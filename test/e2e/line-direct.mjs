// 前端驗證：「排入推播」視窗的 LINE 原生推播（Playwright，Worker 全部用假回應攔截，不會連到真的 LINE）
// 執行：
//   python3 -m http.server 8960 &            # 在專案根目錄
//   NODE_PATH=$(npm root -g) node test/e2e/line-direct.mjs
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
await ctx.route('https://example.com/**', r => r.fulfill({ status: 200, contentType: 'text/html', body: 'ok' }));   // 新分頁打開的連結不要真的上網（沙盒沒網路會變成錯誤頁）
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
let testers = [{ tid: T_A, name: '王小明', registeredAt: 1 }, { tid: T_B, name: '李小華', registeredAt: 2 }, { tid: T_C, name: '陳小美', registeredAt: 3 }];
let testQuota = { type: 'limited', value: 200 }, testUsed = 36, testersFail = '';
const T_N1 = '1'.repeat(16), T_N2 = '2'.repeat(16), UID_OK = 'U0123456789abcdef0123456789abcdef';
const officialTesters = { news: [{ tid: T_N1, name: '小編本人', registeredAt: 1 }], ent: [] };
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

await page.addInitScript(() => { sessionStorage.setItem('labAuth', JSON.stringify({ token: 'lab-token', expiresAt: Date.now() + 3600e3 })); try { if (!sessionStorage.getItem('__noMe')) localStorage.setItem('lineMe', 'a'.repeat(16)); } catch (e) { /* */ } });
await page.goto(`${BASE}?imageProxy=${encodeURIComponent(WORKER)}`);
await page.evaluate(() => { setLab(true); });
const txt = id => page.textContent(id);
const bgOf = async id => { await page.waitForTimeout(380); return page.evaluate(i => getComputedStyle(document.getElementById(i)).backgroundColor, id); };
const vis = async id => !(await page.locator(id).isHidden());

// ===== 1. 第二步驟底部按鈕：下載本頁｜全部下載｜排入LINE推播（間隔一致）=====
await page.evaluate(() => { goStep(2); });
const bar = await page.evaluate(() => {
  const ids = ['downloadJpgBtn', 'downloadAllBtn', 'labPushBtn'], r = ids.map(i => document.getElementById(i).getBoundingClientRect());
  return { text: ids.map(i => document.getElementById(i).textContent), hidden: ids.map(i => document.getElementById(i).hidden), gap1: r[1].left - r[0].right, gap2: r[2].left - r[1].right, sameTop: r.every(x => Math.abs(x.top - r[0].top) < 1) };
});
check(bar.text.join('｜') === '下載本頁｜全部下載｜排入LINE推播' && bar.hidden.every(h => !h), `第二步驟底部三顆按鈕：${bar.text.join('｜')}`);
check(Math.abs(bar.gap1 - 10) < 0.6 && Math.abs(bar.gap2 - 10) < 0.6 && bar.sameTop, `三顆按鈕間隔一致（${bar.gap1.toFixed(1)}px／${bar.gap2.toFixed(1)}px）且同一排`);
await page.evaluate(() => { setLab(false); });
check(await page.evaluate(() => document.getElementById('labPushBtn').hidden && !document.getElementById('downloadAllBtn').hidden), '關掉試驗功能：只剩「下載本頁」「全部下載」，「排入LINE推播」消失');
await page.evaluate(() => { setLab(true); });
await page.evaluate(() => { ['downloadAllBtn', 'labPushBtn'].forEach(i => document.getElementById(i).classList.remove('is-disabled')); });   // 只為截圖：拿掉「圖片未完成」的灰色鎖定樣式
await page.locator('#dock').screenshot({ path: path.join(SHOTS, 'line-ui-1-bottom-bar.png') });

// ===== 2. 視窗：左上切換、標題 =====
async function openDialog() {
  await page.evaluate(() => { s8AltByMode[mode] = '測試推播標題'; openS8Dialog(); });
  await page.waitForFunction(() => document.querySelectorAll('#s8Stage .s8-cell').length === 6, null, { timeout: 60000 });
  await page.evaluate(() => { s8State.urls.forEach((row, p) => row.forEach((_, i) => { s8State.urls[p][i] = `https://example.com/p${p + 1}/n${i + 1}?utm_source=x`; })); s8Refresh(); });
  await page.waitForFunction(() => document.getElementById('s8Errs').children.length === 0, null, { timeout: 5000 });
}
await openDialog();
check((await txt('#s8Title')) === '排入推播', '彈窗改名為「排入推播」');
const head = await page.evaluate(() => { const t = document.getElementById('s8Modetabs').getBoundingClientRect(), h = document.getElementById('s8Title').getBoundingClientRect(), c = document.getElementById('s8CloseBtn').getBoundingClientRect(), m = document.querySelector('#s8Modal').getBoundingClientRect(); return { left: t.left - m.left, beforeTitle: t.right <= h.left, closeRight: m.right - c.right, texts: [...document.querySelectorAll('#s8Modetabs .s8-ptab')].map(b => b.textContent), active: document.querySelector('#s8Modetabs .s8-ptab.active').dataset.md }; });
check(head.texts.join('｜') === 'LINE原生推播｜S8推播' && head.active === 'line' && head.left < 40 && head.beforeTitle, `左上有切換「${head.texts.join('｜')}」，預設是 LINE原生推播`);
check(await page.evaluate(() => getComputedStyle(document.getElementById('s8Panel')).display === 'none') && await vis('#lineFoot') && await vis('#lineP1'), 'LINE原生推播分頁只顯示 LINE 的步驟（底部進度列、傳送資料），不顯示 S8 的組織／發送對象／步驟');
check(await page.evaluate(() => ['s8Name', 's8Account', 's8TargetAll'].every(i => document.getElementById(i).offsetParent === null)) && await vis('#s8Alt'), 'LINE 不需要的欄位（群發名稱、組織、對象）隱藏，「推播通知」與連結預覽保留');
await page.hover('#s8ModeS8');
await page.waitForTimeout(450);
const tip = await page.evaluate(() => { const t = document.getElementById('uiTip'), r = t.getBoundingClientRect(), b = document.getElementById('s8ModeS8').getBoundingClientRect(); return { text: t.textContent, show: t.classList.contains('show'), op: getComputedStyle(t).opacity, below: r.top >= b.bottom }; });
const zOk = await page.evaluate(() => Number(getComputedStyle(document.getElementById('uiTip')).zIndex) > Number(getComputedStyle(document.getElementById('s8Overlay')).zIndex));
check(zOk, '提示泡泡的層級在彈窗之上（不會被彈窗蓋住）');
check(tip.text === '功能受限每月MCP上限' && tip.show && tip.op === '1' && tip.below, '游標移到「S8推播」跳出「功能受限每月MCP上限」');
{ const hb = await page.locator('#s8Modal .modal-head').boundingBox(); await page.screenshot({ path: path.join(SHOTS, 'line-ui-2b-s8-tip.png'), clip: { x: hb.x, y: hb.y, width: hb.width, height: hb.height + 70 } }); }
await page.mouse.move(600, 700); await page.waitForTimeout(450);
check(await page.locator('#uiTip').isHidden(), '游標移開後提示消失');
await page.locator('#s8Modal .modal-head').screenshot({ path: path.join(SHOTS, 'line-ui-2-header.png') });

// （第 3～10、13、17、18 節＝舊的五步驟流程、排程狀態、測試排程、多選收件人，已改版為四步驟精靈，驗證搬到 test/e2e/line-wizard.mjs）

// ===== 11. 切到 S8 分頁 =====
await page.click('#s8ModeS8');
check(await vis('#s8Panel') && !(await vis('#linePanel')) && await vis('#s8Name') && await vis('#s8Account'), '切到「S8推播」：顯示原本的 S8 步驟與欄位（名稱、組織、對象）');
await page.locator('#s8Modal').screenshot({ path: path.join(SHOTS, 'line-ui-7-s8-tab.png') });
await page.click('#s8CloseBtn');

// ===== 12. 操作提示：被其他介面碰到就先隱藏 =====
await page.setViewportSize({ width: 1100, height: 900 });
await page.evaluate(() => { goStep(2); setTipCollapsed(false); });
await page.waitForTimeout(150);
const yield1 = await page.evaluate(() => ({ y: document.getElementById('tipToast').classList.contains('tip-yield'), op: getComputedStyle(document.getElementById('tipToast')).opacity, vis: getComputedStyle(document.getElementById('tipToast')).visibility, pe: getComputedStyle(document.getElementById('tipToast')).pointerEvents }));
check(yield1.y && yield1.vis === 'hidden' && yield1.pe === 'none', '視窗窄、操作提示會碰到底部操作列：先隱藏（不能點）');
await page.screenshot({ path: path.join(SHOTS, 'line-ui-11-tip-hidden.png'), clip: { x: 0, y: 560, width: 1100, height: 340 } });
await page.setViewportSize({ width: 1700, height: 900 });
await page.waitForTimeout(250);
const yield2 = await page.evaluate(() => ({ y: document.getElementById('tipToast').classList.contains('tip-yield'), vis: getComputedStyle(document.getElementById('tipToast')).visibility }));
check(!yield2.y && yield2.vis === 'visible', '視窗變寬、不再碰到：操作提示自動恢復顯示');
await page.screenshot({ path: path.join(SHOTS, 'line-ui-12-tip-shown.png'), clip: { x: 300, y: 300, width: 1400, height: 600 } });
await page.setViewportSize({ width: 1100, height: 900 });
await page.waitForTimeout(250);
check(await page.evaluate(() => document.getElementById('tipToast').classList.contains('tip-yield')), '再變窄又碰到：再次隱藏');
await page.evaluate(() => { setTipCollapsed(true); });
await page.waitForTimeout(150);
const fabY = await page.evaluate(() => { const f = document.getElementById('tipFab').getBoundingClientRect(), d = document.getElementById('dock').getBoundingClientRect(); return { overlaps: f.left < d.right && f.right > d.left && f.top < d.bottom && f.bottom > d.top, y: document.getElementById('tipFab').classList.contains('tip-yield') }; });
check(fabY.y === fabY.overlaps, `收合成「!」按鈕時同樣規則（碰到才隱藏：${fabY.overlaps}）`);
// ===== 14. 預覽連結旁的「打開網址」（新分頁）=====
await openDialog();
await page.evaluate(() => { s8Md = 'line'; });
check(await page.evaluate(() => document.getElementById('s8CellOpen').disabled) && (await txt('#s8CellOpen')) === '打開網址', '還沒點格子：「打開網址」按鈕在連結欄後面，且不能按');
const rowBox = await page.evaluate(() => { const i = document.getElementById('s8CellUrl').getBoundingClientRect(), b = document.getElementById('s8CellOpen').getBoundingClientRect(); return { after: b.left >= i.right - 1, sameRow: Math.abs((b.top + b.height / 2) - (i.top + i.height / 2)) < 3 }; });
check(rowBox.after && rowBox.sameRow, '按鈕與連結欄同一列、在連結後方');
await page.locator('#s8Stage .s8-cell').nth(0).click();
check(await page.evaluate(() => !document.getElementById('s8CellOpen').disabled), '點了格子：「打開網址」可以按');
await page.locator('.s8-linkrow').screenshot({ path: path.join(SHOTS, 'line-ui-14-open-url.png') });
const mainUrl = page.url();
const [pop] = await Promise.all([ctx.waitForEvent('page'), page.click('#s8CellOpen')]);
await pop.waitForLoadState('domcontentloaded').catch(() => {});
const want = await page.inputValue('#s8CellUrl');
check(pop.url() === want && want.startsWith('https://example.com/p1/n1'), `用新分頁打開完整連結（${pop.url()}）`);
check((await pop.evaluate(() => window.opener)) === null, '新分頁沒有 opener（noopener，不影響編輯頁）');
await pop.close();
check(page.url() === mainUrl && await vis('#s8Overlay'), '編輯頁沒有被導走，視窗還開著');
await page.fill('#s8CellUrl', 'javascript:alert(1)');
check(await page.evaluate(() => document.getElementById('s8CellOpen').disabled), '連結不是 http(s) 開頭：不能按（不會執行 javascript:）');
await page.fill('#s8CellUrl', '');
check(await page.evaluate(() => document.getElementById('s8CellOpen').disabled), '連結是空的：不能按');
await page.click('.s8-ptab[data-sp="1"]'); await page.waitForTimeout(100);
check(await page.evaluate(() => document.getElementById('s8CellOpen').disabled), '切到第 2 頁：還沒選格子，又變回不能按');
await page.locator('#s8Stage .s8-cell').nth(2).click();
const [pop2] = await Promise.all([ctx.waitForEvent('page'), page.click('#s8CellOpen')]);
check(pop2.url().startsWith('https://example.com/p2/n3'), `第 2 頁第 3 格也能打開（${pop2.url()}）`);
await pop2.close();
await page.click('#s8ModeS8'); await page.waitForTimeout(150);
check(await vis('#s8CellOpen') && await page.evaluate(() => !document.getElementById('s8CellOpen').disabled), 'S8推播分頁一樣有「打開網址」');
await page.click('#s8ModeLine'); await page.waitForTimeout(150);

// ===== 15. 關閉再重開：預覽不能卡在「圖片產生中…」=====
// 真正的原因：上方「LINE原生推播／S8推播」切換鈕跟「第 1 頁／第 2 頁」共用 .s8-ptab 樣式，點它會把頁碼設成 NaN，之後預覽圖永遠取不到
await page.click('#s8ModeS8'); await page.click('#s8ModeLine');
check(await page.evaluate(() => Number.isInteger(s8State.sp) && document.querySelectorAll('#s8Stage img').length === 1), '點「S8推播／LINE原生推播」切換鈕：頁碼不會壞掉，預覽圖還在');
check(await page.evaluate(() => Number(document.querySelector('#s8Ptabs .s8-ptab.active').dataset.sp) === s8State.sp && document.getElementById('s8ModeLine').classList.contains('active')), '切換後「目前這一頁」與「LINE原生推播」各自維持正確的選取狀態');
await page.click('#s8CloseBtn');
await page.evaluate(() => { openS8Dialog(); });
await page.waitForFunction(() => document.querySelectorAll('#s8Stage img').length === 1, null, { timeout: 10000 });
check(await page.evaluate(() => !document.getElementById('s8StagePh') && Number.isInteger(s8State.sp)), '切換過分頁後關閉再重開：預覽正常載入（不是「圖片產生中…」）');
await page.evaluate(() => { s8State.sp = NaN; s8SaveState(); });   // 即使存進壞掉的頁碼，重開也會自動回到第 1 頁
await page.click('#s8CloseBtn');
await page.evaluate(() => { openS8Dialog(); });
await page.waitForFunction(() => document.querySelectorAll('#s8Stage img').length === 1, null, { timeout: 10000 });
check(await page.evaluate(() => s8State.sp === 0), '頁碼即使壞掉，重開也會回到第 1 頁並顯示預覽');
await page.click('#s8CloseBtn');
await page.evaluate(() => { window.__renders = 0; const orig = renderPageToOffscreen; window.__origRender = orig; renderPageToOffscreen = function (...a) { window.__renders++; return orig.apply(this, a); }; s8DropSaved(mode); s8JobKill(mode); });
await page.evaluate(() => { openS8Dialog(); });
await page.waitForTimeout(120);
await page.click('#s8CloseBtn');           // 圖還在做就關掉
await page.evaluate(() => { openS8Dialog(); });   // 馬上重開
await page.waitForFunction(() => s8State && s8State.images.length === 2 && document.querySelectorAll('#s8Stage img').length === 1, null, { timeout: 60000 });
check(await page.evaluate(() => !document.getElementById('s8StagePh')), '圖還在做就關掉、馬上重開：預覽正常出現，沒有卡在「圖片產生中…」');
check((await page.evaluate(() => window.__renders)) === 2, `重開時接上原本那份工作，沒有重畫（共畫 ${await page.evaluate(() => window.__renders)} 張，應為 2）`);
await page.click('#s8CloseBtn');
await page.evaluate(() => { openS8Dialog(); });   // 做好之後關掉再開
await page.waitForFunction(() => s8State && s8State.images.length === 2 && document.querySelectorAll('#s8Stage img').length === 1, null, { timeout: 10000 });
check((await page.evaluate(() => window.__renders)) === 2, '做好之後關掉再開：直接用做好的圖，不重畫');
// 卡住時的出路：超過 11 秒顯示「重新產生」
await page.evaluate(() => { s8State.images = []; s8Jobs[mode].startedAt -= 20000; s8RenderStage(); });
check(await vis('#s8Regen') && (await txt('#s8StagePh')).includes('比較久'), '超過 11 秒還沒好：顯示「圖片產生比較久…」與「重新產生」');
await page.locator('#s8Stage').screenshot({ path: path.join(SHOTS, 'line-ui-15-regen.png') });
await page.click('#s8Regen');
await page.waitForFunction(() => s8State && s8State.images.length === 2 && document.querySelectorAll('#s8Stage img').length === 1, null, { timeout: 60000 });
check((await page.evaluate(() => window.__renders)) === 4, '按「重新產生」：重畫一次後預覽恢復');
await page.evaluate(() => { renderPageToOffscreen = window.__origRender; });
await page.click('#s8CloseBtn');

// ===== 16. 還正在編輯：防止誤關分頁 =====
const guard = () => page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return { prevented: e.defaultPrevented, editing: editingNow() }; });
await page.evaluate(() => { editMarkClean('news'); });
check(!(await guard()).prevented, '剛下載／推播完（沒有未完成的修改）：關分頁不會被攔');
await page.evaluate(() => { pages[0].cards[0].line1 = '又改了一個標題'; });
check((await guard()).prevented, '改了內容還沒下載或推播：關分頁會跳出離開確認（beforeunload）');
await page.waitForTimeout(1700);
check((await page.title()).startsWith('● '), `分頁標題前面出現「●」（${await page.title()}）`);
await page.evaluate(() => { editMarkClean('news', 1); });
check((await guard()).prevented, '只標記第 2 頁已完成：第 1 頁還是編輯中，仍會攔');
await page.evaluate(() => { editMarkClean('news', 0); });
check(!(await guard()).prevented, '兩頁都標記完成：不再攔');
await page.waitForTimeout(1700);
check(!(await page.title()).startsWith('● '), '分頁標題的「●」消失');
await page.evaluate(() => { pages[0].cards[0].line1 = '標題 A'; });
await page.evaluate(() => { pages[0].cards[0].line1 = '又改了一個標題'; });
check(!(await guard()).prevented, '改過又改回原本的內容：視為沒有未完成的修改');
await page.evaluate(() => { s8Md = 'line'; openS8Dialog(); });
await page.waitForFunction(() => document.querySelectorAll('#s8Stage .s8-cell').length === 6, null, { timeout: 60000 });
await page.evaluate(() => { const st = lineSt(); st.test = 'busy'; });
check((await guard()).prevented, '推播傳送中：關分頁一定會攔');
await page.evaluate(() => { const st = lineSt(); st.test = ''; lineUpdateSteps(); });
await page.click('#s8CloseBtn');
// 下載本頁／全部下載之後算完成
await page.evaluate(() => { pages[1].cards[0].line1 = '第二頁新標題'; });
check((await guard()).prevented, '（再改一頁內容）編輯中');
await page.evaluate(() => { ensureAssetsReady().then(() => { editMarkClean(mode); }); });
await page.waitForTimeout(300);
check(!(await guard()).prevented, '標記完成後恢復');
// ===== 19. 快速回覆按鈕（訊息下方那排圓角按鈕）：每次推播都不同、可自己新增數量；連結留空 → 用文字到搜尋網站搜尋 =====
await page.evaluate(() => { s8Md = 'line'; try { localStorage.removeItem('qrSearchTpl'); } catch (e) { /* */ } Object.keys(qrByMode).forEach(k => { qrByMode[k] = []; }); document.getElementById('qrTpl').value = ''; });
await openDialog();
await page.evaluate(() => { const st = lineSt(); lineResetFlow(st); lineUpdateSteps(); });
check(await vis('#qrSec') && (await txt('.qr-title')).includes('最多 13 顆') && (await page.$$eval('#qrRows .qr-row', r => r.length)) === 0 && await page.isHidden('#qrPrev') && await page.isHidden('#qrTplRow'), '「推播通知」下面有「快速回覆按鈕（選填，最多 13 顆）」：一開始是空的（每次推播都不同，不帶上次的）');
for (let i = 0; i < 3; i++) await page.click('#qrAdd');
const labs = ['蔣萬安', '少康獨家專訪六都', '民調'];
for (let i = 0; i < 3; i++) await page.locator('#qrRows .qr-lab input').nth(i).fill(labs[i]);
await page.locator('#qrRows .qr-url input').nth(1).fill('https://news.example.com/interview/six-cities');
check((await page.$$eval('#qrRows .qr-row', r => r.length)) === 3 && (await page.$$eval('#qrRows .qr-cnt', c => c.map(x => x.textContent).join())) === '3/20,8/20,2/20', '可以手動新增；每顆有「顯示文字」（字數 n/20）與「連結（選填）」');
check(await vis('#qrTplRow') && (await page.$$eval('#s8Errs li', l => l.map(x => x.textContent))).some(t => t.includes('快速回覆第 1 顆沒有連結') && t.includes('搜尋網站網址')), '有按鈕沒填連結 → 出現「搜尋網站網址」欄，沒填前會提示不能傳送');
await page.fill('#qrTpl', 'https://example.com/search?q={keyword}');
const enc1 = 'https://example.com/search?q=' + encodeURIComponent('蔣萬安');
check((await page.locator('#qrRows .qr-hint').nth(0).textContent()).includes(enc1) && await page.locator('#qrRows .qr-hint').nth(1).isHidden(), `連結留空的那顆：提示實際會開啟的搜尋網址（${enc1}）；有填連結的那顆不用`);
check((await page.$$eval('#s8Errs li', l => l.map(x => x.textContent))).every(t => !t.includes('快速回覆')) && (await page.getAttribute('#qrPrev', 'class')) !== null && (await page.$$eval('#qrPrev .qr-pill', p => p.map(x => x.textContent).join())) === '蔣萬安,少康獨家專訪六都,民調' && await page.evaluate(() => getComputedStyle(document.querySelector('#qrPrev .qr-pill')).backgroundColor) === 'rgb(31, 42, 74)', '下方即時預覽成深藍圓角按鈕（跟 LINE 上的樣子一樣），錯誤消失');
check(await page.evaluate(() => localStorage.getItem('qrSearchTpl')) === 'https://example.com/search?q={keyword}' && !(await page.evaluate(() => JSON.stringify(localStorage)).then(t => t.includes('蔣萬安'))), '「搜尋網站網址」是固定設定，記在瀏覽器；按鈕內容不寫進瀏覽器（避免昨天的按鈕被帶進今天）');
await page.locator('.qr-sec').screenshot({ path: path.join(SHOTS, 'line-ui-19a-quick-reply.png') });
// 驗證
await page.locator('#qrRows .qr-lab input').nth(2).fill('一二三四五六七八九十一二三四五六七八九十一');
check((await page.$$eval('#s8Errs li', l => l.map(x => x.textContent))).some(t => t.includes('第 3 顆') && t.includes('最多 20 字')) && (await page.$$eval('#qrRows .qr-cnt', c => c[2].textContent)) === '21/20', '顯示文字超過 20 字：標紅、擋下，計數 21/20');
await page.locator('#qrRows .qr-lab input').nth(2).fill('民調');
await page.locator('#qrRows .qr-url input').nth(1).fill('http://insecure.example');
check((await page.$$eval('#s8Errs li', l => l.map(x => x.textContent))).some(t => t.includes('第 2 顆') && t.includes('https://')), '連結不是 https：擋下');
await page.locator('#qrRows .qr-url input').nth(1).fill('https://news.example.com/interview/six-cities');
await page.locator('#qrRows .qr-lab input').nth(1).fill('');
check((await page.$$eval('#s8Errs li', l => l.map(x => x.textContent))).some(t => t.includes('缺少顯示文字')), '有連結但沒填顯示文字：擋下');
await page.locator('#qrRows .qr-lab input').nth(1).fill('少康獨家專訪六都');
await page.fill('#qrTpl', 'https://example.com/search');
check((await page.$$eval('#s8Errs li', l => l.map(x => x.textContent))).some(t => t.includes('搜尋網站網址') && t.includes('{keyword}')), '搜尋網站網址沒有 {keyword}：擋下');
await page.fill('#qrTpl', 'http://example.com/search?q={keyword}');
check((await page.$$eval('#s8Errs li', l => l.map(x => x.textContent))).some(t => t.includes('https://')), '搜尋網站網址不是 https：擋下');
await page.fill('#qrTpl', 'https://example.com/search?q={關鍵字}');
check((await page.$$eval('#s8Errs li', l => l.every(x => !x.textContent.includes('快速回覆') && !x.textContent.includes('搜尋網站')))) && (await page.locator('#qrRows .qr-hint').nth(0).textContent()).includes(encodeURIComponent('蔣萬安')), '{關鍵字} 也能當佔位符');
// 排序、刪除、上限
await page.locator('#qrRows .qr-row').nth(0).locator('.qr-acts button').nth(1).click();
check((await page.$$eval('#qrRows .qr-lab input', i => i.map(x => x.value).join())) === '少康獨家專訪六都,蔣萬安,民調', '↓ 往後移：順序跟著變（預覽也是）');
await page.locator('#qrRows .qr-row').nth(2).locator('.qr-acts button').nth(2).click();
check((await page.$$eval('#qrRows .qr-row', r => r.length)) === 2 && (await page.$$eval('#qrPrev .qr-pill', p => p.map(x => x.textContent).join())) === '少康獨家專訪六都,蔣萬安', '✕ 刪除這顆');
for (let i = 0; i < 11; i++) await page.click('#qrAdd');
check(await page.isDisabled('#qrAdd') && (await txt('#qrAdd')).includes('已達上限 13 顆') && (await page.$$eval('#qrRows .qr-row', r => r.length)) === 13, '最多 13 顆：滿了「新增」變成「已達上限 13 顆」且不能按');
await page.evaluate(() => { qrByMode.news.length = 2; qrRender(); qrChanged(); });
// 傳送資料：快速回覆帶進 prepare；之後再改就作廢
await page.click('#linePrepBtn');
await page.waitForFunction(() => /傳送完成/.test(document.getElementById('linePrepMsg').textContent), null, { timeout: 60000 });
const pq = reqs.prepare.at(-1).quick;
check(JSON.stringify(pq) === JSON.stringify([{ label: '少康獨家專訪六都', kind: 'url', value: 'https://news.example.com/interview/six-cities' }, { label: '蔣萬安', kind: 'url', value: 'https://example.com/search?q=' + encodeURIComponent('蔣萬安') }]), '傳送資料：快速回覆依順序送出，連結留空的已換成搜尋網址（文字已 URL 編碼）');
await page.locator('#qrRows .qr-lab input').nth(1).fill('蔣萬安 民調');
check(await page.evaluate(() => lineSt().prep === null) && (await txt('#lineWin')).includes('內容有更動'), '傳送後又改快速回覆：已傳送的資料作廢，要重新傳送');
await page.locator('.qr-sec').screenshot({ path: path.join(SHOTS, 'line-ui-19b-quick-reply-2.png') });
// 沒設快速回覆 → 不帶
await page.evaluate(() => { qrByMode.news = []; qrRender(); qrChanged(); const st = lineSt(); lineResetFlow(st); lineUpdateSteps(); });
await page.click('#linePrepBtn');
await page.waitForFunction(() => /傳送完成/.test(document.getElementById('linePrepMsg').textContent), null, { timeout: 60000 });
check(JSON.stringify(reqs.prepare.at(-1).quick) === '[]', '沒設快速回覆：送出空陣列，行為跟以前一樣');
check(await page.evaluate(() => qrByMode.ent.length === 0), '娛樂版型的快速回覆是獨立的一份');
await page.click('#s8CloseBtn');

check(pageErrors.length === 0, `頁面沒有 JS 錯誤 ${pageErrors.join(' | ')}`);

await browser.close();
console.log(failed ? `\n${failed} 項失敗` : '\n全部通過');
process.exit(failed ? 1 : 0);
