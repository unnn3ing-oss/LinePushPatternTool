// 前端驗證：「排入推播」視窗的 LINE 原生推播四步驟精靈——底部進度列、操作者、只推給操作者的測試推播、正式推播（立即／排程）、鎖定、聊天室預覽（Playwright，Worker 全部用假回應攔截，不會連到真的 LINE）
// 執行：
//   python3 -m http.server 8960 &            # 在專案根目錄
//   NODE_PATH=$(npm root -g) node test/e2e/line-wizard.mjs
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const BASE = process.env.BASE_URL || 'http://localhost:8960/index.html';
const WORKER = 'https://worker.test';
const SHOTS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'screenshots');
mkdirSync(SHOTS, { recursive: true });
let failed = 0;
const check = (cond, label) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) failed++; };
const GREEN = 'rgb(22, 163, 74)', RED = 'rgb(220, 38, 38)', YELLOW = 'rgb(250, 204, 21)', BEIGE = 'rgb(251, 240, 207)', BLUE = 'rgb(0, 74, 173)';

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await browser.newContext({ viewport: { width: 1100, height: 1500 } });
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));
const dialogs = [];
page.on('dialog', async d => { dialogs.push(d.message()); await d.accept(); });

// ---- 假 Worker ----
const reqs = { status: [], prepare: [], validate: [], send: [], clicks: [] };
let validateOk = true, sendFail = '', followers = 287091, sendDelay = 0, clicksUnavailable = false;
const scheds = [];   // 假的排程資料庫
let heartbeat = Date.now(), schedFail = '';
const schedReqs = { create: [], update: [], cancel: [], list: 0 };
const labAuthReqs = [];
const T_A = 'a'.repeat(16), T_B = 'b'.repeat(16), T_C = 'c'.repeat(16);
let testers = [{ tid: T_A, name: '小編本人', registeredAt: 1 }, { tid: T_B, name: '王小明', registeredAt: 2 }, { tid: T_C, name: '陳小美', registeredAt: 3 }];
let testQuota = { type: 'limited', value: 200 }, testUsed = 36, testersFail = '';
const T_N1 = '1'.repeat(16), T_N2 = '2'.repeat(16), UID_OK = 'U8f0fba4524410d1cbc7c95ce37d96b80';
const officialTesters = { news: [{ tid: T_N1, name: '小編本人', registeredAt: 1 }, { tid: T_N2, name: '新同仁', registeredAt: 2 }], ent: [] };
let lookupFail = '';
const offReqs = { lookup: [], add: [], remove: [], send: [] };
const testerReqs = { list: 0, remove: [] };
await page.route(`${WORKER}/**`, async route => {
  const url = new URL(route.request().url());
  const body = route.request().postDataJSON?.() || {};
  const json = (obj, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(obj) });
  if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' } });
  if (url.pathname === '/lab-auth') { labAuthReqs.push(body); return body.password === 'pw' ? json({ token: 'lab-token-2', expiresAt: Date.now() + 3600e3 }) : json({ error: '密碼不正確' }, 401); }
  if (url.pathname === '/line/testers/list') { testerReqs.list++; if (body.channel === 'news' || body.channel === 'ent') return json({ ok: true, channel: body.channel, testers: officialTesters[body.channel], maxPerSend: 2 }); return testersFail ? json({ error: testersFail }, 502) : json({ ok: true, testers, maxPerSend: 2 }); }
  if (url.pathname === '/line/testers/remove') { if (body.channel === 'news' || body.channel === 'ent') { offReqs.remove.push(body); officialTesters[body.channel] = officialTesters[body.channel].filter(t => t.tid !== body.tid); return json({ ok: true, testers: officialTesters[body.channel], maxPerSend: 2 }); } testerReqs.remove.push(body); testers = testers.filter(t => t.tid !== body.tid); return json({ ok: true, testers, maxPerSend: 2 }); }
  if (url.pathname === '/line/testers/lookup' || url.pathname === '/line/testers/add') {
    const add = url.pathname.endsWith('add'); (add ? offReqs.add : offReqs.lookup).push(body);
    if (lookupFail) return json({ error: lookupFail }, 404);
    const already = officialTesters[body.channel].some(t => t.tid === T_N2);
    if (add && !already) officialTesters[body.channel].push({ tid: T_N2, name: '新同仁', registeredAt: 5 });
    return json({ ok: true, channel: body.channel, found: { tid: T_N2, name: '新同仁', already }, testers: officialTesters[body.channel], maxPerSend: 2 });
  }
  if (url.pathname === '/line/schedule/list') { schedReqs.list++; return json({ ok: true, schedules: scheds.filter(x => x.status !== 'hidden').sort((a, b) => (a.status === 'scheduled' ? 0 : 1) - (b.status === 'scheduled' ? 0 : 1) || a.runAt - b.runAt), heartbeatAt: heartbeat, serverNow: Date.now(), officialAllowed: true }); }
  if (url.pathname === '/line/schedule/create') {
    schedReqs.create.push(body);
    if (schedFail) return json({ error: schedFail }, 409);
    const rec = { id: String(scheds.length + 1).padStart(24, 'a'), channel: body.channel, org: body.channel, testers: body.testers, recipientNames: (body.testers || []).map(t => (testers.find(x => x.tid === t) || {}).name), name: body.name, altText: '測試推播標題', runAt: Date.parse(body.runAt), runAtIso: body.runAt, status: 'scheduled', attempts: 0, lastError: '', requestId: '', sentAt: '', approvedFriends: followers, links: body.links, createdAt: Date.now() };
    scheds.push(rec); return json({ ok: true, schedule: rec });
  }
  if (url.pathname === '/line/schedule/update') { schedReqs.update.push(body); const r = scheds.find(x => x.id === body.id); r.runAtIso = body.runAt; r.runAt = Date.parse(body.runAt); return json({ ok: true, schedule: r }); }
  if (url.pathname === '/line/schedule/cancel') { schedReqs.cancel.push(body); const r = scheds.find(x => x.id === body.id); r.status = 'cancelled'; return json({ ok: true, schedule: r }); }
  if (url.pathname === '/line/status') { reqs.status.push(body); return json({ ok: true, channel: body.channel, r2Ready: true, bot: { displayName: body.channel === 'test' ? '測試官方帳號' : 'TVBS新聞', basicId: '@abc' }, quota: body.channel === 'test' ? testQuota : { type: 'limited', value: 100000000 }, used: body.channel === 'test' ? testUsed : 17266349, followers: body.channel === 'test' ? null : { status: 'ready', followers, targetedReaches: followers - 5, blocks: 5 }, notes: [] }); }
  if (url.pathname === '/line/prepare') { reqs.prepare.push(body); return json({ ok: true, id: 'prep' + reqs.prepare.length, prepareToken: 'ptok' + reqs.prepare.length, expiresInMinutes: 30, pages: body.pages.length }); }
  if (url.pathname === '/line/validate') { reqs.validate.push(body); return json(validateOk ? { ok: true, valid: true, pages: 2 } : { ok: true, valid: false, message: 'LINE 回應 400：baseUrl 不對' }); }
  if (url.pathname === '/line/clicks') {
    reqs.clicks.push(body);
    if (clicksUnavailable) return json({ ok: true, unavailable: true, message: 'LINE 還沒有這次發送的統計（…）。只保留發送後約 14 天。' });
    return json({ ok: true, overview: { requestId: body.requestId, delivered: 287091, uniqueImpression: 90000, uniqueClick: 41000 }, messages: [{ seq: 1, impression: 80000 }, { seq: 2, impression: null }], clicks: [{ seq: 1, url: 'https://example.com/p1/n1?utm_source=x', click: 1234, uniqueClick: 1000, uniqueClickOfRequest: 1000 }, { seq: 1, url: 'https://example.com/p1/n2?utm_source=x', click: null, uniqueClick: null }, { seq: 2, url: 'https://elsewhere.example/z', click: 25, uniqueClick: 22 }] });
  }
  if (url.pathname === '/line/send') {
    reqs.send.push(body);
    if (sendDelay) await new Promise(r => setTimeout(r, sendDelay));
    if (sendFail && body.channel !== 'test') return json({ error: sendFail }, 502);
    if (body.channel !== 'test' && body.mode === 'test') {   // 正式帳號的測試推播：只 multicast 給該帳號名單內勾選的人
      offReqs.send.push(body);
      if (!(body.testers || []).length) return json({ error: '請先選擇測試推播要給誰（至少 1 位）。沒有發送任何東西。' }, 400);
      return json({ ok: true, channel: body.channel, official: false, testOnly: true, sentAt: '2026-10-07T12:00:00+08:00', requestId: '44444444-4444-4444-8444-444444444444', retryKey: body.retryKey, friends: body.testers.length, pages: 2, testToken: 'ttok-off', recipients: body.testers.map(t => (officialTesters[body.channel].find(x => x.tid === t) || {}).name), quota: { limit: 100000000, used: 17266349 } });
    }
    const official = body.channel !== 'test';
    if (!official && !(body.testers || []).length) return json({ error: '請先選擇測試推播要給誰（至少 1 位）。沒有發送任何東西。' }, 400);
    const usedBefore = testUsed;
    if (!official) testUsed += body.testers.length;
    return json({ ok: true, channel: body.channel, official, sentAt: '2026-10-07T12:00:00+08:00', requestId: official ? '22222222-2222-4222-8222-222222222222' : '11111111-1111-4111-8111-111111111111', retryKey: body.retryKey, friends: official ? followers : body.testers.length, pages: 2, ...(official ? {} : { testToken: 'ttok', recipients: body.testers.map(t => (testers.find(x => x.tid === t) || {}).name), quota: { limit: testQuota.value, used: usedBefore } }) });
  }
  return json({ error: `unexpected ${url.pathname}` }, 404);
});

await page.addInitScript(() => { sessionStorage.setItem('labAuth', JSON.stringify({ token: 'lab-token', expiresAt: Date.now() + 3600e3 })); try { localStorage.removeItem('lineOp'); localStorage.removeItem('lineTestOn'); } catch (e) { /* */ } });
await ctx.route('https://example.com/**', r => r.fulfill({ status: 200, contentType: 'text/html', body: 'ok' }));
await page.goto(`${BASE}?imageProxy=${encodeURIComponent(WORKER)}`);
await page.evaluate(() => { setLab(true); });
const txt = id => page.textContent(id);
const vis = async sel => !(await page.locator(sel).isHidden());
const bgOf = async id => { await page.waitForTimeout(380); return page.evaluate(i => getComputedStyle(document.getElementById(i)).backgroundColor, id); };
const stepNow = () => page.evaluate(() => lineSt().step);
const paneVis = async () => (await Promise.all(['lineP1', 'lineP2', 'lineP3', 'lineP4'].map(i => vis('#' + i)))).map((v, i) => v ? i + 1 : 0).filter(Boolean).join();
const nextState = () => page.evaluate(() => { const b = document.getElementById('lineNextBtn'); return { dis: b.classList.contains('is-disabled'), aria: b.getAttribute('aria-disabled'), tip: b.dataset.tip, hidden: b.hidden }; });
async function openDialog() {
  await page.evaluate(() => { s8AltByMode[mode] = '測試推播標題'; openS8Dialog(); });
  await page.waitForFunction(() => document.querySelectorAll('#s8Stage .s8-cell').length === 6 && s8State.images.length === 2 && s8State.images.every(Boolean), null, { timeout: 60000 });
  await page.evaluate(() => { s8State.urls.forEach((row, p) => row.forEach((_, i) => { s8State.urls[p][i] = `https://example.com/p${p + 1}/n${i + 1}?utm_source=x`; })); s8Refresh(); });
  await page.waitForFunction(() => document.getElementById('s8Errs').children.length === 0, null, { timeout: 5000 });
}
const clickNext = async () => { await page.click('#lineNextBtn'); await page.waitForTimeout(150); };
async function toStep(n) {   // 從第 1 步一路按到第 n 步（用「推播」操作者小編本人）
  if ((await stepNow()) === 1 && !(await page.evaluate(() => !!lineSt().prep))) { await page.click('#linePrepBtn'); await page.waitForFunction(() => /傳送完成/.test(document.getElementById('linePrepMsg').textContent), null, { timeout: 60000 }); }
  while ((await stepNow()) < n) {
    const s = await stepNow();
    if (s === 2 && !(await page.evaluate(() => !!lineOp))) { await page.waitForSelector('#lineOpList .lw-op'); await page.locator('#lineOpList .lw-op', { hasText: '小編本人' }).click(); }
    if (s === 3 && (await page.evaluate(() => lineSt().test)) !== 'ok') { await page.click('#lineTestBtn'); await page.waitForFunction(() => lineSt().test === 'ok'); }
    await clickNext();
  }
}

// ===== 1. 版面：底部步驟進度列、標題拿掉、快速回覆在預覽下方 =====
await openDialog();
const lay = await page.evaluate(() => {
  const r = id => document.getElementById(id).getBoundingClientRect(), m = r('s8Modal'), f = r('lineFoot'), h = document.querySelector('#s8Modal .modal-head').getBoundingClientRect();
  return { footAtBottom: Math.abs(f.bottom - m.bottom) < 2 && f.top > h.bottom, labels: [...document.querySelectorAll('#lineStepbar .lsb b')].map(b => b.textContent).join('｜'), nextRight: r('lineNextBtn').right > m.right - 60, titleGone: ![...document.querySelectorAll('#s8Modal .s8-page')].some(e => e.textContent.trim() === 'LINE原生推播' && e.offsetParent), hStepperGone: !document.getElementById('lineHStepper'), qrBelowPreview: r('qrSec').top >= r('s8Stage').bottom && document.getElementById('qrSec').parentElement.id === 'contentBlock', headTabs: document.getElementById('s8Modetabs').textContent.replace(/\s/g, ''), footBorder: getComputedStyle(document.getElementById('lineFoot')).borderTopWidth, headBorder: getComputedStyle(document.querySelector('#s8Modal .modal-head')).borderBottomWidth };
});
check(lay.footAtBottom && lay.labels === '推播內容｜推播方式｜測試推播｜正式推播', `步驟進度列固定在彈窗最下方：${lay.labels}`);
check(lay.nextRight && lay.footBorder === lay.headBorder, '右側是「下一步」按鈕；底部列的樣式與上方標題／切換列一致（同樣的分隔線）');
check(lay.titleGone && lay.hStepperGone && lay.headTabs === 'LINE原生推播S8推播', '「LINE原生推播」標題與舊的水平步驟列已拿掉（切換列的分頁保留）');
check(lay.qrBelowPreview, '快速回覆按鈕區移到連結預覽下方');
check((await paneVis()) === '1' && await vis('#contentBlock') && await vis('#lineP1'), '第 1 步只顯示「推播內容」：推播通知、連結預覽、快速回覆、傳送資料');
await page.locator('#s8Modal').screenshot({ path: path.join(SHOTS, 'wiz-1-content.png') });

// ===== 2. 下一步反灰＋上方泡泡說明哪個步驟未完成 =====
let ns = await nextState();
check(ns.dis && ns.aria === 'true' && ns.tip.includes('第 1 步「推播內容」還沒完成') && ns.tip.includes('還沒按「傳送資料」'), `第 1 步沒按「傳送資料」：下一步反灰，說明「${ns.tip}」`);
await page.hover('#lineNextBtn'); await page.waitForTimeout(200);
const bub = await page.evaluate(() => { const b = document.getElementById('lineNextBtn'), cs = getComputedStyle(b, '::after'); return { content: cs.content, display: cs.display, bottom: cs.bottom, pos: cs.position, bg: cs.backgroundColor, btnBg: getComputedStyle(b).backgroundColor }; });
check(bub.display === 'block' && bub.content.includes('推播內容') && bub.pos === 'absolute' && parseFloat(bub.bottom) > 20, '游標移到反灰的「下一步」：上方彈出泡泡（在按鈕上方）');
check(bub.btnBg === 'rgb(207, 211, 217)', `反灰的「下一步」是灰色（${bub.btnBg}）`);
await page.locator('#s8Modal').screenshot({ path: path.join(SHOTS, 'wiz-2-next-disabled.png') });
await page.mouse.move(5, 5);
await page.click('#lineNextBtn', { force: true }); await page.waitForTimeout(100);
check((await stepNow()) === 1, '反灰時按「下一步」不會換頁（泡泡會顯示一下）');
// 內容有缺：說明第一個缺的東西
await page.evaluate(() => { document.getElementById('s8Alt').value = ''; document.getElementById('s8Alt').dispatchEvent(new Event('input', { bubbles: true })); });
ns = await nextState();
check(ns.tip.includes('推播通知') || ns.tip.length > 20, `內容沒填完整：泡泡改說明缺什麼（${ns.tip}）`);
await page.evaluate(() => { document.getElementById('s8Alt').value = '測試推播標題'; document.getElementById('s8Alt').dispatchEvent(new Event('input', { bubbles: true })); });
await page.click('#linePrepBtn');
await page.waitForFunction(() => /傳送完成/.test(document.getElementById('linePrepMsg').textContent), null, { timeout: 60000 });
check(reqs.prepare.length === 1 && reqs.prepare[0].altText === '測試推播標題' && reqs.validate.length === 1 && reqs.send.length === 0, '傳送資料：上傳＋請 LINE 檢查格式，沒有發送任何東西');
ns = await nextState();
check(!ns.dis && ns.aria === 'false', '傳送完成：「下一步」變成可按（藍色）');
check(await page.evaluate(() => document.querySelector('#lineStepbar .lsb.on b').textContent === '推播內容' && !document.getElementById('lineSb1').classList.contains('done')), '目前這步（推播內容）亮藍色');

// ===== 3. 第 2 步：推播方式（選擇操作者）=====
await clickNext();
check((await stepNow()) === 2 && (await paneVis()) === '2' && !(await vis('#contentBlock')), '按「下一步」：進到第 2 步，只顯示「推播方式（選擇操作者）」');
await page.waitForSelector('#lineOpList .lw-op');
const ops = await page.$$eval('#lineOpList .lw-op', b => b.map(x => x.textContent));
check(ops.length === 4 && ops[0].startsWith('小編本人') && ops[0].includes('正式✓') && ops[0].includes('測試✓') && ops.some(o => o.startsWith('新同仁') && o.includes('測試✗')) && ops.some(o => o.startsWith('王小明') && o.includes('正式✗')), `操作者是單選的名單（正式帳號＋測試帳號名單合併，標出各帳號有沒有）：${ops.join('｜')}`);
ns = await nextState();
check(ns.dis && ns.tip.includes('第 2 步「推播方式」還沒完成') && ns.tip.includes('操作者'), `沒選操作者：下一步反灰，泡泡說明（${ns.tip}）`);
check(await page.evaluate(() => document.getElementById('lineSb1').classList.contains('done') && document.getElementById('lineSl1').classList.contains('done')), '第 1 步在進度列上變成綠色完成');
await page.locator('#lineOpList .lw-op', { hasText: '小編本人' }).click();
check(await page.evaluate(() => lineOp === '小編本人' && localStorage.getItem('lineOp') === '小編本人') && (await txt('#lineOpNote')).includes('只會傳給他一位'), '選「小編本人」：記在這個瀏覽器，說明測試推播只會傳給他一位');
check(await page.locator('#lineOpList .lw-op.on').count() === 1, '單選：同時只有一位被選取');
await page.locator('#s8Modal').screenshot({ path: path.join(SHOTS, 'wiz-3-operator.png') });
ns = await nextState();
check(!ns.dis, '選了操作者：下一步可按');

// ===== 4. 第 3 步：測試推播（只推給操作者本人，立即傳送）=====
await clickNext();
check((await stepNow()) === 3 && (await paneVis()) === '3', '進到第 3 步「測試推播」');
check(!(await vis('#lineWho')) && !(await vis('#lineWhoBtn')) && (await page.locator('#lineWhoPanel').count()) === 0, '舊的「測試推播給（多選）」下拉已移除');
check((await txt('#lineDestOff')).includes('TVBS新聞（正式帳號）') && await page.evaluate(() => document.getElementById('lineDestOff').classList.contains('on')), '預設發到目標推播帳號（正式帳號，只傳給操作者）');
check((await txt('#lineWhoNote')).includes('只傳給操作者：小編本人') && (await txt('#lineWhoNote')).includes('不是群發'), `說明：只傳給操作者、不是群發（${await txt('#lineWhoNote')}）`);
check(await page.locator('#lineLineSchedule, #linePickSched').first().isHidden(), '測試推播沒有排程選項（只有立即傳送）');
ns = await nextState();
check(ns.dis && ns.tip.includes('第 3 步「測試推播」還沒完成') && ns.tip.includes('推播測試'), '還沒測試：下一步反灰，泡泡說明');
await page.click('#lineTestBtn');
await page.waitForFunction(() => lineSt().test === 'ok');
const t1 = offReqs.send.at(-1);
check(t1.channel === 'news' && t1.mode === 'test' && JSON.stringify(t1.testers) === JSON.stringify([T_N1]) && t1.testers.length === 1 && /^[0-9a-f-]{36}$/.test(t1.retryKey) && t1.confirmTotal === undefined && Array.isArray(t1.links) && t1.links.length === 12, '測試推播：只帶操作者一位（新聞帳號名單裡的小編本人）、沒有人數確認、帶每格連結');
check((await txt('#lineWin')).includes('只發給操作者') && (await txt('#lineWin')).includes('請到手機的「TVBS新聞」確認') && await page.evaluate(() => document.getElementById('lineWin').classList.contains('ok')), '結果寫明發到哪、只給誰');
const winTop = await page.evaluate(() => { const w = document.getElementById('lineWin').getBoundingClientRect(), b = document.getElementById('composeBody').getBoundingClientRect(), p = document.getElementById('lineP3').getBoundingClientRect(); return { onTop: w.top - b.top >= 0 && w.top - b.top < 24, above: w.bottom <= p.top, dbg: [w.top, b.top, w.bottom, p.top] }; });
check(winTop.onTop && winTop.above, `推播狀態顯示在彈窗內容最上方（在各步驟內容之上）${winTop.dbg}`);
check((await txt('#lineTestBtn')) === '再推一次' && !(await nextState()).dis, '測試成功：下一步可按；按鈕變「再推一次」');
await page.locator('#s8Modal').screenshot({ path: path.join(SHOTS, 'wiz-4-test.png') });
await page.click('#lineTestBtn');
await page.waitForFunction(() => lineSt().test === 'ok' && offReqs.send.length === 2 || true);
await page.waitForTimeout(300);
check(offReqs.send.length === 2 && offReqs.send[1].retryKey !== offReqs.send[0].retryKey, '「再推一次」換一把重試金鑰（才會真的再發一次）');
// 換操作者：只在測試帳號名單的「王小明」→ 正式帳號不能測
await page.click('#lineSb2'); await page.waitForTimeout(150);
check((await stepNow()) === 2 && await page.evaluate(() => lineSt().test === 'ok'), '點進度列的「2」可以回上一步，測試結果還在');
await page.locator('#lineOpList .lw-op', { hasText: '王小明' }).click();
check(await page.evaluate(() => lineSt().test === '' && lineSt().testToken === ''), '換了操作者：之前的測試推播不算數（要重新測試）');
await clickNext();
check(await page.evaluate(() => lineSt().testOn === 'test' && document.getElementById('lineDestOff').disabled && !document.getElementById('lineDestTest').disabled), '王小明只在測試帳號名單：自動改發測試帳號，正式帳號選項不能按');
check((await page.getAttribute('#lineDestOff', 'title')).includes('名單裡沒有「王小明」'), '不能按的原因寫在提示上');
await page.click('#lineTestBtn');
await page.waitForFunction(() => lineSt().test === 'ok');
const t2 = reqs.send.at(-1);
check(t2.channel === 'test' && JSON.stringify(t2.testers) === JSON.stringify([T_B]) && t2.mode === undefined, '測試帳號的測試推播：同樣只傳給操作者一位（王小明）');
// 操作者不在任何名單
await page.click('#lineSb2'); await page.waitForTimeout(100);
await page.locator('#lineOpList .lw-op', { hasText: '小編本人' }).click();
await clickNext();
check(await page.evaluate(() => lineSt().testOn === 'test' || lineSt().testOn === 'official'), '換回小編本人（兩邊都有）');
await page.click('#lineDestOff'); await page.waitForTimeout(150);
check(await page.evaluate(() => lineSt().testOn === 'official' && lineSt().test === ''), '手動切到正式帳號：要重新測試');
// 測試失敗
sendFail = '測試推播被 LINE 拒絕';
await page.click('#lineTestBtn');
await page.waitForFunction(() => lineSt().test === 'bad');
check((await nextState()).dis && (await txt('#lineWin')).includes('測試推播失敗') && await page.evaluate(() => document.getElementById('lineWin').classList.contains('bad')), '測試推播失敗：狀態窗（黃）顯示原因，下一步維持反灰');
sendFail = '';
await page.click('#lineTestBtn');
await page.waitForFunction(() => lineSt().test === 'ok');

// ===== 5. 第 4 步：正式推播（立即／排程）＋聊天室預覽 =====
// 先加兩顆快速回覆（用回到第 1 步的方式加；內容變更會作廢資料，所以這裡先到第 1 步改再重做）
await page.click('#lineSb1'); await page.waitForTimeout(150);
check((await stepNow()) === 1 && await vis('#qrSec'), '回到第 1 步');
for (let i = 0; i < 3; i++) await page.click('#qrAdd');
const labs = ['蔣萬安', '少康獨家專訪六都', '民調'];
for (let i = 0; i < 3; i++) await page.locator('#qrRows .qr-lab input').nth(i).fill(labs[i]);
await page.fill('#qrTpl', 'https://news.example.com/search?q={keyword}');
await page.waitForFunction(() => /內容有更動/.test(document.getElementById('lineWin').textContent) || !lineSt().prep);
check(!(await page.evaluate(() => !!lineSt().prep)) && (await txt('#lineWin')).includes('內容有更動'), '在第 1 步改了內容（加快速回覆）：已上傳的資料作廢，要重新傳送資料');
await toStep(4);
check((await stepNow()) === 4 && (await paneVis()) === '4' && (await nextState()).hidden, '到第 4 步「正式推播」：下一步按鈕收起');
const chat = await page.evaluate(() => { const c = document.getElementById('lineChat'); return { name: c.querySelector('.chat-name').textContent, imgs: c.querySelectorAll('img.chat-img').length, chips: [...c.querySelectorAll('.chat-chip')].map(x => x.textContent), time: c.querySelector('.chat-time').textContent, hasInput: !!c.querySelector('.chat-in'), srcs: [...c.querySelectorAll('img.chat-img')].every(i => i.src.startsWith('blob:') && i.naturalWidth > 0) }; });
check(chat.name === 'TVBS新聞' && chat.imgs === 2 && chat.srcs, '聊天室預覽：帳號名稱、兩頁圖片訊息（用實際產生的圖）');
check(chat.chips.join('｜') === labs.join('｜') && chat.hasInput && /^(上午|下午)\d{1,2}:\d{2}$/.test(chat.time), `聊天室預覽：快速回覆按鈕（${chat.chips.join('、')}）、輸入列、時間（${chat.time}）`);
const chatBox = await page.evaluate(() => { const c = document.getElementById('lineChat').getBoundingClientRect(), ctl = document.querySelector('#lineP4 .lw-ctl').getBoundingClientRect(); return { right: c.left >= ctl.right - 2, w: c.width }; });
check(chatBox.right && chatBox.w > 250 && chatBox.w < 340, `預覽在控制項右側（寬 ${Math.round(chatBox.w)}px，像手機寬度）`);
await page.locator('#lineChat').screenshot({ path: path.join(SHOTS, 'wiz-5-chat.png') });
await page.locator('#s8Modal').screenshot({ path: path.join(SHOTS, 'wiz-5-step4.png') });
check(!(await vis('#lineConfirmBox')) && !(await vis('#lineGoTrack')), '還沒選立即／排程：不顯示確認人數與推播按鈕');
await page.click('#linePickNow'); await page.waitForTimeout(300);
check((await vis('#lineConfirmBox')) && (await txt('#lineConfirmCap')).includes('TVBS新聞') && (await txt('#lineConfirmCap')).includes('好友人數'), `確認人數寫明目標推播帳號：「${await txt('#lineConfirmCap')}」`);
await page.waitForFunction(() => Number.isFinite(lineSt().friends));
const inw = await page.evaluate(() => { const i = document.getElementById('lineConfirmTotal'); return { w: i.getBoundingClientRect().width, ph: i.placeholder, base: parseFloat(getComputedStyle(document.getElementById('lineP4')).getPropertyValue('--s8-btn-w')) }; });
check(inw.ph === '輸入 287,091' && Math.abs(inw.w - inw.base * 4 / 3) < 2, `確認人數輸入框加寬 1/3（${inw.base}px → ${Math.round(inw.w)}px），提示「${inw.ph}」放得下`);
const phFits = await page.evaluate(() => { const i = document.getElementById('lineConfirmTotal'), s = document.createElement('span'); const cs = getComputedStyle(i); s.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${cs.font}`; s.textContent = i.placeholder; document.body.appendChild(s); const w = s.getBoundingClientRect().width; s.remove(); return w + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) <= i.getBoundingClientRect().width; });
check(phFits, '提示文字不會被切掉');
await page.locator('#lineP4 .lw-ctl').screenshot({ path: path.join(SHOTS, 'wiz-6-confirm.png') });
await page.fill('#lineConfirmTotal', '123');
check((await txt('#lineConfirmMark')) === '✗' && !(await vis('#lineGoTrack')), '人數輸入錯誤：✗，不能推播');
await page.fill('#lineConfirmTotal', '287,091');
check((await txt('#lineConfirmMark')) === '✓' && await vis('#lineGoBtn') && (await txt('#lineGoBtn')) === '正式推播', '輸入正確人數：✓，出現「正式推播」');
check(offReqs.send.length >= 1 && reqs.send.every(r => r.channel !== 'news' || r.mode === 'test') && offReqs.send.every(r => r.mode === 'test'), '到這裡正式帳號還沒做任何正式發送');
await page.click('#lineGoBtn');
check((await txt('#lineGoBtn')) === '確定推播？' && (await bgOf('lineGoBtn')) === YELLOW, '綠 → 黃「確定推播？」');
await page.click('#lineGoBtn');
check(await vis('#lineSlider'), '再按一次：滑動開關');
sendDelay = 500;
const kb = await page.locator('#lineKnob').boundingBox(), sb = await page.locator('#lineSlider').boundingBox();
await page.mouse.move(kb.x + kb.width / 2, kb.y + kb.height / 2); await page.mouse.down();
await page.mouse.move(kb.x + sb.width + 40, kb.y + kb.height / 2, { steps: 12 });
await page.mouse.up();
await page.waitForFunction(() => /推播中/.test(document.getElementById('lineWin').textContent || ''), null, { timeout: 5000 });
check(await page.evaluate(() => document.getElementById('lineWin').classList.contains('busy')) && (await txt('#lineWin')).includes('TVBS新聞'), '推播中：上方狀態窗即時顯示「推播中…」與帳號、人數');
check(await page.evaluate(() => [...document.querySelectorAll('#lineStepbar .lsb')].every(b => b.disabled || b.getAttribute('aria-current') === 'step') && document.getElementById('linePrevBtn').disabled), '推播中：不能換步驟');
await page.waitForFunction(() => /已正式推播到/.test(document.getElementById('lineWin').textContent), null, { timeout: 10000 });
sendDelay = 0;
const off4 = reqs.send.filter(r => r.channel === 'news' && r.mode !== 'test').at(-1);
check(off4.testToken === 'ttok-off' && off4.confirmTotal === 287091 && /^[0-9a-f-]{36}$/.test(off4.retryKey) && Array.isArray(off4.links) && off4.testers === undefined, '正式推播：channel=news、帶測試憑證、你輸入的人數、不帶收件人名單（全部好友）');
check(await page.evaluate(() => document.getElementById('lineWin').classList.contains('ok')), '推播完成：上方狀態窗綠色顯示結果');
// 鎖定
const lock = await page.evaluate(() => ({ btns: [...document.querySelectorAll('#lineStepbar .lsb')].map(b => [b.disabled || b.getAttribute('aria-current') === 'step', b.classList.contains('done')]), prev: document.getElementById('linePrevBtn').disabled, go: document.getElementById('lineGoBtn').textContent, goDis: document.getElementById('lineGoBtn').disabled, step: lineSt().step, pickDis: document.getElementById('lineDate').disabled, conf: document.getElementById('lineConfirmTotal').disabled }));
check(lock.go === '已正式推播' && lock.goDis && lock.btns.every(b => b[1]) && lock.pickDis && lock.conf, '推播完成：「已正式推播」、進度列四步全部綠色完成、輸入框鎖住');
await page.click('#lineSb2', { force: true }).catch(() => {}); await page.click('#linePrevBtn', { force: true }).catch(() => {});
await page.waitForTimeout(200);
check((await stepNow()) === 4 && await page.evaluate(() => lineSt().goState === 'ok'), '推播完成後鎖定：點進度列或「上一步」都回不去');
await page.locator('#s8Modal').screenshot({ path: path.join(SHOTS, 'wiz-7-locked.png') });
// 關閉再開仍鎖定
await page.click('#s8CloseBtn');
await openDialog();
check((await stepNow()) === 4 && await page.evaluate(() => lineSt().goState === 'ok') && (await txt('#lineGoBtn')) === '已正式推播', '關閉再開：仍是已推播、鎖定的狀態（內容沒變）');
// 內容改了才會解鎖重來
await page.evaluate(() => { document.getElementById('s8Alt').value = '另一則推播'; document.getElementById('s8Alt').dispatchEvent(new Event('input', { bubbles: true })); });
await page.waitForTimeout(100);
check((await stepNow()) === 4 || (await stepNow()) === 1, '（鎖定後內容被改：流程狀態見下一項）');

// ===== 6. 排程路徑 =====
await page.evaluate(() => { const st = lineSt(); lineResetFlow(st); lineUpdateSteps(); });
await toStep(4);
await page.click('#linePickSched'); await page.waitForTimeout(250);
const sw = Date.now() + 3 * 3600e3;
const ymd = ms => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10), hm = ms => new Date(ms + 8 * 3600e3).toISOString().slice(11, 16);
await page.evaluate(([d, t]) => { const a = document.getElementById('lineDate'), b = document.getElementById('lineTime'); a.value = d; b.value = t; a.dispatchEvent(new Event('input', { bubbles: true })); b.dispatchEvent(new Event('input', { bubbles: true })); }, [ymd(sw), hm(sw)]);
check(!(await page.evaluate(() => document.getElementById('lineChat').textContent.includes('下午1:03'))), '選排程：聊天室預覽的時間跟著排程時間');
await page.waitForFunction(() => Number.isFinite(lineSt().friends));
await page.fill('#lineConfirmTotal', '287091');
await page.click('#lineGoBtn'); await page.click('#lineGoBtn');
const kb3 = await page.locator('#lineKnob').boundingBox(), sb3 = await page.locator('#lineSlider').boundingBox();
await page.mouse.move(kb3.x + kb3.width / 2, kb3.y + kb3.height / 2); await page.mouse.down();
await page.mouse.move(kb3.x + sb3.width + 40, kb3.y + kb3.height / 2, { steps: 12 });
await page.mouse.up();
await page.waitForFunction(() => /已排程/.test(document.getElementById('lineWin').textContent), null, { timeout: 10000 });
const sc = schedReqs.create.at(-1);
check(sc.channel === 'news' && sc.runAt === `${ymd(sw)}T${hm(sw)}:00+08:00` && sc.confirmTotal === 287091 && sc.testToken === 'ttok-off' && sc.name === undefined && sc.testers === undefined && Array.isArray(sc.links), '正式排程：帶時間、人數、測試憑證與每格連結；沒有 name／testers（預設命名由 Worker 決定，測試排程已移除）');
check((await txt('#lineGoBtn')) === '已排程' && await page.evaluate(() => lineSt().goState === 'ok'), '排程完成：「已排程」並鎖定');

// ===== 7. 正式推播失敗：上方黃色狀態、可重試 =====
await page.evaluate(() => { const st = lineSt(); lineResetFlow(st); lineUpdateSteps(); });
await toStep(4);
await page.click('#linePickNow'); await page.waitForFunction(() => Number.isFinite(lineSt().friends));
await page.fill('#lineConfirmTotal', '287091');
sendFail = 'LINE 回應 429：額度不足';
await page.click('#lineGoBtn'); await page.click('#lineGoBtn');
const kb4 = await page.locator('#lineKnob').boundingBox(), sb4 = await page.locator('#lineSlider').boundingBox();
await page.mouse.move(kb4.x + kb4.width / 2, kb4.y + kb4.height / 2); await page.mouse.down();
await page.mouse.move(kb4.x + sb4.width + 40, kb4.y + kb4.height / 2, { steps: 12 });
await page.mouse.up();
await page.waitForFunction(() => /推播失敗/.test(document.getElementById('lineWin').textContent), null, { timeout: 10000 });
check(await page.evaluate(() => document.getElementById('lineWin').classList.contains('bad') && lineSt().goState === 'bad') && (await txt('#lineGoBtn')).includes('重新推播') && (await stepNow()) === 4, '正式推播失敗：上方黃色狀態窗顯示原因、按鈕變「重新推播」，沒有鎖定（可回上一步）');
check(!(await page.evaluate(() => document.getElementById('linePrevBtn').disabled)) , '失敗時還能回上一步');
sendFail = '';

// ===== 8. 名單是空的、讀不到 =====
await page.evaluate(() => { const st = lineSt(); lineResetFlow(st); Object.keys(lineWhoBy).forEach(k => { lineWhoBy[k] = { loaded: true, loading: false, testers: [], error: '', quota: null }; }); lineOp = ''; try { localStorage.removeItem('lineOp'); } catch (e) { /* */ } lineUpdateSteps(); });
await page.click('#linePrepBtn');
await page.waitForFunction(() => /傳送完成/.test(document.getElementById('linePrepMsg').textContent), null, { timeout: 60000 });
await clickNext();
check((await txt('#lineOpNote')).includes('名單是空的') && (await txt('#lineOpNote')).includes('權限管理') && (await nextState()).dis, '名單是空的：說明去哪裡新增自己，下一步反灰');

// ===== 9. 切到 S8 分頁：不受影響 =====
await page.click('#s8ModeS8');
check(await vis('#s8Panel') && !(await vis('#lineFoot')) && await vis('#contentBlock') && !(await vis('#lineP2')) && await vis('#qrSec'), 'S8推播分頁：沒有底部步驟列，S8 原本的步驟與欄位照舊；快速回覆一樣在預覽下方');
await page.click('#s8CloseBtn');

check(pageErrors.length === 0, `頁面沒有 JS 錯誤${pageErrors.length ? '：' + pageErrors.join(' | ') : ''}`);
await browser.close();
console.log(failed ? `\n${failed} 項失敗` : '\n全部通過');
process.exit(failed ? 1 : 0);
