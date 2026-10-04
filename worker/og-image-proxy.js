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
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
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

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request, env) });
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
