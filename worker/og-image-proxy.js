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
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    const path = new URL(request.url).pathname;
    if (path === '/lab-auth') return handleLabAuth(request, env);
    if (path === '/lab-ping') return handleLabPing(request, env);
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
