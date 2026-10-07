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
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => {} }, configurable: true });
  window.__opened = [];
  window.open = (u) => { window.__opened.push(u); return null; };
});
await page.goto(`${BASE}?imageProxy=${encodeURIComponent(WORKER)}`);
await page.evaluate(() => { setLab(true); });

async function openDialog() {
  await page.evaluate(() => { s8AltByMode[mode] = '測試推播標題'; openS8Dialog(); });
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

check(await page.evaluate(() => !document.getElementById('labToggle').title), '「試驗功能」不用瀏覽器內建的 title 小提示');
check(await page.locator('#labTip').isHidden(), '沒滑過時泡泡不顯示');
await page.hover('#labToggle');
await page.waitForTimeout(450);
const tip = await page.evaluate(() => { const t = document.getElementById('labTip'), r = t.getBoundingClientRect(), b = document.getElementById('labToggle').getBoundingClientRect(), c = getComputedStyle(t); return { text: t.textContent, show: t.classList.contains('show'), opacity: c.opacity, below: r.top >= b.bottom, cx: Math.abs((r.left + r.width / 2) - (b.left + b.width / 2)), radius: c.borderTopLeftRadius, bg: c.backgroundColor }; });
check(tip.text === 'S8串接測試' && tip.show && tip.opacity === '1' && tip.below && tip.cx < 40 && parseFloat(tip.radius) >= 12, `滑過「試驗功能」：懸浮泡泡顯示「S8串接測試」（在按鈕下方，${JSON.stringify(tip)}）`);
await page.screenshot({ path: path.join(SHOTS, 's8-0-lab-tip.png'), clip: { x: 600, y: 0, width: 500, height: 110 } });
await page.mouse.move(300, 600);
await page.waitForTimeout(450);
check(await page.locator('#labTip').isHidden(), '滑開後泡泡淡出並隱藏');

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
check((await page.locator('.s8-ptab').count()) === 2 && (await page.textContent('.s8-ptab.active')) === '第 1 頁', '預覽上方有「第 1 頁／第 2 頁」切換，預設第 1 頁');
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
check(await page.evaluate(() => /^rgb\(22, 163, 74\)$/.test(getComputedStyle(document.getElementById('s8PrepBtn')).color)), '步驟 1「傳送資料」是綠色（與頁面上方切換頁數同款分段膠囊，白色旋鈕在它底下）');
check(await page.evaluate(() => { const t = document.getElementById('s8PrepTrack'), k = t.querySelector('.s8-knob'), b = document.getElementById('s8PrepBtn'); return t.classList.contains('has') && Math.abs(k.getBoundingClientRect().left - b.getBoundingClientRect().left) < 1.5 && Math.abs(k.getBoundingClientRect().width - b.getBoundingClientRect().width) < 1.5; }), '步驟 1：白色旋鈕貼在「傳送資料」底下');
check(await page.isHidden('#s8PrepOut'), '還沒傳送：右邊（原本「第 2 頁」的位置）是空的');
check((await page.textContent('#s8Step1 > i')) === '1', '步驟 1 前面有圓圈數字');

// ===== 3. 傳送失敗：下方顯示簡單狀態，沒有後續步驟 =====
prepareFails = true;
await page.click('#s8PrepBtn');
await page.waitForFunction(() => /傳送失敗/.test(document.getElementById('s8PrepMsg').textContent));
check((await page.textContent('#s8PrepMsg')).startsWith('✗ 傳送失敗') && !(await vis('#s8Step2')), '失敗：顯示「傳送失敗」、不出現步驟 2');
check(await page.evaluate(() => { const t = document.getElementById('s8PrepTrack').getBoundingClientRect(), o = document.getElementById('s8PrepOut').getBoundingClientRect(); return o.left >= t.left && o.right <= t.right + 0.5 && o.top >= t.top && o.bottom <= t.bottom + 0.5; }), '狀態包在分段膠囊框內（原本「第 2 頁」的位置）');
prepareFails = false;

// ===== 4. 傳送成功：只顯示簡單狀態（沒有「開啟S8預覽」按鈕）=====
await page.click('#s8PrepBtn');
await page.waitForFunction(() => /傳送完成/.test(document.getElementById('s8PrepMsg').textContent));
check((await page.textContent('#s8PrepMsg')).includes('1,234 人') && !(await page.textContent('#s8PrepMsg')).includes('分鐘內有效'), '成功：顯示「傳送完成」與可發送人數，沒有「預覽 20 分鐘內有效」');
check(reqs.prepare[1].pages[0].buttons[1].title === expectTitle && reqs.prepare[1].pages[0].buttons[0].title.startsWith('項目1'), '傳給 S8 的區塊名稱：有標題的格子用「★標題」，沒標題的退回「項目N」');
check(reqs.prepare.length === 2 && reqs.prepare[1].pages.length === 2 && reqs.prepare[1].pages[0].buttons.length === 6 && reqs.prepare[1].pages[0].buttons[1].url === 'https://example.com/p1/n2?utm_source=x', '傳送內容：兩頁、每頁 6 格、連結用目前字框的值');
check(await vis('#s8Step2') && !(await vis('#s8Step3')), '成功後出現步驟 2，步驟 3 還沒出現');
await page.waitForTimeout(600);
const lineOf = id => page.evaluate(i => { const e = document.getElementById(i); return { linked: e.classList.contains('linked'), done: e.classList.contains('done'), track: getComputedStyle(e, '::before').transform, fill: getComputedStyle(e, '::after').transform }; }, id);
const scaleY = t => { const m = String(t).match(/matrix\(([^)]+)\)/); return m ? Number(m[1].split(',')[3]) : 0; };
let l1 = await lineOf('s8Step1');
check(l1.linked && l1.done && scaleY(l1.track) === 1 && scaleY(l1.fill) === 1, '步驟 1→2 有連線：灰線長出、步驟 1 完成後綠色填滿（動畫跑完）');
check(!(await lineOf('s8Step2')).linked, '最後一個可見步驟（目前是步驟 2）後面沒有連線');
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
check(await page.evaluate(() => parseFloat(getComputedStyle(document.getElementById('s8ConfirmTotal')).borderTopLeftRadius) >= 16), '步驟 3 的輸入框是圓角框');
check((await page.textContent('#s8ConfirmMark')) === '', '還沒輸入：數字框後面沒有標記');
await page.fill('#s8ConfirmTotal', '999');
check(!(await vis('#s8Step4')), '人數輸入錯誤：不出現步驟 4');
check((await page.textContent('#s8ConfirmMark')) === '✗' && (await page.getAttribute('#s8ConfirmMark', 'class')).includes('bad'), '打錯數字：數字框後面出現紅色 ✗');
const markCss = () => page.evaluate(() => { const c = getComputedStyle(document.getElementById('s8ConfirmMark')); const r = document.getElementById('s8ConfirmMark').getBoundingClientRect(); return { bg: c.backgroundColor, color: c.color, radius: c.borderTopLeftRadius, w: Math.round(r.width), h: Math.round(r.height) }; });
let mk = await markCss();
check(mk.bg === 'rgb(220, 38, 38)' && mk.color === 'rgb(255, 255, 255)' && mk.w === mk.h && parseFloat(mk.radius) >= mk.w / 2, `✗ 包在紅底圓圈內（${JSON.stringify(mk)}）`);
await page.fill('#s8ConfirmTotal', '1,234');
check((await page.textContent('#s8ConfirmMark')) === '✓' && (await page.getAttribute('#s8ConfirmMark', 'class')).includes('ok'), '打對數字：數字框後面變成綠色 ✓');
mk = await markCss();
check(mk.bg === 'rgb(22, 163, 74)' && mk.color === 'rgb(255, 255, 255)' && mk.w === mk.h && parseFloat(mk.radius) >= mk.w / 2, `✓ 包在綠底圓圈內（${JSON.stringify(mk)}）`);
await page.mouse.move(0, 0);
const cap = await page.evaluate(() => { const g = id => { const c = getComputedStyle(document.getElementById(id)); return `${c.backgroundColor}|${c.borderTopLeftRadius}|${c.fontWeight}`; }; return { count: g('s8CountBtn'), prep: g('s8PrepTrack'), seg2: g('s8Seg2'), conf: g('s8ConfirmBox'), copy: g('s8CopyName'), create: g('s8CreateBtn') }; });
check(['prep', 'seg2', 'conf', 'copy', 'create'].every(k => cap[k] === cap.count), `步驟 1～5 的膠囊／軌道與「計算符合條件的客戶數」同款（背景／圓角／粗細）：${JSON.stringify(cap)}`);
check(await vis('#s8Step4') && !(await vis('#s8Step5')), '人數輸入正確：出現步驟 4，步驟 5 還沒出現');
check((await page.textContent('#s8CopyTxt')) === '複製群發名稱' && await page.isHidden('#s8CopyOk'), '步驟 4 是「複製群發名稱」，還沒複製時沒有打勾圖示');
await page.click('#s8CopyName');
await page.waitForFunction(() => !document.getElementById('s8Step5').hidden);
check(await vis('#s8Step5'), '按「複製群發名稱」後才出現步驟 5');
const nm = await page.inputValue('#s8Name');
check((await page.textContent('#s8CopyTxt')) === '已複製名稱', '按下後按鈕短暫顯示「已複製名稱」');
const okIcon = await page.evaluate(() => { const i = document.getElementById('s8CopyOk'), b = document.getElementById('s8CopyName'), ir = i.getBoundingClientRect(), br = b.getBoundingClientRect(), c = getComputedStyle(i); return { text: i.textContent, inside: ir.left >= br.left && ir.right <= br.right && ir.top >= br.top && ir.bottom <= br.bottom, right: ir.left > br.left + br.width / 2, round: c.borderTopLeftRadius, bg: c.backgroundColor, w: Math.round(ir.width), h: Math.round(ir.height) }; });
check(okIcon.text === '✓' && okIcon.inside && okIcon.right && okIcon.w === okIcon.h && parseFloat(okIcon.round) >= okIcon.w / 2 && okIcon.bg === 'rgb(22, 163, 74)', `按鈕內右側有綠色圓形打勾圖示（${JSON.stringify(okIcon)}）`);
await shot('s8-3b-copied');
await page.waitForTimeout(1800);
check((await page.textContent('#s8CopyTxt')) === '複製群發名稱' && await page.isVisible('#s8CopyOk'), '一下子之後按鈕文字跳回「複製群發名稱」，圓形打勾圖示仍保留');
await page.fill('#s8ConfirmTotal', '1');
check(await page.isHidden('#s8CopyOk') || !(await vis('#s8Step4')), '人數被改掉、步驟 4 收起時，打勾圖示會重設');
await page.fill('#s8ConfirmTotal', '1,234');
check(await page.isHidden('#s8CopyOk') && (await page.textContent('#s8CopyTxt')) === '複製群發名稱', '重新出現步驟 4 時要重新複製：沒有打勾圖示');
await page.click('#s8CopyName');
await page.waitForFunction(() => !document.getElementById('s8Step5').hidden);
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
check(await vis('#s8WhenMsg') && await vis('#s8Step3'), '按「設定排程時間」：出現月日時分四個下拉選單與步驟 3');
const opts = [];
for (const id of ['s8Mo', 's8Dd', 's8Hh', 's8Mi']) { await page.locator(`.s8-cb-btn[data-for="${id}"]`).click(); opts.push(await page.locator('.s8-cblist div').count()); await page.keyboard.press('Escape'); }
check(JSON.stringify(opts) === JSON.stringify([12, 31, 24, 60]), `月／日／時／分選單選項數：${opts.join('／')}`);
const def = await page.evaluate(() => { const g = id => Number(document.getElementById(id).value); return Date.UTC(new Date(Date.now() + 8 * 3600e3).getUTCFullYear(), g('s8Mo') - 1, g('s8Dd'), g('s8Hh'), g('s8Mi')) - 8 * 3600e3; });
check(Math.abs(def - (Date.now() + 24 * 3600e3)) < 10 * 60e3, '預設時間約為 24 小時後（台北時間）');
const setWhen = async (ms) => { const p = taipeiParts(ms); await page.fill('#s8Mo', String(p.mo)); await page.fill('#s8Dd', String(p.d)); await page.fill('#s8Hh', String(p.h)); await page.fill('#s8Mi', String(p.mi)); return p; };
await page.fill('#s8ConfirmTotal', '1234');
await setWhen(Date.now() + 10 * 60e3);
check((await page.getAttribute('#s8WhenMsg', 'class')).includes('bad') && (await page.textContent('#s8WhenMsg')).includes('30 分鐘'), '設成 10 分鐘後：紅字提示要在 30 分鐘之後');
check(!(await vis('#s8Step4')), '時間不合格：不出現步驟 4');
await setWhen(Date.now() + 9 * 86400e3);
check((await page.textContent('#s8WhenMsg')).includes('7 天') && !(await vis('#s8Step4')), '設成 9 天後：提示最晚 7 天內，不出現步驟 4');
await page.fill('#s8Mo', '2'); await page.fill('#s8Dd', '31');
check(!(await vis('#s8Step4')) && (await page.textContent('#s8WhenMsg')).includes('沒有 31 日'), '不存在的日期（2 月 31 日）會被擋下');
const pillText = await page.textContent('#s8PickSched');
check(pillText.includes('設定排程') && pillText.includes('月') && pillText.includes('日'), '「設定排程」膠囊有「月」「日」文字');
const fw = await page.evaluate(() => ['s8Mo', 's8Dd', 's8Hh', 's8Mi'].map(id => Math.round(document.getElementById(id).getBoundingClientRect().width)));
check(fw.every(w => w <= 48), `時間輸入框很窄（寬 ${fw.join('／')}px）`);
await page.fill('#s8Mo', '13');
check((await page.getAttribute('#s8WhenMsg', 'class')).includes('bad') && (await page.textContent('#s8WhenMsg')).includes('月（1–12）') && !(await vis('#s8Step4')), '手動輸入不合法的月（13）：紅字提示，不出現步驟 4');
await page.fill('#s8Mo', '');
check((await page.textContent('#s8WhenMsg')).includes('請輸入有效的月'), '留白：提示要輸入有效的月');
await setWhen(Date.now() + 3 * 3600e3);
await page.locator('.s8-cb-btn[data-for="s8Hh"]').click();
check(await page.locator('.s8-cblist').isVisible() && (await page.locator('.s8-cblist div').count()) === 24, '按 ▾ 開出時的選單（0–23）');
await shot('s8-5b-time-dropdown');
await page.locator('.s8-cblist div', { hasText: /^09$/ }).click();
check((await page.inputValue('#s8Hh')) === '09' && !(await page.locator('.s8-cblist').isVisible()), '從選單挑 09：填入並收起選單');
await page.fill('#s8Mi', '7'); await page.locator('#s8Mi').blur();
check((await page.inputValue('#s8Mi')) === '07', '手動輸入 7，離開後補成 07');
await page.locator('#s8Hh').focus(); await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp');
check((await page.inputValue('#s8Hh')) === '11', '↑ 鍵可加一');
await page.keyboard.press('Enter');
const want = await setWhen(Date.now() + 3 * 3600e3);
check(!(await page.getAttribute('#s8WhenMsg', 'class')).includes('bad') && await vis('#s8Step4'), '設成 3 小時後：合格，出現步驟 4');
await page.click('#s8CopyName');
const wantText = `${want.y}-${pad2(want.mo)}-${pad2(want.d)} ${pad2(want.h)}:${pad2(want.mi)}`;
check((await page.textContent('#s8CreateBtn')).includes(`建立排程（${wantText} 發送）`), `步驟 5 按鈕寫出確切時間：${wantText}`);
check((await page.textContent('#s8Tip')).includes('不會暫停') && (await page.textContent('#s8Tip')).includes(wantText) && (await page.textContent('#s8Tip')).includes('1,234'), '步驟 5 提示寫出「不會暫停、何時實際發送給幾人」');
const sizes = await page.evaluate(() => ['s8PrepTrack', 's8Seg2', 's8ConfirmBox', 's8CopyName', 's8CreateBtn'].map(id => { const e = document.getElementById(id), r = e.getBoundingClientRect(); return { id, w: Math.round(r.width), h: Math.round(r.height), clipped: e.scrollWidth > e.clientWidth + 1 }; }));
check(sizes.every(x => x.w === sizes[0].w && x.h === sizes[0].h), `步驟裡所有按鈕尺寸一致：${sizes.map(x => `${x.id}=${x.w}×${x.h}`).join('、')}`);
check(sizes.every(x => !x.clipped), '最長的內容（排程時間選單、建立排程文字）都放得下，沒有被裁切');
await page.waitForTimeout(450);
check(await page.evaluate(() => { const k = document.querySelector('#s8Seg2 .s8-knob').getBoundingClientRect(), b = document.getElementById('s8PickSched').getBoundingClientRect(); return Math.abs(k.left - b.left) < 1.5 && Math.abs(k.width - b.width) < 1.5; }), '選「設定排程」：旋鈕滑到它底下（含月日時分選單）');
check(await page.evaluate(() => { const k = document.querySelector('#s8ConfirmBox .s8-knob').getBoundingClientRect(), b = document.getElementById('s8ConfirmLabel').getBoundingClientRect(); return Math.abs(k.left - b.left) < 1.5; }), '步驟 3：白色旋鈕在「確認人數」底下，數字框在右邊');
const slack = await page.evaluate(() => { const t = document.getElementById('s8Seg2'); const kids = Array.from(t.children).filter(e => !e.classList.contains('s8-knob')); const used = kids.reduce((n, e) => n + e.getBoundingClientRect().width, 0) + 6; return Math.round(t.getBoundingClientRect().width - used); });
const wNow = await page.evaluate(() => Math.round(document.getElementById('s8Seg2').getBoundingClientRect().width));
check(slack <= 8, `統一寬度由最長的控制項決定，沒有硬塞空間（寬 ${wNow}px，最長那一個多出 ${slack}px）`);
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
