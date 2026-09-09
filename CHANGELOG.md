# 更新日志

## 未发布

本次变更为 **功能版本**，重做 PPT 生成能力：模型用受限子集的 SVG 描述每一页，ArcForge 把它转换成原生可编辑的 PPTX 对象；支持以用户上传的 PPTX 作为品牌模板，并新增策划稿校验与逐页 PNG 预览。

### 新功能

- **SVG 页面描述转原生 PPTX（arcforge-slides v3）**：`presentation.py` 新增 `schema_version: 3` 清单（`mode`、`stage`、`template`、`assets`、`slides[].svg`）。矩形、圆、线段、多边形与 M/L/H/V/Z 路径转为形状，`text/tspan` 转为文本框（同时写入拉丁、东亚与复杂文种字体），`data-asset` 图片转为独立图片对象，`data-arcforge="chart"` 转为原生图表，线性渐变与透明度保留。文字宽度用 Pillow 真实字体度量，结果里报告 `text_overflows`、`out_of_bounds`、`protected_collisions` 与 `missing_fonts`。
- **模板底稿模式**：`mode: template` 打开用户 PPTX，删除样例页并保留母版、版式与主题；`inspect` 新增 `template` 结构（版式、占位符、1280 画布坐标的禁区、主题色与字体）。OfficeRuntime 的 `presentation create/validate` 接受 `input_path` 作为模板。
- **策划稿与设计稿两阶段**：`stage: plan` 只允许灰阶且禁止渐变；新增 `presentation validate` 动作，在内存中转换整份清单并报告问题而不写文件。
- **PNG 预览**：`presentation render` 输出 `.png` 时改走 OfficeCLI 截图（强制 HTML 渲染），默认输出全部页面的联系表，`spec_path` 可传 `{"pages":"2"}` 选择页面；`.pdf` 仍走 LibreOffice。
- **PPTX 上传与读取**：附件类型新增 `presentation`（pptx/pptm/potx/ppt），Read 工具按页提取幻灯片文字，桌面端与 Gateway Web 同步识别。
- **Skill 更新**：`arcforge-slides` 改为调研、大纲、策划稿、设计稿五阶段工作流，新增 `references/prompts.md`（金字塔大纲、Bento 卡片线框、样式包设计、视觉审稿提示词）与示例 SVG 页面；`references/spec.md` 改为清单与 SVG 子集说明。

### 安全

- Rust 侧在运行时解析前拒绝含 `href`、`xlink`、`<use>`、`<style>`、`<script>`、`<foreignObject>`、data URI 或远程 URL 的 SVG 页面，并校验清单中素材、模板、页面文件均位于工作区内。

### 其他

- 新增 `office_runtime`、`fs`、`system`、`skills` 相关单元测试；旧版 `slides[]` 规格继续受支持。
- 打包的 Office Runtime sidecar 需重新执行 `pnpm sidecar:build:office` 才会包含新的 `presentation.py`。

## v0.3.5

本次发布为 **功能版本**，新增企微（WeCom）"客户端能力同步"机制，让远程会话的默认权限跟随桌面端当前启用的 Skill 与工具；同时将 Skill 脚本执行与 Skill 文件改动权限解耦，使只读 Skill 策略下也能运行已启用 Skill 的脚本。

### 新功能

- **企微客户端能力同步（Desktop Capability Sync）**：企微安装级默认权限可"跟随客户端"，桌面端当前启用的 Skill 与工具会反映到默认权限策略，新请求使用更新后的策略；单独配置的用户与群组权限不受影响，Skill 文件修改权限仍独立控制。
  - **安装默认权限采纳（adopt）**：后端 `channel_control` 服务新增 `adopt_installation_default`，基于乐观并发期望（binding_id / profile_id / profile_revision / profile_current_revision / policy_hash）创建新的跟随型默认配置；旧版或手动配置的默认不被自动覆盖，确认后保留原配置及单独配置的用户、群组权限。
  - **权限修订版本追踪**：新增 `channel_permission_profile_revisions` 修订历史与 `last_synced_revision`，`next_profile_revision` 生成单调修订号；显式编辑会把配置所有权转回桌面用户，绑定可指向较旧修订并在采纳时校准。
  - **新命令与字段**：新增 Tauri 命令 `channel_installation_default_adopt`；`InstallationDefault` 增加 `follows_desktop` 与 `profile_current_revision`。
  - **前端同步与设置 UI**：新增 `buildWecomInstallationDefaultSyncKey`、`adoptWecomInstallationDefault`、`resolveWecomPermissionProfile`，并按安装维度串行化默认权限写入；设置页新增"客户端能力同步"区块，展示跟随状态、提供"确认跟随客户端"与"刷新权限状态"入口。
  - **Gateway 桥接解析**：企微请求鉴权改用 `resolveWecomPermissionProfile`，仅同步本机安装后再解析生效权限，并把 `settings` 传入桥接监听。

### 改进

- **Skill 脚本执行与文件改动权限分离**：移除 `isSkillShellExecutionRestricted` / `SkillShellExecutionBlockedError` / `assertSkillShellExecutionAllowed` 等执行阻断逻辑；已启用 Skill 可通过 Bash / ManagedProcess 运行其脚本（按 Skill 当前指令），而 Skill 文件写入（Write / Edit / Delete）仍由 `ToolPathResolver` 独立强制。由此一个只读 Skill 策略的渠道也能执行已批准的数据工作流，同时禁止改写 Skill 包文件。同步更新 Bash 工具后缀与 shell 执行指引文案。

### 其他

- 新增 `wecom-permission-sync`、`wecom-permission-ui` 回归测试，并更新 shell-tools、gateway-bridge-listeners、wecom-settings、markdown-image-policy 等既有测试。
- 桌面端版本（Cargo.toml / package.json / Cargo.lock）统一升级至 0.3.5。

## v0.3.4

本次发布为 **功能版本**，通过内置 Office Runtime 新增 Word DOCX 文档的可审查交付能力，并修复 Skill 运行器在陈旧恢复与执行拒绝上的边界问题。

### 新功能

- **OfficeCLI 文档工作流（OfficeCLI Document Workflow）**：基于内置 Office Runtime，新增 Word DOCX 文档从创建、修改、检查、校验到渲染的完整交付链路，覆盖办公文档产出场景。
  - **arcforge-documents 内置 Skill**：新增面向 Word 交付的内置技能，引导通过结构化 `OfficeRuntime` 工具产出文档，明确禁止直接调用 officecli、任意 shell 命令或 OfficeCLI MCP 端点。
  - **OfficeRuntime 文档能力扩展**：新增 `document_artifacts` 命令模块并扩展 `office_runtime`，支持 `create` / `patch` / `inspect` / `validate` / `render` 等 action；内容以原子批处理 JSON 规范驱动（`add` / `set` / `remove` / `move` / `swap` / `get` / `query`），并强制工作区路径、超时与覆盖策略，外部图片、媒体、OLE 与模板引用在首版被有意屏蔽。
  - **OfficeCLI sidecar 与合规**：新增 `build-officecli-sidecar.ps1` 构建脚本，并随附 `third-party/officecli` 的 LICENSE、NOTICE 与第三方声明。
  - **前端展示适配**：`GeneratedFilesCard`、`displayFiles`、`officeRuntimeTools`、`RoundContent` 等适配文档产物卡片与渲染策略，并补充 i18n 文案。

### 修复

- **Skill 运行器陈旧恢复**：不再审计历史工作区副本来恢复 Skill 指令，改用当前已启用 Skill 的指令；将瞬时运行器路径、缓存作用域结果与兜底命令排除在持久操作规则之外，同时保留显式历史工作记录。
- **Skill shell 执行拒绝上报**：将被阻止的 Skill shell 执行与启用状态分开上报，不放松既有权限边界，Channel 脚本执行保持受限。

### 其他

- 补充提示词与工具回归覆盖：1318 项前端测试通过，TypeScript no-emit 检查通过。
- 桌面端版本（Cargo.toml / package.json / Cargo.lock）统一升级至 0.3.4。

## v0.3.3

本次发布为 **功能版本**，升级 Pi 至 0.84.3，并为 provider 设置页新增单个模型的"高级采样与兼容参数"配置，主要适配通过 new-api 中转访问各类模型的兼容性需求。

### 新功能

- **高级模型控制（Advanced Model Controls）**：在 provider 设置页为单个模型新增"高级采样与兼容参数"配置区，针对目录外模型（中转/改名）的兼容场景。
  - **采样参数（JSON）**：可把 JSON 对象（top_p、top_k、min_p 等）合并到模型请求，适配服务端支持的非标准采样字段；请求级配置按键覆盖。
  - **Finish reason 声明**：声明 OpenAI Completions 响应是否始终返回 finish_reason（自动 / 始终返回 / 可能省略），解决部分中转端点不返回 finish_reason 导致流处理异常。
  - **思考 Token 预算字段**：选择服务端接收思考 Token 上限的字段名（thinking_token_budget / thinking_budget / thinking_budget_tokens / 不发送），适配不同供应商的推理 token 预算字段命名差异。

### 改进

- **Pi 升级至 0.84.3**：升级前端依赖 Pi 至 0.84.3，同步更新 gateway web 与 agent-gui 的 pnpm-lock。
- **模型运行时链路适配**：deepSeekProviderAdapter、modelFactory、payloadPipeline、streamByApi、openAICompletionsStream 等运行时链路适配高级参数透传与流式兼容，并补充 stream-by-api tool-choice、request-options 等测试。

### 其他

- 桌面端版本（Cargo.toml / package.json / Cargo.lock）统一升级至 0.3.3。
- 本次提交不包含 Office Runtime 工作区的其他改动。

## v0.3.2

本次发布为 **bugfix 版本**，聚焦修复 GUI 远程聊天队列租约（lease）在连续排队场景下失效、重复弹窗的问题。该问题表现为连续快速发送多条企业微信消息时，队列因 lease 失效而无法依次执行并反复弹出 lease 提示。

### 修复

- **远程聊天队列租约失效**：修复 GUI 队列 lease 管理在连续排队场景下失效、重复弹窗的问题；连续快速发送多条企业微信消息后能依次执行。
  - **真实 lease owner**：GUI 队列保留真实的 lease owner，不再使用固定的 `gui-queue` 占位符，避免 owner 冲突导致续租失败。
  - **提前续租**：身份与权限解析完成前立即开始续租，防止握手期间 lease 超时被判定失效。
  - **失效 lease 不重入队**：失效的 lease 不再无限重新入队并重复弹窗，队列在 lease 失效后正确收敛。

### 验证

- 完整前端测试：1289/1289 通过
- 定向回归：18/18 通过
- TypeScript 类型检查通过
- 建议彻底退出后重启桌面端，连续快速发送 2~3 条企业微信消息，验证排队后能依次执行且不再出现 lease 弹窗。

### 其他

- 桌面端版本（Cargo.toml / package.json / Cargo.lock）统一升级至 0.3.2。
- 本次提交不包含 Office Runtime 工作区的其他改动。

## v0.3.1

本次发布为 **bugfix 版本**，聚焦修复企业微信远程会话启动超时问题，统一 Channel 会话标识与终端状态边界。

### 修复

- **企业微信远程会话启动超时**：修复因会话标识拼接不一致导致远程会话无法正确关联、出现启动超时的问题。
  - **Channel 会话标识统一**：`channelConversationID` 改用 `channelInstallationID`（由 `channel + tenant_id + bot_id + connector_id` 组成的安装级标识）作为哈希输入，替代之前逐字段拼接的方式，确保 Connector、桌面端与 Gateway 三方计算出的会话 ID 完全一致。
  - **跨运行时 JSON 哈希契约**：`channelInstallationID` 使用确定性的 JSON 序列化（固定字段顺序、禁用 HTML 转义），并通过 `normalizeChannelInstallationJSON` 统一处理 Go `encoding/json` 与 JS `JSON.stringify` / Python `ensure_ascii=false` 对行分隔符（U+2028 / U+2029）的转义差异，杜绝因运行时差异导致的哈希不一致。
- **终端状态防冲突**：`runFinishedWithPersistenceLocked` 新增 `chatCommandTerminalLocked` 检查，防止迟到的或被错误路由的 live 信号在已终结的 run 上追加第二个终端记录，避免事件流分裂。恢复路径使用 `persist=false` 正常物化终端记录。
- **会话绑定不可变**：`resolveConversationLocked` 在 run 已绑定 conversationID 后直接返回已有值，不再允许 Agent 事件中独立推导的会话 ID 迁移该 run，防止事件流被拆分到不同会话。
- **FailChatCommand / ChatCommandSettled 终端守卫**：在 pending 与 stream 两条路径都补上终端锁定检查，已终结的 run 不再触发重复状态更新。

### 其他

- 桌面端版本（Cargo.toml / package.json / Cargo.lock）统一升级至 0.3.1。

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
