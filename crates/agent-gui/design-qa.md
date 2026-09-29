# ArcForge Settings — Design QA

final result: passed

Updated: 2026-09-24. Scope: desktop settings frontend, preserving the approved overview structure and existing configuration destinations.

## Visual source and normalization

- Final user-approved source: `C:/Users/ADMINI~1/AppData/Local/Temp/codex-clipboard-42a7bcd5-ad9e-4c91-8f8d-47a807ec87f1.png` (1658 × 949 pixels).
- Earlier layout reference: `C:/Users/Administrator/.codex/generated_images/01a0d0db-cbec-70b2-b041-9a7179b956f8/exec-36855805-2c59-47b6-b20c-aee002cbf4b1.png`.
- Implementation: `.tmp/settings-design-qa/1658x949.png`, 1658 × 949 CSS px and image px, deviceScaleFactor 1. No resampling. Both final source and implementation show the same Windows title bar, light theme, Agent mode, ready runtime, six sections, and demo inventory.
- Source and implementation were opened together in the same visual comparison input. The latest source matches the implemented page. Earlier image typography, input size, and surface treatment were deliberately superseded by the user's detailed token/typography brief and approval of the final screenshot.
- Focused evidence: `.tmp/settings-design-qa/runtime-detail.png`, `row-detail.png`, and `search-focus.png`. These were inspected alongside the full reference; icons, active indicator, metadata, row hover and search focus remain legible at native density.

## Required fidelity surfaces

| Surface | Result |
| --- | --- |
| Fonts and typography | System UI stack with Chinese system fallback. Title 28/650, description 14/400, item title 15/600, body 13/400 and status 12/500. No added fonts. Titles, summaries and links remain distinct and wrap without overlap. |
| Spacing and layout rhythm | Top navigation, upper-right search, runtime strip, two-column directory and bottom save status retained. Main content is bounded on large screens. Runtime wraps at 1120 px; directory becomes one column at 720 px. Controls remain reachable via scrolling. |
| Colors and tokens | Three surfaces use #F6F7F9, #FAFBFC and #FFFFFF. Weak borders and 2.5% row hover. #4F6BFF accent is confined to interaction/runtime indicators; small accent text uses #4058E8 for contrast. Neutral metadata uses #687283. No large shadows or gradients. Dark tokens preserve legibility. |
| Images and icons | Existing ArcForge logo and existing icon library reused; no generated substitutes. Settings/core icons 18 px, runtime icons 14 px, arrows 16 px, consistent 1.7 stroke. |
| Copy and content | All six approved categories retained. Existing settings destinations remain available. Counts use configuration inventory in production; MCP connected requires running and initialized runtime status. Unavailable status is not represented as connected. Demo counts are isolated to the QA fixture. |

## Browser verification

Headless Google Chrome via Playwright, explicitly authorized by the user after the built-in browser connection failed. Real production React components and CSS render in a dev-only fixture; official Tauri IPC mocks prevent reads/writes to user settings.

| Viewport | Evidence | Result |
| --- | --- | --- |
| 1440 × 900 | `.tmp/settings-design-qa/1440x900.png` | Two columns; all six sections and save footer visible. |
| 1920 × 1080 | `.tmp/settings-design-qa/1920x1080.png` | Bounded content, stable alignment, no excessive stretching. |
| 1658 × 949 | `.tmp/settings-design-qa/1658x949.png` | Final approved reference comparison. |
| 1024 × 768 | `.tmp/settings-design-qa/1024x768.png` | Runtime reflows; no horizontal overflow. |
| 800 × 700 | `.tmp/settings-design-qa/800x700.png` | Two columns with wrapped links; scrolling keeps footer visible. |
| 640 × 760 | `.tmp/settings-design-qa/640x760.png` | Single-column layout; no clipping of controls. |
| 480 × 720 | `.tmp/settings-design-qa/480x720.png` | Compact runtime and single column; no horizontal overflow. |

Automated interactions checked:

- Chat / Agent changes the original execution mode setting; selecting Agent in developer mode preserves `agent-dev`.
- Ctrl K focuses the search; query results resolve by setting/alias; keyboard Enter and pointer selection navigate; Escape clears; moving focus outside closes results.
- Search navigates and focuses the font anchor, including a repeated search for the same anchor. MCP navigation reaches the existing panel.
- Row hover uses rgba(15,23,42,.025), with browser alpha quantization allowed; arrow moves 2 px.
- Ready, loading, unavailable, running, empty configuration, English, dark, developer mode and save error states render successfully.
- Existing sidebar and transcript stores update the strip from Running to Ready; save-in-progress uses the original save state.
- Reduced motion disables spinner animation; back action reaches the provided handler. Code inspection also confirmed the app overlay closes immediately with reduced motion and ignores child transition events.
- Additional focused check: enabling debug writes `agent-dev`; Chat disables the debug switch. Screenshots: `debug-disabled.png`, `font-detail.png`.
- Browser console errors and uncaught page errors: 0. Results: `.tmp/settings-design-qa/results.json`.

Reproduction: `test/visual/README.md`, `test/visual/settings-overview.cjs`.

## Comparison history and fixes

| Finding | Fix | Post-fix evidence |
| --- | --- | --- |
| P2: search results remained open after keyboard focus left the search | Close on outside focus/pointer events; retain keyboard navigation and scroll the active result into view | Browser assertions; `search-focus.png` |
| P2: navigating to the same field twice did not restore field focus | Track repeated navigation and refocus the destination | Repeated font search assertion; `font-detail.png` |
| P2: disabling motion could leave an invisible settings overlay intercepting interaction | Close synchronously under reduced motion; filter bubbled transition-end events | Type check and app callback inspection; reduced-motion browser check |
| P2: muted small text and accent text had insufficient contrast | Darker neutral metadata and dedicated accent text token; preserve original accent for focus/indicator | Latest desktop/runtime screenshots |
| P2: shared button font shorthand overrode component weights | Lower base reset specificity so component typography applies | `runtime-detail.png`, final approved screenshot |
| P2: mixed MCP success/unavailable reads could show a connected color with unavailable copy | Give unavailable state priority in both copy and appearance | Latest error-state screenshot and status model test |
| Initial runtime spacing was uneven | Equal capability tracks within the existing strip | Final approved screenshot |
| An initial dark screenshot caught the theme transition halfway | Wait for the 150 ms transition before capturing; no product change | `.tmp/settings-design-qa/dark.png` |

## Code checks and limitations

- Production TypeScript and the separately typed visual fixture: passed.
- Vite production build: passed. Existing large-chunk and node:fs externalization warnings remain; no build error.
- Focused settings, i18n and system-theme regression suite: 186 passed, 0 failed.
- Biome on the new settings modules and page shell: passed.
- Native Tauri launch, actual MCP transports, OS window controls and disk persistence were not exercised by browser mocks. Existing backend/persistence implementations are reused; the QA result applies to the frontend changes.

## Implementation checklist

- [x] Approved page structure and six configuration groups retained.
- [x] Surface, accent, typography, radii and compact controls implemented.
- [x] Keyboard, focus, hover, loading, error, running and disabled states checked.
- [x] Desktop and narrow viewports captured and inspected.
- [x] Source/implementation and focused-region visual comparisons completed.
- [x] No outstanding P0/P1/P2 frontend findings.

Follow-up polish: none required for the approved overview. Further redesign of nested settings forms is outside this visual iteration.

---

## Follow-up: remote access navigation

- User-reported failure reproduced in the preview: the missing `gateway_status` mock returned null, causing `RemoteSection` to read `status.online` on a null value.
- Added an offline gateway mock and null/rejected-status scenarios. The production component now falls back to disconnected status for an empty initial response and ignores empty status events.
- Directory sublinks now have explicit accessible names so decorative separators are not read as part of the labels.
- Verified remote navigation, gateway address editing, and return to overview under normal, null and rejected runtime responses. Evidence: `.tmp/settings-design-qa/remote-access.png`.
- Browser suite: 18 checks, zero console/page errors. Focused remote-input/settings-overview tests: 4 passed. TypeScript (including the fixture) passed.

## Previous review — preserved composer QA

# Composer model and Git redesign QA

- Source visual truth: `E:/ArcForge/crates/agent-gui/design-qa-artifacts/composer-reference.png`
- Closed implementation: `E:/ArcForge/crates/agent-gui/design-qa-artifacts/composer-model-closed.png`
- Add menu with Git: `E:/ArcForge/crates/agent-gui/design-qa-artifacts/composer-add-git-menu.png`
- Git submenu: `E:/ArcForge/crates/agent-gui/design-qa-artifacts/composer-git-submenu.png`
- Model and reasoning picker: `E:/ArcForge/crates/agent-gui/design-qa-artifacts/composer-model-picker.png`
- Preview route: `http://127.0.0.1:4174/test/fixtures/composer-preview/`
- State: light theme, empty composer, `glm-5.2`, Agent mode, high reasoning, `master` branch

## Full-view comparison evidence

- The implementation preserves the reference card width, generous top writing area, 24 px radius, translucent surface, soft border, shadow, expand control, and right-aligned send action.
- The bottom toolbar is intentionally reduced from many unrelated controls to three anchors: `添加`, current model, and send.
- Git no longer occupies a permanent pill. It is a clearly labeled project action in the Add menu and exposes the existing branch workflow in a nested menu.
- The model selector no longer occupies the page header. It is anchored above the composer model pill, keeping conversation configuration next to the message being composed.
- Reasoning is no longer a separate toolbar pill. Low, medium, high, and extra-high choices live in one fixed section inside the model panel.

## Focused-region comparison evidence

- Typography and rhythm: 11–14 px interface text, 30–32 px controls, 8–12 px row spacing, and compact group separators match the existing ArcForge density.
- Popover geometry: both menus open above the composer, stay within the 1280 × 720 test viewport, and use collision-aware positioning. The Git submenu opens laterally without covering its parent trigger.
- Visual hierarchy: file/reference actions remain first, runtime capabilities remain together, and Git is separated as the project-level action. Model search and model results are scrollable while execution mode and reasoning remain stable.
- Tokens and assets: only existing theme tokens and the project icon set are used. No replacement SVG, emoji, placeholder image, or one-off color system was introduced.

## Interaction and accessibility checks

- The closed composer exposes exactly one Add button, one current-model button, and one send button.
- Opening Add exposes Upload, reference file, Skill, web search, Thinking, and Git as semantic menu items.
- Git opens as an expanded submenu with fetch, pull, push, refresh, local branches, create branch, and more actions.
- The model panel is a semantic dialog with two labeled radio groups: execution mode and reasoning effort.
- Selecting `最高` updates the checked reasoning option without closing the panel.
- Selecting another model closes the panel and updates the composer trigger.
- Switching Agent to Chat updates the checked execution-mode option.
- TypeScript and focused model-picker/composer tests pass after the refactor.

## Comparison history

1. Closed-state comparison against the supplied composer crop.
   - Finding: the permanent reasoning and branch pills created the toolbar clutter the user wanted removed.
   - Fix: consolidated reasoning into the model panel and Git into Add, leaving a quieter three-anchor toolbar.
2. Add-menu and Git-submenu inspection.
   - Finding: no clipping or collision at the reference-sized composer width; submenu hierarchy remains understandable.
3. Model-panel inspection.
   - Finding: model selection, execution mode, and reasoning form one coherent configuration surface; no actionable P0, P1, or P2 visual findings remain.

## Follow-up polish

- No blocking polish items. If more composer tools are added later, the Add menu should gain short group labels rather than adding new permanent toolbar controls.

final result: passed

## Menu interaction fixes — 2026-09-29

- Model-search Escape now reaches the Popover dismissal handler in desktop and Gateway, with focus restored to the model trigger. The new composer browser regression failed against the old handler and passes after the fix.
- Settings Memory status and its category summary now reflect that desktop Chat and Agent both use Memory; channel-specific permission checks are unchanged.
- Opening settings focuses its heading and makes the mounted chat subtree inert. Closing restores the opener, with a chat-container fallback when the opener is gone. Native title-bar controls and settings portals remain accessible.
- Verification: 204 focused settings/i18n/model tests, GUI and Web TypeScript checks, production Vite build, 19 settings browser check groups and 5 composer browser check groups passed. Browser checks include Tab/Shift+Tab, blocked background programmatic focus, nested settings dialog/model menus, reduced motion and focus restoration.
- Native Tauri startup, the App overlay transition timing, and actual disk persistence were not exercised by the browser fixtures; no desktop package was installed.
