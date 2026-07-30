export function shouldStartConversationForRecentSelection(isRecentScopeActive: boolean) {
  return !isRecentScopeActive;
}

export function shouldStartConversationForWorkspaceActivation(params: {
  forceNewConversation: boolean;
  isRecentScopeActive: boolean;
  activeProjectId: string;
  targetProjectId: string;
}) {
  return (
    params.forceNewConversation ||
    params.isRecentScopeActive ||
    params.activeProjectId !== params.targetProjectId
  );
}
