// 前端驗證：排程訊息到時間先變「訊息推播中」、約每 10 秒刷新到「已發送」；右下角狀態泡泡（訊息名稱＋狀態，外框跟底部工具列相同，蓋在最上層）
// （Playwright，Worker 全部用假回應攔截，不會連到真的 LINE；因為要等 10 秒的輪詢，整支約 30 秒）
// 執行：python3 -m http.server 8960 &  然後  NODE_PATH=$(npm root -g) node test/e2e/push-status.mjs
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

const NOW = Date.now();
const iso = ms => new Date(ms + 8 * 3600e3).toISOString().slice(0, 19) + '+08:00';
const SCHED = { kind: 'sched', test: false, pageCount: 2, friends: null, delivered: null, statAt: '', id: 's'.repeat(24), channel: 'news', org: 'news', name: '10/11新聞', altText: '★明早新聞', runAt: NOW + 4000, runAtIso: iso(NOW + 4000), status: 'scheduled', attempts: 0, lastError: '', requestId: '', sentAt: '', approvedFriends: 287000, recipientNames: [], links: [], createdAt: NOW };
const FUTURE = { ...SCHED, id: 'f'.repeat(24), name: '10/12新聞', runAt: NOW + 3 * 3600e3, runAtIso: iso(NOW + 3 * 3600e3) };
const db = { news: [SCHED, FUTURE], ent: [], test: [] };
let listCalls = 0;
await page.route(`${WORKER}/**`, async route => {
  const url = new URL(route.request().url());
  const json = (obj, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(obj) });
  if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' } });
  if (url.pathname === '/line/history/list') { listCalls++; return json({ ok: true, records: db[JSON.parse(route.request().postData() || '{}').channel] || [], heartbeatAt: Date.now(), serverNow: Date.now() }); }
  return json({ error: `unexpected ${url.pathname}` }, 404);
});
await page.addInitScript(() => { sessionStorage.setItem('labAuth', JSON.stringify({ token: 'lab-token', expiresAt: Date.now() + 3600e3 })); });
await page.goto(`${BASE}?imageProxy=${encodeURIComponent(WORKER)}`);
await page.evaluate(() => { setLab(true); });
const chips = () => page.$$eval('#hubListBox .hub-row', rs => rs.map(r => [r.querySelector('.nm').textContent, r.children[1].textContent]));
const bubbles = () => page.$$eval('#pushBubbles .push-bubble', bs => bs.map(b => b.querySelector('.pb-name').textContent + '｜' + b.querySelector('.pb-st').textContent));

await page.click('#s8Link');
await page.waitForFunction(() => document.querySelectorAll('#hubListBox .hub-row').length === 2);
let c = await chips();
check(c.find(x => x[0] === '10/11新聞')[1] === '排程' && c.find(x => x[0] === '10/12新聞')[1] === '排程', '還沒到時間：兩筆都是「排程」');
check((await bubbles()).length === 0, '只是打開列表：不彈泡泡（狀態沒變）');
let before = listCalls;

// 時間到：先換成「訊息推播中」（不用等網路）
await page.waitForFunction(() => [...document.querySelectorAll('#hubListBox .hub-row')].some(r => r.children[1].textContent === '訊息推播中'), null, { timeout: 12000 });
c = await chips();
check(c.find(x => x[0] === '10/11新聞')[1] === '訊息推播中' && c.find(x => x[0] === '10/12新聞')[1] === '排程', '排程時間一到：該筆先顯示「訊息推播中」，其他排程不受影響');
check(listCalls - before <= 1, `換成「訊息推播中」是本機判斷（到點最多查一次 Worker，實際 ${listCalls - before} 次）`);
check((await bubbles()).join(',') === '10/11新聞｜訊息推播中', `右下角泡泡：「訊息名稱｜訊息狀態」→ ${(await bubbles()).join(',')}`);
await page.waitForTimeout(500);   // 等彈出動畫跑完
const st = await page.evaluate(() => {
  const b = document.querySelector('#pushBubbles .push-bubble'), d = document.querySelector('.dock'), cs = getComputedStyle(b), ds = getComputedStyle(d), r = b.getBoundingClientRect();
  return { pos: getComputedStyle(document.getElementById('pushBubbles')).position, z: +getComputedStyle(document.getElementById('pushBubbles')).zIndex, bg: cs.backgroundColor, dbg: ds.backgroundColor, rad: cs.borderRadius, drad: ds.borderRadius, sh: cs.boxShadow, dsh: ds.boxShadow, pad: cs.padding, dpad: ds.padding, right: innerWidth - r.right, bottom: innerHeight - r.bottom, maxZ: Math.max(...[...document.querySelectorAll('body *')].map(e => +getComputedStyle(e).zIndex || 0).filter(n => n < 600)) };
});
check(st.pos === 'fixed' && st.z > st.maxZ, `泡泡固定在視窗上、層級 ${st.z} 高於其他所有元素（${st.maxZ}）`);
check(st.bg === st.dbg && st.rad === st.drad && st.sh === st.dsh && st.pad === st.dpad, `外框跟底部工具列相同：底色 ${st.bg}、圓角 ${st.rad}、陰影、內距`);
check(st.right < 40 && st.bottom < 40, `在網頁最右下角、蓋住操作提示（距右 ${Math.round(st.right)}px、距下 ${Math.round(st.bottom)}px）`);
const spin = await page.evaluate(() => getComputedStyle(document.querySelector('#pushBubbles .pb-spin')).display);
check(spin !== 'none', '「訊息推播中」帶轉圈圈');

// Worker 這時已經發出去：下一輪查詢（約 10 秒）就變「已發送」
SCHED.status = 'sent'; SCHED.sentAt = iso(Date.now());
const t0 = Date.now();
await page.waitForFunction(() => [...document.querySelectorAll('#hubListBox .hub-row')].some(r => r.children[1].textContent === '已發送'), null, { timeout: 15000 });
const dt = Date.now() - t0;
check(listCalls > before, `約每 10 秒向 Worker 查一次發送狀態（${(dt / 1000).toFixed(1)} 秒後刷新）`);
check(dt < 12500, '刷新間隔約 10 秒');
check((await bubbles()).join(',') === '10/11新聞｜已發送', '泡泡更新為「10/11新聞｜已發送」（同一顆更新，不重複彈）');
const callsAtSent = listCalls;
await page.waitForTimeout(11000);
check(listCalls === callsAtSent, '已發送之後不再輪詢（剩下的排程還沒到時間）');
check((await bubbles()).length === 0, '已發送的泡泡約 8 秒後自動收起');

// 失敗要留著、可以手動關
const FAIL = { ...SCHED, id: 'x'.repeat(24), name: '10/13新聞', status: 'failed', lastError: 'x' };
await page.evaluate(() => pushBubble('t', '10/13新聞', 'failed'));
await page.waitForTimeout(9000);
check((await bubbles()).join(',') === '10/13新聞｜發送失敗', '發送失敗的泡泡不會自己消失');
await page.click('#pushBubbles .pb-x');
await page.waitForTimeout(500);
check((await bubbles()).length === 0, '按 × 可以關掉');
void FAIL;

check(pageErrors.length === 0, `頁面沒有 JS 錯誤${pageErrors.length ? '：' + pageErrors.join(' | ') : ''}`);
await browser.close();
console.log(failed ? `\n${failed} 項失敗` : '\n全部通過');
process.exit(failed ? 1 : 0);
