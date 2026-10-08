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
const testerReqs = { list: 0, remove: [] };
await page.route(`${WORKER}/**`, async route => {
  const url = new URL(route.request().url());
  const body = route.request().postDataJSON?.() || {};
  const json = (obj, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(obj) });
  if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' } });
  if (url.pathname === '/lab-auth') { labAuthReqs.push(body); return body.password === 'pw' ? json({ token: 'lab-token-2', expiresAt: Date.now() + 3600e3 }) : json({ error: '密碼不正確' }, 401); }
  if (url.pathname === '/line/testers/list') { testerReqs.list++; return testersFail ? json({ error: testersFail }, 502) : json({ ok: true, testers, maxPerSend: 2 }); }
  if (url.pathname === '/line/testers/remove') { testerReqs.remove.push(body); testers = testers.filter(t => t.tid !== body.tid); return json({ ok: true, testers, maxPerSend: 2 }); }
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
check(await page.evaluate(() => getComputedStyle(document.getElementById('s8Panel')).display === 'none') && await vis('#linePanel'), 'LINE原生推播分頁只顯示 LINE 的步驟，不顯示 S8 的組織／發送對象／步驟');
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

// ===== 3. LINE 步驟 ① 傳送資料 =====
await page.evaluate(() => document.getElementById('linePanel').scrollIntoView({ block: 'start' }));
check((await txt('#lineHStepper')).replace(/\s/g, '').startsWith('1傳送資料') && await page.evaluate(() => document.querySelectorAll('#lineHStepper .s8-hs').length === 5), '水平步驟列共 5 步：傳送資料／發佈方式／測試推播／確認人數／正式推播（目前只顯示第 1 步名稱）');
check(await vis('#lineStep1') && !(await vis('#lineStep2')), '一開始只有第 1 步的按鈕');
check((await bgOf('linePrepBtn')) === 'rgb(255, 255, 255)', '還沒動作的按鈕是白色');
await page.click('#linePrepBtn');
await page.waitForFunction(() => /傳送完成/.test(document.getElementById('linePrepMsg').textContent), null, { timeout: 60000 });
const pb = reqs.prepare[0];
check(pb.org === 'news' && pb.altText === '測試推播標題' && pb.pages.length === 2 && pb.pages.every(p => Object.keys(p.images).join() === '1040' && p.height === 800 && p.buttons.length === 6), '傳送資料：版型、推播標題、每頁只送與 S8 同一張的 1040 圖與 6 個連結區塊');
check(await page.evaluate(async b64 => { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); const mine = new Uint8Array(await s8State.images[0].blob.arrayBuffer()); return mine.length === u.length && mine.every((v, i) => v === u[i]); }, pb.pages[0].images['1040']), '上傳的 1040 圖與 S8 預覽用的是同一張（位元組相同）');
check(reqs.validate.length === 1 && reqs.validate[0].channel === 'test' && reqs.send.length === 0, '傳送後請 LINE 檢查格式，沒有發送任何東西');
check((await bgOf('linePrepBtn')) === GREEN, '傳送完成：按鈕變綠色');
check(await page.evaluate(() => document.getElementById('linePrepTrack').classList.contains('open')), '有狀態時灰框往右彈開顯示文字');
check((await page.textContent('#linePrepMsg')).length < 20 && await page.evaluate(() => document.getElementById('linePrepOut').getBoundingClientRect().height < 40), '狀態文字一行放得下');

// ===== 4. 步驟 ② 立即推播／排程推播（含日期、時間選擇器）=====
check(await vis('#lineStep2') && (await txt('#linePickNow')) === '立即推播' && (await txt('#linePickSched')).includes('排程推播'), '第 2 步：選擇發佈方式「立即推播」「排程推播」');
check((await bgOf('linePickNow')) === 'rgb(255, 255, 255)' && (await bgOf('linePickSched')) === 'rgb(255, 255, 255)', '兩顆預設都是白色');
const gapPair = await page.evaluate(() => { const a = document.getElementById('linePickNow').getBoundingClientRect(), b = document.getElementById('linePickSched').getBoundingClientRect(); return b.left - a.right; });
check(Math.abs(gapPair - 14) < 0.6, `兩顆中間間距跟 S8 的「存成草稿／設定排程」一樣（${gapPair.toFixed(1)}px）`);
const dflt = await page.evaluate(() => ({ d: document.getElementById('lineDate').value, t: document.getElementById('lineTime').value, dt: document.getElementById('lineDateTxt').textContent, tt: document.getElementById('lineTimeTxt').textContent, types: [document.getElementById('lineDate').type, document.getElementById('lineTime').type] }));
check(dflt.types.join() === 'date,time' && dflt.dt === `${dflt.d.slice(5, 7)}/${dflt.d.slice(8, 10)}` && dflt.tt === dflt.t, `排程膠囊內有日期（${dflt.dt}）與時間（${dflt.tt}）選擇器，預設現在＋3 小時`);
check(Math.abs(Date.parse(`${dflt.d}T${dflt.t}:00+08:00`) - (Date.now() + 3 * 3600e3)) < 3 * 60e3, '預設時間是現在＋3 小時（台北時間）');
const midY = await page.evaluate(() => { const c = e => { const r = e.getBoundingClientRect(); return r.top + r.height / 2; }; return [c(document.getElementById('lineDateBox')), c(document.getElementById('lineTimeBox')), c(document.getElementById('linePickNow'))]; });
check(Math.abs(midY[0] - midY[2]) <= 1 && Math.abs(midY[1] - midY[2]) <= 1, '日期／時間框與左側按鈕垂直置中對齊');
const setWhen = async (d, t) => page.evaluate(([d, t]) => { const a = document.getElementById('lineDate'), b = document.getElementById('lineTime'); a.value = d; b.value = t; a.dispatchEvent(new Event('input', { bubbles: true })); b.dispatchEvent(new Event('input', { bubbles: true })); }, [d, t]);
const ymd = ms => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10), hm = ms => new Date(ms + 8 * 3600e3).toISOString().slice(11, 16);
await setWhen(ymd(Date.now() + 2 * 60e3), hm(Date.now() + 2 * 60e3));
check((await page.getAttribute('#lineWhenMsg', 'class')).includes('bad') && (await txt('#lineWhenMsg')).includes('5 分鐘') && !(await vis('#lineStep3')), '排程時間設成 2 分鐘後：紅字提示要在 5 分鐘之後，不會進下一步');
await setWhen(ymd(Date.now() + 20 * 86400e3), '10:00');
check((await txt('#lineWhenMsg')).includes('14 天') && !(await vis('#lineStep3')), '排程時間設成 20 天後：提示最晚 14 天內');
await page.hover('#linePickNow'); await page.mouse.move(600, 700);
await page.evaluate(() => { lineSetWhen(Date.now() + 3 * 3600e3); });
await page.click('#linePickNow');
await page.waitForTimeout(380);
check((await page.evaluate(() => getComputedStyle(document.querySelector('#lineSeg2 .s8-knob')).backgroundColor)) === BLUE && await vis('#lineStep3'), '選「立即推播」：旋鈕變藍色並出現第 3 步');
check(await page.evaluate(() => document.getElementById('lineStep1').classList.contains('old') && !document.getElementById('lineStep2').classList.contains('old')), '只留剛完成（發佈方式）與目前這步，再前一步（傳送資料）收起');
await page.locator('#linePanel').screenshot({ path: path.join(SHOTS, 'line-ui-2c-step2.png') });

// ===== 5. 步驟 ③ 測試推播 → 測試完成 =====
check((await txt('#lineTestBtn')) === '推播測試帳號' && await page.isHidden('#lineDoneTrack'), '第 3 步預設推播給「測試帳號」，還沒推播前沒有「測試完成」');
sendDelay = 700;
await page.click('#lineTestBtn');
await page.waitForTimeout(200);
check((await bgOf('lineTestBtn')) === BEIGE && (await txt('#lineTestBtn')) === '推播中…', '推播中：米黃色');
await page.waitForFunction(() => /已推播到測試帳號/.test(document.getElementById('lineTestMsg').textContent));
sendDelay = 0;
check(reqs.send[0].channel === 'test' && /^[0-9a-f-]{36}$/.test(reqs.send[0].retryKey), '測試推播：channel=test，帶 UUID retryKey');
check((await bgOf('lineTestBtn')) === GREEN && await page.isDisabled('#lineTestBtn') && (await txt('#lineTestBtn')) === '已推播', '推播完畢狀態正常：按鈕綠色（顯示「已推播」）且不能重複推播');
check(await vis('#lineDoneBtn') && !(await vis('#lineStep4')), '出現「測試完成」，但還沒按之前不會進入下一步');
check((await txt('#lineWin')).includes('請到手機的測試帳號確認'), '下方狀態窗寫出時間與 request id，提醒到手機確認');
await page.click('#lineDoneBtn');
check(await vis('#lineStep4') && (await bgOf('lineDoneBtn')) === GREEN, '按下「測試完成」才跳下一步，且按鈕變綠');
check(await page.evaluate(() => document.getElementById('lineStep2').classList.contains('old')), '再前一步（發佈方式）已隱藏，只留剛完成與目前這步');

// ===== 6. 步驟 ④ 確認人數（跟 S8 同款）=====
await page.waitForFunction(() => document.getElementById('lineConfirmTotal').placeholder.includes('287,091'));
check(reqs.status.some(s => s.channel === 'news') && !(await vis('#lineStep5')), '進到這步先向 LINE 查正式帳號好友數；還沒輸入前不會出現下一步');
check((await txt('#lineConfirmLabel')) === '確認人數' && (await page.getAttribute('#lineConfirmTotal', 'placeholder')) === '輸入 287,091', '「確認人數」：框內提示正確人數');
const sizeCmp = await page.evaluate(() => { const r = id => document.getElementById(id).getBoundingClientRect(); const a = r('lineConfirmLabel'), b = r('lineConfirmTotal'); return { lw: a.width, iw: b.width, ih: b.height, bh: a.height }; });
check(Math.abs(sizeCmp.lw - sizeCmp.iw) < 1.5 && Math.abs(sizeCmp.ih - sizeCmp.bh) < 1.5, `數字輸入框與旁邊的按鈕同寬同高（${sizeCmp.iw.toFixed(0)}×${sizeCmp.ih.toFixed(0)}）`);
await page.fill('#lineConfirmTotal', '100');
check((await txt('#lineConfirmMark')) === '✗' && (await bgOf('lineConfirmLabel')) === RED && !(await vis('#lineStep5')), '輸入錯誤：尾端 ✗、按鈕變紅，不會進下一步');
await page.fill('#lineConfirmTotal', '287,091');
check((await txt('#lineConfirmMark')) === '✓' && (await bgOf('lineConfirmLabel')) === GREEN && await vis('#lineStep5'), '輸入正確：尾端 ✓、按鈕變綠，出現第 5 步');
check(await page.evaluate(() => document.getElementById('lineStep3').classList.contains('old')), '再前一步（測試推播）已隱藏');
await page.locator('#linePanel').screenshot({ path: path.join(SHOTS, 'line-ui-3-step4.png') });

// ===== 7. 步驟 ⑤ 正式推播：綠 → 黃 → 滑動開關 =====
const go = id => page.evaluate(i => document.getElementById(i).textContent, id);
check((await go('lineGoBtn')) === '正式推播' && (await bgOf('lineGoBtn')) === GREEN, '「正式推播」是綠色');
check(reqs.send.length === 1, '到這裡正式帳號還沒推播任何東西');
await page.click('#lineGoBtn');
check((await go('lineGoBtn')) === '確定推播？' && (await bgOf('lineGoBtn')) === YELLOW, '按下後同一個按鈕變成黃色「確定推播？」');
check(reqs.send.length === 1, '黃色確認階段仍然沒有推播');
await page.click('#lineGoBtn');
check(await vis('#lineSlider') && !(await vis('#lineGoBtn')), '再按一次：同位置變成圓框滑動開關');
const geo = await page.evaluate(() => { const s = document.getElementById('lineSlider').getBoundingClientRect(), k = document.getElementById('lineKnob').getBoundingClientRect(); return { sh: s.height, kw: k.width, kh: k.height, kleft: k.left - s.left, radius: getComputedStyle(document.getElementById('lineSlider')).borderRadius }; });
check(Math.abs(geo.sh - 46) < 1 && geo.kw === geo.kh && geo.kleft < 8 && parseFloat(geo.radius) >= 20, `滑動開關：圓框高 ${geo.sh}px（與其他步驟同高），白色圓鈕在最左側`);
await page.locator('#linePanel').screenshot({ path: path.join(SHOTS, 'line-ui-4-slider.png') });
const kb = await page.locator('#lineKnob').boundingBox(), sb = await page.locator('#lineSlider').boundingBox();
await page.mouse.move(kb.x + kb.width / 2, kb.y + kb.height / 2); await page.mouse.down();
await page.mouse.move(kb.x + sb.width * 0.5, kb.y + kb.height / 2, { steps: 8 });
const half = await page.evaluate(() => document.getElementById('lineKnob').style.transform);
await page.mouse.up(); await page.waitForTimeout(450);
const back = await page.evaluate(() => document.getElementById('lineKnob').style.transform);
check(/translateX\((?!0px)/.test(half) && /translateX\(0px\)/.test(back) && reqs.send.length === 1, '滑到一半放開會彈回左側，不會推播');
sendDelay = 600;
const kb2 = await page.locator('#lineKnob').boundingBox();
await page.mouse.move(kb2.x + kb2.width / 2, kb2.y + kb2.height / 2); await page.mouse.down();
await page.mouse.move(kb2.x + sb.width + 40, kb2.y + kb2.height / 2, { steps: 12 });
await page.mouse.up();
await page.waitForFunction(() => /推播中/.test(document.getElementById('lineWin').textContent || ''), null, { timeout: 5000 });
check((await txt('.line-slabel')) === '推播中…', '滑到右側後開關顯示「推播中…」，並在下方狀態窗等回報');
await page.waitForFunction(() => /已正式推播到/.test(document.getElementById('lineWin').textContent), null, { timeout: 10000 });
sendDelay = 0;
const off = reqs.send[1];
check(off.channel === 'news' && off.testToken === 'ttok' && off.confirmTotal === 287091 && /^[0-9a-f-]{36}$/.test(off.retryKey) && off.retryKey !== reqs.send[0].retryKey, '正式推播：channel=news、帶 testToken、你輸入的人數 287091、另一組 retryKey');
check((await txt('#lineWin')).includes('287,091') && await page.evaluate(() => document.getElementById('lineWin').classList.contains('ok')), '下方狀態窗（綠色）回報推播成功、時間、人數、request id');
check((await go('lineGoBtn')) === '已正式推播' && (await bgOf('lineGoBtn')) === GREEN && await page.isDisabled('#lineGoBtn'), '完成後按鈕顯示「已正式推播」，不能重複推播');
await page.locator('#linePanel').screenshot({ path: path.join(SHOTS, 'line-ui-5-done.png') });

// ===== 8. 發送紀錄與點擊次數（折疊區）=====
await page.evaluate(() => { document.getElementById('lineBox').open = true; });
const hist = await page.evaluate(() => JSON.parse(localStorage.getItem('lineSends')));
check(hist.length === 2 && hist[0].channel === 'news' && hist[1].channel === 'test' && hist[0].links.length === 12, '測試與正式推播都記下 request id 與每格連結');
await page.click('#lineClicksBtn');
await page.waitForSelector('#lineClicksOut table');
const rows = await page.$$eval('#lineClicksOut table tr', trs => trs.map(tr => [...tr.children].map(c => c.textContent)));
check(reqs.clicks[0].requestId === '22222222-2222-4222-8222-222222222222' && rows[1][2] === '1,234' && rows[2][2] === '—' && rows.some(r => r[0] === '（其他連結）'), '查詢點擊次數：每個連結一列、不足 20 顯示「—」、其他連結另列');
const snap = await page.evaluate(() => JSON.parse(localStorage.getItem('lineSends'))[0].snap);
check(snap && snap.clicks.length === 3 && /\+08:00$/.test(snap.at), '每次查到的數字自動存成快照');
check((await txt('#lineClicksOut .line-note')).includes('LINE 數據查詢時間'), '表格下方註明查詢時間');

// ---- 時間太久：超過 14 天 LINE 不再提供 → 顯示最後一次的快照，不再問 LINE ----
await page.evaluate(() => { const a = JSON.parse(localStorage.getItem('lineSends')); a[0].sentAt = '2026-09-01T10:00:00+08:00'; localStorage.setItem('lineSends', JSON.stringify(a)); lineHistRender(); });
const clicksBefore = reqs.clicks.length;
await page.click('#lineClicksBtn');
await page.waitForFunction(() => /快照/.test(document.getElementById('lineClicksOut').textContent));
check(reqs.clicks.length === clicksBefore && (await txt('#lineClicksOut')).includes('已超過 14 天') && (await page.$$eval('#lineClicksOut table tr', t => t.length)) > 3, '超過 14 天：不再問 LINE，直接顯示最後一次查到的快照，並說明');
check((await page.$$eval('#lineHist option', os => os[0].textContent)).includes('已過 14 天，有快照'), '下拉選單標出「已過 14 天，有快照」');
await page.evaluate(() => { const a = JSON.parse(localStorage.getItem('lineSends')); delete a[0].snap; localStorage.setItem('lineSends', JSON.stringify(a)); lineHistRender(); });
await page.click('#lineClicksBtn');
await page.waitForFunction(() => /沒有存快照/.test(document.getElementById('lineClicksOut').textContent));
check((await txt('#lineClicksOut')).includes('下次請在發送後 14 天內查詢'), '超過 14 天又沒有快照：說明查不到的原因與下次怎麼做');
await page.evaluate(() => { const a = JSON.parse(localStorage.getItem('lineSends')); a[0].sentAt = '2026-10-07T12:00:00+08:00'; localStorage.setItem('lineSends', JSON.stringify(a)); lineHistRender(); });

// ---- 憑證過期：跳出密碼視窗，輸入後自動繼續 ----
await page.evaluate(() => { sessionStorage.setItem('labAuth', JSON.stringify({ token: 'old', expiresAt: Date.now() - 1000 })); });
const c0 = reqs.clicks.length;
await page.click('#lineClicksBtn');
await page.waitForSelector('#labOverlay.open');
check((await txt('#labMsg')).includes('憑證已過期') && await page.evaluate(() => Number(getComputedStyle(document.getElementById('labOverlay')).zIndex) > Number(getComputedStyle(document.getElementById('s8Overlay')).zIndex)), '憑證過期：自動跳出密碼視窗（蓋在排入推播視窗之上），說明輸入後會繼續');
check(await page.evaluate(() => document.getElementById('s8Overlay').classList.contains('open')), '排入推播視窗還開著，沒有被關掉或重畫');
await page.screenshot({ path: path.join(SHOTS, 'line-ui-10-relogin.png') });
await page.fill('#labPass', 'pw'); await page.click('#labEnterBtn');
await page.waitForFunction(() => document.querySelector('#lineClicksOut table') && /LINE 數據查詢時間/.test(document.getElementById('lineClicksOut').textContent));
check(labAuthReqs.length === 1 && reqs.clicks.length === c0 + 1 && !(await page.evaluate(() => document.getElementById('labOverlay').classList.contains('open'))), '輸入密碼後剛剛的查詢自動繼續完成（不用重按）');
// 取消 → 說明憑證過期，不會把視窗關掉
await page.evaluate(() => { sessionStorage.setItem('labAuth', JSON.stringify({ token: 'old', expiresAt: Date.now() - 1000 })); });
await page.click('#lineClicksBtn');
await page.waitForSelector('#labOverlay.open');
await page.click('#labCancelBtn');
await page.waitForFunction(() => /憑證已過期/.test(document.getElementById('lineClicksOut').textContent));
check(await page.evaluate(() => document.getElementById('s8Overlay').classList.contains('open')), '取消輸入密碼：顯示憑證過期說明，視窗仍開著');
await page.evaluate(() => { sessionStorage.setItem('labAuth', JSON.stringify({ token: 'lab-token-2', expiresAt: Date.now() + 3600e3 })); });

// ===== 9. 排程推播流程 + 排程狀態（查看、變更、刪除）=====
await page.evaluate(() => { const st = lineSt(); lineResetFlow(st); lineUpdateSteps(); });
await page.click('#linePrepBtn');
await page.waitForFunction(() => /傳送完成/.test(document.getElementById('linePrepMsg').textContent), null, { timeout: 60000 });
const when1 = Date.now() + 3 * 3600e3;
await setWhen(ymd(when1), hm(when1));
await page.waitForTimeout(380);
check((await page.evaluate(() => getComputedStyle(document.querySelector('#lineSeg2 .s8-knob')).backgroundColor)) === BLUE && await vis('#lineStep3') && (await txt('#lineWhenMsg')).includes('由 Worker 自動推播'), '點日期／時間選擇器就是選了「排程推播」：旋鈕變藍，出現第 3 步，說明由 Worker 自動推播');
check((await page.textContent('#lineDot5Txt')) === '正式排程', '第 5 步名稱變成「正式排程」');
await page.locator('#linePanel').screenshot({ path: path.join(SHOTS, 'line-ui-8-sched-step2.png') });
await page.click('#lineTestBtn');
await page.waitForFunction(() => /已推播到測試帳號/.test(document.getElementById('lineTestMsg').textContent));
await page.click('#lineDoneBtn');
await page.waitForFunction(() => document.getElementById('lineConfirmTotal').placeholder.includes('287,091'));
await page.fill('#lineConfirmTotal', '287091');
check((await go('lineGoBtn')) === '正式排程' && (await bgOf('lineGoBtn')) === GREEN, '「正式排程」綠色');
await page.click('#lineGoBtn');
check((await go('lineGoBtn')) === '確定排程？' && (await bgOf('lineGoBtn')) === YELLOW, '黃色「確定排程？」');
await page.click('#lineGoBtn');
check((await txt('.line-slabel')) === '滑動以排程推播', '滑動開關寫「滑動以排程推播」');
const sendsBefore = reqs.send.length;
const kb4 = await page.locator('#lineKnob').boundingBox(), sb4 = await page.locator('#lineSlider').boundingBox();
await page.mouse.move(kb4.x + kb4.width / 2, kb4.y + kb4.height / 2); await page.mouse.down();
await page.mouse.move(kb4.x + sb4.width + 40, kb4.y + kb4.height / 2, { steps: 12 });
await page.mouse.up();
await page.waitForFunction(() => /已排程/.test(document.getElementById('lineWin').textContent), null, { timeout: 10000 });
const cr = schedReqs.create[0];
check(cr.channel === 'news' && cr.runAt === `${ymd(when1)}T${hm(when1)}:00+08:00` && cr.confirmTotal === 287091 && cr.testToken === 'ttok' && cr.links.length === 12 && reqs.send.length === sendsBefore, '建立排程：帶帳號、台北時間 ISO、人數、testToken、12 個連結，且沒有立刻發送');
check((await go('lineGoBtn')) === '已排程' && (await bgOf('lineGoBtn')) === GREEN, '完成後按鈕顯示「已排程」');
await page.waitForFunction(() => document.querySelectorAll('#lineSchedList .line-srow').length >= 1);
let srows = await page.$$eval('#lineSchedList .line-srow', rs => rs.map(r => ({ text: r.textContent, btns: [...r.querySelectorAll('button')].map(b => b.textContent), chip: r.querySelector('.line-chip:last-of-type').textContent })));
check(srows[0].chip === '待發送' && srows[0].text.includes(`${ymd(when1)} ${hm(when1)}`) && srows[0].text.includes('TVBS新聞') && srows[0].btns.join() === '變更時間,刪除排程', '排程狀態：列出時間、帳號、「待發送」，並有「變更時間」「刪除排程」');
await page.locator('#lineSched').screenshot({ path: path.join(SHOTS, 'line-ui-9-sched-list.png') });
// 變更時間
await page.click('#lineSchedList .line-srow button:has-text("變更時間")');
const when2 = Date.now() + 5 * 3600e3;
await page.evaluate(([d, t]) => { const ins = document.querySelectorAll('#lineSchedList .line-srow input'); ins[0].value = d; ins[0].dispatchEvent(new Event('input')); ins[1].value = t; ins[1].dispatchEvent(new Event('input')); }, [ymd(when2), hm(when2)]);
await page.click('#lineSchedList .line-srow button:has-text("儲存新時間")');
await page.waitForFunction(t => document.querySelector('#lineSchedList .when').textContent === t, `${ymd(when2)} ${hm(when2)}`);
check(schedReqs.update.length === 1 && schedReqs.update[0].runAt === `${ymd(when2)}T${hm(when2)}:00+08:00` && (await txt('#lineSchedList .when')) === `${ymd(when2)} ${hm(when2)}`, '變更時間：送出新的時間，列表更新');
// 不合格的新時間不會送出
await page.click('#lineSchedList .line-srow button:has-text("變更時間")');
await page.evaluate(([d, t]) => { const ins = document.querySelectorAll('#lineSchedList .line-srow input'); ins[0].value = d; ins[0].dispatchEvent(new Event('input')); ins[1].value = t; ins[1].dispatchEvent(new Event('input')); }, [ymd(Date.now() + 60e3), hm(Date.now() + 60e3)]);
const dlgN = dialogs.length;
await page.click('#lineSchedList .line-srow button:has-text("儲存新時間")');
check(schedReqs.update.length === 1 && dialogs.length === dlgN + 1 && dialogs.at(-1).includes('5 分鐘'), '新時間不合格（5 分鐘內）：跳出說明，不會送出');
await page.click('#lineSchedList .line-srow button:has-text("取消")');
// 刪除排程
await page.click('#lineSchedList .line-srow button:has-text("刪除排程")');
await page.waitForFunction(() => /已取消/.test(document.querySelector('#lineSchedList').textContent));
check(schedReqs.cancel.length === 1 && dialogs.at(-1).includes('確定要刪除這筆排程') && dialogs.at(-1).includes('刪除後不會發送'), '刪除排程：先跳確認視窗，確認後送出取消，狀態變「已取消」');
check(await page.$$eval('#lineSchedList .line-srow', rs => !rs[0].querySelector('button')), '已取消的排程沒有變更／刪除按鈕');
// Cron 沒在跑 → 紅色警告
scheds.push({ id: 'b'.repeat(24), channel: 'news', org: 'news', name: 'x', altText: '另一筆', runAt: Date.now() + 3600e3, runAtIso: `${ymd(Date.now() + 3600e3)}T${hm(Date.now() + 3600e3)}:00+08:00`, status: 'scheduled', links: [] });
heartbeat = 0;
await page.click('#lineSchedRefresh');
await page.waitForFunction(() => !document.getElementById('lineSchedWarn').hidden);
check((await txt('#lineSchedWarn')).includes('Cron Trigger 沒有在跑') && (await txt('#lineSchedWarn')).includes('* * * * *'), 'Cron 沒有心跳而且有待發送的排程：紅字警告，說明怎麼設定');
heartbeat = Date.now();
// 排程自動發出去：把 request id 補進發送紀錄
scheds.push({ id: 'c'.repeat(24), channel: 'ent', org: 'ent', name: 'y', altText: '自動發出的', runAt: Date.now() - 3600e3, runAtIso: '2026-10-07T10:00:00+08:00', status: 'sent', requestId: '33333333-3333-4333-8333-333333333333', sentAt: '2026-10-07T10:00:05+08:00', links: [{ page: 1, label: '左上', title: '★標題', url: 'https://example.com/auto' }] });
await page.click('#lineSchedRefresh');
await page.waitForFunction(() => !document.getElementById('lineSchedWarn').hidden === false && /自動發出的/.test(document.getElementById('lineSchedList').textContent));
check((await page.evaluate(() => JSON.parse(localStorage.getItem('lineSends')).some(r => r.requestId === '33333333-3333-4333-8333-333333333333' && r.fromSchedule))), '排程自動發出去的，request id 自動補進發送紀錄（才能查點擊次數）');
await page.locator('#lineSched').screenshot({ path: path.join(SHOTS, 'line-ui-9b-sched-list2.png') });

// ===== 10. 推播失敗 → 下方狀態窗（黃）=====
await page.evaluate(() => { const st = lineSt(); lineResetFlow(st); lineUpdateSteps(); });
await page.click('#linePrepBtn');
await page.waitForFunction(() => /傳送完成/.test(document.getElementById('linePrepMsg').textContent), null, { timeout: 60000 });
await page.click('#linePickNow');
sendFail = 'LINE 回應 429：You have reached your monthly limit。請到 LINE 官方帳號後台確認有沒有發出去。';
await page.click('#lineTestBtn');
await page.waitForFunction(() => /已推播到測試帳號/.test(document.getElementById('lineTestMsg').textContent));
await page.click('#lineDoneBtn');
await page.waitForFunction(() => document.getElementById('lineConfirmTotal').placeholder.includes('287,091'));
await page.fill('#lineConfirmTotal', '287091');
await page.click('#lineGoBtn'); await page.click('#lineGoBtn');
const kb3 = await page.locator('#lineKnob').boundingBox();
await page.mouse.move(kb3.x + kb3.width / 2, kb3.y + kb3.height / 2); await page.mouse.down();
await page.mouse.move(kb3.x + sb.width + 40, kb3.y + kb3.height / 2, { steps: 12 });
await page.mouse.up();
await page.waitForFunction(() => /推播失敗/.test(document.getElementById('lineWin').textContent), null, { timeout: 10000 });
check(await page.evaluate(() => document.getElementById('lineWin').classList.contains('bad')) && (await txt('#lineWin')).includes('monthly limit') && (await txt('#lineWin')).includes('後台確認'), '推播失敗：下方狀態窗（黃色）顯示原因，並提醒到後台確認');
check((await bgOf('lineGoBtn')) === RED && (await go('lineGoBtn')).includes('重新推播') && await vis('#lineGoBtn'), '失敗後按鈕變紅色，可再試一次');
await page.locator('#linePanel').screenshot({ path: path.join(SHOTS, 'line-ui-6-failed.png') });
sendFail = '';
// 排程失敗（例如時間被 Worker 擋掉）
await page.evaluate(() => { const st = lineSt(); st.goState = ''; st.go = 0; st.choice = 'sched'; lineUpdateSteps(); });
schedFail = '排程時間必須在 5 分鐘之後。沒有建立排程。';
await page.click('#lineGoBtn'); await page.click('#lineGoBtn');
const kb5 = await page.locator('#lineKnob').boundingBox();
await page.mouse.move(kb5.x + kb5.width / 2, kb5.y + kb5.height / 2); await page.mouse.down();
await page.mouse.move(kb5.x + sb.width + 40, kb5.y + kb5.height / 2, { steps: 12 });
await page.mouse.up();
await page.waitForFunction(() => /排程失敗/.test(document.getElementById('lineWin').textContent), null, { timeout: 10000 });
check((await txt('#lineWin')).includes('5 分鐘之後') && (await go('lineGoBtn')).includes('重新排程'), '排程失敗：下方狀態窗顯示原因，按鈕可重試');
schedFail = '';

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
// ===== 13. 測試帳號排程（不需要測試推播與確認人數）=====
await page.setViewportSize({ width: 1100, height: 1500 });
await ctx.route('https://example.com/**', r => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>ok</title>ok' }));
await page.evaluate(() => { s8Md = 'line'; });
await openDialog();
await page.evaluate(() => { const st = lineSt(); lineResetFlow(st); lineUpdateSteps(); });
await page.click('#linePrepBtn');
await page.waitForFunction(() => /傳送完成/.test(document.getElementById('linePrepMsg').textContent), null, { timeout: 60000 });
check(!(await vis('#lineTarget')), '還沒選「排程推播」：看不到「排程對象」');
const tw = Date.now() + 2 * 3600e3;
await setWhen(ymd(tw), hm(tw));
await page.waitForTimeout(380);
check(await vis('#lineTarget') && (await page.$$eval('#lineTarget .line-tbtn', b => b.map(x => x.textContent).join())) === '正式帳號,測試帳號' && await page.evaluate(() => document.getElementById('lineTgtOfficial').classList.contains('on')), '選了排程推播：出現「排程對象：正式帳號／測試帳號」，預設正式帳號');
check(await vis('#lineStep3') && (await page.evaluate(() => !document.getElementById('lineDot3').hidden && !document.getElementById('lineDot4').hidden)), '正式帳號：照原本流程（要測試推播、確認人數）');
await page.locator('#linePanel').screenshot({ path: path.join(SHOTS, 'line-ui-13a-target-official.png') });
await page.click('#lineTgtTest');
await page.waitForTimeout(300);
const tsUi = await page.evaluate(() => ({ d3: document.getElementById('lineDot3').hidden, d4: document.getElementById('lineDot4').hidden, l3: document.getElementById('lineLine3').hidden, n5: document.querySelector('#lineDot5 i').textContent, t5: document.getElementById('lineDot5Txt').textContent, s3: document.getElementById('lineStep3').hidden, s4: document.getElementById('lineStep4').hidden, s5: document.getElementById('lineStep5').hidden, go: document.getElementById('lineGoBtn').textContent, msg: document.getElementById('lineWhenMsg').textContent, on: document.getElementById('lineTgtTest').classList.contains('on') }));
check(tsUi.d3 && tsUi.d4 && tsUi.l3 && tsUi.n5 === '3' && tsUi.t5 === '測試排程' && tsUi.s3 && tsUi.s4 && !tsUi.s5 && tsUi.go === '測試排程' && tsUi.on, '選「測試帳號」：略過測試推播與確認人數，步驟列變 ①②③，第 3 步叫「測試排程」');
check(tsUi.msg.includes('測試帳號') && tsUi.msg.includes('不需要測試推播與確認人數'), '時間下方的說明寫明只推播到測試帳號');
await page.locator('#linePanel').screenshot({ path: path.join(SHOTS, 'line-ui-13b-target-test.png') });
const sendsB = reqs.send.length, createsB = schedReqs.create.length;
await page.click('#lineGoBtn');
check((await go('lineGoBtn')) === '確定排程？' && (await bgOf('lineGoBtn')) === YELLOW, '測試排程：綠 → 黃「確定排程？」');
await page.click('#lineGoBtn');
check((await txt('.line-slabel')) === '滑動以排程到測試帳號', '滑動開關寫「滑動以排程到測試帳號」');
{
  const kb = await page.locator('#lineKnob').boundingBox(), sb = await page.locator('#lineSlider').boundingBox();
  await page.mouse.move(kb.x + kb.width / 2, kb.y + kb.height / 2); await page.mouse.down();
  await page.mouse.move(kb.x + sb.width + 40, kb.y + kb.height / 2, { steps: 12 }); await page.mouse.up();
}
await page.waitForFunction(() => /已排程到測試帳號/.test(document.getElementById('lineWin').textContent), null, { timeout: 10000 });
const tc = schedReqs.create[createsB];
check(schedReqs.create.length === createsB + 1 && tc.channel === 'test' && tc.runAt === `${ymd(tw)}T${hm(tw)}:00+08:00` && tc.confirmTotal === undefined && tc.testToken === undefined && reqs.send.length === sendsB, '建立排程：channel=test、沒帶人數與測試憑證，也沒有立刻發送');
await page.waitForFunction(() => [...document.querySelectorAll('#lineSchedList .line-srow')].some(r => r.textContent.includes('測試帳號')));
const trow = await page.$$eval('#lineSchedList .line-srow', rs => rs.filter(r => r.textContent.includes('測試帳號')).map(r => ({ chips: [...r.querySelectorAll('.line-chip')].map(c => c.textContent), btns: [...r.querySelectorAll('button')].map(b => b.textContent) }))[0]);
check(trow.chips.includes('測試帳號') && trow.chips.includes('待發送') && trow.btns.join() === '變更時間,刪除排程', '排程狀態：標示「測試帳號」「待發送」，一樣能變更時間、刪除');
await page.locator('#lineSched').screenshot({ path: path.join(SHOTS, 'line-ui-13c-test-sched-list.png') });
check((await go('lineGoBtn')) === '已排程' && await page.evaluate(() => document.getElementById('lineGoBtn').disabled), '完成後按鈕變「已排程」且不能再按（避免重複排）');
await page.evaluate(() => { const st = lineSt(); lineResetFlow(st); lineUpdateSteps(); });
await page.click('#linePrepBtn');
await page.waitForFunction(() => /傳送完成/.test(document.getElementById('linePrepMsg').textContent), null, { timeout: 60000 });
await setWhen(ymd(tw), hm(tw)); await page.waitForTimeout(300);
await page.click('#lineTgtTest'); await page.waitForTimeout(150); await page.click('#lineTgtOfficial'); await page.waitForTimeout(300);
check(await page.evaluate(() => !document.getElementById('lineDot3').hidden && !document.getElementById('lineDot4').hidden && document.querySelector('#lineDot5 i').textContent === '5' && document.getElementById('lineDot5Txt').textContent === '正式排程'), '改回「正式帳號」：步驟列恢復成五步、第 5 步叫「正式排程」');
check(await page.evaluate(() => !document.getElementById('lineStep5').hidden === false || document.getElementById('lineStep5').hidden), '改回正式帳號：不會直接跳到最後一步（還要測試推播與確認人數）');

// ===== 14. 預覽連結旁的「打開網址」（新分頁）=====
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
// ===== 17. 測試名單：多選下拉，測試推播只發給「勾選的人」（最多 2 位，選滿就不能再選）=====
const whoChecked = () => page.$$eval('#lineWhoPanel input:checked', i => i.map(x => x.value));
const whoDisabled = () => page.$$eval('#lineWhoPanel input:disabled', i => i.map(x => x.value));
await page.evaluate(() => { s8Md = 'line'; });
await page.evaluate(() => { try { localStorage.removeItem('lineWho'); localStorage.removeItem('lineMe'); } catch (e) { /* */ } lineWhoSt.sel = []; lineWhoSt.loaded = false; });
await openDialog();
await page.evaluate(() => { const st = lineSt(); lineResetFlow(st); lineUpdateSteps(); });
await page.click('#linePrepBtn');
await page.waitForFunction(() => /傳送完成/.test(document.getElementById('linePrepMsg').textContent), null, { timeout: 60000 });
await page.click('#linePickNow'); await page.waitForTimeout(400);
await page.waitForFunction(() => lineWhoSt.loaded && document.querySelectorAll('#lineWhoPanel input').length === 3);
check(await vis('#lineWho') && await vis('#lineWhoBtn') && !(await page.$('#lineWhoMe')) && !(await page.$('#lineWho2')), '測試推播前只有一個「測試推播給」多選下拉（不是兩個單選）');
check((await txt('#lineWhoBtnTxt')) === '請選擇（最多 2 位）' && await page.isHidden('#lineWhoPanel'), '還沒選：按鈕寫「請選擇（最多 2 位）」，選單收著');
check(await page.evaluate(() => document.getElementById('lineTestBtn').disabled) && (await txt('#lineWhoNote')).includes('請先選擇測試推播要傳給誰') && (await page.getAttribute('#lineWhoNote', 'class')).includes('bad'), '還沒選人：「推播測試帳號」不能按，並提示要先選');
check(!(await page.evaluate(() => document.body.innerText.includes('同事'))), '畫面上沒有「同事」兩個字');
await page.locator('#linePanel').screenshot({ path: path.join(SHOTS, 'line-ui-17a-who-empty.png') });
await page.click('#lineWhoBtn');
check(await vis('#lineWhoPanel') && (await page.getAttribute('#lineWhoBtn', 'aria-expanded')) === 'true' && (await page.$$eval('#lineWhoPanel .ms-opt', o => o.map(x => x.textContent.trim()).join())) === '王小明,李小華,陳小美', '點開：列出已登記的名字（勾選方塊）');
await page.screenshot({ path: path.join(SHOTS, 'line-ui-17a2-who-open.png'), clip: { ...(await page.locator('#lineWho').boundingBox()), height: 260 } });
await page.click(`#lineWhoPanel input[value="${T_B}"]`);
check(JSON.stringify(await whoChecked()) === JSON.stringify([T_B]) && (await txt('#lineWhoBtnTxt')) === '李小華' && !(await page.evaluate(() => document.getElementById('lineTestBtn').disabled)), '勾 1 位：按鈕顯示名字，測試推播可以按');
check(JSON.stringify(await page.evaluate(() => JSON.parse(localStorage.getItem('lineWho')))) === JSON.stringify([T_B]), '選擇記在這個瀏覽器（下次自動帶入）');
check((await txt('#lineWhoNote')).includes('李小華') && (await txt('#lineWhoNote')).includes('1 位') && (await txt('#lineWhoNote')).includes(`剩 ${200 - testUsed}／200`), '說明：只發給李小華、1 位、約用 1 則，並顯示測試帳號本月剩餘額度');
check((await whoDisabled()).length === 0, '只選 1 位時，其他人都還能勾');
await page.click(`#lineWhoPanel input[value="${T_C}"]`);
check(JSON.stringify(await whoChecked()) === JSON.stringify([T_B, T_C]) && (await txt('#lineWhoBtnTxt')) === '李小華、陳小美' && (await txt('#lineWhoNote')).includes('2 位'), '勾第 2 位：按鈕顯示「李小華、陳小美」，共 2 位');
check(JSON.stringify(await whoDisabled()) === JSON.stringify([T_A]) && (await txt('#lineWhoPanel .ms-foot')).includes('已選滿 2 位'), '選滿 2 位：沒勾的人變灰、不能再勾，並提示要取消一位才能換人');
await page.click(`#lineWhoPanel input[value="${T_A}"]`, { force: true }).catch(() => {});
check(JSON.stringify(await whoChecked()) === JSON.stringify([T_B, T_C]), '硬點灰掉的選項也勾不上去（維持原本 2 位）');
await page.screenshot({ path: path.join(SHOTS, 'line-ui-17b-who-full.png'), clip: { ...(await page.locator('#lineWho').boundingBox()), height: 260 } });
await page.click(`#lineWhoPanel input[value="${T_C}"]`);
check(JSON.stringify(await whoChecked()) === JSON.stringify([T_B]) && (await whoDisabled()).length === 0, '取消 1 位：其他人又能勾');
await page.click(`#lineWhoPanel input[value="${T_A}"]`);
check(JSON.stringify(await whoChecked()) === JSON.stringify([T_A, T_B]) && (await txt('#lineWhoBtnTxt')) === '李小華、王小明', '換成另一位：取消後再勾');
await page.click('#lineWhoNote'); await page.waitForTimeout(100);
check(await page.isHidden('#lineWhoPanel'), '點選單外面：選單收起，選擇還在');
await page.click('#lineWhoBtn'); await page.keyboard.press('Escape'); await page.waitForTimeout(100);
check(await page.isHidden('#lineWhoPanel') && await vis('#s8Overlay'), '按 Esc：只收起選單，不會關掉整個視窗');
await page.click(`#lineWhoBtn`); await page.click(`#lineWhoPanel input[value="${T_A}"]`); await page.click('#lineWhoNote');   // 取消王小明，剩李小華
await page.waitForTimeout(100);
await page.click(`#lineWhoBtn`); await page.click(`#lineWhoPanel input[value="${T_C}"]`); await page.click('#lineWhoNote');   // 加陳小美 → 李小華、陳小美
await page.locator('#linePanel').screenshot({ path: path.join(SHOTS, 'line-ui-17c-who-picked.png') });
const sendsBefore17 = reqs.send.length;
await page.evaluate(() => { lineUsageCheckMs = 100; });
const usedBefore17 = testUsed;
await page.click('#lineTestBtn');
await page.waitForFunction(() => /已推播到測試帳號/.test(document.getElementById('lineTestMsg').textContent));
const b17 = reqs.send[sendsBefore17];
check(b17.channel === 'test' && JSON.stringify(b17.testers) === JSON.stringify([T_B, T_C]), '測試推播送出：只帶勾選的 2 位（李小華、陳小美）');
check((await txt('#lineTestMsg')).includes('李小華、陳小美') && (await txt('#lineWin')).includes('收件人：李小華、陳小美'), '結果寫明收件人是誰');
check(!(await vis('#lineWho')), '測試推播完成後收件人選單收起');
await page.waitForFunction(() => /用量核對/.test(document.getElementById('lineWin').textContent), null, { timeout: 5000 });
check((await txt('#lineWin')).includes(`本月已用 ${usedBefore17} → ${usedBefore17 + 2}（+2），和「收件人數 2 位 = 2 則」一致`), '發送後向 LINE 核對實際用量：前後差 +2，與「收件人數 = 則數」一致');
// 換收件人要換一把重試金鑰
const keyChange = await page.evaluate(() => { const st = lineSt(); st.retryKey.test = 'x'; lineWhoToggle(lineWhoPicked()[0], false); return st.retryKey.test; });
check(keyChange === '', '換收件人：清掉原本的重試金鑰（下一次發送會產生新的）');
await page.evaluate(() => { lineWhoSt.sel = []; lineWhoStoreSel([]); });
// 名單空／讀不到
await page.evaluate(() => { const st = lineSt(); lineResetFlow(st); lineUpdateSteps(); });
await page.click('#linePrepBtn');
await page.waitForFunction(() => /傳送完成/.test(document.getElementById('linePrepMsg').textContent), null, { timeout: 60000 });
const saved17 = testers; testers = [];
await page.click('#linePickNow'); await page.waitForTimeout(150);
await page.click('#lineWhoRefresh');
await page.waitForFunction(() => /名單是空的/.test(document.getElementById('lineWhoNote').textContent));
check(await page.evaluate(() => document.getElementById('lineTestBtn').disabled) && (await txt('#lineWhoBtnTxt')) === '（名單是空的）', '名單是空的：不能測試推播，並教你傳「登記」');
testersFail = '憑證過期'; await page.click('#lineWhoRefresh');
await page.waitForFunction(() => /讀不到測試名單/.test(document.getElementById('lineWhoNote').textContent));
check(await page.evaluate(() => document.getElementById('lineTestBtn').disabled) && (await txt('#lineWhoNote')).includes('憑證過期'), '名單讀不到：顯示原因，不能測試推播');
testersFail = ''; testers = saved17; await page.click('#lineWhoRefresh');
await page.waitForFunction(() => document.querySelectorAll('#lineWhoPanel input').length === 3);
// 記住上次的選擇：重新載入名單後自動帶回
await page.evaluate(() => { lineWhoSt.sel = []; lineWhoSt.loaded = false; localStorage.setItem('lineWho', JSON.stringify(['b'.repeat(16), 'zzzz'])); });   // 其中一個已不在名單
await page.click('#lineWhoRefresh');
await page.waitForFunction(() => document.querySelectorAll('#lineWhoPanel input').length === 3);
check(JSON.stringify(await whoChecked()) === JSON.stringify([T_B]) && !(await page.evaluate(() => document.getElementById('lineTestBtn').disabled)), '重新載入名單：自動帶回上次的選擇，已不在名單的人會被略過');
// 測試排程：收件人區搬到「發佈方式」下面，沒選人不能排
await page.evaluate(() => { lineWhoSt.sel = []; lineWhoStoreSel([]); const st = lineSt(); lineResetFlow(st); lineUpdateSteps(); });
await page.click('#linePrepBtn');
await page.waitForFunction(() => /傳送完成/.test(document.getElementById('linePrepMsg').textContent), null, { timeout: 60000 });
const tw17 = Date.now() + 2 * 3600e3;
await setWhen(ymd(tw17), hm(tw17)); await page.waitForTimeout(300);
await page.click('#lineTgtTest'); await page.waitForTimeout(400);
check(await page.evaluate(() => document.getElementById('lineWho').parentNode.closest('.s8-step').id === 'lineStep2') && await vis('#lineWho'), '測試排程：收件人選單在第 2 步「排程對象」下面');
check(await page.evaluate(() => document.getElementById('lineGoBtn').disabled), '沒選收件人：「測試排程」不能按');
await page.click('#lineWhoBtn'); await page.click(`#lineWhoPanel input[value="${T_A}"]`);
await page.screenshot({ path: path.join(SHOTS, 'line-ui-17d-who-tsched.png'), clip: { x: 0, y: (await page.locator('#lineTarget').boundingBox()).y - 10, width: 760, height: 330 } });
await page.click('#lineWhoNote');
await page.click('#lineGoBtn'); await page.click('#lineGoBtn');
{ const kb = await page.locator('#lineKnob').boundingBox(), sb = await page.locator('#lineSlider').boundingBox();
  await page.mouse.move(kb.x + kb.width / 2, kb.y + kb.height / 2); await page.mouse.down();
  await page.mouse.move(kb.x + sb.width + 40, kb.y + kb.height / 2, { steps: 12 }); await page.mouse.up(); }
await page.waitForFunction(() => /已排程到測試帳號/.test(document.getElementById('lineWin').textContent), null, { timeout: 10000 });
const tc17 = schedReqs.create.at(-1);
check(tc17.channel === 'test' && JSON.stringify(tc17.testers) === JSON.stringify([T_A]) && (await txt('#lineWin')).includes('收件人：王小明'), '建立測試排程：帶 testers=[王小明]，結果寫明收件人');
await page.waitForFunction(() => [...document.querySelectorAll('#lineSchedList .ttl')].some(t => t.textContent.includes('→ 給 王小明')));
await page.locator('#lineSched').screenshot({ path: path.join(SHOTS, 'line-ui-17e-sched-recipients.png') });
// 名單管理（折疊區）
await page.evaluate(() => { document.getElementById('lineBox').open = true; lineTesterListRender(); });
check((await page.$$eval('#lineTesterList .line-trow span', r => r.map(x => x.textContent).join())) === '王小明,李小華,陳小美', '折疊區「測試名單」列出所有登記的人');
await page.evaluate(() => { lineWhoSt.sel = ['a'.repeat(16), 'b'.repeat(16)]; lineWhoStoreSel(lineWhoSt.sel); });
await page.click('#lineTesterList .line-trow:first-child button');
await page.waitForFunction(() => document.querySelectorAll('#lineTesterList .line-trow').length === 2);
check(testerReqs.remove.at(-1).tid === T_A && JSON.stringify(await page.evaluate(() => JSON.parse(localStorage.getItem('lineWho')))) === JSON.stringify([T_B]), '移除王小明：送出移除，名單少一位；他若在你記住的選擇裡就一併拿掉');
await page.locator('#lineBox').screenshot({ path: path.join(SHOTS, 'line-ui-17f-tester-list.png') });
await page.click('#s8CloseBtn');

check(pageErrors.length === 0, `頁面沒有 JS 錯誤 ${pageErrors.join(' | ')}`);

await browser.close();
console.log(failed ? `\n${failed} 項失敗` : '\n全部通過');
process.exit(failed ? 1 : 0);
