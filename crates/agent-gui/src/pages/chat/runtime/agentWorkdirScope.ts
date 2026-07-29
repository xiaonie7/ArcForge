export type AgentTurnWorkdirResolution = {
  workdir: string;
  allowEmptyWorkdir: boolean;
};

export function resolveAgentTurnWorkdir(params: {
  isAgentMode: boolean;
  hasTrustedPrincipal: boolean;
  explicitWorkdir?: string;
  gatewayWorkdir?: string;
  unscopedAgent: boolean;
  conversationWorkdir?: string;
  defaultWorkdir: string;
}): AgentTurnWorkdirResolution {
  if (!params.isAgentMode) {
    return { workdir: "", allowEmptyWorkdir: false };
  }
  if (params.hasTrustedPrincipal) {
    return { workdir: "", allowEmptyWorkdir: true };
  }
  if (typeof params.explicitWorkdir === "string") {
    const workdir = params.explicitWorkdir.trim();
    return { workdir, allowEmptyWorkdir: workdir.length === 0 };
  }
  if (typeof params.gatewayWorkdir === "string") {
    const workdir = params.gatewayWorkdir.trim();
    return { workdir, allowEmptyWorkdir: workdir.length === 0 };
  }
  if (params.unscopedAgent) {
    return { workdir: "", allowEmptyWorkdir: true };
  }
  return {
    workdir: (params.conversationWorkdir ?? params.defaultWorkdir).trim(),
    allowEmptyWorkdir: false,
  };
}

export function resolveLocalQueuedTurnWorkdir(params: {
  isAgentMode: boolean;
  editedWorkdir?: string;
  unscopedAgent: boolean;
  conversationWorkdir?: string;
  displayedWorkdir: string;
  defaultWorkdir: string;
}) {
  if (!params.isAgentMode) return "";
  if (typeof params.editedWorkdir === "string") return params.editedWorkdir.trim();
  if (params.unscopedAgent) return "";
  return (params.conversationWorkdir ?? params.displayedWorkdir ?? params.defaultWorkdir).trim();
}

export function resolveGatewayQueuedTurnWorkdir(params: {
  hasTrustedPrincipal: boolean;
  requestedWorkdir?: string;
  conversationWorkdir?: string;
  displayedWorkdir: string;
  defaultWorkdir: string;
}) {
  if (params.hasTrustedPrincipal) return "";
  return (
    params.requestedWorkdir ??
    params.conversationWorkdir ??
    params.displayedWorkdir ??
    params.defaultWorkdir
  ).trim();
}
