// 執行：node --test worker/test/*.test.mjs
// 用假的 LINE API 與假的 R2 驗證 LINE 直連：憑證、準備（圖片進 R2）、檢查、發送的各道關卡，
// 以及「Worker 只會呼叫白名單內的 LINE 端點」（沒有 push／multicast／narrowcast）。
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { makeLabToken } from '../og-image-proxy.js';

const ORIGIN = 'http://localhost:8960';
const BASE_ENV = { LAB_PASSWORD: 'test-password', ALLOWED_ORIGINS: ORIGIN, LINE_CHANNEL_ID_TEST: '111', LINE_CHANNEL_SECRET_TEST: 'sec-test', LINE_CHANNEL_ID_NEWS: '222', LINE_CHANNEL_SECRET_NEWS: 'sec-news' };
const UUID = '123e4567-e89b-12d3-a456-426614174000';
const enc = new TextEncoder();

function fakeR2() {
  const store = new Map();
  return { store, async put(k, bytes, opts) { store.set(k, { bytes, httpMetadata: opts && opts.httpMetadata }); }, async get(k) { const o = store.get(k); return o ? { body: o.bytes, httpMetadata: o.httpMetadata } : null; } };
}
const PNG_B64 = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4));
const imagesB64 = () => Object.fromEntries([240, 300, 460, 700, 1040].map(w => [w, PNG_B64]));
const page = (h = 800) => ({ width: 1040, height: h, images: imagesB64(), buttons: [{ title: 't', url: 'https://example.com/a', x: '0%', y: '0%', width: '50%', height: '50%' }, { title: 't2', url: 'https://example.com/b', x: '50%', y: '50%', width: '50%', height: '50%' }] });
const prepBody = (extra = {}) => ({ org: 'news', name: 'x', altText: '測試推播', pages: [page(), page()], ...extra });

// 假 LINE：記錄每一次呼叫；followers / quota 可調
function installFakeLine({ followers = 1000, quota = { type: 'limited', value: 100000 }, used = 10, validateStatus = 200, broadcastStatus = 200, tokenStatus = 200 } = {}) {
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
    if (key === 'POST /v2/bot/message/validate/broadcast') return validateStatus === 200 ? json({}) : json({ message: 'The request body has 1 error(s)', details: [{ message: 'must be valid', property: 'messages[0].baseUrl' }] }, validateStatus);
    if (key === 'POST /v2/bot/message/broadcast') return broadcastStatus === 200 || broadcastStatus === 409 ? json({}, broadcastStatus) : json({ message: 'You have reached your monthly limit.' }, broadcastStatus);
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
async function prepared(env, extra) { const r = await req(env, '/line/prepare', prepBody(extra)); assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; }
const sendBody = (prep, extra = {}) => ({ prepareToken: prep.prepareToken, channel: 'test', retryKey: UUID, ...extra });
const FORBIDDEN_PATHS = /push|multicast|narrowcast|richmenu|webhook|oauth2\/v2|revoke/i;

test('所有 /line 端點都要試驗功能憑證', async () => {
  const env = { ...BASE_ENV, LINE_IMG: fakeR2() };
  for (const p of ['/line/status', '/line/prepare', '/line/validate', '/line/send']) {
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

test('prepare：2 頁 × 5 種寬度共 10 張進 R2，路徑不含副檔名，回傳 prepareToken', async () => {
  const r2 = fakeR2(); const env = { ...BASE_ENV, LINE_IMG: r2 };
  const j = await prepared(env);
  assert.equal(j.pages, 2);
  assert.equal(r2.store.size, 10);
  for (const k of r2.store.keys()) assert.match(k, /^line\/[0-9a-f]{32}\/(240|300|460|700|1040)$/);
  assert.equal([...r2.store.values()][0].httpMetadata.contentType, 'image/png');
  assert.ok(j.prepareToken.length > 20);
});

test('prepare：不合格的輸入都回 400 且不存任何圖', async () => {
  const r2 = fakeR2(); const env = { ...BASE_ENV, LINE_IMG: r2 };
  const bad = [
    prepBody({ org: 'other' }), prepBody({ altText: '' }), prepBody({ pages: [] }),
    prepBody({ pages: [{ ...page(), height: 500 }] }),
    prepBody({ pages: [{ ...page(), images: { ...imagesB64(), 700: btoa('not an image') } }] }),
    prepBody({ pages: [{ ...page(), images: { ...imagesB64(), 240: '' } }] }),
    prepBody({ pages: [{ ...page(), buttons: [{ title: 't', url: 'javascript:alert(1)', x: '0%', y: '0%', width: '50%', height: '50%' }] }] }),
  ];
  for (const b of bad) { const r = await req(env, '/line/prepare', b); assert.equal(r.status, 400, JSON.stringify(b).slice(0, 80)); }
  assert.equal(r2.store.size, 0);
});

test('GET /line-img：只提供合法路徑與寬度，不用副檔名、不用憑證', async () => {
  const r2 = fakeR2(); const env = { ...BASE_ENV, LINE_IMG: r2 };
  await prepared(env);
  const key = [...r2.store.keys()].find(k => k.endsWith('/700'));
  const [, pid] = key.split('/');
  const ok = await worker.fetch(new Request(`https://worker.test/line-img/${pid}/700`), env);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/png');
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

test('send（測試帳號）：先 validate、再 broadcast；帶 retry key；回 testToken', async () => {
  const line = installFakeLine(); const env = { ...BASE_ENV, LINE_IMG: fakeR2() };
  try {
    const prep = await prepared(env);
    const r = await req(env, '/line/send', sendBody(prep));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.ok, true); assert.equal(r.json.official, false); assert.equal(r.json.friends, 1000);
    assert.ok(r.json.testToken);
    const order = line.calls.map(c => `${c.method} ${c.path}`).filter(k => /validate|message\/broadcast/.test(k));
    assert.deepEqual(order, ['POST /v2/bot/message/validate/broadcast', 'POST /v2/bot/message/broadcast']);
    const b = line.calls.find(c => c.path === '/v2/bot/message/broadcast');
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
    assert.equal(line.count('POST /v2/bot/message/broadcast'), 0);
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
    assert.equal(line.count('POST /v2/bot/message/broadcast'), 0);
  } finally { line.restore(); }
});

test('send：額度不夠 → 409 不發送', async () => {
  const line = installFakeLine({ followers: 5000, quota: { type: 'limited', value: 1000 }, used: 900 }); const env = { ...BASE_ENV, LINE_IMG: fakeR2() };
  try {
    const prep = await prepared(env);
    const r = await req(env, '/line/send', sendBody(prep));
    assert.equal(r.status, 409); assert.match(r.json.error, /額度不夠/);
    assert.equal(line.count('POST /v2/bot/message/broadcast'), 0);
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
    assert.equal(line.count('POST /v2/bot/message/broadcast'), 1);
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
    assert.equal(line.count('POST /v2/bot/message/broadcast'), 1, '只有測試帳號那一次');
  } finally { line.restore(); }
});

test('整個過程只呼叫白名單內的 LINE 端點（沒有 push／multicast／narrowcast）', async () => {
  const line = installFakeLine(); const env = { ...BASE_ENV, LINE_IMG: fakeR2() };
  try {
    const prep = await prepared(env);
    await req(env, '/line/status', { channel: 'test' });
    await req(env, '/line/validate', { prepareToken: prep.prepareToken, channel: 'test' });
    await req(env, '/line/send', sendBody(prep));
    assert.ok(line.calls.length > 5);
    for (const c of line.calls) assert.ok(!FORBIDDEN_PATHS.test(c.path), c.path);
    const allowed = new Set(['POST /oauth2/v3/token', 'GET /v2/bot/info', 'GET /v2/bot/message/quota', 'GET /v2/bot/message/quota/consumption', 'GET /v2/bot/insight/followers', 'POST /v2/bot/message/validate/broadcast', 'POST /v2/bot/message/broadcast']);
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
