// 執行：node --test worker/test/*.test.mjs
// 用假的 S8 MCP 伺服器驗證 POST /s8/create 的 mode（draft／schedule），並確認任何模式都不會呼叫 resume／sendNow。
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { makeLabToken } from '../og-image-proxy.js';

const ORIGIN = 'http://localhost:8960';
const ENV = { LAB_PASSWORD: 'test-password', ALLOWED_ORIGINS: ORIGIN };
const ORG_ID = 'org_news';
const TASK_ID = 'task_abc123';
const MCP_URL = 'https://api-next.no8.io/mcp';

// ---- 與 Worker 相同的 AES-GCM 封裝（測試用），好讓我們自己造 session / prepareToken ----
const enc = new TextEncoder();
const b64u = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function seal(obj) {
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(`s8-session|${ENV.LAB_PASSWORD}`));
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj))));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
  return b64u(out);
}

const MESSAGES = [{
  contentType: 'application/x-template',
  data: { templateType: 'imagemap', altText: '測試推播', elements: [{ title: 't', imageUrl: 'https://assets.no8.io/a.png', size: { width: 1040, height: 800 }, messageTemplateType: 'ImagemapTemplate1', buttons: [{ title: 'b', type: 'url', data: 'https://example.com', tags: [], x: '0%', y: '0%', width: '50%', height: '50%' }] }] },
}];

// ---- 假 S8：記錄所有 tools/call，broadcast_create 之後狀態是 scheduled（pause 後變 draft）----
function installFakeS8({ total = 1234, getFails = false, createWithoutId = false } = {}) {
  const calls = [];
  const state = { status: 'scheduled', phase: 'scheduled' };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url) !== MCP_URL) throw new Error(`unexpected fetch ${url}`);
    const msg = JSON.parse(init.body);
    const reply = result => new Response(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }), { status: 200, headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'sid1' } });
    if (msg.method === 'initialize') return reply({ protocolVersion: '2025-03-26', capabilities: {} });
    if (msg.method === 'notifications/initialized') return new Response('', { status: 202 });
    if (msg.method !== 'tools/call') throw new Error(`unexpected method ${msg.method}`);
    const { name, arguments: args } = msg.params;
    calls.push({ name, args });
    const ok = data => reply({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });
    switch (name) {
      case 'auth_organizations': return ok({ organizations: [{ id: ORG_ID, displayName: 'TVBS新聞' }] });
      case 'broadcast_audience_preview': return ok({ total, previewRef: 'pref_1' });
      case 'broadcast_create': return ok(createWithoutId ? { ok: true } : { taskId: TASK_ID, status: 'scheduled' });
      case 'broadcast_get':
        if (getFails) return reply({ isError: true, content: [{ type: 'text', text: 'boom' }] });
        return ok({ taskId: TASK_ID, status: state.status, phase: state.phase, allowedActions: state.status === 'draft' ? ['delete'] : ['pause', 'delete'] });
      case 'broadcast_update': state.status = state.phase = 'draft'; return ok({ ok: true });
      default: throw new Error(`tool ${name} should not be called in this test`);
    }
  };
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

async function post(path, body, extra = {}) {
  const { token } = await makeLabToken(ENV);
  const session = await seal({ a: 'access', r: 'refresh', e: Date.now() + 3600e3, c: 'client', s: 'insightark-mcp:read insightark-mcp:write' });
  const req = new Request(`https://worker.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Authorization: `Bearer ${token}`, 'X-S8-Session': session, ...extra },
    body: JSON.stringify(body),
  });
  const res = await worker.fetch(req, ENV);
  return { status: res.status, json: await res.json() };
}
// 台北時間、到分鐘（秒固定 00）的 RFC 3339 字串：現在 + ms
const atIn = ms => new Date(Math.floor((Date.now() + ms) / 60000) * 60000 + 8 * 3600e3).toISOString().slice(0, 19).replace(/:\d{2}$/, ':00') + '+08:00';
async function createBody(extra = {}) {
  const prepareToken = await seal({ t: 'prepare', org: 'news', orgId: ORG_ID, messages: MESSAGES, x: Date.now() + 600e3 });
  const sched = extra.mode === 'schedule' && !('scheduleAt' in extra) ? { scheduleAt: atIn(24 * 3600e3) } : {};
  return { prepareToken, confirmTotal: 1234, ...sched, ...extra };
}
const names = calls => calls.map(c => c.name);
const FORBIDDEN = /resume|send_?now|sendNow|send$/i;

test('沒帶 mode → 預設 draft：建立、暫停、確認草稿', async () => {
  const s8 = installFakeS8();
  try {
    const { status, json } = await post('/s8/create', await createBody());
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.mode, 'draft');
    assert.equal(json.status, 'draft');
    assert.deepEqual(names(s8.calls).filter(n => n.startsWith('broadcast_') && n !== 'broadcast_audience_preview'), ['broadcast_create', 'broadcast_get', 'broadcast_update', 'broadcast_get']);
    assert.deepEqual(s8.calls.find(c => c.name === 'broadcast_update').args, { orgId: ORG_ID, taskId: TASK_ID, action: 'pause' });
  } finally { s8.restore(); }
});

test("mode:'draft' 明確指定，行為與預設相同", async () => {
  const s8 = installFakeS8();
  try {
    const { json } = await post('/s8/create', await createBody({ mode: 'draft' }));
    assert.equal(json.ok, true); assert.equal(json.mode, 'draft');
    assert.ok(names(s8.calls).includes('broadcast_update'));
  } finally { s8.restore(); }
});

for (const bad of ['Schedule', 'SCHEDULE', 'send', 'sendNow', 'resume', 'immediate', '', ' schedule', null, 0, 1, true, false, [], ['schedule'], {}, { mode: 'schedule' }]) {
  test(`非法 mode ${JSON.stringify(bad)} → 400，且完全沒有呼叫 S8`, async () => {
    const s8 = installFakeS8();
    try {
      const { status, json } = await post('/s8/create', await createBody({ mode: bad }));
      assert.equal(status, 400);
      assert.match(json.error, /mode/);
      assert.equal(s8.calls.length, 0);
    } finally { s8.restore(); }
  });
}

test("mode:'schedule' → 不呼叫 broadcast_update，改用 broadcast_get 確認，回傳完整欄位", async () => {
  const s8 = installFakeS8();
  try {
    const want = atIn(3 * 3600e3);
    const { status, json } = await post('/s8/create', await createBody({ mode: 'schedule', scheduleAt: want }));
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.mode, 'schedule');
    assert.equal(json.taskId, TASK_ID);
    assert.equal(json.status, 'scheduled');
    assert.equal(json.phase, 'scheduled');
    assert.deepEqual(json.allowedActions, ['pause', 'delete']);
    assert.equal(json.total, 1234);
    assert.equal(json.orgId, ORG_ID);
    assert.equal(names(s8.calls).includes('broadcast_update'), false, 'schedule 模式不得呼叫 broadcast_update');
    assert.deepEqual(names(s8.calls).filter(n => n.startsWith('broadcast_') && n !== 'broadcast_audience_preview'), ['broadcast_create', 'broadcast_get']);
    assert.deepEqual(s8.calls.find(c => c.name === 'broadcast_get').args, { orgId: ORG_ID, taskId: TASK_ID });
    // scheduleAt：原樣用使用者指定的台北時間（到分鐘）
    assert.equal(json.scheduleAt, want);
    assert.equal(s8.calls.find(c => c.name === 'broadcast_create').args.scheduleAt, want);
  } finally { s8.restore(); }
});

test("schedule 模式：送給 broadcast_create 的參數仍固定（全部 LINE 顧客，recipients 不接受自訂）", async () => {
  const s8 = installFakeS8();
  try {
    const want = atIn(2 * 3600e3);
    await post('/s8/create', await createBody({ mode: 'schedule', scheduleAt: want, recipients: { where: { tags: ['x'] } }, platform: 'facebook', sendNow: true }));
    const c = s8.calls.find(x => x.name === 'broadcast_create');
    assert.deepEqual(Object.keys(c.args).sort(), ['messages', 'orgId', 'platform', 'previewRef', 'recipients', 'scheduleAt']);
    assert.deepEqual(c.args.recipients, { where: { platforms: ['line'] } });
    assert.equal(c.args.platform, 'line');
    assert.equal(c.args.scheduleAt, want);
  } finally { s8.restore(); }
});

test('draft 模式：scheduleAt 固定為建立當下 +24 小時，且不接受自訂 scheduleAt（400，沒有呼叫 S8）', async () => {
  const s8 = installFakeS8();
  try {
    const before = Date.now();
    const ok = await post('/s8/create', await createBody({ mode: 'draft' }));
    assert.equal(ok.json.ok, true);
    const at = Date.parse(s8.calls.find(x => x.name === 'broadcast_create').args.scheduleAt);
    assert.ok(at >= before + 23.9 * 3600e3 && at <= Date.now() + 24 * 3600e3 + 1000, 'draft 的 scheduleAt 約等於 +24 小時');
    s8.calls.length = 0;
    const bad = await post('/s8/create', await createBody({ mode: 'draft', scheduleAt: atIn(2 * 3600e3) }));
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /scheduleAt/);
    assert.equal(s8.calls.length, 0);
  } finally { s8.restore(); }
});

// 排程時間的範圍與格式：Worker 強制 +30 分鐘 ～ +7 天；不合格一律 400 且完全沒有呼叫 S8
const BAD_TIMES = {
  '缺少 scheduleAt': () => undefined,
  '現在（立即發送）': () => atIn(0),
  '過去': () => atIn(-3600e3),
  '+10 分鐘': () => atIn(10 * 60e3),
  '+29 分鐘': () => atIn(29 * 60e3),
  '+7 天又 2 小時': () => atIn(7 * 24 * 3600e3 + 2 * 3600e3),
  '+30 天': () => atIn(30 * 24 * 3600e3),
  '不存在的日期 2 月 31 日': () => '2099-02-31T10:00:00+08:00',
  '帶秒數': () => atIn(3 * 3600e3).replace(':00+08:00', ':30+08:00'),
  '不是台北時區': () => atIn(3 * 3600e3).replace('+08:00', 'Z'),
  '非字串': () => 1234567890,
  '空字串': () => '',
};
for (const [label, make] of Object.entries(BAD_TIMES)) {
  test(`排程時間不合格（${label}）→ 400，完全沒有呼叫 S8`, async () => {
    const s8 = installFakeS8();
    try {
      const body = await createBody({ mode: 'schedule' });
      const v = make();
      if (v === undefined) delete body.scheduleAt; else body.scheduleAt = v;
      const { status, json } = await post('/s8/create', body);
      assert.equal(status, 400);
      assert.match(json.error, /沒有建立任何東西/);
      assert.equal(s8.calls.length, 0);
    } finally { s8.restore(); }
  });
}

for (const [label, ms] of [['+31 分鐘（下限內）', 31 * 60e3], ['+3 小時', 3 * 3600e3], ['+6 天 23 小時（上限內）', 6 * 24 * 3600e3 + 23 * 3600e3]]) {
  test(`排程時間合格（${label}）→ 照指定時間建立，不暫停`, async () => {
    const s8 = installFakeS8();
    try {
      const want = atIn(ms);
      const { status, json } = await post('/s8/create', await createBody({ mode: 'schedule', scheduleAt: want }));
      assert.equal(status, 200);
      assert.equal(json.ok, true);
      assert.equal(json.scheduleAt, want);
      assert.equal(names(s8.calls).includes('broadcast_update'), false);
    } finally { s8.restore(); }
  });
}

test('任何模式都沒有 resume／sendNow，且 broadcast_update 只會是 pause', async () => {
  for (const mode of [undefined, 'draft', 'schedule']) {
    const s8 = installFakeS8();
    try {
      await post('/s8/create', await createBody(mode ? { mode } : {}));
      assert.equal(s8.calls.some(c => FORBIDDEN.test(c.name) || (c.args && FORBIDDEN.test(String(c.args.action || '')))), false);
      for (const u of s8.calls.filter(c => c.name === 'broadcast_update')) assert.equal(u.args.action, 'pause');
    } finally { s8.restore(); }
  }
});

test('schedule 模式仍須輸入正確人數：不符 → 409，沒有 broadcast_create', async () => {
  const s8 = installFakeS8();
  try {
    const { status, json } = await post('/s8/create', await createBody({ mode: 'schedule', confirmTotal: 1 }));
    assert.equal(status, 409);
    assert.match(json.error, /沒有建立任何東西/);
    assert.equal(names(s8.calls).includes('broadcast_create'), false);
  } finally { s8.restore(); }
});

test('schedule 模式讀不到狀態 → ok:false 並明確警告實際發送時間，仍不呼叫 broadcast_update', async () => {
  const s8 = installFakeS8({ getFails: true });
  try {
    const { json } = await post('/s8/create', await createBody({ mode: 'schedule' }));
    assert.equal(json.ok, false);
    assert.equal(json.created, true);
    assert.equal(json.taskId, TASK_ID);
    assert.match(json.warning, /實際發送/);
    assert.equal(names(s8.calls).includes('broadcast_update'), false);
  } finally { s8.restore(); }
});

test('找不到 taskId → ok:false，警告會實際發送', async () => {
  const s8 = installFakeS8({ createWithoutId: true });
  try {
    const { json } = await post('/s8/create', await createBody({ mode: 'schedule' }));
    assert.equal(json.ok, false);
    assert.match(json.warning, /實際發送/);
    assert.equal(names(s8.calls).includes('broadcast_update'), false);
  } finally { s8.restore(); }
});

test('/s8/pause 仍可把 schedule 建立的群發暫停成草稿（只有 pause）', async () => {
  const s8 = installFakeS8();
  try {
    await post('/s8/create', await createBody({ mode: 'schedule' }));
    s8.calls.length = 0;
    const { json } = await post('/s8/pause', { org: 'news', taskId: TASK_ID });
    assert.equal(json.ok, true);
    assert.equal(json.status, 'draft');
    assert.deepEqual(s8.calls.filter(c => c.name === 'broadcast_update').map(c => c.args.action), ['pause']);
  } finally { s8.restore(); }
});
