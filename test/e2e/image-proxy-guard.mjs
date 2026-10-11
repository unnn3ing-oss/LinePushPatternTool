// ?imageProxy= 防釣魚：陌生網址不會被直接採用、不會收到 Lab 密碼（Playwright；所有外部請求都被攔截）
// 執行：python3 -m http.server 8960 &  然後  NODE_PATH=$(npm root -g) node test/e2e/image-proxy-guard.mjs
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const HTML = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../index.html'), 'utf8');
const BASE = 'http://localhost:8960/index.html';
const PROD = 'https://prod.example/index.html';   // 模擬正式站：用同一份 index.html，但網域不是 localhost
const DEFAULT = 'https://og-image-proxy.19jpz-3.workers.dev';
const EVIL = 'https://evil.example';
let fails = 0;
const check = (ok, name) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) fails++; };

const browser = await chromium.launch();
async function fresh(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await ctx.newPage();
  const hits = [], dialogs = [];
  await ctx.route('https://prod.example/**', r => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: HTML }));
  await ctx.route(/^https:\/\/(?!prod\.example)/, r => { hits.push(r.request().url()); r.fulfill({ status: 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' }); });
  page.on('dialog', d => { dialogs.push(d.message()); opts.accept ? d.accept() : d.dismiss(); });
  return { ctx, page, hits, dialogs };
}
const proxyNow = page => page.evaluate(() => imageProxyUrl());
const stored = page => page.evaluate(() => [localStorage.getItem('imageProxy'), localStorage.getItem('imageProxyOk')]);

// 1. 在非 localhost 的頁面上，陌生網址 → 跳確認；取消 → 用預設 Worker，不記住
async function asProd(page, url) { await page.goto(url.replace(BASE, PROD)); }
{
  const { ctx, page, hits, dialogs } = await fresh();
  await asProd(page, `${BASE}?imageProxy=${encodeURIComponent(EVIL)}&x=1`);
  check(await proxyNow(page) === DEFAULT, '正式站 + 陌生 imageProxy，按取消：用預設 Worker');
  check(dialogs.length === 1 && dialogs[0].includes(EVIL) && dialogs[0].includes('密碼'), '確認視窗顯示完整網址並說明密碼會送過去');
  check((await stored(page)).every(v => v === null), '沒同意：什麼都不記住');
  check(await page.evaluate(() => !location.search.includes('imageProxy') && location.search.includes('x=1')), '網址列拿掉 imageProxy 參數、其他參數保留');
  check(hits.every(u => !u.startsWith(EVIL)), '沒有任何請求送到陌生網址');
  await ctx.close();
}
// 2. 同意 → 記住那一個網址；之後重新整理不再問
{
  const { ctx, page, dialogs } = await fresh({ accept: true });
  await asProd(page, `${BASE}?imageProxy=${encodeURIComponent(EVIL)}`);
  check(await proxyNow(page) === EVIL && (await stored(page))[1] === EVIL, '按確定：採用並記住該網址');
  await asProd(page, BASE);
  check(await proxyNow(page) === EVIL && dialogs.length === 1, '重新開啟：沿用、不再詢問');
  await ctx.close();
}
// 3. 以前（舊版）直接存進 localStorage 的陌生網址：沒有同意紀錄 → 重新詢問，取消就丟掉
{
  const { ctx, page, dialogs } = await fresh();
  await page.addInitScript(u => { try { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('imageProxy', u); sessionStorage.setItem('seeded', '1'); } } catch (e) { /* */ } }, EVIL);
  await asProd(page, BASE);
  check(await proxyNow(page) === DEFAULT && dialogs.length === 1, '舊版留下的陌生網址：要重新確認，取消就恢復預設');
  check((await stored(page)).every(v => v === null), '並且清掉');
  await ctx.close();
}
// 4. 預設網址、http 網址、帶帳號密碼的網址
{
  const { ctx, page, dialogs } = await fresh();
  await asProd(page, `${BASE}?imageProxy=${encodeURIComponent(DEFAULT)}`);
  check(await proxyNow(page) === DEFAULT && dialogs.length === 0, '指定預設網址：直接採用、不跳視窗');
  await ctx.close();
  for (const bad of ['http://evil.example', 'https://user:pw@evil.example', 'javascript:alert(1)', 'not a url']) {
    const r = await fresh();
    await asProd(r.page, `${BASE}?imageProxy=${encodeURIComponent(bad)}`);
    check(await proxyNow(r.page) === DEFAULT && r.dialogs.length === 0 && (await stored(r.page)).every(v => v === null), `不合法的網址「${bad}」：直接忽略，用預設`);
    await r.ctx.close();
  }
}
// 5. 本機開發（頁面在 localhost）：直接採用，e2e 才能攔截假 Worker
{
  const { ctx, page, dialogs } = await fresh();
  await page.goto(`${BASE}?imageProxy=${encodeURIComponent('https://worker.test')}`);
  check(await proxyNow(page) === 'https://worker.test' && dialogs.length === 0, '頁面在 localhost：直接採用（開發／測試用）');
  await page.goto(`${BASE}?imageProxy=`);
  check(await proxyNow(page) === DEFAULT, '?imageProxy= 空的：恢復預設');
  await ctx.close();
}
// 6. 試驗功能登入：密碼只會 POST 到實際採用的網址（取消後是預設，不是陌生網址）
{
  const { ctx, page, hits } = await fresh();
  await asProd(page, `${BASE}?imageProxy=${encodeURIComponent(EVIL)}`);
  await page.evaluate(() => { openLabLogin(); document.getElementById('labPass').value = 'secret-pass'; });
  await page.evaluate(() => submitLabLogin());
  await page.waitForTimeout(300);
  check(hits.some(u => u === `${DEFAULT}/lab-auth`) && hits.every(u => !u.startsWith(EVIL)), '密碼只送到預設 Worker，沒送到陌生網址');
  await ctx.close();
}
await browser.close();
console.log(fails ? `\n有 ${fails} 項失敗` : '\n全部通過');
process.exit(fails ? 1 : 0);
