// 前端驗證：「連結 SUPER 8 Studio」視窗（一次授權讀取＋寫入、簡化版面、中斷連結要先確認）。Worker 全部用假回應攔截，不會連到真的 S8。
// 執行：
//   python3 -m http.server 8960 &            # 在專案根目錄
//   NODE_PATH=$(npm root -g) node test/e2e/s8-connect.mjs
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

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await browser.newContext({ viewport: { width: 900, height: 900 } });
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));

const loginBodies = [];
let statusScope = 'insightark-mcp:read insightark-mcp:write';
await page.route(`${WORKER}/**`, async route => {
  const url = new URL(route.request().url());
  const body = route.request().postDataJSON?.() || {};
  const json = (obj, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(obj) });
  if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' } });
  if (url.pathname === '/s8/login-start') {
    loginBodies.push(body);
    return json({ authorizeUrl: 'https://s8.example/authorize?x=1', clientId: 'cidW', registered: !body.clientId, scope: 'insightark-mcp:read insightark-mcp:write' });
  }
  if (url.pathname === '/s8/status') return json({ ok: true, scope: statusScope, session: null, me: { data: { user: { lastName: '莊', firstName: '鈞評', email: 'a@b.c' } } }, organizations: { data: { organizations: [{ id: 'o1', displayName: 'TVBS新聞' }, { id: 'o2', displayName: 'TVBS娛樂頭條' }] } } });
  return json({ error: `unexpected ${url.pathname}` }, 404);
});
await page.addInitScript(() => {
  sessionStorage.setItem('labAuth', JSON.stringify({ token: 'lab-token', expiresAt: Date.now() + 3600e3 }));
  window.__opened = [];
  window.open = (u) => { window.__opened.push(u); return {}; };
});
await page.goto(`${BASE}?imageProxy=${encodeURIComponent(WORKER)}`);
await page.evaluate(() => { setLab(true); });
const dialogs = [];
let dialogAnswer = false;
page.on('dialog', async d => { dialogs.push(d.message()); await (dialogAnswer ? d.accept() : d.dismiss()); });
const vis = async sel => !(await page.locator(sel).isHidden());

// ===== 未連結 =====
await page.click('#s8Link');
check((await page.textContent('#s8cState')) === '尚未連結', '未連結：狀態顯示「尚未連結」');
check((await page.textContent('#s8cOut')).includes('讀取＋寫入') && (await page.textContent('#s8cOut')).includes('不用再重複授權'), '提示窗說明一次授予讀取＋寫入權限');
check(await page.locator('#s8cUpgrade').count() === 0, '「升級為可建立草稿」按鈕已移除');
check(await vis('#s8cConnect') && await vis('#s8cDisconnect') && await vis('#s8cCheck'), '看得到「連結 S8」「中斷連結」「檢查連結狀態」');
check((await page.textContent('#s8cConnect')) === '連結 S8' && (await page.textContent('#s8cDisconnect')) === '中斷連結' && (await page.textContent('#s8cCheck')) === '檢查連結狀態', '三個按鈕文字');
check(await page.locator('#s8cTools').count() === 1 && (await vis('#s8cTools')), '「查看工具定義」按鈕顯示（唯讀，只列出工具名稱與欄位）');
const ys = await page.evaluate(() => ['s8cState', 's8cOut', 's8cConnect'].map(id => document.getElementById(id).getBoundingClientRect().top));
check(ys[0] < ys[1] && ys[1] < ys[2], '由上到下：連結狀態 → 提示窗 → 按鈕');
await page.screenshot({ path: path.join(SHOTS, 's8c-1-disconnected.png') });

// ===== 連結：一律要 read+write，記住用戶端 id 避免重複註冊 =====
await page.click('#s8cConnect');
await page.waitForFunction(() => window.__opened.length === 1);
check(loginBodies.length === 1 && !('upgrade' in loginBodies[0]) && loginBodies[0].clientId === '', '第一次連結：不帶 upgrade、沒有舊的用戶端 id');
check((await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('s8ClientW:')).length)) === 1, '記住帶 write 的用戶端 id（新的儲存鍵 s8ClientW:）');
await page.click('#s8cConnect');
await page.waitForFunction(() => window.__opened.length === 2);
check(loginBodies[1].clientId === 'cidW', '再次連結：沿用同一個用戶端 id，不重複註冊');

// ===== 已連結（讀＋寫）=====
await page.evaluate(() => { sessionStorage.setItem('s8Session', 'opaque'); });
await page.click('#s8cCheck');
await page.waitForFunction(() => /身分/.test(document.getElementById('s8cOut').textContent));
check((await page.textContent('#s8cState')) === '已連結', '已連結：狀態顯示「已連結」');
check((await page.textContent('#s8cOut')).includes('莊鈞評') && (await page.textContent('#s8cOut')).includes('TVBS娛樂頭條'), '提示窗顯示身分與可管理的組織');
await page.screenshot({ path: path.join(SHOTS, 's8c-2-connected.png') });

// ===== 中斷連結：先確認 =====
dialogAnswer = false;
await page.click('#s8cDisconnect');
check(dialogs.length === 1 && dialogs[0].includes('確定要中斷'), '按「中斷連結」先跳警告確認');
check(!!(await page.evaluate(() => sessionStorage.getItem('s8Session'))) && (await page.textContent('#s8cState')) === '已連結', '按「取消」：仍維持連結');
dialogAnswer = true;
await page.click('#s8cDisconnect');
check(dialogs.length === 2, '再按一次，確認視窗再出現');
check(!(await page.evaluate(() => sessionStorage.getItem('s8Session'))) && (await page.textContent('#s8cState')) === '尚未連結', '按「確定」：才真的中斷');
await page.click('#s8cDisconnect');
check(dialogs.length === 2 && (await page.textContent('#s8cOut')).includes('沒有連結'), '本來就沒連結時：不跳確認，只提示');

// ===== 舊的唯讀授權 =====
statusScope = 'insightark-mcp:read';
await page.evaluate(() => { sessionStorage.setItem('s8Session', 'opaque'); });
await page.click('#s8cCheck');
await page.waitForFunction(() => /唯讀/.test(document.getElementById('s8cState').textContent));
check((await page.textContent('#s8cState')).includes('重新授權'), '只有唯讀權限的舊連結：提示重新按「連結 S8」授權一次');

check(pageErrors.length === 0, `頁面沒有 JS 錯誤${pageErrors.length ? '：' + pageErrors.join(' | ') : ''}`);
await browser.close();
console.log(failed ? `\n${failed} 項失敗` : '\n全部通過');
process.exit(failed ? 1 : 0);
