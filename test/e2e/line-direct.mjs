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
await page.route(`${WORKER}/**`, async route => {
  const url = new URL(route.request().url());
  const body = route.request().postDataJSON?.() || {};
  const json = (obj, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(obj) });
  if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' } });
  if (url.pathname === '/line/status') { reqs.status.push(body); return json({ ok: true, channel: body.channel, r2Ready: true, bot: { displayName: body.channel === 'test' ? '測試官方帳號' : 'TVBS新聞', basicId: '@abc' }, quota: { type: 'limited', value: 100000000 }, used: 17266349, followers: body.channel === 'test' ? null : { status: 'ready', followers, targetedReaches: followers - 5, blocks: 5 }, notes: [] }); }
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
    return json({ ok: true, channel: body.channel, official, sentAt: '2026-10-07T12:00:00+08:00', requestId: official ? '22222222-2222-4222-8222-222222222222' : '11111111-1111-4111-8111-111111111111', retryKey: body.retryKey, friends: official ? followers : 1, pages: 2, ...(official ? {} : { testToken: 'ttok' }) });
  }
  return json({ error: `unexpected ${url.pathname}` }, 404);
});

await page.addInitScript(() => { sessionStorage.setItem('labAuth', JSON.stringify({ token: 'lab-token', expiresAt: Date.now() + 3600e3 })); });
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
check((await txt('#lineHStepper')).replace(/\s/g, '').startsWith('1傳送資料') && await page.evaluate(() => document.querySelectorAll('#lineHStepper .s8-hs').length === 4), '水平步驟列共 4 步：傳送資料／發佈方式／測試推播／正式推播（目前只顯示第 1 步名稱）');
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

// ===== 4. 步驟 ② 立即推播／排程推播 =====
check(await vis('#lineStep2') && (await txt('#linePickNow')) === '立即推播' && (await txt('#linePickSched')) === '排程推播', '第 2 步：選擇發佈方式「立即推播」「排程推播」');
check((await bgOf('linePickNow')) === 'rgb(255, 255, 255)' && (await bgOf('linePickSched')) === 'rgb(255, 255, 255)', '兩顆預設都是白色');
const gapPair = await page.evaluate(() => { const a = document.getElementById('linePickNow').getBoundingClientRect(), b = document.getElementById('linePickSched').getBoundingClientRect(); return b.left - a.right; });
check(Math.abs(gapPair - 14) < 0.6, `兩顆中間間距跟 S8 的「存成草稿／設定排程」一樣（${gapPair.toFixed(1)}px）`);
await page.hover('#linePickSched'); await page.waitForTimeout(450);
check((await txt('#uiTip')).includes('沒有排程功能'), '排程推播：LINE 沒有排程功能，游標移上去說明原因');
await page.locator('#linePanel').screenshot({ path: path.join(SHOTS, 'line-ui-2c-step2.png') });
await page.click('#linePickSched', { force: true });
check(!(await vis('#lineStep3')), '點「排程推播」不會往下（目前不支援）');
await page.click('#linePickNow');
await page.waitForTimeout(380);
check((await page.evaluate(() => getComputedStyle(document.querySelector('#lineSeg2 .s8-knob')).backgroundColor)) === BLUE && await vis('#lineStep3'), '選「立即推播」：旋鈕變藍色並出現第 3 步');
check(await page.evaluate(() => document.getElementById('lineStep1').classList.contains('old') && !document.getElementById('lineStep2').classList.contains('old')), '只留剛完成（發佈方式）與目前這步，再前一步（傳送資料）收起');

// ===== 5. 步驟 ③ 測試推播 → 測試完成 =====
check((await txt('#lineTestBtn')) === '推播測試帳號' && await page.isHidden('#lineDoneTrack'), '第 3 步預設推播給「測試帳號」，還沒推播前沒有「測試完成」');
await page.evaluate(() => { window.__t = 0; });
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
await page.locator('#linePanel').screenshot({ path: path.join(SHOTS, 'line-ui-3-step4.png') });

// ===== 6. 步驟 ④ 正式推播：綠 → 黃 → 滑動開關 =====
const go = id => page.evaluate(i => document.getElementById(i).textContent, id);
check((await go('lineGoBtn')) === '正式推播' && (await bgOf('lineGoBtn')) === GREEN, '「正式推播」是綠色');
check(reqs.send.length === 1, '到這裡正式帳號還沒推播任何東西');
await page.click('#lineGoBtn');
check((await go('lineGoBtn')) === '確定推播？' && (await bgOf('lineGoBtn')) === YELLOW, '按下後同一個按鈕變成黃色「確定推播？」');
check(reqs.send.length === 1, '黃色確認階段仍然沒有推播');
await page.click('#lineGoBtn');
check(await vis('#lineSlider') && !(await vis('#lineGoBtn')), '再按一次：同位置變成圓框滑動開關');
const geo = await page.evaluate(() => { const s = document.getElementById('lineSlider').getBoundingClientRect(), t = document.getElementById('linePrepTrack').getBoundingClientRect(), k = document.getElementById('lineKnob').getBoundingClientRect(); return { sw: s.width, sh: s.height, tw: getComputedStyle(document.getElementById('lineSteps')).getPropertyValue('--s8-ctl-w'), kr: getComputedStyle(document.getElementById('lineKnob')).borderRadius, kw: k.width, kh: k.height, kleft: k.left - s.left, radius: getComputedStyle(document.getElementById('lineSlider')).borderRadius }; });
check(Math.abs(geo.sh - 46) < 1 && geo.kw === geo.kh && geo.kleft < 8 && parseFloat(geo.radius) >= 20, `滑動開關：圓框高 ${geo.sh}px（與其他步驟同高），白色圓鈕在最左側`);
await page.locator('#linePanel').screenshot({ path: path.join(SHOTS, 'line-ui-4-slider.png') });
// 滑到一半放開：彈回，不推播
const kb = await page.locator('#lineKnob').boundingBox(), sb = await page.locator('#lineSlider').boundingBox();
await page.mouse.move(kb.x + kb.width / 2, kb.y + kb.height / 2); await page.mouse.down();
await page.mouse.move(kb.x + sb.width * 0.5, kb.y + kb.height / 2, { steps: 8 });
const half = await page.evaluate(() => document.getElementById('lineKnob').style.transform);
await page.mouse.up(); await page.waitForTimeout(450);
const back = await page.evaluate(() => document.getElementById('lineKnob').style.transform);
check(/translateX\((?!0px)/.test(half) && /translateX\(0px\)/.test(back) && reqs.send.length === 1, '滑到一半放開會彈回左側，不會推播');
// 滑到最右側：推播
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
check(off.channel === 'news' && off.testToken === 'ttok' && off.confirmTotal === 287091 && /^[0-9a-f-]{36}$/.test(off.retryKey) && off.retryKey !== reqs.send[0].retryKey, '正式推播：channel=news、帶 testToken、好友數來自 LINE（287,091）、另一組 retryKey');
check(reqs.status.some(s => s.channel === 'news'), '推播前先向 LINE 查正式帳號好友數與額度');
check((await txt('#lineWin')).includes('287,091') && await page.evaluate(() => document.getElementById('lineWin').classList.contains('ok')), '下方狀態窗（綠色）回報推播成功、時間、人數、request id');
check((await go('lineGoBtn')) === '已正式推播' && (await bgOf('lineGoBtn')) === GREEN && await page.isDisabled('#lineGoBtn'), '完成後按鈕顯示「已正式推播」，不能重複推播');
await page.locator('#linePanel').screenshot({ path: path.join(SHOTS, 'line-ui-5-done.png') });

// ===== 7. 發送紀錄與點擊次數（折疊區）=====
await page.evaluate(() => { document.getElementById('lineBox').open = true; });
const hist = await page.evaluate(() => JSON.parse(localStorage.getItem('lineSends')));
check(hist.length === 2 && hist[0].channel === 'news' && hist[1].channel === 'test' && hist[0].links.length === 12, '測試與正式推播都記下 request id 與每格連結');
await page.click('#lineClicksBtn');
await page.waitForSelector('#lineClicksOut table');
const rows = await page.$$eval('#lineClicksOut table tr', trs => trs.map(tr => [...tr.children].map(c => c.textContent)));
check(reqs.clicks[0].requestId === '22222222-2222-4222-8222-222222222222' && rows[1][2] === '1,234' && rows[2][2] === '—' && rows.some(r => r[0] === '（其他連結）'), '查詢點擊次數：每個連結一列、不足 20 顯示「—」、其他連結另列');

// ===== 8. 推播失敗 → 下方狀態窗（黃）=====
await page.evaluate(() => { const st = lineSt(); lineResetFlow(st); lineUpdateSteps(); });
await page.click('#linePrepBtn');
await page.waitForFunction(() => /傳送完成/.test(document.getElementById('linePrepMsg').textContent), null, { timeout: 60000 });
await page.click('#linePickNow');
sendFail = 'LINE 回應 429：You have reached your monthly limit。請到 LINE 官方帳號後台確認有沒有發出去。';
await page.click('#lineTestBtn');
await page.waitForFunction(() => /已推播到測試帳號/.test(document.getElementById('lineTestMsg').textContent));
await page.click('#lineDoneBtn');
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

// ===== 9. 切到 S8 分頁 =====
await page.click('#s8ModeS8');
check(await vis('#s8Panel') && !(await vis('#linePanel')) && await vis('#s8Name') && await vis('#s8Account'), '切到「S8推播」：顯示原本的 S8 步驟與欄位（名稱、組織、對象）');
await page.locator('#s8Modal').screenshot({ path: path.join(SHOTS, 'line-ui-7-s8-tab.png') });
check(pageErrors.length === 0, `頁面沒有 JS 錯誤 ${pageErrors.join(' | ')}`);

await browser.close();
console.log(failed ? `\n${failed} 項失敗` : '\n全部通過');
process.exit(failed ? 1 : 0);
