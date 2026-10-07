// 前端驗證：「排入S8」新聞與娛樂各自獨立保留進度（Playwright，Worker 全部用假回應攔截，不會連到真的 S8）
// 執行：python3 -m http.server 8960 &  然後  NODE_PATH=$(npm root -g) node test/e2e/s8-per-mode.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:8960/index.html';
const WORKER = 'https://worker.test';
let failed = 0;
const check = (c, l) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${l}`); if (!c) failed++; };
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await (await browser.newContext({ viewport: { width: 1100, height: 1500 } })).newPage();
const pageErrors = []; page.on('pageerror', e => pageErrors.push(e.message));
let createDelay = 0;
const reqs = { prepare: [], create: [] };
await page.route(`${WORKER}/**`, async route => {
  const url = new URL(route.request().url()), body = route.request().postDataJSON?.() || {};
  const json = (o, st = 200) => route.fulfill({ status: st, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(o) });
  if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' } });
  if (url.pathname === '/s8/prepare') { reqs.prepare.push(body); return json({ ok: true, org: { id: 'o', name: body.org === 'ent' ? 'TVBS娛樂頭條' : 'TVBS新聞' }, total: body.org === 'ent' ? 81334 : 286224, preview: {}, imageUrls: [], prepareToken: 'tok-' + body.org, expiresInMinutes: 20, session: null }); }
  if (url.pathname === '/s8/create') { reqs.create.push(body); if (createDelay) await new Promise(r => setTimeout(r, createDelay)); return json({ ok: true, mode: body.mode, taskId: 'task_' + body.prepareToken, status: 'draft', phase: 'draft', total: 1, orgId: 'o', scheduleAt: body.scheduleAt }); }
  return json({ error: `unexpected ${url.pathname}` }, 404);
});
await page.addInitScript(() => {
  sessionStorage.setItem('labAuth', JSON.stringify({ token: 't', expiresAt: Date.now() + 3600e3 }));
  sessionStorage.setItem('s8Session', 'opaque'); sessionStorage.setItem('s8Scope', 'insightark-mcp:read insightark-mcp:write');
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => {} }, configurable: true });
});
await page.goto(`${BASE}?imageProxy=${encodeURIComponent(WORKER)}`);
await page.evaluate(() => setLab(true));
const vis = async sel => !(await page.locator(sel).isHidden());
const fillUrls = () => page.evaluate(() => { s8AltByMode[mode] = '測試推播標題'; pages.forEach(pg => pg.cards.forEach((c, i) => { c.url = `https://example.com/${mode}/${i}`; })); });
const gotoMode = async m => { await page.click(`.mode-tab[data-mode="${m}"]`); await page.waitForTimeout(250); await fillUrls(); };
const openS8 = async n => { await page.evaluate(() => (s8Md = 's8', openS8Dialog())); await page.waitForFunction(c => document.querySelectorAll('#s8Stage .s8-cell').length === c && (s8State.images.length === 2 || s8State.imgFailed), n, { timeout: 60000 }); await page.waitForTimeout(200); };
const closeS8 = async () => { await page.click('#s8CloseBtn'); await page.waitForTimeout(150); };
const setConfirm = v => page.evaluate(x => { const i = document.getElementById('s8ConfirmTotal'); i.value = x; i.dispatchEvent(new Event('input', { bubbles: true })); }, v);
const sendData = async () => { await page.click('#s8PrepBtn'); await page.waitForFunction(() => /傳送完成/.test(document.getElementById('s8PrepMsg').textContent)); };

// ===== 新聞：傳送 → 選存成草稿 → 打對人數 =====
await gotoMode('news');
await openS8(6);
check((await page.textContent('#s8Account')) === 'TVBS新聞', '新聞：視窗帳號是 TVBS新聞');
await page.fill('#s8Name', '261007早（新聞）');   // 名稱要在傳送前改（傳送後改任何內容都會讓傳送結果作廢）
await sendData();
await page.click('#s8PickDraft');
await setConfirm('286224');
const newsImg = await page.evaluate(() => s8State.images[0].url);
check(await vis('#s8Step3') && !(await vis('#s8Step1')), '新聞：進行到步驟 3（步驟 1 已隱藏）');
await closeS8();

// ===== 娛樂：開起來是全新的，不受新聞影響 =====
await gotoMode('ent');
await openS8(4);
check((await page.textContent('#s8Account')) === 'TVBS娛樂頭條', '娛樂：視窗帳號是 TVBS娛樂頭條');
check(await vis('#s8Step1') && !(await vis('#s8Step2')) && (await page.inputValue('#s8ConfirmTotal')) === '', '娛樂：從步驟 1 開始，沒有帶到新聞的進度');
check((await page.inputValue('#s8Name')) !== '261007早（新聞）', '娛樂：群發名稱不是新聞改過的那個');
await page.fill('#s8Name', '261007早（娛樂）');
await sendData();
check((await page.textContent('#s8PrepMsg')).includes('81,334'), '娛樂：傳送後人數是娛樂的 81,334');
await page.click('#s8PickSched');
const entTime = await page.evaluate(() => ['s8Date', 's8Time'].map(id => document.getElementById(id).value).join());
await closeS8();

// ===== 回到新聞：進度還在 =====
await gotoMode('news');
await openS8(6);
check((await page.inputValue('#s8Name')) === '261007早（新聞）', '新聞：群發名稱還在');
check(await page.evaluate(() => document.getElementById('s8PickDraft').classList.contains('active')), '新聞：存成草稿的選擇還在');
check((await page.inputValue('#s8ConfirmTotal')) === '286224' && await vis('#s8Step3') && !(await vis('#s8Step1')), '新聞：確認人數與步驟進度還在（步驟 3）');
check((await page.textContent('#s8PrepMsg')).includes('286,224'), '新聞：傳送結果還在（可發送 286,224 人）');
check((await page.evaluate(() => s8State.images[0].url)) === newsImg, '新聞：兩張圖沿用之前做好的，不用重新產生');
check(reqs.prepare.length === 2, '回來後沒有重新傳送（新聞、娛樂各傳過一次，共 2 次）');
await closeS8();

// ===== 再看娛樂：也還在，而且是排程 =====
await gotoMode('ent');
await openS8(4);
check((await page.inputValue('#s8Name')) === '261007早（娛樂）' && await page.evaluate(() => document.getElementById('s8PickSched').classList.contains('active')), '娛樂：名稱與「設定排程」選擇還在');
check((await page.evaluate(() => ['s8Date', 's8Time'].map(id => document.getElementById(id).value).join())) === entTime, '娛樂：排程時間還在');
check((await page.textContent('#s8PrepMsg')).includes('81,334') && (await page.getAttribute('#s8ConfirmTotal', 'placeholder')) === '輸入 81,334', '娛樂：傳送結果與人數提示是娛樂自己的');
await closeS8();

// ===== 畫面內容改了：舊進度作廢 =====
await gotoMode('news');
await page.evaluate(() => { pages[0].cards[0].line1 = '改過的標題'; });
await openS8(6);
check(await vis('#s8Step1') && !(await vis('#s8Step2')) && (await page.inputValue('#s8ConfirmTotal')) === '', '新聞畫面內容改過後再開：從頭開始（舊進度作廢）');
await sendData();
await page.click('#s8PickDraft');
await setConfirm('286224');
await page.click('#s8CopyName');
await page.waitForFunction(() => !document.getElementById('s8Step5').hidden);

// ===== 建立中不能關視窗 =====
createDelay = 900;
await page.click('#s8CreateBtn');
await page.waitForTimeout(200);
await page.click('#s8CloseBtn');
check(await page.evaluate(() => document.getElementById('s8Overlay').classList.contains('open')), '建立中：按關閉不會關掉視窗（避免結果跑到別的版型）');
await page.waitForFunction(() => document.getElementById('s8NoteOverlay').classList.contains('open'));
createDelay = 0;
await page.click('#s8NoteOk');
check(reqs.create.length === 1 && reqs.create[0].prepareToken === 'tok-news', '建立送出的是新聞自己的預覽');
await closeS8();
// 已建立完成的進度不帶回來
await openS8(6);
check(await vis('#s8Step1') && !(await vis('#s8Step5')), '建立完成後再開：重新開始，不會停在上次的綠色按鈕');
// ===== 點步驟圓圈可以回頭 =====
await sendData();
await page.click('#s8PickSched');
await setConfirm('286224');
check(await vis('#s8Step3'), '（回頭測試）先走到步驟 3');
await page.click('#s8Dot2');
check((await page.evaluate(() => document.getElementById('s8PickDraft').classList.contains('active') || document.getElementById('s8PickSched').classList.contains('active'))) === false && await vis('#s8Step2') && !(await vis('#s8Step3')), '點圓圈 2：回到「選擇方式」，選項與後面的進度清掉');
await page.click('#s8PickDraft');
await setConfirm('286224');
await page.click('#s8CopyName');
await page.waitForFunction(() => !document.getElementById('s8Step5').hidden);
await page.click('#s8Dot3');
check((await page.inputValue('#s8ConfirmTotal')) === '' && await vis('#s8Step3') && !(await vis('#s8Step5')), '點圓圈 3：回到「確認人數」，保留草稿選擇、清掉人數與複製');
await page.click('#s8Dot1');
check(await vis('#s8Step1') && !(await vis('#s8Step2')) && await page.isHidden('#s8PrepOut'), '點圓圈 1：整個重來');

check(pageErrors.length === 0, `頁面沒有 JS 錯誤${pageErrors.length ? '：' + pageErrors.join(' | ') : ''}`);
await browser.close();
console.log(failed ? `\n${failed} 項失敗` : '\n全部通過');
process.exit(failed ? 1 : 0);
