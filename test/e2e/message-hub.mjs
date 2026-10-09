// 前端驗證：右上角「訊息推播」視窗——推播列表／LINE推播設定／S8連結設定（Playwright，Worker 全部用假回應攔截，不會連到真的 LINE）
// 執行：
//   python3 -m http.server 8960 &            # 在專案根目錄
//   NODE_PATH=$(npm root -g) node test/e2e/message-hub.mjs
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

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await browser.newContext({ viewport: { width: 1100, height: 1300 } });
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));
const dialogs = [];
page.on('dialog', async d => { dialogs.push(d.message()); await d.accept(); });

// ---- 假 Worker ----
const NOW = Date.now();
const iso = ms => new Date(ms + 8 * 3600e3).toISOString().slice(0, 19) + '+08:00';
const LINKS = [{ page: 1, label: '左上', title: '★蔣萬安專訪', url: 'https://example.com/a?utm_source=x' }, { page: 1, label: '中上', title: '★颱風動態', url: 'https://example.com/b?utm_source=x' }, { page: 2, label: '右下', title: '★賽事結果', url: 'https://example.com/c' }];
const rec = (o) => ({ kind: 'now', test: false, pageCount: 2, friends: null, delivered: null, statAt: '', id: '', channel: 'news', org: 'news', name: '', altText: '', runAt: 0, runAtIso: '', status: 'sent', attempts: 1, lastError: '', requestId: '', sentAt: '', approvedFriends: null, recipientNames: [], links: LINKS, createdAt: 0, ...o });
const A = rec({ id: 'a'.repeat(24), name: '10/09新聞', altText: '★今晚重點新聞', runAt: NOW - 3600e3, runAtIso: iso(NOW - 3600e3), sentAt: iso(NOW - 3600e3), friends: 287091, requestId: '22222222-2222-4222-8222-222222222222' });
const B = rec({ id: 'b'.repeat(24), kind: 'sched', name: '10/10新聞', altText: '★明早新聞', status: 'scheduled', runAt: NOW + 7200e3, runAtIso: iso(NOW + 7200e3), approvedFriends: 287000, sentAt: '' });
const C = rec({ id: 'c'.repeat(24), kind: 'sched', name: '10/09晚間', altText: '★晚間', status: 'sending', runAt: NOW - 30e3, runAtIso: iso(NOW - 30e3), approvedFriends: 287000 });
const D = rec({ id: 'd'.repeat(24), name: '10/08新聞', test: true, altText: '★測試稿', runAt: NOW - 86400e3, runAtIso: iso(NOW - 86400e3), sentAt: iso(NOW - 86400e3), friends: 1, recipientNames: ['小編本人'], requestId: '33333333-3333-4333-8333-333333333333' });
const E = rec({ id: 'e'.repeat(24), kind: 'sched', name: '10/07新聞', altText: '★失敗稿', status: 'failed', runAt: NOW - 2 * 86400e3, runAtIso: iso(NOW - 2 * 86400e3), lastError: '發送當下好友數差太多', links: [] });
const ENT = rec({ id: '9'.repeat(24), channel: 'ent', org: 'ent', name: '10/09娛樂', altText: '★娛樂', runAt: NOW - 7200e3, runAtIso: iso(NOW - 7200e3), sentAt: iso(NOW - 7200e3), friends: 50000, requestId: '44444444-4444-4444-8444-444444444444' });
const db = { news: [A, B, C, D, E], ent: [ENT], test: [] };
const reqs = { list: [], stats: [], rename: [], cancel: [], status: [], testers: [], lookup: [], add: [], remove: [] };
let heartbeat = NOW, statsMode = 'ok', statsFail = '';
const testersDb = { news: [{ tid: '1'.repeat(16), name: '小編本人', userId: 'U8f0fba4524410d1cbc7c95ce37d96b80', registeredAt: 1 }], ent: [], test: [{ tid: 'a'.repeat(16), name: '王小明', userId: 'U' + 'a'.repeat(32), registeredAt: 1 }] };
const UID2 = 'U' + 'd'.repeat(32);
const labAuthReqs = [];
const findRec = id => Object.values(db).flat().find(r => r.id === id);
await page.route(`${WORKER}/**`, async route => {
  const url = new URL(route.request().url());
  const body = route.request().postDataJSON?.() || {};
  const json = (obj, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(obj) });
  if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' } });
  if (url.pathname === '/lab-auth') { labAuthReqs.push(body); return body.password === 'pw' ? json({ token: 'lab-token-2', expiresAt: Date.now() + 3600e3 }) : json({ error: '密碼不正確' }, 401); }
  if (url.pathname === '/line/history/list') { reqs.list.push(body); return json({ ok: true, channel: body.channel, records: db[body.channel], heartbeatAt: heartbeat, serverNow: Date.now() }); }
  if (url.pathname === '/line/history/stats') {
    reqs.stats.push(body);
    if (statsFail) return json({ error: statsFail }, 502);
    const r = findRec(body.id);
    if (statsMode === 'none' || r.test) return json({ ok: true, record: r, stats: r.stat || null, fresh: false, unavailable: true, message: 'LINE 目前沒有這次發送的統計（LINE 回應 404）。只有認證帳號有，且只保留發送後約 14 天。' });
    r.delivered = 280000; r.statAt = iso(Date.now()); r.stat = { at: iso(Date.now()), overview: { delivered: 280000, uniqueImpression: 90000, uniqueClick: 41000 }, messages: [{ seq: 1, impression: 80000 }], clicks: [{ seq: 1, url: LINKS[0].url, click: 1234, uniqueClick: 1000 }, { seq: 1, url: LINKS[1].url, click: null, uniqueClick: null }, { seq: 2, url: 'https://elsewhere.example/z', click: 25, uniqueClick: 22 }] };
    return json({ ok: true, record: r, stats: r.stat, fresh: true });
  }
  if (url.pathname === '/line/history/rename') { reqs.rename.push(body); const r = findRec(body.id); r.name = body.name; return json({ ok: true, record: r }); }
  if (url.pathname === '/line/schedule/cancel') { reqs.cancel.push(body); const r = findRec(body.id); r.status = 'cancelled'; return json({ ok: true, schedule: r }); }
  if (url.pathname === '/line/schedule/list') return json({ ok: true, schedules: [], heartbeatAt: heartbeat, serverNow: Date.now(), officialAllowed: true });
  if (url.pathname === '/line/status') {
    reqs.status.push(body);
    if (body.channel === 'ent') return json({ error: 'Worker 尚未設定 TVBS娛樂頭條 的 LINE 憑證' }, 503);
    return json({ ok: true, channel: body.channel, r2Ready: true, heartbeatAt: heartbeat, serverNow: Date.now(), officialAllowed: false, bot: { displayName: body.channel === 'test' ? '測試官方帳號' : 'TVBS新聞', basicId: '@abc' }, quota: body.channel === 'test' ? { type: 'limited', value: 200 } : { type: 'none' }, used: body.channel === 'test' ? 36 : 17266349, followers: body.channel === 'test' ? null : { status: 'ready', followers: 287091 }, notes: [] });
  }
  if (url.pathname === '/line/testers/list') { reqs.testers.push(body); return json({ ok: true, channel: body.channel, testers: testersDb[body.channel], maxPerSend: 2 }); }
  if (url.pathname === '/line/testers/remove') { reqs.remove.push(body); testersDb[body.channel] = testersDb[body.channel].filter(t => t.tid !== body.tid); return json({ ok: true, testers: testersDb[body.channel], maxPerSend: 2 }); }
  if (url.pathname === '/line/testers/lookup' || url.pathname === '/line/testers/add') {
    const add = url.pathname.endsWith('add'); (add ? reqs.add : reqs.lookup).push(body);
    const name = (body.name || '').trim() || 'LINE暱稱小美';
    if (add) testersDb[body.channel].push({ tid: '2'.repeat(16), name, userId: body.userId, registeredAt: 5 });
    return json({ ok: true, channel: body.channel, found: { tid: '2'.repeat(16), name, lineName: 'LINE暱稱小美', already: false }, testers: testersDb[body.channel], maxPerSend: 2 });
  }
  return json({ error: `unexpected ${url.pathname}` }, 404);
});
await page.addInitScript(() => { sessionStorage.setItem('labAuth', JSON.stringify({ token: 'lab-token', expiresAt: Date.now() + 3600e3 })); window.__opened = []; window.open = (u) => { window.__opened.push(u); return {}; }; });
await page.goto(`${BASE}?imageProxy=${encodeURIComponent(WORKER)}`);
await page.evaluate(() => { setLab(true); });
const txt = id => page.textContent(id);
const vis = async sel => !(await page.locator(sel).isHidden());
const rowsOf = () => page.$$eval('#hubListBox .hub-row', rs => rs.map(r => ({ name: r.querySelector('.nm').textContent, when: r.querySelector('.c1, div .sub') ? r.children[0].querySelector('.sub').textContent : '', status: r.children[1].textContent, people: r.children[2].textContent })));

// ===== 1. 按鈕與視窗 =====
check((await txt('#s8Link')) === '訊息推播', '右上角按鈕叫「訊息推播」');
await page.click('#s8Link');
check(await page.evaluate(() => document.getElementById('s8Overlay').classList.contains('open') && document.getElementById('s8Modal').dataset.view === 'hub'), '點「訊息推播」：開啟跟「排入LINE推播」同一個彈窗，進入訊息推播檢視');
check((await page.$$eval('#hubTabs .s8-ptab', b => b.map(x => x.textContent).join('｜'))) === '推播列表｜LINE推播設定｜S8連結設定', '頂部三個分頁：推播列表｜LINE推播設定｜S8連結設定');
check(!(await vis('#s8Modetabs')) && !(await vis('#composeBody')) && await vis('#hubBody'), '看不到「LINE原生推播／S8推播」切換與編輯表單');
check((await page.$$eval('#hubAcct .line-tbtn', b => b.map(x => x.textContent).join('｜'))) === 'TVBS新聞｜TVBS娛樂頭條｜測試帳號' && (await page.textContent('#hubAcct .on')) === 'TVBS新聞', '帳號切換：TVBS新聞｜TVBS娛樂頭條｜測試帳號（預設跟目前版型）');

// ===== 2. 推播列表 =====
await page.waitForFunction(() => document.querySelectorAll('#hubListBox .hub-row').length === 5);
check(reqs.list.at(-1).channel === 'news', '向 Worker 要 TVBS新聞 的推播列表');
let rows = await rowsOf();
check(rows.map(r => r.name).join('｜') === '10/09新聞｜10/10新聞｜10/09晚間｜10/08新聞測試｜10/07新聞', `每列的訊息命名：${rows.map(r => r.name).join('｜')}`);
check(rows[0].when.startsWith('發送 ') && rows[1].when.startsWith('排程 ') && /^排程 \d\d\/\d\d \d\d:\d\d$/.test(rows[1].when), `命名下方寫發送時間／排程時間：${rows[0].when}、${rows[1].when}`);
check(rows.map(r => r.status).join('｜') === '已發送｜排程｜發送中｜已發送｜發送失敗', `發送狀態：${rows.map(r => r.status).join('｜')}`);
rows = await rowsOf();
await page.waitForTimeout(400);
check(reqs.stats.length === 0, '打開列表不會向 LINE 查統計（列表的人數不用它，省 LINE 的查詢額度）');
check(rows[0].people.includes('約 287,091 人') && rows[0].people.includes('發送時好友數') && !rows[0].people.includes('280,000'), `推播人數＝發送當下好友數，不拿 LINE 的 delivered（那是訊息則數）：${rows[0].people}`);
check(rows[1].people.includes('287,000') && rows[1].people.includes('預計') && rows[3].people.includes('1 人') && rows[3].people.includes('小編本人'), `排程顯示預計人數；測試推播顯示收件人：${rows[1].people}／${rows[3].people}`);
check(!(await page.isHidden('#hubListWarn')) === false, '有 Cron 心跳：沒有警告');
await page.locator('#s8Modal').screenshot({ path: path.join(SHOTS, 'hub-1-list.png') });

// ===== 3. 點進去看詳細 =====
await page.click('#hubListBox .hub-row:first-child');
check(await vis('#hubDetail') && !(await vis('#hubListMain')), '點列表任一筆：進入該筆的詳細畫面');
let kv = await page.$$eval('#hubDetail .hub-kv > div', d => d.map(x => x.textContent));
check(kv.includes('★今晚重點新聞') && kv.includes('推播標題'), '顯示「推播標題」');
let trs = await page.$$eval('#hubDetail table.hub-tbl tr', t => t.map(tr => [...tr.children].map(c => c.textContent)));
check(trs.length === 6 && trs[1][0].includes('★蔣萬安專訪') && trs[1][1] === '1,234' && trs[1][2] === '1,000', '每則訊息標題一列：點擊次數 1,234／點擊人數 1,000');
check(trs[2][1] === '—' && trs[3][1] === '—' && trs.some(r => r[0].includes('（其他連結）')) && trs.at(-1)[0].includes('送達 280,000 則訊息') && trs.at(-1)[0].includes('開啟 90,000 人') && trs.at(-1)[2] === '41,000', 'LINE 沒提供（<20）顯示「—」；其他連結另列；最後一列是整則統計');
check(reqs.stats.length === 1 && reqs.stats[0].force === false, '進入詳細畫面時查一次統計（5 分鐘內 Worker 會直接用快取）');
await page.locator('#hubDetail table.hub-tbl tr:nth-child(2) .lk button:first-child').click();
check((await page.evaluate(() => window.__opened)).join() === LINKS[0].url, '每則標題旁的「打開連結」：新分頁打開該格的推播連結');
await page.locator('#hubDetail').screenshot({ path: path.join(SHOTS, 'hub-2-detail.png') });
await page.click('#hubStatsRefresh');
await page.waitForFunction(() => document.querySelectorAll('#hubDetail table tr').length === 6);
check(reqs.stats.at(-1).force === true, '「重新整理統計」：force=true 重新向 LINE 查');
// 改名
await page.click('#hubRenameBtn');
await page.fill('#hubRenameInp', '10/09 晚間重點');
await page.click('#hubDetail .hub-d-name .primary');
await page.waitForFunction(() => document.querySelector('#hubDetail .hub-d-name').textContent.includes('10/09 晚間重點'));
check(reqs.rename.at(-1).id === 'a'.repeat(24) && reqs.rename.at(-1).name === '10/09 晚間重點', '改名：送出新名稱');
await page.click('#hubDetail .hub-back');
check((await rowsOf())[0].name === '10/09 晚間重點', '返回列表：訊息命名已更新');

check(kv.some(v => v.includes('約 287,091 人（發送時好友數）')), '詳細頁「推播人數」＝發送當下好友數（不是 LINE 的 delivered）');
// 每格對應自己的點擊數：同一個連結出現在兩格（LINE 合併計算）、網址只差結尾斜線也要對得上
await page.evaluate(() => {
  const r = { ...hubFindRec('a'.repeat(24)), id: 'f'.repeat(24), name: '重複連結', links: [{ page: 1, label: '左上', title: '格一', url: 'https://example.com/d/' }, { page: 1, label: '右上', title: '格二', url: 'https://example.com/d' }, { page: 2, label: '左下', title: '格三', url: 'https://example.com/e' }] };
  hubFor('news').records.push(r);
  hubStats[r.id] = { stats: { at: '2026-10-10T05:00:00+08:00', overview: { delivered: 100, uniqueImpression: 50, uniqueClick: 30 }, messages: [], clicks: [{ seq: 1, url: 'https://example.com/d', click: 77, uniqueClick: 66 }, { seq: 2, url: 'https://example.com/e', click: 21, uniqueClick: 20 }] } };
  hubDetailId = r.id; hubDetailRender();
});
trs = await page.$$eval('#hubDetail table.hub-tbl tr', t => t.map(tr => [...tr.children].map(c => c.textContent)));
check(trs[1][1] === '77' && trs[1][2] === '66' && trs[2][1] === '77' && trs[2][2] === '66' && trs[3][1] === '21' && trs[3][2] === '20', '每一格各自寫出對應的點擊次數與點擊人數（網址只差結尾斜線也對得上）');
check(trs[1][0].includes('和另外 1 格是同一個連結') && trs[2][0].includes('和另外 1 格是同一個連結') && !trs[3][0].includes('同一個連結'), '同一個連結用在兩格時，註明 LINE 合併計算、數字相同');
await page.evaluate(() => { hubFor('news').records = hubFor('news').records.filter(r => r.id !== 'f'.repeat(24)); hubCloseDetail(); });

// ===== 4. 排程、測試、失敗 =====
await page.click('#hubListBox .hub-row:nth-child(2)');
check(await vis('#hubCancelSched') && !(await vis('#hubStatsRefresh')) && (await txt('#hubDStats')).includes('還沒發送'), '排程中的一筆：有「取消這筆排程」，沒有統計可看');
await page.click('#hubCancelSched');
await page.waitForFunction(() => document.querySelector('#hubListMain') && !document.getElementById('hubListMain').hidden);
check(reqs.cancel.at(-1).id === 'b'.repeat(24) && dialogs.at(-1).includes('確定要取消這筆排程') && (await rowsOf())[1].status === '已取消', '取消排程：先確認、送出取消，列表變「已取消」');
await page.click('#hubListBox .hub-row:nth-child(4)');
await page.waitForFunction(() => /只有認證帳號有/.test(document.getElementById('hubDStats').textContent));
check((await txt('#hubDetail')).includes('測試') && (await txt('#hubDStats')).includes('LINE 目前沒有這次發送的統計'), '測試推播：統計不可用時說明原因');
await page.click('#hubDetail .hub-back');
await page.click('#hubListBox .hub-row:nth-child(5)');
check((await txt('#hubDetail')).includes('發送當下好友數差太多') && (await txt('#hubDStats')).includes('沒有記下每則訊息的連結'), '失敗的一筆：顯示錯誤原因');
await page.click('#hubDetail .hub-back');

// ===== 5. 切換帳號 =====
await page.click('#hubAcctEnt');
await page.waitForFunction(() => /TVBS娛樂頭條 的推播列表/.test(document.getElementById('hubListTitle').textContent) && document.querySelectorAll('#hubListBox .hub-row').length === 1);
check(reqs.list.at(-1).channel === 'ent' && (await rowsOf())[0].name === '10/09娛樂', '切到 TVBS娛樂頭條：只看到娛樂帳號的推播');
await page.click('#hubAcctTest');
await page.waitForFunction(() => /還沒有推播紀錄/.test(document.getElementById('hubListBox').textContent));
check(reqs.list.at(-1).channel === 'test', '切到測試帳號：空列表顯示說明');

// ===== 6. Cron 沒在跑的警告 =====
heartbeat = 0;
await page.click('#hubAcctNews');
await page.waitForFunction(() => !document.getElementById('hubListWarn').hidden);
check((await txt('#hubListWarn')).includes('Cron Trigger 沒有在跑'), '有排程中的推播、但 Cron 沒心跳：列表上方紅字警告');
heartbeat = NOW;

// ===== 7. LINE推播設定 =====
await page.click('#hubTabSet');
await page.waitForFunction(() => /已連線/.test(document.getElementById('hubStatusBox').textContent));
const st = await txt('#hubStatusBox');
check(st.includes('TVBS新聞（@abc）') && st.includes('287,091') && st.includes('無上限') && st.includes('已綁定') && st.includes('運作中') && st.includes('LINE_ALLOW_OFFICIAL'), '連線狀態：帳號、好友數、訊息額度、圖片空間、排程引擎、正式群發開關');
check(reqs.status.at(-1).channel === 'news', '連線狀態向 LINE 查的是目前選的帳號');
await page.waitForFunction(() => document.querySelectorAll('#lineTesterList .line-trow').length === 1);
check((await txt('#lineTesterTitle')).includes('權限管理') && (await txt('#lineTesterList')).includes('小編本人') && (await txt('#lineTesterList')).includes('U8f0fba4524410d1cbc7c95ce37d96b80'), '權限管理：列表顯示名字＋對應的 userId');
await page.locator('#hubBody').screenshot({ path: path.join(SHOTS, 'hub-3-settings.png') });
// 新增成員：名字＋userId
await page.fill('#lineAddUid', 'abc'); await page.click('#lineAddFind');
check((await txt('#lineAddOut')).includes('格式不對') && reqs.lookup.length === 0, '貼了格式不對的 userId：直接擋掉，不問 LINE');
await page.fill('#lineAddName', '主播小美'); await page.fill('#lineAddUid', UID2); await page.click('#lineAddFind');
await page.waitForFunction(() => /會用「主播小美」（LINE 暱稱：LINE暱稱小美）加入/.test(document.getElementById('lineAddOut').textContent));
check(reqs.lookup.at(-1).channel === 'news' && reqs.lookup.at(-1).name === '主播小美' && reqs.lookup.at(-1).userId === UID2 && !(await page.evaluate(() => document.getElementById('lineAddOk').disabled)), '「查詢」：帶名字與 userId，LINE 驗證通過才能按「加入名單」');
await page.click('#lineAddOk');
await page.waitForFunction(() => document.querySelectorAll('#lineTesterList .line-trow').length === 2);
check(reqs.add.at(-1).name === '主播小美' && (await txt('#lineTesterList')).includes('主播小美') && (await txt('#lineTesterList')).includes(UID2) && (await page.inputValue('#lineAddUid')) === '' && (await page.inputValue('#lineAddName')) === '', '「加入名單」：列表多一位（名字＋userId），輸入框清空');
await page.click('#lineTesterList .line-trow:last-child button');
await page.waitForFunction(() => document.querySelectorAll('#lineTesterList .line-trow').length === 1);
check(reqs.remove.at(-1).channel === 'news' && reqs.remove.at(-1).tid === '2'.repeat(16) && dialogs.at(-1).includes('主播小美'), '移除成員：先確認，只動這個帳號的名單');
// 切到娛樂：Worker 沒設憑證
await page.click('#hubAcctEnt');
await page.waitForFunction(() => /連不上/.test(document.getElementById('hubStatusBox').textContent));
check((await txt('#hubStatusBox')).includes('尚未設定'), '憑證沒設的帳號：連線狀態顯示 ✗ 連不上與原因');
await page.click('#hubAcctTest');
await page.waitForFunction(() => /測試官方帳號/.test(document.getElementById('hubStatusBox').textContent));
check((await txt('#hubStatusBox')).includes('上限 200') && (await txt('#hubStatusBox')).includes('剩 164') && !(await txt('#hubStatusBox')).includes('正式群發') && (await txt('#lineTesterList')).includes('王小明') && (await txt('#lineTesterHint')).includes('登記'), '測試帳號：額度（200／已用 36／剩 164）、名單與「傳登記」說明');
check(await vis('#lineAddRow'), '測試帳號也能直接貼 userId 新增');
await page.click('#hubStatusBtn');
check(reqs.status.filter(r => r.channel === 'test').length >= 2, '「重新檢查」：重新向 LINE 查');

// ===== 8. 憑證過期 → 密碼視窗 → 自動繼續 =====
await page.click('#hubTabList'); await page.click('#hubAcctNews');
await page.waitForFunction(() => document.querySelectorAll('#hubListBox .hub-row').length === 5);
await page.click('#hubListBox .hub-row:first-child');
await page.evaluate(() => { sessionStorage.setItem('labAuth', JSON.stringify({ token: 'old', expiresAt: Date.now() - 1000 })); });
const s0 = reqs.stats.length;
await page.click('#hubStatsRefresh');
await page.waitForSelector('#labOverlay.open');
check((await txt('#labMsg')).includes('憑證已過期') && await page.evaluate(() => Number(getComputedStyle(document.getElementById('labOverlay')).zIndex) > Number(getComputedStyle(document.getElementById('s8Overlay')).zIndex)), '憑證過期：跳出密碼視窗（蓋在訊息推播視窗之上）');
await page.fill('#labPass', 'pw'); await page.click('#labEnterBtn');
await page.waitForFunction(() => !document.getElementById('labOverlay').classList.contains('open'));
await page.waitForTimeout(300);
check(labAuthReqs.length === 1 && reqs.stats.length === s0 + 1 && await page.evaluate(() => document.getElementById('s8Overlay').classList.contains('open')), '輸入密碼後剛剛的查詢自動繼續，視窗仍開著');
await page.evaluate(() => { sessionStorage.setItem('labAuth', JSON.stringify({ token: 'lab-token-2', expiresAt: Date.now() + 3600e3 })); });

// ===== 9. 關閉與回到「排入LINE推播」=====
await page.click('#hubCloseBtn');
check(!(await page.evaluate(() => document.getElementById('s8Overlay').classList.contains('open'))), '按「關閉」：視窗收起');
await page.keyboard.press('Escape');
await page.evaluate(() => { s8AltByMode[mode] = '測試推播標題'; openS8Dialog(); });
await page.waitForFunction(() => document.querySelectorAll('#s8Stage .s8-cell').length === 6, null, { timeout: 60000 });
check(await page.evaluate(() => document.getElementById('s8Modal').dataset.view === 'compose') && await vis('#s8Modetabs') && await vis('#composeBody') && !(await vis('#hubBody')) && !(await vis('#hubTabs')), '再開「排入LINE推播」：回到原本的編輯畫面（模式切換、表單），沒有被訊息推播的分頁蓋掉');
check(!(await vis('#lineBox')) || (await page.locator('#lineBox').count()) === 0, '編輯畫面裡舊的「帳號與額度、發送紀錄」折疊區已移除（搬進訊息推播）');
await page.click('#s8CloseBtn');
// 拼圖版型也能開
await page.evaluate(() => { document.querySelector('[data-mode="collage"]')?.click(); });
await page.click('#s8Link');
await page.waitForFunction(() => document.querySelectorAll('#hubListBox .hub-row').length >= 1);
check(await page.evaluate(() => document.getElementById('s8Modal').dataset.view === 'hub') && (await page.textContent('#hubAcct .on')) === 'TVBS新聞', '在拼圖版型也能開訊息推播，不會出錯');
await page.click('#hubCloseBtn');

check(pageErrors.length === 0, `頁面沒有 JS 錯誤${pageErrors.length ? '：' + pageErrors.join(' | ') : ''}`);
await browser.close();
console.log(failed ? `\n${failed} 項失敗` : '\n全部通過');
process.exit(failed ? 1 : 0);
