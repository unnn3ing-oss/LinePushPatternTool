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
const bubbles = () => page.$$eval('#pushBubbles .push-bubble', bs => bs.map(b => b.querySelector('.pb-name').textContent + '｜' + b.querySelector('.pb-st').textContent));
const load = () => page.evaluate(() => hubListLoad('news'));
const eff = id => page.evaluate(id => pushEff(hubFor('news').records.find(r => r.id === id)), id);

// 1. 伺服器時鐘比本機快 2 分鐘：本機看起來還沒到的排程，其實已經在推播
const now = Date.now();
skewMs = 120000; records = [mk('a', now + 60000), mk('b', now + 15000 + 120000)];
await load();
check(await eff(records[0].id) === 'sending', '用 Worker 的時鐘判斷：本機還差 1 分鐘、Worker 已過時間 → 訊息推播中');
// 2. 不到 1 分鐘不能取消（Worker 會拒絕）
await page.click('#s8Link'); await page.waitForSelector('#hubListBox .hub-row');
await page.evaluate(id => hubOpenDetail(id), records[1].id);
check(await page.locator('#hubCancelSched').count() === 0, '距離發送不到 30 秒：不顯示「取消這筆排程」');
records = [mk('b2', now + 45000 + 120000)]; await load(); await page.evaluate(id => hubOpenDetail(id), records[0].id);
check(await page.locator('#hubCancelSched').count() === 1, '還有 45 秒：還可以取消（只有最後 30 秒不行）');
skewMs = 0; records = [mk('c', now + 10 * 60000)]; await load(); await page.evaluate(id => hubOpenDetail(id), records[0].id);
check(await page.locator('#hubCancelSched').count() === 1, '還有 10 分鐘：可以取消');

// 3. 改名輸入框不被背景自動更新洗掉
await page.click('#hubRenameBtn'); await page.fill('#hubRenameInp', '我正在輸入的新名稱');
await page.evaluate(() => { pushHubRefresh(); });
check(await page.inputValue('#hubRenameInp') === '我正在輸入的新名稱', '背景自動更新重畫後，正在輸入的新名稱還在');
check(await page.evaluate(() => document.activeElement && document.activeElement.id) === 'hubRenameInp', '輸入框的游標也還在');
await page.evaluate(() => { hubRenaming = false; hubCloseDetail(); });

// 4. 超過 3 分鐘還沒送出：顯示「逾時未發」
skewMs = 0; records = [mk('d', Date.now() - 3.5 * 60000)]; await load();
check(await eff(records[0].id) === 'missed', '已經過 3.5 分鐘還是排程中：顯示「逾時未發」');
records = [mk('e', Date.now() - 2.5 * 60000)]; await load();
check(await eff(records[0].id) === 'sending', '剛過 2.5 分鐘：還是訊息推播中');
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
await page.evaluate(() => { sessionStorage.setItem('labAuth', JSON.stringify({ token: 'lab-token', expiresAt: Date.now() + 3600e3 })); pushWatchPaused = false; });   // 上面的 401 會清掉憑證，重新放回去

// 7. 關掉試驗功能：泡泡與追蹤維持現狀，但不再查詢；重新打開就繼續
await page.evaluate(() => { pushBubble('x', 'X', 'failed'); pushWatch.set('z', { id: 'z', channel: 'news', name: 'z', runAt: Date.now() + 1e6, status: 'scheduled' }); setLab(false); });
await page.evaluate(() => pushWatchTick());
check(await page.evaluate(() => pushWatch.has('z') && !!document.querySelector('#pushBubbles .push-bubble')), '關掉試驗功能：泡泡與追蹤維持原樣');
await page.evaluate(() => { pushWatch.delete('z'); setLab(true); });
check(await page.evaluate(() => pushWatchPaused === false), '重新打開試驗功能：恢復查詢');

// 7b. 背景查詢逾時／失敗：彈泡泡通知，查到了就自動收起
await page.evaluate(() => { for (const k of [...pushBubbleEls.keys()]) pushBubbleClose(k); });
records = [mk('p', Date.now() - 10000)]; await load();
await page.evaluate(() => { window.__realFetch = window.fetch; window.fetch = () => Promise.reject(new TypeError('Failed to fetch')); });
await page.evaluate(() => pushWatchTick()); await page.waitForTimeout(400);
check((await bubbles()).join(',') === '推播狀態查詢｜查詢失敗，稍後自動重試', `查詢失敗：彈出通知（${(await bubbles()).join(',')}）`);
await page.evaluate(() => { window.fetch = (u, o) => { const e = new DOMException('aborted', 'AbortError'); return Promise.reject(e); }; });
await page.evaluate(() => pushWatchTick()); await page.waitForTimeout(400);
check((await bubbles()).join(',') === '推播狀態查詢｜查詢逾時，稍後自動重試', '查詢逾時：泡泡改成「查詢逾時」（同一顆更新）');
await page.evaluate(() => { window.fetch = window.__realFetch; });
await page.evaluate(() => pushWatchTick()); await page.waitForTimeout(800);
check((await bubbles()).filter(x => x.startsWith('推播狀態查詢')).length === 0, '查到之後：通知自動收起');

// 8. 位置：沒有彈窗時在「操作提示」左側（被底部工具列擠掉時靠右下角、壓到工具列就抬高）；有彈窗時蓋住操作提示（整個網頁最右下角）
await page.evaluate(() => { for (const k of [...pushBubbleEls.keys()]) pushBubbleClose(k); document.querySelectorAll('.modal-overlay.open').forEach(o => o.classList.remove('open')); pushBubble('a', '10/11新聞', 'sending'); pushBubble('b', '10/11新聞（測試）', 'sent'); });
const geo = async () => {
  await page.evaluate(() => { pushBubble('a', '10/11新聞', 'sending'); pushBubble('b', '10/11新聞（測試）', 'sent'); });   // 泡泡 5 秒就消失，每次量位置前重新彈出
  await page.waitForTimeout(900);
  return page.evaluate(() => {
  const bx = document.getElementById('pushBubbles').getBoundingClientRect(), tip = document.getElementById('tipToast'), fab = document.getElementById('tipFab'), col = tip.classList.contains('tip-collapsed'), el = col ? fab : tip;
  const hid = el.classList.contains('tip-yield'), t = el.getBoundingClientRect(), d = document.getElementById('dock').getBoundingClientRect();
  const kids = [...document.querySelectorAll('#pushBubbles .push-bubble')].map(e => e.getBoundingClientRect());
  const L = Math.min(...kids.map(k => k.left)), R = Math.max(...kids.map(k => k.right)), T = Math.min(...kids.map(k => k.top)), B = Math.max(...kids.map(k => k.bottom));
  return { bR: innerWidth - R, bB: innerHeight - B, hid, col, tipL: t.left, overlapDock: L < d.right && R > d.left && T < d.bottom && B > d.top, overlapTip: !hid && L < t.right && R > t.left && T < t.bottom && B > t.top };
  });
};
await page.setViewportSize({ width: 2400, height: 900 }); await page.evaluate(() => setTipCollapsed(false)); await page.waitForTimeout(900);
let g = await geo();
check(!g.col && !g.hid && !g.overlapTip && !g.overlapDock && Math.abs(g.bB - 20) < 3 && g.bR > 20 + 372, `寬螢幕、操作提示展開：泡泡在它左側，不壓到操作提示與工具列（距右 ${Math.round(g.bR)}px、距下 ${Math.round(g.bB)}px）`);
await page.evaluate(() => setTipCollapsed(true)); await page.waitForTimeout(900);
g = await geo();
check(g.col && !g.overlapTip && !g.overlapDock && Math.abs(g.bB - 20) < 3 && g.bR > 20 + 46 && g.bR < 20 + 46 + 40, `操作提示收成「!」：泡泡靠到它的左側（距右 ${Math.round(g.bR)}px）`);
for (const w of [1280, 900, 600, 390]) {
  await page.setViewportSize({ width: w, height: 800 }); await page.evaluate(() => setTipCollapsed(false)); await page.waitForTimeout(900);
  g = await geo();
  check(!g.overlapDock && !g.overlapTip, `寬 ${w}px（操作提示展開）：泡泡不壓到底部工具列、不壓到操作提示（距右 ${Math.round(g.bR)}px、距下 ${Math.round(g.bB)}px，操作提示${g.hid ? '被擠掉' : '顯示中'}）`);
}
await page.setViewportSize({ width: 1280, height: 800 });
await page.evaluate(() => { s8AltByMode[mode] = '測試推播標題'; openS8Dialog(); }); await page.waitForTimeout(900);
g = await geo();
check(Math.abs(g.bR - 20) < 3 && Math.abs(g.bB - 20) < 3, `有彈窗在用：泡泡移到網頁最右下角，蓋住操作提示（距右 ${Math.round(g.bR)}px、距下 ${Math.round(g.bB)}px）`);
const topOk = await page.evaluate(() => +getComputedStyle(document.getElementById('pushBubbles')).zIndex > Math.max(...[...document.querySelectorAll('.modal-overlay')].map(o => +getComputedStyle(o).zIndex || 0)));
check(topOk, '泡泡層級在彈窗之上');
await page.evaluate(() => { document.querySelectorAll('.modal-overlay.open').forEach(o => o.classList.remove('open')); }); await page.waitForTimeout(900);
g = await geo();
check(!g.overlapDock, '彈窗關掉：泡泡回到不壓工具列的位置');
check(pageErrors.length === 0, `頁面沒有 JS 錯誤 ${pageErrors.join('|')}`);
await browser.close();
console.log(failed ? `\n${failed} 項失敗` : '\n全部通過');
process.exit(failed ? 1 : 0);
