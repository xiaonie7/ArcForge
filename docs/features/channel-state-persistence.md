# Channel 状态持久化

本文定义 ArcForge 外部消息 Channel 的持久化边界。第一期实现企业微信，后续飞书、钉钉等 Connector 必须复用相同的身份、Inbox、权限和 Outbox 语义。

## 目标

- Connector 重启后保持用户和群聊的会话映射。
- Connector 与 Gateway 同时重启后，同一外部消息仍只映射到一个 canonical run。
- 权限由桌面端可信配置决定，Connector 和模型输入不能扩大权限。
- 自动化任务引用稳定的投递目标，发送结果未知时不自动制造重复消息。
- 单机版本零外部依赖；多实例版本可把相同 Store 接口迁移到 PostgreSQL。

系统不承诺跨 SQLite 事务和企业微信网络调用的 exactly-once。无法确认发送结果时必须进入 `unknown`，由用户对账或明确重试。

## 所有权

| 数据 | 单机事实源 | 写入方 |
| --- | --- | --- |
| 企业微信会话映射、回调 Inbox | `wecom-state.sqlite3` | Connector |
| Gateway canonical command | `gateway-state.sqlite3` | Gateway |
| Permission Profile 与 Principal Binding | `config.sqlite` | Desktop/Rust |
| Delivery Target 与 Outbox | `config.sqlite` | Automation/Rust |
| Bot Secret 与 Channel Token | 系统凭据存储 | Desktop/Rust |

运行态数据库不得保存 Bot Secret、Channel Token、Provider API Key 或用户输入的完整附件。

## 身份与作用域

安装身份由以下字段组成：

```text
channel + tenant_id + bot_id + connector_id
```

Connector 应把上述字段规范化并派生稳定的 `installation_id`。Session 和 Inbox 的所有主键都必须包含安装作用域，避免多个机器人或租户串数据。

会话范围使用显式模式：

```text
direct | group_shared | group_per_user | thread
```

企业微信第一期保持现有语义：私聊使用 `direct`，群聊使用 `group_per_user`。外部消息的 durable Inbox 主键不能包含 `channel_session_id`，因为 `/new` 会轮换该值；应使用 `installation_id + external_message_id`，并保存 `payload_hash` 检测同一 ID 的冲突载荷。

## Connector Session

SessionStore 保留现有接口：

- `get_for_key`：不存在时原子创建。
- `reserve_rotation`：生成候选 Session，不修改当前绑定。
- `commit_rotation`：仅在当前 generation/session 与 reservation 一致时提交。
- `rotate`：只用于不需要回滚的显式调用。

SQLite 的轮换提交必须使用条件更新，不能读后无条件覆盖：

```sql
UPDATE channel_sessions
SET session_id = :candidate,
    generation = generation + 1,
    updated_at_ms = :now
WHERE installation_id = :installation
  AND scope_mode = :scope_mode
  AND chat_type = :chat_type
  AND chat_id = :chat_id
  AND external_user_id = :external_user_id
  AND generation = :expected_generation
  AND session_id = :expected_session_id;
```

更新行数为零时必须重新读取 generation：若已是同一 candidate 且 generation
恰好递增一次，则按幂等重试成功处理；其他情况才是 CAS 失败。失败的 `/new`
不得修改旧 Session。`/new` 的 reservation 必须在提交 Gateway 前保存到 Inbox，
避免 canonical replay 提交一个从未执行过的新 candidate。

同一 Session 的 Gateway 提交需要在进程内锁之外持有数据库 lease。lease 以安装
身份和 Session scope 为键，续租和释放均匹配随机 owner token；共享同一数据库的
Connector 进程不得并发提交同一 Session。

## Durable Inbox

Inbox 状态机：

```text
received/absent -> processing -> completed
                              -> failed
                              -> unknown
```

首次 claim 必须使用唯一约束或单条条件插入。`processing` 记录包含随机 `claim_token` 和 `lease_until_ms`；完成更新必须同时匹配当前 token，防止旧 Worker 覆盖新 Worker 的结果。

Gateway 已返回 accepted 后连接中断时，不得把 Inbox 固化为 `failed`。Connector
释放当前 claim 但保留 rotation reservation，重连后用相同 external message ID 和
相同 Session candidate 查询并复用 Gateway canonical run。

重复消息处理规则：

| 已有状态 | 行为 |
| --- | --- |
| `completed` | 重放已缓存的最终文本，不执行第二次模型调用 |
| `failed` | 重放确定性失败；明确可重试错误应在失败前删除 claim |
| `processing` 且 lease 有效 | 等待或忽略本次回调，不创建第二个 run |
| `processing` 且 lease 过期 | 使用新 token 接管，并以相同 external message ID 查询 canonical run；Gateway 无法恢复时转为 `unknown` |
| `unknown` | 不自动执行，返回可对账的安全提示 |

持久化 TTL 使用 UTC Unix 毫秒。不得把 `time.monotonic()` 的值写入数据库。

## Gateway Canonical Command

Gateway 使用稳定 `client_request_id` 作为幂等键。该键包含安装身份、外部会话范围和外部消息 ID，不包含可轮换的 Channel Session。

Gateway 需要持久化：

```text
client_request_id
run_id
conversation_id
accepted_seq
state
dispatch_phase
terminal_status
terminal_text
created_at_ms
updated_at_ms
expires_at_ms
```

内存 `commandDedup` 只允许作为缓存，SQLite 是 canonical run 的最终判断依据。Gateway 重启后：

- 终态记录可以直接重放。
- 非终态记录先进入 `recovering`，保留原 canonical `run_id`，恢复期间绝不重新 dispatch。
- 重复请求只确认原 canonical run 并等待；Desktop 的 `active_runs` 报告恢复订阅，`finished_runs` 报告写入真实终态。
- 恢复宽限期内仍无法向 Desktop 对账的 run 才标记 `unknown`。该合成终态携带 `gateway_restart`，不能自动重投。

首次接纳必须在一个 SQLite 事务中同时写入 `client_request_id + run_id + conversation_id + accepted_seq` 并读取 canonical 行。后续 `Bind` 只补充 Desktop 返回的会话元数据；失败不能撤销或重新投递已经接纳的 run，而是记录结构化错误并由 Gateway reaper 重试。终态写失败同样保留内存重试记录，真实终态仍遵循 first-wins。

## Permission Profile

Profile 是不可变的版本化策略。编辑 Profile 产生新 revision；运行开始时保存最终 `profile_id + revision + policy_hash`，后续配置修改不影响该 run。

最小策略字段：

```text
execution_mode
workdir
allow_empty_workdir
allowed_skills
allowed_system_tools
allowed_mcp_servers
memory_enabled
native_web_search_enabled
max_duration_seconds
max_output_chars
```

`native_web_search_enabled` 独立于 `allowed_system_tools`。它控制由模型供应商托管、不会经过本地工具注册表的联网搜索；字段缺失时必须按 `false` 处理，新安装默认也不授予。若 Profile 显式开启，该决策同时约束文本模式、主 Agent、子代理、压缩和其他辅助模型调用。

可信 Channel 只加载 `allowed_mcp_servers` 冻结快照中的 MCP 业务工具，不注册桌面 `McpManager`。后者支持内联 server 诊断和连接测试，属于本地配置管理面，不能通过 Channel Profile 的业务 MCP 白名单间接获得。

可信 Channel 同样不注册 `CronTaskManager`。Cron/Playbook 会在当前 run 结束后继续执行，而现有 Profile 只约束当前 run；在没有持久化委托主体与逐次能力快照之前，Channel 不能创建、修改、启停或删除桌面自动化。自动投递仍由桌面端已配置的 Playbook/Cron 执行。

`allowed_skills` 只授予使用已安装 Skill 的能力，不授予 Skill 元管理能力。策略规范化会剔除 `skills-creator` 与 `skills-installer`；可信 Channel 不能安装、创建或动态授权新 Skill，不能修改 Skill 文件，也不能把 Skill 选择写回桌面全局设置。

绑定解析顺序：

```text
principal > conversation > connector installation default > deny
```

Gateway 的 Trusted Origin 只提供认证身份。Connector、消息正文和模型输出都不能提供或覆盖 Profile 内容。Desktop 必须在构造工具注册表和 Runner 配置前解析 Profile，并显式传入冻结后的能力列表；仅把策略写进 system prompt 不构成权限控制。

## Delivery Target 与 Outbox

Playbook/Cron 应引用内部 `target_id`，而不是长期保存裸外部会话 ID。Target 记录包含安装身份、外部目标、类型、显示名、enabled、revision 和 validation status。

Outbox 与运行终态在同一个 SQLite 事务中创建。状态机：

```text
prepared -> sending -> sent
                    -> failed
                    -> unknown
```

只有 `prepared` 或明确确认“尚未调用供应商发送 API”的失败允许自动重试。`sending` 后超时、断连或进程退出属于结果未知；除非供应商提供可验证的幂等键或查询回执，否则恢复时进入 `unknown`。

## SQLite 设置

运行态数据库统一启用：

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

所有 claim、CAS 和状态转换使用短事务。异步消息处理器不得执行长时间 SQLite 查询；Python Connector 使用专用锁/数据库执行线程，Gateway/Rust 使用受控连接或连接池。

配置了持久化数据库但数据库无法打开或迁移时，Channel 必须失败关闭并报告健康状态。生产模式不得静默回退到进程内 Store。

Gateway 普通二进制默认把 canonical command 状态写入当前目录下的
`arcforge-gateway-state.sqlite3`，可通过 `ARCFORGE_GATEWAY_STATE_DB` 指定其他路径。
官方容器镜像把该变量设为 `/var/lib/arcforge/gateway-state.sqlite3`；生产部署必须为
`/var/lib/arcforge` 挂载本地目录或持久卷，否则重新创建容器后无法保留跨重启去重和
终态 replay 状态。

## 清理与可观测性

Connector Inbox 和 Gateway dedupe 定期分批删除过期记录；automation run 被修剪后，与其关联的孤立终态 Outbox 也按有限批次清理。通用终态 Outbox 在没有明确保留期前不自动删除，所有清理批次都必须设置上限，避免持有长写锁。

至少记录以下指标：

- Inbox claim 成功、重复命中、终态重放和 unknown 数量。
- Session 创建、CAS 轮换成功和冲突数量。
- Gateway durable dedupe 命中和恢复数量。
- Profile 拒绝、Profile revision 和 policy hash。
- Outbox prepared、sent、failed、unknown 和重试数量。

日志不得输出 Secret、Token、完整外部附件或未经截断的模型输出。

## 迁移与兼容

第一期没有可迁移的进程内数据。升级后首次消息会创建新的持久 Session，之后重启保持稳定。

旧 Playbook/Cron 中的裸 `targetId` 必须继续可读。迁移时为每个唯一的 `(channel, installation, external_target_id)` 创建 Target，再把新写入格式切换为 `target_id + target_revision`；旧字段至少保留一个兼容周期。

多实例部署不得把 SQLite 放到网络共享目录。需要跨主机时实现同一 Store 接口的 PostgreSQL 后端，使用唯一约束、事务、lease/fencing token 和 `FOR UPDATE SKIP LOCKED`；Redis 只用于缓存、限流和唤醒。

## 验收场景

1. Connector 重启后，同一用户继续使用原 Session。
2. `/new` 成功后轮换；失败或 CAS 冲突时旧 Session 不变。
3. 两个 Connector Store 实例同时 claim 同一消息，只有一个成功。
4. Connector 和 Gateway 同时重启后，重复回调不创建第二个 canonical run。
5. 旧 claim token 不能覆盖 lease 接管后的终态。
6. Profile 修改不影响已经开始的 run；无绑定身份默认拒绝。
7. Target 禁用后新 Outbox 不发送，既有发送结果保留审计记录。
8. 发送前失败可以重试；发送后结果未知不会自动重发。
