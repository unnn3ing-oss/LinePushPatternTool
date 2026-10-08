// 執行：node --test worker/test/*.test.mjs
// POST /s8/tools：只列出名單內工具的名稱／說明／欄位（MCP tools/list），不執行任何工具。
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { makeLabToken } from '../og-image-proxy.js';

const ORIGIN = 'http://localhost:8960';
const ENV = { LAB_PASSWORD: 'test-password', ALLOWED_ORIGINS: ORIGIN };
const MCP_URL = 'https://api-next.no8.io/mcp';
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
const TOOLS = ['auth_me', 'broadcast_create', 'crm_customer_search', 'crm_customer_get', 'crm_platform_list', 'crm_customer_group_members_list', 'messaging_customer_send_message', 'credits_usage', 'crm_customer_update', 'crm_customer_tag_batch_add', 'broadcast_list']
  .map(name => ({ name, description: `${name} 說明`, inputSchema: { type: 'object', properties: { orgId: { type: 'string' } } } }));

test('/s8/tools：多列出客戶資料與單一客戶發送的欄位定義，但只做 tools/list，不執行任何工具；會修改資料的客戶工具不列', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url) !== MCP_URL) throw new Error(`unexpected fetch ${url}`);
    const msg = JSON.parse(init.body); calls.push(msg.method);
    const reply = result => new Response(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }), { status: 200, headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'sid1' } });
    if (msg.method === 'initialize') return reply({ protocolVersion: '2025-03-26', capabilities: {} });
    if (msg.method === 'notifications/initialized') return new Response('', { status: 202 });
    if (msg.method === 'tools/list') return reply({ tools: TOOLS });
    throw new Error(`unexpected method ${msg.method}`);
  };
  try {
    const { token } = await makeLabToken(ENV);
    const session = await seal({ a: 'access', r: 'refresh', e: Date.now() + 3600e3, c: 'client', s: 'insightark-mcp:read insightark-mcp:write' });
    const res = await worker.fetch(new Request('https://worker.test/s8/tools', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Authorization: `Bearer ${token}`, 'X-S8-Session': session }, body: '{}' }), ENV);
    const j = await res.json();
    assert.equal(res.status, 200, JSON.stringify(j));
    const names = j.tools.map(t => t.name);
    for (const n of ['crm_customer_search', 'crm_customer_get', 'crm_platform_list', 'crm_customer_group_members_list', 'messaging_customer_send_message', 'credits_usage', 'broadcast_create', 'auth_me']) assert.ok(names.includes(n), n);
    for (const n of ['crm_customer_update', 'crm_customer_tag_batch_add', 'broadcast_list']) assert.ok(!names.includes(n), `${n} 不該列出`);
    assert.ok(j.tools.every(t => t.inputSchema && t.description), '每個工具都帶欄位定義與說明');
    assert.deepEqual([...new Set(calls)].sort(), ['initialize', 'notifications/initialized', 'tools/list'], '只做 tools/list，沒有任何 tools/call');
  } finally { globalThis.fetch = realFetch; }
});
