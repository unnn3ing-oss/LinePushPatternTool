// 前端驗證：右上角「試驗功能」按鈕（和「S8 已連結」）在 新聞／娛樂／拼圖 三種版型、各種視窗寬度都停在同一個位置。
// 執行：python3 -m http.server 8960 &  然後  NODE_PATH=$(npm root -g) node test/e2e/lab-toggle-pos.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
let failed = 0;
const check = (c, l) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${l}`); if (!c) failed++; };
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
for (const vw of [1400, 1100, 900]) {
  const page = await browser.newPage({ viewport: { width: vw, height: 800 } });
  await page.addInitScript(() => { sessionStorage.setItem('labAuth', JSON.stringify({ token: 't', expiresAt: Date.now() + 3600e3 })); });
  await page.goto(process.env.BASE_URL || 'http://localhost:8960/index.html');
  await page.evaluate(() => setLab(true));
  const pos = [];
  for (const m of ['news', 'ent', 'collage', 'news']) {
    await page.click(`.mode-tab[data-mode="${m}"]`);
    await page.waitForTimeout(250);
    pos.push(await page.evaluate(() => { const r = document.getElementById('labToggle').getBoundingClientRect(), s = document.getElementById('s8Link').getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(s.left)]; }));
  }
  check(pos.every(p => p.join() === pos[0].join()), `視窗寬 ${vw}px：新聞／娛樂／拼圖／回新聞，「試驗功能」與「S8」按鈕位置都一樣 ${JSON.stringify(pos[0])}`);
  await page.close();
}
await browser.close();
console.log(failed ? `\n${failed} 項失敗` : '\n全部通過');
process.exit(failed ? 1 : 0);
