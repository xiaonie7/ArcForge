<p align="right">
  English · <a href="README.md">简体中文</a>
</p>

<p align="center">
  <img src=".tmp/arcforge-brand/lockup.png" width="820" alt="ArcForge — Local-first desktop Work Agent for Windows professionals" />
</p>

<img src=".tmp/arcforge-brand/app1.png" width="820" alt="ArcForge — Local-first desktop Work Agent for Windows professionals" />

<p align="center">
  <strong>A local-first desktop Work Agent for Windows professionals</strong>
</p>

<p align="center">
  Turn goals and local context into reviewable deliverables, verifiable evidence, and real actions you explicitly authorize.
</p>

<p align="center">
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%20x64-0078D4?logo=windows11&logoColor=white" />
  <img alt="Tauri" src="https://img.shields.io/badge/Tauri-2-FFC131?logo=tauri&logoColor=white" />
  <img alt="React" src="https://img.shields.io/badge/React-19-087EA4?logo=react&logoColor=white" />
  <img alt="Rust" src="https://img.shields.io/badge/Rust-stable-B7410E?logo=rust&logoColor=white" />
  <img alt="Go" src="https://img.shields.io/badge/Go-1.25-00ADD8?logo=go&logoColor=white" />
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-2EA44F" /></a>
</p>

<p align="center">
  <a href="#why-arcforge">Why ArcForge</a> ·
  <a href="#core-capabilities">Core capabilities</a> ·
  <a href="#current-status">Current status</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#contributing">Contributing</a>
</p>

---

> This is the English front-page introduction. The complete documentation lives
> in the [Chinese README](README.md). Both are kept in sync; pick whichever
> language you prefer.

## Why ArcForge?

ArcForge is more than a chat window. It lets an agent read context, call tools,
generate files, and verify results within boundaries you can see and control —
turning a conversation into work that is actually done.

| Local-first | Openly extensible | Desktop & remote |
| --- | --- | --- |
| Workspaces, sessions and tool execution are centered on your machine; the desktop runs standalone | Compose your own workflow through Skills, MCP and multi-model protocols | Use it daily on the Windows desktop; access it from a browser through the Gateway when needed |

Typical loop:

```text
Goal & context
    ↓
Planning & tool calls
    ↓
Observable execution
    ↓
Files / diffs / reports / action results
    ↓
Review, verify & user confirmation
```

## Core capabilities

### Multi-model conversation

- Supports the Anthropic Messages, OpenAI Responses / Chat Completions, and
  Gemini Generate Content protocols.
- Configurable custom Base URL, request headers and compatible services — no
  lock-in to a single model provider.
- Streaming rendering of Markdown, code, KaTeX formulas, Mermaid diagrams and
  images.
- Conversation compression and persistence keep effective context across long
  tasks.

### Local workbench

- Read, search, create and precisely edit workspace files.
- Run shell commands and host long-running processes such as dev servers and
  watchers.
- Integrated terminal, Git change viewer, SSH / SFTP and local service tunnels.
- Document, spreadsheet and presentation workflows.

### Agent collaboration & extension

- Delegate independent tasks to sub-agents with parallel work isolated in Git
  worktrees.
- Native MCP server support for stdio, HTTP and SSE transports.
- Install, create, manage and lazily load Skills.
- An extensible tool registration mechanism keeps agent capabilities
  composable.

### Database tools

- Manage SQLite, PostgreSQL and MySQL connections in settings. Passwords are
  stored in the system keychain (Windows Credential Manager) — never written to
  disk, never entered into chat history.
- `DatabaseQuery` read-only queries: list connections/tables, inspect schema,
  and run parameterized queries. The backend enforces a read-only transaction,
  bound parameters, timeouts and row/cell/payload limits.
- `DatabaseExecute` controlled writes: available only when a connection has
  "Allow writes" enabled in a chat session. Limited to a single parameterized
  INSERT/UPDATE/DELETE; UPDATE/DELETE require a WHERE clause and roll back if
  the affected-row safety limit is exceeded.
- Temporary connections (supplied by a user or Skill for one call) are read-only
  and not persisted. Passwords in tool calls are redacted before the call is
  written to session history.

### WeCom integration

- A standalone connector process receives WeCom smart-bot text, file and image
  callbacks and forwards them through the Gateway's dedicated
  `/ws/v2/channel` as ordinary conversations and attachments. The connector
  never touches tool calls, the working directory or session history.
- Files are sent back to a WeCom chat only when the agent explicitly calls
  `PresentFile`; ordinary file reads are never forwarded automatically.
- In desktop-hosted mode, the built-in Gateway and Connector start with one
  click. Tokens are generated in Rust memory and passed straight to child
  processes, never exposed to the WebView. Connecting to an externally deployed
  Gateway is also supported.
- WeCom messages reuse the desktop's current model, execution mode, working
  directory, Skills, system tools, MCP, Memory, SSH and tunnel configuration —
  no separate capability allowlist to maintain.

### Memory & automation

- Cross-session memory backed by local Markdown and SQLite full-text search.
- Long conversations are segmented, summarized and restored.
- Scheduled tasks of type prompt, HTTP and command.

### Remote Gateway

- A lightweight Go Gateway with an embedded browser WebUI.
- Connects to the desktop agent over HTTP, WebSocket v2 and Protobuf.
- Short-lived disconnect recovery, remote terminal and file access.

## Current status

ArcForge is a fast-moving development preview:

- The desktop client currently targets **Windows 10/11 x64** only.
- Tauri online updates and the GitHub Releases tag-based publishing flow are
  wired up. Maintainers of their own release flow must configure the updater
  signing public key and GitHub Actions private-key secrets.
- Tagged preview builds are published through GitHub Releases; building from
  source remains supported as described below.
- Wire up your own Windows Authenticode code-signing flow before public
  distribution; it is separate from Tauri updater signing.
- The Gateway is optional; the desktop client does not depend on any server.

If you plan to use ArcForge for important work, first validate the models,
tools and permission configuration you intend to use against non-critical,
isolated data.

## Quick start

### Prerequisites

| Dependency | Purpose |
| --- | --- |
| Windows 10/11 x64 + WebView2 | Run the desktop client |
| Visual Studio Build Tools (Desktop development with C++) | Windows / MSVC build |
| Rust stable + `x86_64-pc-windows-msvc` | Tauri backend |
| Node.js 22 + pnpm 10 | Frontend and build tooling |
| Python 3.10+ | Build the Office Runtime sidecar |

Pinned Node, pnpm, Go, Protobuf and Buf versions live in
[`mise.toml`](mise.toml); with [mise](https://mise.jdx.dev/) installed, run
`mise install`.

### Start the desktop dev environment

```powershell
git clone https://github.com/xiaonie7/ArcForge.git
cd ArcForge

pnpm --dir crates/agent-gui install --frozen-lockfile
rustup target add x86_64-pc-windows-msvc
pnpm --dir crates/agent-gui tauri dev
```

The first launch creates an isolated Python environment and builds the Office
Runtime, so it takes longer than subsequent launches.

### Build a Windows installer

```powershell
pnpm --dir crates/agent-gui tauri build `
  --config src-tauri/tauri.windows.conf.json `
  --target x86_64-pc-windows-msvc
```

The generated MSI / NSIS installers land in the Cargo `target` directory under
`release/bundle/`. Pushing a `v*.*.*` tag triggers the Windows desktop release
workflow. Before enabling online updates for the first time, generate the Tauri
updater keys, commit the public key, and configure the GitHub secrets — see
[Desktop updates](crates/agent-gui/docs/releasing/desktop-updates.md).

## Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│              Browser WebUI (optional)  ·  WeCom users        │
└───────────────────────────┬─────────────────────────────────┘
                            │ HTTP / WebSocket      ▲ message callback
┌───────────────────────────▼───────────────┴─────────┐
│          Agent Gateway          │    WeCom Connector │
│    Go · WebSocket v2 · Protobuf │  Python · channel │
└───────────────────────────┬─────────────────────────┘
                            │ Remote bridge
┌───────────────────────────▼─────────────────────────┐
│                      ArcForge Desktop                │
│                    Tauri 2 · React · Rust            │
├────────────┬────────────┬────────────┬────────────┬─────────┤
│ LLM router │ Agent loop │ Local tools│ Skills/MCP │ Memory  │
│ multi-proto│ Sub-Agent  │ FS/Shell/DB│ ecosystem  │ automat.│
└────────────┴────────────┴────────────┴────────────┴─────────┘
```

### Tech stack

| Component | Technology |
| --- | --- |
| Desktop UI | Tauri 2, React 19, TypeScript, Vite 8, Tailwind CSS |
| Desktop backend | Rust, Tokio, SQLite |
| Content rendering | Streamdown, KaTeX, Mermaid, Monaco Editor |
| Agent & models | `pi-agent-core`, `pi-ai`, multi-protocol provider adapters |
| Gateway | Go, HTTP, WebSocket, Protobuf |
| Gateway WebUI | React, TypeScript, Vite |
| Channel connector | Python (WeCom AiBot callback forwarding) |

### Repository layout

```text
ArcForge/
├── crates/
│   ├── agent-gui/          # Tauri desktop client
│   │   ├── src/            # React frontend & agent runtime
│   │   └── src-tauri/      # Rust backend, system capabilities & built-in Skills
│   └── agent-gateway/      # Go Gateway and embedded WebUI
├── connectors/             # Channel connectors (WeCom AiBot, etc.)
├── contracts/              # Machine-readable contracts & schemas
├── fixtures/               # Test and acceptance fixtures
├── scripts/                # Release and maintenance scripts
├── tools/                  # Contract verification tools
├── Dockerfile              # Gateway container build
├── Makefile                # Common dev commands
└── mise.toml               # Shared toolchain versions
```

## Contributing

Contributions via issues and pull requests are welcome. Before submitting, run
the checks that match your change's scope — see
[CONTRIBUTING.md](CONTRIBUTING.md) for the full development setup and
commands.

For security-sensitive reports, follow [SECURITY.md](SECURITY.md) instead of
opening a public issue.

## License

This project is licensed under the [MIT License](LICENSE).
