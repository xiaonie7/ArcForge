# Desktop 更新发布

ArcForge 桌面端使用 Tauri Updater 从 GitHub Releases 获取 Windows 更新。更新清单地址配置在 `crates/agent-gui/src-tauri/tauri.conf.json`，发布工作流位于 `.github/workflows/release-desktop.yml`。

## 首次配置签名

Tauri 更新包必须签名。只在受信任的开发机上生成一次密钥：

```powershell
pnpm --dir crates/agent-gui tauri signer generate -w "$env:USERPROFILE\.tauri\arcforge.key"
```

命令会输出公钥，并将私钥写入指定路径。将公钥写入 `crates/agent-gui/src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`，替换其中的 `REPLACE_WITH_TAURI_UPDATER_PUBLIC_KEY`。私钥不能提交到仓库或写入桌面客户端。

在 GitHub 仓库的 **Settings → Secrets and variables → Actions** 中添加：

- `TAURI_SIGNING_PRIVATE_KEY`：私钥文件的完整文本内容。
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：生成密钥时设置的密码；没有密码时可以不创建此 Secret。

公钥和私钥必须来自同一次生成。更换密钥后，已安装的旧版本无法验证使用新密钥签名的更新，通常需要重新安装一次客户端。

## 发布版本

工作流使用 Windows runner 构建 sidecar、NSIS 和 MSI 安装包，并由 `tauri-apps/tauri-action` 创建或更新 GitHub Release。推送符合 `vMAJOR.MINOR.PATCH` 的标签即可触发：

```powershell
git tag v0.1.2
git push origin v0.1.2
```

工作流会把标签版本写入临时 Tauri 配置，不会修改 `package.json`。发布成功后，Release 中应至少包含：

- Windows NSIS 安装包及其 updater 压缩包。
- updater 压缩包对应的 `.sig` 签名文件。
- `latest.json` 更新清单。

在线更新使用 NSIS updater artifact；MSI 仍可作为手动安装包提供。稳定版本请使用不带预发布后缀的标签，因为 `releases/latest/download/latest.json` 指向 GitHub 的 Latest Release。

## 本地验证

在配置 GitHub Secrets 前，可以先验证版本配置和普通构建：

```powershell
node scripts/release/prepare-app-version-from-tag.mjs v0.1.2 `
  --tauri-config crates/agent-gui/src-tauri/tauri.version.generated.conf.json

$env:ARCFORGE_APP_VERSION = "0.1.2"
pnpm --dir crates/agent-gui tauri build `
  --config src-tauri/tauri.windows.conf.json `
  --config src-tauri/tauri.version.generated.conf.json `
  --target x86_64-pc-windows-msvc
Remove-Item Env:ARCFORGE_APP_VERSION
```

`ARCFORGE_APP_VERSION` 让界面显示版本与 Tauri 包版本保持一致；GitHub Actions 会自动设置它。未配置有效签名密钥时不要把生成的安装包用于升级验证。构建完成后可删除 `crates/agent-gui/src-tauri/tauri.version.generated.conf.json`。

## 故障排查

- **提示签名无效**：检查 `pubkey` 是否与 GitHub Secret 中的私钥匹配，并确认 Release 同时上传了 `.sig` 文件。
- **没有检测到更新**：确认新版本高于当前版本，Release 已发布而不是草稿，并且 `latest.json` 可从 endpoint 直接访问。
- **浏览器/Gateway 页面没有更新按钮**：在线更新只在 Tauri 原生窗口启用，浏览器页面不会调用原生 updater API。
