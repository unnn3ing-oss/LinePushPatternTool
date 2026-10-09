// 執行：node --test worker/test/*.test.mjs
// 快速回覆（Quick Reply）：LINE 直發附在最後一則訊息；S8 路徑帶 quickReply 參數；格式不合格一律 400 且不碰 LINE／S8／R2。
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { makeLabToken } from '../og-image-proxy.js';

const ORIGIN = 'http://localhost:8960';
const ENV0 = { LAB_PASSWORD: 'test-password', ALLOWED_ORIGINS: ORIGIN, LINE_CHANNEL_ID_TEST: '111', LINE_CHANNEL_SECRET_TEST: 'sec-test', LINE_CHANNEL_ID_NEWS: '222', LINE_CHANNEL_SECRET_NEWS: 'sec-news' };
const enc = new TextEncoder();
const b64u = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function seal(obj) {
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(`s8-session|${ENV0.LAB_PASSWORD}`));
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj))));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
  return b64u(out);
}
const PNG = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4));
const page = () => ({ width: 1040, height: 800, images: { 1040: PNG }, buttons: [{ title: 't', url: 'https://example.com/a', x: '0%', y: '0%', width: '50%', height: '50%' }] });
const QUICK = [{ label: '蔣萬安', kind: 'text', value: '蔣萬安' }, { label: '少康獨家專訪六都', kind: 'text', value: '少康獨家專訪六都' }, { label: '看更多', kind: 'url', value: 'https://example.com/more' }];
const LABEL20 = '一二三四五六七八九十一二三四五六七八九十';

function fakeR2() {
  const store = new Map();
  return { store, async put(k, b, o) { store.set(k, { bytes: b, httpMetadata: o && o.httpMetadata, customMetadata: o && o.customMetadata }); }, async get(k) { const o = store.get(k); return o ? { key: k, body: o.bytes, async text() { return typeof o.bytes === 'string' ? o.bytes : new TextDecoder().decode(o.bytes); } } : null; }, async delete(k) { store.delete(k); }, async list({ prefix = '' } = {}) { return { objects: [...store.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, o]) => ({ key, customMetadata: o.customMetadata })), truncated: false }; } };
}
async function call(env, path, body, extraHeaders = {}) {
  const { token } = await makeLabToken(env);
  const res = await worker.fetch(new Request(`https://worker.test${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Authorization: `Bearer ${token}`, ...extraHeaders }, body: JSON.stringify(body) }), env);
  let json = null; try { json = await res.json(); } catch { /* */ }
  return { status: res.status, json };
}

// ---------- LINE 直發 ----------
function fakeLine() {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.origin !== 'https://api.line.me') throw new Error(`unexpected fetch ${url}`);
    const key = `${init.method || 'GET'} ${u.pathname}`; calls.push({ key, body: init.body, headers: init.headers });
    const json = (d, st = 200) => new Response(JSON.stringify(d), { status: st, headers: { 'Content-Type': 'application/json', 'x-line-request-id': 'req-1' } });
    if (key === 'POST /oauth2/v3/token') return json({ access_token: 't', expires_in: 900 });
    if (key === 'GET /v2/bot/info') return json({ displayName: 'x', basicId: '@x' });
    if (key === 'GET /v2/bot/message/quota') return json({ type: 'limited', value: 200 });
    if (key === 'GET /v2/bot/message/quota/consumption') return json({ totalUsage: 1 });
    if (key === 'GET /v2/bot/insight/followers') return json({ status: 'ready', followers: 100, targetedReaches: 95, blocks: 5 });
    if (/^POST \/v2\/bot\/message\/(validate\/)?(multicast|broadcast)$/.test(key)) return json({});
    throw new Error(`unexpected LINE call ${key}`);
  };
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}
const UID = 'U' + 'a'.repeat(32);
async function tidOf(uid) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(uid))).slice(0, 8)].map(b => b.toString(16).padStart(2, '0')).join(''); }
async function lineSetup(quick) {
  const r2 = fakeR2(), env = { ...ENV0, LINE_IMG: r2 };
  const tid = await tidOf(UID);
  r2.store.set(`testers/${tid}.json`, { bytes: JSON.stringify({ tid, userId: UID, name: 'A', registeredAt: 1 }) });
  const prep = await call(env, '/line/prepare', { org: 'news', name: 'x', altText: '測試', pages: [page(), page()], ...(quick === undefined ? {} : { quick }) });
  return { r2, env, tid, prep };
}

test('LINE：快速回覆只附在「最後一則」訊息；傳送文字 → message action、連結 → uri action；沒設就沒有 quickReply', async () => {
  const line = fakeLine();
  try {
    const { env, tid, prep } = await lineSetup(QUICK);
    assert.equal(prep.status, 200, JSON.stringify(prep.json));
    const v = await call(env, '/line/validate', { prepareToken: prep.json.prepareToken, channel: 'test' });
    assert.equal(v.json.valid, true);
    const msgs = JSON.parse(line.calls.find(c => c.key === 'POST /v2/bot/message/validate/broadcast').body).messages;
    assert.equal(msgs.length, 2); assert.equal(msgs[0].quickReply, undefined, '第 1 頁沒有快速回覆');
    assert.deepEqual(msgs[1].quickReply, { items: [
      { type: 'action', action: { type: 'message', label: '蔣萬安', text: '蔣萬安' } },
      { type: 'action', action: { type: 'message', label: '少康獨家專訪六都', text: '少康獨家專訪六都' } },
      { type: 'action', action: { type: 'uri', label: '看更多', uri: 'https://example.com/more' } },
    ] });
    // 測試推播（multicast）也帶得出去
    const s = await call(env, '/line/send', { prepareToken: prep.json.prepareToken, channel: 'test', retryKey: '123e4567-e89b-12d3-a456-426614174000', testers: [tid] });
    assert.equal(s.status, 200, JSON.stringify(s.json));
    const sent = JSON.parse(line.calls.find(c => c.key === 'POST /v2/bot/message/multicast').body).messages;
    assert.equal(sent[1].quickReply.items.length, 3); assert.equal(sent[0].quickReply, undefined);
  } finally { line.restore(); }
  const line2 = fakeLine();
  try {
    for (const quick of [undefined, []]) {
      const { env, prep } = await lineSetup(quick);
      assert.equal(prep.status, 200);
      await call(env, '/line/validate', { prepareToken: prep.json.prepareToken, channel: 'test' });
    }
    for (const c of line2.calls.filter(c => c.key.includes('validate'))) assert.ok(!c.body.includes('quickReply'), '沒設快速回覆就完全不帶 quickReply');
  } finally { line2.restore(); }
});

test('LINE：快速回覆格式不合格 → 400，什麼都不存（R2 沒有圖）也不呼叫 LINE', async () => {
  const line = fakeLine();
  try {
    const many = Array.from({ length: 14 }, (_, i) => ({ label: `b${i}`, kind: 'text', value: 'x' }));
    const bad = [many, 'abc', { label: 'a' }, [{ label: '', kind: 'text', value: 'x' }], [{ label: LABEL20 + '一', kind: 'text', value: 'x' }], [{ label: 'a', kind: 'text', value: '' }], [{ label: 'a', kind: 'text', value: 'x'.repeat(301) }],
      [{ label: 'a', kind: 'url', value: 'http://example.com' }], [{ label: 'a', kind: 'url', value: 'javascript:alert(1)' }], [{ label: 'a', kind: 'url', value: 'https://a b' }], [{ label: 'a', kind: 'postback', value: 'x' }], [{ label: 'a', value: 'x' }], [null]];
    for (const quick of bad) {
      const r2 = fakeR2(), env = { ...ENV0, LINE_IMG: r2 };
      const r = await call(env, '/line/prepare', { org: 'news', name: 'x', altText: '測試', pages: [page()], quick });
      assert.equal(r.status, 400, JSON.stringify(quick).slice(0, 60));
      assert.equal(r2.store.size, 0, '格式不對不會先把圖存進 R2');
    }
    // 剛好 13 顆、剛好 20 字都可以
    const ok = Array.from({ length: 13 }, (_, i) => ({ label: LABEL20, kind: 'text', value: `關鍵字${i}` }));
    const r = await call({ ...ENV0, LINE_IMG: fakeR2() }, '/line/prepare', { org: 'news', name: 'x', altText: '測試', pages: [page()], quick: ok });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(line.calls.length, 0);
  } finally { line.restore(); }
});

test('LINE 排程：快速回覆跟著排程存起來，時間到發出去的最後一則帶 quickReply', async () => {
  const line = fakeLine();
  try {
    const { r2, env, tid, prep } = await lineSetup(QUICK);
    const at = new Date(Math.floor((Date.now() + 3600e3) / 60000) * 60000 + 8 * 3600e3).toISOString().slice(0, 19).replace(/:\d{2}$/, ':00') + '+08:00';
    const c = await call(env, '/line/schedule/create', { prepareToken: prep.json.prepareToken, channel: 'test', testers: [tid], runAt: at, links: [] });
    assert.equal(c.status, 200, JSON.stringify(c.json));
    const key = `sched/${c.json.schedule.id}.json`, rec = JSON.parse(r2.store.get(key).bytes);
    assert.equal(rec.quick.length, 3);
    rec.runAt = Date.now() - 20000; r2.store.set(key, { bytes: JSON.stringify(rec), customMetadata: { status: 'scheduled', runAt: String(rec.runAt) } });
    let p; await worker.scheduled({}, env, { waitUntil: x => { p = x; } }); await p;
    assert.equal(JSON.parse(r2.store.get(key).bytes).status, 'sent');
    const sent = JSON.parse(line.calls.find(c => c.key === 'POST /v2/bot/message/multicast').body).messages;
    assert.equal(sent.at(-1).quickReply.items[2].action.uri, 'https://example.com/more');
  } finally { line.restore(); }
});

// ---------- S8 路徑 ----------
const MCP_URL = 'https://api-next.no8.io/mcp';
function fakeS8() {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url) === 'https://upload.test/put') return new Response('', { status: 200 });
    if (String(url) !== MCP_URL) throw new Error(`unexpected fetch ${url}`);
    const msg = JSON.parse(init.body);
    const reply = result => new Response(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }), { status: 200, headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'sid1' } });
    if (msg.method === 'initialize') return reply({ protocolVersion: '2025-03-26', capabilities: {} });
    if (msg.method === 'notifications/initialized') return new Response('', { status: 202 });
    const { name, arguments: args } = msg.params; calls.push({ name, args });
    const ok = d => reply({ content: [{ type: 'text', text: JSON.stringify(d) }], structuredContent: d });
    switch (name) {
      case 'auth_organizations': return ok({ organizations: [{ id: 'org_news', displayName: 'TVBS新聞' }] });
      case 'broadcast_audience_preview': return ok({ total: 1234, previewRef: 'pref_1' });
      case 'media_upload_url': return ok({ uploadUrl: 'https://upload.test/put', assetUrl: 'https://assets.no8.io/a.png' });
      case 'messaging_message_preview': return ok({ previewUrl: 'https://preview.test/p' });
      case 'broadcast_create': return ok({ taskId: 'task_1', status: 'scheduled' });
      case 'broadcast_get': return ok({ taskId: 'task_1', status: 'scheduled', phase: 'scheduled', allowedActions: ['pause'] });
      case 'broadcast_update': return ok({ ok: true });
      default: throw new Error(`tool ${name} should not be called`);
    }
  };
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}
async function s8Call(path, body) {
  const session = await seal({ a: 'access', r: 'refresh', e: Date.now() + 3600e3, c: 'client', s: 'insightark-mcp:read insightark-mcp:write' });
  return call(ENV0, path, body, { 'X-S8-Session': session });
}
const atIn = ms => new Date(Math.floor((Date.now() + ms) / 60000) * 60000 + 8 * 3600e3).toISOString().slice(0, 19).replace(/:\d{2}$/, ':00') + '+08:00';

test('S8：快速回覆 → 預覽與 broadcast_create 都帶 quickReply（message／uri 格式）；沒設就和以前完全一樣', async () => {
  const s8 = fakeS8();
  try {
    let r = await s8Call('/s8/prepare', { org: 'news', name: 'n', altText: '測試', pages: [page()], images: [PNG], quick: QUICK });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const qr = [{ action: 'message', label: '蔣萬安', text: '蔣萬安' }, { action: 'message', label: '少康獨家專訪六都', text: '少康獨家專訪六都' }, { action: 'uri', label: '看更多', url: 'https://example.com/more' }];
    assert.deepEqual(s8.calls.find(c => c.name === 'messaging_message_preview').args.quickReply, qr);
    const c = await s8Call('/s8/create', { prepareToken: r.json.prepareToken, confirmTotal: 1234 });
    assert.equal(c.status, 200, JSON.stringify(c.json));
    const created = s8.calls.find(x => x.name === 'broadcast_create').args;
    assert.deepEqual(created.quickReply, qr); assert.equal(created.scheduleAt.length > 20, true);
    // 沒設快速回覆
    s8.calls.length = 0;
    r = await s8Call('/s8/prepare', { org: 'news', name: 'n', altText: '測試', pages: [page()], images: [PNG] });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(s8.calls.find(c => c.name === 'messaging_message_preview').args).sort(), ['messages', 'orgId', 'platform']);
    await s8Call('/s8/create', { prepareToken: r.json.prepareToken, confirmTotal: 1234 });
    assert.deepEqual(Object.keys(s8.calls.find(x => x.name === 'broadcast_create').args).sort(), ['messages', 'orgId', 'platform', 'previewRef', 'recipients', 'scheduleAt']);
  } finally { s8.restore(); }
});

test('S8：快速回覆格式不合格 → 400 且完全沒呼叫 S8；被竄改的 prepareToken（壞的 quickReply）被把關擋下，不會 broadcast_create', async () => {
  const s8 = fakeS8();
  try {
    const r = await s8Call('/s8/prepare', { org: 'news', name: 'n', altText: '測試', pages: [page()], images: [PNG], quick: [{ label: 'a', kind: 'url', value: 'http://insecure.example' }] });
    assert.equal(r.status, 400); assert.equal(s8.calls.length, 0);
    const MESSAGES = [{ contentType: 'application/x-template', data: { templateType: 'imagemap', altText: '測試', elements: [{ title: 't', imageUrl: 'https://assets.no8.io/a.png', size: { width: 1040, height: 800 }, messageTemplateType: 'ImagemapTemplate1', buttons: [{ title: 't', type: 'url', data: 'https://example.com/a', tags: [], x: '0%', y: '0%', width: '100%', height: '100%' }] }] } }];
    for (const quickReply of [[{ action: 'postback', label: 'a', postback: 'x' }], [{ action: 'message', label: 'a', text: 'x', extra: 1 }], [{ action: 'uri', label: 'a', url: 'http://x.example' }], [{ action: 'message', label: LABEL20 + '一', text: 'x' }], 'abc', Array.from({ length: 14 }, () => ({ action: 'message', label: 'a', text: 'x' }))]) {
      const token = await seal({ t: 'prepare', org: 'news', orgId: 'org_news', messages: MESSAGES, quickReply, x: Date.now() + 600e3 });
      const c = await s8Call('/s8/create', { prepareToken: token, confirmTotal: 1234 });
      assert.ok(c.status >= 400, JSON.stringify(quickReply).slice(0, 50));
    }
    assert.equal(s8.calls.filter(x => x.name === 'broadcast_create').length, 0, '壞的快速回覆一個都沒有真的建立群發');
  } finally { s8.restore(); }
});
