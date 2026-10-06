// 前端驗證：S8 視窗「連結預覽（頁籤＋點格子看完整連結）」與「傳送資料給S8」五個步驟（Playwright，Worker 全部用假回應攔截，不會連到真的 S8）
// 執行：
//   python3 -m http.server 8960 &            # 在專案根目錄
//   NODE_PATH=$(npm root -g) node test/e2e/s8-steps.mjs
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
const taipeiParts = ms => { const x = new Date(ms + 8 * 3600e3); return { y: x.getUTCFullYear(), mo: x.getUTCMonth() + 1, d: x.getUTCDate(), h: x.getUTCHours(), mi: x.getUTCMinutes() }; };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await browser.newContext({ viewport: { width: 1100, height: 1500 } });
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));

// ---- 假 Worker ----
const reqs = { create: [], pause: [], prepare: [] };
let prepareFails = false;
await page.route(`${WORKER}/**`, async route => {
  const url = new URL(route.request().url());
  const body = route.request().postDataJSON?.() || {};
  const json = (obj, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(obj) });
  if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' } });
  if (url.pathname === '/s8/prepare') {
    reqs.prepare.push(body);
    if (prepareFails) return json({ error: 'S8 暫時無法使用' }, 502);
    return json({ ok: true, org: { id: 'org1', name: 'TVBS新聞' }, total: 1234, preview: { previewUrl: 'https://s8.example/preview/abc' }, imageUrls: [], prepareToken: 'tok', expiresInMinutes: 20, session: null });
  }
  if (url.pathname === '/s8/create') {
    reqs.create.push(body);
    if (body.mode === 'schedule') return json({ ok: true, mode: 'schedule', taskId: 'task_sched01', scheduleAt: body.scheduleAt, status: 'scheduled', phase: 'scheduled', allowedActions: ['pause', 'delete'], total: 1234, orgId: 'org1' });
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
  window.__opened = [];
  window.open = (u) => { window.__opened.push(u); return null; };
});
await page.goto(`${BASE}?imageProxy=${encodeURIComponent(WORKER)}`);
await page.evaluate(() => { setLab(true); });

async function openDialog() {
  await page.evaluate(() => { pushTitleInput.value = '測試推播標題'; openS8Dialog(); });
  await page.waitForFunction(() => document.querySelectorAll('#s8Stage .s8-cell').length === 6, null, { timeout: 60000 });
  await page.evaluate(() => {
    s8State.urls.forEach((row, p) => row.forEach((_, i) => { s8State.urls[p][i] = `https://example.com/p${p + 1}/n${i + 1}?utm_source=x`; }));
    s8Refresh();
  });
  await page.waitForFunction(() => document.getElementById('s8Errs').children.length === 0, null, { timeout: 5000 });
}
const shot = async name => page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });
const vis = async id => !(await page.locator(id).isHidden());
const dialogs = [];
let dialogAnswer = true;
page.on('dialog', async d => { dialogs.push(d.message()); await (dialogAnswer ? d.accept() : d.dismiss()); });

check(await page.evaluate(() => document.getElementById('labToggle').title === 'S8串接測試'), '頂部「試驗功能」滑過提示是「S8串接測試」');

// ===== 1. 預覽：頁籤與點格子看完整連結 =====
await openDialog();
check((await page.locator('.s8-ptab').count()) === 2 && (await page.textContent('.s8-ptab.active')) === '第 1 頁', '預覽上方有「第 1 頁／第 2 頁」切換，預設第 1 頁');
check((await page.locator('#s8Stage img').count()) === 1, '預覽區一次只顯示一張圖');
check(await page.isDisabled('#s8CellUrl'), '還沒點格子：完整連結字框停用');
await page.locator('#s8Stage .s8-cell').nth(1).click();
check((await page.inputValue('#s8CellUrl')) === 'https://example.com/p1/n2?utm_source=x', '點第 1 頁第 2 格：下方顯示該格完整連結');
check((await page.locator('#s8Stage .s8-cell.sel').count()) === 1, '被點的格子有選取標示');
check((await page.textContent('#s8LinkLbl')).includes('第 1 頁') && (await page.textContent('#s8LinkLbl')).includes('項目2'), '字框上方標出「第 1 頁 項目2」');
await page.click('.s8-ptab[data-sp="1"]');
check((await page.textContent('.s8-ptab.active')) === '第 2 頁', '切到第 2 頁');
check(await page.isDisabled('#s8CellUrl') && (await page.inputValue('#s8CellUrl')) === '', '換頁後選取清空');
await page.locator('#s8Stage .s8-cell').nth(4).click();
check((await page.inputValue('#s8CellUrl')) === 'https://example.com/p2/n5?utm_source=x', '點第 2 頁第 5 格：顯示該格完整連結');
await page.fill('#s8CellUrl', 'https://example.com/changed');
check(await page.evaluate(() => s8Collect().pages[1].cells[4].url) === 'https://example.com/changed', '在字框修改連結會更新該格');
await page.fill('#s8CellUrl', '');
check((await page.locator('#s8Stage .s8-cell.bad').count()) === 1 && (await page.locator('#s8Errs li').count()) >= 1, '清空連結：該格標紅並列出錯誤');
await page.fill('#s8CellUrl', 'https://example.com/p2/n5?utm_source=x');
check(await page.locator('#s8Imgs, #s8Pages, .s8-url, .s8-cap').count() === 0, '舊的「兩則連結清單」與「兩張圖」區塊已移除');
check(await page.locator('.s8-note').count() === 0, '最上方舊說明已移除');
check((await page.textContent('#s8Title')) === '排入 S8', '視窗標題是「排入 S8」');
check(await page.locator('#s8CopyBtn, #s8DownloadBtn, #s8Prompt').count() === 0 && !(await page.textContent('.s8-modal')).includes('複製給 Claude 的指令') && !(await page.textContent('.s8-modal')).includes('下載兩張圖'), '「複製給 Claude 的指令」「下載兩張圖」與完整指令區已移除，只剩「關閉」');
check(!(await page.textContent('.s8-modal')).includes('需要先在右上角「S8」視窗升級授權。流程'), '「傳送資料給S8」下方的說明已移除');
await shot('s8-1-preview');

// ===== 2. 步驟顯示：一開始只有步驟 1 =====
check(await vis('#s8Step1') && !(await vis('#s8Step2')) && !(await vis('#s8Step3')) && !(await vis('#s8Step4')) && !(await vis('#s8Step5')), '一開始只看得到步驟 1');
check((await page.textContent('#s8PrepBtn')) === '傳送資料', '步驟 1 按鈕是「傳送資料」');
check(await page.evaluate(() => { const b = getComputedStyle(document.getElementById('s8PrepBtn')); return b.backgroundColor !== 'rgba(0, 0, 0, 0)' && /^rgb\(22, 163, 74\)$/.test(b.backgroundColor); }), '步驟 1 按鈕是綠色');
check((await page.textContent('#s8Step1 > i')) === '1', '步驟 1 前面有圓圈數字');

// ===== 3. 傳送失敗：下方顯示簡單狀態，沒有後續步驟 =====
prepareFails = true;
await page.click('#s8PrepBtn');
await page.waitForFunction(() => /傳送失敗/.test(document.getElementById('s8PrepMsg').textContent));
check((await page.textContent('#s8PrepMsg')).startsWith('✗ 傳送失敗') && await page.isHidden('#s8PreviewBtn') && !(await vis('#s8Step2')), '失敗：顯示「傳送失敗」，沒有預覽按鈕、不出現步驟 2');
prepareFails = false;

// ===== 4. 傳送成功：狀態＋「開啟S8預覽」按鈕 =====
await page.click('#s8PrepBtn');
await page.waitForFunction(() => /傳送完成/.test(document.getElementById('s8PrepMsg').textContent));
check((await page.textContent('#s8PrepMsg')).includes('1,234 人'), '成功：顯示「傳送完成」與可發送人數');
check(await page.isVisible('#s8PreviewBtn') && (await page.textContent('#s8PreviewBtn')) === '開啟S8預覽', '成功：出現「開啟S8預覽」按鈕');
await page.click('#s8PreviewBtn');
check((await page.evaluate(() => window.__opened)).includes('https://s8.example/preview/abc'), '按「開啟S8預覽」會開啟 S8 預覽網址');
check(reqs.prepare.length === 2 && reqs.prepare[1].pages.length === 2 && reqs.prepare[1].pages[0].buttons.length === 6 && reqs.prepare[1].pages[0].buttons[1].url === 'https://example.com/p1/n2?utm_source=x', '傳送內容：兩頁、每頁 6 格、連結用目前字框的值');
check(await vis('#s8Step2') && !(await vis('#s8Step3')), '成功後出現步驟 2，步驟 3 還沒出現');
await page.waitForTimeout(600);
const lineOf = id => page.evaluate(i => { const e = document.getElementById(i); return { linked: e.classList.contains('linked'), done: e.classList.contains('done'), track: getComputedStyle(e, '::before').transform, fill: getComputedStyle(e, '::after').transform }; }, id);
const scaleY = t => { const m = String(t).match(/matrix\(([^)]+)\)/); return m ? Number(m[1].split(',')[3]) : 0; };
let l1 = await lineOf('s8Step1');
check(l1.linked && l1.done && scaleY(l1.track) === 1 && scaleY(l1.fill) === 1, '步驟 1→2 有連線：灰線長出、步驟 1 完成後綠色填滿（動畫跑完）');
check(!(await lineOf('s8Step2')).linked, '最後一個可見步驟（目前是步驟 2）後面沒有連線');
check(await page.evaluate(() => { const t = document.getElementById('s8Ptabs'); return t.classList.contains('seg-track') && !!t.querySelector('.seg-knob'); }), '頁籤與頁面上方相同：capsule 軌道＋滑動旋鈕');
check((await page.textContent('#s8PickDraft')) === '存成草稿' && (await page.textContent('#s8PickSched')) === '設定排程時間', '步驟 2 兩個按鈕：存成草稿／設定排程時間');
const gap = await page.evaluate(() => { const a = document.getElementById('s8PickDraft').getBoundingClientRect(), b = document.getElementById('s8PickSched').getBoundingClientRect(); return b.left - a.right; });
check(gap >= 8, `兩個按鈕之間有間距（${gap}px）`);
check(await page.isHidden('#s8When'), '還沒按「設定排程時間」前，時間選單不顯示');
await shot('s8-2-step2');

// ===== 5. 存成草稿 → 步驟 3 → 步驟 4 → 步驟 5 =====
await page.click('#s8PickDraft');
check(await vis('#s8Step3') && !(await vis('#s8Step4')) && !(await vis('#s8Step5')), '按「存成草稿」後才出現步驟 3');
check((await page.textContent('#s8Step3')).includes('確認人數'), '步驟 3 是「確認人數」');
check(await page.evaluate(() => parseFloat(getComputedStyle(document.getElementById('s8ConfirmTotal')).borderTopLeftRadius) >= 16), '步驟 3 的輸入框是圓角框');
await page.fill('#s8ConfirmTotal', '999');
check(!(await vis('#s8Step4')), '人數輸入錯誤：不出現步驟 4');
await page.fill('#s8ConfirmTotal', '1,234');
check(await vis('#s8Step4') && !(await vis('#s8Step5')), '人數輸入正確：出現步驟 4，步驟 5 還沒出現');
check((await page.textContent('#s8CopyName')) === '複製排程名稱', '步驟 4 是「複製排程名稱」');
await page.click('#s8CopyName');
await page.waitForFunction(() => !document.getElementById('s8Step5').hidden);
check(await vis('#s8Step5'), '按「複製排程名稱」後才出現步驟 5');
const nm = await page.inputValue('#s8Name');
check((await page.textContent('#s8CopyMsg')).includes(nm), `步驟 4 旁顯示已複製的名稱「${nm}」`);
check((await page.textContent('#s8CreateBtn')) === '建立草稿', '草稿：步驟 5 按鈕是「建立草稿」');
check((await page.textContent('#s8Tip')).includes(nm) && (await page.textContent('#s8Tip')).includes('手動'), '步驟 5 下方提示：到 S8 貼上名稱手動命名');
await shot('s8-3-step5-draft');
await page.click('#s8CreateBtn');
await page.waitForFunction(() => /草稿已建立/.test(document.getElementById('s8CreateOut').textContent));
check(reqs.create.length === 1 && reqs.create[0].mode === 'draft' && !('scheduleAt' in reqs.create[0]) && reqs.create[0].confirmTotal === 1234, "存成草稿：送出 mode:'draft'，不帶 scheduleAt");
check(dialogs.length === 0 && (await page.locator('.s8-banner').count()) === 0, '草稿：不跳確認視窗、沒有紅字橫幅');
check((await page.textContent('#s8CreateOut')).includes(nm), '草稿成功訊息再次提醒貼上名稱命名');
check(!(await vis('#s8Step2')) && !(await vis('#s8Step5')), '建立完成後步驟收起，要再建立需重新傳送');
await shot('s8-4-draft-created');

// ===== 6. 設定排程時間：下拉選單、範圍檢查 =====
await page.click('#s8PrepBtn');
await page.waitForFunction(() => /傳送完成/.test(document.getElementById('s8PrepMsg').textContent) && !document.getElementById('s8Step2').hidden);
await page.click('#s8PickSched');
check(await vis('#s8When') && await vis('#s8Step3'), '按「設定排程時間」：出現五個下拉選單與步驟 3');
const opts = await page.evaluate(() => ['s8Yy', 's8Mo', 's8Dd', 's8Hh', 's8Mi'].map(id => document.getElementById(id).options.length));
check(JSON.stringify(opts) === JSON.stringify([2, 12, 31, 24, 60]), `年／月／日／時／分選單選項數：${opts.join('／')}`);
const def = await page.evaluate(() => { const g = id => Number(document.getElementById(id).value); return Date.UTC(g('s8Yy'), g('s8Mo') - 1, g('s8Dd'), g('s8Hh'), g('s8Mi')) - 8 * 3600e3; });
check(Math.abs(def - (Date.now() + 24 * 3600e3)) < 10 * 60e3, '預設時間約為 24 小時後（台北時間）');
const setWhen = async (ms) => { const p = taipeiParts(ms); await page.selectOption('#s8Yy', String(p.y)); await page.selectOption('#s8Mo', String(p.mo)); await page.selectOption('#s8Dd', String(p.d)); await page.selectOption('#s8Hh', String(p.h)); await page.selectOption('#s8Mi', String(p.mi)); return p; };
await page.fill('#s8ConfirmTotal', '1234');
await setWhen(Date.now() + 10 * 60e3);
check((await page.getAttribute('#s8WhenMsg', 'class')).includes('bad') && (await page.textContent('#s8WhenMsg')).includes('30 分鐘'), '設成 10 分鐘後：紅字提示要在 30 分鐘之後');
check(!(await vis('#s8Step4')), '時間不合格：不出現步驟 4');
await setWhen(Date.now() + 9 * 86400e3);
check((await page.textContent('#s8WhenMsg')).includes('7 天') && !(await vis('#s8Step4')), '設成 9 天後：提示最晚 7 天內，不出現步驟 4');
await page.selectOption('#s8Mo', '2'); await page.selectOption('#s8Dd', '31');
check(!(await vis('#s8Step4')) && (await page.textContent('#s8WhenMsg')).includes('沒有 31 日'), '不存在的日期（2 月 31 日）會被擋下');
const want = await setWhen(Date.now() + 3 * 3600e3);
check(!(await page.getAttribute('#s8WhenMsg', 'class')).includes('bad') && await vis('#s8Step4'), '設成 3 小時後：合格，出現步驟 4');
await page.click('#s8CopyName');
const wantText = `${want.y}-${pad2(want.mo)}-${pad2(want.d)} ${pad2(want.h)}:${pad2(want.mi)}`;
check((await page.textContent('#s8CreateBtn')).includes(`建立排程（${wantText} 發送）`), `步驟 5 按鈕寫出確切時間：${wantText}`);
check((await page.textContent('#s8Tip')).includes('不會暫停') && (await page.textContent('#s8Tip')).includes(wantText) && (await page.textContent('#s8Tip')).includes('1,234'), '步驟 5 提示寫出「不會暫停、何時實際發送給幾人」');
await shot('s8-5-step5-schedule');

// ===== 7. 建立排程：確認視窗、送出指定時間、紅字橫幅、暫停 =====
dialogAnswer = false;
await page.click('#s8CreateBtn');
check(dialogs.length === 1 && dialogs[0].includes(wantText) && dialogs[0].includes('不會暫停'), '按建立排程會跳確認視窗，寫出時間且說明不會暫停');
check(reqs.create.length === 1, '按「取消」：沒有送出任何建立');
dialogAnswer = true;
await page.click('#s8CreateBtn');
await page.waitForSelector('.s8-banner');
const c2 = reqs.create[1];
const wantIso = `${want.y}-${pad2(want.mo)}-${pad2(want.d)}T${pad2(want.h)}:${pad2(want.mi)}:00+08:00`;
check(reqs.create.length === 2 && c2.mode === 'schedule' && c2.scheduleAt === wantIso && c2.confirmTotal === 1234, `送出 mode:'schedule' 與 scheduleAt=${wantIso}`);
check((await page.textContent('.s8-banner .t')).includes(wantText) && (await page.textContent('.s8-banner .t')).includes('1,234'), '紅字橫幅寫出確切發送時間與人數');
check((await page.textContent('.s8-banner')).includes(nm), '橫幅提醒貼上名稱手動命名');
await shot('s8-6-schedule-banner');
await page.click('.s8-banner button');
await page.waitForSelector('.s8-banner.paused');
check(reqs.pause.length === 1 && reqs.pause[0].taskId === 'task_sched01', '按「暫停成草稿」：呼叫 /s8/pause');
await shot('s8-7-paused');

// ===== 8. 變更內容會讓傳送結果失效 =====
await page.click('#s8PrepBtn');
await page.waitForFunction(() => /傳送完成/.test(document.getElementById('s8PrepMsg').textContent));
await page.click('#s8PickDraft');
await page.fill('#s8Alt', '改過的推播通知');
check(!(await vis('#s8Step2')) && await page.isHidden('#s8PrepOut'), '傳送後改了內容：步驟收起，需要重新傳送');

check(pageErrors.length === 0, `頁面沒有 JS 錯誤${pageErrors.length ? '：' + pageErrors.join(' | ') : ''}`);
await browser.close();
console.log(failed ? `\n${failed} 項失敗` : '\n全部通過');
process.exit(failed ? 1 : 0);
