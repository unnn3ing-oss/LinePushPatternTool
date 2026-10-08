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
//   POST /s8/login-start  → 取得 S8 授權頁網址（請求 insightark-mcp:read＋write 範圍，一次授權）
//   GET  /s8/callback     → S8 授權完成後跳回這裡，換取憑證、加密後交還網頁
//   POST /s8/status       → 用憑證呼叫 auth_me、auth_organizations（唯讀）
//   POST /s8/audience     → 試算「全部 LINE 顧客」可發送人數（broadcast_audience_preview，唯讀；組織與參數都由 Worker 固定）
//   POST /s8/prepare      → （需 write 授權）上傳兩張圖到 S8、產生 S8 預覽網址，並封存要建立的內容
//   POST /s8/create       → （需 write 授權）重新試算人數後建立群發，先以「建立當下 + 24 小時」排程；body.mode 只接受 'draft'（預設，立刻暫停成草稿）或 'schedule'（明確選擇不暫停、保留 +1 天排程，改用 broadcast_get 確認狀態）；絕不立即發送，沒有 resume／sendNow
//   POST /s8/pause        → 把排程暫停成草稿（broadcast_update 只允許 pause，沒有 resume／立即發送）
//   POST /s8/tools        → 列出 S8 工具的名稱與欄位定義（MCP tools/list，唯讀，不執行任何工具）
// 另有「LINE 官方帳號直連」（試驗，使用者已授權；預設只允許測試帳號）：POST /line/status、/line/prepare、/line/validate、/line/send、/line/clicks 與公開的 GET /line-img/<id>/<寬度>，說明見下方該段與 worker/README.md。
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
// 連結一律請求 read＋write；但只有通過把關（s8Guard）的幾個工具與固定參數才會送出，沒有立即發送、resume 或 sendNow 的路徑。唯讀工具另有 S8_READ_TOOLS 白名單。
const S8_BASE_DEFAULT = 'https://api-next.no8.io';
const S8_SCOPE_READ = 'insightark-mcp:read';
const S8_SCOPE_WRITE = 'insightark-mcp:read insightark-mcp:write';
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

async function s8Register(env, meta, redirectUri, scope = S8_SCOPE_READ) {
  const r = await fetch(meta.registration_endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: S8_CLIENT_NAME, redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'], token_endpoint_auth_method: 'none', scope,
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
    // 連結一律要 read + write（避免反覆授權）。網頁會記住「帶 write 的用戶端 id」重複使用；沒有才向 S8 註冊一個新的。
    // 舊版的 upgrade 參數仍接受但已無作用。
    const scope = S8_SCOPE_WRITE;
    let clientId = typeof body.clientId === 'string' && /^[\w.~-]{1,200}$/.test(body.clientId) ? body.clientId : '';
    let registered = false;
    if (!clientId) { clientId = await s8Register(env, meta, redirectUri, scope); registered = true; }
    const verifier = randomB64Url(48);
    const state = await s8Seal(env, { v: verifier, c: clientId, u: returnUrl, ru: redirectUri, sc: scope, x: Date.now() + S8_STATE_TTL_MS });
    const url = new URL(meta.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope, state,
      code_challenge: await pkceChallenge(verifier), code_challenge_method: 'S256', resource: s8McpUrl(env),
    }).toString();
    return jsonOk({ authorizeUrl: url.href, clientId, registered, scope }, request, env);
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
    const sessObj = s8SessionFrom(data, state.c);
    if (!data.scope && state.sc) sessObj.s = state.sc;
    const session = await s8Seal(env, sessObj);
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
// ---- 工具白名單與參數把關（階段三：只建立草稿）----
// 唯讀工具任何時候都可呼叫；其餘工具只有在「有 write 授權」且參數通過下面的把關時才會送出。
// 程式裡沒有任何路徑能呼叫 resume、sendNow，也沒有省略 scheduleAt 的建立。
// 排程時間：draft 模式固定為建立當下 +24 小時（建立後立刻暫停）；schedule 模式由使用者指定（台北時間，到分鐘），
// 但 Worker 強制必須落在「建立當下 +30 分鐘 ～ +7 天」之間；任何情況都不可能立即發送，也沒有 resume／sendNow。
const S8_STAGE3_TOOLS = new Set(['media_upload_url', 'messaging_message_preview', 'broadcast_create', 'broadcast_get', 'broadcast_update']);
const S8_FIXED_RECIPIENTS = { where: { platforms: ['line'] } };   // 全部 LINE 顧客，不加任何其他條件
const S8_USER_MIN_MS = 30 * 60 * 1000;                            // 使用者指定的排程時間：至少在 30 分鐘之後
const S8_USER_MAX_MS = 7 * 24 * 60 * 60 * 1000;                   // 使用者指定的排程時間：最多 7 天之內
const S8_MIN_LEAD_MS = 25 * 60 * 1000;                            // 把關層的下限（比上面稍寬，容許建立過程中的幾分鐘延遲）
const S8_MAX_LEAD_MS = S8_USER_MAX_MS + 60 * 60 * 1000;           // 把關層的上限
const keysOf = o => Object.keys(o || {}).sort().join(',');
function s8Guard(name, args, canWrite, now = Date.now()) {
  if (S8_READ_TOOLS.has(name)) return;
  if (!canWrite || !S8_STAGE3_TOOLS.has(name)) throw new Error(`工具 ${name} 不在允許名單內`);
  const fail = why => { throw new Error(`${name} 參數被擋下：${why}`); };
  const a = args || {};
  if (name === 'broadcast_update') {
    if (keysOf(a) !== 'action,orgId,taskId' || a.action !== 'pause') fail('只允許 {orgId, taskId, action:"pause"}');
  } else if (name === 'broadcast_get') {
    if (keysOf(a) !== 'orgId,taskId') fail('只允許 {orgId, taskId}');
  } else if (name === 'media_upload_url') {
    if (keysOf(a) !== 'contentType,filename,orgId,purpose' || a.contentType !== 'image/png' || a.purpose !== 'imagemap') fail('只允許上傳 image/png（purpose=imagemap）');
  } else if (name === 'messaging_message_preview') {
    if (keysOf(a) !== 'messages,orgId,platform' || a.platform !== 'line') fail('只允許 {orgId, platform:"line", messages}');
    s8CheckMessages(a.messages, fail);
  } else if (name === 'broadcast_create') {
    if (keysOf(a) !== 'messages,orgId,platform,previewRef,recipients,scheduleAt') fail('只允許 {orgId, platform, recipients, previewRef, messages, scheduleAt}');
    if (a.platform !== 'line') fail('平台只能是 line');
    if (JSON.stringify(a.recipients) !== JSON.stringify(S8_FIXED_RECIPIENTS)) fail('發送對象只能是全部 LINE 顧客（不加條件）');
    if (typeof a.previewRef !== 'string' || !a.previewRef) fail('缺少 previewRef');
    if (typeof a.scheduleAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/.test(a.scheduleAt)) fail('scheduleAt 必須是台北時間（+08:00）的 RFC 3339 格式，且不可省略');
    const at = Date.parse(a.scheduleAt);
    if (!(at >= now + S8_MIN_LEAD_MS)) fail('scheduleAt 必須在 25 分鐘之後（不得立即發送）');
    if (!(at <= now + S8_MAX_LEAD_MS)) fail('scheduleAt 不可超過 7 天');
    s8CheckMessages(a.messages, fail);
  }
}
function s8CheckMessages(messages, fail) {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 5) fail('訊息數量必須是 1 到 5 則');
  for (const m of messages) {
    if (!m || m.contentType !== 'application/x-template' || !m.data || m.data.templateType !== 'imagemap') fail('只允許圖文訊息（imagemap）');
    if (typeof m.data.altText !== 'string' || !m.data.altText.trim()) fail('缺少推播通知（altText）');
    const els = m.data.elements;
    if (!Array.isArray(els) || els.length !== 1) fail('imagemap 必須剛好一個 element');
    const el = els[0];
    if (typeof el.imageUrl !== 'string' || !/^https:\/\/\S+$/.test(el.imageUrl)) fail('圖片網址必須是 https');
    if (!Array.isArray(el.buttons) || !el.buttons.length) fail('缺少點擊區塊');
    for (const b of el.buttons) if (b.type !== 'url' || typeof b.data !== 'string' || !/^https?:\/\/\S+$/.test(b.data)) fail('點擊區塊只允許網址連結');
  }
}

function parseToolResult(r) {
  const res = r.body.result || {};
  const text = (res.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n');
  let parsed = res.structuredContent;
  if (parsed === undefined) { try { parsed = JSON.parse(text); } catch { parsed = text; } }
  return { isError: !!res.isError, data: parsed };
}

// 開一個 MCP 連線，之後可連續呼叫多個工具（每次呼叫都先過 s8Guard）。
async function mcpOpen(env, token, canWrite = false) {
  const init = await mcpRpc(env, token, '', 1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'line-push-pattern-tool', version: '1' } });
  if (!init.body || init.body.error) throw new Error(`MCP 初始化失敗：${(init.body && init.body.error && init.body.error.message) || init.status}`);
  const sid = init.sid;
  await mcpRpc(env, token, sid, null, 'notifications/initialized', {}).catch(() => {});
  let n = 2;
  return {
    async call(name, args) {
      s8Guard(name, args, canWrite);
      const r = await mcpRpc(env, token, sid, n++, 'tools/call', { name, arguments: args || {} });
      if (!r.body || r.body.error) throw new Error(`${name} 失敗：${(r.body && r.body.error && r.body.error.message) || r.status}`);
      return parseToolResult(r);
    },
  };
}
async function mcpCallTools(env, token, calls) {
  const mcp = await mcpOpen(env, token, false);
  const out = {};
  for (const c of calls) out[c.name] = await mcp.call(c.name, c.args || {});
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

// ---- 階段三：上傳圖片、預覽、建立草稿 ----
const S8_PREPARE_TTL_MS = 20 * 60 * 1000;
const S8_MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const taipeiIso = ms => new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 19) + '+08:00';
const toolText = r => (typeof r.data === 'string' ? r.data : JSON.stringify(r.data)).slice(0, 600);
const walkStrings = (o, path = '', out = []) => { if (typeof o === 'string') out.push([path, o]); else if (o && typeof o === 'object') for (const k of Object.keys(o)) walkStrings(o[k], `${path}.${k}`, out); return out; };

// media_upload_url 的回傳欄位名稱文件沒寫，這裡寬鬆解析；對不上就整段回報，不猜。
function pickUploadInfo(data, allowHttp = false) {
  const urls = walkStrings(data).filter(([, v]) => (allowHttp ? /^https?:\/\/\S+$/ : /^https:\/\/\S+$/).test(v));
  const up = urls.find(([k]) => /upload|presign|put|signed/i.test(k)) || (urls.length === 1 ? urls[0] : null);
  if (!up) return null;
  const rest = urls.filter(x => x !== up);
  const asset = (rest.find(([k, v]) => /asset|public|final|download|cdn|file|image|url/i.test(k) || /assets\.no8\.io/.test(v)) || [null, up[1].split('?')[0]])[1];
  let headers = {};
  const h = walkStrings(data).filter(([k]) => /headers\./i.test(k));
  for (const [k, v] of h) headers[k.split('.').pop()] = v;
  return { uploadUrl: up[1], assetUrl: asset, headers };
}

async function s8LoadSession(request, env) {
  let sess = await s8Open(env, request.headers.get('X-S8-Session'));
  if (!sess || !sess.a) return { error: jsonError(401, '尚未連結 S8（或連結資料無效），請重新連結', request, env) };
  let refreshed = null;
  if (sess.e < Date.now() + 60 * 1000) {
    if (!sess.r) return { error: jsonError(401, '憑證已過期，請重新連結', request, env) };
    const meta = await s8Metadata(env);
    const data = await s8TokenRequest(env, meta, { grant_type: 'refresh_token', refresh_token: sess.r, client_id: sess.c, resource: s8McpUrl(env) });
    sess = s8SessionFrom(data, sess.c, sess);
    refreshed = await s8Seal(env, sess);
  }
  return { sess, refreshed };
}
const s8HasWrite = sess => /insightark-mcp:write/.test(sess.s || '');

async function s8ResolveOrg(mcp, orgKey) {
  const name = S8_ORG_NAMES[orgKey];
  if (!name) throw badInput('org 只能是 news 或 ent');
  const r = await mcp.call('auth_organizations', {});
  const org = ((r.data && r.data.organizations) || []).find(o => o.displayName === name);
  if (!org || !org.id) throw new Error(`S8 帳號下找不到組織「${name}」`);
  return org;
}
async function s8AudienceTotal(mcp, orgId) {
  const r = await mcp.call('broadcast_audience_preview', { orgId, platform: 'line', recipients: S8_FIXED_RECIPIENTS, includeSample: false });
  const total = r.data && r.data.total;
  if (r.isError || !Number.isFinite(total) || !r.data.previewRef) throw new Error(`試算人數失敗：${toolText(r)}`);
  return { total, previewRef: r.data.previewRef };
}

function s8BuildMessages(pages, altText, imageUrls) {
  return pages.map((pg, i) => ({
    contentType: 'application/x-template',
    data: {
      templateType: 'imagemap', altText,
      elements: [{
        title: String(pg.title || `第${i + 1}則`).slice(0, 60), imageUrl: imageUrls[i], size: { width: pg.width, height: pg.height }, messageTemplateType: 'ImagemapTemplate1',
        buttons: pg.buttons.map((b, j) => ({ title: String(b.title || `項目${j + 1}`).slice(0, 40), type: 'url', data: b.url, tags: [], x: b.x, y: b.y, width: b.width, height: b.height })),
      }],
    },
  }));
}
const PCT = /^(?:100(?:\.0{1,2})?|(?:0|[1-9]\d?)(?:\.\d{1,2})?)%$/;
const PCT_POS = /^(?:100(?:\.0{1,2})?|(?:0?\.(?:0[1-9]|[1-9]\d?)|[1-9]\d?(?:\.\d{1,2})?))%$/;
const badInput = msg => Object.assign(new Error(msg), { status: 400 });
function s8ValidatePages(pages) {
  if (!Array.isArray(pages) || pages.length < 1 || pages.length > 2) throw badInput('頁數必須是 1 到 2');
  for (const pg of pages) {
    if (!(pg.width === 1040 && (pg.height === 800 || pg.height === 1040))) throw badInput('圖片尺寸必須是 1040×800 或 1040×1040');
    if (!Array.isArray(pg.buttons) || pg.buttons.length < 1 || pg.buttons.length > 6) throw badInput('每頁點擊區塊必須是 1 到 6 個');
    for (const b of pg.buttons) {
      if (typeof b.url !== 'string' || !/^https?:\/\/\S+$/.test(b.url) || b.url.length > 2000) throw badInput('連結格式不正確');
      if (!PCT.test(b.x) || !PCT.test(b.y) || !PCT_POS.test(b.width) || !PCT_POS.test(b.height)) throw badInput('點擊區塊座標格式不正確');
    }
  }
}

async function handleS8Prepare(request, env) {
  if (request.method !== 'POST') return jsonError(405, '只支援 POST', request, env);
  const denied = await requireLab(request, env); if (denied) return denied;
  let body;
  try { const raw = await request.text(); if (raw.length > 12 * 1024 * 1024) return jsonError(413, '內容太大', request, env); body = JSON.parse(raw); } catch { return jsonError(400, '格式不正確', request, env); }
  try {
    const loaded = await s8LoadSession(request, env); if (loaded.error) return loaded.error;
    const { sess, refreshed } = loaded;
    if (!s8HasWrite(sess)) return jsonError(403, '目前只有唯讀授權，請在「S8」視窗按「連結 S8」重新授權一次', request, env);
    const altText = typeof body.altText === 'string' ? body.altText.trim().slice(0, 400) : '';
    if (!altText) return jsonError(400, '缺少推播通知文字', request, env);
    s8ValidatePages(body.pages);
    const images = Array.isArray(body.images) ? body.images : [];
    if (images.length !== body.pages.length) return jsonError(400, '圖片數量和頁數不一致', request, env);
    const mcp = await mcpOpen(env, sess.a, true);
    const org = await s8ResolveOrg(mcp, body.org);
    const { total } = await s8AudienceTotal(mcp, org.id);
    // 上傳圖片
    const imageUrls = [];
    for (let i = 0; i < images.length; i++) {
      const bytes = Uint8Array.from(atob(String(images[i] || '')), c => c.charCodeAt(0));
      if (!bytes.length || bytes.length >= S8_MAX_IMAGE_BYTES) return jsonError(400, `第 ${i + 1} 張圖片大小不符（必須小於 2MB）`, request, env);
      if (!(bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)) return jsonError(400, `第 ${i + 1} 張不是 PNG`, request, env);
      const up = await mcp.call('media_upload_url', { orgId: org.id, filename: `${String(body.name || 'push').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'push'}_p${i + 1}.png`, contentType: 'image/png', purpose: 'imagemap' });
      if (up.isError) throw new Error(`取得上傳網址失敗：${toolText(up)}`);
      const info = pickUploadInfo(up.data, !!(env && env.ALLOW_HTTP === '1'));   // 正式環境只收 https（ALLOW_HTTP 只給本機測試）
      if (!info) throw new Error(`看不懂 media_upload_url 的回應，請把這段貼給維護者：${toolText(up)}`);
      const put = await fetch(info.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/png', ...info.headers }, body: bytes });
      if (!put.ok) throw new Error(`上傳圖片失敗（${put.status}）`);
      imageUrls.push(info.assetUrl);
    }
    const messages = s8BuildMessages(body.pages, altText, imageUrls);
    const prev = await mcp.call('messaging_message_preview', { orgId: org.id, platform: 'line', messages });
    if (prev.isError) throw new Error(`產生預覽失敗：${toolText(prev)}`);
    const prepareToken = await s8Seal(env, { t: 'prepare', org: body.org, orgId: org.id, messages, x: Date.now() + S8_PREPARE_TTL_MS });
    return jsonOk({ ok: true, org: { id: org.id, name: org.displayName }, total, preview: prev.data, imageUrls, prepareToken, expiresInMinutes: S8_PREPARE_TTL_MS / 60000, session: refreshed }, request, env);
  } catch (e) {
    return jsonError(e.status === 401 || e.status === 400 ? e.status : 502, e.message || '無法呼叫 S8', request, env);
  }
}

function pickTaskId(data) {
  const found = walkStrings(data).find(([k]) => /(^|\.)(taskId|id|_id)$/i.test(k));
  return found ? found[1] : '';
}
const pickField = (data, re) => { const f = walkStrings(data).find(([k]) => re.test(k)); return f ? f[1] : ''; };

// broadcast_get 的 allowedActions 可能在任何一層（實測第一層找不到），遞迴找；找不到回 null。
function findAllowedActions(o, depth = 0) {
  if (!o || typeof o !== 'object' || depth > 5) return null;
  if (Array.isArray(o.allowedActions)) return o.allowedActions;
  for (const k of Object.keys(o)) { const r = findAllowedActions(o[k], depth + 1); if (r) return r; }
  return null;
}
const snippet = d => { try { return JSON.stringify(d).slice(0, 400); } catch { return ''; } };

async function pauseToDraft(mcp, orgId, taskId) {
  const g1 = await mcp.call('broadcast_get', { orgId, taskId });
  const allowed = findAllowedActions(g1.data);
  // S8 明確回報了「非空的可用動作」卻沒有 pause 才放棄；清單找不到或是空的，仍嘗試 pause（pause 是安全方向，S8 自己會拒絕不合法的狀態）
  if (allowed && allowed.length && !allowed.includes('pause')) return { ok: false, why: `目前不能暫停（allowedActions：${JSON.stringify(allowed)}，狀態：${pickField(g1.data, /(^|\.)(status|phase)$/i)}）`, get: g1.data };
  const upd = await mcp.call('broadcast_update', { orgId, taskId, action: 'pause' });
  if (upd.isError) return { ok: false, why: `暫停失敗：${toolText(upd)}`, get: g1.data };
  const g2 = await mcp.call('broadcast_get', { orgId, taskId });
  const status = pickField(g2.data, /(^|\.)status$/i), phase = pickField(g2.data, /(^|\.)phase$/i);
  const ok = status === 'draft' || phase === 'draft';
  return { ok, why: ok ? undefined : `已送出暫停，但狀態仍是 ${status || phase || '（未知）'}（S8 回傳：${snippet(g2.data)}）`, status, phase, get: g2.data };
}

const S8_CREATE_MODES = new Set(['draft', 'schedule']);   // draft（預設）：建立後立刻暫停成草稿；schedule：使用者明確選擇並指定時間，保留排程
// 檢查使用者指定的排程時間，回傳錯誤文字（沒問題回空字串）：格式、日期真的存在、+30 分鐘 ～ +7 天
function checkUserScheduleAt(v, now = Date.now()) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+08:00$/.test(v)) return '排程時間格式必須是 YYYY-MM-DDTHH:mm:00+08:00（台北時間，到分鐘）';
  const t = Date.parse(v);
  if (!Number.isFinite(t) || taipeiIso(t) !== v) return '排程時間不是有效的日期';
  if (t < now + S8_USER_MIN_MS) return '排程時間必須在 30 分鐘之後（不得立即發送）';
  if (t > now + S8_USER_MAX_MS) return '排程時間最多只能設在 7 天之內';
  return '';
}
async function handleS8Create(request, env) {
  if (request.method !== 'POST') return jsonError(405, '只支援 POST', request, env);
  const denied = await requireLab(request, env); if (denied) return denied;
  let body = {};
  try { body = JSON.parse((await request.text()) || '{}'); } catch { return jsonError(400, '格式不正確', request, env); }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return jsonError(400, '格式不正確', request, env);
  const mode = body.mode === undefined ? 'draft' : body.mode;
  if (typeof mode !== 'string' || !S8_CREATE_MODES.has(mode)) return jsonError(400, "mode 只能是 'draft' 或 'schedule'。沒有建立任何東西。", request, env);
  // schedule 模式的排程時間由使用者指定（台北時間 YYYY-MM-DDTHH:mm:00+08:00，到分鐘）；draft 模式不接受 scheduleAt（固定 +24 小時後立刻暫停）
  let userAt = '';
  if (mode === 'schedule') {
    const bad = checkUserScheduleAt(body.scheduleAt);
    if (bad) return jsonError(400, `${bad}。沒有建立任何東西。`, request, env);
    userAt = body.scheduleAt;
  } else if (body.scheduleAt !== undefined) return jsonError(400, "只有 mode:'schedule' 才能指定 scheduleAt。沒有建立任何東西。", request, env);
  const prep = await s8Open(env, body.prepareToken);
  if (!prep || prep.t !== 'prepare' || !prep.x || prep.x < Date.now()) return jsonError(400, '預覽已過期或無效，請重新「上傳並產生預覽」', request, env);
  let created = null;
  try {
    const loaded = await s8LoadSession(request, env); if (loaded.error) return loaded.error;
    const { sess, refreshed } = loaded;
    if (!s8HasWrite(sess)) return jsonError(403, '目前只有唯讀授權，請在「S8」視窗按「連結 S8」重新授權一次', request, env);
    const mcp = await mcpOpen(env, sess.a, true);
    // 人數確認：重新試算，必須和使用者輸入的人數幾乎一致
    const { total, previewRef } = await s8AudienceTotal(mcp, prep.orgId);
    const typed = Number(body.confirmTotal);
    if (!Number.isFinite(typed) || Math.abs(typed - total) > Math.max(5, Math.round(total * 0.01))) {
      return jsonError(409, `確認人數不符：S8 現在試算是 ${total} 人，你輸入的是 ${body.confirmTotal}。沒有建立任何東西。`, request, env);
    }
    // draft：建立當下 + 24 小時（台北時間），建立後馬上暫停成草稿；schedule：使用者指定的時間（上面已驗證在 +30 分鐘 ～ +7 天），建立後保留排程。
    // 驗證過後經過了 S8 人數試算的時間，這裡再確認一次下限，避免剛好卡在邊界。
    if (mode === 'schedule' && Date.parse(userAt) < Date.now() + S8_MIN_LEAD_MS) return jsonError(409, '排程時間已經太接近現在，請重新設定時間。沒有建立任何東西。', request, env);
    const scheduleAt = mode === 'schedule' ? userAt : taipeiIso(Date.now() + 24 * 3600 * 1000);
    created = await mcp.call('broadcast_create', { orgId: prep.orgId, platform: 'line', recipients: S8_FIXED_RECIPIENTS, previewRef, messages: prep.messages, scheduleAt });
    if (created.isError) throw new Error(`建立失敗：${toolText(created)}`);
    const taskId = pickTaskId(created.data);
    if (!taskId) return jsonOk({ ok: false, created: true, mode, warning: `群發已建立（排程在 ${scheduleAt}），但我找不到 taskId，無法自動${mode === 'schedule' ? '確認狀態' : '暫停'}。它會在 ${scheduleAt} 實際發送，請立即到 Super 8 Console 暫停或刪除這筆群發！`, scheduleAt, total, raw: created.data, session: refreshed }, request, env);
    if (mode === 'schedule') {
      // 保留排程：不呼叫 broadcast_update，只用 broadcast_get（唯讀）確認狀態與可用動作
      const g = await mcp.call('broadcast_get', { orgId: prep.orgId, taskId });
      if (g.isError) return jsonOk({ ok: false, created: true, mode, taskId, warning: `群發已建立並保留排程，但讀取狀態失敗（${toolText(g)}）。它會在 ${scheduleAt} 實際發送給 ${total} 人，請到 Super 8 Console 確認，或按「暫停成草稿」。`, scheduleAt, total, orgId: prep.orgId, session: refreshed }, request, env);
      const allowedActions = findAllowedActions(g.data) || [];
      return jsonOk({ ok: true, mode: 'schedule', taskId, scheduleAt, status: pickField(g.data, /(^|\.)status$/i), phase: pickField(g.data, /(^|\.)phase$/i), allowedActions, total, orgId: prep.orgId, session: refreshed }, request, env);
    }
    const paused = await pauseToDraft(mcp, prep.orgId, taskId);
    if (!paused.ok) return jsonOk({ ok: false, created: true, mode, taskId, warning: `群發已建立，但沒有成功暫停成草稿（${paused.why || '狀態：' + paused.status}）。它仍排在 ${scheduleAt} 發送，請立即到 Super 8 Console 暫停或刪除，或按「重試暫停」。`, scheduleAt, total, session: refreshed }, request, env);
    return jsonOk({ ok: true, mode: 'draft', taskId, status: paused.status, phase: paused.phase, scheduledWas: scheduleAt, total, orgId: prep.orgId, session: refreshed }, request, env);
  } catch (e) {
    const extra = created && !created.isError ? `（注意：群發可能已建立，請到 Console 確認：${toolText(created)}）` : '';
    return jsonError(e.status === 401 ? 401 : 502, `${e.message || '無法呼叫 S8'}${extra}`, request, env);
  }
}

async function handleS8Pause(request, env) {
  if (request.method !== 'POST') return jsonError(405, '只支援 POST', request, env);
  const denied = await requireLab(request, env); if (denied) return denied;
  let body = {};
  try { body = JSON.parse((await request.text()) || '{}'); } catch { return jsonError(400, '格式不正確', request, env); }
  if (typeof body.taskId !== 'string' || !/^[\w-]{6,64}$/.test(body.taskId)) return jsonError(400, 'taskId 格式不正確', request, env);
  try {
    const loaded = await s8LoadSession(request, env); if (loaded.error) return loaded.error;
    const { sess, refreshed } = loaded;
    if (!s8HasWrite(sess)) return jsonError(403, '目前只有唯讀授權，請在「S8」視窗按「連結 S8」重新授權一次', request, env);
    const mcp = await mcpOpen(env, sess.a, true);
    const org = await s8ResolveOrg(mcp, body.org);
    const paused = await pauseToDraft(mcp, org.id, body.taskId);
    return jsonOk({ ok: paused.ok, taskId: body.taskId, status: paused.status, phase: paused.phase, why: paused.why, session: refreshed }, request, env);
  } catch (e) {
    return jsonError(e.status === 401 || e.status === 400 ? e.status : 502, e.message || '無法呼叫 S8', request, env);
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

// ===========================================================================
// LINE 官方帳號直連（試驗）：準備、檢查，以及（使用者已授權）對「全部好友」broadcast。沒有排程、沒有草稿：發送成功就是已經發出。
//   POST /line/status    → 檢查帳號（名稱、好友數、本月額度與已用）— 全部唯讀
//   POST /line/prepare   → 把每頁 1040 寬的圖片存進 R2（綁定名稱 LINE_IMG），封存要用的內容（30 分鐘有效）
//   POST /line/validate  → 把準備好的內容交給 LINE 的 validate/broadcast 檢查格式（只檢查，不會發送）
//   POST /line/clicks    → 用發送時的 request id 查這次群發每個連結的點擊次數／人數（唯讀）
//   POST /line/schedule/create｜list｜update｜cancel → 排程推播（Worker 自己排，需 R2 與 Cron Trigger，見下方「排程推播」）
//   POST /line/send      → validate 通過後發送。測試帳號：multicast 給「測試名單」勾選的人（每次最多 2 位，不 broadcast）；正式帳號：broadcast 給全部好友，要 LINE_ALLOW_OFFICIAL=1＋先成功發過測試帳號＋輸入好友數
//   GET  /line-img/<id>/<寬度> → 公開提供圖片給 LINE 伺服器抓（imagemap 規定的 baseUrl/{240,300,460,700,1040}，網址不能有副檔名；五種寬度都回同一張 1040）
// 憑證放 Worker Secret：LINE_CHANNEL_ID_TEST / LINE_CHANNEL_SECRET_TEST（測試帳號）、
//   LINE_CHANNEL_ID_NEWS / _SECRET_NEWS、LINE_CHANNEL_ID_ENT / _SECRET_ENT（正式帳號）。
// 每次呼叫現場用 channel ID＋secret 換 15 分鐘的 stateless token（可無限發行、不會讓別人（例如 S8）的 token 失效），不存任何 token。
// ===========================================================================
const LINE_API = 'https://api.line.me';
const LINE_CHANNEL_SUFFIX = { test: 'TEST', news: 'NEWS', ent: 'ENT' };
const LINE_IMG_WIDTHS = [240, 300, 460, 700, 1040];
const LINE_PREPARE_TTL_MS = 30 * 60 * 1000;
const LINE_MAX_IMG_BYTES = 10 * 1024 * 1024;   // LINE 上限是 10MB
// Worker 只能對 LINE 做這幾件事（方法＋路徑），其他一律不給：沒有 push／narrowcast、沒有改頻道設定、沒有重發長效 token。
// multicast（只發給名單內指定的人）、reply（回覆登記訊息，不計額度）、profile（查登記者暱稱）只允許測試帳號用（見 LINE_TEST_ONLY）。
const LINE_ALLOWED_CALLS = [
  /^POST \/oauth2\/v3\/token$/,
  /^GET \/v2\/bot\/info$/,
  /^GET \/v2\/bot\/message\/quota$/,
  /^GET \/v2\/bot\/message\/quota\/consumption$/,
  /^GET \/v2\/bot\/insight\/followers$/,
  /^POST \/v2\/bot\/message\/validate\/broadcast$/,
  /^POST \/v2\/bot\/message\/broadcast$/,   // 只有 handleLineSend 會用到
  /^GET \/v2\/bot\/insight\/message\/event$/,   // 查某次群發的開啟／點擊統計（唯讀）
  /^POST \/v2\/bot\/message\/validate\/multicast$/,
  /^POST \/v2\/bot\/message\/multicast$/,
  /^POST \/v2\/bot\/message\/reply$/,
  /^GET \/v2\/bot\/profile\/U[0-9a-f]{32}$/,
];
const LINE_TEST_ONLY = [/^POST \/v2\/bot\/message\/validate\/multicast$/, /^POST \/v2\/bot\/message\/multicast$/, /^POST \/v2\/bot\/message\/reply$/, /^GET \/v2\/bot\/profile\//];
const lineTokenCache = new Map();   // channel key → { id, promise(token), exp }

function lineChannelCreds(env, key) {
  const suf = LINE_CHANNEL_SUFFIX[key];
  if (!suf) throw badInput('channel 只能是 test、news 或 ent');
  const id = env && env[`LINE_CHANNEL_ID_${suf}`], secret = env && env[`LINE_CHANNEL_SECRET_${suf}`];
  if (!id || !secret) throw Object.assign(new Error(`尚未設定 ${suf} 帳號的 LINE_CHANNEL_ID_${suf} / LINE_CHANNEL_SECRET_${suf}（Worker Secret）`), { status: 503 });
  return { id: String(id).trim(), secret: String(secret).trim() };
}
async function lineAccessToken(env, key) {
  const { id, secret } = lineChannelCreds(env, key);
  const hit = lineTokenCache.get(key);
  if (hit && hit.id === id && hit.exp > Date.now() + 60 * 1000) return hit.promise;   // 同時多個請求共用同一次發行（也可能是還在進行中的）
  const promise = (async () => {
    const res = await fetch(`${LINE_API}/oauth2/v3/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }).toString(),
    });
    let data = {}; try { data = await res.json(); } catch { /* not JSON */ }
    if (!res.ok || !data.access_token) throw Object.assign(new Error(`LINE 不接受這組 Channel ID／secret（${res.status} ${data.error_description || data.error || ''}）`.trim()), { status: 502 });
    lineTokenCache.set(key, { id, promise: Promise.resolve(data.access_token), exp: Date.now() + (Number(data.expires_in) || 900) * 1000 });
    return data.access_token;
  })();
  lineTokenCache.set(key, { id, promise, exp: Date.now() + 10 * 60 * 1000 });   // 發行中：先佔位，成功後換成真正的到期時間
  promise.catch(() => { if (lineTokenCache.get(key) && lineTokenCache.get(key).promise === promise) lineTokenCache.delete(key); });
  return promise;
}
// 對 LINE 呼叫一次；不管狀態碼都回 { status, data, requestId }（不丟例外），但方法＋路徑必須在白名單內。
async function lineCall(env, key, method, path, body, extraHeaders) {
  const base = path.split('?')[0];
  const sig = `${method} ${base}`;
  if (!LINE_ALLOWED_CALLS.some(re => re.test(sig))) throw new Error(`不允許的 LINE 呼叫：${sig}`);
  if (key !== 'test' && LINE_TEST_ONLY.some(re => re.test(sig))) throw new Error(`${sig} 只能用在測試帳號`);
  if (key === 'test' && sig === 'POST /v2/bot/message/broadcast') throw new Error('測試帳號不能 broadcast（會發給所有好友、吃掉免費額度），只能用 multicast 發給測試名單內的人');
  const token = await lineAccessToken(env, key);
  const res = await fetch(`${LINE_API}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(extraHeaders || {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {}; const text = await res.text(); try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 300) }; }
  return { status: res.status, data, requestId: res.headers.get('x-line-request-id') || '' };
}
const lineErrText = r => {
  const d = r.data || {};
  const detail = Array.isArray(d.details) && d.details.length ? `（${d.details.map(x => `${x.property || ''} ${x.message || ''}`.trim()).join('；')}）` : '';
  return `LINE 回應 ${r.status}：${d.message || d.raw || '沒有說明'}${detail}`;
};
const lineYesterdayYmd = () => new Date(Date.now() + 8 * 3600e3 - 24 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
const lineStatusCode = e => (e && e.status >= 400 && e.status < 600 ? e.status : 502);

async function lineAccountInfo(env, key) {
  const [info, quota, used, fol] = await Promise.all([
    lineCall(env, key, 'GET', '/v2/bot/info'),
    lineCall(env, key, 'GET', '/v2/bot/message/quota'),
    lineCall(env, key, 'GET', '/v2/bot/message/quota/consumption'),
    lineCall(env, key, 'GET', `/v2/bot/insight/followers?date=${lineYesterdayYmd()}`),
  ]);
  const followers = fol.status === 200 && fol.data && fol.data.status === 'ready' && Number.isFinite(fol.data.followers) ? fol.data : null;
  return {
    bot: info.status === 200 ? { displayName: info.data.displayName || '', basicId: info.data.basicId || '' } : null,
    quota: quota.status === 200 ? { type: quota.data.type || '', value: Number.isFinite(quota.data.value) ? quota.data.value : null } : null,
    used: used.status === 200 && Number.isFinite(used.data.totalUsage) ? used.data.totalUsage : null,
    followers,
    notes: [info, quota, used, fol].filter(r => r.status !== 200).map(lineErrText),
  };
}
async function lineReadBody(request, env, max = 1024 * 1024) {
  try { const raw = await request.text(); if (raw.length > max) return { error: jsonError(413, '內容太大', request, env) }; const b = JSON.parse(raw || '{}'); if (!b || typeof b !== 'object' || Array.isArray(b)) throw 0; return { body: b }; }
  catch { return { error: jsonError(400, '格式不正確', request, env) }; }
}

async function handleLineStatus(request, env) {
  if (request.method !== 'POST') return jsonError(405, '只支援 POST', request, env);
  const denied = await requireLab(request, env); if (denied) return denied;
  const { body, error } = await lineReadBody(request, env); if (error) return error;
  try {
    const info = await lineAccountInfo(env, body.channel);
    return jsonOk({ ok: true, channel: body.channel, r2Ready: !!(env && env.LINE_IMG && typeof env.LINE_IMG.put === 'function'), ...info }, request, env);
  } catch (e) { return jsonError(lineStatusCode(e), e.message || '無法呼叫 LINE', request, env); }
}

const lineHex = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('');
function lineDecodeImage(b64, w) {
  let bytes; try { bytes = Uint8Array.from(atob(String(b64 || '')), c => c.charCodeAt(0)); } catch { throw badInput(`${w}px 圖片不是有效的 base64`); }
  if (!bytes.length || bytes.length > LINE_MAX_IMG_BYTES) throw badInput(`${w}px 圖片大小不符（必須小於 10MB）`);
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const jpg = bytes[0] === 0xff && bytes[1] === 0xd8;
  if (!png && !jpg) throw badInput(`${w}px 圖片必須是 PNG 或 JPEG`);
  return { bytes, type: png ? 'image/png' : 'image/jpeg' };
}
async function handleLinePrepare(request, env) {
  if (request.method !== 'POST') return jsonError(405, '只支援 POST', request, env);
  const denied = await requireLab(request, env); if (denied) return denied;
  const { body, error } = await lineReadBody(request, env, 28 * 1024 * 1024); if (error) return error;
  try {
    if (!env || !env.LINE_IMG || typeof env.LINE_IMG.put !== 'function') throw Object.assign(new Error('Worker 尚未綁定 R2（綁定變數名稱必須是 LINE_IMG），圖片沒地方放。請見 worker/README.md「LINE 直連」'), { status: 503 });
    if (body.org !== 'news' && body.org !== 'ent') throw badInput('org 只能是 news 或 ent');
    const altText = typeof body.altText === 'string' ? body.altText.trim().slice(0, 400) : '';
    if (!altText) throw badInput('缺少推播通知文字');
    s8ValidatePages(body.pages);
    const pages = [];
    for (const pg of body.pages) {
      const imgs = pg.images && typeof pg.images === 'object' ? pg.images : {};
      const { bytes, type } = lineDecodeImage(imgs[1040], 1040);
      const pid = lineHex(16);
      await env.LINE_IMG.put(`line/${pid}/1040`, bytes, { httpMetadata: { contentType: type, cacheControl: 'public, max-age=31536000, immutable' } });
      const px = v => Math.round(parseFloat(v) / 100 * 1040);
      pages.push({
        pid, width: 1040, height: pg.height,
        areas: pg.buttons.map(b => ({ url: b.url, x: px(b.x), y: Math.round(parseFloat(b.y) / 100 * pg.height), width: px(b.width), height: Math.round(parseFloat(b.height) / 100 * pg.height) })),
      });
    }
    const id = lineHex(12);
    const prepareToken = await s8Seal(env, { t: 'line-prepare', id, org: body.org, altText, pages, x: Date.now() + LINE_PREPARE_TTL_MS });
    return jsonOk({ ok: true, id, prepareToken, expiresInMinutes: LINE_PREPARE_TTL_MS / 60000, pages: pages.length }, request, env);
  } catch (e) { return jsonError(lineStatusCode(e), e.message || '準備失敗', request, env); }
}

async function handleLineImage(request, env) {
  const m = new URL(request.url).pathname.match(/^\/line-img\/([0-9a-f]{32})\/(\d{3,4})$/);
  if (!m || !LINE_IMG_WIDTHS.includes(Number(m[2]))) return new Response('not found', { status: 404 });
  if (!env || !env.LINE_IMG || typeof env.LINE_IMG.get !== 'function') return new Response('not configured', { status: 503 });
  const obj = await env.LINE_IMG.get(`line/${m[1]}/1040`);   // 五種寬度的網址都回同一張 1040（LINE 要求五種都要能下載；手機自己縮小）
  if (!obj) return new Response('not found', { status: 404 });
  const type = (obj.httpMetadata && obj.httpMetadata.contentType) || 'image/png';
  return new Response(request.method === 'HEAD' ? null : obj.body, { status: 200, headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' } });
}

// 把準備好的內容組成 LINE 的 imagemap 訊息物件（階段一只拿來做格式檢查）
function lineBuildMessages(prep, origin) {
  return prep.pages.map(pg => ({
    type: 'imagemap', baseUrl: `${origin}/line-img/${pg.pid}`, altText: prep.altText,
    baseSize: { width: 1040, height: pg.height },
    actions: pg.areas.map(a => ({ type: 'uri', linkUri: a.url, area: { x: a.x, y: a.y, width: a.width, height: a.height } })),
  }));
}
async function handleLineValidate(request, env) {
  if (request.method !== 'POST') return jsonError(405, '只支援 POST', request, env);
  const denied = await requireLab(request, env); if (denied) return denied;
  const { body, error } = await lineReadBody(request, env); if (error) return error;
  try {
    const prep = await s8Open(env, body.prepareToken);
    if (!prep || prep.t !== 'line-prepare' || !prep.x || prep.x < Date.now()) throw badInput('準備好的內容已過期或無效，請重新「上傳圖片」');
    const messages = lineBuildMessages(prep, new URL(request.url).origin);
    const v = await lineCall(env, body.channel, 'POST', '/v2/bot/message/validate/broadcast', { messages });
    if (v.status === 200) return jsonOk({ ok: true, valid: true, pages: messages.length, note: '只檢查格式，沒有發送任何東西' }, request, env);
    if (v.status === 400) return jsonOk({ ok: true, valid: false, message: lineErrText(v) }, request, env);
    throw Object.assign(new Error(lineErrText(v)), { status: 502 });
  } catch (e) { return jsonError(lineStatusCode(e), e.message || '檢查失敗', request, env); }
}

// ---- 發送（使用者已明確授權）。預設只允許測試帳號；正式帳號要 Worker 設定 LINE_ALLOW_OFFICIAL=1，且同一份內容先成功發過測試帳號、輸入正確好友數 ----
const LINE_OFFICIAL = new Set(['news', 'ent']);
const LINE_TESTED_TTL_MS = 60 * 60 * 1000;
const LINE_RETRY_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 共用：驗證格式 → 查好友數與額度 → 才 broadcast。任何一關沒過都丟出「沒有發送任何東西」的錯誤。
// approve(friends)：正式帳號的人數把關（立即推播＝使用者輸入的人數；排程＝建立排程時確認過的人數），不通過就丟錯。
async function lineBroadcastNow(env, key, prep, { origin, retryKey, approve }) {
  lineChannelCreds(env, key);
  const official = LINE_OFFICIAL.has(key);
  const messages = lineBuildMessages(prep, origin);
  const v = await lineCall(env, key, 'POST', '/v2/bot/message/validate/broadcast', { messages });
  if (v.status !== 200) throw Object.assign(new Error(`訊息格式沒有通過 LINE 檢查：${lineErrText(v)}。沒有發送任何東西。`), { status: 400 });
  const info = await lineAccountInfo(env, key);
  const friends = info.followers ? info.followers.followers : null;
  if (official) {
    if (friends === null) throw Object.assign(new Error('查不到這個帳號的好友數（LINE 的統計資料還沒好），為了安全正式帳號不發送。沒有發送任何東西。'), { status: 409 });
    if (approve) approve(friends);
  }
  if (info.quota && info.quota.type === 'limited' && info.quota.value !== null && info.used !== null && friends !== null && info.quota.value - info.used < friends) {
    throw Object.assign(new Error(`本月訊息額度不夠：上限 ${info.quota.value}、已用 ${info.used}，這次要發約 ${friends} 則。沒有發送任何東西。`), { status: 409 });
  }
  const sent = await lineCall(env, key, 'POST', '/v2/bot/message/broadcast', { messages }, { 'X-Line-Retry-Key': retryKey });
  if (sent.status !== 200 && sent.status !== 409) throw Object.assign(new Error(`${lineErrText(sent)}。請到 LINE 官方帳號後台確認有沒有發出去。`), { status: 502, lineStatus: sent.status });
  return { requestId: sent.requestId, alreadyAccepted: sent.status === 409, friends, pages: messages.length };
}
// ---- 測試名單：使用者傳「登記」給測試帳號 → webhook 記下 userId；測試推播只用 multicast 發給名單內「勾選的人」（每次最多 2 位）----
const LINE_TESTER_PREFIX = 'testers/';
const LINE_TESTER_MAX_PER_SEND = 2;
const LINE_TESTER_MAX_TOTAL = 50;
const LINE_USER_ID = /^U[0-9a-f]{32}$/;
const LINE_REGISTER_WORDS = new Set(['登記', '加入測試名單']);
// 網頁只看得到 tid（userId 的雜湊前 16 碼），看不到 LINE 的 userId
async function lineTid(userId) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', textEncoder.encode(userId))).slice(0, 8)].map(b => b.toString(16).padStart(2, '0')).join(''); }
async function lineTesterGet(env, tid) {
  if (!/^[0-9a-f]{16}$/.test(String(tid || ''))) return null;
  const o = await lineR2(env).get(`${LINE_TESTER_PREFIX}${tid}.json`);
  if (!o) return null;
  try { return JSON.parse(typeof o.text === 'function' ? await o.text() : textDecoder.decode(o.body)); } catch { return null; }
}
async function lineTesterAll(env) {
  const r = await lineR2(env).list({ prefix: LINE_TESTER_PREFIX, limit: 200 }), out = [];
  for (const o of r.objects || []) { const rec = await lineTesterGet(env, o.key.slice(LINE_TESTER_PREFIX.length, -5)); if (rec) out.push(rec); }
  return out.sort((a, b) => (a.registeredAt || 0) - (b.registeredAt || 0));
}
const lineTesterPublic = r => ({ tid: r.tid, name: r.name || '（沒有暱稱）', registeredAt: r.registeredAt || 0 });
async function lineResolveTesters(env, tids) {
  if (!Array.isArray(tids) || !tids.length) throw badInput('請先選擇測試推播要給誰（至少 1 位）。沒有發送任何東西。');
  if (tids.length > 10) throw badInput('收件人格式不正確。沒有發送任何東西。');
  const uniq = [...new Set(tids.map(String))];
  if (uniq.length > LINE_TESTER_MAX_PER_SEND) throw badInput(`每次測試推播最多只能發給 ${LINE_TESTER_MAX_PER_SEND} 位。沒有發送任何東西。`);
  const recs = [];
  for (const tid of uniq) {
    const rec = await lineTesterGet(env, tid);
    if (!rec) throw badInput('選到的收件人不在測試名單裡（可能已被移除），請重新整理名單再選。沒有發送任何東西。');
    recs.push(rec);
  }
  return recs;
}
// 測試帳號專用：validate → 額度檢查（收件人數）→ multicast 給名單內指定的人。額度算法：LINE 以「收件人數」計（一則訊息有幾頁圖不影響）。
async function lineMulticastTest(env, prep, { origin, retryKey, recs }) {
  lineChannelCreds(env, 'test');
  const messages = lineBuildMessages(prep, origin);
  const v = await lineCall(env, 'test', 'POST', '/v2/bot/message/validate/multicast', { messages });
  if (v.status !== 200) throw Object.assign(new Error(`訊息格式沒有通過 LINE 檢查：${lineErrText(v)}。沒有發送任何東西。`), { status: 400 });
  const info = await lineAccountInfo(env, 'test');
  if (info.quota && info.quota.type === 'limited' && info.quota.value !== null && info.used !== null && info.quota.value - info.used < recs.length) {
    throw Object.assign(new Error(`測試帳號本月訊息額度不夠：上限 ${info.quota.value}、已用 ${info.used}，這次要發 ${recs.length} 位。沒有發送任何東西。`), { status: 409 });
  }
  const sent = await lineCall(env, 'test', 'POST', '/v2/bot/message/multicast', { to: recs.map(r => r.userId), messages }, { 'X-Line-Retry-Key': retryKey });
  if (sent.status !== 200 && sent.status !== 409) throw Object.assign(new Error(`${lineErrText(sent)}。請到 LINE 官方帳號後台確認有沒有發出去。`), { status: 502, lineStatus: sent.status });
  return { requestId: sent.requestId, alreadyAccepted: sent.status === 409, friends: recs.length, recipients: recs.map(r => r.name || '（沒有暱稱）'), pages: messages.length, quota: info.quota && info.quota.value !== null && info.used !== null ? { limit: info.quota.value, used: info.used } : null };
}
// 正式帳號的共同前置條件（立即推播與建立排程都要過）
async function lineOfficialGate(env, key, prep, testToken) {
  if (!env || env.LINE_ALLOW_OFFICIAL !== '1') throw Object.assign(new Error('正式帳號發送尚未開啟（Worker 沒有設定 LINE_ALLOW_OFFICIAL=1）。沒有發送任何東西。'), { status: 403 });
  if (key !== prep.org) throw badInput('這份內容是為另一個版型準備的，不能發到這個正式帳號。沒有發送任何東西。');
  const tested = await s8Open(env, testToken);
  if (!tested || tested.t !== 'line-tested' || tested.id !== prep.id || !tested.x || tested.x < Date.now()) throw badInput('發正式帳號前，同一份內容必須先成功發到測試帳號。沒有發送任何東西。');
}
const lineTypedApprove = typed => friends => {
  const n = Number(typed);
  if (!Number.isFinite(n) || Math.abs(n - friends) > Math.max(50, Math.round(friends * 0.02))) throw Object.assign(new Error(`確認人數不符：LINE 回報好友數約 ${friends} 人，你輸入的是 ${typed}。沒有發送任何東西。`), { status: 409 });
};
async function lineOpenPrep(env, token, what = '發送') {
  const prep = await s8Open(env, token);
  if (!prep || prep.t !== 'line-prepare' || !prep.x || prep.x < Date.now()) throw badInput(`準備好的內容已過期或無效，請重新「傳送資料」。沒有${what}任何東西。`);
  return prep;
}
async function handleLineSend(request, env) {
  if (request.method !== 'POST') return jsonError(405, '只支援 POST', request, env);
  const denied = await requireLab(request, env); if (denied) return denied;
  const { body, error } = await lineReadBody(request, env); if (error) return error;
  try {
    const key = body.channel;
    if (!LINE_CHANNEL_SUFFIX[key]) throw badInput('channel 只能是 test、news 或 ent');
    if (typeof body.retryKey !== 'string' || !LINE_RETRY_KEY.test(body.retryKey)) throw badInput('缺少 retryKey（UUID），用來避免重複發送。沒有發送任何東西。');
    const prep = await lineOpenPrep(env, body.prepareToken);
    const official = LINE_OFFICIAL.has(key);
    if (official) await lineOfficialGate(env, key, prep, body.testToken);
    const origin = new URL(request.url).origin;
    const r = official
      ? await lineBroadcastNow(env, key, prep, { origin, retryKey: body.retryKey, approve: lineTypedApprove(body.confirmTotal) })
      : await lineMulticastTest(env, prep, { origin, retryKey: body.retryKey, recs: await lineResolveTesters(env, body.testers) });
    const out = { ok: true, channel: key, official, sentAt: taipeiIso(Date.now()), requestId: r.requestId, retryKey: body.retryKey, alreadyAccepted: r.alreadyAccepted, friends: r.friends, pages: r.pages };
    if (!official) { out.recipients = r.recipients; out.quota = r.quota; }
    if (!official) out.testToken = await s8Seal(env, { t: 'line-tested', id: prep.id, x: Date.now() + LINE_TESTED_TTL_MS });
    return jsonOk(out, request, env);
  } catch (e) { return jsonError(lineStatusCode(e), e.message || '發送失敗', request, env); }
}

// ===========================================================================
// 測試名單（只有測試帳號）
//   POST /line/webhook         LINE 呼叫的 webhook（要在測試帳號的 Developers Console 設定，並開啟 Use webhook）。不需要試驗功能憑證，改驗 X-Line-Signature。
//                              使用者傳「登記」→ 記下 userId＋暱稱（回覆「已加入測試名單」，reply 不計額度）；加好友或傳別的字 → 回覆提示；封鎖／刪除好友 → 自動從名單移除
//   POST /line/testers/list    查看名單（只回 tid＋暱稱，不給網頁 LINE userId）
//   POST /line/testers/remove  從名單移除
// 新聞／娛樂帳號的 webhook 屬於 S8，這裡完全不碰。
// ===========================================================================
async function lineVerifySignature(secret, rawBytes, sigB64) {
  let sig; try { sig = Uint8Array.from(atob(String(sigB64 || '')), c => c.charCodeAt(0)); } catch { return false; }
  if (!sig.length) return false;
  const key = await crypto.subtle.importKey('raw', textEncoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('HMAC', key, sig, rawBytes);
}
async function lineReply(env, replyToken, text) {
  if (!replyToken) return;
  const r = await lineCall(env, 'test', 'POST', '/v2/bot/message/reply', { replyToken, messages: [{ type: 'text', text }] });
  if (r.status !== 200) console.error('line reply failed', r.status);
}
async function lineHandleEvent(env, ev) {
  const userId = ev && ev.source && ev.source.type === 'user' ? ev.source.userId : '';
  if (!LINE_USER_ID.test(String(userId || ''))) return;
  const tid = await lineTid(userId), key = `${LINE_TESTER_PREFIX}${tid}.json`, r2 = lineR2(env);
  if (ev.type === 'unfollow') { await r2.delete(key); return; }
  if (ev.type === 'follow') { await lineReply(env, ev.replyToken, '這是測試帳號。要加入測試名單，請傳送「登記」。'); return; }
  if (ev.type !== 'message' || !ev.message || ev.message.type !== 'text') return;
  if (!LINE_REGISTER_WORDS.has(String(ev.message.text || '').trim())) { await lineReply(env, ev.replyToken, '要加入測試名單，請傳送「登記」。'); return; }
  const old = await lineTesterGet(env, tid);
  if (!old && (await lineTesterAll(env)).length >= LINE_TESTER_MAX_TOTAL) { await lineReply(env, ev.replyToken, `測試名單已滿（${LINE_TESTER_MAX_TOTAL} 人），請聯絡管理者。`); return; }
  let name = old ? old.name : '';
  const pr = await lineCall(env, 'test', 'GET', `/v2/bot/profile/${userId}`);
  if (pr.status === 200 && pr.data && pr.data.displayName) name = String(pr.data.displayName).slice(0, 40);
  const rec = { tid, userId, name, registeredAt: old ? old.registeredAt : Date.now(), updatedAt: Date.now() };
  await r2.put(key, JSON.stringify(rec), { httpMetadata: { contentType: 'application/json' } });
  await lineReply(env, ev.replyToken, `已${old ? '更新' : '加入'}測試名單${name ? `：${name}` : ''}。之後在推播工具選你的名字，測試推播就只會傳給你。`);
}
async function handleLineWebhook(request, env) {
  const plain = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
  if (request.method !== 'POST') return plain(405, { error: '只支援 POST' });
  let secret; try { secret = lineChannelCreds(env, 'test').secret; } catch (e) { return plain(e.status || 503, { error: e.message }); }
  const raw = await request.arrayBuffer();
  if (raw.byteLength > 1024 * 1024) return plain(413, { error: '內容太大' });
  if (!(await lineVerifySignature(secret, new Uint8Array(raw), request.headers.get('x-line-signature')))) return plain(401, { error: '簽章不正確' });
  let body; try { body = JSON.parse(textDecoder.decode(raw)); } catch { return plain(400, { error: '格式不正確' }); }
  const events = Array.isArray(body && body.events) ? body.events.slice(0, 20) : [];   // 按 Verify 時 events 是空陣列，直接回 200
  for (const ev of events) { try { await lineHandleEvent(env, ev); } catch (e) { console.error('line webhook event failed', e && e.message); } }
  return plain(200, { ok: true });
}
async function handleLineTesters(request, env, action) {
  if (request.method !== 'POST') return jsonError(405, '只支援 POST', request, env);
  const denied = await requireLab(request, env); if (denied) return denied;
  const { body, error } = await lineReadBody(request, env); if (error) return error;
  try {
    lineR2(env);
    if (action === 'remove') {
      const rec = await lineTesterGet(env, body.tid);
      if (!rec) throw Object.assign(new Error('名單裡找不到這位'), { status: 404 });
      await lineR2(env).delete(`${LINE_TESTER_PREFIX}${rec.tid}.json`);
    }
    return jsonOk({ ok: true, testers: (await lineTesterAll(env)).map(lineTesterPublic), maxPerSend: LINE_TESTER_MAX_PER_SEND }, request, env);
  } catch (e) { return jsonError(lineStatusCode(e), e.message || '操作失敗', request, env); }
}

// ===========================================================================
// 排程推播（LINE 本身沒有排程，所以由 Worker 自己排）
//   排程資料存在同一個 R2 bucket 的 sched/<id>.json（狀態與時間同時放在 customMetadata，Cron 一次 list 就能挑出到期的）。
//   Cron Trigger（每分鐘一次）呼叫 scheduled()：把到期的排程用「建立排程時產生的 retryKey」發出去（LINE 24 小時內同 key 不會重複發）。
//   要在 Cloudflare 後台設定：Worker → Settings → Triggers → Cron Triggers → 新增 `* * * * *`。沒設的話排程不會發送，所以網頁會讀「心跳」提醒。
//   POST /line/schedule/create  建立（正式帳號的條件跟立即推播一樣：LINE_ALLOW_OFFICIAL=1、先成功發過測試帳號、輸入正確好友數）
//   POST /line/schedule/list    查看（狀態、時間、嘗試次數、錯誤、發送後的 request id）
//   POST /line/schedule/update  變更時間（只有「待發送」的）
//   POST /line/schedule/cancel  刪除（取消）排程（只有「待發送」的）
// ===========================================================================
const LINE_SCHED_PREFIX = 'sched/';
const LINE_SCHED_MIN_LEAD_MS = 5 * 60 * 1000;            // 最早：5 分鐘後（Cron 每分鐘跑一次）
const LINE_SCHED_MAX_LEAD_MS = 14 * 24 * 3600 * 1000;    // 最晚：14 天內
const LINE_SCHED_MAX_LATE_MS = 30 * 60 * 1000;           // 到期後超過 30 分鐘還沒發出去 → 放棄（新聞過時了），標成「逾時未發送」
const LINE_SCHED_MAX_PENDING = 30;
const LINE_SCHED_DRIFT = 0.1;                            // 發送當下的好友數跟建立排程時確認的人數差超過 10% 就不發
function checkLineRunAt(v, now = Date.now()) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+08:00$/.test(v)) return '排程時間格式必須是 YYYY-MM-DDTHH:mm:00+08:00（台北時間，到分鐘）';
  const t = Date.parse(v);
  if (!Number.isFinite(t) || taipeiIso(t) !== v) return '排程時間不是有效的日期';
  if (t < now + LINE_SCHED_MIN_LEAD_MS) return '排程時間必須在 5 分鐘之後';
  if (t > now + LINE_SCHED_MAX_LEAD_MS) return '排程時間最多只能設在 14 天之內';
  return '';
}
function lineR2(env) {
  if (!env || !env.LINE_IMG || typeof env.LINE_IMG.put !== 'function' || typeof env.LINE_IMG.list !== 'function') throw Object.assign(new Error('Worker 尚未綁定 R2（綁定變數名稱必須是 LINE_IMG），排程資料沒地方放'), { status: 503 });
  return env.LINE_IMG;
}
const lineSchedKey = id => `${LINE_SCHED_PREFIX}${id}.json`;
async function lineSchedPut(env, rec) {
  rec.updatedAt = Date.now();
  await lineR2(env).put(lineSchedKey(rec.id), JSON.stringify(rec), { httpMetadata: { contentType: 'application/json' }, customMetadata: { status: rec.status, runAt: String(rec.runAt) } });
  return rec;
}
async function lineSchedGet(env, id) {
  if (!/^[0-9a-f]{24}$/.test(String(id || ''))) throw badInput('排程編號格式不正確');
  const o = await lineR2(env).get(lineSchedKey(id));
  if (!o) return null;
  try { return JSON.parse(typeof o.text === 'function' ? await o.text() : textDecoder.decode(o.body)); } catch { return null; }
}
async function lineSchedList(env) {
  const r2 = lineR2(env), out = []; let cursor;
  do {
    const r = await r2.list({ prefix: LINE_SCHED_PREFIX, limit: 500, cursor, include: ['customMetadata'] });
    for (const o of r.objects || []) out.push({ key: o.key, status: (o.customMetadata || {}).status || '', runAt: Number((o.customMetadata || {}).runAt) || 0 });
    cursor = r.truncated ? r.cursor : undefined;
  } while (cursor);
  return out;
}
const lineSchedPublic = r => ({ id: r.id, channel: r.channel, org: r.org, name: r.name || '', altText: r.altText, runAt: r.runAt, runAtIso: taipeiIso(r.runAt), status: r.status, attempts: r.attempts || 0, lastError: r.lastError || '', requestId: r.requestId || '', sentAt: r.sentAt || '', approvedFriends: r.approvedFriends || null, recipientNames: r.recipientNames || [], links: r.links || [], createdAt: r.createdAt });
const lineSanitizeLinks = links => (Array.isArray(links) ? links : []).slice(0, 24).map(l => ({ page: Number(l && l.page) || 0, label: String((l && l.label) || '').slice(0, 20), title: String((l && l.title) || '').slice(0, 120), url: String((l && l.url) || '').slice(0, 2000) }));

async function handleLineScheduleCreate(request, env) {
  if (request.method !== 'POST') return jsonError(405, '只支援 POST', request, env);
  const denied = await requireLab(request, env); if (denied) return denied;
  const { body, error } = await lineReadBody(request, env); if (error) return error;
  try {
    const key = body.channel;
    if (!LINE_CHANNEL_SUFFIX[key]) throw badInput('channel 只能是 test、news 或 ent');
    lineR2(env);
    const bad = checkLineRunAt(body.runAt); if (bad) throw badInput(`${bad}。沒有建立排程。`);
    const prep = await lineOpenPrep(env, body.prepareToken, '排程');
    const official = LINE_OFFICIAL.has(key);
    if (official) await lineOfficialGate(env, key, prep, body.testToken);
    const recs = official ? null : await lineResolveTesters(env, body.testers);   // 測試帳號排程：建立時就要指定收件人（時間到只發給他們）
    lineChannelCreds(env, key);
    const pending = (await lineSchedList(env)).filter(x => x.status === 'scheduled' || x.status === 'sending').length;
    if (pending >= LINE_SCHED_MAX_PENDING) throw Object.assign(new Error(`待發送的排程已經 ${pending} 筆，請先刪除不需要的再建立。沒有建立排程。`), { status: 409 });
    const origin = new URL(request.url).origin;
    // 建立當下就把格式檢查與人數確認做完（發送當下還會再檢查一次）
    const messages = lineBuildMessages(prep, origin);
    const v = await lineCall(env, key, 'POST', official ? '/v2/bot/message/validate/broadcast' : '/v2/bot/message/validate/multicast', { messages });
    if (v.status !== 200) throw Object.assign(new Error(`訊息格式沒有通過 LINE 檢查：${lineErrText(v)}。沒有建立排程。`), { status: 400 });
    const info = official ? await lineAccountInfo(env, key) : null;
    const friends = info && info.followers ? info.followers.followers : null;
    if (official) {
      if (friends === null) throw Object.assign(new Error('查不到這個帳號的好友數（LINE 的統計資料還沒好），為了安全正式帳號不排程。沒有建立排程。'), { status: 409 });
      lineTypedApprove(body.confirmTotal)(friends);
    }
    const id = lineHex(12), now = Date.now();
    const rec = { v: 1, id, channel: key, org: prep.org, name: typeof body.name === 'string' ? body.name.slice(0, 60) : '', altText: prep.altText, pages: prep.pages, links: lineSanitizeLinks(body.links), origin, runAt: Date.parse(body.runAt), createdAt: now, status: 'scheduled', attempts: 0, retryKey: crypto.randomUUID(), approvedFriends: friends };
    if (recs) { rec.testerTids = recs.map(r => r.tid); rec.recipientNames = recs.map(r => r.name || '（沒有暱稱）'); }
    await lineSchedPut(env, rec);
    return jsonOk({ ok: true, schedule: lineSchedPublic(rec) }, request, env);
  } catch (e) { return jsonError(lineStatusCode(e), e.message || '建立排程失敗', request, env); }
}
async function handleLineScheduleList(request, env) {
  if (request.method !== 'POST') return jsonError(405, '只支援 POST', request, env);
  const denied = await requireLab(request, env); if (denied) return denied;
  try {
    const r2 = lineR2(env);
    const items = await lineSchedList(env);
    const recs = [];
    for (const it of items.sort((a, b) => b.runAt - a.runAt).slice(0, 60)) { const id = it.key.slice(LINE_SCHED_PREFIX.length, -5); const r = await lineSchedGet(env, id); if (r) recs.push(r); }
    // 待發送／發送中排前面（由近到遠），其他依時間新到舊
    const live = recs.filter(r => r.status === 'scheduled' || r.status === 'sending').sort((a, b) => a.runAt - b.runAt);
    const rest = recs.filter(r => !(r.status === 'scheduled' || r.status === 'sending')).sort((a, b) => b.runAt - a.runAt);
    let heartbeatAt = 0;
    const hb = await r2.get('meta/heartbeat.json'); if (hb) { try { heartbeatAt = Number(JSON.parse(typeof hb.text === 'function' ? await hb.text() : textDecoder.decode(hb.body)).at) || 0; } catch { /* ignore */ } }
    return jsonOk({ ok: true, schedules: [...live, ...rest].map(lineSchedPublic), heartbeatAt, serverNow: Date.now(), officialAllowed: !!(env && env.LINE_ALLOW_OFFICIAL === '1') }, request, env);
  } catch (e) { return jsonError(lineStatusCode(e), e.message || '查詢排程失敗', request, env); }
}
async function handleLineScheduleChange(request, env, action) {
  if (request.method !== 'POST') return jsonError(405, '只支援 POST', request, env);
  const denied = await requireLab(request, env); if (denied) return denied;
  const { body, error } = await lineReadBody(request, env); if (error) return error;
  try {
    const rec = await lineSchedGet(env, body.id);
    if (!rec) throw Object.assign(new Error('找不到這筆排程'), { status: 404 });
    if (rec.status !== 'scheduled') throw Object.assign(new Error(`這筆排程目前是「${rec.status}」，只有「待發送」的能${action === 'update' ? '變更' : '刪除'}`), { status: 409 });
    if (rec.runAt - Date.now() < 60 * 1000) throw Object.assign(new Error('這筆排程再不到 1 分鐘就要發送，來不及變更或刪除了'), { status: 409 });
    if (action === 'update') {
      const bad = checkLineRunAt(body.runAt); if (bad) throw badInput(`${bad}。排程沒有變動。`);
      rec.runAt = Date.parse(body.runAt); rec.attempts = 0; rec.lastError = '';
    } else {
      rec.status = 'cancelled'; rec.cancelledAt = Date.now();
    }
    await lineSchedPut(env, rec);
    return jsonOk({ ok: true, schedule: lineSchedPublic(rec) }, request, env);
  } catch (e) { return jsonError(lineStatusCode(e), e.message || '操作失敗', request, env); }
}
// Cron：每分鐘由 Cloudflare 呼叫一次。先寫「心跳」讓網頁知道 Cron 有在跑，再把到期的排程發出去。
async function lineRunDue(env, now = Date.now()) {
  const r2 = lineR2(env);
  await r2.put('meta/heartbeat.json', JSON.stringify({ at: now }), { httpMetadata: { contentType: 'application/json' } });
  const due = (await lineSchedList(env)).filter(x => (x.status === 'scheduled' || x.status === 'sending') && x.runAt <= now).sort((a, b) => a.runAt - b.runAt).slice(0, 5);
  const results = [];
  for (const it of due) {
    const rec = await lineSchedGet(env, it.key.slice(LINE_SCHED_PREFIX.length, -5));
    if (!rec || (rec.status !== 'scheduled' && rec.status !== 'sending') || rec.runAt > now) continue;
    if (now - rec.runAt > LINE_SCHED_MAX_LATE_MS) { rec.status = 'missed'; rec.lastError = '超過預定時間 30 分鐘仍沒有發出（可能 Cron 沒有在跑），為避免內容過時，已放棄這筆排程'; await lineSchedPut(env, rec); results.push([rec.id, 'missed']); continue; }
    if (rec.status === 'sending' && now - (rec.sendingAt || 0) < 5 * 60 * 1000) continue;   // 上一輪還在發（或剛當掉），等一下再看；重試時用同一個 retryKey，不會重複發
    rec.status = 'sending'; rec.sendingAt = now; rec.attempts = (rec.attempts || 0) + 1;
    await lineSchedPut(env, rec);
    try {
      const prep = { org: rec.org, altText: rec.altText, pages: rec.pages };
      const official = LINE_OFFICIAL.has(rec.channel);
      if (official) {
        if (env.LINE_ALLOW_OFFICIAL !== '1') throw Object.assign(new Error('正式帳號發送已關閉（Worker 沒有設定 LINE_ALLOW_OFFICIAL=1），沒有發送'), { status: 403 });
        if (rec.channel !== rec.org) throw badInput('排程內容與帳號不符，沒有發送');
      }
      const approve = friends => { const a = rec.approvedFriends; if (a && Math.abs(friends - a) > Math.max(100, Math.round(a * LINE_SCHED_DRIFT))) throw Object.assign(new Error(`發送當下好友數約 ${friends} 人，和建立排程時確認的 ${a} 人差太多，為了安全沒有發送`), { status: 409 }); };
      let r;
      if (official) r = await lineBroadcastNow(env, rec.channel, prep, { origin: rec.origin, retryKey: rec.retryKey, approve });
      else {   // 測試帳號：只發給建立排程時指定的人（名單裡已被移除的就略過；一個都不剩就失敗）
        const recs = []; for (const tid of rec.testerTids || []) { const t = await lineTesterGet(env, tid); if (t) recs.push(t); }
        if (!recs.length) throw badInput('這筆測試排程指定的收件人都已不在測試名單裡，沒有發送任何東西');
        r = await lineMulticastTest(env, prep, { origin: rec.origin, retryKey: rec.retryKey, recs });
      }
      rec.status = 'sent'; rec.requestId = r.requestId; rec.sentAt = taipeiIso(Date.now()); rec.friends = r.friends; rec.lastError = '';
    } catch (e) {
      const transient = !e.status || e.status >= 500 || e.lineStatus >= 500 || e.lineStatus === 429 || e.status === 429 || (e.status === 502 && !e.lineStatus && /fetch|network/i.test(e.message || ''));
      if (transient && now - rec.runAt < LINE_SCHED_MAX_LATE_MS) { rec.status = 'scheduled'; rec.lastError = `第 ${rec.attempts} 次嘗試失敗，下一分鐘會再試：${e.message}`; }
      else { rec.status = 'failed'; rec.lastError = e.message || '發送失敗'; }
    }
    await lineSchedPut(env, rec);
    results.push([rec.id, rec.status]);
  }
  return results;
}

// 查某次群發的互動統計（每個連結的點擊次數／點擊人數）。唯讀；requestId 是發送時 LINE 回的 x-line-request-id。
// LINE 規定：統計只在發送後 14 天內更新；數值小於 20（或實際人數小於 20）會顯示 null；每小時最多 60 次查詢。
async function handleLineClicks(request, env) {
  if (request.method !== 'POST') return jsonError(405, '只支援 POST', request, env);
  const denied = await requireLab(request, env); if (denied) return denied;
  const { body, error } = await lineReadBody(request, env); if (error) return error;
  try {
    if (typeof body.requestId !== 'string' || !LINE_RETRY_KEY.test(body.requestId)) throw badInput('requestId 格式不正確（應該是發送時 LINE 回的 UUID）');
    const r = await lineCall(env, body.channel, 'GET', `/v2/bot/insight/message/event?requestId=${encodeURIComponent(body.requestId)}`);
    if (r.status === 200) {
      const d = r.data || {};
      return jsonOk({ ok: true, overview: d.overview || null, messages: Array.isArray(d.messages) ? d.messages : [], clicks: Array.isArray(d.clicks) ? d.clicks : [] }, request, env);
    }
    if (r.status === 400 || r.status === 404) return jsonOk({ ok: true, unavailable: true, message: `LINE 還沒有這次發送的統計（${lineErrText(r)}）。統計通常要等一段時間，且只保留發送後約 14 天。` }, request, env);
    throw Object.assign(new Error(lineErrText(r)), { status: 502 });
  } catch (e) { return jsonError(lineStatusCode(e), e.message || '查詢失敗', request, env); }
}

export default {
  // Cron Trigger（每分鐘）：把到期的 LINE 排程發出去，見上方「排程推播」說明
  async scheduled(event, env, ctx) {
    const job = lineRunDue(env).catch(e => console.error('line schedule cron failed', e && e.message));
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(job); else await job;
  },
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
    if (path === '/s8/prepare') return handleS8Prepare(request, env);
    if (path === '/s8/create') return handleS8Create(request, env);
    if (path === '/s8/pause') return handleS8Pause(request, env);
    if (path === '/line/status') return handleLineStatus(request, env);
    if (path === '/line/prepare') return handleLinePrepare(request, env);
    if (path === '/line/validate') return handleLineValidate(request, env);
    if (path === '/line/send') return handleLineSend(request, env);
    if (path === '/line/clicks') return handleLineClicks(request, env);
    if (path === '/line/webhook') return handleLineWebhook(request, env);
    if (path === '/line/testers/list') return handleLineTesters(request, env, 'list');
    if (path === '/line/testers/remove') return handleLineTesters(request, env, 'remove');
    if (path === '/line/schedule/create') return handleLineScheduleCreate(request, env);
    if (path === '/line/schedule/list') return handleLineScheduleList(request, env);
    if (path === '/line/schedule/update') return handleLineScheduleChange(request, env, 'update');
    if (path === '/line/schedule/cancel') return handleLineScheduleChange(request, env, 'cancel');
    if (path.startsWith('/line-img/') && (request.method === 'GET' || request.method === 'HEAD')) return handleLineImage(request, env);
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
