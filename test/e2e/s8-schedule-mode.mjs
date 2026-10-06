// 前端驗證：S8 任務包視窗「直接建立」區的 draft／schedule 模式（Playwright，Worker 全部用假回應攔截，不會連到真的 S8）。
// 執行：
//   python3 -m http.server 8960 &            # 在專案根目錄
//   NODE_PATH=$(npm root -g) node test/e2e/s8-schedule-mode.mjs
// 截圖輸出到 test/e2e/screenshots/
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

const pad2 = n => String(n).padStart(2, '0');
const taipeiIso = ms => new Date(ms + 8 * 3600e3).toISOString().slice(0, 19) + '+08:00';

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await browser.newContext({ viewport: { width: 1100, height: 1300 } });
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));

// ---- 假 Worker ----
const reqs = { create: [], pause: [], prepare: [] };
let lastScheduleAt = '';
await page.route(`${WORKER}/**`, async route => {
  const url = new URL(route.request().url());
  const body = route.request().postDataJSON?.() || {};
  const json = (obj, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(obj) });
  if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' } });
  if (url.pathname === '/s8/prepare') { reqs.prepare.push(body); return json({ ok: true, org: { id: 'org1', name: 'TVBS新聞' }, total: 1234, preview: { previewUrl: 'https://s8.example/preview/abc' }, imageUrls: [], prepareToken: 'tok', expiresInMinutes: 20, session: null }); }
  if (url.pathname === '/s8/create') {
    reqs.create.push(body);
    if (body.mode === 'schedule') { lastScheduleAt = taipeiIso(Date.now() + 24 * 3600e3); return json({ ok: true, mode: 'schedule', taskId: 'task_sched01', scheduleAt: lastScheduleAt, status: 'scheduled', phase: 'scheduled', allowedActions: ['pause', 'delete'], total: 1234, orgId: 'org1' }); }
    return json({ ok: true, mode: 'draft', taskId: 'task_draft01', status: 'draft', phase: 'draft', scheduledWas: taipeiIso(Date.now() + 24 * 3600e3), total: 1234, orgId: 'org1' });
  }
  if (url.pathname === '/s8/pause') { reqs.pause.push(body); return json({ ok: true, taskId: body.taskId, status: 'draft', phase: 'draft' }); }
  return json({ error: `unexpected ${url.pathname}` }, 404);
});

// ---- 進入試驗功能並開啟 S8 視窗 ----
await page.addInitScript(() => {
  sessionStorage.setItem('labAuth', JSON.stringify({ token: 'lab-token', expiresAt: Date.now() + 3600e3 }));
  sessionStorage.setItem('s8Session', 'opaque');
  sessionStorage.setItem('s8Scope', 'insightark-mcp:read insightark-mcp:write');
});
await page.goto(`${BASE}?imageProxy=${encodeURIComponent(WORKER)}`);
await page.evaluate(() => { setLab(true); });

async function openDialog() {
  await page.evaluate(() => { pushTitleInput.value = '測試推播標題'; openS8Dialog(); });
  await page.waitForFunction(() => document.querySelectorAll('#s8Imgs img').length === 2, null, { timeout: 60000 });
  await page.evaluate(() => {
    document.querySelectorAll('.s8-url').forEach((inp, i) => { inp.value = `https://example.com/n${i}`; });
    s8Refresh();
  });
  await page.waitForFunction(() => document.getElementById('s8Errs').children.length === 0, null, { timeout: 5000 });
}
async function prepare() {
  await page.click('#s8PrepBtn');
  await page.waitForSelector('#s8ConfirmRow:not([hidden])');
}
const shot = async (name, sel = '.s8-modal') => {
  const el = page.locator(sel).first();
  await el.evaluate(n => { n.scrollTop = n.scrollHeight; });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });
};
const dialogs = [];
let dialogAnswer = true;
page.on('dialog', async d => { dialogs.push(d.message()); await (dialogAnswer ? d.accept() : d.dismiss()); });

// ===== 1. 預設是「建立後暫停成草稿」 =====
await openDialog();
check(await page.isChecked('#s8ModeDraft'), '預設選項是「建立後暫停成草稿」');
check(!(await page.isChecked('#s8ModeSchedule')), '「保留為 +1 天排程」預設未選');
await prepare();
check((await page.textContent('#s8CreateBtn')).includes('建立草稿（建立後立刻暫停）'), 'draft：按鈕文字是「建立草稿（建立後立刻暫停）」');
check(await page.isHidden('#s8SchedWarn'), 'draft：沒有紅字發送警告');
check(await page.isHidden('#s8RetryPause'), '沒有失敗時「重試暫停成草稿」隱藏');
check(await page.isDisabled('#s8CreateBtn'), '尚未輸入人數 → 按鈕停用');
await shot('1-default-draft');

// ===== 2. draft 建立：送 mode:'draft'，沒有橫幅、沒有 confirm =====
await page.fill('#s8ConfirmTotal', '1234');
check(await page.isEnabled('#s8CreateBtn'), 'draft：輸入正確人數後按鈕啟用');
await page.click('#s8CreateBtn');
await page.waitForFunction(() => /草稿已建立/.test(document.getElementById('s8CreateOut').textContent));
check(reqs.create.length === 1 && reqs.create[0].mode === 'draft', "draft：送出 mode:'draft'");
check(dialogs.length === 0, 'draft：不跳確認視窗（行為與以前相同）');
check(await page.locator('.s8-banner').count() === 0, 'draft：不出現紅字橫幅');
await shot('2-draft-created');

// ===== 3. 切到排程：人數仍要輸入；按鈕與確認文字寫出確切時間 =====
await page.click('#s8CloseBtn');
await openDialog();
check(await page.isChecked('#s8ModeDraft'), '重新開啟視窗後選項回到預設「暫停成草稿」');
await prepare();
await page.check('#s8ModeSchedule');
const btnText = await page.textContent('#s8CreateBtn');
const m = btnText.match(/將在 (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) 實際發送給 1,234 人/);
check(!!m, `schedule：按鈕文字寫出「將在 YYYY-MM-DD HH:mm 實際發送給 1,234 人」→ ${btnText}`);
if (m) {
  const shown = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - 8 * 3600e3;   // 台北時間 → UTC ms
  const diffH = (shown - Date.now()) / 3600e3;
  check(diffH > 23.9 && diffH < 24.1, `schedule：顯示時間約為現在 +24 小時（實際 +${diffH.toFixed(3)} 小時）`);
}
check(/將在 .* 實際發送給 1,234 人/.test(await page.textContent('#s8SchedWarn')) && await page.isVisible('#s8SchedWarn'), 'schedule：顯示紅字警告');
check(await page.isDisabled('#s8CreateBtn'), 'schedule：沒輸入人數 → 按鈕停用');
await page.fill('#s8ConfirmTotal', '1233');
check(await page.isDisabled('#s8CreateBtn'), 'schedule：人數輸入錯誤 → 按鈕停用');
await page.fill('#s8ConfirmTotal', '1,234');
check(await page.isEnabled('#s8CreateBtn'), 'schedule：輸入正確人數 → 按鈕啟用');
await shot('3-schedule-selected');

// ===== 4. 確認視窗：取消 → 不送出；確認 → 送出 mode:'schedule'，沒有任何自訂時間 =====
dialogs.length = 0; dialogAnswer = false;
await page.click('#s8CreateBtn');
await page.waitForTimeout(300);
check(dialogs.length === 1 && /不會暫停/.test(dialogs[0]) && /將在 \d{4}-\d{2}-\d{2} \d{2}:\d{2} 實際發送給 1,234 人/.test(dialogs[0]), `schedule：確認視窗寫出確切發送時間與人數 → ${JSON.stringify(dialogs[0])}`);
check(reqs.create.length === 1, 'schedule：按「取消」不會送出任何建立請求');
dialogAnswer = true;
await page.click('#s8CreateBtn');
await page.waitForSelector('.s8-banner');
check(reqs.create.length === 2 && reqs.create[1].mode === 'schedule', "schedule：確認後送出 mode:'schedule'");
check(!('scheduleAt' in reqs.create[1]) && !('recipients' in reqs.create[1]), 'schedule：請求不含 scheduleAt／recipients（時間與對象都由 Worker 決定）');

// ===== 5. 成功橫幅 =====
const banner = page.locator('.s8-banner').first();
const bannerText = await banner.textContent();
const want = `將在 ${lastScheduleAt.replace('T', ' ').slice(0, 16)} 實際發送給 1,234 人`;
check(bannerText.includes(want), `橫幅以 Worker 回傳的確切時間顯示 → ${want}`);
check(bannerText.includes('task_sched01') && bannerText.includes('scheduled'), '橫幅列出 taskId 與狀態');
check((await banner.evaluate(n => getComputedStyle(n).backgroundColor)) === 'rgb(185, 28, 28)', '橫幅是紅底');
check(await banner.getByRole('button', { name: '暫停成草稿' }).isVisible(), '橫幅有「暫停成草稿」按鈕');
await shot('4-schedule-banner');

// ===== 6. 關閉視窗時還有保留中的排程 → 先確認 =====
dialogs.length = 0; dialogAnswer = false;
await page.click('#s8CloseBtn');
await page.waitForTimeout(200);
check(dialogs.length === 1 && /仍會照時間發送/.test(dialogs[0]), '關閉視窗：有未暫停的排程時會先提醒');
check(await page.evaluate(() => document.getElementById('s8Overlay').classList.contains('open')), '關閉視窗：按取消後視窗仍開著');
dialogAnswer = true;

// ===== 7. 暫停成草稿：走現有 /s8/pause =====
await banner.getByRole('button', { name: '暫停成草稿' }).click();
await page.waitForSelector('.s8-banner.paused');
check(reqs.pause.length === 1 && reqs.pause[0].taskId === 'task_sched01' && reqs.pause[0].org === 'news', '暫停：呼叫 /s8/pause，帶 org 與 taskId');
check((await banner.textContent()).includes('已暫停成草稿') && await banner.locator('button').count() === 0, '暫停：橫幅改成已暫停，按鈕消失');
await shot('5-schedule-paused');

dialogs.length = 0;
await page.click('#s8CloseBtn');
await page.waitForTimeout(200);
check(dialogs.length === 0 && !(await page.evaluate(() => document.getElementById('s8Overlay').classList.contains('open'))), '暫停後關閉視窗：不再提醒，視窗關閉');

check(pageErrors.length === 0, `頁面沒有 JS 錯誤 ${pageErrors.join(' | ')}`);
await browser.close();
console.log(failed ? `\n${failed} 項失敗` : '\n全部通過');
process.exit(failed ? 1 : 0);
