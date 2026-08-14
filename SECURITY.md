# Security Policy

ArcForge runs primarily on your own machine and is built around explicit
authorization: the agent only acts within the boundaries you can see and
approve. This document explains what that means in practice and how to report
vulnerabilities.

## Supported versions

ArcForge is in an active development preview. Security fixes are applied to the
latest `main` branch and to the most recent tagged release. We do not maintain
patch backports for older releases.

| Version | Supported          |
| ------- | ------------------ |
| latest `main` / newest tag | :white_check_mark: |
| older tags               | :x:                |

## Trust model

- **Local-first.** Workspaces, sessions and tool execution are centered on your
  machine. The desktop client does not depend on any server.
- **Explicit authorization.** Tools that change state (file writes, shell
  commands, database writes, outbound file delivery) go through the tool's own
  confirmation flow and your runtime permission configuration. The agent does
  not silently escalate beyond what you allow.
- **Credentials stay local.** Secrets such as database passwords and Siwuting
  credentials are stored in the operating system credential store (Windows
  Credential Manager), never written to plain-text files, and never exposed to
  the model or to tool arguments. Passwords supplied for a single call are
  redacted before the call is written to session history.
- **Optional remote surface.** The Gateway is an opt-in component for browser
  access. Its only trust boundary is a shared bearer token. Connector processes
  (for example WeCom) never touch tool calls, the working directory or session
  history.
- **No auto-delivery of files.** Files are sent back to a channel (e.g. WeCom)
  only when the agent explicitly calls `PresentFile`. Ordinary file reads are
  never forwarded automatically.

## Hardening recommendations

- Generate strong, random tokens for the Gateway and any connectors. Never bake
  tokens into images or commit them to the repository.
- Terminate the Gateway behind HTTPS with a reverse proxy that forwards
  WebSocket upgrades and the `Host` / `X-Forwarded-Proto` headers, and expose it
  only to trusted networks.
- Before relying on ArcForge for important work, validate the models, tools and
  permission configuration you intend to use against non-critical, isolated
  data.
- Keep updater signing keys private. The Tauri updater public key is public by
  design; the private key and its password are GitHub Actions secrets and must
  never be committed. Code-signing (Windows Authenticode) is separate from
  updater signing and should be wired up before public distribution.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security problems.

Report vulnerabilities privately via GitHub's security advisory feature:

1. Go to <https://github.com/xiaonie7/ArcForge/security/advisories/new>.
2. Choose "Report a vulnerability".
3. Describe the issue, affected components, reproduction steps and impact.

GitHub Security Advisories are currently the project's private reporting
channel. Please do not include sensitive credentials in your report.

We aim to acknowledge reports within **5 business days** and to coordinate a
fix and disclosure timeline with you. Please allow reasonable time for a fix to
land before public disclosure.

## Scope

This policy covers the ArcForge desktop client, the Go Gateway, the embedded
Gateway WebUI, and the channel connectors shipped in this repository. Issues in
third-party models, MCP servers or upstream dependencies should be reported to
their respective maintainers; we still appreciate being notified so we can
adjust defaults or documentation.
