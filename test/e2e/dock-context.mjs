// 前端驗證：底部工具列依情境顯示（希克定律）——兩頁都空白時「下一步」反灰不能按（進度條 ② 也點不進去）；
// 沒選格子時貼圖反灰；步驟 2「← 返回編輯」在最左、是幽靈按鈕，
// 「全部下載」是最右邊唯一的實心主按鈕，本頁全空時不顯示「下載本頁」（Playwright）
// 執行：
//   python3 -m http.server 8960 &            # 在專案根目錄
//   NODE_PATH=$(npm root -g) node test/e2e/dock-context.mjs
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const BASE = process.env.BASE_URL || 'http://localhost:8960/index.html';
const SHOTS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'screenshots');
mkdirSync(SHOTS, { recursive: true });
let failed = 0;
const check = (cond, label) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) failed++; };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 860 } })).newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));
await page.goto(BASE);
await page.waitForTimeout(800);
const hidden = id => page.evaluate(i => document.getElementById(i).hidden, id);

// ===== 1. 空白頁：工具列照舊，「下一步」反灰不能按 =====
check(!(await hidden('dockStickers')) && !(await hidden('edgeSwitch')) && !(await hidden('resetAllBtn')), '空白頁：T寶貼圖、檢查照片邊緣、清除本頁照常顯示');
const nextOff = () => page.evaluate(() => { const b = document.getElementById('nextStepBtn'); return b.classList.contains('is-disabled') && b.getAttribute('aria-disabled') === 'true'; });
check(await nextOff(), '空白頁：「下一步」反灰');
check(await page.evaluate(() => document.getElementById('nextStepBtn').dataset.tip) === '請先貼上快速填入或放入照片', '反灰的「下一步」有提示文字');
await page.click('#nextStepBtn', { force: true });
check(await page.evaluate(() => step) === 1, '空白頁：按「下一步」不會進步驟 2');
await page.click('.step-btn[data-step="2"]');
check(await page.evaluate(() => step) === 1, '空白頁：點進度條 ② 也不會進步驟 2');
await page.locator('#nextStepBtn').hover();
await page.waitForTimeout(150);
await page.locator('#dock').screenshot({ path: path.join(SHOTS, 'dock-1-empty.png') });
await page.screenshot({ path: path.join(SHOTS, 'dock-1b-empty-tip.png'), clip: { x: 0, y: 700, width: 1440, height: 160 } });

// ===== 2. 只有第 2 頁有內容：第 1 頁也能進下一步 =====
await page.evaluate(() => { pages[1].cards[0].line1 = '標題'; syncChrome(); });
check(!(await nextOff()), '任一頁有內容：「下一步」恢復可按');
await page.evaluate(() => { pages[1] = makePageState(1); syncChrome(); });
check(await nextOff(), '內容清掉：「下一步」再度反灰');

// ===== 3. 貼圖：沒選格子時反灰 =====
await page.evaluate(() => { pages[activePageIndex].cards[0].line1 = '標題'; render(); });
check(!(await nextOff()), '本頁打了字：「下一步」可按');
check(await page.evaluate(() => document.getElementById('stickerPalette').classList.contains('need-cell')), '沒選格子：貼圖反灰');
await page.evaluate(() => { setActiveCard(0, true); syncChrome(); });
check(!(await page.evaluate(() => document.getElementById('stickerPalette').classList.contains('need-cell'))), '選了格子：貼圖恢復正常');
await page.evaluate(() => { cellSelected = false; syncChrome(); });

// 清除本頁：仍要二次確認，取消後內容還在
await page.click('#resetAllBtn');
check(await page.evaluate(() => document.getElementById('confirmOverlay').classList.contains('open')), '清除本頁：跳出確認視窗');
await page.click('#confirmCancelBtn');
check(await page.evaluate(() => pages[activePageIndex].cards[0].line1 === '標題'), '取消清除：內容保留');

// ===== 4. 步驟 2：返回編輯在最左（幽靈）、全部下載在最右（唯一實心）=====
await page.evaluate(() => { goStep(2); });
const bar = await page.evaluate(() => {
  const vis = Array.from(document.querySelectorAll('#downloadRow > button, #downloadRow > .dock-chip')).filter(e => !e.hidden && e.offsetWidth);
  const bg = e => getComputedStyle(e).backgroundColor;
  return { order: vis.map(e => e.id), back: bg(document.getElementById('backStepBtn')), jpg: bg(document.getElementById('downloadJpgBtn')) };
});
check(bar.order[0] === 'backStepBtn' && bar.order[bar.order.length - 1] === 'downloadAllBtn', `步驟 2 順序：${bar.order.join(' → ')}`);
check(bar.back === 'rgba(0, 0, 0, 0)', '「返回編輯」是幽靈按鈕（透明底）');
check(bar.jpg === 'rgba(0, 0, 0, 0)', '「下載本頁」是外框次要按鈕（透明底）');
check(await hidden('dockStickers') && await hidden('edgeSwitch') && await hidden('resetAllBtn'), '步驟 2：不顯示貼圖、檢查照片邊緣、清除本頁');
await page.evaluate(() => { document.getElementById('downloadAllBtn').classList.remove('is-disabled'); });   // 只為截圖
await page.locator('#dock').screenshot({ path: path.join(SHOTS, 'dock-3-step2.png') });

// ===== 5. 步驟 2 本頁全空：不顯示「下載本頁」=====
await page.evaluate(() => { goStep(1); pages[activePageIndex] = makePageState(activePageIndex); goStep(2); });
check(await hidden('downloadJpgBtn'), '步驟 2 本頁全空：不顯示「下載本頁」');

// ===== 6. 拼圖：「下載」照常顯示 =====
await page.click('.mode-tab[data-mode="collage"]');
await page.waitForTimeout(300);
check(!(await hidden('downloadJpgBtn')) && !(await hidden('copyCollageBtn')), '拼圖：「下載」「直接複製」照常顯示');

check(pageErrors.length === 0, `頁面沒有 JS 錯誤${pageErrors.length ? '：' + pageErrors.join(' / ') : ''}`);
await browser.close();
console.log(failed ? `\n${failed} 項失敗` : '\n全部通過');
process.exit(failed ? 1 : 0);
