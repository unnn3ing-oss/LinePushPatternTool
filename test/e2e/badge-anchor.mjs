// 前端驗證：新聞版步驟 2 的「!」位置——下排的「!」要在「照片開始看得到的位置」往下 24px（不能壓在上排的黑色漸層帶上）；上排維持原位。
// 執行：python3 -m http.server 8960 &  然後  NODE_PATH=$(npm root -g) node test/e2e/badge-anchor.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
let failed = 0;
const check = (c, l) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${l}`); if (!c) failed++; };
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage();
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.goto(process.env.BASE_URL || 'http://localhost:8960/index.html');
await page.evaluate(() => templatesReady);
const r = await page.evaluate(() => {
  const out = {};
  for (const hdr of [true, false]) {
    out[hdr ? 'p1' : 'p2'] = [0, 1, 2, 3, 4, 5].map(i => ({ cellTop: cellRect(i, hdr).y, a: badgeAnchor(i, hdr).y, edge: NEWS_BAND_EDGE[hdr ? ROW_EDGES_HEADER[0] : ROW_EDGES_PLAIN[0]] }));
  }
  return out;
});
for (const [k, rows] of Object.entries(r)) {
  const edge = rows[0].edge;
  check(rows.slice(0, 3).every(x => x.a === x.cellTop + 24), `${k}：上排「!」維持在格子上方 +24`);
  check(rows.slice(3).every(x => x.a === edge + 24), `${k}：下排「!」在黑色帶下緣（${edge}）往下 24px（${rows[3].a}），不是舊位置（${rows[3].cellTop + 24}）`);
  check(rows.slice(3).every(x => x.a - 15 > edge), `${k}：下排「!」圓圈完全在黑色帶下方`);
}
check(errs.length === 0, '頁面沒有 JS 錯誤');
await browser.close();
console.log(failed ? `\n${failed} 項失敗` : '\n全部通過');
process.exit(failed ? 1 : 0);
