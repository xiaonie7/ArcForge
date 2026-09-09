# Prompts for the five-stage deck workflow

Use these as working instructions for yourself (or for a sub-agent) at each stage. Keep the outputs in the workspace `deck/` folder.

## A. Outline architect (stage 2)

```text
Role: presentation structure architect.
Input: deck/brief.md and the collected materials.
Method: pyramid principle.
1. Lead with the conclusion: each part opens with its core point.
2. Upper levels summarize lower levels.
3. Group only items of the same logical kind.
4. Order by time, importance, or cause and effect.
Constraints: plan from the materials only; never invent facts; drop anything the materials show as outdated.
Page requirement: {{PAGE_REQUIREMENTS}}.

Output JSON:
{
  "cover": {"page_id": "p-01", "title": "", "sub_title": ""},
  "table_of_contents": ["Part 1 title", "..."],
  "parts": [
    {"part_title": "", "pages": [
      {"page_id": "p-03", "title": "", "key_points": ["", ""],
       "evidence": [{"claim": "", "source": "attachment path / query / URL"}],
       "visual_intent": "image | chart | table | text | comparison",
       "assets": ["asset-id"]}
    ]}
  ],
  "end_page": {"page_id": "p-12", "title": "", "key_points": []}
}
```

## B. Planning draft page (stage 4)

```text
Role: information architect writing one SVG wireframe page.
Canvas: viewBox="0 0 1280 720"; side margins 60, top/bottom 48; card gap ≥ 20.
Bento principles:
- Flexibility: 1 to 6 cards, decided by the content; split the page rather than shrinking text.
- Hierarchy: the most important information gets the largest card.
- Whitespace: do not fill every pixel.
Combinations: single focus; 50/50; 2/3 + 1/3; three columns; main plus two details; hero plus 2–4 small cards; mixed grid.

Allowed: rect (rx), circle, ellipse, line, polygon, path (M/L/H/V/Z), text/tspan (one tspan per line; set data-width to the card's inner width), image with data-asset, g with translate only.
Forbidden: color, gradients, curves, filters, masks, rotate, scale, foreignObject, href, base64.
Grayscale only: #FFFFFF, #F2F2F2, #D9D9D9, #8C8C8C, #404040.
Markers: <rect data-arcforge="background"/> for the page background; <rect data-arcforge="chart" data-chart='{...}'/> for a native chart; <image data-asset="id" preserveAspectRatio="xMidYMid meet"/> for pictures with text or drawings.
Give every card and text an id. Output only the SVG.
```

## C. Design page (stage 5)

```text
Role: presentation designer applying a style pack to an existing wireframe.
Keep every card at its planned position and size; change only fills, strokes, radii, typography weights, icons, and decorations.
Style pack: {{STYLE_PACK_JSON}} (palette, fonts, card radius and stroke, accent rules).
Rules:
- Use the accent color for exactly one focal element per page.
- Titles 28–36 px, card headings 18–22 px, body 14–18 px, captions 11–12 px.
- Icons are simple paths or circles in the accent color; never draw charts from rectangles.
- Decorative circles or bars may bleed off the canvas on cover and section pages only.
- Stay inside the same SVG subset as the wireframe; gradients are allowed on backgrounds and hero cards.
Output only the SVG.
```

Built-in style packs when the user has no template:

| Pack | Palette | Feel |
| --- | --- | --- |
| business-blue | primary `#1F3A93`, accent `#2EC4B6`, background `#F4F6FA`, surface `#FFFFFF`, text `#1B1F29`, muted `#6B7280` | Corporate, calm |
| dark-tech | primary `#0B1220`, accent `#22D3EE`, background `#0F172A`, surface `#111C33`, text `#E2E8F0`, muted `#94A3B8` | Product launch, technical |
| light-minimal | primary `#111827`, accent `#F59E0B`, background `#FFFFFF`, surface `#F9FAFB`, text `#111827`, muted `#6B7280` | Editorial, minimal |

When a template is provided, build the style pack from the `inspect` result: `theme.colors` (`dk1`, `lt1`, `dk2`, `lt2`, `accent1`…`accent6`) and `theme.fonts`, and keep every element outside `protected_regions`.

## D. Visual review (after each render)

```text
Look at the rendered preview and report, per page: text cut off or overlapping, cards too dense, pictures cropped where text or drawings exist, inconsistent colors or fonts across pages, elements covering template logos or footers.
For each problem name the page id and the element id, then redraw only those pages. Stop after two rounds and report what remains.
```
