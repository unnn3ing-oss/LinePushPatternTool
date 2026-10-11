// 前端驗證：推播狀態輪詢與泡泡的邊界情況——背景查詢不跳登入視窗、憑證過期就停、登出清乾淨、
// 用 Worker 的時鐘判斷「推播中」、Cron 沒在跑／逾時不再說「推播中」、不到 1 分鐘不能取消、改名輸入框不被自動更新洗掉、泡泡不蓋住精靈按鈕
// （Playwright，Worker 全部用假回應攔截）
// 執行：python3 -m http.server 8960 &  然後  NODE_PATH=$(npm root -g) node test/e2e/push-status-edge.mjs
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:8960/index.html';
const WORKER = 'https://worker.test';
let failed = 0;
const check = (cond, label) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) failed++; };
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const pageErrors = []; page.on('pageerror', e => pageErrors.push(e.message));

const iso = ms => new Date(ms + 8 * 3600e3).toISOString().slice(0, 19) + '+08:00';
const mk = (id, runAt, extra = {}) => ({ kind: 'sched', test: false, pageCount: 2, friends: null, delivered: null, statAt: '', id: id.repeat(24).slice(0, 24), channel: 'news', org: 'news', name: `名稱${id}`, altText: `標題${id}`, runAt, runAtIso: iso(runAt), status: 'scheduled', attempts: 0, lastError: '', requestId: '', sentAt: '', approvedFriends: null, recipientNames: [], links: [], createdAt: runAt - 3600e3, ...extra });
let skewMs = 0, heartbeatAgo = 0, mode401 = false, records = [];
await page.route(`${WORKER}/**`, async route => {
  const url = new URL(route.request().url());
  const json = (obj, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(obj) });
  if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' } });
  if (url.pathname === '/line/history/list') {
    if (mode401) return json({ error: '試驗功能憑證無效或已過期' }, 401);
    return json({ ok: true, records, heartbeatAt: Date.now() + skewMs - heartbeatAgo, serverNow: Date.now() + skewMs });
  }
  return json({ error: `unexpected ${url.pathname}` }, 404);
});
await page.addInitScript(() => { sessionStorage.setItem('labAuth', JSON.stringify({ token: 'lab-token', expiresAt: Date.now() + 3600e3 })); });
await page.goto(`${BASE}?imageProxy=${encodeURIComponent(WORKER)}`);
await page.evaluate(() => { setLab(true); });
const load = () => page.evaluate(() => hubListLoad('news'));
const eff = id => page.evaluate(id => pushEff(hubFor('news').records.find(r => r.id === id)), id);

// 1. 伺服器時鐘比本機快 2 分鐘：本機看起來還沒到的排程，其實已經在推播
const now = Date.now();
skewMs = 120000; records = [mk('a', now + 60000), mk('b', now + 30000 + 120000)];
await load();
check(await eff(records[0].id) === 'sending', '用 Worker 的時鐘判斷：本機還差 1 分鐘、Worker 已過時間 → 訊息推播中');
// 2. 不到 1 分鐘不能取消（Worker 會拒絕）
await page.click('#s8Link'); await page.waitForSelector('#hubListBox .hub-row');
await page.evaluate(id => hubOpenDetail(id), records[1].id);
check(await page.locator('#hubCancelSched').count() === 0, '距離發送不到 1 分鐘：不顯示「取消這筆排程」');
skewMs = 0; records = [mk('c', now + 10 * 60000)]; await load(); await page.evaluate(id => hubOpenDetail(id), records[0].id);
check(await page.locator('#hubCancelSched').count() === 1, '還有 10 分鐘：可以取消');

// 3. 改名輸入框不被背景自動更新洗掉
await page.click('#hubRenameBtn'); await page.fill('#hubRenameInp', '我正在輸入的新名稱');
await page.evaluate(() => { pushHubRefresh(); });
check(await page.inputValue('#hubRenameInp') === '我正在輸入的新名稱', '背景自動更新重畫後，正在輸入的新名稱還在');
check(await page.evaluate(() => document.activeElement && document.activeElement.id) === 'hubRenameInp', '輸入框的游標也還在');
await page.evaluate(() => { hubRenaming = false; hubCloseDetail(); });

// 4. Cron 沒在跑：不要一直說「推播中」
skewMs = 0; heartbeatAgo = 10 * 60000; records = [mk('d', Date.now() - 5 * 60000)]; await load();
check(await eff(records[0].id) === 'missed', 'Cron 心跳中斷、已經過 5 分鐘：顯示「逾時未發」，不說推播中');
heartbeatAgo = 0; records = [mk('e', Date.now() - 2 * 60000)]; await load();
check(await eff(records[0].id) === 'sending', 'Cron 正常、剛過 2 分鐘：訊息推播中');
records = [mk('f', Date.now() - 36 * 60000)]; await load();
check(await eff(records[0].id) === 'missed', '超過 35 分鐘還是排程中：視為逾時未發');
await page.evaluate(() => hubCloseDetail());

// 5. 列表上消失（被刪除）的排程：追蹤和泡泡一起收掉
records = [mk('g', Date.now() - 10000)]; await load();
check(await page.evaluate(() => pushWatch.size) === 1, '列表上的排程已到時間：開始追蹤');
await page.evaluate(() => { pushBubble('rec:' + [...pushWatch.keys()][0], '名稱g', 'sending'); });
records = []; await load(); await page.waitForTimeout(600);
check(await page.evaluate(() => pushWatch.size === 0 && !document.querySelector('#pushBubbles .push-bubble')), '從列表消失：追蹤停止、泡泡收掉');

// 6. 背景查詢遇到憑證失效：不跳登入視窗、不關試驗功能，只是暫停
records = [mk('h', Date.now() - 10000)]; await load();
mode401 = true;
const r6 = await page.evaluate(async () => { try { await s8Api('/line/history/list', { channel: 'news' }, {}, false, true); return 'ok'; } catch (e) { return e.code || e.message; } });
check(r6 === 'auth', `s8Api silent：401 丟 code=auth（${r6}）`);
check(!(await page.evaluate(() => document.getElementById('labOverlay').classList.contains('open'))) && await page.evaluate(() => labOn), '不彈登入視窗、試驗功能維持開啟');
await page.evaluate(() => { sessionStorage.setItem('labAuth', JSON.stringify({ token: 'lab-token', expiresAt: Date.now() + 3600e3 })); });
await page.evaluate(() => pushWatchTick());
check(await page.evaluate(() => pushWatchPaused === true && !document.getElementById('labOverlay').classList.contains('open')), '輪詢遇到 401：暫停，不跳視窗');
mode401 = false;

// 7. 關掉試驗功能：追蹤、泡泡、計時器全清
await page.evaluate(() => { pushBubble('x', 'X', 'failed'); pushWatch.set('z', { id: 'z', channel: 'news', name: 'z', runAt: Date.now() + 1e6, status: 'scheduled' }); setLab(false); });
await page.waitForTimeout(500);
check(await page.evaluate(() => pushWatch.size === 0 && pushWatchTimer === 0 && !document.querySelector('#pushBubbles .push-bubble')), '關掉試驗功能：追蹤、計時器、泡泡全部清掉');
await page.evaluate(() => { sessionStorage.setItem('labAuth', JSON.stringify({ token: 'lab-token', expiresAt: Date.now() + 3600e3 })); setLab(true); });

// 8. 窄視窗：泡泡不蓋住精靈右下角的按鈕
await page.evaluate(() => { s8AltByMode[mode] = '測試推播標題'; openS8Dialog(); });
await page.waitForFunction(() => document.querySelectorAll('#s8Stage .s8-cell').length === 6 && s8State.images.length === 2 && s8State.images.every(Boolean), null, { timeout: 60000 }).catch(() => {});
await page.evaluate(() => { for (const k of [...pushBubbleEls.keys()]) pushBubbleClose(k); pushBubble('a', '10/11新聞', 'sending'); pushBubble('b', '10/11新聞（測試）', 'failed', '未確認，請至後台確認'); });
await page.waitForTimeout(600);
for (const w of [1280, 900, 700, 520, 390]) {
  await page.setViewportSize({ width: w, height: 800 }); await page.waitForTimeout(250);
  const o = await page.evaluate(() => {
    const btn = document.getElementById('lineNextBtn'); if (!btn || btn.offsetParent === null) return null;
    const b = btn.getBoundingClientRect(); const hit = [...document.querySelectorAll('#pushBubbles .push-bubble')].filter(e => { const r = e.getBoundingClientRect(); return r.left < b.right && r.right > b.left && r.top < b.bottom && r.bottom > b.top; }).length;
    return { hit, btn: [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)], vw: innerWidth, vh: innerHeight };
  });
  if (!o) { check(true, `寬 ${w}px：精靈未開，略過`); continue; }
  check(o.hit === 0, `寬 ${w}px：泡泡沒有蓋住「下一步」按鈕 ${JSON.stringify(o.btn)}`);
}
check(pageErrors.length === 0, `頁面沒有 JS 錯誤 ${pageErrors.join('|')}`);
await browser.close();
console.log(failed ? `\n${failed} 項失敗` : '\n全部通過');
process.exit(failed ? 1 : 0);
