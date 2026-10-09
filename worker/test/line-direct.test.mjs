// 執行：node --test worker/test/*.test.mjs
// 用假的 LINE API 與假的 R2 驗證 LINE 直連：憑證、準備（圖片進 R2）、檢查、發送的各道關卡，
// 以及「Worker 只會呼叫白名單內的 LINE 端點」（沒有 push／multicast／narrowcast）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import worker, { makeLabToken } from '../og-image-proxy.js';

const ORIGIN = 'http://localhost:8960';
const BASE_ENV = { LAB_PASSWORD: 'test-password', ALLOWED_ORIGINS: ORIGIN, LINE_CHANNEL_ID_TEST: '111', LINE_CHANNEL_SECRET_TEST: 'sec-test', LINE_CHANNEL_ID_NEWS: '222', LINE_CHANNEL_SECRET_NEWS: 'sec-news' };
const UUID = '123e4567-e89b-12d3-a456-426614174000';
const enc = new TextEncoder();

function fakeR2() {
  const store = new Map();
  const wrap = (k, o) => ({ key: k, body: o.bytes, httpMetadata: o.httpMetadata, customMetadata: o.customMetadata, async text() { return typeof o.bytes === 'string' ? o.bytes : new TextDecoder().decode(o.bytes); } });
  return {
    store,
    async put(k, bytes, opts) { store.set(k, { bytes, httpMetadata: opts && opts.httpMetadata, customMetadata: opts && opts.customMetadata }); },
    async get(k) { const o = store.get(k); return o ? wrap(k, o) : null; },
    async delete(k) { store.delete(k); },
    async list({ prefix = '' } = {}) { return { objects: [...store.entries()].filter(([k]) => k.startsWith(prefix)).map(([k, o]) => ({ key: k, customMetadata: o.customMetadata })), truncated: false }; },
  };
}
const PNG_B64 = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4));
const imagesB64 = () => ({ 1040: PNG_B64 });
const page = (h = 800) => ({ width: 1040, height: h, images: imagesB64(), buttons: [{ title: 't', url: 'https://example.com/a', x: '0%', y: '0%', width: '50%', height: '50%' }, { title: 't2', url: 'https://example.com/b', x: '50%', y: '50%', width: '50%', height: '50%' }] });
const prepBody = (extra = {}) => ({ org: 'news', name: 'x', altText: '測試推播', pages: [page(), page()], ...extra });

// 假 LINE：記錄每一次呼叫；followers / quota 可調
function installFakeLine({ clicks = 'ok', followers = 1000, quota = { type: 'limited', value: 100000 }, used = 10, validateStatus = 200, broadcastStatus = 200, tokenStatus = 200, profileStatus = 200 } = {}) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.origin !== 'https://api.line.me') throw new Error(`unexpected fetch ${url}`);
    const rec = { method: init.method || 'GET', path: u.pathname, search: u.search, headers: init.headers || {}, body: init.body };
    calls.push(rec);
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'x-line-request-id': 'req-1' } });
    const key = `${rec.method} ${rec.path}`;
    if (key === 'POST /oauth2/v3/token') return tokenStatus === 200 ? json({ access_token: 'tok-' + new URLSearchParams(rec.body).get('client_id'), expires_in: 900, token_type: 'Bearer' }) : json({ error: 'invalid_client', error_description: 'bad secret' }, tokenStatus);
    if (key === 'GET /v2/bot/info') return json({ displayName: '測試官方帳號', basicId: '@test' });
    if (key === 'GET /v2/bot/message/quota') return json(quota);
    if (key === 'GET /v2/bot/message/quota/consumption') return json({ totalUsage: used });
    if (key === 'GET /v2/bot/insight/followers') return followers === null ? json({ status: 'unready' }) : json({ status: 'ready', followers, targetedReaches: followers - 5, blocks: 5 });
    if (key === 'GET /v2/bot/insight/message/event') return clicks === 'none' ? json({ message: 'not ready' }, 404) : json({ overview: { requestId: u.searchParams.get('requestId'), delivered: 287091, uniqueImpression: 90000, uniqueClick: 41000 }, messages: [{ seq: 1, impression: 80000 }, { seq: 2, impression: 60000 }], clicks: [{ seq: 1, url: 'https://example.com/a', click: 1234, uniqueClick: 1000, uniqueClickOfRequest: 1000 }, { seq: 2, url: 'https://example.com/b', click: null, uniqueClick: null, uniqueClickOfRequest: null }] });
    if (key === 'POST /v2/bot/message/validate/broadcast') return validateStatus === 200 ? json({}) : json({ message: 'The request body has 1 error(s)', details: [{ message: 'must be valid', property: 'messages[0].baseUrl' }] }, validateStatus);
    if (key === 'POST /v2/bot/message/broadcast') return broadcastStatus === 200 || broadcastStatus === 409 ? json({}, broadcastStatus) : json({ message: 'You have reached your monthly limit.' }, broadcastStatus);
    if (key === 'POST /v2/bot/message/validate/multicast') return validateStatus === 200 ? json({}) : json({ message: 'The request body has 1 error(s)', details: [{ message: 'must be valid', property: 'messages[0].baseUrl' }] }, validateStatus);
    if (key === 'POST /v2/bot/message/multicast') return broadcastStatus === 200 || broadcastStatus === 409 ? json({}, broadcastStatus) : json({ message: 'You have reached your monthly limit.' }, broadcastStatus);
    if (key === 'POST /v2/bot/message/reply') return json({});
    if (/^GET \/v2\/bot\/profile\/U[0-9a-f]{32}$/.test(key)) return profileStatus === 200 ? json({ displayName: '王小明', userId: u.pathname.split('/').pop() }) : json({ message: 'Not found' }, profileStatus);
    throw new Error(`unexpected LINE call ${key}`);
  };
  return { calls, restore: () => { globalThis.fetch = realFetch; }, count: k => calls.filter(c => `${c.method} ${c.path}` === k).length };
}

async function req(env, path, body, { method = 'POST', auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json', Origin: ORIGIN };
  if (auth) headers.Authorization = `Bearer ${(await makeLabToken(env)).token}`;
  const res = await worker.fetch(new Request(`https://worker.test${path}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body) }), env);
  let json = null; try { json = await res.clone().json(); } catch { /* not json */ }
  return { status: res.status, json, res };
}
const TESTER_UID = 'U' + 'a'.repeat(32), TESTER_UID2 = 'U' + 'b'.repeat(32), TESTER_UID3 = 'U' + 'c'.repeat(32);
const tidOf = uid => createHash('sha256').update(uid).digest('hex').slice(0, 16);
const TID = tidOf(TESTER_UID), TID2 = tidOf(TESTER_UID2), TID3 = tidOf(TESTER_UID3);
function seedTester(env, uid = TESTER_UID, name = '王小明') { const tid = tidOf(uid); env.LINE_IMG.store.set(`testers/${tid}.json`, { bytes: JSON.stringify({ tid, userId: uid, name, registeredAt: Date.now() }), httpMetadata: {} }); return tid; }
async function prepared(env, extra) { const r = await req(env, '/line/prepare', prepBody(extra)); assert.equal(r.status, 200, JSON.stringify(r.json)); if (env.LINE_IMG) seedTester(env); return r.json; }
const sendBody = (prep, extra = {}) => ({ prepareToken: prep.prepareToken, channel: 'test', retryKey: UUID, testers: [TID], ...extra });
const FORBIDDEN_PATHS = /message\/push|narrowcast|richmenu|webhook|oauth2\/v2|revoke/i;

test('所有 /line 端點都要試驗功能憑證', async () => {
  const env = { ...BASE_ENV, LINE_IMG: fakeR2() };
  for (const p of ['/line/status', '/line/prepare', '/line/validate', '/line/send', '/line/clicks']) {
    const r = await req(env, p, {}, { auth: false });
    assert.equal(r.status, 401, p);
  }
});

test('沒設憑證 → 503，且不會呼叫 LINE', async () => {
  const line = installFakeLine();
  try {
    const r = await req({ LAB_PASSWORD: 'test-password', ALLOWED_ORIGINS: ORIGIN }, '/line/status', { channel: 'test' });
    assert.equal(r.status, 503);
    assert.match(r.json.error, /LINE_CHANNEL_ID_TEST/);
    assert.equal(line.calls.length, 0);
  } finally { line.restore(); }
});

test('status：換 stateless token 後只做唯讀查詢，回傳名稱、好友數、額度', async () => {
  const line = installFakeLine({ followers: 287091, quota: { type: 'limited', value: 100000000 }, used: 17266349 });
  try {
    const r = await req({ ...BASE_ENV, LINE_IMG: fakeR2() }, '/line/status', { channel: 'test' });
    assert.equal(r.status, 200);
    assert.equal(r.json.bot.displayName, '測試官方帳號');
    assert.equal(r.json.followers.followers, 287091);
    assert.deepEqual(r.json.quota, { type: 'limited', value: 100000000 });
    assert.equal(r.json.used, 17266349);
    assert.equal(r.json.r2Ready, true);
    const tok = line.calls.find(c => c.path === '/oauth2/v3/token');
    const form = new URLSearchParams(tok.body);
    assert.equal(form.get('grant_type'), 'client_credentials');
    assert.equal(form.get('client_id'), '111');
    assert.ok(line.calls.every(c => c.method === 'GET' || c.path === '/oauth2/v3/token'), '只有唯讀呼叫');
  } finally { line.restore(); }
});

test('status：好友數還沒統計好 → followers 為 null（不是假數字）', async () => {
  const line = installFakeLine({ followers: null });
  try {
    const r = await req(BASE_ENV, '/line/status', { channel: 'test' });
    assert.equal(r.status, 200);
    assert.equal(r.json.followers, null);
  } finally { line.restore(); }
});

test('Channel secret 錯誤 → 502 並說明，不洩漏 secret', async () => {
  const line = installFakeLine({ tokenStatus: 401 });
  try {
    const r = await req({ ...BASE_ENV, LINE_CHANNEL_ID_TEST: '901', LINE_CHANNEL_SECRET_TEST: 'sec-test' }, '/line/status', { channel: 'test' });
    assert.equal(r.status, 502);
    assert.ok(!JSON.stringify(r.json).includes('sec-test'));
  } finally { line.restore(); }
});

test('prepare：沒綁 R2 → 503', async () => {
  const r = await req(BASE_ENV, '/line/prepare', prepBody());
  assert.equal(r.status, 503);
  assert.match(r.json.error, /LINE_IMG/);
});

test('prepare：每頁只存 1040 這一張（2 頁共 2 張）進 R2，路徑不含副檔名，回傳 prepareToken', async () => {
  const r2 = fakeR2(); const env = { ...BASE_ENV, LINE_IMG: r2 };
  const j = await prepared(env);
  assert.equal(j.pages, 2);
  const imgKeys = [...r2.store.keys()].filter(k => k.startsWith('line/'));
  assert.equal(imgKeys.length, 2);
  for (const k of imgKeys) assert.match(k, /^line\/[0-9a-f]{32}\/1040$/);
  assert.equal(r2.store.get(imgKeys[0]).httpMetadata.contentType, 'image/png');
  assert.ok(j.prepareToken.length > 20);
});

test('prepare：不合格的輸入都回 400 且不存任何圖', async () => {
  const r2 = fakeR2(); const env = { ...BASE_ENV, LINE_IMG: r2 };
  const bad = [
    prepBody({ org: 'other' }), prepBody({ altText: '' }), prepBody({ pages: [] }),
    prepBody({ pages: [{ ...page(), height: 500 }] }),
    prepBody({ pages: [{ ...page(), images: { 700: PNG_B64 } }] }),   // 沒有 1040
    prepBody({ pages: [{ ...page(), images: { 1040: btoa('not an image') } }] }),
    prepBody({ pages: [{ ...page(), images: { 1040: '' } }] }),
    prepBody({ pages: [{ ...page(), buttons: [{ title: 't', url: 'javascript:alert(1)', x: '0%', y: '0%', width: '50%', height: '50%' }] }] }),
  ];
  for (const b of bad) { const r = await req(env, '/line/prepare', b); assert.equal(r.status, 400, JSON.stringify(b).slice(0, 80)); }
  assert.equal(r2.store.size, 0);
});

test('GET /line-img：五種寬度的網址都回同一張 1040；其他路徑與寬度 404，不用副檔名、不用憑證', async () => {
  const r2 = fakeR2(); const env = { ...BASE_ENV, LINE_IMG: r2 };
  await prepared(env);
  const [, pid] = [...r2.store.keys()][0].split('/');
  for (const w of [240, 300, 460, 700, 1040]) {
    const ok = await worker.fetch(new Request(`https://worker.test/line-img/${pid}/${w}`), env);
    assert.equal(ok.status, 200, String(w));
    assert.equal(ok.headers.get('content-type'), 'image/png');
    assert.equal(ok.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  }
  for (const p of [`/line-img/${pid}/700.png`, `/line-img/${pid}/123`, `/line-img/${'g'.repeat(32)}/700`, `/line-img/${'0'.repeat(32)}/700`]) {
    const r = await worker.fetch(new Request(`https://worker.test${p}`), env);
    assert.equal(r.status, 404, p);
  }
});

test('validate：組成 imagemap（baseUrl 指到 Worker、座標換算成 1040 基準），只呼叫 validate', async () => {
  const line = installFakeLine(); const env = { ...BASE_ENV, LINE_IMG: fakeR2() };
  try {
    const prep = await prepared(env);
    const r = await req(env, '/line/validate', { prepareToken: prep.prepareToken, channel: 'test' });
    assert.equal(r.status, 200); assert.equal(r.json.valid, true);
    const call = line.calls.find(c => c.path === '/v2/bot/message/validate/broadcast');
    const msgs = JSON.parse(call.body).messages;
    assert.equal(msgs.length, 2);
    assert.match(msgs[0].baseUrl, /^https:\/\/worker\.test\/line-img\/[0-9a-f]{32}$/);
    assert.deepEqual(msgs[0].baseSize, { width: 1040, height: 800 });
    assert.deepEqual(msgs[0].actions[1], { type: 'uri', linkUri: 'https://example.com/b', area: { x: 520, y: 400, width: 520, height: 400 } });
    assert.equal(msgs[0].altText, '測試推播');
    assert.equal(line.count('POST /v2/bot/message/broadcast'), 0, 'validate 不能真的發送');
  } finally { line.restore(); }
});

test('validate：LINE 說格式不對 → valid:false 並帶出原因', async () => {
  const line = installFakeLine({ validateStatus: 400 }); const env = { ...BASE_ENV, LINE_IMG: fakeR2() };
  try {
    const prep = await prepared(env);
    const r = await req(env, '/line/validate', { prepareToken: prep.prepareToken, channel: 'test' });
    assert.equal(r.status, 200); assert.equal(r.json.valid, false);
    assert.match(r.json.message, /baseUrl/);
  } finally { line.restore(); }
});

test('send（測試帳號）：先 validate、再 multicast 給指定的人（不 broadcast）；帶 retry key；回 testToken', async () => {
  const line = installFakeLine(); const env = { ...BASE_ENV, LINE_IMG: fakeR2() };
  try {
    const prep = await prepared(env);
    const r = await req(env, '/line/send', sendBody(prep));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.ok, true); assert.equal(r.json.official, false); assert.equal(r.json.friends, 1); assert.deepEqual(r.json.recipients, ['王小明']);
    assert.ok(r.json.testToken);
    const order = line.calls.map(c => `${c.method} ${c.path}`).filter(k => /validate|message\/(broadcast|multicast)/.test(k));
    assert.deepEqual(order, ['POST /v2/bot/message/validate/multicast', 'POST /v2/bot/message/multicast']);
    assert.equal(line.count('POST /v2/bot/message/broadcast'), 0, '測試帳號絕不 broadcast（不會發給所有好友）');
    const b = line.calls.find(c => c.path === '/v2/bot/message/multicast');
    assert.deepEqual(JSON.parse(b.body).to, [TESTER_UID]);
    assert.equal(JSON.parse(b.body).messages.length, 2);
    assert.equal(b.headers['X-Line-Retry-Key'], UUID);
    assert.equal(b.headers.Authorization, 'Bearer tok-111');
  } finally { line.restore(); }
});

test('send：格式沒過 → 400，且完全沒呼叫 broadcast', async () => {
  const line = installFakeLine({ validateStatus: 400 }); const env = { ...BASE_ENV, LINE_IMG: fakeR2() };
  try {
    const prep = await prepared(env);
    const r = await req(env, '/line/send', sendBody(prep));
    assert.equal(r.status, 400); assert.match(r.json.error, /沒有發送任何東西/);
    assert.equal(line.count('POST /v2/bot/message/multicast'), 0);
  } finally { line.restore(); }
});

test('send：缺／壞的 retryKey、壞的 prepareToken、壞的 channel 都不會發送', async () => {
  const line = installFakeLine(); const env = { ...BASE_ENV, LINE_IMG: fakeR2() };
  try {
    const prep = await prepared(env);
    for (const b of [sendBody(prep, { retryKey: undefined }), sendBody(prep, { retryKey: 'abc' }), sendBody(prep, { prepareToken: 'zzz' }), sendBody(prep, { channel: 'prod' }), sendBody(prep, { channel: undefined })]) {
      const r = await req(env, '/line/send', b);
      assert.equal(r.status, 400, JSON.stringify(b).slice(0, 60));
    }
    assert.equal(line.count('POST /v2/bot/message/multicast'), 0);
  } finally { line.restore(); }
});

test('send：額度不夠 → 409 不發送（以收件人數計，與好友數無關）', async () => {
  const line = installFakeLine({ followers: null, quota: { type: 'limited', value: 1000 }, used: 1000 }); const env = { ...BASE_ENV, LINE_IMG: fakeR2() };
  try {
    const prep = await prepared(env);
    const r = await req(env, '/line/send', sendBody(prep));
    assert.equal(r.status, 409); assert.match(r.json.error, /額度不夠/);
    assert.equal(line.count('POST /v2/bot/message/multicast'), 0);
  } finally { line.restore(); }
});

test('send：LINE 拒絕（例如超過每月額度）→ 502，並提醒到後台確認', async () => {
  const line = installFakeLine({ broadcastStatus: 429 }); const env = { ...BASE_ENV, LINE_IMG: fakeR2() };
  try {
    const prep = await prepared(env);
    const r = await req(env, '/line/send', sendBody(prep));
    assert.equal(r.status, 502); assert.match(r.json.error, /monthly limit/); assert.match(r.json.error, /後台確認/);
  } finally { line.restore(); }
});

test('send：同一個 retryKey 被 LINE 回 409 → 視為已受理，不重複發送', async () => {
  const line = installFakeLine({ broadcastStatus: 409 }); const env = { ...BASE_ENV, LINE_IMG: fakeR2() };
  try {
    const prep = await prepared(env);
    const r = await req(env, '/line/send', sendBody(prep));
    assert.equal(r.status, 200); assert.equal(r.json.alreadyAccepted, true);
    assert.equal(line.count('POST /v2/bot/message/multicast'), 1);
  } finally { line.restore(); }
});

test('正式帳號預設鎖住：沒設 LINE_ALLOW_OFFICIAL=1 → 403，什麼都不呼叫', async () => {
  const line = installFakeLine(); const env = { ...BASE_ENV, LINE_IMG: fakeR2() };
  try {
    const prep = await prepared(env);
    const r = await req(env, '/line/send', sendBody(prep, { channel: 'news', confirmTotal: 1000 }));
    assert.equal(r.status, 403); assert.match(r.json.error, /LINE_ALLOW_OFFICIAL/);
    assert.equal(line.calls.length, 0);
  } finally { line.restore(); }
});

test('正式帳號：要先成功發過測試帳號、輸入好友數、版型要對，缺一不可', async () => {
  const line = installFakeLine({ followers: 287091, quota: { type: 'limited', value: 100000000 }, used: 1 });
  const env = { ...BASE_ENV, LINE_IMG: fakeR2(), LINE_ALLOW_OFFICIAL: '1' };
  try {
    const prep = await prepared(env);
    // 1. 沒有 testToken
    let r = await req(env, '/line/send', sendBody(prep, { channel: 'news', confirmTotal: 287091 }));
    assert.equal(r.status, 400); assert.match(r.json.error, /先成功發到測試帳號/);
    // 先發測試帳號取得 testToken
    const t = await req(env, '/line/send', sendBody(prep, { retryKey: '123e4567-e89b-12d3-a456-426614174111' }));
    assert.equal(t.status, 200);
    // 2. testToken 屬於別份內容 → 拒絕
    const other = await prepared(env);
    r = await req(env, '/line/send', sendBody(other, { channel: 'news', confirmTotal: 287091, testToken: t.json.testToken }));
    assert.equal(r.status, 400);
    // 3. 版型不對（內容是 news，卻發 ent）
    r = await req(env, '/line/send', sendBody(prep, { channel: 'ent', confirmTotal: 287091, testToken: t.json.testToken }));
    assert.equal(r.status, 400, '版型不對'); assert.match(r.json.error, /另一個版型/);
    // 4. 好友數不符
    const before = line.count('POST /v2/bot/message/broadcast');
    r = await req(env, '/line/send', sendBody(prep, { channel: 'news', confirmTotal: 100, testToken: t.json.testToken }));
    assert.equal(r.status, 409); assert.match(r.json.error, /確認人數不符/);
    r = await req(env, '/line/send', sendBody(prep, { channel: 'news', testToken: t.json.testToken }));
    assert.equal(r.status, 409);
    assert.equal(line.count('POST /v2/bot/message/broadcast'), before, '前面任何一關失敗都不能發送');
    // 5. 全部符合 → 發送，並且用的是 news 的憑證
    r = await req(env, '/line/send', sendBody(prep, { channel: 'news', confirmTotal: 287100, testToken: t.json.testToken }));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.official, true); assert.equal(r.json.testToken, undefined);
    const last = line.calls.filter(c => c.path === '/v2/bot/message/broadcast').at(-1);
    assert.equal(last.headers.Authorization, 'Bearer tok-222');
  } finally { line.restore(); }
});

test('正式帳號：查不到好友數 → 不發送', async () => {
  const line = installFakeLine({ followers: null });
  const env = { ...BASE_ENV, LINE_IMG: fakeR2(), LINE_ALLOW_OFFICIAL: '1' };
  try {
    const prep = await prepared(env);
    const t = await req(env, '/line/send', sendBody(prep));
    assert.equal(t.status, 200);
    const r = await req(env, '/line/send', sendBody(prep, { channel: 'news', confirmTotal: 1000, testToken: t.json.testToken }));
    assert.equal(r.status, 409); assert.match(r.json.error, /好友數/);
    assert.equal(line.count('POST /v2/bot/message/broadcast'), 0, '測試帳號用 multicast；正式帳號好友數查不到，沒有 broadcast');
  } finally { line.restore(); }
});

test('整個過程只呼叫白名單內的 LINE 端點（沒有 push／narrowcast）', async () => {
  const line = installFakeLine(); const env = { ...BASE_ENV, LINE_IMG: fakeR2() };
  try {
    const prep = await prepared(env);
    await req(env, '/line/status', { channel: 'test' });
    await req(env, '/line/validate', { prepareToken: prep.prepareToken, channel: 'test' });
    await req(env, '/line/send', sendBody(prep));
    assert.ok(line.calls.length > 5);
    for (const c of line.calls) assert.ok(!FORBIDDEN_PATHS.test(c.path), c.path);
    const allowed = new Set(['POST /oauth2/v3/token', 'GET /v2/bot/info', 'GET /v2/bot/message/quota', 'GET /v2/bot/message/quota/consumption', 'GET /v2/bot/insight/followers', 'POST /v2/bot/message/validate/broadcast', 'POST /v2/bot/message/broadcast', 'POST /v2/bot/message/validate/multicast', 'POST /v2/bot/message/multicast']);
    for (const c of line.calls) assert.ok(allowed.has(`${c.method} ${c.path}`), `${c.method} ${c.path}`);
  } finally { line.restore(); }
});

test('token 會快取：連續呼叫不會每次重新發行', async () => {
  const line = installFakeLine(); const env = { ...BASE_ENV, LINE_CHANNEL_ID_TEST: '333', LINE_CHANNEL_SECRET_TEST: 'sec-x' };
  try {
    await req(env, '/line/status', { channel: 'test' });
    await req(env, '/line/status', { channel: 'test' });
    assert.equal(line.count('POST /oauth2/v3/token'), 1);
  } finally { line.restore(); }
});

test('clicks：用 requestId 查每個連結的點擊次數；null（不足 20）原樣保留', async () => {
  const line = installFakeLine();
  try {
    const rid = '123e4567-e89b-12d3-a456-426614174999';
    const r = await req(BASE_ENV, '/line/clicks', { channel: 'news', requestId: rid });
    assert.equal(r.status, 200);
    assert.equal(r.json.overview.requestId, rid);
    assert.equal(r.json.clicks[0].click, 1234);
    assert.equal(r.json.clicks[1].click, null);
    assert.equal(r.json.messages.length, 2);
    const c = line.calls.find(x => x.path === '/v2/bot/insight/message/event');
    assert.equal(c.method, 'GET');
    assert.equal(c.search, `?requestId=${rid}`);
    assert.equal(c.headers.Authorization, 'Bearer tok-222', '用該帳號自己的憑證查');
    assert.equal(line.count('POST /v2/bot/message/broadcast'), 0, '查詢不會發送任何東西');
  } finally { line.restore(); }
});

test('clicks：統計還沒好 → unavailable 並說明；requestId 格式不對 → 400 且不呼叫 LINE', async () => {
  const line = installFakeLine({ clicks: 'none' });
  try {
    const r = await req(BASE_ENV, '/line/clicks', { channel: 'test', requestId: '123e4567-e89b-12d3-a456-426614174999' });
    assert.equal(r.status, 200); assert.equal(r.json.unavailable, true); assert.match(r.json.message, /14 天/);
    const before = line.calls.length;
    for (const bad of ['abc', '', undefined, '123e4567-e89b-12d3-a456-426614174999&x=1', '../x']) {
      const b = await req(BASE_ENV, '/line/clicks', { channel: 'test', requestId: bad });
      assert.equal(b.status, 400, String(bad));
    }
    assert.equal(line.calls.length, before);
  } finally { line.restore(); }
});

// ===================== 排程推播（Worker 自己排）=====================
const taipei = ms => new Date(Math.floor(ms / 60000) * 60000 + 8 * 3600e3).toISOString().slice(0, 19).replace(/:\d{2}$/, ':00') + '+08:00';
const inMin = m => taipei(Date.now() + m * 60000);
const LINKS = [{ page: 1, label: '左上', title: '★標題一', url: 'https://example.com/a' }, { page: 1, label: '中上', title: '★標題二', url: 'https://example.com/b' }];
async function createSched(env, prep, extra = {}) { return req(env, '/line/schedule/create', { prepareToken: prep.prepareToken, channel: 'test', testers: [TID], runAt: inMin(60), links: LINKS, name: '261007早', ...extra }); }
// 把存在 R2 的排程改成「某個時間點到期」，模擬時間經過
async function setRunAt(r2, id, ms, extra = {}) {
  const k = `sched/${id}.json`, o = r2.store.get(k), rec = { ...JSON.parse(o.bytes), runAt: ms, ...extra };
  r2.store.set(k, { bytes: JSON.stringify(rec), httpMetadata: o.httpMetadata, customMetadata: { status: rec.status, runAt: String(rec.runAt) } });
}
const cron = async env => { let p; await worker.scheduled({}, env, { waitUntil: x => { p = x; } }); await p; };
const recOf = (r2, id) => JSON.parse(r2.store.get(`sched/${id}.json`).bytes);

test('排程：建立（測試帳號）→ 存進 R2，狀態待發送，帶出連結；還不會發送', async () => {
  const line = installFakeLine(); const r2 = fakeR2(); const env = { ...BASE_ENV, LINE_IMG: r2 };
  try {
    const prep = await prepared(env);
    const r = await createSched(env, prep);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const s = r.json.schedule;
    assert.equal(s.status, 'scheduled'); assert.equal(s.channel, 'test'); assert.equal(s.links.length, 2); assert.equal(s.altText, '測試推播');
    const stored = recOf(r2, s.id);
    assert.equal(stored.origin, 'https://worker.test'); assert.match(stored.retryKey, /^[0-9a-f-]{36}$/);
    assert.deepEqual(r2.store.get(`sched/${s.id}.json`).customMetadata, { status: 'scheduled', runAt: String(stored.runAt), channel: 'test' });
    assert.equal(line.count('POST /v2/bot/message/multicast') + line.count('POST /v2/bot/message/broadcast'), 0, '建立排程不會發送');
    assert.equal(line.count('POST /v2/bot/message/validate/multicast'), 1, '建立當下先請 LINE 檢查格式');
    assert.deepEqual(s.recipientNames, ['王小明']); assert.deepEqual(stored.testerTids, [TID]);
  } finally { line.restore(); }
});

test('排程：時間不合格（5 分鐘內、超過 14 天、格式錯、不存在的日期）→ 400 且不存', async () => {
  const line = installFakeLine(); const r2 = fakeR2(); const env = { ...BASE_ENV, LINE_IMG: r2 };
  try {
    const prep = await prepared(env);
    const before = r2.store.size;
    for (const runAt of [inMin(2), inMin(15 * 24 * 60), '2026-10-07 12:00', inMin(60).replace('+08:00', 'Z'), '2026-02-31T10:00:00+08:00', undefined, 12345]) {
      const r = await createSched(env, prep, { runAt });
      assert.equal(r.status, 400, String(runAt));
    }
    assert.equal(r2.store.size, before);
  } finally { line.restore(); }
});

test('排程：沒綁 R2 → 503；準備資料過期或亂寫 → 400', async () => {
  const line = installFakeLine();
  try {
    const r2 = fakeR2(); const env = { ...BASE_ENV, LINE_IMG: r2 };
    const prep = await prepared(env);
    assert.equal((await createSched(BASE_ENV, prep)).status, 503);
    assert.equal((await createSched(env, { prepareToken: 'zzz' })).status, 400);
  } finally { line.restore(); }
});

test('排程（正式帳號）：條件跟立即推播一樣——旗標、先測試過、版型、好友數，缺一不可', async () => {
  const line = installFakeLine({ followers: 287091, quota: { type: 'limited', value: 100000000 } }); const r2 = fakeR2();
  const env = { ...BASE_ENV, LINE_IMG: r2 };
  try {
    const prep = await prepared(env);
    let r = await createSched(env, prep, { channel: 'news', confirmTotal: 287091 });
    assert.equal(r.status, 403); assert.match(r.json.error, /LINE_ALLOW_OFFICIAL/);
    const env2 = { ...env, LINE_ALLOW_OFFICIAL: '1' };
    r = await createSched(env2, prep, { channel: 'news', confirmTotal: 287091 });
    assert.equal(r.status, 400); assert.match(r.json.error, /先成功發到測試帳號/);
    const t = await req(env2, '/line/send', sendBody(prep));
    r = await createSched(env2, prep, { channel: 'ent', confirmTotal: 287091, testToken: t.json.testToken });
    assert.equal(r.status, 400, '版型不對');
    r = await createSched(env2, prep, { channel: 'news', confirmTotal: 100, testToken: t.json.testToken });
    assert.equal(r.status, 409); assert.match(r.json.error, /確認人數不符/);
    assert.equal([...r2.store.keys()].filter(k => k.startsWith('sched/')).length, 0, '前面任何一關失敗都不能建立排程');
    r = await createSched(env2, prep, { channel: 'news', confirmTotal: 287100, testToken: t.json.testToken });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.schedule.approvedFriends, 287091);
  } finally { line.restore(); }
});

test('排程：list 回傳待發送在前、含心跳；update 只能改待發送的時間；cancel 之後不再發送', async () => {
  const line = installFakeLine(); const r2 = fakeR2(); const env = { ...BASE_ENV, LINE_IMG: r2 };
  try {
    const prep = await prepared(env);
    const a = (await createSched(env, prep, { runAt: inMin(120) })).json.schedule;
    const b = (await createSched(env, prep, { runAt: inMin(30) })).json.schedule;
    let l = await req(env, '/line/schedule/list', {});
    assert.equal(l.status, 200); assert.deepEqual(l.json.schedules.map(x => x.id), [b.id, a.id], '依時間由近到遠'); assert.equal(l.json.heartbeatAt, 0);
    // 變更時間
    let u = await req(env, '/line/schedule/update', { id: a.id, runAt: inMin(240) });
    assert.equal(u.status, 200); assert.equal(recOf(r2, a.id).runAt, Date.parse(u.json.schedule.runAtIso));
    assert.equal((await req(env, '/line/schedule/update', { id: a.id, runAt: inMin(1) })).status, 400, '不合格的新時間不會生效');
    assert.equal((await req(env, '/line/schedule/update', { id: 'x'.repeat(24), runAt: inMin(90) })).status, 400);
    assert.equal((await req(env, '/line/schedule/update', { id: '0'.repeat(24), runAt: inMin(90) })).status, 404);
    // 刪除（取消）
    const c = await req(env, '/line/schedule/cancel', { id: b.id });
    assert.equal(c.status, 200); assert.equal(c.json.schedule.status, 'cancelled');
    assert.equal((await req(env, '/line/schedule/cancel', { id: b.id })).status, 409, '已取消的不能再取消／變更');
    assert.equal((await req(env, '/line/schedule/update', { id: b.id, runAt: inMin(90) })).status, 409);
    // 快要發送（<1 分鐘）來不及動
    await setRunAt(r2, a.id, Date.now() + 30000);
    assert.equal((await req(env, '/line/schedule/cancel', { id: a.id })).status, 409);
    // 取消的在 Cron 時不會發
    await setRunAt(r2, b.id, Date.now() - 60000);
    await cron(env);
    assert.equal(recOf(r2, b.id).status, 'cancelled');
    assert.equal(line.count('POST /v2/bot/message/broadcast'), 0);
  } finally { line.restore(); }
});

test('Cron：到期的發出去一次（帶建立時的 retryKey 與 Worker 網址）、未到期不發、重複跑不會重複發、心跳被記錄', async () => {
  const line = installFakeLine(); const r2 = fakeR2(); const env = { ...BASE_ENV, LINE_IMG: r2 };
  try {
    const prep = await prepared(env);
    const due = (await createSched(env, prep, { runAt: inMin(60) })).json.schedule;
    const later = (await createSched(env, prep, { runAt: inMin(600) })).json.schedule;
    await setRunAt(r2, due.id, Date.now() - 20000);
    await cron(env);
    assert.equal(line.count('POST /v2/bot/message/multicast'), 1);
    assert.equal(line.count('POST /v2/bot/message/broadcast'), 0);
    const b = line.calls.find(c => c.path === '/v2/bot/message/multicast');
    assert.deepEqual(JSON.parse(b.body).to, [TESTER_UID]);
    assert.equal(b.headers['X-Line-Retry-Key'], recOf(r2, due.id).retryKey);
    assert.match(JSON.parse(b.body).messages[0].baseUrl, /^https:\/\/worker\.test\/line-img\//);
    const rec = recOf(r2, due.id);
    assert.equal(rec.status, 'sent'); assert.equal(rec.requestId, 'req-1'); assert.match(rec.sentAt, /\+08:00$/);
    assert.equal(recOf(r2, later.id).status, 'scheduled');
    assert.ok(JSON.parse(r2.store.get('meta/heartbeat.json').bytes).at > Date.now() - 5000);
    await cron(env); await cron(env);
    assert.equal(line.count('POST /v2/bot/message/multicast'), 1, '已發送的不會再發');
    const l = await req(env, '/line/schedule/list', {});
    assert.equal(l.json.schedules.find(x => x.id === due.id).requestId, 'req-1');
    assert.ok(l.json.heartbeatAt > 0);
  } finally { line.restore(); }
});

test('Cron：超過預定時間 30 分鐘還沒發 → 逾時放棄，不發送', async () => {
  const line = installFakeLine(); const r2 = fakeR2(); const env = { ...BASE_ENV, LINE_IMG: r2 };
  try {
    const prep = await prepared(env);
    const s = (await createSched(env, prep)).json.schedule;
    await setRunAt(r2, s.id, Date.now() - 31 * 60000);
    await cron(env);
    assert.equal(recOf(r2, s.id).status, 'missed'); assert.match(recOf(r2, s.id).lastError, /30 分鐘/);
    assert.equal(line.count('POST /v2/bot/message/multicast'), 0);
  } finally { line.restore(); }
});

test('Cron：LINE 暫時失敗（5xx）→ 下一分鐘用同一個 retryKey 再試；格式／額度問題 → 直接失敗不重試', async () => {
  const r2 = fakeR2(); const env = { ...BASE_ENV, LINE_IMG: r2 };
  let line = installFakeLine({ broadcastStatus: 503 });
  let s;
  try {
    const prep = await prepared(env);
    s = (await createSched(env, prep)).json.schedule;
    await setRunAt(r2, s.id, Date.now() - 30000);
    await cron(env);
    assert.equal(recOf(r2, s.id).status, 'scheduled'); assert.equal(recOf(r2, s.id).attempts, 1); assert.match(recOf(r2, s.id).lastError, /再試/);
    const firstKey = line.calls.find(c => c.path === '/v2/bot/message/multicast').headers['X-Line-Retry-Key'];
    line.restore(); line = installFakeLine();
    await cron(env);
    assert.equal(recOf(r2, s.id).status, 'sent'); assert.equal(recOf(r2, s.id).attempts, 2);
    assert.equal(line.calls.find(c => c.path === '/v2/bot/message/multicast').headers['X-Line-Retry-Key'], firstKey, '重試用同一個 retryKey，LINE 不會重複發');
    // 格式不合格 → failed
    line.restore(); line = installFakeLine({ validateStatus: 400 });
    const s2 = (await createSched(env, await prepared(env), { runAt: inMin(60) }));
    assert.equal(s2.status, 400, '建立當下格式就不過，根本不會排');
  } finally { line.restore(); }
  line = installFakeLine();
  try {
    const s3 = (await createSched(env, await prepared(env))).json.schedule;
    line.restore(); line = installFakeLine({ validateStatus: 400 });
    await setRunAt(r2, s3.id, Date.now() - 30000);
    await cron(env);
    assert.equal(recOf(r2, s3.id).status, 'failed'); assert.equal(line.count('POST /v2/bot/message/multicast'), 0);
    // 額度不夠 → failed
    line.restore(); line = installFakeLine({ followers: 5000, quota: { type: 'limited', value: 1000 }, used: 1000 });
    const s4 = (await createSched(env, await prepared(env))).json.schedule;
    await setRunAt(r2, s4.id, Date.now() - 30000);
    await cron(env);
    assert.equal(recOf(r2, s4.id).status, 'failed'); assert.match(recOf(r2, s4.id).lastError, /額度不夠/);
  } finally { line.restore(); }
});

test('Cron（正式帳號）：旗標被關掉、或發送當下好友數和確認時差太多 → 不發送', async () => {
  const r2 = fakeR2(); const envOn = { ...BASE_ENV, LINE_IMG: r2, LINE_ALLOW_OFFICIAL: '1' };
  let line = installFakeLine({ followers: 287091, quota: { type: 'limited', value: 100000000 } });
  try {
    const prep = await prepared(envOn);
    const t = await req(envOn, '/line/send', sendBody(prep));
    const mk = async () => (await createSched(envOn, prep, { channel: 'news', confirmTotal: 287091, testToken: t.json.testToken })).json.schedule;
    const s1 = await mk(), s2 = await mk(), s3 = await mk();
    // 1. 旗標關掉
    await setRunAt(r2, s1.id, Date.now() - 30000);
    await cron({ ...BASE_ENV, LINE_IMG: r2 });
    assert.equal(recOf(r2, s1.id).status, 'failed'); assert.match(recOf(r2, s1.id).lastError, /LINE_ALLOW_OFFICIAL/);
    // 2. 好友數暴增 20%
    line.restore(); line = installFakeLine({ followers: 345000, quota: { type: 'limited', value: 100000000 } });
    await setRunAt(r2, s2.id, Date.now() - 30000);
    const before = line.count('POST /v2/bot/message/broadcast');
    await cron(envOn);
    assert.equal(recOf(r2, s2.id).status, 'failed'); assert.match(recOf(r2, s2.id).lastError, /差太多/);
    assert.equal(line.count('POST /v2/bot/message/broadcast'), before);
    // 3. 一切正常 → 用 news 的憑證發出
    line.restore(); line = installFakeLine({ followers: 287500, quota: { type: 'limited', value: 100000000 } });
    await setRunAt(r2, s3.id, Date.now() - 30000);
    await cron(envOn);
    assert.equal(recOf(r2, s3.id).status, 'sent');
    assert.equal(line.calls.filter(c => c.path === '/v2/bot/message/broadcast').at(-1).headers.Authorization, 'Bearer tok-222');
  } finally { line.restore(); }
});

test('排程端點都要試驗功能憑證', async () => {
  const env = { ...BASE_ENV, LINE_IMG: fakeR2() };
  for (const p of ['/line/schedule/create', '/line/schedule/list', '/line/schedule/update', '/line/schedule/cancel']) assert.equal((await req(env, p, {}, { auth: false })).status, 401, p);
});


// ===================== 測試名單 + multicast（只限測試帳號）=====================
const signedHook = (events, secret = 'sec-test') => { const body = JSON.stringify({ destination: 'Uxxx', events }); return { body, sig: createHmac('sha256', secret).update(body).digest('base64') }; };
async function hook(env, events, { secret, sig, rawBody } = {}) {
  const h = signedHook(events, secret);
  const res = await worker.fetch(new Request('https://worker.test/line/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-line-signature': sig === undefined ? h.sig : sig }, body: rawBody !== undefined ? rawBody : h.body }), env);
  let json = null; try { json = await res.json(); } catch { /* */ }
  return { status: res.status, json };
}
const msgEv = (uid, text, token = 'rt-1') => ({ type: 'message', replyToken: token, source: { type: 'user', userId: uid }, message: { type: 'text', id: '1', text } });
const testersOf = async env => (await req(env, '/line/testers/list', {})).json;

test('webhook：簽章不對 → 401，什麼都不記、不呼叫 LINE；Verify（events 空陣列）→ 200', async () => {
  const line = installFakeLine(); const r2 = fakeR2(); const env = { ...BASE_ENV, LINE_IMG: r2 };
  try {
    assert.equal((await hook(env, [msgEv(TESTER_UID, '登記')], { sig: 'AAAA' })).status, 401);
    assert.equal((await hook(env, [msgEv(TESTER_UID, '登記')], { sig: undefined, secret: 'wrong-secret' })).status, 401);
    assert.equal((await hook(env, [msgEv(TESTER_UID, '登記')], { sig: '' })).status, 401);
    const bad = signedHook([msgEv(TESTER_UID, '登記')]);
    assert.equal((await hook(env, [], { sig: bad.sig })).status, 401, '簽章是別份內容的');
    assert.equal(r2.store.size, 0); assert.equal(line.calls.length, 0);
    assert.equal((await hook(env, [])).status, 200, 'Verify');
    const g = await worker.fetch(new Request('https://worker.test/line/webhook'), env);
    assert.equal(g.status, 405);
    assert.equal((await hook({ LAB_PASSWORD: 'x', ALLOWED_ORIGINS: ORIGIN, LINE_IMG: r2 }, [])).status, 503, '沒設測試帳號 secret');
  } finally { line.restore(); }
});

test('webhook：傳「登記」→ 記下 userId＋暱稱並回覆；重複登記只更新；網頁只看得到 tid 與暱稱', async () => {
  const line = installFakeLine(); const env = { ...BASE_ENV, LINE_IMG: fakeR2() };
  try {
    const r = await hook(env, [msgEv(TESTER_UID, ' 登記 ')]);
    assert.equal(r.status, 200);
    const rep = line.calls.find(c => c.path === '/v2/bot/message/reply');
    assert.equal(JSON.parse(rep.body).replyToken, 'rt-1'); assert.match(JSON.parse(rep.body).messages[0].text, /已加入測試名單：王小明/);
    assert.equal(rep.headers.Authorization, 'Bearer tok-111', '用測試帳號的 token');
    const l = await testersOf(env);
    assert.deepEqual(l.testers.map(t => [t.tid, t.name]), [[TID, '王小明']]); assert.equal(l.maxPerSend, 1);
    assert.equal(l.testers[0].userId, TESTER_UID, '權限管理要列出名字對應的 userId');
    await hook(env, [msgEv(TESTER_UID, '登記', 'rt-2')]);
    assert.equal((await testersOf(env)).testers.length, 1);
    assert.match(JSON.parse(line.calls.filter(c => c.path === '/v2/bot/message/reply').at(-1).body).messages[0].text, /已更新測試名單/);
    // 取不到暱稱 → 仍登記，名稱空白
    line.restore();
  } finally { line.restore(); }
  const line2 = installFakeLine({ profileStatus: 404 }); const env2 = { ...BASE_ENV, LINE_IMG: fakeR2() };
  try { await hook(env2, [msgEv(TESTER_UID2, '登記')]); assert.equal((await testersOf(env2)).testers[0].name, '（沒有暱稱）'); } finally { line2.restore(); }
});

test('webhook：其他訊息／加好友 → 只回提示、不登記；群組或非文字事件忽略；封鎖（unfollow）→ 從名單移除', async () => {
  const line = installFakeLine(); const env = { ...BASE_ENV, LINE_IMG: fakeR2() };
  try {
    await hook(env, [msgEv(TESTER_UID, '你好'), { type: 'follow', replyToken: 'rt-f', source: { type: 'user', userId: TESTER_UID2 } }, { type: 'message', replyToken: 'rt-g', source: { type: 'group', groupId: 'C1', userId: TESTER_UID3 }, message: { type: 'text', text: '登記' } }, { type: 'message', replyToken: 'rt-s', source: { type: 'user', userId: TESTER_UID3 }, message: { type: 'sticker' } }, msgEv('not-a-user-id', '登記')]);
    assert.equal((await testersOf(env)).testers.length, 0);
    const texts = line.calls.filter(c => c.path === '/v2/bot/message/reply').map(c => JSON.parse(c.body).messages[0].text);
    assert.equal(texts.length, 2); assert.ok(texts.every(t => /登記/.test(t)));
    await hook(env, [msgEv(TESTER_UID, '登記')]);
    assert.equal((await testersOf(env)).testers.length, 1);
    await hook(env, [{ type: 'unfollow', source: { type: 'user', userId: TESTER_UID } }]);
    assert.equal((await testersOf(env)).testers.length, 0, '封鎖後自動移除');
  } finally { line.restore(); }
});

test('webhook：名單上限 50 人，滿了回覆而不是記錄', async () => {
  const line = installFakeLine(); const env = { ...BASE_ENV, LINE_IMG: fakeR2() };
  try {
    for (let i = 0; i < 50; i++) seedTester(env, 'U' + String(i).padStart(32, '0'), 'p' + i);
    await hook(env, [msgEv(TESTER_UID, '登記')]);
    assert.equal((await testersOf(env)).testers.length, 50);
    assert.match(JSON.parse(line.calls.filter(c => c.path === '/v2/bot/message/reply').at(-1).body).messages[0].text, /已滿/);
  } finally { line.restore(); }
});

test('測試名單端點要試驗功能憑證；remove 只移除指定的人', async () => {
  const env = { ...BASE_ENV, LINE_IMG: fakeR2() };
  for (const p of ['/line/testers/list', '/line/testers/remove']) assert.equal((await req(env, p, {}, { auth: false })).status, 401, p);
  seedTester(env); seedTester(env, TESTER_UID2, '李小華');
  assert.equal((await testersOf(env)).testers.length, 2);
  const r = await req(env, '/line/testers/remove', { tid: TID });
  assert.deepEqual(r.json.testers.map(t => t.name), ['李小華']);
  assert.equal((await req(env, '/line/testers/remove', { tid: TID })).status, 404);
  assert.equal((await req(env, '/line/testers/remove', { tid: '../x' })).status, 404);
});

test('send（測試帳號）：沒選收件人、超過 1 位（只傳給操作者本人）、名單外的人 → 400，完全沒呼叫 LINE', async () => {
  const line = installFakeLine(); const env = { ...BASE_ENV, LINE_IMG: fakeR2() };
  try {
    const prep = await prepared(env); seedTester(env, TESTER_UID2, '李小華'); seedTester(env, TESTER_UID3, '陳小美');
    const before = line.calls.length;
    for (const testers of [undefined, [], 'abc', [TID, TID2], [TID, TID2, TID3], [TID, TID2, TID3, TID, TID2, TID3, TID, TID2, TID3, TID, TID2], ['0'.repeat(16)], [TESTER_UID], [{ tid: TID }]]) {
      const r = await req(env, '/line/send', sendBody(prep, { testers }));
      assert.equal(r.status, 400, JSON.stringify(testers));
    }
    assert.equal(line.calls.length, before, '任何一關沒過都沒有呼叫 LINE');
    // 1 位（含重複的同一位只算 1 位）→ 成功，且 to 只有他
    let r = await req(env, '/line/send', sendBody(prep, { testers: [TID2] }));
    assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.friends, 1); assert.deepEqual(r.json.recipients, ['李小華']);
    assert.deepEqual(JSON.parse(line.calls.filter(c => c.path === '/v2/bot/message/multicast').at(-1).body).to, [TESTER_UID2]);
    r = await req(env, '/line/send', sendBody(prep, { testers: [TID, TID, TID], retryKey: '123e4567-e89b-12d3-a456-426614174222' }));
    assert.equal(r.status, 200); assert.equal(r.json.friends, 1);
  } finally { line.restore(); }
});

test('send：名單有人被移除之後再送 → 400（不是默默少發）', async () => {
  const line = installFakeLine(); const env = { ...BASE_ENV, LINE_IMG: fakeR2() };
  try {
    const prep = await prepared(env);
    await req(env, '/line/testers/remove', { tid: TID });
    const r = await req(env, '/line/send', sendBody(prep));
    assert.equal(r.status, 400); assert.match(r.json.error, /不在測試名單/);
    assert.equal(line.count('POST /v2/bot/message/multicast'), 0);
  } finally { line.restore(); }
});

test('multicast／reply／profile 只用測試帳號的 token；正式帳號（news／ent）只會 broadcast', async () => {
  const line = installFakeLine({ followers: 287091, quota: { type: 'limited', value: 100000000 }, used: 1 });
  const env = { ...BASE_ENV, LINE_IMG: fakeR2(), LINE_ALLOW_OFFICIAL: '1' };
  try {
    const prep = await prepared(env);
    await hook(env, [msgEv(TESTER_UID, '登記')]);
    const t = await req(env, '/line/send', sendBody(prep));
    const o = await req(env, '/line/send', sendBody(prep, { channel: 'news', confirmTotal: 287091, testToken: t.json.testToken, retryKey: '123e4567-e89b-12d3-a456-426614174333' }));
    assert.equal(o.status, 200, JSON.stringify(o.json));
    for (const c of line.calls.filter(c => /multicast|reply|profile/.test(c.path))) assert.equal(c.headers.Authorization, 'Bearer tok-111', c.path);
    const official = line.calls.filter(c => c.headers.Authorization === 'Bearer tok-222');
    assert.ok(official.length > 0);
    for (const c of official) assert.ok(!/multicast|reply|profile/.test(c.path), `正式帳號不能呼叫 ${c.path}`);
    assert.equal(line.calls.filter(c => c.path === '/v2/bot/message/broadcast').every(c => c.headers.Authorization === 'Bearer tok-222'), true, '測試帳號從不 broadcast');
  } finally { line.restore(); }
});

test('測試排程：建立時必須指定收件人（最多 1 位）；時間到只 multicast 給他，名單被移除的就失敗不發', async () => {
  const line = installFakeLine(); const r2 = fakeR2(); const env = { ...BASE_ENV, LINE_IMG: r2 };
  try {
    const prep = await prepared(env); seedTester(env, TESTER_UID2, '李小華'); seedTester(env, TESTER_UID3, '陳小美');
    assert.equal((await createSched(env, prep, { testers: undefined })).status, 400);
    assert.equal((await createSched(env, prep, { testers: [TID, TID2] })).status, 400);
    assert.equal([...r2.store.keys()].filter(k => k.startsWith('sched/')).length, 0, '沒過的不會建立');
    const a = (await createSched(env, prep, { testers: [TID2] })).json.schedule;
    assert.deepEqual(a.recipientNames, ['李小華']);
    await setRunAt(r2, a.id, Date.now() - 20000); await cron(env);
    assert.equal(recOf(r2, a.id).status, 'sent');
    assert.deepEqual(JSON.parse(line.calls.find(c => c.path === '/v2/bot/message/multicast').body).to, [TESTER_UID2]);
    // 全被移除 → failed，沒有發送
    const b = (await createSched(env, prep, { testers: [TID3] })).json.schedule;
    await req(env, '/line/testers/remove', { tid: TID3 });
    const sentBefore = line.count('POST /v2/bot/message/multicast');
    await setRunAt(r2, b.id, Date.now() - 20000); await cron(env);
    assert.equal(recOf(r2, b.id).status, 'failed'); assert.match(recOf(r2, b.id).lastError, /不在測試名單/);
    assert.equal(line.count('POST /v2/bot/message/multicast'), sentBefore);
    assert.equal(line.count('POST /v2/bot/message/broadcast'), 0);
  } finally { line.restore(); }
});

// ===================== 正式帳號的測試名單與測試推播（只 multicast 給名單內的人）=====================
const OFFICIAL_UID = 'U8f0fba4524410d1cbc7c95ce37d96b80', OFFICIAL_UID2 = 'U' + 'd'.repeat(32), OFFICIAL_UID3 = 'U' + 'e'.repeat(32);
const OTID = tidOf(OFFICIAL_UID), OTID2 = tidOf(OFFICIAL_UID2), OTID3 = tidOf(OFFICIAL_UID3);
const tReq = (env, path, body) => req(env, path, body);

test('正式帳號測試名單：lookup 只向 LINE 查 profile 驗證、不存；add 驗證通過才存在該帳號自己的目錄', async () => {
  const line = installFakeLine(); const r2 = fakeR2(); const env = { ...BASE_ENV, LINE_IMG: r2 };
  try {
    seedTester(env);   // 測試帳號名單裡已有一位
    let r = await tReq(env, '/line/testers/lookup', { channel: 'news', userId: OFFICIAL_UID });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.found, { tid: OTID, name: '王小明', lineName: '王小明', already: false }); assert.deepEqual(r.json.testers, []);
    assert.equal([...r2.store.keys()].filter(k => k.startsWith('testers/news/')).length, 0, 'lookup 不存');
    const prof = line.calls.find(c => c.path.startsWith('/v2/bot/profile/'));
    assert.equal(prof.path, `/v2/bot/profile/${OFFICIAL_UID}`); assert.equal(prof.headers.Authorization, 'Bearer tok-222', '用新聞帳號的 token 查');
    r = await tReq(env, '/line/testers/add', { channel: 'news', userId: OFFICIAL_UID });
    assert.equal(r.status, 200); assert.deepEqual(r.json.testers.map(t => [t.tid, t.name]), [[OTID, '王小明']]);
    assert.ok(r2.store.has(`testers/news/${OTID}.json`)); assert.equal(r.json.testers[0].userId, OFFICIAL_UID);
    // 各帳號的名單互相獨立
    assert.deepEqual((await tReq(env, '/line/testers/list', { channel: 'ent' })).json.testers, []);
    assert.deepEqual((await tReq(env, '/line/testers/list', {})).json.testers.map(t => t.tid), [TID], '測試帳號名單不受影響，也不會混進 news 子目錄');
    assert.deepEqual((await tReq(env, '/line/testers/list', { channel: 'news' })).json.testers.map(t => t.tid), [OTID]);
    // 重複加入 → already
    assert.equal((await tReq(env, '/line/testers/add', { channel: 'news', userId: OFFICIAL_UID })).json.found.already, true);
    // 移除
    assert.equal((await tReq(env, '/line/testers/remove', { channel: 'news', tid: OTID })).json.testers.length, 0);
    assert.ok(r2.store.has(`testers/${TID}.json`), '移除新聞名單不影響測試帳號名單');
  } finally { line.restore(); }
});

test('正式帳號測試名單：壞格式、LINE 查不到（不是好友／別的 Provider）、沒設憑證、名單滿了 → 都不會加入', async () => {
  const r2 = fakeR2(); const env = { ...BASE_ENV, LINE_IMG: r2 };
  let line = installFakeLine();
  try {
    for (const userId of ['', 'abc', 'U' + 'a'.repeat(31), 'u' + 'a'.repeat(32), 'U' + 'A'.repeat(32), OFFICIAL_UID + 'x', '../x', undefined]) assert.equal((await tReq(env, '/line/testers/add', { channel: 'news', userId })).status, 400, String(userId));
    assert.equal((await tReq(env, '/line/testers/add', { channel: 'prod', userId: OFFICIAL_UID })).status, 400);
    assert.equal(line.calls.filter(c => c.path.startsWith('/v2/bot/profile')).length, 0, '格式不對根本不會問 LINE');
    assert.equal((await tReq({ ...env, LINE_CHANNEL_ID_ENT: undefined }, '/line/testers/add', { channel: 'ent', userId: OFFICIAL_UID })).status, 503, '娛樂帳號沒設憑證');
    for (const p of ['/line/testers/lookup', '/line/testers/add']) assert.equal((await req(env, p, { channel: 'news', userId: OFFICIAL_UID }, { auth: false })).status, 401, p);
  } finally { line.restore(); }
  line = installFakeLine({ profileStatus: 404 });
  try {
    const r = await tReq(env, '/line/testers/add', { channel: 'news', userId: OFFICIAL_UID });
    assert.equal(r.status, 404); assert.match(r.json.error, /Provider/); assert.match(r.json.error, /沒有加入名單/);
    assert.equal([...r2.store.keys()].filter(k => k.startsWith('testers/news/')).length, 0);
  } finally { line.restore(); }
  line = installFakeLine();
  try {
    for (let i = 0; i < 20; i++) r2.store.set(`testers/news/${tidOf('U' + String(i).padStart(32, '0'))}.json`, { bytes: JSON.stringify({ tid: tidOf('U' + String(i).padStart(32, '0')), userId: 'U' + String(i).padStart(32, '0'), name: 'p' + i }), httpMetadata: {} });
    const r = await tReq(env, '/line/testers/add', { channel: 'news', userId: OFFICIAL_UID });
    assert.equal(r.status, 409); assert.match(r.json.error, /已滿/);
  } finally { line.restore(); }
});

test('正式帳號的測試推播：mode:test 只 multicast 給該帳號名單裡勾選的人；不需要 LINE_ALLOW_OFFICIAL；不 broadcast；回 testToken', async () => {
  const line = installFakeLine({ followers: 287091, quota: { type: 'limited', value: 100000000 }, used: 17266349 }); const env = { ...BASE_ENV, LINE_IMG: fakeR2() };
  try {
    const prep = await prepared(env);
    await tReq(env, '/line/testers/add', { channel: 'news', userId: OFFICIAL_UID });
    const r = await req(env, '/line/send', sendBody(prep, { channel: 'news', mode: 'test', testers: [OTID] }));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.official, false); assert.equal(r.json.testOnly, true); assert.equal(r.json.channel, 'news'); assert.equal(r.json.friends, 1); assert.deepEqual(r.json.recipients, ['王小明']);
    assert.ok(r.json.testToken);
    assert.equal(line.count('POST /v2/bot/message/broadcast'), 0, '只有 multicast，沒有 broadcast');
    const m = line.calls.find(c => c.path === '/v2/bot/message/multicast');
    assert.deepEqual(JSON.parse(m.body).to, [OFFICIAL_UID]); assert.equal(m.headers.Authorization, 'Bearer tok-222', '用新聞帳號發');
    assert.equal(line.calls.filter(c => c.path === '/v2/bot/message/validate/multicast').length, 1);
    assert.equal(line.count('POST /v2/bot/message/reply'), 0);
  } finally { line.restore(); }
});

test('正式帳號的測試推播：收件人必須在「該帳號」的名單內（最多 1 位）；版型要對；別的帳號的人不能混用', async () => {
  const line = installFakeLine(); const env = { ...BASE_ENV, LINE_IMG: fakeR2() };
  try {
    const prep = await prepared(env);   // 內容是 news 版型；seedTester 只在測試帳號名單
    await tReq(env, '/line/testers/add', { channel: 'news', userId: OFFICIAL_UID });
    await tReq(env, '/line/testers/add', { channel: 'news', userId: OFFICIAL_UID2 });
    await tReq(env, '/line/testers/add', { channel: 'news', userId: OFFICIAL_UID3 });
    const before = line.calls.length;
    for (const [extra, why] of [[{ testers: [TID] }, '測試帳號名單裡的人不能發到新聞帳號'], [{ testers: [OTID, OTID2] }, '超過 1 位'], [{ testers: [OTID, OTID2, OTID3] }, '超過 1 位'], [{ testers: [] }, '沒選人'], [{ testers: undefined }, '沒帶'], [{ testers: [OFFICIAL_UID] }, '直接給 userId'], [{ channel: 'ent', testers: [OTID] }, '版型不對（news 內容發 ent）']]) {
      const r = await req(env, '/line/send', sendBody(prep, { channel: 'news', mode: 'test', ...extra }));
      assert.equal(r.status, 400, why);
    }
    assert.equal(line.calls.length, before, '前面任何一關沒過都沒有呼叫 LINE');
    const ok = await req(env, '/line/send', sendBody(prep, { channel: 'news', mode: 'test', testers: [OTID2] }));
    assert.equal(ok.status, 200); assert.equal(ok.json.friends, 1);
    assert.deepEqual(JSON.parse(line.calls.filter(c => c.path === '/v2/bot/message/multicast').at(-1).body).to, [OFFICIAL_UID2]);
  } finally { line.restore(); }
});

test('正式帳號的 broadcast 閘門完全沒變：沒帶 mode:test 就走原本流程（旗標、testToken、人數）；mode:test 的 testToken 可通過同一份內容的閘門', async () => {
  const line = installFakeLine({ followers: 287091, quota: { type: 'limited', value: 100000000 }, used: 1 }); const env = { ...BASE_ENV, LINE_IMG: fakeR2() };
  try {
    const prep = await prepared(env);
    await tReq(env, '/line/testers/add', { channel: 'news', userId: OFFICIAL_UID });
    // 沒旗標 → 403，multicast 不能繞過 broadcast
    let r = await req(env, '/line/send', sendBody(prep, { channel: 'news', confirmTotal: 287091 }));
    assert.equal(r.status, 403); assert.match(r.json.error, /LINE_ALLOW_OFFICIAL/);
    r = await req(env, '/line/send', sendBody(prep, { channel: 'news', mode: 'nope', confirmTotal: 287091, testers: [OTID] }));
    assert.equal(r.status, 403, 'mode 不是 test 就是一般的正式發送，一樣被鎖');
    const t = await req(env, '/line/send', sendBody(prep, { channel: 'news', mode: 'test', testers: [OTID] }));
    assert.equal(t.status, 200);
    assert.equal(line.count('POST /v2/bot/message/broadcast'), 0);
    const env2 = { ...env, LINE_ALLOW_OFFICIAL: '1' };
    r = await req(env2, '/line/send', sendBody(prep, { channel: 'news', confirmTotal: 100, testToken: t.json.testToken, retryKey: '123e4567-e89b-12d3-a456-426614174444' }));
    assert.equal(r.status, 409, '人數不符照樣擋'); 
    r = await req(env2, '/line/send', sendBody(prep, { channel: 'news', confirmTotal: 287091, testToken: t.json.testToken, retryKey: '123e4567-e89b-12d3-a456-426614174444' }));
    assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.official, true);
    assert.equal(line.count('POST /v2/bot/message/broadcast'), 1);
    assert.equal(JSON.parse(line.calls.find(c => c.path === '/v2/bot/message/broadcast').body).messages.length, 2);
  } finally { line.restore(); }
});

test('reply 仍只有測試帳號能用；正式帳號的 multicast 每次最多 1 個合法 userId', async () => {
  const line = installFakeLine(); const env = { ...BASE_ENV, LINE_IMG: fakeR2() };
  try {
    const prep = await prepared(env);
    await tReq(env, '/line/testers/add', { channel: 'news', userId: OFFICIAL_UID });
    await req(env, '/line/send', sendBody(prep, { channel: 'news', mode: 'test', testers: [OTID] }));
    await hook(env, [msgEv(TESTER_UID, '登記')]);
    for (const c of line.calls.filter(c => c.path === '/v2/bot/message/reply')) assert.equal(c.headers.Authorization, 'Bearer tok-111', 'reply 只用測試帳號');
    for (const c of line.calls.filter(c => c.path === '/v2/bot/message/multicast' && c.headers.Authorization === 'Bearer tok-222')) { const to = JSON.parse(c.body).to; assert.ok(to.length === 1 && to.every(u => /^U[0-9a-f]{32}$/.test(u))); }
    assert.equal(line.calls.filter(c => c.path === '/v2/bot/message/broadcast' && c.headers.Authorization === 'Bearer tok-111').length, 0, '測試帳號從不 broadcast');
  } finally { line.restore(); }
});

// ===== 訊息推播 → 推播列表（發送紀錄／統計／改名）=====
const histKeys = r2 => [...r2.store.keys()].filter(k => k.startsWith('hist/'));
const histRec = (r2, k) => JSON.parse(r2.store.get(k).bytes);
const listOf = async (env, channel) => (await req(env, '/line/history/list', { channel })).json;
const UUID2 = '223e4567-e89b-12d3-a456-426614174111';

test('推播列表：立即推播成功就留一筆紀錄（預設命名「日期＋新聞」），同一次重試不會多一筆，失敗不留', async () => {
  const line = installFakeLine(); const r2 = fakeR2(); const env = { ...BASE_ENV, LINE_IMG: r2 };
  try {
    const prep = await prepared(env);
    const r = await req(env, '/line/send', sendBody(prep, { links: LINKS }));
    assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.historySaved, true);
    assert.equal(histKeys(r2).length, 1);
    const rec = histRec(r2, histKeys(r2)[0]);
    assert.equal(rec.id, UUID.replace(/-/g, '').slice(0, 24)); assert.equal(rec.kind, 'now'); assert.equal(rec.channel, 'test'); assert.equal(rec.status, 'sent'); assert.equal(rec.test, true);
    assert.match(rec.name, /^\d{2}\/\d{2}新聞$/); assert.equal(rec.altText, '測試推播'); assert.equal(rec.requestId, 'req-1'); assert.equal(rec.links.length, 2); assert.deepEqual(rec.recipientNames, ['王小明']);
    assert.deepEqual(r2.store.get(histKeys(r2)[0]).customMetadata, { status: 'sent', runAt: String(rec.runAt), channel: 'test' });
    // 同一個 retryKey 再送一次（LINE 回 409 代表已受理）→ 不新增、不覆蓋
    await req(env, '/line/history/rename', { id: rec.id, name: '我改的名字' });
    const again = await req(env, '/line/send', sendBody(prep, { links: LINKS }));
    assert.equal(again.status, 200);
    assert.equal(histKeys(r2).length, 1); assert.equal(histRec(r2, histKeys(r2)[0]).name, '我改的名字');
    // 自訂名稱、娛樂版型
    const prepEnt = await prepared(env, { org: 'ent' });
    await req(env, '/line/send', sendBody(prepEnt, { retryKey: UUID2, name: '  晚間重點  ' }));
    const ent = histKeys(r2).map(k => histRec(r2, k)).find(x => x.org === 'ent');
    assert.equal(ent.name, '晚間重點');
  } finally { line.restore(); }
  const bad = installFakeLine({ broadcastStatus: 500 }); const r2b = fakeR2(); const envb = { ...BASE_ENV, LINE_IMG: r2b };
  try {
    const prep = await prepared(envb);
    const r = await req(envb, '/line/send', sendBody(prep));
    assert.notEqual(r.status, 200); assert.equal(histKeys(r2b).length, 0, '沒發出去就不留紀錄');
  } finally { bad.restore(); }
});

test('推播列表：依帳號切換、立即推播＋排程合併、新到舊；需要憑證；channel 要合法', async () => {
  const line = installFakeLine(); const r2 = fakeR2(); const env = { ...BASE_ENV, LINE_IMG: r2 };
  try {
    const prep = await prepared(env);
    await req(env, '/line/send', sendBody(prep, { links: LINKS }));                       // 測試帳號・立即
    await createSched(env, prep, { runAt: inMin(60), name: '排程一' });                    // 測試帳號・排程
    await tReq(env, '/line/testers/add', { channel: 'news', userId: OFFICIAL_UID });
    await req(env, '/line/send', sendBody(prep, { channel: 'news', mode: 'test', testers: [OTID], retryKey: UUID2 }));   // 新聞帳號・測試推播
    const t = await listOf(env, 'test'), n = await listOf(env, 'news'), e = await listOf(env, 'ent');
    assert.equal(t.records.length, 2); assert.deepEqual(t.records.map(x => x.kind), ['sched', 'now'], '排程時間在後面，排前面');
    assert.equal(t.records[0].name, '排程一'); assert.equal(t.records[0].status, 'scheduled');
    assert.equal(n.records.length, 1); assert.equal(n.records[0].channel, 'news'); assert.equal(n.records[0].test, true); assert.equal(e.records.length, 0);
    assert.ok(Number.isFinite(t.serverNow)); assert.ok(t.records.every(x => !('pages' in x) && !('quick' in x)), '不把圖片資料給網頁');
    assert.equal((await req(env, '/line/history/list', { channel: 'test' }, { auth: false })).status, 401);
    assert.equal((await req(env, '/line/history/list', { channel: 'prod' })).status, 400);
    // 舊排程（metadata 沒有 channel）也能用 body 判斷歸屬
    const old = [...r2.store.keys()].find(k => k.startsWith('sched/')); const m = r2.store.get(old).customMetadata; delete m.channel;
    assert.equal((await listOf(env, 'test')).records.length, 2); assert.equal((await listOf(env, 'news')).records.length, 1);
  } finally { line.restore(); }
});

test('推播列表：點擊統計——查到就存成快照、5 分鐘內不重查、force 才重查、超過 14 天用快照、LINE 沒資料回快照', async () => {
  const line = installFakeLine(); const r2 = fakeR2(); const env = { ...BASE_ENV, LINE_IMG: r2 };
  try {
    const prep = await prepared(env);
    await tReq(env, '/line/testers/add', { channel: 'news', userId: OFFICIAL_UID });
    await req(env, '/line/send', sendBody(prep, { channel: 'news', mode: 'test', testers: [OTID], links: LINKS }));
    const id = (await listOf(env, 'news')).records[0].id;
    const calls = () => line.count('GET /v2/bot/insight/message/event');
    let r = await req(env, '/line/history/stats', { id });
    assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.fresh, true); assert.equal(calls(), 1);
    assert.equal(r.json.stats.overview.delivered, 287091); assert.equal(r.json.stats.clicks[0].click, 1234); assert.equal(r.json.record.delivered, 287091);
    const q = line.calls.find(c => c.path === '/v2/bot/insight/message/event'); assert.equal(q.search, '?requestId=req-1'); assert.equal(q.headers.Authorization, 'Bearer tok-222', '用該筆自己的帳號查');
    r = await req(env, '/line/history/stats', { id }); assert.equal(r.json.cached, true); assert.equal(calls(), 1, '5 分鐘內不重查');
    r = await req(env, '/line/history/stats', { id, force: true }); assert.equal(r.json.fresh, true); assert.equal(calls(), 2);
    assert.equal((await listOf(env, 'news')).records[0].delivered, 287091, '列表顯示發送成功人數');
    // LINE 暫時沒資料 → 回最後的快照＋說明
    line.restore(); const none = installFakeLine({ clicks: 'none' });
    try {
      r = await req(env, '/line/history/stats', { id, force: true });
      assert.equal(r.status, 200); assert.equal(r.json.unavailable, true); assert.match(r.json.message, /快照/); assert.equal(r.json.stats.overview.delivered, 287091);
    } finally { none.restore(); }
    // 超過 14 天：不問 LINE，只給快照
    const key = histKeys(r2)[0]; const rec = histRec(r2, key); rec.sentAt = '2020-01-01T10:00:00+08:00'; r2.store.set(key, { ...r2.store.get(key), bytes: JSON.stringify(rec) });
    const again = installFakeLine();
    try {
      r = await req(env, '/line/history/stats', { id, force: true });
      assert.equal(again.count('GET /v2/bot/insight/message/event'), 0); assert.equal(r.json.unavailable, true); assert.match(r.json.message, /14 天/); assert.ok(r.json.stats);
    } finally { again.restore(); }
    assert.equal((await req(env, '/line/history/stats', { id: 'f'.repeat(24) })).status, 404);
    assert.equal((await req(env, '/line/history/stats', { id: 'zz' })).status, 400);
    assert.equal((await req(env, '/line/history/stats', { id }, { auth: false })).status, 401);
  } finally { line.restore(); }
});

test('推播列表：排程還沒發送時沒有統計；改名有限制', async () => {
  const line = installFakeLine(); const r2 = fakeR2(); const env = { ...BASE_ENV, LINE_IMG: r2 };
  try {
    const prep = await prepared(env);
    const s = (await createSched(env, prep)).json.schedule;
    let r = await req(env, '/line/history/stats', { id: s.id });
    assert.equal(r.json.unavailable, true); assert.equal(line.count('GET /v2/bot/insight/message/event'), 0);
    r = await req(env, '/line/history/rename', { id: s.id, name: ' 早場排程 ' });
    assert.equal(r.status, 200); assert.equal(r.json.record.name, '早場排程'); assert.equal(recOf(r2, s.id).name, '早場排程'); assert.equal(recOf(r2, s.id).status, 'scheduled', '改名不動狀態');
    for (const name of ['', '   ', undefined, 5]) assert.equal((await req(env, '/line/history/rename', { id: s.id, name })).status, 400, String(name));
    const rec = recOf(r2, s.id); rec.status = 'sending'; r2.store.set(`sched/${s.id}.json`, { ...r2.store.get(`sched/${s.id}.json`), bytes: JSON.stringify(rec) });
    assert.equal((await req(env, '/line/history/rename', { id: s.id, name: 'x' })).status, 409);
    assert.equal((await req(env, '/line/history/rename', { id: 'a'.repeat(24), name: 'x' })).status, 404);
    assert.equal((await req(env, '/line/history/rename', { id: s.id, name: 'x' }, { auth: false })).status, 401);
  } finally { line.restore(); }
});

test('權限管理：名字可以自己填（空白就用 LINE 暱稱），測試帳號也能直接貼 userId 加入', async () => {
  const line = installFakeLine(); const r2 = fakeR2(); const env = { ...BASE_ENV, LINE_IMG: r2 };
  try {
    let r = await tReq(env, '/line/testers/lookup', { channel: 'test', userId: OFFICIAL_UID2, name: '小編A' });
    assert.equal(r.status, 200, JSON.stringify(r.json)); assert.deepEqual(r.json.found, { tid: OTID2, name: '小編A', lineName: '王小明', already: false });
    assert.equal(r2.store.has(`testers/${OTID2}.json`), false, 'lookup 不存');
    r = await tReq(env, '/line/testers/add', { channel: 'test', userId: OFFICIAL_UID2, name: '小編A' });
    assert.deepEqual(r.json.testers.map(t => [t.name, t.userId]), [['小編A', OFFICIAL_UID2]]);
    assert.equal(line.calls.find(c => c.path.startsWith('/v2/bot/profile/')).headers.Authorization, 'Bearer tok-111', '測試帳號用測試帳號的 token 驗證');
    r = await tReq(env, '/line/testers/add', { channel: 'news', userId: OFFICIAL_UID });
    assert.equal(r.json.testers[0].name, '王小明', '沒填名字就用 LINE 暱稱');
    r = await tReq(env, '/line/testers/add', { channel: 'news', userId: OFFICIAL_UID, name: 'x'.repeat(80) });
    assert.equal(r.json.testers[0].name.length, 40);
    // 填的名字之後可以再用同一個 userId 更新
    r = await tReq(env, '/line/testers/add', { channel: 'test', userId: OFFICIAL_UID2, name: '小編B' });
    assert.equal(r.json.testers[0].name, '小編B'); assert.equal(r.json.testers.length, 1);
  } finally { line.restore(); }
});

test('連線狀態：/line/status 多回 Cron 心跳與正式帳號開關', async () => {
  const line = installFakeLine(); const r2 = fakeR2(); const env = { ...BASE_ENV, LINE_IMG: r2 };
  try {
    let r = await req(env, '/line/status', { channel: 'news' });
    assert.equal(r.json.heartbeatAt, 0); assert.equal(r.json.officialAllowed, false); assert.equal(r.json.r2Ready, true);
    r2.store.set('meta/heartbeat.json', { bytes: JSON.stringify({ at: 1234567 }) });
    r = await req({ ...env, LINE_ALLOW_OFFICIAL: '1' }, '/line/status', { channel: 'news' });
    assert.equal(r.json.heartbeatAt, 1234567); assert.equal(r.json.officialAllowed, true);
  } finally { line.restore(); }
});
