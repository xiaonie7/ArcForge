# Contributing to ArcForge

Thanks for your interest in improving ArcForge. This guide covers the practical
steps for setting up a development environment, running checks, and sending a
pull request.

ArcForge is a local-first desktop Work Agent for Windows. The repository hosts
three main components that often change together:

- **Desktop client** — Tauri 2 / React 19 / Rust (`crates/agent-gui`)
- **Gateway** — Go service with an embedded React WebUI (`crates/agent-gateway`)
- **Channel connectors** — e.g. the WeCom AiBot forwarder (`connectors/`)

## Before you start

- A GitHub issue is the best place to discuss non-trivial changes before
  opening a PR. For bugs, include OS version, ArcForge version, and the
  smallest reproduction you can manage.
- Keep PRs focused. A PR that addresses one concern is faster to review than a
  mixed-scope one.
- By contributing you agree that your changes will be released under the
  project's [MIT License](LICENSE).

## Prerequisites

The shared tool versions are pinned in [`mise.toml`](mise.toml). If you use
[mise](https://mise.jdx.dev/), run `mise install` to get the right Node, pnpm,
Go, Protobuf and Buf versions.

| Dependency | Purpose |
| --- | --- |
| Windows 10/11 x64 + WebView2 | Run the desktop client |
| Visual Studio Build Tools (Desktop development with C++) | Windows / MSVC build |
| Rust stable + `x86_64-pc-windows-msvc` | Tauri backend |
| Node.js 22 + pnpm 10 | Frontend and build tooling |
| Python 3.10+ | Build the Office Runtime sidecar |

## Getting started

```powershell
git clone https://github.com/xiaonie7/ArcForge.git
cd ArcForge

pnpm --dir crates/agent-gui install --frozen-lockfile
rustup target add x86_64-pc-windows-msvc
pnpm --dir crates/agent-gui tauri dev
```

The first launch creates an isolated Python environment and builds the Office
Runtime, so it takes longer than subsequent runs.

## Development commands

### Desktop

```powershell
pnpm --dir crates/agent-gui build
pnpm --dir crates/agent-gui lint
pnpm --dir crates/agent-gui test:frontend
cargo check --manifest-path crates/agent-gui/src-tauri/Cargo.toml --tests
```

### Gateway

```bash
go -C crates/agent-gateway test ./...
pnpm --dir crates/agent-gateway/web build
pnpm --dir crates/agent-gateway/web test
```

### Cross-cutting and contracts

```bash
node scripts/check-mirror.mjs
node tools/verify_contract_vectors.mjs
python tools/verify_contract_schema.py
git diff --check
```

`make help` lists the full set of build entry points when GNU Make is
available.

## Code style and conventions

- **Rust**: follow `rustfmt` / `clippy`. Tauri commands and domain types prefer
  `camelCase` serde renaming at the API boundary while internal Rust stays
  idiomatic.
- **TypeScript / React**: the existing ESLint and Prettier configuration is the
  source of truth. Mirror files between `crates/agent-gui` and
  `crates/agent-gateway/web` must stay in sync — `scripts/check-mirror.mjs`
  enforces this, so run it before committing.
- **Go**: `gofmt` / `go vet`. Keep the Gateway dependency surface small.
- **User-facing strings** go through the i18n catalog
  (`crates/agent-gui/src/i18n/config.ts`) with both Chinese and English
  entries.
- **Security boundaries are load-bearing.** When touching tools, credentials,
  or anything that crosses a trust boundary, preserve the existing
  confirmation flows and redaction behavior. See [SECURITY.md](SECURITY.md) for
  the trust model.

## Tests

Add or update tests alongside your change. The repository mixes Node test
runners, `cargo test`, and `go test`. Frontend tests that assert against
selectable tool definitions, system tool options, and contract vectors are
there to catch drift — update the expected fixtures deliberately, not to make
the suite pass.

## Commit messages and pull requests

- Write commit messages in the imperative mood ("Add …", "Fix …").
- Reference the issue number in the PR description when applicable.
- Include before/after notes for user-visible changes and migration steps for
  anything that affects configuration or signing keys.
- Mark PRs that change the updater, signing, or credential handling as clearly
  as possible so they get extra review.

## Branching and releases

Development happens on `main`. Tagged releases follow `vMAJOR.MINOR.PATCH`
(pre-release suffixes are allowed). Pushing such a tag triggers the desktop
release workflow. Do not modify `package.json` versions or `updater/latest.json`
by hand for releases — the workflow writes the version into a generated Tauri
config. See
[Desktop updates](crates/agent-gui/docs/releasing/desktop-updates.md) for the
full release flow.

## Reporting issues

For bugs and feature requests, open a GitHub issue with enough context to
reproduce. For security-sensitive reports, follow [SECURITY.md](SECURITY.md)
instead of opening a public issue.
