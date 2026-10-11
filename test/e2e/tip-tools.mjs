// 前端驗證：右下角「操作提示」彈窗——先顯示「更多工具」4 秒再自動滑到「操作提示」、共約 8 秒後收起、可左右滑動／圓點／左右鍵切換、連結另開分頁
// （Playwright；因為要等計時，整支約 15 秒）
// 執行：python3 -m http.server 8960 &  然後  NODE_PATH=$(npm root -g) node test/e2e/tip-tools.mjs
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:8960/index.html';
let failed = 0;
const check = (cond, label) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) failed++; };
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await browser.newContext({ viewport: { width: 1900, height: 900 } });
const page = await ctx.newPage();
const errs = []; page.on('pageerror', e => errs.push(e.message));
await ctx.route('https://unnn3ing-oss.github.io/**', r => r.fulfill({ status: 200, contentType: 'text/html', body: 'tool' }));
const t0 = Date.now();
await page.goto(BASE);
const st = () => page.evaluate(() => ({ page: tipPage, title: document.getElementById('tipToastTitle').textContent, collapsed: document.getElementById('tipToast').classList.contains('tip-collapsed'), tx: document.getElementById('tipTrack').style.transform, hGap: Math.abs(parseFloat(document.getElementById('tipPager').style.height) - document.getElementById(tipPage === 0 ? 'tipPaneTools' : 'tipPaneTips').offsetHeight) }));
await page.waitForTimeout(600);
let s = await st();
check(s.page === 0 && s.title === '更多工具' && !s.collapsed, `剛開網頁：先顯示「更多工具」（${s.title}）`);
const info = await page.evaluate(() => ({ links: [...document.querySelectorAll('#tipPaneTools a.tip-tool-link')].map(a => [a.href, a.target, a.rel]), names: [...document.querySelectorAll('#tipPaneTools .tip-text b')].map(b => b.textContent), descs: [...document.querySelectorAll('#tipPaneTools .tip-text > span')].map(x => x.textContent.length > 20), nested: document.querySelectorAll('#tipPaneTools a a, #tipPaneTools a button').length, cards: [...document.querySelectorAll('#tipPaneTools a.tip-tool-link')].map(a => { const r = a.getBoundingClientRect(), cs = getComputedStyle(a); return r.width > 250 && r.height > 60 && parseFloat(cs.borderTopWidth) > 0 && cs.cursor === 'pointer'; }), cardText: [...document.querySelectorAll('#tipPaneTools a.tip-tool-link')].map(a => a.querySelector('b').textContent) }));
check(info.names.join('|') === '圖片套版產生器|YouTube 影片批量下載工具' && info.descs.every(Boolean), `兩個工具都有名稱與簡述：${info.names.join('、')}`);
check(info.cards.length === 2 && info.cards.every(Boolean) && info.nested === 0 && info.cardText.join('|') === '圖片套版產生器|YouTube 影片批量下載工具', '兩個工具各是一個框，整個框就是連結（外框、游標手指、框內沒有另一顆按鈕）');
check(info.links[0][0] === 'https://unnn3ing-oss.github.io/QuickPatterntool/' && info.links[1][0] === 'https://unnn3ing-oss.github.io/videodownload/' && info.links.every(l => l[1] === '_blank' && /noopener/.test(l[2])), '網頁版連結正確、另開分頁');
check(s.hGap < 2, '彈窗高度貼合目前分頁');
await page.waitForFunction(() => tipPage === 1, null, { timeout: 6000 });
const tSlide = Date.now() - t0;
check(tSlide > 3500 && tSlide < 5200, `約 4 秒後自動滑到「操作提示」（${(tSlide / 1000).toFixed(1)} 秒）`);
await page.waitForTimeout(500);
s = await st();
check(s.title === '操作提示' && s.tx === 'translateX(-100%)' && !s.collapsed && s.hGap < 2, '已滑到「操作提示」，標題跟著換');
await page.waitForFunction(() => document.getElementById('tipToast').classList.contains('tip-collapsed'), null, { timeout: 8000 });
const tClose = Date.now() - t0;
check(tClose > 7500 && tClose < 9500, `共約 8 秒後自動收起（${(tClose / 1000).toFixed(1)} 秒）`);

// 從「!」重新打開：直接是操作提示
await page.click('#tipFab'); await page.waitForTimeout(400);
s = await st();
check(!s.collapsed && s.page === 1, '按「!」重新打開：直接顯示「操作提示」');
await page.hover('#tipToast .tip-toast-head');   // 游標放在彈窗上才不會中途收起

// 圓點、左右鍵
await page.click('#tipDot0'); await page.waitForTimeout(500);
check((await st()).page === 0, '按圓點：回到「更多工具」');
await page.focus('#tipDot0'); await page.keyboard.press('ArrowRight'); await page.waitForTimeout(400);
check((await st()).page === 1, '按右鍵：到「操作提示」');
await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(400);
check((await st()).page === 0, '按左鍵：回「更多工具」');

// 拖曳滑動
const box = await page.locator('#tipPager').boundingBox();
const cy = box.y + 20;
await page.mouse.move(box.x + box.width - 30, cy); await page.mouse.down(); await page.mouse.move(box.x + 80, cy, { steps: 8 }); await page.mouse.up(); await page.waitForTimeout(500);
check((await st()).page === 1, '向左拖曳：滑到「操作提示」');
await page.mouse.move(box.x + 40, cy); await page.mouse.down(); await page.mouse.move(box.x + box.width - 20, cy, { steps: 8 }); await page.mouse.up(); await page.waitForTimeout(500);
check((await st()).page === 0, '向右拖曳：滑回「更多工具」');
await page.mouse.move(box.x + box.width - 30, cy); await page.mouse.down(); await page.mouse.move(box.x + box.width - 60, cy, { steps: 4 }); await page.mouse.up(); await page.waitForTimeout(500);
check((await st()).page === 0, '拖得太短：彈回原位');

// 點連結：新分頁；拖曳經過連結不會誤開
const [pop] = await Promise.all([ctx.waitForEvent('page', { timeout: 4000 }), page.locator('#tipPaneTools a.tip-tool-link').first().locator('.tip-text span').click()]);
check(pop.url() === 'https://unnn3ing-oss.github.io/QuickPatterntool/', `點第一個工具的框：新分頁開 ${pop.url()}`);
await pop.close();
check(page.url().startsWith('http://localhost') && (await st()).page === 0, '原頁面沒被導走');
const pagesBefore = ctx.pages().length;
const lk = await page.locator('#tipPaneTools a.tip-tool-link').first().boundingBox();
const pop2P = ctx.waitForEvent('page', { timeout: 4000 });
await page.locator('#tipPaneTools a.tip-tool-link').nth(1).click();
const pop2 = await pop2P;
check(pop2.url() === 'https://unnn3ing-oss.github.io/videodownload/', `點第二個工具的框：新分頁開 ${pop2.url()}`);
await pop2.close();
await page.mouse.move(lk.x + lk.width - 4, lk.y + lk.height / 2); await page.mouse.down(); await page.mouse.move(lk.x - 150, lk.y + lk.height / 2, { steps: 8 }); await page.mouse.up(); await page.waitForTimeout(600);
check(ctx.pages().length === pagesBefore && (await st()).page === 1, '從連結上開始拖曳滑動：會換頁，不會誤開連結');

// 不在目前分頁的連結不能被 Tab 到
const inert = await page.evaluate(() => document.getElementById('tipPaneTools').inert && !document.getElementById('tipPaneTips').inert);
check(inert, '看不到的分頁不能被 Tab 聚焦（inert）');
check(errs.length === 0, `頁面沒有 JS 錯誤 ${errs.join('|')}`);
await browser.close();
console.log(failed ? `\n${failed} 項失敗` : '\n全部通過');
process.exit(failed ? 1 : 0);
