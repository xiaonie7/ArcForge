# Native Pi Trusted Execution V1

Status: Phase 1 implemented (candidate pipeline)

## Decision

ArcForge is the control plane and trust boundary. `@earendil-works/pi-agent-core`
is the native inference backend (`NativePiBackend`); it is not allowed to decide
Task success or directly approve changes. Claude Code is not part of this
implementation.

The worktree coding path is:

```text
Frozen RunSpec
  -> NativePiBackend
  -> ToolIntentProposal
  -> Rust Execution Broker authorization
  -> task worktree tool execution
  -> CompletionProposal
  -> Rust CandidateBundle snapshot
  -> structural ValidationReport
  -> WaitingReview
```

## Enforced in Phase 1

- Every worktree run gets an immutable, canonical SHA-256-bound `RunSpec`.
  Rust recomputes the hash before registration and consumes a one-time
  `workspaceId` issued by the Rust worktree creator.
- Pi tool calls are converted to ordered `ToolIntentProposal` values. The
  backend adapter has no direct tool executor in its public input.
- Rust registers the exact Task/Run/RunSpec/workspace/base/path-policy binding,
  checks monotonic source sequence, capability, tool/effect classification and
  relative paths. A policy denial consumes its sequence without authorizing an
  effect, so one rejected intent cannot desynchronize the rest of the run.
- Candidate mode has a fixed surface: Read/List/Glob/Grep/Write/Edit/Delete,
  Bash and SendMessage. MCP, Office, Memory, Skills, ManagedProcess, SSH,
  tunnels, cron and nested Agent are fail-closed.
- `agent_end` produces a `CompletionProposal`; it does not produce Task success.
- The Validator receives only `runId` and `runSpecHash`; workspace, frozen base
  and allowed paths come from the still-active Rust Broker binding. Rust anchors
  every diff to that base and recomputes changed paths, tracked binary diff,
  untracked contents, file modes, candidate hash, limits and `git diff --check`.
  A two-pass `candidate_stability` check detects HEAD/path/content/mode drift;
  symlink and non-regular candidates fail closed.
- The UI and model-facing report expose `CandidateBundle`,
  `ValidationReport`, and a separate `codeTaskState`.
- Cancellation is checked after authorization, backend return and validation.
  `validation_failed` and unavailable validation remain AgentRun terminal data,
  but are returned as failed Agent-tool outcomes rather than Task success.
- Model-authored `apply_policy=auto|explicit` is not treated as Approval.
  Changed worktrees remain in `WaitingReview`; the candidate path never calls
  the legacy worktree Apply command.

## Deliberate limits

Phase 1 is a fail-closed candidate-control boundary, not the completed G1
security broker:

- A Git worktree isolates changes but is not an OS sandbox.
- Bash is registered as `workspace_only`; a shell command can still use ambient
  host permissions. It must not be advertised as hostile-code isolation.
- Authorization and execution are not yet one sealed Rust operation. The broker
  authorizes each intent before the frontend delegates to the existing
  filesystem or process IPC command, so those lower-level commands remain part
  of the trusted application surface.
- Validation scope is `structural`, and `testStatus=not_run`. Candidate-selected
  build/test commands are not executed by the validator until an OS-enforced
  process sandbox and minimal environment are available.
- The candidate hash binds the inspected base, patch, paths and contents, but
  Phase 1 does not persist an immutable candidate archive. The retained
  worktree can drift, so a future Apply must recheck the hash with strict CAS.
- Broker bindings are in-memory and are not yet the append-only domain event
  store described by the G1 plan.
- There is no trusted ApprovalGrant UI or strict CAS Apply command yet.
  Therefore Phase 1 intentionally retains candidates instead of applying them.
- The existing `subagent_worktree_apply` command remains for legacy callers,
  including its merge fallbacks, but Native Pi candidate mode does not call it.

## Next release gates

1. Add Windows restricted-token/AppContainer/Windows Sandbox or VM execution,
   minimal environment, network policy, Job Object lifetime control and
   cancel/reconciliation.
2. Rebuild the sealed candidate in a fresh validator workspace and execute only
   a frozen, trusted ValidationPlan.
3. Persist CandidateBundle and ValidationReport in the Rust domain store.
4. Add user-generated ApprovalGrant bound to RunSpec, base OID, candidate hash,
   validation report hash and policy hash.
5. Add strict CAS Apply. Any base/candidate/touched-path drift must return
   Conflict; never use 3-way or file-copy fallback for validated candidates.
6. Keep commit and push as separate explicit effects.
