// 前端驗證：新聞／娛樂「步驟 2 畫面檢查」——游標移到預覽圖的格子上就顯示「複製推播連結」（不用再點）。
// 執行：python3 -m http.server 8960 &  然後  NODE_PATH=$(npm root -g) node test/e2e/cell-hover-copy.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const SHOTS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'screenshots');
let failed = 0;
const check = (c, l) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${l}`); if (!c) failed++; };
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await (await browser.newContext({ viewport: { width: 1300, height: 1000 } })).newPage();
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.goto(process.env.BASE_URL || 'http://localhost:8960/index.html');
await page.evaluate(() => { window.__copied = []; copyText = async t => { window.__copied.push(t); return true; }; });   // 不依賴瀏覽器剪貼簿權限

for (const m of ['news', 'ent']) {
  await page.click(`.mode-tab[data-mode="${m}"]`); await page.waitForTimeout(250);
  await page.evaluate(() => { pages[0].cards.forEach((c, i) => { c.url = i === 1 ? '' : `https://news.tvbs.com.tw/politics/${2000 + i}`; }); });
  await page.evaluate(() => goStep(2)); await page.waitForTimeout(400);
  const cellCenter = i => page.evaluate(i => { const rc = stepTwoCellRect(i, activePage().showHeader), r = canvas.getBoundingClientRect(); return { x: r.left + (rc.x + rc.w / 2) * r.width / CANVAS_W, y: r.top + (rc.y + rc.h / 2) * r.height / CANVAS_H, w: rc.w * r.width / CANVAS_W, h: rc.h * r.height / CANVAS_H }; }, i);
  const btn = () => page.evaluate(() => { const b = document.getElementById('cellCopyBtn'), r = b.getBoundingClientRect(); return { hidden: b.hidden, text: b.textContent, cx: r.left + r.width / 2, cy: r.top + r.height / 2, cls: b.className }; });
  const label = m === 'news' ? '新聞' : '娛樂';
  check(await page.evaluate(() => document.getElementById('cellCopyBtn').hidden), `${label}：一進步驟 2 沒有游標在格子上，不顯示「複製推播連結」`);
  const c0 = await cellCenter(0);
  await page.mouse.move(c0.x - c0.w / 4, c0.y - c0.h / 4);   // 在第 1 格內、但不在正中間
  await page.waitForTimeout(250);
  let b = await btn();
  check(!b.hidden && b.text === '複製推播連結' && Math.abs(b.cx - c0.x) < 3 && Math.abs(b.cy - c0.y) < 3, `${label}：游標移到第 1 格上（沒有按下）→ 該格正中間出現「複製推播連結」`);
  check(await page.evaluate(() => cellSelected && activeCard === 0), `${label}：第 1 格同時淡淡反灰（和以前點選一樣的樣子）`);
  await page.screenshot({ path: path.join(SHOTS, `cell-hover-${m}.png`), clip: { x: 0, y: 0, width: 1300, height: 900 } });
  // 換到另一格：按鈕跟著移動
  const c3 = await cellCenter(3);
  await page.mouse.move(c3.x + c3.w / 4, c3.y + c3.h / 4, { steps: 6 }); await page.waitForTimeout(250);
  b = await btn();
  check(!b.hidden && Math.abs(b.cx - c3.x) < 3 && Math.abs(b.cy - c3.y) < 3 && await page.evaluate(() => activeCard === 3), `${label}：游標移到第 4 格 → 按鈕跟到第 4 格正中間`);
  // 沒有連結的格子
  const c1 = await cellCenter(1);
  await page.mouse.move(c1.x - c1.w / 4, c1.y + c1.h / 4, { steps: 6 }); await page.waitForTimeout(250);
  b = await btn();
  check(!b.hidden && b.text === '這格沒有連結' && b.cls.includes('no-link'), `${label}：沒有連結的格子顯示「這格沒有連結」`);
  // 從格子移到按鈕上：不會收起，而且點得到
  await page.mouse.move(c0.x - c0.w / 4, c0.y - c0.h / 4, { steps: 4 }); await page.waitForTimeout(250);
  b = await btn();
  await page.mouse.move(b.cx, b.cy, { steps: 8 }); await page.waitForTimeout(250);
  check(!(await btn()).hidden && await page.evaluate(() => activeCard === 0), `${label}：游標從格子移到「複製推播連結」按鈕上時，按鈕不會消失`);
  await page.mouse.down(); await page.mouse.up(); await page.waitForTimeout(150);
  check(await page.evaluate(() => window.__copied.at(-1)) !== undefined && (await page.evaluate(() => window.__copied.at(-1))).startsWith(`https://news.tvbs.com.tw/politics/2000`) && (await btn()).text === '已複製 ✓', `${label}：按下去複製第 1 格的推播連結（含追蹤碼），按鈕顯示「已複製 ✓」`);
  // 游標離開預覽圖（也不在按鈕上）→ 收起、取消反灰
  await page.mouse.move(5, 500, { steps: 8 }); await page.waitForTimeout(300);
  check((await btn()).hidden && await page.evaluate(() => !cellSelected), `${label}：游標移出預覽圖 → 按鈕收起、格子恢復`);
  // 點格子（觸控螢幕的做法）還是可以
  await page.mouse.click(c3.x + c3.w / 4, c3.y - c3.h / 4); await page.waitForTimeout(250);
  check(!(await btn()).hidden && await page.evaluate(() => activeCard === 3), `${label}：直接點格子也一樣會顯示（觸控螢幕沒有 hover 時用）`);
  await page.mouse.move(5, 500); await page.waitForTimeout(250);
  // 編輯畫面（步驟 1）不顯示
  await page.evaluate(() => goStep(1)); await page.waitForTimeout(300);
  const e0 = await page.evaluate(() => { const r = canvas.getBoundingClientRect(); return { x: r.left + r.width * 0.2, y: r.top + r.height * 0.5 }; });
  await page.mouse.move(e0.x, e0.y); await page.waitForTimeout(250);
  check((await btn()).hidden, `${label}：步驟 1（編輯畫面）游標在格子上也不會出現「複製推播連結」`);
  // 換頁後不殘留
  await page.evaluate(() => goStep(2)); await page.waitForTimeout(300);
  await page.mouse.move(c0.x - c0.w / 4, c0.y - c0.h / 4); await page.waitForTimeout(250);
  await page.click('.page-tab[data-page="1"], #pageTabs button:nth-child(2)').catch(() => {});
  await page.mouse.move(5, 500); await page.waitForTimeout(250);
  check((await btn()).hidden, `${label}：游標移開後，按鈕不會殘留`);
}
await page.click('.mode-tab[data-mode="collage"]'); await page.waitForTimeout(300);
await page.mouse.move(600, 400); await page.waitForTimeout(200);
check((await page.evaluate(() => document.getElementById('cellCopyBtn').hidden)), '拼圖：不會出現「複製推播連結」');
check(errs.length === 0, `頁面沒有 JS 錯誤 ${errs.join(' | ')}`);
await browser.close();
console.log(failed ? `\n${failed} 項失敗` : '\n全部通過');
process.exit(failed ? 1 : 0);
