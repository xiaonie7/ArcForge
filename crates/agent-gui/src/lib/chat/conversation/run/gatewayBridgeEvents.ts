import type { ConversationViewState, HistoryMessageRef } from "../conversationState";
import type { RetryAttemptRecord } from "../liveTranscriptStore";

type QueueEventOptions = {
  allowAfterClose?: boolean;
  /** Internal: only assistant token events participate in fallback tracking. */
  tracksForwardedText?: boolean;
};

type QueueUserMessageOptions = {
  // Edit-resend: the edited (truncation-base) user message. The gateway
  // broadcasts a `rebased` event from it so every other connected client
  // truncates its transcript at the same point.
  baseMessageRef?: HistoryMessageRef;
};

// Wire shape mirror of the gateway's ChatMessageRef (snake_case), matching
// the webui's buildHistoryMessageRefPayload byte for byte.
function buildGatewayBaseMessageRefPayload(ref: HistoryMessageRef): Record<string, unknown> {
  return {
    segment_index: ref.segmentIndex,
    message_index: ref.messageIndex,
    segment_id: ref.segmentId,
    message_id: ref.messageId,
    role: ref.role,
    content_hash: ref.contentHash,
  };
}

type GatewayBridgeSendResult = Promise<void> | void;

type GatewayBridgeEventControllerParams = {
  conversationId: string;
  requestId: string;
  workerId?: string;
  enabled: boolean;
  /** Maximum assistant/output text code points forwarded for this run. */
  maxOutputChars?: number;
  sendEvent: (
    requestId: string,
    event: Record<string, unknown>,
    options?: { workerId?: string },
  ) => GatewayBridgeSendResult;
  resolveErrorConversationId?: () => string;
};

export type GatewayBridgeEventController = {
  queueEvent: (
    event: Record<string, unknown>,
    options?: QueueEventOptions,
  ) => GatewayBridgeSendResult;
  queueUserMessage: (
    message: string,
    uploadedFiles?: readonly unknown[],
    options?: QueueUserMessageOptions,
  ) => GatewayBridgeSendResult;
  queueToken: (delta: string, extra?: Record<string, unknown>) => void;
  queueTitle: (nextTitle: string, allowAfterClose?: boolean) => void;
  queueToolStatus: (status: string | null, isCompaction?: boolean) => void;
  queueRetryAttempts: (attempts: readonly RetryAttemptRecord[]) => void;
  queueCheckpoint: (state: ConversationViewState) => void;
  emitError: (
    message: string,
    conversationIdOverride?: string,
  ) => GatewayBridgeSendResult;
  close: () => void;
  hasForwardedText: () => boolean;
  isClosed: () => boolean;
};

export function createGatewayBridgeEventController(
  params: GatewayBridgeEventControllerParams,
): GatewayBridgeEventController {
  let forwardedText = false;
  let streamClosed = false;
  let lastToolStatusKey = "";
  let lastToolStatus: string | null = null;
  let lastToolStatusIsCompaction = false;
  let lastRetryAttemptsKey = "[]";
  const maxOutputChars =
    Number.isFinite(params.maxOutputChars) && (params.maxOutputChars as number) >= 0
      ? Math.floor(params.maxOutputChars as number)
      : undefined;
  let remainingOutputChars = maxOutputChars;

  const truncateCodePoints = (value: string, maximum: number) => {
    if (maximum <= 0) return "";
    const codePoints = Array.from(value);
    return codePoints.length <= maximum ? value : codePoints.slice(0, maximum).join("");
  };

  const limitOutputEvent = (event: Record<string, unknown>) => {
    if (maxOutputChars === undefined) return event;
    if (event.type === "token" && typeof event.text === "string") {
      const text = truncateCodePoints(event.text, remainingOutputChars ?? 0);
      remainingOutputChars = Math.max(0, (remainingOutputChars ?? 0) - Array.from(text).length);
      return text === event.text ? event : { ...event, text };
    }
    if (event.type === "done" && typeof event.final_text === "string") {
      const finalText = truncateCodePoints(event.final_text, maxOutputChars);
      return finalText === event.final_text ? event : { ...event, final_text: finalText };
    }
    return event;
  };

  const queueEvent = (event: Record<string, unknown>, options?: QueueEventOptions) => {
    if (!params.enabled) return;
    if (streamClosed && !options?.allowAfterClose) return;
    const limitedEvent = limitOutputEvent(event);
    if (
      options?.tracksForwardedText &&
      limitedEvent.type === "token" &&
      typeof limitedEvent.text === "string" &&
      limitedEvent.text.length > 0
    ) {
      forwardedText = true;
    }
    return params.sendEvent(params.requestId, limitedEvent, { workerId: params.workerId });
  };

  const queueToolStatus = (status: string | null, isCompaction = false) => {
    const normalizedStatus = status?.trim() ?? "";
    const statusKey = `${normalizedStatus}::${isCompaction ? "1" : "0"}`;
    if (statusKey === lastToolStatusKey) return;
    lastToolStatusKey = statusKey;
    lastToolStatus = normalizedStatus || null;
    lastToolStatusIsCompaction = isCompaction;
    queueEvent({
      type: "tool_status",
      status: normalizedStatus || null,
      isCompaction,
      conversation_id: params.conversationId,
    });
  };

  // Rides on the tool_status wire event (re-sending the current status text)
  // so the WebUI can mirror the desktop's expandable retry-details block
  // without a new event type. Events without a retryAttempts array leave the
  // WebUI's list untouched; an explicit empty array clears it.
  const queueRetryAttempts = (attempts: readonly RetryAttemptRecord[]) => {
    const payload = attempts.map((entry) => ({
      attempt: entry.attempt,
      maxAttempts: entry.maxAttempts,
      errorMessage: entry.errorMessage,
    }));
    const attemptsKey = JSON.stringify(payload);
    if (attemptsKey === lastRetryAttemptsKey) return;
    lastRetryAttemptsKey = attemptsKey;
    queueEvent({
      type: "tool_status",
      status: lastToolStatus,
      isCompaction: lastToolStatusIsCompaction,
      retryAttempts: payload,
      conversation_id: params.conversationId,
    });
  };

  return {
    queueEvent,
    queueUserMessage(message: string, uploadedFiles = [], options?: QueueUserMessageOptions) {
      if (!message.trim() && uploadedFiles.length === 0) return;
      return queueEvent({
        type: "user_message",
        message,
        uploaded_files: uploadedFiles.map((file) =>
          file && typeof file === "object" ? { ...(file as Record<string, unknown>) } : file,
        ),
        conversation_id: params.conversationId,
        ...(options?.baseMessageRef
          ? {
              base_message_ref: buildGatewayBaseMessageRefPayload(options.baseMessageRef),
              reason: "edit_resend",
            }
          : {}),
      });
    },
    queueToken(delta: string, extra?: Record<string, unknown>) {
      if (delta.length === 0 && !extra) return;
      queueEvent(
        {
          type: "token",
          text: delta,
          conversation_id: params.conversationId,
          ...extra,
        },
        { tracksForwardedText: true },
      );
    },
    queueTitle(nextTitle: string, allowAfterClose = false) {
      const title = nextTitle.trim();
      if (!title) return;
      queueEvent(
        {
          type: "token",
          text: "",
          title,
          titleFinal: allowAfterClose === true,
          conversation_id: params.conversationId,
        },
        { allowAfterClose },
      );
    },
    queueToolStatus,
    queueRetryAttempts,
    queueCheckpoint(state: ConversationViewState) {
      const activeSegment = state.segments[state.activeSegmentIndex];
      const summary = activeSegment?.summary;
      if (!summary?.content.trim()) return;

      queueEvent({
        type: "token",
        text: summary.content,
        provider: "arcforge",
        model: "summary",
        api: "arcforge-compaction",
        conversation_id: params.conversationId,
        checkpoint: {
          summaryId: summary.id,
          segmentIndex: state.activeSegmentIndex,
          coveredMessageCount: summary.summaryMeta.coveredMessageCount,
          coversThroughMessageId: summary.summaryMeta.coversThroughMessageId,
          timestamp: summary.timestamp,
          generatedBy: {
            providerId: summary.summaryMeta.generatedBy.providerId,
            model: summary.summaryMeta.generatedBy.model,
            promptVersion: summary.summaryMeta.generatedBy.promptVersion,
          },
        },
      });
    },
    emitError(message: string, conversationIdOverride?: string) {
      return queueEvent({
        type: "error",
        message,
        conversation_id:
          conversationIdOverride ?? params.resolveErrorConversationId?.() ?? params.conversationId,
      });
    },
    close() {
      streamClosed = true;
    },
    hasForwardedText() {
      return forwardedText;
    },
    isClosed() {
      return streamClosed;
    },
  };
}
