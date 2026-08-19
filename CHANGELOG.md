# 更新日志

## v0.3.0

本次发布围绕 **Playbook 自动投递** 和 **Channel 状态持久化** 两条主线，把自动化能力从「单条定时 Prompt」升级为「可复用模板 + 条件投递」，并夯实了企业微信通道在重启、轮换与权限收敛上的可靠性。

### 新功能

- **Playbook 工作流模板**：把提示词、模型、推理等级、工作目录、Skills、系统工具、MCP 服务器和投递策略沉淀为可复用模板。同一个 Playbook 可生成多个不同频率的 Cron 任务；采用「创建时复制」语义，模板后续编辑不影响已生成任务，确保权限与投递目标可独立审计。
  - 桌面端「定时任务 -> 工作流模板」与 Gateway WebUI 的 Playbooks 页面双向支持，WebUI 通过已认证的 Gateway WebSocket `cron.manage` 转发，不在浏览器持有企业微信凭据。
  - 前端 automation store 仅接受后端权威快照，分别维护 Cron / Hooks / Playbooks revision，冲突时用响应快照重放当前操作。
- **自动化投递（Delivery Outbox）**：Cron 任务完成后按 `always / onlyOn success / onlyOn failure` 条件，由桌面端本地企业微信运行时投递 Markdown 摘要；采用 prepared Outbox 原子写入，发送结果未知时进入 `unknown` 而非制造重复消息。
- **运行完成通知**：桌面端在运行与投递均到达终态后弹出 AutomationRunToast 完成通知，完整记录可在 Cron 运行历史查看。
- **i18n 扩展**：桌面端与 Gateway WebUI 同步补充 Playbook、自动化、通道相关多语言文案。

### 改进

- **AutomationStore / Scheduler 重构**：校验字段、SQLite 事务、revision 比较集中到 Rust `AutomationStore`；Scheduler 处理并发与超时，持久化 Prompt lease，运行完成后评估投递条件。新增 `automation/types.rs`、`automation/db.rs` 扩展与配套测试。
- **Gateway bridge 事件**：补全 `gatewayBridgeEvents`、`useGatewayBridgeListeners` 与 chat turn queue 协同，远程管理操作稳定落到同一个权威 AutomationStore。
- **Channel 状态持久化边界**：定义企业微信会话映射、回调 Inbox 的持久化所有权；`installation_id`（channel + tenant_id + bot_id + connector_id）作用域化所有主键，避免多机器人/租户串数据；Session 轮换改为条件更新提交，杜绝读后无条件覆盖。
- **权限模型收敛**：Permission Profile 与 Principal Binding 由桌面端可信配置决定，Connector 与模型输入不得扩大权限；新增 `channelPermissionPolicy`、`wecomPermissionProfile` 与 `channelTurnDeadline`。

### 修复

- 加固自动化投递状态落库与输出清洗，避免幻影状态与脏输出。
- 修复 PlaybookModal 长行格式化与编辑器边界问题。
- 收敛 Gateway bridge 与 chat turn queue 在回合结束时的 settle 语义。

### 其他

- 桌面端版本（Cargo.toml / package.json / Cargo.lock）统一升级至 0.3.0。
- 新增 `docs/features/playbooks-and-delivery.md`、`docs/features/channel-state-persistence.md` 设计文档。
