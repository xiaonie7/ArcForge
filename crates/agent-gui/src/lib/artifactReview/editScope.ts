import type {
  ArtifactEditResult,
  ArtifactEditScope,
  EditScopeKind,
  ScopedEditContext,
  SelectionContext,
} from "./types";
import { artifactBasename } from "./types";

/** First line of a reply that declines because the locked target is too small for the request. */
export const SCOPE_TOO_NARROW_MARKER = "SCOPE_TOO_NARROW:";

export function createEditId(now = Date.now()) {
  return `e-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Element and page scopes lock the tool set; a deck scope keeps the ordinary tools. */
export function isRestrictedEditScope(
  scope: ArtifactEditScope | null | undefined,
): scope is ArtifactEditScope {
  return Boolean(scope && scope.kind !== "artifact");
}

export function editScopeFromSelection(
  selection: SelectionContext,
  kind: EditScopeKind,
  editId: string,
): ArtifactEditScope {
  const { artifact } = selection;
  if (kind === "artifact") return { editId, kind, artifact };
  const unitId =
    selection.selection.type === "element" ? selection.selection.unitId : selection.selection.id;
  if (!unitId || selection.selection.type === "artifact") {
    throw new Error("A page or element must be selected for a scoped edit.");
  }
  if (kind === "element") {
    if (selection.selection.type !== "element") {
      throw new Error("An element must be selected for an element-scoped edit.");
    }
    return { editId, kind, artifact, unitId, elementId: selection.selection.id };
  }
  return { editId, kind, artifact, unitId };
}

export function describeEditScope(scope: ArtifactEditScope) {
  if (scope.kind === "artifact") return "the whole deck";
  if (scope.kind === "element") return `slide ${scope.unitId} › element #${scope.elementId}`;
  return `slide ${scope.unitId} (the whole page)`;
}

function replacementFormHint(kind: ScopedEditContext["replacementKind"], scope: ArtifactEditScope) {
  switch (kind) {
    case "svg_element":
      return `one complete SVG element that keeps id="${scope.elementId}" and its data-role (no <svg> wrapper, no XML declaration)`;
    case "svg_page":
      return "the complete page SVG (viewBox 0 0 1280 720)";
    case "template_text":
      return '{"text": "new text"} (line breaks become paragraphs; template formatting is kept)';
    case "template_table":
      return '{"rows": [["cell", ...], ...]} matching the table\'s current row and column counts';
    case "template_page":
      return '{"text_edits": [...], "table_edits": [...]} using shape ids from inspect';
    default:
      return "";
  }
}

/** Per-turn system prompt section; injected only while an inline edit runs. */
export function buildScopedEditSystemPrompt(scope: ArtifactEditScope): string {
  const deck = scope.artifact.path;
  const manifest = scope.manifestPath ?? "the deck manifest (deck/deck.json)";
  if (scope.kind === "artifact") {
    return [
      "## Deck-wide Edit",
      `The user allowed changes across the whole deck ${deck} (manifest ${manifest}) from the artifact review panel.`,
      "- Prefer OfficeRuntime document=presentation action=patch per page (slide_id, optional element_id, replacement) so every change is recorded and reversible; use create only when several pages must change together.",
      "- Report every page id you changed in one or two sentences.",
    ].join("\n");
  }
  const target = describeEditScope(scope);
  const targetArguments =
    scope.kind === "element"
      ? `slide_id="${scope.unitId}", element_id="${scope.elementId}"`
      : `slide_id="${scope.unitId}"`;
  return [
    "## Scoped Inline Edit",
    `The user asked for one change from the artifact review panel. This turn is locked to a single target: ${deck} › ${target}.`,
    `- The only way to change files in this turn is OfficeRuntime with document=presentation, action=patch, spec_path="${manifest}", output_path="${deck}", ${targetArguments}, and replacement holding the complete new content. Write, Edit, Shell, and action=create are not available; the runtime rejects patches aimed at any other slide_id or element_id.`,
    "- The user message contains the current content of the target and states which replacement form applies. Read other files (the style pack, the manifest, neighbouring pages) only when the change depends on them; never modify them.",
    `- If the request cannot be done inside this target (it needs other pages, neighbouring elements, deck-wide style changes, or new assets), do not call patch. Reply with a single line that starts with \`${SCOPE_TOO_NARROW_MARKER}\` followed by the scope you need (page or deck) and why.`,
    "- If the patch result reports text_overflows or out_of_bounds for this page, fix them with another patch before replying.",
    "- After a successful patch, reply with one or two sentences: what changed and the page id. Do not repeat the SVG.",
  ].join("\n");
}

function fence(language: string, body: string) {
  return `\`\`\`${language}\n${body.trim()}\n\`\`\``;
}

/** Text appended to the user message for a scoped edit, replacing the generic selection note. */
export function buildScopedEditInstruction(
  scope: ArtifactEditScope,
  context: ScopedEditContext,
  selection?: SelectionContext,
): string {
  const lines = [
    "Artifact review selection: the user is looking at this target in the review panel and the request refers to it.",
    `- artifact: ${scope.artifact.path} (${scope.artifact.artifactType})`,
    `- manifest: ${context.manifestPath}${context.stage || context.mode ? ` (stage: ${context.stage ?? "?"}, mode: ${context.mode ?? "?"})` : ""}`,
  ];
  if (context.templatePath) lines.push(`- template: ${context.templatePath}`);
  if (scope.kind === "artifact") {
    lines.push(
      `- scope: the whole deck (${context.slideCount ?? context.slideIds?.length ?? "?"} pages${context.slideIds?.length ? `: ${context.slideIds.join(", ")}` : ""})`,
    );
    lines.push("Change only what the request needs and report which page ids changed.");
    return lines.join("\n");
  }
  const slide = context.slide;
  const position =
    slide && typeof context.slideCount === "number"
      ? ` (slide ${slide.index} of ${context.slideCount})`
      : "";
  lines.push(
    `- slide: ${scope.unitId}${position}${slide?.svgPath ? `, source: ${slide.svgPath}` : slide?.sourceSlide ? `, template page ${slide.sourceSlide}` : ""}`,
  );
  const bbox = selection?.selection.type === "element" ? selection.selection.bbox : undefined;
  const element = context.element;
  if (scope.kind === "element" && element) {
    const role = element.role ?? selection?.selection.elementType;
    const box = bbox
      ? `, bbox x=${bbox[0]} y=${bbox[1]} w=${bbox[2]} h=${bbox[3]} (canvas 1280×720)`
      : "";
    if (context.replacementKind === "svg_element") {
      lines.push(`- element: #${element.id}${role ? ` (data-role="${role}")` : ""}${box}`);
    } else {
      lines.push(
        `- element: template shape "${element.name ?? element.id}" (shape_id ${element.shapeId ?? "?"})${box}`,
      );
    }
  }
  lines.push(
    `- replacement form (${context.replacementKind}): ${replacementFormHint(context.replacementKind, scope)}`,
  );
  lines.push(
    "Change only this target. A request for a broader change must return SCOPE_TOO_NARROW; it does not expand the scope lock. Keep every id and every other element in place.",
  );
  if (context.replacementKind === "svg_element" && element?.snippet) {
    lines.push(
      element.truncated
        ? `Current content of #${element.id} (truncated; Read ${slide?.svgPath ?? "the page SVG"} for the rest):`
        : `Current content of #${element.id}:`,
    );
    lines.push(fence("svg", element.snippet));
  } else if (context.replacementKind === "svg_page" && context.page) {
    if (context.page.truncated) {
      lines.push(
        `The page SVG is ${context.page.sizeBytes} bytes; Read ${slide?.svgPath ?? "it"} before replacing it.`,
      );
    } else {
      lines.push("Current page SVG:");
      lines.push(fence("svg", context.page.snippet));
    }
  } else if (
    (context.replacementKind === "template_text" || context.replacementKind === "template_table") &&
    element
  ) {
    lines.push(
      `Current template value: ${JSON.stringify(element.templateValue ?? null)}${
        element.currentEdit ? `\nCurrent manifest edit: ${JSON.stringify(element.currentEdit)}` : ""
      }`,
    );
  } else if (context.replacementKind === "template_page" && slide) {
    lines.push(
      `Current manifest edits: ${JSON.stringify({ text_edits: slide.textEdits ?? [], table_edits: slide.tableEdits ?? [] })}`,
    );
  }
  return lines.join("\n");
}

/** Reads a SCOPE_TOO_NARROW reply; tolerates leading markdown such as `**` or `> `. */
export function parseScopeTooNarrow(
  text: string,
): { reason: string; suggestedKind: "unit" | "artifact" } | null {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/^[\s>*`_#-]+/, "").trim();
    if (!line.toUpperCase().startsWith(SCOPE_TOO_NARROW_MARKER)) continue;
    const reason = line
      .slice(SCOPE_TOO_NARROW_MARKER.length)
      .replace(/[*`_]+$/, "")
      .trim();
    const suggestedKind =
      /\b(deck|whole deck|entire deck|all pages|every page|style pack|template)\b|整个|全部|所有页|样式/i.test(
        reason,
      )
        ? "artifact"
        : "unit";
    return { reason: reason || text.trim(), suggestedKind };
  }
  return null;
}

/** Normalizes the runtime's patch report (snake_case) into the review model. */
export function parseArtifactEditResult(parsed: unknown): ArtifactEditResult | null {
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const edit = record.edit as Record<string, unknown> | undefined;
  const deck = (record.deck ?? {}) as Record<string, unknown>;
  if (record.action !== "patched" || !edit || typeof edit.edit_id !== "string") return null;
  const ids = (value: unknown) =>
    Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  return {
    editId: edit.edit_id,
    unitId: typeof edit.slide_id === "string" ? edit.slide_id : "",
    elementId: typeof edit.element_id === "string" ? edit.element_id : undefined,
    scope: edit.scope === "element" ? "element" : "unit",
    kind: typeof edit.kind === "string" ? edit.kind : "",
    reverted: edit.reverted === true,
    beforeText: typeof edit.before_text === "string" ? edit.before_text : "",
    afterText: typeof edit.after_text === "string" ? edit.after_text : "",
    changedUnitIds: ids(deck.changed_slide_ids),
    patchedUnitIds: ids(deck.patched_slide_ids),
    sharedInputsChanged: deck.shared_inputs_changed === true,
    textOverflows: Array.isArray(deck.text_overflows) ? deck.text_overflows : [],
    outOfBounds: Array.isArray(deck.out_of_bounds) ? deck.out_of_bounds : [],
  };
}

export function editScopeTitle(scope: ArtifactEditScope) {
  const file = artifactBasename(scope.artifact.path);
  if (scope.kind === "artifact") return file;
  if (scope.kind === "element") return `${file} › ${scope.unitId} › #${scope.elementId}`;
  return `${file} › ${scope.unitId}`;
}
