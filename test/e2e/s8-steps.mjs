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
let prepareFails = false, createDelay = 0, createFail = '';
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
    if (createDelay) await new Promise(r => setTimeout(r, createDelay));
    if (createFail === 'error') return json({ error: 'S8 暫時無法使用，沒有建立任何東西' }, 502);
    if (createFail === 'rate') return json({ error: '建立失敗：{"error":{"code":"rate_limit_exceeded","limitType":"credit_bucket","message":"Rate limit exceeded: credit exhausted (cost 100, remaining 48). Retry after 2124099s."}}' }, 502);
    if (createFail === 'created') return json({ ok: false, created: true, mode: body.mode, taskId: 'task_x1', warning: '群發已建立，但沒有成功暫停成草稿。它仍排在明天發送，請立即到 Super 8 Console 暫停或刪除，或按「重試暫停」。', total: 1234 });
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
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => {} }, configurable: true });
  window.__opened = [];
  HTMLInputElement.prototype.showPicker = function () { (window.__picked = window.__picked || []).push(this.id); };
  window.open = (u) => { window.__opened.push(u); return null; };
});
await page.goto(`${BASE}?imageProxy=${encodeURIComponent(WORKER)}`);
await page.evaluate(() => { setLab(true); });

async function openDialog() {
  await page.evaluate(() => { s8AltByMode[mode] = '測試推播標題'; (s8Md = 's8', openS8Dialog()); });
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

check(await page.evaluate(() => !document.getElementById('labToggle').title) && !(await page.locator('#labTip').count()), '「試驗功能」沒有 title 小提示，也沒有懸浮泡泡');

// ===== 1. 預覽：頁籤與點格子看完整連結 =====
await openDialog();
check(await page.locator('#pushTitleBox, #pushTitleInput, #pushTitleReopen').count() === 0, '編輯畫面的「推播標題」卡片與工具列按鈕已移除');
check((await page.getAttribute('#s8Alt', 'placeholder')) === '填入推播標題，例如★我是推播標題 推播標題是我', '「推播通知」欄位的示範文字：填入推播標題，例如★我是推播標題 推播標題是我');
check((await page.inputValue('#s8Alt')) === '測試推播標題', '推播通知欄位帶入先前輸入的內容');
await page.fill('#s8Alt', '★我是推播標題 推播標題是我');
check(await page.evaluate(() => s8AltByMode[mode]) === '★我是推播標題 推播標題是我', '在這個欄位輸入會被記住（關掉再開仍在）');
await page.fill('#s8Alt', '');
check(await page.evaluate(() => s8Collect().alt === '') && (await page.locator('#s8Errs li').allTextContents()).some(t => t.includes('推播通知')), '推播通知留白：列出「請填推播通知」錯誤');
await page.fill('#s8Alt', '測試推播標題');
check((await page.locator('#s8Ptabs .s8-ptab').count()) === 2 && (await page.textContent('#s8Ptabs .s8-ptab.active')) === '第 1 頁', '預覽上方有「第 1 頁／第 2 頁」切換，預設第 1 頁');
check((await page.locator('#s8Stage img').count()) === 1, '預覽區一次只顯示一張圖');
const box = await page.evaluate(() => { const s = document.getElementById('s8Stage').getBoundingClientRect(), i = document.querySelector('#s8Stage img').getBoundingClientRect(); return { dh: Math.abs(s.height - i.height), dt: Math.abs(s.top - i.top), dw: Math.abs(s.width - i.width) }; });
check(box.dh < 0.5 && box.dt < 0.5 && box.dw < 0.5, `預覽框與圖片完全貼合，上下沒有多出灰色塊（高度差 ${box.dh.toFixed(1)}px）`);
check(await page.isDisabled('#s8CellUrl'), '還沒點格子：完整連結字框停用');
await page.locator('#s8Stage .s8-cell').nth(1).click();
check((await page.inputValue('#s8CellUrl')) === 'https://example.com/p1/n2?utm_source=x', '點第 1 頁第 2 格：下方顯示該格完整連結');
check((await page.locator('#s8Stage .s8-cell.sel').count()) === 1, '被點的格子有選取標示');
check((await page.textContent('#s8LinkLbl')).includes('第 1 頁') && (await page.textContent('#s8LinkLbl')).includes('項目2'), '字框上方標出「第 1 頁 項目2」');
// 每格名稱：快速填入的標題（沒填才退回「項目N」）
await page.evaluate(() => { pages[0].cards[1].line1 = '降溫恐"跌破20度"!'; pages[0].cards[1].line2 = '北部再爆大雨'; });
await page.locator('#s8Stage .s8-cell').nth(1).click();
const expectTitle = '★降溫恐"跌破20度"! 北部再爆大雨';
check((await page.textContent('#s8LinkLbl')).includes(expectTitle), `字框上方標出該格標題：${expectTitle}`);
check((await page.locator('#s8Stage .s8-cell').nth(1).getAttribute('title')) === expectTitle, '格子的滑過提示也是該格標題');
check((await page.locator('#s8Stage .s8-cell').nth(0).getAttribute('title')).startsWith('項目1'), '還沒填標題的格子退回「項目1（位置）」');
await page.click('.s8-ptab[data-sp="1"]');
check((await page.textContent('#s8Ptabs .s8-ptab.active')) === '第 2 頁', '切到第 2 頁');
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
check((await page.textContent('#s8Title')) === '排入推播', '視窗標題是「排入推播」（左上有 LINE原生推播／S8推播 切換）');
check(await page.locator('#s8CopyBtn, #s8DownloadBtn, #s8Prompt').count() === 0 && !(await page.textContent('.s8-modal')).includes('複製給 Claude 的指令') && !(await page.textContent('.s8-modal')).includes('下載兩張圖'), '「複製給 Claude 的指令」「下載兩張圖」與完整指令區已移除，只剩「關閉」');
check(!(await page.textContent('.s8-modal')).includes('需要先在右上角「S8」視窗升級授權。流程'), '「傳送資料給S8」下方的說明已移除');
await shot('s8-1-preview');

// ===== 2. 步驟顯示：一開始只有步驟 1 =====
check(await vis('#s8Step1') && !(await vis('#s8Step2')) && !(await vis('#s8Step3')) && !(await vis('#s8Step4')) && !(await vis('#s8Step5')), '一開始只看得到步驟 1');
check((await page.textContent('#s8PrepBtn')) === '傳送資料', '步驟 1 按鈕是「傳送資料」');
const bgOf = async id => { await page.waitForTimeout(380); return page.evaluate(i => getComputedStyle(document.getElementById(i)).backgroundColor, id); };   // 等顏色轉場跑完
const shadowOf = id => page.evaluate(i => getComputedStyle(document.getElementById(i)).boxShadow, id);
const WHITE = await page.evaluate(() => { const t = document.createElement('i'); t.style.background = 'var(--knob)'; document.body.appendChild(t); const c = getComputedStyle(t).backgroundColor; t.remove(); return c; });
const GREEN = 'rgb(22, 163, 74)', RED = 'rgb(220, 38, 38)', BLUE = 'rgb(0, 74, 173)';
check((await bgOf('s8PrepBtn')) === WHITE && (await shadowOf('s8PrepBtn')) !== 'none' && (await bgOf('s8PrepTrack')) === (await bgOf('s8CountBtn')), '還沒動作：按鈕是白色（有陰影），底框是灰色');
check(await page.isHidden('#s8PrepOut'), '還沒傳送：右邊（原本「第 2 頁」的位置）是空的');
const hug = await page.evaluate(() => { const t = document.getElementById('s8PrepTrack').getBoundingClientRect(), b = document.getElementById('s8PrepBtn').getBoundingClientRect(); return { dw: +(t.width - b.width).toFixed(1), dh: +(t.height - b.height).toFixed(1), transition: getComputedStyle(document.getElementById('s8PrepTrack')).transitionProperty }; });
check(hug.dw === 10 && /width/.test(hug.transition), `按下傳送資料前，灰框貼齊按鈕（只比按鈕多左右各 5px：${hug.dw}px），並且寬度有轉場動畫`);
check(await page.evaluate(() => { const d = [1, 2, 3, 4, 5].map(n => document.getElementById('s8Dot' + n).getBoundingClientRect()); return d.every((r, i) => Math.abs(r.top - d[0].top) < 2 && (i === 0 || r.left > d[i - 1].left)); }), '步驟前面的圓圈數字是水平排成一列（1→5 由左到右）');
check(await page.evaluate(() => document.querySelectorAll('.s8-step > i').length === 0), '每個步驟的按鈕前面不再各自帶垂直排列的圓圈');

// ===== 3. 傳送失敗：下方顯示簡單狀態，沒有後續步驟 =====
prepareFails = true;
await page.click('#s8PrepBtn');
await page.waitForFunction(() => /傳送失敗/.test(document.getElementById('s8PrepMsg').textContent));
check((await page.textContent('#s8PrepMsg')).startsWith('✗ 傳送失敗') && !(await vis('#s8Step2')), '失敗：顯示「傳送失敗」、不出現步驟 2');
check((await bgOf('s8PrepBtn')) === RED, '傳送失敗：「傳送資料」按鈕變紅色');
check(await page.evaluate(() => { const t = document.getElementById('s8PrepTrack').getBoundingClientRect(), o = document.getElementById('s8PrepOut').getBoundingClientRect(); return o.left >= t.left && o.right <= t.right + 0.5 && o.top >= t.top && o.bottom <= t.bottom + 0.5; }), '狀態包在分段膠囊框內（原本「第 2 頁」的位置）');
prepareFails = false;

// ===== 4. 傳送成功：只顯示簡單狀態（沒有「開啟S8預覽」按鈕）=====
await page.click('#s8PrepBtn');
await page.waitForFunction(() => /傳送完成/.test(document.getElementById('s8PrepMsg').textContent));
check((await bgOf('s8PrepBtn')) === GREEN, '傳送完成：「傳送資料」按鈕變綠色');
await page.waitForTimeout(550);
const open = await page.evaluate(() => ({ w: Math.round(document.getElementById('s8PrepTrack').getBoundingClientRect().width), full: Math.round(document.getElementById('s8Seg2').getBoundingClientRect().width), cls: document.getElementById('s8PrepTrack').classList.contains('open') }));
check(open.cls && open.w === open.full, `有狀態更新後，灰框往右彈開到統一寬度（${open.w}px）才顯示文字狀態`);
check((await page.textContent('#s8PrepMsg')).includes('1,234 人') && !(await page.textContent('#s8PrepMsg')).includes('分鐘內有效'), '成功：顯示「傳送完成」與可發送人數，沒有「預覽 20 分鐘內有效」');
check(reqs.prepare[1].pages[0].buttons[1].title === expectTitle && reqs.prepare[1].pages[0].buttons[0].title.startsWith('項目1'), '傳給 S8 的區塊名稱：有標題的格子用「★標題」，沒標題的退回「項目N」');
check(reqs.prepare.length === 2 && reqs.prepare[1].pages.length === 2 && reqs.prepare[1].pages[0].buttons.length === 6 && reqs.prepare[1].pages[0].buttons[1].url === 'https://example.com/p1/n2?utm_source=x', '傳送內容：兩頁、每頁 6 格、連結用目前字框的值');
check(Array.isArray(reqs.prepare[1].quick) && reqs.prepare[1].quick.length === 0, '沒設快速回覆：傳給 S8 的 quick 是空陣列（行為跟以前一樣）');
check(await vis('#s8Step2') && !(await vis('#s8Step3')), '成功後出現步驟 2，步驟 3 還沒出現');
await page.waitForTimeout(600);
const hl = id => page.evaluate(i => { const e = document.getElementById(i); return { done: e.classList.contains('done'), scale: Number((String(getComputedStyle(e, '::after').transform).match(/matrix\(([^)]+)\)/) || [0, '0,0,0,0'])[1].split(',')[0]) }; }, id);
const l1 = await hl('s8Line1'), l2 = await hl('s8Line2');
check(await page.evaluate(() => document.getElementById('s8Dot1').classList.contains('done') && document.getElementById('s8Dot2').classList.contains('on')), '步驟 1 完成：圓圈 1 變綠，圓圈 2 變成目前這一步（藍色並顯示名稱）');
check(l1.done && l1.scale === 1 && !l2.done && l2.scale === 0, '水平連線：1→2 綠色由左往右填滿（動畫跑完），2→3 還沒填');
check(await page.evaluate(() => { const t = document.getElementById('s8Ptabs'); return t.classList.contains('seg-track') && !!t.querySelector('.seg-knob'); }), '頁籤與頁面上方相同：capsule 軌道＋滑動旋鈕');
check((await page.textContent('#s8PickDraft')) === '存成草稿' && (await page.textContent('#s8PickSched')).includes('設定排程'), '步驟 2 兩個按鈕：存成草稿／設定排程時間');
check(await page.evaluate(() => { const t = document.getElementById('s8Seg2'); return t.classList.contains('s8-seg') && t.contains(document.getElementById('s8PickDraft')) && t.contains(document.getElementById('s8PickSched')); }), '步驟 2：存成草稿／設定排程是同一條分段膠囊（與切換頁數同款）');
check(await page.evaluate(() => !document.getElementById('s8Seg2').classList.contains('has')), '還沒選時旋鈕不顯示');
check(await page.isHidden('#s8WhenMsg'), '還沒按「設定排程時間」前，時間選單不顯示');
await shot('s8-2-step2');

// ===== 5. 存成草稿 → 步驟 3 → 步驟 4 → 步驟 5 =====
await page.click('#s8PickDraft');
await page.waitForTimeout(450);
check(await page.evaluate(() => { const k = document.querySelector('#s8Seg2 .s8-knob').getBoundingClientRect(), b = document.getElementById('s8PickDraft').getBoundingClientRect(); return Math.abs(k.left - b.left) < 1.5 && Math.abs(k.width - b.width) < 1.5; }), '選「存成草稿」：旋鈕滑到它底下');
check(await vis('#s8Step3') && !(await vis('#s8Step4')) && !(await vis('#s8Step5')), '按「存成草稿」後才出現步驟 3');
check((await page.textContent('#s8Step3')).includes('確認人數'), '步驟 3 是「確認人數」');
check((await page.getAttribute('#s8ConfirmTotal', 'placeholder')) === '輸入 1,234', '數字框內提示正確人數（輸入 1,234）');
const col1 = await page.evaluate(() => ['s8PickDraft', 's8ConfirmLabel'].map(id => { const e = document.getElementById(id), r = e.getBoundingClientRect(), c = getComputedStyle(e); return { id, w: Math.round(r.width), cx: Math.round(r.left + r.width / 2), fs: c.fontSize, fw: c.fontWeight, ta: c.textAlign }; }).concat([(() => { const e = document.getElementById('s8ConfirmTotal'), c = getComputedStyle(e); return { id: 'input', fs: c.fontSize, fw: c.fontWeight, ta: c.textAlign }; })()]));
check(col1[0].w === col1[1].w && col1[0].cx === col1[1].cx && col1.every(x => x.fs === col1[0].fs && x.fw === col1[0].fw), `同一欄的文字尺寸與位置一致：按鈕寬 ${col1[0].w}px、文字中心 ${col1[0].cx}、字級 ${col1[0].fs}／${col1[0].fw}（確認人數數字框也一樣）`);
const firstCol = await page.evaluate(() => ['s8PrepBtn'].map(id => Math.round(parseFloat(getComputedStyle(document.getElementById(id)).width))));   // 步驟 1 此時已隱藏，看樣式寬度
check(firstCol[0] === col1[0].w, '第一欄的「傳送資料」按鈕也是同樣寬度');
check(await page.evaluate(() => parseFloat(getComputedStyle(document.getElementById('s8ConfirmTotal')).borderTopLeftRadius) >= 16), '步驟 3 的輸入框是圓角框');
check((await page.textContent('#s8ConfirmMark')) === '' && (await bgOf('s8ConfirmLabel')) === WHITE, '還沒輸入：數字框後面沒有標記，「確認人數」按鈕是白色');
await page.fill('#s8ConfirmTotal', '999');
check(!(await vis('#s8Step4')), '人數輸入錯誤：不出現步驟 4');
check((await bgOf('s8ConfirmLabel')) === RED, '確認人數打錯：「確認人數」按鈕變紅色');
check((await page.textContent('#s8ConfirmMark')) === '✗' && (await page.getAttribute('#s8ConfirmMark', 'class')).includes('bad'), '打錯數字：數字框後面出現紅色 ✗');
const markCss = () => page.evaluate(() => { const c = getComputedStyle(document.getElementById('s8ConfirmMark')); const r = document.getElementById('s8ConfirmMark').getBoundingClientRect(); return { bg: c.backgroundColor, color: c.color, radius: c.borderTopLeftRadius, w: Math.round(r.width), h: Math.round(r.height) }; });
let mk = await markCss();
check(mk.bg === 'rgb(220, 38, 38)' && mk.color === 'rgb(255, 255, 255)' && mk.w === mk.h && parseFloat(mk.radius) >= mk.w / 2, `✗ 包在紅底圓圈內（${JSON.stringify(mk)}）`);
await page.fill('#s8ConfirmTotal', '1,234');
check((await bgOf('s8ConfirmLabel')) === GREEN, '確認人數打對：「確認人數」按鈕變綠色');
check((await page.textContent('#s8ConfirmMark')) === '✓' && (await page.getAttribute('#s8ConfirmMark', 'class')).includes('ok'), '打對數字：數字框後面變成綠色 ✓');
mk = await markCss();
check(mk.bg === 'rgb(22, 163, 74)' && mk.color === 'rgb(255, 255, 255)' && mk.w === mk.h && parseFloat(mk.radius) >= mk.w / 2, `✓ 包在綠底圓圈內（${JSON.stringify(mk)}）`);
await page.mouse.move(0, 0);
const cap = await page.evaluate(() => { const g = id => { const c = getComputedStyle(document.getElementById(id)); return `${c.backgroundColor}|${c.borderTopLeftRadius}|${c.fontWeight}`; }; return { count: g('s8CountBtn'), prep: g('s8PrepTrack'), seg2: g('s8Seg2'), conf: g('s8ConfirmBox'), copy: g('s8CopyTrack'), create: g('s8CreateTrack') }; });
check(['prep', 'seg2', 'conf', 'copy', 'create'].every(k => cap[k] === cap.count), `步驟 1～5 的膠囊／軌道與「計算符合條件的客戶數」同款（背景／圓角／粗細）：${JSON.stringify(cap)}`);
check(await vis('#s8Step4') && !(await vis('#s8Step5')), '人數輸入正確：出現步驟 4，步驟 5 還沒出現');
check((await page.textContent('#s8CopyTxt')) === '複製群發名稱' && await page.isHidden('#s8CopyOk'), '步驟 4 是「複製群發名稱」，還沒複製時沒有打勾圖示');
await page.click('#s8CopyName');
await page.waitForFunction(() => !document.getElementById('s8Step5').hidden);
check(await vis('#s8Step5'), '按「複製群發名稱」後才出現步驟 5');
const nm = await page.inputValue('#s8Name');
check((await page.textContent('#s8CopyTxt')) === '已複製名稱' && (await bgOf('s8CopyName')) === GREEN, '按下後按鈕短暫顯示「已複製名稱」，且變綠色');
const okIcon = await page.evaluate(() => { const i = document.getElementById('s8CopyOk'), b = document.getElementById('s8CopyName'), ir = i.getBoundingClientRect(), br = b.getBoundingClientRect(), c = getComputedStyle(i); return { text: i.textContent, inside: ir.left >= br.left && ir.right <= br.right && ir.top >= br.top && ir.bottom <= br.bottom, right: ir.left > br.left + br.width / 2, round: c.borderTopLeftRadius, bg: c.backgroundColor, w: Math.round(ir.width), h: Math.round(ir.height) }; });
check(okIcon.text === '✓' && okIcon.inside && okIcon.right && okIcon.w === okIcon.h && parseFloat(okIcon.round) >= okIcon.w / 2 && okIcon.bg === 'rgb(255, 255, 255)', `綠色按鈕內右側有白色圓形打勾圖示（${JSON.stringify(okIcon)}）`);
await shot('s8-3b-copied');
await page.waitForTimeout(1800);
check((await page.textContent('#s8CopyTxt')) === '複製群發名稱' && await page.isVisible('#s8CopyOk') && (await bgOf('s8CopyName')) === GREEN, '一下子之後按鈕文字跳回「複製群發名稱」，圓形打勾圖示與綠色仍保留');
const setConfirm = v => page.evaluate(x => { const i = document.getElementById('s8ConfirmTotal'); i.value = x; i.dispatchEvent(new Event('input', { bubbles: true })); }, v);   // 步驟 3 此時已隱藏，用程式模擬輸入
await setConfirm('1');
check(await page.isHidden('#s8CopyOk') || !(await vis('#s8Step4')), '人數被改掉、步驟 4 收起時，打勾圖示會重設');
await setConfirm('1,234');
check(await page.isHidden('#s8CopyOk') && (await page.textContent('#s8CopyTxt')) === '複製群發名稱' && (await bgOf('s8CopyName')) === WHITE, '重新出現步驟 4 時要重新複製：沒有打勾圖示，按鈕回到白色');
await page.click('#s8CopyName');
await page.waitForFunction(() => !document.getElementById('s8Step5').hidden);
check((await page.textContent('#s8CreateBtn')) === '建立草稿', '草稿：步驟 5 按鈕是「建立草稿」');
check(await page.locator('#s8Tip').count() === 0 && !(await page.textContent('.s8-modal')).includes('沒有名稱欄位'), '步驟 5 後面沒有「沒有名稱欄位」的提示了');
await shot('s8-3-step5-draft');
createDelay = 700;
await page.click('#s8CreateBtn');
await page.waitForTimeout(250);
check((await bgOf('s8CreateBtn')) === 'rgb(61, 127, 224)' && (await page.textContent('#s8CreateBtn')) === '建立中…' && await page.isDisabled('#s8CreateBtn'), '剛送出、建立中：「建立」按鈕變淺藍色（建立中…，不能重複按）');
await page.waitForFunction(() => document.getElementById('s8NoteOverlay').classList.contains('open'));
createDelay = 0;
check(reqs.create.length === 1 && reqs.create[0].mode === 'draft' && !('scheduleAt' in reqs.create[0]) && reqs.create[0].confirmTotal === 1234, "存成草稿：送出 mode:'draft'，不帶 scheduleAt");
check(dialogs.length === 0 && (await page.locator('.s8-banner').count()) === 0, '草稿：不跳確認視窗、沒有紅字橫幅');
check((await page.textContent('#s8NoteTitle')) === '草稿已建立' && (await page.textContent('#s8NoteBody')).includes('S8 後台') && (await page.textContent('#s8NoteBody')).includes(nm), '成功：跳出彈窗提醒到 S8 後台確認，並貼上名稱「' + nm + '」命名群發');
check((await bgOf('s8CreateBtn')) === GREEN && (await page.textContent('#s8CreateBtn')) === '已建立草稿' && await page.isDisabled('#s8CreateBtn'), '成功：「建立」按鈕變綠色（已建立草稿）並停用，避免重複建立');
check(!(await page.textContent('#s8CreateOut')).includes('沒有名稱欄位') && (await page.textContent('#s8CreateOut')).includes('草稿已建立'), '草稿成功摘要不再有「沒有名稱欄位」那句');
check(!(await vis('#s8Step1')) && !(await vis('#s8Step2')) && !(await vis('#s8Step3')) && await vis('#s8Step4') && await vis('#s8Step5'), '完成後只留最後兩個步驟（前面的都隱藏）');
await shot('s8-4-draft-created');
await page.click('#s8NoteOk');
check(!(await page.locator('#s8NoteOverlay').evaluate(e => e.classList.contains('open'))), '按「知道了」關閉彈窗');
// 要再建立另一筆：關掉視窗重新開啟
await page.click('#s8CloseBtn');
await openDialog();


// ===== 6. 設定排程時間：下拉選單、範圍檢查 =====
await page.click('#s8PrepBtn');
await page.waitForFunction(() => /傳送完成/.test(document.getElementById('s8PrepMsg').textContent) && !document.getElementById('s8Step2').hidden);
await page.click('#s8PickSched');
check(await vis('#s8WhenMsg') && await vis('#s8Step3'), '按「設定排程」：出現日期與時間選擇器與步驟 3');
const ymd = p => `${p.y}-${pad2(p.mo)}-${pad2(p.d)}`, hm = p => `${pad2(p.h)}:${pad2(p.mi)}`;
const dflt = await page.evaluate(() => { const d = document.getElementById('s8Date'), t = document.getElementById('s8Time'); return { types: [d.type, t.type], d: d.value, t: t.value, min: d.min, max: d.max, dt: document.getElementById('s8DateTxt').textContent, tt: document.getElementById('s8TimeTxt').textContent }; });
check(dflt.types.join() === 'date,time', '日期用日期選擇器、時間用時間選擇器（各一個，不是月日時分四格）');
const defMs = Date.parse(`${dflt.d}T${dflt.t}:00+08:00`);
check(Math.abs(defMs - (Date.now() + 3 * 3600e3)) < 3 * 60e3, `預設時間是「現在 + 3 小時」：${dflt.d} ${dflt.t}`);
check(dflt.d === ymd(taipeiParts(defMs)) && dflt.d === ymd(taipeiParts(Date.now())) || dflt.d === ymd(taipeiParts(Date.now() + 3 * 3600e3)), '預設日期是今天（若 +3 小時跨過午夜，就是那一天）');
check(dflt.dt === `${dflt.d.slice(5, 7)}/${dflt.d.slice(8, 10)}` && dflt.tt === dflt.t, `膠囊上日期顯示成 MM/DD（${dflt.dt}）、時間顯示成 HH:MM（${dflt.tt}）`);
check(dflt.min === ymd(taipeiParts(Date.now())) && dflt.max === ymd(taipeiParts(Date.now() + 7 * 86400e3)), `日期選擇器只讓選今天到 7 天內（${dflt.min} ～ ${dflt.max}）`);
const pillText = await page.textContent('#s8PickSched');
check(pillText.includes('設定排程') && pillText.includes(dflt.dt) && pillText.includes(dflt.tt), '「設定排程」膠囊內有日期與時間兩個選擇器');
const mid = await page.evaluate(() => { const c = e => { const r = e.getBoundingClientRect(); return r.top + r.height / 2; }; const seg = document.getElementById('s8Seg2').querySelector('.s8-knob') || document.getElementById('s8Seg2'); const pill = document.getElementById('s8PickSched'); return { seg: c(document.getElementById('s8Seg2')), pill: c(pill), date: c(document.getElementById('s8DateBox')), time: c(document.getElementById('s8TimeBox')), left: c(document.getElementById('s8PickDraft')) }; });
check(Math.abs(mid.date - mid.left) <= 1 && Math.abs(mid.time - mid.left) <= 1 && Math.abs(mid.pill - mid.left) <= 1, `日期／時間框與左側「存成草稿」垂直置中對齊（差 ${(mid.date - mid.left).toFixed(1)} / ${(mid.time - mid.left).toFixed(1)}px）`);
await page.evaluate(() => { window.__picked = []; });
await page.click('#s8DateBox'); await page.click('#s8TimeBox');
check(JSON.stringify(await page.evaluate(() => window.__picked)) === JSON.stringify(['s8Date', 's8Time']), '點日期／時間會開啟原生的日期／時間選擇器');
const setWhen = async ms => { const p = taipeiParts(ms); await page.fill('#s8Date', ymd(p)); await page.fill('#s8Time', hm(p)); return p; };
await setWhen(Date.now() + 10 * 60e3);
check((await page.getAttribute('#s8WhenMsg', 'class')).includes('bad') && (await page.textContent('#s8WhenMsg')).includes('30 分鐘'), '設成 10 分鐘後：紅字提示要在 30 分鐘之後');
await page.waitForTimeout(380);
check(await page.evaluate(() => getComputedStyle(document.querySelector('#s8Seg2 .s8-knob')).backgroundColor) === BLUE, '排程時間不合格：選擇型按鈕維持藍色（錯誤用紅字提示，不改按鈕顏色）');
check(!(await vis('#s8Step4')), '時間不合格：不出現步驟 4');
await setWhen(Date.now() + 9 * 86400e3);
check((await page.textContent('#s8WhenMsg')).includes('7 天') && !(await vis('#s8Step4')), '設成 9 天後：提示最晚 7 天內，不出現步驟 4');
await page.fill('#s8Date', '');
check((await page.getAttribute('#s8WhenMsg', 'class')).includes('bad') && (await page.textContent('#s8WhenMsg')).includes('請選擇日期') && (await page.textContent('#s8DateTxt')) === 'MM/DD', '日期清空：提示請選擇日期');
await shot('s8-5b-time-picker');
const want = await setWhen(Date.now() + 3 * 3600e3);
await setConfirm('1234');   // 時間合格後再打對人數（步驟 3 這時還看得到），步驟 4 才出現
check(!(await page.getAttribute('#s8WhenMsg', 'class')).includes('bad') && await vis('#s8Step4'), '設成 3 小時後：合格，出現步驟 4');
await page.waitForTimeout(380);
check(await page.evaluate(() => getComputedStyle(document.querySelector('#s8Seg2 .s8-knob')).backgroundColor) === BLUE, '選擇型按鈕（存成草稿／設定排程）按下後變藍色');
await page.click('#s8CopyName');
const wantText = `${want.y}-${pad2(want.mo)}-${pad2(want.d)} ${pad2(want.h)}:${pad2(want.mi)}`;
check((await page.textContent('#s8CreateBtn')).includes(`建立排程（${wantText} 發送）`), `步驟 5 按鈕寫出確切時間：${wantText}`);
await page.evaluate(() => document.querySelectorAll('.s8-step.old').forEach(e => e.classList.remove('old')));   // 為了量尺寸，先讓被隱藏的步驟都顯示出來
const sizes = await page.evaluate(() => ['s8PrepTrack', 's8Seg2', 's8ConfirmBox', 's8CopyTrack', 's8CreateTrack'].map(id => { const e = document.getElementById(id), r = e.getBoundingClientRect(); return { id, w: Math.round(r.width), h: Math.round(r.height), clipped: e.scrollWidth > e.clientWidth + 1 }; }));
check(sizes.every(x => x.w === sizes[0].w && x.h === sizes[0].h), `步驟裡所有按鈕尺寸一致：${sizes.map(x => `${x.id}=${x.w}×${x.h}`).join('、')}`);
check(sizes.every(x => !x.clipped), `最長的內容（排程時間選單、建立排程文字）都放得下，沒有被裁切${sizes.filter(x => x.clipped).map(x => '（' + x.id + ' 被裁）').join('')}`);
await page.waitForTimeout(450);
check(await page.evaluate(() => { const k = document.querySelector('#s8Seg2 .s8-knob').getBoundingClientRect(), b = document.getElementById('s8PickSched').getBoundingClientRect(); return Math.abs(k.left - b.left) < 1.5 && Math.abs(k.width - b.width) < 1.5; }), '選「設定排程」：旋鈕滑到它底下（含月日時分選單）');
const slack = await page.evaluate(() => { const t = document.getElementById('s8Seg2'); const kids = Array.from(t.children).filter(e => !e.classList.contains('s8-knob')); const used = kids.reduce((n, e) => n + e.getBoundingClientRect().width, 0) + (kids.length - 1) * 14 + 10; return Math.round(t.getBoundingClientRect().width - used); });
const wNow = await page.evaluate(() => Math.round(document.getElementById('s8Seg2').getBoundingClientRect().width));
check(slack <= 8, `統一寬度由最長的控制項決定，沒有硬塞空間（寬 ${wNow}px，最長那一個多出 ${slack}px）`);
const confirmSz = await page.evaluate(() => { const i = document.getElementById('s8ConfirmTotal').getBoundingClientRect(), l = document.getElementById('s8ConfirmLabel').getBoundingClientRect(); return { iw: Math.round(i.width), ih: Math.round(i.height), lw: Math.round(l.width), lh: Math.round(l.height) }; });
check(confirmSz.iw === confirmSz.lw && confirmSz.ih === confirmSz.lh, `確認人數的數字框與旁邊的按鈕同寬同高（${confirmSz.iw}×${confirmSz.ih} ／ ${confirmSz.lw}×${confirmSz.lh}）`);
const insets = await page.evaluate(() => ['s8PrepTrack', 's8Seg2', 's8ConfirmBox', 's8CopyTrack', 's8CreateTrack'].map(id => { const t = document.getElementById(id), tr = t.getBoundingClientRect(), b = t.querySelector(':scope > .s8-segbtn').getBoundingClientRect(); const last = Array.from(t.querySelectorAll(':scope > .s8-segbtn')).pop().getBoundingClientRect(); return { id, top: +(b.top - tr.top).toFixed(1), bottom: +(tr.bottom - b.bottom).toFixed(1), left: +(b.left - tr.left).toFixed(1), right: id === 's8CopyTrack' || id === 's8CreateTrack' || id === 's8Seg2' ? +(tr.right - last.right).toFixed(1) : null }; }));
check(insets.every(x => x.top === 5 && x.bottom === 5 && x.left === 5 && (x.right === null || x.right === 5)), `所有步驟的按鈕離灰色外框都是同樣的距離 5px：${insets.map(x => `${x.id}(${x.top}/${x.bottom}/${x.left}/${x.right})`).join(' ')}`);
const pairGap = await page.evaluate(() => { const a = document.getElementById('s8PickDraft').getBoundingClientRect(), b = document.getElementById('s8PickSched').getBoundingClientRect(); return Math.round(b.left - a.right); });
check(pairGap >= 12, `「存成草稿」「設定排程」兩個按鈕中間間距加大（${pairGap}px）`);
await shot('s8-5-step5-schedule');

// ===== 7. 建立排程：確認視窗、送出指定時間、紅字橫幅、暫停 =====
dialogAnswer = false;
await page.click('#s8CreateBtn');
check(dialogs.length === 1 && dialogs[0].includes(wantText) && dialogs[0].includes('不會暫停'), '按建立排程會跳確認視窗，寫出時間且說明不會暫停');
check(reqs.create.length === 1, '按「取消」：沒有送出任何建立');
dialogAnswer = true;
await page.click('#s8CreateBtn');
await page.waitForSelector('.s8-banner');
check((await page.textContent('#s8NoteTitle')) === '排程已建立' && (await page.textContent('#s8NoteBody')).includes(wantText) && (await page.textContent('#s8NoteBody')).includes('S8 後台') && (await page.textContent('#s8NoteBody')).includes(nm), '排程成功：彈窗寫出發送時間，提醒到 S8 後台確認排程成功並命名');
check((await bgOf('s8CreateBtn')) === GREEN && (await page.textContent('#s8CreateBtn')) === '已建立排程', '排程成功：「建立」按鈕變綠色（已建立排程）');
await page.click('#s8NoteOk');
const c2 = reqs.create[reqs.create.length - 1];
const wantIso = `${want.y}-${pad2(want.mo)}-${pad2(want.d)}T${pad2(want.h)}:${pad2(want.mi)}:00+08:00`;
check(reqs.create.length === 2 && c2.mode === 'schedule' && c2.scheduleAt === wantIso && c2.confirmTotal === 1234, `送出 mode:'schedule' 與 scheduleAt=${wantIso}`);
check((await page.textContent('.s8-banner .t')).includes(wantText) && (await page.textContent('.s8-banner .t')).includes('1,234'), '紅字橫幅寫出確切發送時間與人數');
check((await page.textContent('.s8-banner')).includes(nm), '橫幅也提醒貼上名稱命名');
await shot('s8-6-schedule-banner');
await page.click('.s8-banner button');
await page.waitForSelector('.s8-banner.paused');
check(reqs.pause.length === 1 && reqs.pause[0].taskId === 'task_sched01', '按「暫停成草稿」：呼叫 /s8/pause');
await shot('s8-7-paused');

// ===== 7b. 建立失敗：按鈕變黃色、下方彈出問題 =====
await page.click('#s8CloseBtn');
await openDialog();
async function reachStep5(choice) {
  await page.click('#s8PrepBtn');
  await page.waitForFunction(() => /傳送完成/.test(document.getElementById('s8PrepMsg').textContent) && !document.getElementById('s8Step2').hidden);
  await page.click(choice === 'draft' ? '#s8PickDraft' : '#s8PickSched');
  await setConfirm('1234');
  await page.click('#s8CopyName');
  await page.waitForFunction(() => !document.getElementById('s8Step5').hidden);
}
await reachStep5('draft');
createFail = 'error';
await page.click('#s8CreateBtn');
await page.waitForFunction(() => document.getElementById('s8CreateBtn').dataset.state === 'warn');
await page.waitForTimeout(450);
check((await bgOf('s8CreateBtn')) === 'rgb(250, 204, 21)', '建立失敗：「建立」按鈕變黃色');
const prob = await page.evaluate(() => { const p = document.getElementById('s8Problem'), r = p.getBoundingClientRect(), t = document.getElementById('s8CreateTrack').getBoundingClientRect(); return { show: p.classList.contains('show'), text: p.textContent, below: r.top >= t.bottom - 1, h: Math.round(r.height) }; });
check(prob.show && prob.below && prob.h > 20 && prob.text.includes('S8 暫時無法使用'), `下方彈出問題說明（在按鈕下方，高 ${prob.h}px）：${prob.text.slice(0, 20)}…`);
check(!(await page.isDisabled('#s8CreateBtn')) && (await page.locator('#s8NoteOverlay').evaluate(e => !e.classList.contains('open'))), '沒建立成功時可以再按一次，且不會跳成功彈窗');
await shot('s8-8-create-failed');
createFail = 'rate';
await page.click('#s8CreateBtn');
await page.waitForFunction(() => /額度不足/.test(document.getElementById('s8Problem').textContent));
const rate = await page.textContent('#s8Problem');
check(rate.includes('需要 100 點') && rate.includes('剩 48 點') && rate.includes('24 天') && rate.includes('沒有建立任何東西') && rate.includes('rate_limit_exceeded'), 'S8 額度不足：改寫成白話（需要 100／剩 48／約 24 天後重置）並保留原文');
await shot('s8-8b-rate-limit');
createFail = 'created';
await page.click('#s8CreateBtn');
await page.waitForFunction(() => /已建立，但沒有成功暫停/.test(document.getElementById('s8Problem').textContent));
check((await bgOf('s8CreateBtn')) === 'rgb(250, 204, 21)' && await page.isDisabled('#s8CreateBtn') && await page.isVisible('#s8RetryRow'), '群發其實已建立（只是暫停失敗）：按鈕黃色且不能再按建立，只能「重試暫停成草稿」');
createFail = '';

// ===== 8. 變更內容會讓傳送結果失效 =====
await page.click('#s8CloseBtn');
await openDialog();
await page.click('#s8PrepBtn');
await page.waitForFunction(() => /傳送完成/.test(document.getElementById('s8PrepMsg').textContent));
await page.click('#s8PickDraft');
await page.fill('#s8Alt', '改過的推播通知');
check(!(await vis('#s8Step2')) && await page.isHidden('#s8PrepOut'), '傳送後改了內容：步驟收起，需要重新傳送');

check(pageErrors.length === 0, `頁面沒有 JS 錯誤${pageErrors.length ? '：' + pageErrors.join(' | ') : ''}`);
await browser.close();
console.log(failed ? `\n${failed} 項失敗` : '\n全部通過');
process.exit(failed ? 1 : 0);
