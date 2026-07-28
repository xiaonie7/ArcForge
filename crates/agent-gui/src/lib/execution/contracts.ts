export const EXECUTION_PROTOCOL_VERSION = "1.0" as const;
export const EXECUTION_SCHEMA_VERSION = 1 as const;
export const NATIVE_PI_BACKEND_ID = "native-pi" as const;

export type AgentBackendId = typeof NATIVE_PI_BACKEND_ID;
export type ExecutionRunMode = "plan" | "execute";
export type CodeTaskState =
  | "running"
  | "backend_completed"
  | "candidate_ready"
  | "validating"
  | "waiting_review"
  | "validation_failed"
  | "backend_failed"
  | "cancelled"
  | "unknown"
  | "applied"
  | "succeeded";
export type ExecutionCapability =
  | "workspace.read"
  | "workspace.write"
  | "process.execute"
  | "coordination.send";

export type ValidationCheckId =
  | "base_revision"
  | "candidate_paths"
  | "candidate_limits"
  | "candidate_stability"
  | "git_diff_check";

export type RunSpec = {
  schemaVersion: typeof EXECUTION_SCHEMA_VERSION;
  protocolVersion: typeof EXECUTION_PROTOCOL_VERSION;
  taskId: string;
  runId: string;
  backendId: AgentBackendId;
  mode: ExecutionRunMode;
  workspace: {
    workspaceId: string;
    parentRoot: string;
    taskRoot: string;
    baseRevision: string;
  };
  capabilities: readonly ExecutionCapability[];
  validationPlan: {
    requiredChecks: readonly ValidationCheckId[];
    /**
     * Candidate code is not allowed to select commands for its own validator.
     * Project build/test commands will be added here only after ArcForge has an
     * OS-enforced process sandbox.
     */
    commands: readonly string[];
  };
  candidatePolicy: {
    /**
     * Empty means all paths inside the task workspace are eligible for the
     * candidate. This is a validation boundary, never an Apply approval.
     */
    allowedOutputPaths: readonly string[];
  };
  createdAt: number;
};

export type SealedRunSpec = {
  spec: Readonly<RunSpec>;
  hash: string;
};

export type ToolIntentEffect =
  | "workspace_read"
  | "workspace_draft_mutation"
  | "process_execution"
  | "coordination_message";

/**
 * Untrusted proposal emitted by the frontend AgentBackend adapter. The Rust
 * broker validates and enriches this shape before it becomes an authoritative
 * ToolIntent in the Work Kernel.
 */
export type ToolIntentProposal = {
  schemaVersion: typeof EXECUTION_SCHEMA_VERSION;
  protocolVersion: typeof EXECUTION_PROTOCOL_VERSION;
  taskId: string;
  runId: string;
  runSpecHash: string;
  workspaceId: string;
  sourceSequence: number;
  toolCallId: string;
  toolName: string;
  effect: ToolIntentEffect;
  arguments: Readonly<Record<string, unknown>>;
  submittedAt: number;
};

export type CompletionProposal = {
  kind: "completion_proposal";
  schemaVersion: typeof EXECUTION_SCHEMA_VERSION;
  backendId: AgentBackendId;
  taskId: string;
  runId: string;
  runSpecHash: string;
  backendStatus: "completed";
  producedAt: number;
};

export type CandidateBundle = {
  kind: "candidate_bundle";
  candidateId: string;
  taskId: string;
  runId: string;
  runSpecHash: string;
  candidateHash: string;
  baseRevision: string;
  changedPaths: string[];
  status: string;
  diffStat: string;
  diff: string;
  diffTruncated: boolean;
  untrackedFiles: string[];
  createdAt: number;
};

export type ValidationCheck = {
  id: ValidationCheckId;
  status: "passed" | "failed";
  summary: string;
};

export type ValidationReport = {
  kind: "validation_report";
  reportId: string;
  reportHash: string;
  taskId: string;
  runId: string;
  runSpecHash: string;
  candidateHash: string;
  baseRevision: string;
  status: "passed" | "failed";
  scope: "structural";
  checks: ValidationCheck[];
  /**
   * The first release deliberately does not execute candidate-controlled
   * build/test commands without an OS sandbox.
   */
  testStatus: "not_run";
  createdAt: number;
};

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`;
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(value: string) {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return bytesToHex(new Uint8Array(digest));
}

export async function sealRunSpec(
  input: Omit<RunSpec, "schemaVersion" | "protocolVersion">,
): Promise<SealedRunSpec> {
  const spec: RunSpec = Object.freeze({
    schemaVersion: EXECUTION_SCHEMA_VERSION,
    protocolVersion: EXECUTION_PROTOCOL_VERSION,
    ...input,
    workspace: Object.freeze({ ...input.workspace }),
    capabilities: Object.freeze([...input.capabilities]),
    validationPlan: Object.freeze({
      requiredChecks: Object.freeze([...input.validationPlan.requiredChecks]),
      commands: Object.freeze([...input.validationPlan.commands]),
    }),
    candidatePolicy: Object.freeze({
      allowedOutputPaths: Object.freeze([
        ...input.candidatePolicy.allowedOutputPaths,
      ]),
    }),
  });
  const hash = await sha256Hex(stableStringify(spec));
  return Object.freeze({
    spec: Object.freeze(spec),
    hash,
  });
}

export function createCompletionProposal(
  runSpec: SealedRunSpec,
  producedAt = Date.now(),
): CompletionProposal {
  return {
    kind: "completion_proposal",
    schemaVersion: EXECUTION_SCHEMA_VERSION,
    backendId: runSpec.spec.backendId,
    taskId: runSpec.spec.taskId,
    runId: runSpec.spec.runId,
    runSpecHash: runSpec.hash,
    backendStatus: "completed",
    producedAt,
  };
}

export function createToolIntentProposal(params: {
  runSpec: SealedRunSpec;
  sourceSequence: number;
  toolCallId: string;
  toolName: string;
  effect: ToolIntentEffect;
  arguments?: Record<string, unknown>;
  submittedAt?: number;
}): ToolIntentProposal {
  const submittedAt = params.submittedAt ?? Date.now();
  return {
    schemaVersion: EXECUTION_SCHEMA_VERSION,
    protocolVersion: EXECUTION_PROTOCOL_VERSION,
    taskId: params.runSpec.spec.taskId,
    runId: params.runSpec.spec.runId,
    runSpecHash: params.runSpec.hash,
    workspaceId: params.runSpec.spec.workspace.workspaceId,
    sourceSequence: params.sourceSequence,
    toolCallId: params.toolCallId,
    toolName: params.toolName,
    effect: params.effect,
    arguments: Object.freeze({ ...(params.arguments ?? {}) }),
    submittedAt,
  };
}
