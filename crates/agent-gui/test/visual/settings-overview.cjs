const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const out = '.tmp/settings-design-qa';
fs.mkdirSync(out, { recursive: true });
const url = process.env.SETTINGS_PREVIEW_URL || 'http://127.0.0.1:1420/test/visual/settings-preview.html';
(async () => {
 const browser = await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE_PATH,headless:true});
 const page = await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:1});
 const errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 page.on('console',m=>{if(m.type()==='error') errors.push(m.text())});
 const checks=[];
 async function home(state='ready') {
  await page.goto(`${url}?state=${state}`);
  await page.locator('.settings-directory-item').first().waitFor();
  if(state!=='loading') await page.waitForFunction(()=>document.querySelector('[aria-busy]')?.getAttribute('aria-busy')==='false');
  await page.evaluate(()=>document.fonts.ready); await page.waitForTimeout(200);
 }
 for(const [width,height] of [[1440,900],[1920,1080],[1658,949],[1024,768],[800,700],[640,760],[480,720]]) {
  await page.setViewportSize({width,height}); await home();
  const measurements=await page.evaluate(()=>{
   const sel=s=>document.querySelector(s).getBoundingClientRect().toJSON();
   return {overflow:document.documentElement.scrollWidth>innerWidth,scrollOverflow:document.querySelector('.settings-scroll').scrollWidth>document.querySelector('.settings-scroll').clientWidth,columns:getComputedStyle(document.querySelector('.settings-directory-grid')).gridTemplateColumns,footer:sel('.settings-footer'),runtime:sel('.settings-runtime'),outside:[...document.querySelectorAll('.settings-capability,.settings-mode-option,.settings-directory-main,.settings-search')].filter(e=>e.getBoundingClientRect().right>innerWidth||e.getBoundingClientRect().left<0).map(e=>e.textContent)};
  });
  assert(!measurements.overflow && !measurements.scrollOverflow && !measurements.outside.length,JSON.stringify({width,measurements}));
  assert(measurements.footer.bottom<=height);
  await page.screenshot({path:`${out}/${width}x${height}.png`});
  checks.push({viewport:`${width}x${height}`,...measurements});
 }
 await page.setViewportSize({width:1440,height:900}); await home();
 assert.equal(await page.locator('.settings-directory-item').count(),6);
 assert.match(await page.locator('.settings-directory-meta').nth(1).innerText(),/2 Providers · 6 Models/);
 await page.getByRole('button',{name:'Chat',exact:true}).click();
 assert.equal(await page.evaluate(()=>window.__settingsQA.settings.system.executionMode),'text');
 assert.match(await page.locator('.settings-capability').first().innerText(),/Agent/);
 assert.match(await page.locator('.settings-capability').nth(2).innerText(),/Enabled/);
 assert.equal(await page.locator('.settings-directory-meta').nth(2).innerText(),'Memory On');
 await page.getByRole('button',{name:'Agent',exact:true}).click();
 assert.equal(await page.evaluate(()=>window.__settingsQA.settings.system.executionMode),'tools');
 assert.match(await page.locator('.settings-capability').nth(2).innerText(),/Enabled/);
 await page.keyboard.press('Control+k');
 const search=page.getByRole('combobox',{name:'搜索设置、能力或连接'}); assert(await search.evaluate(e=>e===document.activeElement));
 await search.fill('字体');
 await page.locator('[role=option]').first().waitFor();
 await page.screenshot({path:`${out}/search-focus.png`});
 await page.keyboard.press('Enter');
 await page.locator('[data-setting-anchor=font]').waitFor();
 assert.equal(await page.evaluate(()=>document.activeElement.dataset.settingAnchor),'font');
 await page.screenshot({path:`${out}/font-detail.png`});
 await page.keyboard.press('Control+k'); await page.getByRole('combobox',{name:'搜索设置、能力或连接'}).fill('字体'); await page.keyboard.press('Enter');
 assert.equal(await page.evaluate(()=>document.activeElement.dataset.settingAnchor),'font');
 await page.getByRole('navigation',{name:'设置',exact:true}).getByRole('button',{name:'设置',exact:true}).click();
 await page.keyboard.press('Control+k'); await page.getByRole('combobox',{name:'搜索设置、能力或连接'}).fill('xxxx-no-result');
 assert.equal(await page.getByRole('option').count(),0); assert.equal(await page.getByRole('combobox',{name:'搜索设置、能力或连接'}).getAttribute('aria-expanded'),'true');
 await page.keyboard.press('Escape'); assert.equal(await page.getByRole('combobox',{name:'搜索设置、能力或连接'}).inputValue(),'');
 await page.getByRole('combobox',{name:'搜索设置、能力或连接'}).fill('mcp'); await page.keyboard.press('Shift+Tab');
 assert.equal(await page.getByRole('combobox',{name:'搜索设置、能力或连接'}).getAttribute('aria-expanded'),'false');
 await page.getByRole('combobox',{name:'搜索设置、能力或连接'}).fill('mcp'); await page.getByRole('option').click();
 assert.equal(await page.locator('h1').innerText(),'MCP');
 await home();
 await page.locator('.settings-directory-item').nth(3).hover();
 await page.waitForTimeout(200);
 const hover=await page.locator('.settings-directory-item').nth(3).evaluate(e=>({background:getComputedStyle(e).backgroundColor,arrow:getComputedStyle(e.querySelector('.settings-directory-arrow')).transform}));
 assert.match(hover.background,/rgba\(15, 23, 42, 0\.02[45]\)/); assert.match(hover.arrow,/, 2, 0\)/);
 await page.screenshot({path:`${out}/row-hover.png`});
 checks.push({interactions:'mode, search shortcut/keyboard/pointer/escape/blur/repeated navigation, anchors, MCP route, row hover',hover});
 for(const state of ['ready','remote-unavailable','remote-error']) {
  await home(state);
  await page.getByRole('button',{name:'远程访问',exact:true}).click();
  await page.waitForTimeout(200);
  assert.equal(await page.locator('h1').innerText(),'远程访问');
  const gatewayUrl=page.getByPlaceholder('https://gateway.example.com');
  assert(await gatewayUrl.isVisible());
  await gatewayUrl.fill('https://preview.example.com');
  await page.waitForFunction(()=>window.__settingsQA.settings.remote.gatewayUrl==='https://preview.example.com');
  assert(await page.getByText('未连接',{exact:true}).isVisible());
  if(state==='ready') await page.screenshot({path:`${out}/remote-access.png`});
  await page.getByRole('navigation',{name:'设置',exact:true}).getByRole('button',{name:'设置',exact:true}).click();
  assert.equal(await page.locator('.settings-directory-item').count(),6);
 }
 checks.push({remoteAccess:'directory navigation, URL editing and return; offline/null/rejected runtime status'});
 for(const state of ['loading','error','running','empty','english','dark','debug','save-error']) {
  await home(state);
  const runtime=await page.locator('.settings-runtime').innerText();
  if(state==='loading') assert.equal(await page.locator('[aria-busy]').getAttribute('aria-busy'),'true');
  if(state==='error') assert(!runtime.includes('2 connected'));
  if(state==='running') { assert.match(runtime,/Running/); assert.equal(await page.locator('.settings-capability[data-state=running]').count(),1); }
  if(state==='empty') assert.match(await page.locator('.settings-directory-meta').nth(1).innerText(),/0 Providers · 0 Models/);
  if(state==='debug') {
   await page.getByRole('button',{name:'Agent DEV',exact:true}).click();
   assert.equal(await page.evaluate(()=>window.__settingsQA.settings.system.executionMode),'agent-dev');
  }
  await page.screenshot({path:`${out}/${state}.png`});
  checks.push({state,runtime});
 }
 await home('running');
 await page.evaluate(()=>{window.__settingsQA.transcript.settle();window.__settingsQA.sidebar.applyRunningPatch({conversationId:'demo',running:false});});
 await page.waitForFunction(()=>document.querySelector('.settings-runtime-status').textContent==='Ready');
 await page.evaluate(()=>window.__settingsQA.setSaveState({status:'saving'}));
 await page.locator('.settings-save-status[data-state=saving]').waitFor();
 await page.screenshot({path:`${out}/saving.png`});
 await page.emulateMedia({reducedMotion:'reduce'}); await home('running');
 assert.equal(await page.locator('.settings-spinner').first().evaluate(e=>getComputedStyle(e).animationName),'none');
 await page.getByRole('button',{name:'返回对话',exact:true}).click(); assert(await page.evaluate(()=>window.__wentBack));
 assert(await page.getByTestId('chat-background').evaluate(e=>e===document.activeElement && !e.inert));
 checks.push({liveUpdates:'running to ready; saving; reduced-motion spinner; back action'});
 // Exercise the production focus hook with a mounted, focusable chat underneath.
 for(const reducedMotion of ['no-preference','reduce']) {
  await page.emulateMedia({reducedMotion});
  await page.goto(`${url}?state=focus`);
  const opener=page.getByRole('button',{name:'打开设置',exact:true});
  await opener.focus(); await page.keyboard.press('Enter');
  await page.locator('.settings-page-title').waitFor();
  assert(await page.locator('.settings-page-title').evaluate(e=>e===document.activeElement));
  assert(await page.getByTestId('chat-background').evaluate(e=>e.inert));
  await page.locator('[aria-label="聊天输入"]').evaluate(e=>e.focus());
  assert(await page.locator('.settings-page-title').evaluate(e=>e===document.activeElement));
  for(const key of ['Tab','Shift+Tab']) {
   for(let i=0;i<45;i++) {
    await page.keyboard.press(key);
    assert(await page.getByTestId('chat-background').evaluate(e=>!e.contains(document.activeElement)));
   }
  }
  await page.getByRole('button',{name:'服务商与模型',exact:true}).click();
  await page.getByRole('button',{name:'打开自定义设置',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'自定义设置',exact:true});
  const titleModel=dialog.getByRole('button',{name:'标题生成模型',exact:true});
  await titleModel.focus();
  assert(await titleModel.evaluate(e=>e===document.activeElement && !document.querySelector('.arc-settings').contains(e)));
  await titleModel.click();
  const modelSearch=page.getByRole('menu').locator('input');
  await modelSearch.fill('demo-fast');
  assert(await modelSearch.evaluate(e=>e===document.activeElement));
  await page.getByRole('menuitem',{name:'demo-fast',exact:true}).first().click();
  assert.match(await titleModel.innerText(),/demo-fast/);
  await dialog.getByRole('button',{name:'关闭自定义设置',exact:true}).click();
  await dialog.waitFor({state:'hidden'});
  await page.getByRole('button',{name:'返回对话',exact:true}).click();
  assert(await opener.evaluate(e=>e===document.activeElement));
  assert.equal(await page.getByTestId('chat-background').evaluate(e=>e.inert),false);
  await page.keyboard.press('Tab');
  assert(await page.getByRole('textbox',{name:'聊天输入'}).evaluate(e=>e===document.activeElement));
  await opener.click();
  await page.evaluate(()=>window.__settingsQA.removeOpener());
  await page.getByRole('button',{name:'返回对话',exact:true}).click();
  assert(await page.getByTestId('chat-background').evaluate(e=>e===document.activeElement && !e.inert));
 }
 checks.push({focus:'keyboard open focuses heading; Tab and programmatic focus skip covered chat; portaled dialog and nested model menu remain interactive; close restores trigger; removed trigger falls back to chat; reduced motion'});
 fs.writeFileSync(`${out}/results.json`,JSON.stringify({checks,errors},null,2));
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,checks:checks.length,errors}));
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
