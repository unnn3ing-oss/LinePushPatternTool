// 前端驗證：S8 視窗內的「LINE 官方帳號直接發送（試驗）」區塊（Playwright，Worker 全部用假回應攔截，不會連到真的 LINE）
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

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await browser.newContext({ viewport: { width: 1100, height: 1500 } });
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));
const dialogs = []; let dialogAnswer = true;
page.on('dialog', async d => { dialogs.push(d.message()); await (dialogAnswer ? d.accept() : d.dismiss()); });

// ---- 假 Worker ----
const reqs = { status: [], prepare: [], validate: [], send: [] };
let validateOk = true, sendFail = '', followers = 287091;
await page.route(`${WORKER}/**`, async route => {
  const url = new URL(route.request().url());
  const body = route.request().postDataJSON?.() || {};
  const json = (obj, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(obj) });
  if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' } });
  if (url.pathname === '/line/status') { reqs.status.push(body); return json({ ok: true, channel: body.channel, r2Ready: true, bot: { displayName: body.channel === 'test' ? '測試官方帳號' : 'TVBS新聞', basicId: '@abc' }, quota: { type: 'limited', value: 100000000 }, used: 17266349, followers: body.channel === 'test' ? null : { status: 'ready', followers, targetedReaches: followers - 5, blocks: 5 }, notes: [] }); }
  if (url.pathname === '/line/prepare') { reqs.prepare.push(body); return json({ ok: true, id: 'prep' + reqs.prepare.length, prepareToken: 'ptok' + reqs.prepare.length, expiresInMinutes: 30, pages: body.pages.length }); }
  if (url.pathname === '/line/validate') { reqs.validate.push(body); return json(validateOk ? { ok: true, valid: true, pages: 2 } : { ok: true, valid: false, message: 'LINE 回應 400：baseUrl 不對' }); }
  if (url.pathname === '/line/send') {
    reqs.send.push(body);
    if (sendFail === '403') return json({ error: '正式帳號發送尚未開啟（Worker 沒有設定 LINE_ALLOW_OFFICIAL=1）。沒有發送任何東西。' }, 403);
    const official = body.channel !== 'test';
    return json({ ok: true, channel: body.channel, official, sentAt: '2026-10-07T12:00:00+08:00', requestId: 'req-xyz', retryKey: body.retryKey, friends: official ? followers : 1, pages: 2, ...(official ? {} : { testToken: 'ttok' }) });
  }
  return json({ error: `unexpected ${url.pathname}` }, 404);
});

await page.addInitScript(() => { sessionStorage.setItem('labAuth', JSON.stringify({ token: 'lab-token', expiresAt: Date.now() + 3600e3 })); });
await page.goto(`${BASE}?imageProxy=${encodeURIComponent(WORKER)}`);
await page.evaluate(() => { setLab(true); });
async function openDialog() {
  await page.evaluate(() => { s8AltByMode[mode] = '測試推播標題'; openS8Dialog(); });
  await page.waitForFunction(() => document.querySelectorAll('#s8Stage .s8-cell').length === 6, null, { timeout: 60000 });
  await page.evaluate(() => { s8State.urls.forEach((row, p) => row.forEach((_, i) => { s8State.urls[p][i] = `https://example.com/p${p + 1}/n${i + 1}?utm_source=x`; })); s8Refresh(); });
  await page.waitForFunction(() => document.getElementById('s8Errs').children.length === 0, null, { timeout: 5000 });
}
const txt = id => page.textContent(id);
const bg = id => page.evaluate(i => getComputedStyle(document.getElementById(i)).backgroundColor, id);

await openDialog();
check(await page.isVisible('#lineBox') && !(await page.evaluate(() => document.getElementById('lineBox').open)), 'LINE 區塊在 S8 視窗內，預設收合');
await page.evaluate(() => { document.getElementById('lineBox').open = true; document.getElementById('lineBox').scrollIntoView(); });
check((await txt('#lineChOfficialTxt')) === '正式帳號（TVBS新聞）', '正式帳號的選項寫出目前版型的帳號名稱');
check(await page.isChecked('#lineChTest') && await page.isHidden('#lineConfirmRow'), '預設是測試帳號，且不需要輸入好友數');
check(await page.isDisabled('#lineSendBtn'), '還沒上傳前「發送」是關的');
check((await txt('.line-warn')).includes('沒有草稿、沒有排程') && (await txt('.line-warn')).includes('無法收回'), '醒目提醒：沒有草稿、沒有排程、無法收回');

// 檢查帳號
await page.click('#lineStatusBtn');
await page.waitForFunction(() => /測試官方帳號/.test(document.getElementById('lineOut').textContent));
let out = await txt('#lineOut');
check(reqs.status[0].channel === 'test' && out.includes('上限 100,000,000') && out.includes('已用 17,266,349') && out.includes('剩 82,733,651') && out.includes('已綁定'), '檢查帳號：顯示名稱、額度、已用、剩餘、R2 狀態');
check(out.includes('好友數：查不到'), '好友數查不到時明說（不是假數字）');

// 上傳圖片並檢查格式
await page.click('#linePrepBtn');
await page.waitForFunction(() => /LINE 格式檢查通過/.test(document.getElementById('lineOut').textContent), null, { timeout: 60000 });
const pb = reqs.prepare[0];
check(pb.org === 'news' && pb.altText === '測試推播標題' && pb.pages.length === 2, '上傳內容：版型、推播標題、兩頁');
check(pb.pages.every(p => Object.keys(p.images).join() === '1040' && p.images['1040'].length > 100), '每頁只送 1040 這一張（Worker 對 5 種寬度網址都回這張，不經過我們縮圖）');
check(pb.pages.every(p => p.width === 1040 && p.height === 800 && p.buttons.length === 6 && p.buttons.every(b => /^\d+(\.\d+)?%$/.test(b.x) && /^https:\/\/example\.com\//.test(b.url))), '每頁 1040×800、6 個點擊區塊（百分比座標、連結）');
const sameBytes = await page.evaluate(async (b64) => { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); const mine = new Uint8Array(await s8State.images[0].blob.arrayBuffer()); return mine.length === u.length && mine.every((v, i) => v === u[i]); }, pb.pages[0].images['1040']);
check(sameBytes, '送出的 1040 圖與「排入 S8」預覽／傳給 S8 的那張位元組完全相同');
check(reqs.validate.length === 1 && reqs.validate[0].channel === 'test' && reqs.validate[0].prepareToken === 'ptok1', '上傳後立刻請 LINE 檢查格式（validate）');
check(reqs.send.length === 0, '到這一步沒有發送任何東西');
check(!(await page.isDisabled('#lineSendBtn')), '檢查通過後「發送」才可以按');

// 測試帳號發送：取消、確認
dialogAnswer = false;
await page.click('#lineSendBtn');
await page.waitForFunction(() => /已取消/.test(document.getElementById('lineOut').textContent));
check(reqs.send.length === 0 && dialogs.at(-1).includes('測試帳號') && dialogs.at(-1).includes('立刻發出'), '按發送先跳確認視窗；取消就沒有發送');
dialogAnswer = true;
await page.click('#lineSendBtn');
await page.waitForFunction(() => /已發送到測試帳號/.test(document.getElementById('lineOut').textContent));
check(reqs.send.length === 1 && reqs.send[0].channel === 'test' && /^[0-9a-f-]{36}$/.test(reqs.send[0].retryKey) && reqs.send[0].prepareToken === 'ptok1', '發送：帶 channel、UUID retryKey、prepareToken');
check(await page.isDisabled('#lineSendBtn') && (await txt('#lineSendBtn')).includes('已發送'), '發送成功後按鈕鎖住，不會重複發送');
check((await bg('lineOut')) === 'rgb(220, 252, 231)', '成功訊息是綠底');
await page.screenshot({ path: path.join(SHOTS, 'line-1-test-sent.png'), fullPage: false });

// 正式帳號
await page.click('#lineChOfficial');
check(await page.isVisible('#lineConfirmRow'), '切到正式帳號會出現「輸入好友數確認」');
await page.click('#lineStatusBtn');
await page.waitForFunction(() => /287,091 人/.test(document.getElementById('lineOut').textContent));
check((await page.getAttribute('#lineConfirm', 'placeholder')).includes('287,091'), '好友數確認欄位的提示字顯示 LINE 回報的好友數');
check(!(await page.isDisabled('#lineSendBtn')), '同一份內容已先發測試帳號，正式帳號才可發送');
await page.fill('#lineConfirm', '100');
await page.click('#lineSendBtn');
await page.waitForFunction(() => /已發送到正式帳號/.test(document.getElementById('lineOut').textContent));
const sent2 = reqs.send[1];
check(sent2 && sent2.channel === 'news' && sent2.testToken === 'ttok' && sent2.confirmTotal === 100, '正式帳號：帶 testToken 與使用者輸入的好友數（由 Worker 檢查是否相符）');
await page.screenshot({ path: path.join(SHOTS, 'line-2-official.png'), fullPage: false });

// 內容更動 → 作廢
await page.evaluate(() => { s8State.urls[0][0] = 'https://example.com/changed'; s8Refresh(); });
await page.waitForFunction(() => /內容有更動/.test(document.getElementById('lineOut').textContent));
check(await page.isDisabled('#lineSendBtn'), '改了連結之後，上傳的資料作廢、發送鎖住');

// 格式不對
validateOk = false;
await page.click('#linePrepBtn');
await page.waitForFunction(() => /LINE 說格式不對/.test(document.getElementById('lineOut').textContent), null, { timeout: 60000 });
check(await page.isDisabled('#lineSendBtn') && (await bg('lineOut')) === 'rgb(254, 243, 199)', 'LINE 說格式不對：黃底、發送維持鎖住，且說明沒有發送');

// 新聞／娛樂各自獨立
validateOk = true;
check(await page.evaluate(() => lineByMode.news && lineByMode.news.prep === null), '新聞版型的準備資料已作廢');
check(pageErrors.length === 0, `頁面沒有 JS 錯誤 ${pageErrors.join(' | ')}`);

await browser.close();
console.log(failed ? `\n${failed} 項失敗` : '\n全部通過');
process.exit(failed ? 1 : 0);
