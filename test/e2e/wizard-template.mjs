// 驗證「推播精靈範本」（docs/line-push-wizard/wizard-template.html）：它是從 LINE原生推播流程抽出來、給別的專案用的獨立範本，
// 這份測試確保範本不會壞掉——步驟擋關、測試作廢、滑動測試、確認人數、重試金鑰（不重複發送）、鎖定、排程驗證、手機寬度。
// 範本是單一檔案、不連任何網路，所以直接用 file:// 開（順便證明它可以雙擊執行）。
// 執行：
//   NODE_PATH=$(npm root -g) node test/e2e/wizard-template.mjs
//   SHOTS=1 …    → 把截圖寫進 docs/line-push-wizard/shots/（更新文件用的圖；平常寫到暫存資料夾，不動 repo）
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILE = pathToFileURL(path.join(ROOT, 'docs', 'line-push-wizard', 'wizard-template.html')).href;
const SHOTS = process.env.SHOTS ? path.join(ROOT, 'docs', 'line-push-wizard', 'shots') : mkdtempSync(path.join(tmpdir(), 'wz-shots-'));
mkdirSync(SHOTS, { recursive: true });
let failed = 0;
const check = (cond, label) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) failed++; };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await browser.newContext({ viewport: { width: 1000, height: 1100 } });
await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
const page = await ctx.newPage();
const pageErrors = [], dialogs = [];
page.on('pageerror', e => pageErrors.push(e.message));
page.on('dialog', async d => { dialogs.push(d.message()); await d.accept(); });
await page.goto(FILE);
await page.evaluate(() => { try { localStorage.clear(); } catch (e) { /* ok */ } });
await page.reload();

const txt = sel => page.locator(sel).first().innerText();
const hasCls = async (sel, c) => page.evaluate(([s, k]) => document.querySelector(s).classList.contains(k), [sel, c]);
const vis = async sel => page.locator(sel).first().isVisible();
const tip = () => page.getAttribute('#wzNext', 'data-tip');
const sbDisabled = n => page.evaluate(k => document.querySelector(`#wzBar .wz-sb[data-n="${k}"]`).disabled, n);
async function slideTest() {
  await page.waitForFunction(() => { const sl = document.getElementById('wzSlider'); return !sl.classList.contains('back') && /^$|translateX\(0px\)/.test(document.getElementById('wzKnob').style.transform); });   // 等上一次的彈回動畫結束
  const kb = await page.locator('#wzKnob').boundingBox(), sb = await page.locator('#wzSlider').boundingBox();
  await page.mouse.move(kb.x + kb.width / 2, kb.y + kb.height / 2); await page.mouse.down();
  await page.mouse.move(kb.x + sb.width + 40, kb.y + kb.height / 2, { steps: 12 }); await page.mouse.up();
}
const waitTest = state => page.waitForFunction(s => S.test === s, state, { timeout: 8000 });

// ── 第 1 步：內容 ──
check(await hasCls('.wz-sb[data-n="1"]', 'on') && !(await hasCls('#wzNext', 'is-disabled')) && (await txt('#wzNext')) === '下一步', '一開始在第 1 步；範例內容完整，「下一步」可按');
check((await sbDisabled(3)) && (await sbDisabled(4)) && (await sbDisabled(5)) && !(await sbDisabled(2)), '步驟列：第 3、4、5 步還不能點；前一步完成，才能點下一步');
await page.fill('#wzAlt', '');
check((await hasCls('#wzNext', 'is-disabled')) && (await tip()).includes('第 1 步「推播內容」還沒完成：推播通知還沒填') && (await sbDisabled(2)), '內容不完整：「下一步」反灰，泡泡說明缺什麼，步驟列第 2 步也不能點');
await page.locator('#wzNext').click({ force: true }); check(await hasCls('#wzNext', 'tip'), '反灰時按一下，也會彈出說明泡泡');
await page.fill('#wzAlt', '今日重點新聞');
await page.click('#wzCards .wz-field:nth-child(1) input:nth-child(2)'); await page.fill('#wzCards .wz-field:nth-child(1) input:nth-child(2)', 'ftp://bad');
check((await tip()).includes('第 1 格的連結要是 http(s)://'), '連結不是 http(s)：擋下並指出是第幾格');
await page.fill('#wzCards .wz-field:nth-child(1) input:nth-child(2)', 'https://example.com/typhoon');
await page.screenshot({ path: path.join(SHOTS, '1-content.png') });

// ── 第 2 步：設定 ──
await page.click('#wzNext');
await page.waitForFunction(() => document.querySelectorAll('#wzOps .wz-pill').length === 3);
check(await hasCls('.wz-sb[data-n="2"]', 'on') && (await tip()).includes('還沒選擇操作人'), '第 2 步：沒選操作人，不能往下');
check(await page.evaluate(() => [...document.querySelectorAll('#wzAccts .wz-pill')].find(b => b.textContent.includes('正式帳號 B')).disabled), '內容種類不符的帳號（正式帳號 B）不能選');
await page.click('#wzOps .wz-pill:has-text("阿華")');
check((await tip()).includes('「正式帳號 A」的名單裡找不到操作人「阿華」') && (await hasCls('#wzOpNote', 'bad')), '操作人不在這個帳號的名單裡：擋下並說明（用名字對應各帳號名單）');
await page.click('#wzAccts .wz-pill:has-text("測試帳號")');
check(!(await hasCls('#wzNext', 'is-disabled')), '換成他在名單裡的帳號：可以往下');
// 排程驗證
await page.click('#wzSched');
check(await hasCls('#wzSched', 'active') && !(await hasCls('#wzNext', 'is-disabled')) && (await txt('#wzWhenMsg')).includes('由後端自動推播'), '排程：預設現在＋3 小時，可用');
const today = await page.evaluate(() => ymd(tzParts(Date.now())));
await page.fill('#wzDate', today); await page.fill('#wzTime', '00:00'); await page.dispatchEvent('#wzTime', 'change');
check((await hasCls('#wzNext', 'is-disabled')) && (await txt('#wzWhenMsg')).includes('排程時間要在 5 分鐘之後') && (await hasCls('#wzWhenMsg', 'bad')), '排程時間太近／已過：擋下');
const far = await page.evaluate(() => ymd(tzParts(Date.now() + 20 * 86400e3)));
await page.fill('#wzDate', far); await page.fill('#wzTime', '10:00'); await page.dispatchEvent('#wzTime', 'change');
check((await txt('#wzWhenMsg')).includes('最晚只能設在 14 天之內') && (await hasCls('#wzNext', 'is-disabled')), '排程超過 14 天：擋下');
await page.click('#wzNow');
check(await hasCls('#wzNow', 'active') && !(await hasCls('#wzNext', 'is-disabled')), '切回立即推播：可往下');
await page.waitForTimeout(500);   // 等分段控制的旋鈕滑完
await page.screenshot({ path: path.join(SHOTS, '2-setup.png') });

// ── 第 3 步：滑動測試 ──
await page.click('#wzNext');
check(await hasCls('.wz-sb[data-n="3"]', 'on') && (await tip()).includes('請先滑動發送測試推播') && (await sbDisabled(4)), '第 3 步：還沒測試就不能往下');
check((await txt('#wzTestWho')).includes('阿華') && (await txt('#wzTestStat')).includes('尚未測試'), '測試只傳給操作人本人');
// 半途放開會彈回、不發送
{ const kb = await page.locator('#wzKnob').boundingBox(); await page.mouse.move(kb.x + kb.width / 2, kb.y + kb.height / 2); await page.mouse.down(); await page.mouse.move(kb.x + 80, kb.y + kb.height / 2, { steps: 5 }); await page.mouse.up(); }
await page.waitForTimeout(400);
check(await page.evaluate(() => S.test === '' && !S.prep && Mock.seen.size === 0), '滑到一半放開：彈回去，什麼都沒送');
// 測試失敗
await page.check('#dfFailTest'); await slideTest(); await waitTest('bad');
check((await txt('#wzTestStat')).includes('推播失敗：平台回 400') && (await hasCls('#wzNext', 'is-disabled')) && await page.evaluate(() => S.retryKey.test === ''), '測試失敗：顯示原因，不能往下，重試金鑰清掉（下次換新的）');
await page.uncheck('#dfFailTest'); await slideTest(); await waitTest('ok');
check((await txt('#wzTestStat')).includes('已傳給操作人（阿華）') && !(await hasCls('#wzNext', 'is-disabled')) && await vis('#wzTestAgain') && (await hasCls('#wzSlider', 'done')), '測試成功：顯示傳給誰、滑桿變綠鎖住、可以往下');
check(await page.evaluate(() => S.prep && S.testToken.startsWith('tt.test.')), '測試成功會拿到「綁帳號」的測試憑證（正式推播要用）');
await page.screenshot({ path: path.join(SHOTS, '3-test.png') });
// 手機預覽：每一格、每顆快速回覆都是連結
check(await page.evaluate(() => document.querySelectorAll('#wzChat a.wz-cell').length === 3 && document.querySelectorAll('#wzChat a.wz-chip').length === 1 && document.querySelectorAll('#wzChat span.wz-chip').length === 1), '手機預覽：有連結的格子與快速回覆可點（連結留空的快速回覆只是文字）');
const popup = page.waitForEvent('popup'); await page.click('#wzChat a.wz-cell'); const pp = await popup; check(!!pp && await page.evaluate(() => S.step === 3), '點預覽的格子：另開分頁（不影響精靈）'); await pp.close().catch(() => {});

// ── 作廢規則 ──
await page.click('#wzPrev');
await page.click('#wzOps .wz-pill:has-text("小美")');
check(await page.evaluate(() => S.test === '' && S.testToken === ''), '換操作人：之前的測試作廢');
await page.click('#wzNext');
check(await hasCls('.wz-sb[data-n="3"]', 'on') && (await sbDisabled(4)) && (await txt('#wzTestStat')).includes('尚未測試'), '回到第 3 步要重測，第 4 步被鎖住');
await slideTest(); await waitTest('ok');
// 換內容 → 整個流程作廢
await page.click('#wzBar .wz-sb[data-n="1"]');
await page.fill('#wzAlt', '今日重點新聞（改）');
check((await txt('#wzWin')).includes('內容有更動，已作廢上傳的資料') && await page.evaluate(() => S.test === '' && !S.prep && S.step === 1), '內容有任何更動：已上傳的資料與測試全部作廢，並用訊息窗說明');
await page.fill('#wzAlt', '今日重點新聞');
await page.click('#wzNext'); await page.click('#wzNext'); await slideTest(); await waitTest('ok');

// ── 第 4 步：預覽、截圖、確認 ──
await page.click('#wzNext');
check(await hasCls('.wz-sb[data-n="4"]', 'on') && (await txt('#wzNext')) === '立即推播' && await hasCls('#wzNext', 'red') && await vis('#wzInfoBox') && await vis('#wzShotBtn'), '第 4 步：紅色「立即推播」、資訊框、截圖按鈕');
await page.click('#wzShotBtn');
await page.waitForFunction(() => /已複製|已下載/.test(document.getElementById('wzShotTxt').textContent), null, { timeout: 8000 });
const shotOk = await txt('#wzShotTxt');
check(shotOk.includes('已複製圖片'), `截圖：${shotOk}`);
const clipSize = await page.evaluate(async () => { const it = (await navigator.clipboard.read())[0]; const b = await it.getType('image/png'); return b.size; }).catch(() => 0);
check(clipSize > 5000, `剪貼簿裡真的有 PNG 圖片（${clipSize} bytes）`);
await page.screenshot({ path: path.join(SHOTS, '4-preview.png') });
await page.click('#wzNext');
await page.waitForFunction(() => document.getElementById('wzCfmTotal').placeholder.startsWith('輸入'));
check(await vis('#wzCfm') && (await page.getAttribute('#wzCfmTotal', 'placeholder')) === '輸入 18' && await page.evaluate(() => document.getElementById('wzCfmGo').disabled) && (await txt('#wzCfmWarn')).includes('測試帳號：只有已加入'), '確認推播視窗：向後端查好友數、紅色按鈕先反灰、註明「無法收回」與測試帳號說明');
await page.fill('#wzCfmTotal', '17');
check((await txt('#wzCfmMark')) === '✗' && await page.evaluate(() => document.getElementById('wzCfmGo').disabled), '輸入錯的人數：✗，不能按');
await page.fill('#wzCfmTotal', '18');
check((await txt('#wzCfmMark')) === '✓' && await page.evaluate(() => !document.getElementById('wzCfmGo').disabled), '輸入對的人數：✓，紅色「確認推播」亮起');
await page.screenshot({ path: path.join(SHOTS, '4b-confirm.png') });
await page.keyboard.press('Escape');
check(!(await vis('#wzCfm')) && await hasCls('.wz-sb[data-n="4"]', 'on'), 'Esc：只關確認視窗');
// 正式推播失敗 → 修好後重試成功
await page.check('#dfFailOfficial'); await page.click('#wzNext'); await page.waitForFunction(() => document.getElementById('wzCfmTotal').placeholder.startsWith('輸入')); await page.fill('#wzCfmTotal', '18'); await page.click('#wzCfmGo');
await page.waitForFunction(() => !document.getElementById('wzCfmErr').hidden);
check((await txt('#wzCfmErr')).includes('推播失敗：平台回 400') && await vis('#wzCfm') && await page.evaluate(() => S.step === 4 && S.go === 'bad'), '正式推播失敗：留在確認視窗顯示原因，不鎖定');
await page.evaluate(() => { Mock.flags.failOfficial = false; document.getElementById('dfFailOfficial').checked = false; });   // 確認視窗蓋住示範控制列，直接改旗標
await page.click('#wzCfmGo');
await page.waitForFunction(() => S.go === 'ok');
check(await page.evaluate(() => S.step === 5) && !(await vis('#wzCfm')) && (await txt('#wzStatList')).includes('已送出給平台') && (await txt('#wzStatList')).includes('推播人數 18 位'), '重試成功：進入第 5 步，顯示推播狀態');
// ── 第 5 步：鎖定 ──
check(await page.evaluate(() => [1, 2, 3, 4, 5].every(n => n === 5 || document.querySelector(`#wzBar .wz-sb[data-n="${n}"]`).disabled === true)) && !(await vis('#wzPrev')) && await vis('#wzList') && (await txt('#wzNext')) === '完成推播', '第 5 步：推播成功後鎖定，不能回上一步；有「推播列表」「完成推播」');
await page.evaluate(() => goTo(2)); check(await page.evaluate(() => S.step === 5), '就算用程式硬切也回不去（鎖定在流程層，不只是按鈕反灰）');
await page.screenshot({ path: path.join(SHOTS, '5-status.png') });
await page.click('#wzList'); check(dialogs.at(-1).includes('推播列表'), '「推播列表」交給外層處理（示範用 alert）');
await page.click('#wzNext');
check(await page.evaluate(() => S.step === 1 && S.go === '' && !S.prep), '「完成推播」：示範是重置，回第 1 步（真實專案換成關閉視窗）');

// ── 重試金鑰：送出後網路中斷，重按不會重複發送（用 A 帳號） ──
await page.click('#wzNext');
await page.waitForFunction(() => document.querySelectorAll('#wzOps .wz-pill').length === 3);
await page.click('#wzOps .wz-pill:has-text("小明")'); await page.click('#wzAccts .wz-pill:has-text("正式帳號 A")'); await page.click('#wzNext');
await slideTest(); await waitTest('ok'); await page.click('#wzNext');
await page.check('#dfNetLost'); await page.click('#wzNext');
await page.waitForFunction(() => document.getElementById('wzCfmTotal').placeholder === '輸入 287,091');
await page.fill('#wzCfmTotal', '287,091');
check((await txt('#wzCfmMark')) === '✓', '千分位逗號也算對（287,091）');
const h0 = await page.evaluate(() => Mock.history.length);
await page.click('#wzCfmGo'); await page.waitForFunction(() => !document.getElementById('wzCfmErr').hidden);
check((await txt('#wzCfmErr')).includes('若不確定有沒有發出去') && (await page.locator('.wz-bubble .st').last().innerText()).includes('請先到推播列表確認') && await page.evaluate(h => Mock.history.length === h, h0), '送出後網路中斷：說「不確定有沒有發出去」，泡泡提醒先到推播列表確認');
const keyBefore = await page.evaluate(() => S.retryKey.official);
await page.click('#wzCfmGo'); await page.waitForFunction(() => S.go === 'ok');
check(await page.evaluate(h => Mock.history.length === h + 1, h0) && keyBefore && await page.evaluate(() => S.result.already === true) && (await txt('#wzStatList')).includes('先前已受理，沒有重複發送'), '重按：用同一把重試金鑰，後端認得是同一筆——只發一次、畫面註明「沒有重複發送」');
await page.click('#wzNext');

// ── 排程流程＋名單變動 ──
await page.evaluate(() => { whenSet(whenDefault()); });   // 前面測排程驗證時把日期改到 20 天後，這裡還原
await page.click('#wzNext'); await page.waitForFunction(() => document.querySelectorAll('#wzOps .wz-pill').length === 3);
await page.click('#wzOps .wz-pill:has-text("小美")'); await page.click('#wzAccts .wz-pill:has-text("測試帳號")'); await page.click('#wzSched'); await page.click('#wzNext');
await slideTest(); await waitTest('ok'); await page.click('#wzNext');
check((await txt('#wzNext')) === '排程推播' && (await txt('#wzInfoKv')).includes('排程'), '排程流程：第 4 步按鈕變「排程推播」，資訊框寫排程時間');
await page.click('#dfDropOp');
await page.waitForFunction(() => S.step === 3 && S.test === '');
check(await page.evaluate(() => S.step === 3 && S.testToken === ''), '操作人被移出名單：測試作廢，從預覽退回第 3 步');
await page.evaluate(() => { S.op = ''; opSet('小明'); }); // 小明還在名單
await slideTest(); await waitTest('ok'); await page.click('#wzNext'); await page.click('#wzNext');
await page.waitForFunction(() => document.getElementById('wzCfmTotal').placeholder.startsWith('輸入'));
check((await txt('#wzCfmWarn')).includes('排程時間到就會自動推播'), '排程的確認視窗：註明「時間到就會自動推播」與如何取消');
await page.fill('#wzCfmTotal', '18'); await page.click('#wzCfmGo'); await page.waitForFunction(() => S.go === 'ok');
check((await txt('#wzStatList')).includes('已排程，') && await page.evaluate(() => S.result.kind === 'sched'), '排程成功：顯示排程時間與取消方式');

// ── 手機寬度、深色 ──
await page.setViewportSize({ width: 390, height: 900 });
await page.waitForTimeout(200);
check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), '手機寬度（390px）：沒有橫向捲動');
await page.emulateMedia({ colorScheme: 'dark' }); await page.setViewportSize({ width: 1000, height: 1100 });
await page.screenshot({ path: path.join(SHOTS, '6-dark.png') });
check(await page.evaluate(() => getComputedStyle(document.body).backgroundColor === 'rgb(15, 17, 21)'), '深色模式：套用深色 token');

check(pageErrors.length === 0, `沒有 JS 錯誤${pageErrors.length ? '：' + pageErrors.join(' / ') : ''}`);
await browser.close();
console.log(failed ? `\n${failed} 項失敗` : '\n全部通過');
process.exit(failed ? 1 : 0);
