// 前端驗證：底部工具列依情境顯示（希克定律）——空白頁只留「下一步」；放了照片才出現 T寶貼圖與「⋯ 更多」
// （檢查照片邊緣、清除本頁收在選單裡）；沒選格子時貼圖反灰；步驟 2「← 返回編輯」在最左、是幽靈按鈕，
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

// ===== 1. 空白頁：只留「下一步」=====
check(await hidden('dockStickers'), '空白頁：不顯示 T寶貼圖');
check(await hidden('dockMore'), '空白頁：不顯示「⋯ 更多」（檢查照片邊緣、清除本頁）');
check(!(await hidden('nextStepBtn')), '空白頁：「下一步」照常顯示');
await page.locator('#dock').screenshot({ path: path.join(SHOTS, 'dock-1-empty.png') });

// ===== 2. 只打字、沒照片：可以清除，但貼圖與邊緣檢查仍隱藏 =====
await page.evaluate(() => { pages[activePageIndex].cards[0].line1 = '標題'; render(); });
check(!(await hidden('dockMore')) && !(await hidden('resetAllBtn')) && await hidden('edgeSwitch'), '只有文字：「⋯ 更多」只有「清除本頁」');
check(await hidden('dockStickers'), '只有文字：仍不顯示貼圖');

// ===== 3. 放了照片：貼圖出現，沒選格子時反灰；選單裡有邊緣檢查 =====
await page.evaluate(async () => {
  const c = document.createElement('canvas'); c.width = c.height = 40;
  c.getContext('2d').fillRect(0, 0, 40, 40);
  const img = new Image(); img.src = c.toDataURL(); await img.decode();
  pages[activePageIndex].cards[0].img = img; render();
});
check(!(await hidden('dockStickers')), '有照片：顯示 T寶貼圖');
check(await page.evaluate(() => document.getElementById('stickerPalette').classList.contains('need-cell')), '沒選格子：貼圖反灰');
await page.evaluate(() => { setActiveCard(0, true); syncChrome(); });
check(!(await page.evaluate(() => document.getElementById('stickerPalette').classList.contains('need-cell'))), '選了格子：貼圖恢復正常');
check(await hidden('dockMenu'), '選單預設收合');
await page.click('#dockMoreBtn');
check(!(await hidden('dockMenu')) && !(await hidden('edgeSwitch')) && !(await hidden('resetAllBtn')), '點「⋯ 更多」：展開「檢查照片邊緣」與「清除本頁」');
await page.waitForTimeout(200);
await page.screenshot({ path: path.join(SHOTS, 'dock-2-more-menu.png'), clip: { x: 0, y: 560, width: 1440, height: 300 } });
await page.keyboard.press('Escape');
check(await hidden('dockMenu'), 'Esc 收起選單');

// 清除本頁：仍要二次確認，取消後內容還在
await page.click('#dockMoreBtn');
await page.click('#resetAllBtn');
check(await page.evaluate(() => document.getElementById('confirmOverlay').classList.contains('open')), '清除本頁：跳出確認視窗');
await page.click('#confirmCancelBtn');
check(await page.evaluate(() => !!pages[activePageIndex].cards[0].img), '取消清除：內容保留');

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
check(await hidden('dockStickers') && await hidden('dockMore'), '步驟 2：不顯示貼圖與「⋯ 更多」');
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
