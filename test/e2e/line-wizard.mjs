// 前端驗證：「排入推播」視窗的 LINE 原生推播五步驟精靈——推播內容 → 推播設定（操作人／推播帳號／推播方式）→ 推播測試（滑動發送，只傳給操作人）→
// 推播預覽（截圖複製、紅色按鈕、確認推播彈窗）→ 推播狀態（鎖定、推播列表／完成推播）（Playwright，Worker 全部用假回應攔截，不會連到真的 LINE）
// 執行：
//   python3 -m http.server 8960 &            # 在專案根目錄
//   NODE_PATH=$(npm root -g) node test/e2e/line-wizard.mjs
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
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
const RED = 'rgb(220, 38, 38)';

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await browser.newContext({ viewport: { width: 1100, height: 1500 } });
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));
const dialogs = [];
page.on('dialog', async d => { dialogs.push(d.message()); await d.accept(); });

// ---- 假 Worker（語意同真的：測試推播＝mode:'test'，三個帳號都一樣；群發要同帳號的 testToken 與確認人數）----
const reqs = { status: [], prepare: [], validate: [], send: [], sched: [], testers: [] };
const FRIENDS = { news: 287091, ent: 150000, test: 3 };
let validateOk = true, sendFail = '', sendDelay = 0, followersNull = false, schedFail = '';
const T_A = 'a'.repeat(16), T_B = 'b'.repeat(16), T_C = 'c'.repeat(16), T_N1 = '1'.repeat(16), T_N2 = '2'.repeat(16);
const roster = {
  test: [{ tid: T_A, name: '小編本人', registeredAt: 1 }, { tid: T_B, name: '王小明', registeredAt: 2 }, { tid: T_C, name: '陳小美', registeredAt: 3 }],
  news: [{ tid: T_N1, name: '小編本人', registeredAt: 1 }, { tid: T_N2, name: '新同仁', registeredAt: 2 }],
  ent: [],
};
const scheds = [];
await page.route(`${WORKER}/**`, async route => {
  const url = new URL(route.request().url());
  const body = route.request().postDataJSON?.() || {};
  const json = (obj, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(obj) });
  if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' } });
  const ch = body.channel || 'test';
  if (url.pathname === '/line/testers/list') { reqs.testers.push(body); return json({ ok: true, channel: ch, testers: roster[ch], maxPerSend: 1 }); }
  if (url.pathname === '/line/status') { reqs.status.push(body); return json({ ok: true, channel: ch, r2Ready: true, officialAllowed: true, bot: { displayName: ch === 'test' ? '測試官方帳號' : 'TVBS新聞', basicId: '@abc' }, quota: { type: 'limited', value: 100000000 }, used: 36, followers: followersNull ? null : { status: 'ready', followers: FRIENDS[ch], targetedReaches: FRIENDS[ch] - 1, blocks: 1 }, notes: [] }); }
  if (url.pathname === '/line/prepare') { reqs.prepare.push(body); return json({ ok: true, id: 'prep' + reqs.prepare.length, prepareToken: 'ptok' + reqs.prepare.length, expiresInMinutes: 30, pages: body.pages.length }); }
  if (url.pathname === '/line/validate') { reqs.validate.push(body); return json(validateOk ? { ok: true, valid: true, pages: 2 } : { ok: true, valid: false, message: 'LINE 回應 400：baseUrl 不對' }); }
  if (url.pathname === '/line/send') {
    reqs.send.push(body);
    if (sendDelay) await new Promise(r => setTimeout(r, sendDelay));
    if (body.mode === 'test') {
      if (sendFail === 'test') return json({ error: '測試推播被 LINE 拒絕' }, 502);
      if ((body.testers || []).length !== 1) return json({ error: '測試推播一次只能給 1 位。沒有發送任何東西。' }, 400);
      return json({ ok: true, channel: ch, official: false, testOnly: true, sentAt: '2026-10-07T12:00:00+08:00', requestId: '44444444-4444-4444-8444-444444444444', retryKey: body.retryKey, friends: 1, pages: 2, recipients: [roster[ch].find(t => t.tid === body.testers[0]).name], testToken: 'ttok-' + ch, quota: { limit: 100000000, used: 36 } });
    }
    if (body.testToken !== 'ttok-' + ch) return json({ error: `群發前，同一份內容必須先在「${ch}」測試推播成功。沒有發送任何東西。` }, 400);
    if (body.confirmTotal !== FRIENDS[ch]) return json({ error: '確認人數不符。沒有發送任何東西。' }, 409);
    if (sendFail === 'official') return json({ error: 'LINE 回應 429：額度不足' }, 502);
    return json({ ok: true, channel: ch, official: true, sentAt: '2026-10-07T12:00:00+08:00', requestId: '22222222-2222-4222-8222-222222222222', retryKey: body.retryKey, friends: FRIENDS[ch], pages: 2 });
  }
  if (url.pathname === '/line/schedule/create') {
    reqs.sched.push(body);
    if (schedFail) return json({ error: schedFail }, 409);
    const rec = { id: String(scheds.length + 1).padStart(24, 'a'), channel: ch, runAtIso: body.runAt, status: 'scheduled', approvedFriends: FRIENDS[ch] };
    scheds.push(rec); return json({ ok: true, schedule: rec });
  }
  if (url.pathname === '/line/schedule/list') return json({ ok: true, schedules: [], heartbeatAt: Date.now(), serverNow: Date.now() });
  return json({ error: `unexpected ${url.pathname}` }, 404);
});

await page.addInitScript(() => {
  sessionStorage.setItem('labAuth', JSON.stringify({ token: 'lab-token', expiresAt: Date.now() + 3600e3 }));
  try { localStorage.removeItem('lineOp'); } catch (e) { /* */ }
  // 假的剪貼簿：把寫進去的圖存下來供檢查
  window.__clip = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write: async items => { for (const it of items) { const b = await it.getType('image/png'); window.__clip.push({ type: b.type, size: b.size }); window.__clipBlob = b; } } } });
});
await ctx.route('https://example.com/**', r => r.fulfill({ status: 200, contentType: 'text/html', body: 'ok' }));
await page.goto(`${BASE}?imageProxy=${encodeURIComponent(WORKER)}`);
await page.evaluate(() => { setLab(true); });
const setTpl = v => page.evaluate(v => { const e = document.getElementById('qrTpl'); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); }, v);
const txt = id => page.textContent(id);
const vis = async sel => !(await page.locator(sel).isHidden());
const stepNow = () => page.evaluate(() => lineSt().step);
const paneVis = async () => (await Promise.all(['contentBlock', 'lineP2', 'lineP3'].map(i => vis('#' + i)))).map((v, i) => v ? i + 1 : 0).filter(Boolean).join();
const nextState = () => page.evaluate(() => { const b = document.getElementById('lineNextBtn'); return { dis: b.classList.contains('is-disabled'), aria: b.getAttribute('aria-disabled'), tip: b.dataset.tip, hidden: b.hidden, text: b.textContent, red: b.classList.contains('red') }; });
async function openDialog() {
  await page.evaluate(() => { s8AltByMode[mode] = '測試推播標題'; openS8Dialog(); });
  await page.waitForFunction(() => document.querySelectorAll('#s8Stage .s8-cell').length === 6 && s8State.images.length === 2 && s8State.images.every(Boolean), null, { timeout: 60000 });
  await page.evaluate(() => { s8State.urls.forEach((row, p) => row.forEach((_, i) => { s8State.urls[p][i] = `https://example.com/p${p + 1}/n${i + 1}?utm_source=x`; })); s8Refresh(); });
  await page.waitForFunction(() => document.getElementById('s8Errs').children.length === 0, null, { timeout: 5000 });
}
const clickNext = async () => { await page.click('#lineNextBtn'); await page.waitForTimeout(150); };
const slide = async () => {
  await page.waitForTimeout(350);   // 等上一次彈回的動畫結束
  const kb = await page.locator('#lineKnob').boundingBox(), sb = await page.locator('#lineSlider').boundingBox();
  await page.mouse.move(kb.x + kb.width / 2, kb.y + kb.height / 2); await page.mouse.down();
  await page.mouse.move(kb.x + sb.width + 40, kb.y + kb.height / 2, { steps: 12 });
  await page.mouse.up();
};
const pickOp = async name => { await page.waitForSelector('#lineOpList .lw-op'); await page.locator('#lineOpList .lw-op', { hasText: name }).first().click(); };
async function toStep(n) {   // 從目前這步一路按到第 n 步（操作人小編本人、預設帳號與方式）
  while ((await stepNow()) < n) {
    const s = await stepNow();
    if (s === 2 && !(await page.evaluate(() => !!lineOp))) await pickOp('小編本人');
    if (s === 3 && (await page.evaluate(() => lineSt().test)) !== 'ok') { await slide(); await page.waitForFunction(() => lineSt().test === 'ok'); }
    await clickNext();
  }
}
const resetFlow = async () => { await page.evaluate(() => { const st = lineSt(); lineResetFlow(st); st.acct = mode; st.way = 'now'; lineUpdateSteps(); }); };
const cfmOpen = () => vis('#lineCfmOverlay');
const typeCount = async v => { await page.fill('#lineCfmTotal', v); };

// ===== 1. 版面：五個步驟的進度列 =====
await openDialog();
const lay = await page.evaluate(() => {
  const r = id => document.getElementById(id).getBoundingClientRect(), m = r('s8Modal'), f = r('lineFoot');
  return { footAtBottom: Math.abs(f.bottom - m.bottom) < 2, labels: [...document.querySelectorAll('#lineStepbar .lsb b')].map(b => b.textContent).join('｜'), modalW: m.width, wrap: r('lineStepbar').height < 50 };
});
check(lay.footAtBottom && lay.labels === '推播內容｜推播設定｜推播測試｜推播預覽｜推播狀態', `步驟進度列固定在彈窗最下方：${lay.labels}`);
check(lay.modalW > 800 && lay.wrap, `彈窗加寬到 ${Math.round(lay.modalW)}px，五個步驟排在同一行`);
check((await paneVis()) === '1' && (await page.locator('#linePrepBtn').count()) === 0, '第 1 步只顯示「推播內容」');
await page.locator('#s8Modal').screenshot({ path: path.join(SHOTS, 'wiz-1-content.png') });
let ns = await nextState();
check(!ns.dis && ns.text === '下一步' && !ns.red, '內容都填好、預覽圖也產生好：第 1 步的「下一步」可按');
await page.evaluate(() => { document.getElementById('s8Alt').value = ''; document.getElementById('s8Alt').dispatchEvent(new Event('input', { bubbles: true })); });
ns = await nextState();
check(ns.dis && ns.tip.includes('第 1 步「推播內容」還沒完成') && ns.tip.includes('推播通知'), `沒填推播通知：下一步反灰，泡泡說明「${ns.tip}」`);
await page.evaluate(() => { document.getElementById('s8Alt').value = '測試推播標題'; document.getElementById('s8Alt').dispatchEvent(new Event('input', { bubbles: true })); });
check(reqs.prepare.length === 0 && reqs.send.length === 0, '到這裡完全沒有上傳資料給 Worker');

// 先加三顆快速回覆（兩顆關鍵字、一顆連結）
for (let i = 0; i < 3; i++) await page.click('#qrAdd');
const labs = ['蔣萬安', '少康獨家專訪六都', '民調'];
for (let i = 0; i < 3; i++) await page.locator('#qrRows .qr-lab input').nth(i).fill(labs[i]);
await setTpl('https://news.example.com/search?q={keyword}');
await page.locator('#qrRows .qr-url input').nth(2).fill('https://example.com/poll/2026');
await page.waitForTimeout(150);

// ===== 2. 第 2 步：推播設定（操作人、推播帳號、推播方式）=====
await clickNext();
check((await stepNow()) === 2 && (await paneVis()) === '2', '按「下一步」：進到第 2 步「推播設定」');
await page.waitForSelector('#lineOpList .lw-op');
const ops = await page.$$eval('#lineOpList .lw-op', b => b.map(x => x.textContent));
check(ops.length === 4 && ops[0].startsWith('小編本人') && ops[0].includes('新聞✓') && ops[0].includes('測試✓') && ops.some(o => o.startsWith('新同仁') && o.includes('測試✗')) && ops.some(o => o.startsWith('王小明') && o.includes('新聞✗')), `操作人是單選名單，標出各帳號名單有沒有他：${ops.join(' / ')}`);
const accts = await page.$$eval('#lineAcctList .lw-op', b => b.map(x => ({ t: x.textContent, on: x.classList.contains('on'), dis: x.disabled })));
check(accts.length === 3 && accts[0].t === '新聞帳號TVBS新聞' && accts[0].on && accts[1].t === '娛樂帳號TVBS娛樂頭條' && accts[1].dis && accts[2].t === '測試帳號' && !accts[2].dis, `推播帳號：新聞帳號（預設＝目前版型）、娛樂帳號（別的版型，不能選）、測試帳號：${JSON.stringify(accts)}`);
check((await page.getAttribute('#lineAcctList .lw-op:nth-child(2)', 'title')).includes('不能發到娛樂帳號'), '不能選的原因寫在提示上');
check((await txt('#lineAcctNote')).includes('推播測試與正式推播都在這個帳號內'), '說明：推播測試與正式推播都在同一個帳號內完成');
check(await vis('#linePickNow') && await vis('#linePickSched') && await page.evaluate(() => document.getElementById('linePickNow').classList.contains('active')), '推播方式：預設「立即推播」，旁邊是「排程推播」＋日期時間');
ns = await nextState();
check(ns.dis && ns.tip.includes('第 2 步「推播設定」還沒完成') && ns.tip.includes('操作人'), `沒選操作人：下一步反灰（${ns.tip}）`);
await pickOp('小編本人');
check(await page.evaluate(() => lineOp === '小編本人' && localStorage.getItem('lineOp') === '小編本人') && (await txt('#lineOpNote')).includes('只會傳給他一位'), '選「小編本人」：記在這個瀏覽器，說明推播測試只傳給他一位');
await page.locator('#s8Modal').screenshot({ path: path.join(SHOTS, 'wiz-2-setup.png') });
check(!(await nextState()).dis, '選了操作人：下一步可按');
await pickOp('王小明');
ns = await nextState();
check(ns.dis && ns.tip.includes('名單裡找不到操作人「王小明」') && (await txt('#lineOpNote')).includes('「新聞帳號」的名單裡沒有「王小明」'), '操作人不在這個帳號的名單：說明原因、不能往下');
await page.locator('#lineAcctList .lw-op', { hasText: '測試帳號' }).click();
check(await page.evaluate(() => lineSt().acct === 'test') && !(await nextState()).dis && (await txt('#lineAcctNote')).includes('群發給所有加了測試帳號好友'), '改選測試帳號：王小明在測試帳號名單裡，可以往下；說明測試帳號的正式推播是群發給它的所有好友');
await page.locator('#lineAcctList .lw-op', { hasText: '新聞帳號' }).click();
await pickOp('小編本人');
await page.click('#linePickSched'); await page.waitForTimeout(200);
check(await page.evaluate(() => lineSt().way === 'sched') && await vis('#lineWhenMsg'), '選排程推播：顯示排程時間說明');
await page.evaluate(() => { const a = document.getElementById('lineDate'), b = document.getElementById('lineTime'); a.value = new Date(Date.now() + 8 * 3600e3 - 86400e3).toISOString().slice(0, 10); a.dispatchEvent(new Event('input', { bubbles: true })); b.value = '10:00'; b.dispatchEvent(new Event('input', { bubbles: true })); });
ns = await nextState();
check(ns.dis && (await txt('#lineWhenMsg')).includes('5 分鐘之後'), `排程時間已過：下一步反灰（${ns.tip}）`);
await page.click('#linePickNow'); await page.waitForTimeout(150);
check(await page.evaluate(() => lineSt().way === 'now') && !(await nextState()).dis, '改回立即推播：可往下');

// ===== 3. 第 3 步：推播測試 =====
await clickNext();
check((await stepNow()) === 3 && (await paneVis()) === '3', '進到第 3 步「推播測試」');
const s3 = await page.evaluate(() => ({
  titles: [...document.querySelectorAll('#lineTitles li')].map(li => li.className + ':' + li.textContent),
  quick: [...document.querySelectorAll('#lineQuick > div')].map(d => d.textContent),
  info: !document.getElementById('lineInfoBox').hidden, test: !document.getElementById('lineTestBox').hidden, stat: !document.getElementById('lineStatBox').hidden, shot: !document.getElementById('lineShotRow').hidden, slider: !document.getElementById('lineSlider').hidden,
  hasInput: !!document.querySelector('#lineChat .chat-in'), chips: [...document.querySelectorAll('#lineChat .chat-chip')].map(x => x.textContent), chatName: document.querySelector('#lineChat .chat-name').textContent, imgs: document.querySelectorAll('#lineChat img.chat-img').length,
  count: document.getElementById('lineTitlesCount').textContent, split: (() => { const c = document.getElementById('lineChat').getBoundingClientRect(), l = document.querySelector('#lineP3 .lw-ctl').getBoundingClientRect(); return c.left >= l.right - 2 && c.width > 250 && c.width < 340; })(),
}));
check(s3.titles.length === 14 && s3.titles[0] === 'grp:訊息 1' && s3.titles[7] === 'grp:訊息 2' && s3.count === '共 12 格', `左側列出每則訊息標題（每行一個，分「訊息 1／訊息 2」，共 12 格）：${s3.titles.length} 列`);
check(s3.quick.length === 3 && s3.quick[0].includes('蔣萬安') && s3.quick[0].includes('關鍵字') && s3.quick[0].includes('搜尋「蔣萬安」') && s3.quick[2].includes('連結') && s3.quick[2].includes('https://example.com/poll/2026'), `快速回覆列出文字與方式（關鍵字／連結）：${s3.quick.join(' | ')}`);
check(!s3.info && s3.test && !s3.stat && !s3.shot && s3.slider, '第 3 步：沒有推播資訊框；有「推播測試狀態」與滑動按鈕');
const tl3 = await page.evaluate(() => { const ul = document.getElementById('lineTitles'), cs = getComputedStyle(ul); return { ov: cs.overflowY, mh: cs.maxHeight, full: ul.scrollHeight <= ul.clientHeight + 1, av: !!document.querySelector('#lineChat .chat-av'), firstImgTop: Math.round(document.querySelector('#lineChat .chat-img').getBoundingClientRect().top - document.querySelector('#lineChat .chat-bar').getBoundingClientRect().bottom) }; });
check(tl3.mh === 'none' && tl3.ov !== 'auto' && tl3.ov !== 'scroll' && tl3.full, `每則訊息標題全部直接列出，不用捲動（max-height ${tl3.mh}、overflow ${tl3.ov}）`);
check(!tl3.av && tl3.firstImgTop <= 24, `手機預覽沒有 LINE 頭貼，第一張圖直接接在標題列下（相距 ${tl3.firstImgTop}px）`);
check(!s3.hasInput && s3.chips.join('｜') === labs.join('｜') && s3.chatName === 'TVBS新聞' && s3.imgs === 2 && s3.split, '右側推播預覽：沒有底下的輸入列、兩頁圖、快速回覆按鈕，在左側內容的右邊（手機寬度）');
check((await txt('#lineTestStat')).includes('尚未測試') && (await txt('#lineTestWho')).includes('只傳給操作人：小編本人'), '測試狀態：尚未測試；標明只傳給操作人');
ns = await nextState();
check(ns.dis && ns.tip.includes('第 3 步「推播測試」還沒完成') && ns.tip.includes('滑動發送測試推播'), `還沒測試：下一步反灰，泡泡說明（${ns.tip}）`);
await page.locator('#s8Modal').screenshot({ path: path.join(SHOTS, 'wiz-3-test.png') });
// 只滑一半：不觸發
const kb0 = await page.locator('#lineKnob').boundingBox(), sb0 = await page.locator('#lineSlider').boundingBox();
await page.mouse.move(kb0.x + kb0.width / 2, kb0.y + kb0.height / 2); await page.mouse.down(); await page.mouse.move(kb0.x + sb0.width / 2, kb0.y + kb0.height / 2, { steps: 6 }); await page.mouse.up();
await page.waitForTimeout(300);
check(reqs.send.length === 0 && await page.evaluate(() => lineSt().test === ''), '滑到一半放開：彈回去，沒有發送');
sendDelay = 400;
await slide();
await page.waitForFunction(() => lineSt().test === 'busy');
check((await txt('#lineTestStat')).match(/傳送資料中|推播中/) !== null && await page.evaluate(() => document.getElementById('lineSlider').classList.contains('busy')), '推播中：狀態框即時顯示進度');
await page.waitForFunction(() => lineSt().test === 'ok');
sendDelay = 0;
const t1 = reqs.send.at(-1);
check(t1.channel === 'news' && t1.mode === 'test' && JSON.stringify(t1.testers) === JSON.stringify([T_N1]) && /^[0-9a-f-]{36}$/.test(t1.retryKey) && t1.confirmTotal === undefined && t1.testToken === undefined && Array.isArray(t1.links) && t1.links.length === 12, '測試推播：channel=新聞帳號、mode=test、只帶操作人一位、不帶人數與憑證');
check(reqs.prepare.length === 1 && reqs.prepare[0].org === 'news' && reqs.prepare[0].quick.length === 3 && reqs.validate[0].channel === 'news', '滑動時才一起傳送資料；格式檢查用同一個推播帳號');
const st3 = await txt('#lineTestStat');
check(st3.includes('資料已上傳、格式檢查通過') && st3.includes('已送出給 LINE') && st3.includes('已傳給操作人（小編本人）') && st3.includes('「新聞帳號」'), `測試狀態：${st3.replace(/\s+/g, ' ').slice(0, 120)}`);
check(await page.evaluate(() => document.getElementById('lineSlider').classList.contains('done')) && (await txt('#lineSlabel')) === '測試推播已發送' && !(await nextState()).dis, '滑動按鈕變成綠色「測試推播已發送」；下一步可按');
await page.locator('#s8Modal').screenshot({ path: path.join(SHOTS, 'wiz-3b-test-ok.png') });
await page.click('#lineTestAgain'); await page.waitForTimeout(200);
check(await page.evaluate(() => lineSt().test === '' && !document.getElementById('lineSlider').classList.contains('done')) && (await nextState()).dis, '「再發送一次測試」：狀態歸零，要重新滑動');
await slide(); await page.waitForFunction(() => lineSt().test === 'ok');
check(reqs.send.length === 2 && reqs.send[1].retryKey !== reqs.send[0].retryKey && reqs.prepare.length === 1, '再發送：換一把重試金鑰（才會真的再發一次），不重複上傳資料');
await page.click('#lineTestAgain'); sendFail = 'test';
await slide(); await page.waitForFunction(() => lineSt().test === 'bad');
check((await txt('#lineTestStat')).includes('推播失敗') && (await nextState()).dis && await page.evaluate(() => !document.getElementById('lineSlider').classList.contains('done')), '測試失敗：狀態框顯示原因、下一步維持反灰、滑動按鈕可再試');
sendFail = '';
await slide(); await page.waitForFunction(() => lineSt().test === 'ok');
await page.click('#lineSb2'); await page.waitForTimeout(150);
check((await stepNow()) === 2 && await page.evaluate(() => lineSt().test === 'ok'), '點進度列的「2」可以回上一步，測試結果還在');
await page.evaluate(() => { lineOpSet('王小明'); });
check(await page.evaluate(() => lineSt().test === '' && lineSt().testToken === '' && lineSt().step === 2), '換了操作人：之前的測試推播不算數（要重新測試）');
await pickOp('小編本人');
await page.locator('#lineAcctList .lw-op', { hasText: '測試帳號' }).click(); await page.waitForTimeout(100);
await clickNext();
await slide(); await page.waitForFunction(() => lineSt().test === 'ok');
const tt = reqs.send.at(-1);
check(tt.channel === 'test' && tt.mode === 'test' && JSON.stringify(tt.testers) === JSON.stringify([T_A]) && (await txt('#lineTestStat')).includes('「測試帳號」'), '測試帳號當推播帳號：同樣是 mode=test、只傳給操作人（測試帳號名單裡的小編本人）');
await page.click('#lineSb2'); await page.waitForTimeout(100);
await page.locator('#lineAcctList .lw-op', { hasText: '新聞帳號' }).click(); await page.waitForTimeout(100);
check(await page.evaluate(() => lineSt().test === '' && lineSt().acct === 'news'), '換推播帳號：之前的測試推播不算數');
await clickNext();
await slide(); await page.waitForFunction(() => lineSt().test === 'ok');
validateOk = false;
await page.click('#lineTestAgain');
await page.evaluate(() => { lineSt().prep.at = Date.now() - 25 * 60 * 1000; });   // 資料超過 20 分鐘：要重傳
await slide(); await page.waitForFunction(() => lineSt().test === 'bad');
check((await txt('#lineTestStat')).includes('LINE 說格式不對') && await page.evaluate(() => !lineSt().testToken), '資料過期要重傳、LINE 說格式不對：測試失敗、不發送');
validateOk = true;
await slide(); await page.waitForFunction(() => lineSt().test === 'ok');

// ===== 4. 第 4 步：推播預覽 =====
await clickNext();
check((await stepNow()) === 4 && (await paneVis()) === '3', '進到第 4 步「推播預覽」（與第 3 步同一個版面）');
const s4 = await page.evaluate(() => ({
  info: !document.getElementById('lineInfoBox').hidden, test: !document.getElementById('lineTestBox').hidden, shot: !document.getElementById('lineShotRow').hidden, slider: !document.getElementById('lineSlider').hidden,
  kv: [...document.querySelectorAll('#lineInfoKv dt, #lineInfoKv dd')].map(x => x.textContent), qn: document.querySelectorAll('#lineQuick > div').length, tn: document.querySelectorAll('#lineTitles li').length,
}));
check(s4.info && !s4.test && s4.shot && !s4.slider && s4.kv.join('|') === '推播帳號|新聞帳號（TVBS新聞）|推播方式|立即|推播通知|測試推播標題' && s4.qn === 3 && s4.tn === 14, `第 4 步：上方資訊框（推播帳號／推播方式／推播通知）、標題、快速回覆、截圖按鈕；沒有滑動按鈕：${s4.kv.join(' ')}`);
await page.mouse.move(5, 5); await page.waitForTimeout(250);
ns = await nextState();
const nbg = await page.evaluate(() => getComputedStyle(document.getElementById('lineNextBtn')).backgroundColor);
check(ns.text === '立即推播' && ns.red && nbg === RED && !ns.dis, `右下步驟按鈕是紅色「立即推播」（${nbg}）`);
await page.locator('#s8Modal').screenshot({ path: path.join(SHOTS, 'wiz-4-preview.png') });
await page.click('#lineShotBtn');
await page.waitForFunction(() => lineSt().shot === 'copied', null, { timeout: 15000 });
const clip = await page.evaluate(() => window.__clip);
check(clip.length === 1 && clip[0].type === 'image/png' && clip[0].size > 20000 && (await txt('#lineShotTxt')).includes('已複製圖片，可直接貼到聊天室') && await page.evaluate(() => document.getElementById('lineShotBtn').classList.contains('ok')), `按「截圖此畫面」：PNG 圖片（${clip[0] && clip[0].size} bytes）複製到剪貼簿，按鈕變綠「已複製圖片，可直接貼到聊天室」`);
const png = await page.evaluate(async () => { const bmp = await createImageBitmap(window.__clipBlob); return { w: bmp.width, h: bmp.height }; });
writeFileSync(path.join(SHOTS, 'wiz-4-capture.png'), Buffer.from(await page.evaluate(async () => { const buf = new Uint8Array(await window.__clipBlob.arrayBuffer()); let s = ''; for (const x of buf) s += String.fromCharCode(x); return btoa(s); }), 'base64'));
check(png.w === 1520 && png.h > 1400, `截圖尺寸：${png.w}×${png.h}（寬 760px、2 倍清晰；所有標題完整展開）`);
await page.locator('#lineShotBtn').screenshot({ path: path.join(SHOTS, 'wiz-4-shot-btn.png') });
// 沒有剪貼簿圖片功能：改下載
await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }); lineSt().shot = ''; lineUpdateSteps(); });
const dl = page.waitForEvent('download');
await page.click('#lineShotBtn');
const d1 = await dl;
await page.waitForFunction(() => lineSt().shot === 'saved');
check(/^line_review_\d{12}\.png$/.test(d1.suggestedFilename()) && (await txt('#lineShotTxt')).includes('圖片已下載'), `瀏覽器不能複製圖片：改為下載 PNG（${d1.suggestedFilename()}），按鈕提示已下載`);

// ===== 5. 確認推播彈窗（立即）=====
await page.click('#lineNextBtn'); await page.waitForTimeout(250);
check(await cfmOpen(), '按紅色「立即推播」：跳出「確認推播」彈窗');
const cf = await page.evaluate(() => { const o = document.getElementById('lineCfmOverlay').getBoundingClientRect(), m = document.getElementById('s8Overlay').getBoundingClientRect(); return { cover: o.width >= m.width - 1 && o.height >= m.height - 1, title: document.getElementById('lineCfmTitle').textContent, kv: [...document.querySelectorAll('#lineCfmKv dt, #lineCfmKv dd')].map(x => x.textContent).join('|'), warn: [...document.querySelectorAll('#lineCfmWarn div')].map(x => x.textContent).join('|') }; });
check(cf.cover && cf.title === '確認推播' && cf.kv === '推播帳號|新聞帳號（TVBS新聞）|推播方式|立即' && cf.warn === '推播送出後無法收回。', `彈窗蓋住整個視窗：${cf.kv}；${cf.warn}`);
await page.waitForFunction(() => Number.isFinite(lineSt().friends));
const cf2 = await page.evaluate(() => ({ ph: document.getElementById('lineCfmTotal').placeholder, goDis: document.getElementById('lineCfmGo').disabled }));
check(cf2.ph === '輸入 287,091' && cf2.goDis, `確認人數：提示「${cf2.ph}」；沒輸入前「確認推播」不能按`);
await page.locator('#lineCfmOverlay').screenshot({ path: path.join(SHOTS, 'wiz-5-confirm.png') });
await typeCount('123');
check((await txt('#lineCfmMark')) === '✗' && await page.evaluate(() => document.getElementById('lineCfmGo').disabled), '人數輸入錯誤：✗，不能確認');
await typeCount('287,091');
const go = await page.evaluate(() => { const g = document.getElementById('lineCfmGo'); return { dis: g.disabled, bg: getComputedStyle(g).backgroundColor }; });
check((await txt('#lineCfmMark')) === '✓' && !go.dis && go.bg === RED, `輸入正確人數：✓，紅色「確認推播」可按（${go.bg}）`);
check(reqs.send.every(r => r.mode === 'test'), '到這裡還沒有任何正式發送');
await page.click('#lineCfmCancel'); await page.waitForTimeout(150);
check(!(await cfmOpen()) && (await stepNow()) === 4 && reqs.send.every(r => r.mode === 'test'), '按「取消」：關掉彈窗，留在第 4 步，沒有發送');
await page.click('#lineNextBtn'); await page.waitForTimeout(150);
check(await page.evaluate(() => document.getElementById('lineCfmTotal').value === ''), '重新打開：人數要重新輸入');
await page.keyboard.press('Escape'); await page.waitForTimeout(150);
check(!(await cfmOpen()) && await vis('#s8Overlay.open'), '按 Esc：只關掉確認彈窗，不會連主視窗一起關掉');
sendFail = 'official';
await page.click('#lineNextBtn'); await page.waitForFunction(() => Number.isFinite(lineSt().friends)); await typeCount('287091');
await page.click('#lineCfmGo');
await page.waitForFunction(() => lineSt().go === 'bad');
check(await cfmOpen() && (await txt('#lineCfmErr')).includes('推播失敗：LINE 回應 429：額度不足') && (await stepNow()) === 4 && await page.evaluate(() => !document.getElementById('lineCfmGo').disabled), '正式推播失敗：彈窗內顯示原因（不關閉）、留在第 4 步，可再按一次');
sendFail = ''; sendDelay = 400;
await page.click('#lineCfmGo');
await page.waitForFunction(() => lineSt().go === 'busy');
check((await txt('#lineCfmGo')) === '推播中…' && await page.evaluate(() => document.getElementById('lineCfmGo').disabled && document.getElementById('lineCfmCancel').disabled), '推播中：按鈕顯示「推播中…」，不能取消');
await page.keyboard.press('Escape'); await page.waitForTimeout(100);
check(await cfmOpen(), '推播中按 Esc 關不掉');
await page.waitForFunction(() => lineSt().go === 'ok', null, { timeout: 10000 });
sendDelay = 0;
const offs = reqs.send.filter(r => r.mode !== 'test'), off = offs.at(-1);
check(off.channel === 'news' && off.testToken === 'ttok-news' && off.confirmTotal === 287091 && off.testers === undefined && /^[0-9a-f-]{36}$/.test(off.retryKey) && off.retryKey === offs[0].retryKey, '正式推播：channel=新聞帳號、不帶 mode、帶同帳號的測試憑證與確認人數、不帶收件人；失敗重試用同一把重試金鑰（不會重複發）');

// ===== 6. 第 5 步：推播狀態 =====
check((await stepNow()) === 5 && !(await cfmOpen()) && (await paneVis()) === '3', '確認推播成功：關閉彈窗，進到第 5 步「推播狀態」');
const bnow = await page.$$eval('#pushBubbles .push-bubble', bs => bs.map(b => b.querySelector('.pb-name').textContent + '｜' + b.querySelector('.pb-st').textContent));
check(bnow.some(t => /^\d\d\/\d\d新聞｜已發送$/.test(t)) && bnow.some(t => /（測試）｜已發送$/.test(t)), `右下角泡泡：「訊息名稱｜狀態」→ ${bnow.join('、')}`);
const s5 = await page.evaluate(() => ({ info: !document.getElementById('lineInfoBox').hidden, stat: !document.getElementById('lineStatBox').hidden, test: !document.getElementById('lineTestBox').hidden, shot: !document.getElementById('lineShotRow').hidden, slider: !document.getElementById('lineSlider').hidden, rows: [...document.querySelectorAll('#lineStatList .row')].map(r => r.textContent), btns: { list: !document.getElementById('lineListBtn').hidden, next: document.getElementById('lineNextBtn').textContent, nextRed: document.getElementById('lineNextBtn').classList.contains('red'), prev: !document.getElementById('linePrevBtn').hidden } }));
check(s5.info && s5.stat && !s5.test && !s5.shot && !s5.slider && s5.rows[0].includes('已送出給 LINE') && s5.rows[1].includes('LINE 已接受，推播人數 287,091 位') && s5.rows[2].includes('稍後到推播列表'), `第 5 步：資訊框、標題、快速回覆、「推播狀態」：${s5.rows.join(' / ')}`);
check(s5.btns.list && s5.btns.next === '完成推播' && !s5.btns.nextRed && !s5.btns.prev, '右下步驟按鈕：「推播列表」「完成推播」（沒有上一步）');
await page.locator('#s8Modal').screenshot({ path: path.join(SHOTS, 'wiz-6-status.png') });
const lock = await page.evaluate(() => ({ bar: [...document.querySelectorAll('#lineStepbar .lsb')].map(b => [b.classList.contains('done'), b.classList.contains('on')]) }));
check(lock.bar.slice(0, 4).every(b => b[0]) && lock.bar[4][1], '進度列：1～4 綠色完成、5 是目前這步');
await page.click('#lineSb2', { force: true }).catch(() => {}); await page.waitForTimeout(150);
check((await stepNow()) === 5, '推播完成後鎖定：點進度列回不去');
await page.click('#lineListBtn'); await page.waitForTimeout(250);
check(await page.evaluate(() => document.getElementById('s8Modal').dataset.view === 'hub' && hubTab === 'list' && hubCh === 'news') && await vis('#hubList'), '按「推播列表」：直接切到「訊息推播」的「推播列表」（新聞帳號）');
await page.click('#hubCloseBtn'); await page.waitForTimeout(150);
await openDialog();
check((await stepNow()) === 5 && await page.evaluate(() => lineSt().go === 'ok'), '關閉再開：仍是推播狀態、鎖定（內容沒變）');
await page.click('#lineNextBtn'); await page.waitForTimeout(200);
check(!(await vis('#s8Overlay.open')), '按「完成推播」：關閉視窗');
await openDialog();
await page.evaluate(() => { document.getElementById('s8Alt').value = '另一則推播'; document.getElementById('s8Alt').dispatchEvent(new Event('input', { bubbles: true })); });
await page.waitForTimeout(100);
check((await stepNow()) === 1 && await page.evaluate(() => !lineSt().prep && lineSt().go === '') && (await txt('#lineWin')).includes('這是新的一則'), '鎖定後內容被改：視為新的一則推播，回到第 1 步');
await page.evaluate(() => { document.getElementById('s8Alt').value = '測試推播標題'; document.getElementById('s8Alt').dispatchEvent(new Event('input', { bubbles: true })); });

// ===== 7. 排程推播 =====
await resetFlow();
await toStep(2);
const sw = Date.now() + 3 * 3600e3;
const ymd = ms => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10), hm = ms => new Date(ms + 8 * 3600e3).toISOString().slice(11, 16);
await page.click('#linePickSched'); await page.waitForTimeout(200);
await page.evaluate(([d, t]) => { const a = document.getElementById('lineDate'), b = document.getElementById('lineTime'); a.value = d; b.value = t; a.dispatchEvent(new Event('input', { bubbles: true })); b.dispatchEvent(new Event('input', { bubbles: true })); }, [ymd(sw), hm(sw)]);
await toStep(4);
const s4s = await page.evaluate(() => ({ kv: [...document.querySelectorAll('#lineInfoKv dd')].map(x => x.textContent), next: document.getElementById('lineNextBtn').textContent, time: document.querySelector('#lineChat .chat-time').textContent }));
check(s4s.next === '排程推播' && s4s.kv[1] === `排程　${ymd(sw).slice(5).replace('-', '/')}　${hm(sw)}` && /^(上午|下午)\d{1,2}:\d{2}$/.test(s4s.time), `第 4 步（排程）：資訊框顯示排程時間「${s4s.kv[1]}」，紅色按鈕「排程推播」，預覽時間跟著排程（${s4s.time}）`);
await page.locator('#s8Modal').screenshot({ path: path.join(SHOTS, 'wiz-7-preview-sched.png') });
await clickNext();
const sc = await page.evaluate(() => ({ kv: [...document.querySelectorAll('#lineCfmKv dd')].map(x => x.textContent), warn: [...document.querySelectorAll('#lineCfmWarn div')].map(x => x.textContent) }));
check(sc.kv[1].startsWith('排程') && sc.warn.length === 2 && sc.warn[0].includes('排程時間到就會自動推播') && sc.warn[1].includes('訊息推播 → 推播列表') && sc.warn[1].includes('取消'), `排程的確認彈窗：${sc.warn.join(' ')}`);
await page.locator('#lineCfmOverlay').screenshot({ path: path.join(SHOTS, 'wiz-7-confirm-sched.png') });
await page.waitForFunction(() => Number.isFinite(lineSt().friends));
await typeCount('287091'); await page.click('#lineCfmGo');
await page.waitForFunction(() => lineSt().go === 'ok');
const sq = reqs.sched.at(-1);
check(sq.channel === 'news' && sq.runAt === `${ymd(sw)}T${hm(sw)}:00+08:00` && sq.confirmTotal === 287091 && sq.testToken === 'ttok-news' && Array.isArray(sq.links) && sq.testers === undefined, '排程：帶新聞帳號、時間、人數、同帳號測試憑證、每格連結；沒有收件人名單');
const s5s = await page.evaluate(() => [...document.querySelectorAll('#lineStatList .row')].map(r => r.textContent));
check((await stepNow()) === 5 && s5s[0].includes('已排程') && s5s[0].includes(hm(sw)) && s5s[1].includes('推播列表') && s5s[1].includes('取消'), `第 5 步（排程）：${s5s.join(' / ')}`);
const bsch = await page.$$eval('#pushBubbles .push-bubble', bs => bs.map(b => b.querySelector('.pb-name').textContent + '｜' + b.querySelector('.pb-st').textContent));
check(bsch.some(t => /^\d\d\/\d\d新聞｜排程中$/.test(t)), `排程建立後：泡泡「訊息名稱｜排程中」→ ${bsch.join('、')}`);
await page.locator('#s8Modal').screenshot({ path: path.join(SHOTS, 'wiz-7-status-sched.png') });

// ===== 8. 測試帳號：正式推播＝群發給測試帳號的好友 =====
await resetFlow();
await toStep(2);
await page.locator('#lineAcctList .lw-op', { hasText: '測試帳號' }).click(); await page.waitForTimeout(100);
await toStep(4);
check(await page.evaluate(() => [...document.querySelectorAll('#lineInfoKv dd')][0].textContent === '測試帳號' && document.querySelector('#lineChat .chat-name').textContent === '測試帳號'), '推播帳號選測試帳號：資訊框與預覽都顯示測試帳號（版型仍是新聞）');
await clickNext();
check((await page.evaluate(() => [...document.querySelectorAll('#lineCfmWarn div')].map(x => x.textContent))).some(t => t.includes('測試帳號：只有已加入這個帳號好友的人收得到')), '確認彈窗註明：測試帳號只有已加入好友的人收得到');
await page.waitForFunction(() => Number.isFinite(lineSt().friends));
check((await page.evaluate(() => document.getElementById('lineCfmTotal').placeholder)) === '輸入 3', '確認人數是測試帳號的好友數（3）');
await page.locator('#lineCfmOverlay').screenshot({ path: path.join(SHOTS, 'wiz-8-confirm-test.png') });
await typeCount('3'); await page.click('#lineCfmGo');
await page.waitForFunction(() => lineSt().go === 'ok');
const to = reqs.send.filter(r => r.mode !== 'test').at(-1);
check(to.channel === 'test' && to.mode === undefined && to.testToken === 'ttok-test' && to.confirmTotal === 3 && to.testers === undefined, '測試帳號的正式推播：channel=test、不帶 mode（群發）、帶測試帳號自己的測試憑證與好友數');

// ===== 9. 查不到好友數、名單與狀態機細節 =====
await resetFlow();
followersNull = true;
await toStep(4);
await clickNext();
await page.waitForFunction(() => lineSt().friendsErr !== '');
check((await txt('#lineCfmErr')).includes('查不到「新聞帳號」的好友數') && await page.evaluate(() => document.getElementById('lineCfmGo').disabled && document.getElementById('lineCfmTotal').disabled), '查不到好友數：彈窗說明原因，不能確認推播');
followersNull = false;
await page.click('#lineCfmCancel');
await page.evaluate(() => { lineOpSet('王小明'); });
await page.waitForTimeout(100);
check((await stepNow()) === 3 && await page.evaluate(() => lineSt().test === '' && lineSt().testToken === ''), '在第 4 步時操作人被換掉：測試作廢並退回第 3 步，不會停在推不出去的預覽');
await page.evaluate(() => { lineOpSet('小編本人'); });
await resetFlow();
await toStep(4);
await page.evaluate(() => { lineWhoFor('news').testers = lineWhoFor('news').testers.map(t => (t.name === '小編本人' ? { ...t, name: '小編改名' } : t)); lineOpRevalidate(); lineUpdateSteps(); });
check((await stepNow()) === 3 && await page.evaluate(() => lineSt().test === ''), '權限管理把操作人改名：已測試的結果作廢並退回第 3 步');
await page.evaluate(() => { lineWhoFor('news').testers = lineWhoFor('news').testers.map(t => (t.name === '小編改名' ? { ...t, name: '小編本人' } : t)); lineUpdateSteps(); });
await resetFlow();
await page.evaluate(() => { Object.keys(lineWhoBy).forEach(k => { lineWhoBy[k] = { loaded: true, loading: false, testers: [], error: '', quota: null }; }); lineOp = ''; try { localStorage.removeItem('lineOp'); } catch (e) { /* */ } lineUpdateSteps(); });
await page.evaluate(() => { lineGoTo(1); });
await clickNext();
check((await txt('#lineOpNote')).includes('名單是空的') && (await txt('#lineOpNote')).includes('權限管理') && (await nextState()).dis, '名單是空的：說明去哪裡新增自己，下一步反灰');

// ===== 10. S8 分頁不受影響 =====
await page.click('#s8ModeS8');
check(await vis('#s8Panel') && !(await vis('#lineFoot')) && await vis('#contentBlock') && !(await vis('#lineP2')) && await vis('#qrSec'), 'S8推播分頁：沒有底部步驟列，S8 原本的步驟與欄位照舊');
await page.click('#s8CloseBtn');

check(pageErrors.length === 0, `頁面沒有 JS 錯誤${pageErrors.length ? '：' + pageErrors.join(' | ') : ''}`);
await browser.close();
console.log(failed ? `\n${failed} 項失敗` : '\n全部通過');
process.exit(failed ? 1 : 0);
