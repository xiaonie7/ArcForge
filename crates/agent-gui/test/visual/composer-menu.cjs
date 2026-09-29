// Run against `pnpm dev` with PLAYWRIGHT_MODULE and, when needed,
// CHROMIUM_EXECUTABLE_PATH pointing to an installed browser runtime.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const url = process.env.COMPOSER_PREVIEW_URL ||
  'http://127.0.0.1:1420/test/fixtures/composer-preview/';
const output = path.resolve('.tmp/composer-menu-qa');

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  const checks = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(url);
    const trigger = page.locator('.composer-model-trigger');
    const popup = page.locator('.model-selector-dropdown');
    const search = popup.locator('input:not([type="radio"])');
    const models = popup.locator('.model-selector-item');

    async function openPicker() {
      await trigger.click();
      await popup.waitFor({ state: 'visible' });
      await page.waitForFunction(() => {
        const input = document.querySelector('.model-selector-dropdown input:not([type="radio"])');
        return input && document.activeElement === input;
      });
      assert.equal(await search.inputValue(), '', 'Opening resets the model search');
    }

    async function escapeFromSearch() {
      await search.focus();
      await search.press('Escape');
      await popup.waitFor({ state: 'hidden', timeout: 3000 });
      await page.waitForFunction(() =>
        document.activeElement === document.querySelector('.composer-model-trigger'));
      assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
    }

    await openPicker();
    await escapeFromSearch();
    checks.push('Escape in an empty focused search closes the popover and restores trigger focus');

    await openPicker();
    await search.fill('gpt');
    assert.equal(await models.count(), 1);
    assert.equal(await models.first().innerText(), 'gpt-5.2-codex');
    await escapeFromSearch();
    checks.push('Escape also dismisses a filtered search and restores trigger focus');

    await openPicker();
    await search.fill('no-matching-model');
    assert.equal(await models.count(), 0);
    await search.fill('gpt');
    await models.first().click();
    await popup.waitFor({ state: 'hidden' });
    assert.match(await trigger.innerText(), /gpt-5\.2-codex/);
    checks.push('Search filtering, empty results and model selection still work');

    await openPicker();
    assert.equal(await popup.getByRole('button', { name: 'gpt-5.2-codex', exact: true })
      .getAttribute('aria-pressed'), 'true');
    const chat = popup.getByRole('radio', { name: 'Chat', exact: true });
    const agent = popup.getByRole('radio', { name: 'Agent', exact: true });
    await chat.locator('..').click();
    assert(await chat.isChecked(), 'Chat mode can be selected');
    assert(await popup.isVisible(), 'Changing mode keeps the model menu open');
    await agent.locator('..').click();
    assert(await agent.isChecked(), 'Agent mode can be restored');
    const low = popup.locator('input[type="radio"][value="low"]');
    const xhigh = popup.locator('input[type="radio"][value="xhigh"]');
    await low.locator('..').click();
    assert(await low.isChecked(), 'Low reasoning can be selected');
    await xhigh.locator('..').click();
    assert(await xhigh.isChecked(), 'Extra-high reasoning can be selected');
    assert(await popup.isVisible(), 'Changing reasoning keeps the model menu open');
    await page.screenshot({ path: path.join(output, 'model-menu.png') });
    await escapeFromSearch();
    checks.push('Chat/Agent and reasoning controls remain interactive; Escape still restores focus');

    await openPicker();
    assert(await agent.isChecked(), 'Execution mode survives reopening');
    assert(await xhigh.isChecked(), 'Reasoning choice survives reopening');
    await search.fill('glm');
    await models.first().click();
    await popup.waitFor({ state: 'hidden' });
    assert.match(await trigger.innerText(), /glm-5\.2/);
    checks.push('Model can be changed again after mode and reasoning changes');
    assert.deepEqual(errors, [], 'The composer fixture has no uncaught browser errors');
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ checks, errors }, null, 2));
    console.log(`PASS: ${checks.length} composer menu browser checks`);
  } catch (error) {
    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    throw error;
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
