# Settings visual QA

This dev-only fixture renders the production `SettingsPage`, `useSettingsFocus`, existing Windows title bar, CSS, and state stores. All IPC is intercepted with the official Tauri mocks. It never loads or saves the user's configuration. Example providers/models/connections exist only in this fixture.

Start Vite in `crates/agent-gui`, then open `/test/visual/settings-preview.html`. The production build entry does not import this fixture.

Scenarios: `?state=ready`, `loading`, `error`, `running`, `empty`, `english`, `dark`, `debug`, `save-error`, `remote-unavailable`, `remote-error`, `focus`. The `focus` scenario starts on a minimal chat surface so keyboard open, background isolation, nested portals, and focus restoration can be tested with the production hook.

For automated browser verification, use an available Playwright installation and Chromium. No new package dependency is required by the app. Run from `crates/agent-gui`:

```powershell
$env:PLAYWRIGHT_MODULE = 'C:/path/to/node_modules/playwright'
$env:CHROMIUM_EXECUTABLE_PATH = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
node test/visual/settings-overview.cjs
node test/visual/composer-menu.cjs
```

If Playwright is already resolvable and its bundled Chromium is installed, the two environment variables may be omitted. Set `SETTINGS_PREVIEW_URL` to use another Vite port.

Screenshots and JSON results are written to `.tmp/settings-design-qa/`. Type-check the fixture with `tsc --noEmit -p test/visual/tsconfig.json`.

The browser checks cover desktop/narrow layouts, search, mode persistence, navigation, runtime states, live activity, saving/error states, reduced motion, Memory status in Chat mode, and settings focus restoration. The composer check uses `/test/fixtures/composer-preview/` and verifies Escape dismissal with focus restoration, model search/selection, and mode/reasoning controls. Native Tauri process startup, real MCP connectivity, OS window actions, actual persistence, and the App overlay transition require a desktop smoke test and are not asserted by these fixtures.
