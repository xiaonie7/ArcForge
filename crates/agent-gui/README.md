# ArcForge Desktop

ArcForge 是基于 Tauri + React 的 Windows 本地优先桌面 Work Agent。

## 开发

- 安装依赖：`pnpm install --frozen-lockfile`
- 前端开发：`pnpm dev`
- 桌面开发：`pnpm tauri dev`
- 前端构建：`pnpm build`
- Windows 安装包：`pnpm tauri build --config src-tauri/tauri.windows.conf.json --target x86_64-pc-windows-msvc`

桌面端当前仅面向 Windows x64。本仓库不配置在线更新，也不通过 GitHub Releases 自动发布安装包。

## 数据库工具

桌面端内置 `DatabaseQuery` 与 `DatabaseExecute`，支持 PostgreSQL、MySQL 和 SQLite。保存的连接在“设置 → 数据库”中管理，密码仅写入操作系统凭据库；模型只会看到不含主机、用户名和密码的连接摘要。

用户消息或已启用 Skill 明确提供的临时连接可用于当次只读查询，其密码会从工具卡片、Gateway 事件和持久化工具参数中脱敏。临时连接不能写入；写入仅允许已保存、已启用且由用户打开“允许写入”的连接，并限制为单条参数化 `INSERT`、`UPDATE` 或带 `WHERE` 的 `DELETE`。企业微信会话无法使用这两个内置工具。
