// Cloudflare Worker: 給「Line推播套版產生器」快速填入用的文章首圖代理。
//
// 用法：GET https://<你的worker網址>/?url=<文章網址>
//   1. 抓文章網頁，找出第一張圖（og:image → twitter:image → 內文第一個 <img>）
//   2. 把那張圖原樣回傳，並加上 CORS 標頭，讓網頁能把圖畫進畫布、匯出 JPG
//
// 安全限制（不是開放代理）：
//   - 文章網址、圖片網址的網域都必須在 ALLOWED_HOST_SUFFIXES 內
//   - 只允許 https
//   - 只回傳 image/* 且 ≤ 15MB
//   - 只允許 ALLOWED_ORIGINS 內的網頁呼叫（其他網站的瀏覽器請求會被擋）
//
// 若圖片放在別的網域（回應會寫「圖片網域不在允許名單」並列出網域），把它加進
// ALLOWED_HOST_SUFFIXES 後重新部署即可。
//
// 另有「試驗功能」的密碼驗證（見 worker/README.md 的「試驗功能密碼」）：
//   POST /lab-auth   body {"password":"..."} → 密碼對時回傳 {token, expiresAt}，否則 401
//   GET  /lab-ping   帶 Authorization: Bearer <token> → token 有效回 {ok:true}
// 密碼只放在 Worker 的環境變數 LAB_PASSWORD（Secret），網頁原始碼裡沒有；沒設定時一律拒絕。
//
// 另有「S8 OAuth」（階段一：只讀，見 worker/README.md 的「連結 SUPER 8 Studio」）：
//   POST /s8/login-start  → 取得 S8 授權頁網址（只請求 insightark-mcp:read 範圍）
//   GET  /s8/callback     → S8 授權完成後跳回這裡，換取憑證、加密後交還網頁
//   POST /s8/status       → 用憑證呼叫 auth_me、auth_organizations（唯讀）
//   POST /s8/audience     → 試算「全部 LINE 顧客」可發送人數（broadcast_audience_preview，唯讀；組織與參數都由 Worker 固定）
//   POST /s8/tools        → 列出 S8 工具的名稱與欄位定義（MCP tools/list，唯讀，不執行任何工具）
// S8 憑證只以加密形式存在，網頁拿到的是看不懂的字串，只有這個 Worker 能解開。

const ALLOWED_HOST_SUFFIXES = ['tvbs.com.tw'];
const ALLOWED_ORIGINS = [
  'https://unnn3ing-oss.github.io',
  'http://localhost:8000',
  'http://localhost:8960',
];
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept-Language': 'zh-TW,zh;q=0.9',
};

function hostAllowed(hostname, env) {
  const suffixes = (env && env.ALLOWED_HOST_SUFFIXES ? env.ALLOWED_HOST_SUFFIXES.split(',') : ALLOWED_HOST_SUFFIXES).map(s => s.trim()).filter(Boolean);
  return suffixes.some(s => hostname === s || hostname.endsWith('.' + s));
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = env && env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS.split(',').map(s => s.trim()) : ALLOWED_ORIGINS;
  const h = {
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-S8-Session',
    'Access-Control-Expose-Headers': 'X-Image-Url',
  };
  if (origin && allowed.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function jsonError(status, message, request, env) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(request, env) },
  });
}

function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

// Finds the first usable image URL in an article's HTML.
export function extractFirstImage(html, baseUrl) {
  const metas = [...html.matchAll(/<meta\b[^>]*>/gi)].map(m => m[0]);
  const attr = (tag, name) => {
    const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
    return m ? decodeEntities(m[2] !== undefined ? m[2] : m[3]) : '';
  };
  for (const key of ['og:image:secure_url', 'og:image', 'twitter:image', 'twitter:image:src']) {
    for (const tag of metas) {
      const k = (attr(tag, 'property') || attr(tag, 'name')).toLowerCase();
      const v = attr(tag, 'content');
      if (k === key && v) return new URL(v, baseUrl).href;
    }
  }
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const src = attr(m[0], 'data-src') || attr(m[0], 'src');
    if (src && !src.startsWith('data:') && !/\.(svg|gif)(\?|$)/i.test(src)) return new URL(src, baseUrl).href;
  }
  return '';
}

// ---- 試驗功能：密碼驗證與簽章 token -------------------------------------------
// token = "<到期時間(毫秒)>.<HMAC-SHA256(到期時間)>"。簽章金鑰用 LAB_SIGNING_KEY（沒設就用 LAB_PASSWORD，
// 這樣改密碼後舊 token 自動失效）。之後要擋下的功能（例如排入 S8）一律先呼叫 verifyLabToken。
const LAB_TOKEN_TTL_MS = 8 * 60 * 60 * 1000;
const LAB_FAIL_DELAY_MS = 600;   // 密碼錯誤時多等一下，拖慢連續猜密碼
const textEncoder = new TextEncoder();

function toBase64Url(bytes) {
  let bin = '';
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmacBytes(key, data) {
  const k = await crypto.subtle.importKey('raw', textEncoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, textEncoder.encode(data)));
}

// 比對兩個字串但不因長度或第一個不同字元提早結束：各自用隨機金鑰做 HMAC 後逐 byte 比對。
async function safeEqual(a, b) {
  const key = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  const [ha, hb] = await Promise.all([hmacBytes(key, a), hmacBytes(key, b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i] ^ hb[i];
  return diff === 0;
}

function labSigningKey(env) { return (env && (env.LAB_SIGNING_KEY || env.LAB_PASSWORD)) || ''; }

export async function makeLabToken(env, now = Date.now()) {
  const exp = String(now + LAB_TOKEN_TTL_MS);
  return { token: `${exp}.${toBase64Url(await hmacBytes(labSigningKey(env), exp))}`, expiresAt: Number(exp) };
}

export async function verifyLabToken(request, env, now = Date.now()) {
  if (!labSigningKey(env)) return false;
  const m = (request.headers.get('Authorization') || '').match(/^Bearer\s+(\S+)$/i);
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) < now) return false;
  return safeEqual(sig, toBase64Url(await hmacBytes(labSigningKey(env), exp)));
}

async function handleLabAuth(request, env) {
  if (request.method !== 'POST') return jsonError(405, '只支援 POST', request, env);
  if (!env || !env.LAB_PASSWORD) return jsonError(503, '尚未設定試驗功能密碼（Worker 缺少 LAB_PASSWORD）', request, env);
  const origin = request.headers.get('Origin');
  const allowed = env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS.split(',').map(s => s.trim()) : ALLOWED_ORIGINS;
  if (!origin || !allowed.includes(origin)) return jsonError(403, '來源不被允許', request, env);
  let password = '';
  try {
    const raw = await request.text();
    if (raw.length > 1024) return jsonError(413, '內容太長', request, env);
    const body = JSON.parse(raw);
    password = typeof body.password === 'string' ? body.password : '';
  } catch { return jsonError(400, '格式不正確', request, env); }
  if (!password || !(await safeEqual(password, env.LAB_PASSWORD))) {
    await new Promise(r => setTimeout(r, LAB_FAIL_DELAY_MS));
    return jsonError(401, '密碼不正確', request, env);
  }
  const { token, expiresAt } = await makeLabToken(env);
  return new Response(JSON.stringify({ token, expiresAt }), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...corsHeaders(request, env) },
  });
}

async function handleLabPing(request, env) {
  if (request.method !== 'GET') return jsonError(405, '只支援 GET', request, env);
  if (!(await verifyLabToken(request, env))) return jsonError(401, 'token 無效或已過期', request, env);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...corsHeaders(request, env) },
  });
}

// ---- S8 OAuth（階段一：只讀）----------------------------------------------------
// 流程：網頁（已通過試驗功能密碼）→ /s8/login-start 取得授權網址 → 在彈出視窗登入並按「允許」→ S8 跳回 /s8/callback
// → Worker 用 PKCE 換憑證、加密成 session 字串交給網頁 → 之後網頁帶著 session 呼叫 /s8/status。
// 這個階段只請求 read 範圍，且只允許呼叫 S8_READ_TOOLS 內的工具，所以 Worker 無法寫入、發送或排程任何東西。
const S8_BASE_DEFAULT = 'https://api-next.no8.io';
const S8_SCOPE_READ = 'insightark-mcp:read';
const S8_READ_TOOLS = new Set(['auth_me', 'auth_organizations', 'broadcast_audience_preview']);   // 唯讀工具白名單（只有試算人數，沒有任何建立／發送／排程）
const S8_ORG_NAMES = { news: 'TVBS新聞', ent: 'TVBS娛樂頭條' };   // 組織只能從這兩個名稱解析，不採信網頁傳來的 orgId
// 查看工具定義時只列出和群發有關的工具（名稱、說明、欄位），不呼叫它們。
const S8_TOOLS_SHOWN = new Set(['auth_me', 'auth_organizations', 'broadcast_audience_preview', 'broadcast_create', 'broadcast_update', 'broadcast_get', 'messaging_message_preview', 'media_upload_url', 'crm_tag_list']);
const S8_STATE_TTL_MS = 10 * 60 * 1000;
const S8_CLIENT_NAME = 'Line推播套版產生器';

const s8Base = env => ((env && env.S8_BASE) || S8_BASE_DEFAULT).replace(/\/+$/, '');
const s8McpUrl = env => `${s8Base(env)}/mcp`;
const textDecoder = new TextDecoder();

function fromBase64Url(str) {
  const b = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4));
  return Uint8Array.from(b, c => c.charCodeAt(0));
}

// AES-GCM 加密 JSON（金鑰由 LAB_SIGNING_KEY 或 LAB_PASSWORD 衍生，沒設就拒絕）。
async function s8Key(env) {
  const secret = labSigningKey(env);
  if (!secret) throw new Error('未設定 LAB_PASSWORD');
  const raw = await crypto.subtle.digest('SHA-256', textEncoder.encode(`s8-session|${secret}`));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function s8Seal(env, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await s8Key(env), textEncoder.encode(JSON.stringify(obj))));
  const out = new Uint8Array(iv.length + ct.length); out.set(iv); out.set(ct, iv.length);
  return toBase64Url(out);
}
async function s8Open(env, sealed) {
  try {
    const all = fromBase64Url(String(sealed || ''));
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, await s8Key(env), all.slice(12));
    return JSON.parse(textDecoder.decode(pt));
  } catch { return null; }
}
const randomB64Url = n => toBase64Url(crypto.getRandomValues(new Uint8Array(n)));
async function pkceChallenge(verifier) { return toBase64Url(await crypto.subtle.digest('SHA-256', textEncoder.encode(verifier))); }

async function s8Metadata(env) {
  const base = s8Base(env);
  try {
    const r = await fetch(`${base}/.well-known/oauth-authorization-server`);
    if (r.ok) { const m = await r.json(); if (m.authorization_endpoint && m.token_endpoint) return m; }
  } catch { /* fall back */ }
  return { issuer: base, authorization_endpoint: `${base}/mcp/oauth/authorize`, token_endpoint: `${base}/mcp/oauth/token`, registration_endpoint: `${base}/mcp/oauth/register` };
}

async function s8Register(env, meta, redirectUri) {
  const r = await fetch(meta.registration_endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: S8_CLIENT_NAME, redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'], token_endpoint_auth_method: 'none', scope: S8_SCOPE_READ,
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.client_id) throw new Error(`S8 不接受註冊（${r.status}）：${data.error_description || data.error || '未知原因'}`);
  return data.client_id;
}

async function s8TokenRequest(env, meta, params) {
  const r = await fetch(meta.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams(params).toString() });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token) throw new Error(`換取憑證失敗（${r.status}）：${data.error_description || data.error || '未知原因'}`);
  return data;
}

function s8SessionFrom(data, clientId, prev) {
  return {
    a: data.access_token,
    r: data.refresh_token || (prev && prev.r) || '',
    e: Date.now() + (Number(data.expires_in) > 0 ? Number(data.expires_in) * 1000 : 3600 * 1000),
    c: clientId,
    s: data.scope || (prev && prev.s) || S8_SCOPE_READ,
  };
}

function originAllowed(url, env) {
  try {
    const allowed = env && env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS.split(',').map(x => x.trim()) : ALLOWED_ORIGINS;
    return allowed.includes(new URL(url).origin);
  } catch { return false; }
}

async function requireLab(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = env && env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS.split(',').map(x => x.trim()) : ALLOWED_ORIGINS;
  if (!origin || !allowed.includes(origin)) return jsonError(403, '來源不被允許', request, env);
  if (!(await verifyLabToken(request, env))) return jsonError(401, '試驗功能憑證無效或已過期，請重新輸入密碼', request, env);
  return null;
}

function jsonOk(body, request, env, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...corsHeaders(request, env) } });
}

async function handleS8LoginStart(request, env) {
  if (request.method !== 'POST') return jsonError(405, '只支援 POST', request, env);
  const denied = await requireLab(request, env); if (denied) return denied;
  let body = {};
  try { body = JSON.parse((await request.text()) || '{}'); } catch { return jsonError(400, '格式不正確', request, env); }
  const returnUrl = typeof body.returnUrl === 'string' ? body.returnUrl : '';
  if (!originAllowed(returnUrl, env)) return jsonError(400, 'returnUrl 的來源不被允許', request, env);
  const redirectUri = `${new URL(request.url).origin}/s8/callback`;
  try {
    const meta = await s8Metadata(env);
    let clientId = typeof body.clientId === 'string' && /^[\w.~-]{1,200}$/.test(body.clientId) ? body.clientId : '';
    let registered = false;
    if (!clientId) { clientId = await s8Register(env, meta, redirectUri); registered = true; }
    const verifier = randomB64Url(48);
    const state = await s8Seal(env, { v: verifier, c: clientId, u: returnUrl, ru: redirectUri, x: Date.now() + S8_STATE_TTL_MS });
    const url = new URL(meta.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope: S8_SCOPE_READ, state,
      code_challenge: await pkceChallenge(verifier), code_challenge_method: 'S256', resource: s8McpUrl(env),
    }).toString();
    return jsonOk({ authorizeUrl: url.href, clientId, registered, scope: S8_SCOPE_READ }, request, env);
  } catch (e) {
    return jsonError(502, e.message || '無法連到 S8', request, env);
  }
}

const htmlEsc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function callbackPage(payload, returnUrl, message) {
  const data = JSON.stringify(payload).replace(/</g, '\\u003c');
  const origin = (() => { try { return new URL(returnUrl).origin; } catch { return ''; } })();
  const back = returnUrl ? `${returnUrl.split('#')[0]}#s8=${encodeURIComponent(payload.session || '')}${payload.error ? '&s8error=' + encodeURIComponent(payload.error) : ''}&s8client=${encodeURIComponent(payload.clientId || '')}` : '';
  const html = `<!doctype html><meta charset="utf-8"><title>S8 連結</title><body style="font:16px sans-serif;padding:32px"><p>${htmlEsc(message)}</p><script>
(function(){var d=${data},o=${JSON.stringify(origin)},back=${JSON.stringify(back)};
try{if(window.opener&&o){window.opener.postMessage(d,o);window.close();return;}}catch(e){}
if(back){location.replace(back);}
})();</script>`;
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
}

async function handleS8Callback(request, env) {
  const url = new URL(request.url);
  const state = await s8Open(env, url.searchParams.get('state'));
  if (!state || !state.x || state.x < Date.now()) return callbackPage({ type: 's8-error', error: '授權逾時或無效，請回網頁重新連結' }, state && state.u, '授權逾時或無效，請回到網頁重新連結。');
  const err = url.searchParams.get('error');
  if (err) return callbackPage({ type: 's8-error', error: `S8 回報：${err}` }, state.u, `S8 沒有完成授權（${err}）。可以關閉這個視窗。`);
  const code = url.searchParams.get('code');
  if (!code) return callbackPage({ type: 's8-error', error: '缺少授權碼' }, state.u, '缺少授權碼。');
  try {
    const meta = await s8Metadata(env);
    const data = await s8TokenRequest(env, meta, {
      grant_type: 'authorization_code', code, redirect_uri: state.ru, client_id: state.c, code_verifier: state.v, resource: s8McpUrl(env),
    });
    const session = await s8Seal(env, s8SessionFrom(data, state.c));
    return callbackPage({ type: 's8-session', session, clientId: state.c }, state.u, '已連結 SUPER 8 Studio，可以關閉這個視窗。');
  } catch (e) {
    return callbackPage({ type: 's8-error', error: e.message }, state.u, e.message);
  }
}

// ---- MCP（Streamable HTTP）呼叫，只允許白名單工具 ----
function parseMcpBody(text, contentType) {
  if ((contentType || '').includes('text/event-stream')) {
    const msgs = text.split(/\r?\n\r?\n/).map(chunk => chunk.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n')).filter(Boolean);
    for (const m of msgs.reverse()) { try { const j = JSON.parse(m); if (j && (j.result !== undefined || j.error)) return j; } catch { /* next */ } }
    return null;
  }
  try { return JSON.parse(text); } catch { return null; }
}
async function mcpRpc(env, token, sessionId, id, method, params) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  const r = await fetch(s8McpUrl(env), { method: 'POST', headers, body: JSON.stringify(id === null ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params }) });
  if (r.status === 401) { const e = new Error('unauthorized'); e.status = 401; throw e; }
  const text = await r.text();
  return { status: r.status, sid: r.headers.get('Mcp-Session-Id') || sessionId, body: parseMcpBody(text, r.headers.get('Content-Type')), raw: text.slice(0, 300) };
}
async function mcpCallTools(env, token, calls) {
  for (const c of calls) if (!S8_READ_TOOLS.has(c.name)) throw new Error(`工具 ${c.name} 不在允許名單內`);
  const init = await mcpRpc(env, token, '', 1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'line-push-pattern-tool', version: '1' } });
  if (!init.body || init.body.error) throw new Error(`MCP 初始化失敗：${(init.body && init.body.error && init.body.error.message) || init.status}`);
  let sid = init.sid;
  await mcpRpc(env, token, sid, null, 'notifications/initialized', {}).catch(() => {});
  const out = {};
  let n = 2;
  for (const c of calls) {
    const r = await mcpRpc(env, token, sid, n++, 'tools/call', { name: c.name, arguments: c.args || {} });
    if (!r.body || r.body.error) throw new Error(`${c.name} 失敗：${(r.body && r.body.error && r.body.error.message) || r.status}`);
    const res = r.body.result || {};
    const text = (res.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n');
    let parsed = res.structuredContent;
    if (parsed === undefined) { try { parsed = JSON.parse(text); } catch { parsed = text; } }
    out[c.name] = { isError: !!res.isError, data: parsed };
  }
  return out;
}

async function mcpListTools(env, token) {
  const init = await mcpRpc(env, token, '', 1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'line-push-pattern-tool', version: '1' } });
  if (!init.body || init.body.error) throw new Error(`MCP 初始化失敗：${(init.body && init.body.error && init.body.error.message) || init.status}`);
  const sid = init.sid;
  await mcpRpc(env, token, sid, null, 'notifications/initialized', {}).catch(() => {});
  const all = [];
  let cursor;
  for (let i = 0; i < 10; i++) {
    const r = await mcpRpc(env, token, sid, 2 + i, 'tools/list', cursor ? { cursor } : {});
    if (!r.body || r.body.error) throw new Error(`tools/list 失敗：${(r.body && r.body.error && r.body.error.message) || r.status}`);
    all.push(...((r.body.result && r.body.result.tools) || []));
    cursor = r.body.result && r.body.result.nextCursor;
    if (!cursor) break;
  }
  return all.filter(t => S8_TOOLS_SHOWN.has(t.name)).map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}

async function handleS8Audience(request, env) {
  if (request.method !== 'POST') return jsonError(405, '只支援 POST', request, env);
  const denied = await requireLab(request, env); if (denied) return denied;
  let body = {};
  try { body = JSON.parse((await request.text()) || '{}'); } catch { return jsonError(400, '格式不正確', request, env); }
  const orgName = S8_ORG_NAMES[body.org];
  if (!orgName) return jsonError(400, 'org 只能是 news 或 ent', request, env);
  const sess = await s8Open(env, request.headers.get('X-S8-Session'));
  if (!sess || !sess.a) return jsonError(401, '尚未連結 S8（或連結資料無效），請重新連結', request, env);
  if (sess.e < Date.now() + 30 * 1000) return jsonError(401, '憑證即將過期，請先在「連結 S8」視窗按「重新檢查」更新後再試', request, env);
  try {
    // 組織 id 由 S8 自己的清單依名稱解析
    const first = await mcpCallTools(env, sess.a, [{ name: 'auth_organizations' }]);
    const list = (first.auth_organizations.data && first.auth_organizations.data.organizations) || [];
    const org = list.find(o => o.displayName === orgName);
    if (!org || !org.id) return jsonError(404, `S8 帳號下找不到組織「${orgName}」`, request, env);
    // 參數全部固定：LINE、只限定平台，不加任何標籤或其他條件；不要樣本。
    const res = await mcpCallTools(env, sess.a, [{ name: 'broadcast_audience_preview', args: { orgId: org.id, platform: 'line', recipients: { where: { platforms: ['line'] } }, includeSample: false } }]);
    return jsonOk({ ok: true, org: { id: org.id, name: orgName }, result: res.broadcast_audience_preview }, request, env);
  } catch (e) {
    return jsonError(e.status === 401 ? 401 : 502, e.message || '無法呼叫 S8', request, env);
  }
}

async function handleS8Tools(request, env) {
  if (request.method !== 'POST') return jsonError(405, '只支援 POST', request, env);
  const denied = await requireLab(request, env); if (denied) return denied;
  const sess = await s8Open(env, request.headers.get('X-S8-Session'));
  if (!sess || !sess.a) return jsonError(401, '尚未連結 S8（或連結資料無效），請重新連結', request, env);
  if (sess.e < Date.now() + 30 * 1000) return jsonError(401, '憑證即將過期，請先按「重新檢查」更新後再試', request, env);
  try {
    return jsonOk({ ok: true, tools: await mcpListTools(env, sess.a) }, request, env);
  } catch (e) {
    return jsonError(e.status === 401 ? 401 : 502, e.message || '無法呼叫 S8', request, env);
  }
}

async function handleS8Status(request, env) {
  if (request.method !== 'POST') return jsonError(405, '只支援 POST', request, env);
  const denied = await requireLab(request, env); if (denied) return denied;
  let sess = await s8Open(env, request.headers.get('X-S8-Session'));
  if (!sess || !sess.a) return jsonError(401, '尚未連結 S8（或連結資料無效），請重新連結', request, env);
  let refreshed = null;
  const refresh = async () => {
    if (!sess.r) throw new Error('憑證已過期且沒有更新用憑證，請重新連結');
    const meta = await s8Metadata(env);
    const data = await s8TokenRequest(env, meta, { grant_type: 'refresh_token', refresh_token: sess.r, client_id: sess.c, resource: s8McpUrl(env) });
    sess = s8SessionFrom(data, sess.c, sess);
    refreshed = await s8Seal(env, sess);
  };
  try {
    if (sess.e < Date.now() + 60 * 1000) await refresh();
    let results;
    try { results = await mcpCallTools(env, sess.a, [{ name: 'auth_me' }, { name: 'auth_organizations' }]); }
    catch (e) { if (e.status === 401 && !refreshed) { await refresh(); results = await mcpCallTools(env, sess.a, [{ name: 'auth_me' }, { name: 'auth_organizations' }]); } else throw e; }
    return jsonOk({ ok: true, scope: sess.s, me: results.auth_me, organizations: results.auth_organizations, session: refreshed }, request, env);
  } catch (e) {
    return jsonError(e.status === 401 ? 401 : 502, e.message || '無法呼叫 S8', request, env);
  }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    const path = new URL(request.url).pathname;
    if (path === '/lab-auth') return handleLabAuth(request, env);
    if (path === '/lab-ping') return handleLabPing(request, env);
    if (path === '/s8/login-start') return handleS8LoginStart(request, env);
    if (path === '/s8/callback') return handleS8Callback(request, env);
    if (path === '/s8/status') return handleS8Status(request, env);
    if (path === '/s8/tools') return handleS8Tools(request, env);
    if (path === '/s8/audience') return handleS8Audience(request, env);
    if (request.method !== 'GET') return jsonError(405, '只支援 GET', request, env);

    const articleParam = new URL(request.url).searchParams.get('url');
    if (!articleParam) return jsonError(400, '缺少 url 參數', request, env);
    let article;
    try { article = new URL(articleParam); } catch { return jsonError(400, '文章網址格式不正確', request, env); }
    const httpOk = env && env.ALLOW_HTTP === '1';   // only for local testing
    if (article.protocol !== 'https:' && !(httpOk && article.protocol === 'http:')) return jsonError(400, '只允許 https 網址', request, env);
    if (!hostAllowed(article.hostname, env)) return jsonError(403, `文章網域不在允許名單：${article.hostname}`, request, env);

    let html;
    try {
      const res = await fetch(article.href, { headers: FETCH_HEADERS, redirect: 'follow' });
      if (!res.ok) return jsonError(502, `文章網頁回應 ${res.status}`, request, env);
      html = await res.text();
    } catch (e) {
      return jsonError(502, '抓不到文章網頁', request, env);
    }

    let imageUrl;
    try { imageUrl = extractFirstImage(html, article.href); } catch { imageUrl = ''; }
    if (!imageUrl) return jsonError(404, '文章裡找不到圖片', request, env);
    const img = new URL(imageUrl);
    if (img.protocol !== 'https:' && !(httpOk && img.protocol === 'http:')) return jsonError(400, '圖片不是 https 網址', request, env);
    if (!hostAllowed(img.hostname, env)) return jsonError(403, `圖片網域不在允許名單：${img.hostname}`, request, env);

    let imgRes;
    try {
      imgRes = await fetch(img.href, { headers: { ...FETCH_HEADERS, Referer: article.href }, redirect: 'follow' });
    } catch (e) {
      return jsonError(502, '抓不到圖片', request, env);
    }
    if (!imgRes.ok) return jsonError(502, `圖片回應 ${imgRes.status}`, request, env);
    const type = (imgRes.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
    if (!type.startsWith('image/')) return jsonError(502, '抓到的不是圖片檔', request, env);
    const buf = await imgRes.arrayBuffer();
    if (buf.byteLength > MAX_IMAGE_BYTES) return jsonError(413, '圖片太大（超過 15MB）', request, env);

    return new Response(buf, {
      status: 200,
      headers: {
        'Content-Type': type,
        'Cache-Control': 'public, max-age=3600',
        'X-Image-Url': img.href,
        ...corsHeaders(request, env),
      },
    });
  },
};
