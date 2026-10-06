# 文章首圖代理（Cloudflare Worker）

給網頁「快速填入」自動抓文章第一張圖用。瀏覽器基於跨網域限制，不能直接讀新聞網站的內容，所以需要這個小中間站。

- 只允許 `tvbs.com.tw` 網域（文章與圖片都是）、只允許 https，**不是開放代理**。
- 只接受來自 `https://unnn3ing-oss.github.io` 的網頁呼叫（見檔案開頭的 `ALLOWED_ORIGINS`）。
- Cloudflare 免費方案每天 10 萬次請求，遠超過使用量。

## 部署步驟（約 5 分鐘，只做一次）

1. 登入（或免費註冊）<https://dash.cloudflare.com>。
2. 左側選單 **Workers & Pages** → **Create** → **Create Worker**，名稱隨意（例如 `og-image-proxy`）→ **Deploy**。
3. 部署後按 **Edit code**，把編輯器裡的內容**全部刪掉**，貼上 `og-image-proxy.js` 的全部內容 → 右上角 **Deploy**。
4. 回到 Worker 頁面，複製網址（長得像 `https://og-image-proxy.<你的帳號>.workers.dev`）。
5. 把這個網址交給管理網頁的人設定（見下方），或先自己測試：

   在網頁網址後面加 `?imageProxy=<你的worker網址>` 開一次（例如 `https://unnn3ing-oss.github.io/LinePushPatternTool/?imageProxy=https://og-image-proxy.xxx.workers.dev`），網址會存在這台瀏覽器裡，之後正常開網頁就會自動抓圖。

## 試驗功能密碼（網頁右上角「試驗功能」用）

網頁右上角的「試驗功能」要輸入密碼才能進入。**密碼不放在網頁裡**（網頁原始碼是公開的，放了等於沒鎖），而是由這個 Worker 驗證：

1. 把最新的 `og-image-proxy.js` 全部貼上、重新 **Deploy**（內容含 `/lab-auth`、`/lab-ping` 兩個新路徑，原本的抓圖功能不受影響）。
2. Worker 頁面 → **Settings** → **Variables and Secrets** → **Add** → 類型選 **Secret**，名稱填 `LAB_PASSWORD`，值填你要的密碼 → **Deploy**。
3. （選填）再加一個 Secret `LAB_SIGNING_KEY`，填一串隨機文字，用來簽發登入憑證；沒設就用 `LAB_PASSWORD`，這樣改密碼後舊憑證會自動失效。

| 項目 | 說明 |
|---|---|
| 沒設 `LAB_PASSWORD` | 一律回 503，任何人都進不去（不會因為忘了設密碼而變成沒鎖） |
| 密碼正確 | 回傳 8 小時有效、帶簽章的憑證；網頁只存在這個分頁（關掉分頁就沒了） |
| 密碼錯誤 | 回 401，並多等 0.6 秒再回應，拖慢連續猜密碼 |
| 來源限制 | 只接受 `ALLOWED_ORIGINS` 內網頁的請求 |
| 更改密碼 | 在 Secret 改掉值並重新 Deploy，舊憑證立刻全部失效 |

> 之後做「排入 S8」時，Worker 會先檢查這個憑證才處理，並且只允許建立「草稿」。

## 快速自我檢查

瀏覽器直接開 `https://<worker網址>/?url=<一篇 TVBS 文章網址>`：看到文章首圖就代表 Worker 正常（直接用網址列開不會帶 `Origin`，所以只是檢查抓圖，不涉及網頁授權）。

## 常見問題

| 狀況 | 原因與處理 |
|---|---|
| 回應「圖片網域不在允許名單：xxx」 | TVBS 把圖放在別的網域。把該網域的尾段（例如 `tvbs.com.tw`、`xxx.net`）加進檔案開頭的 `ALLOWED_HOST_SUFFIXES` 後重新部署。 |
| 回應「文章網域不在允許名單」 | 貼的不是 TVBS 網址。 |
| 網頁顯示抓圖失敗但 Worker 網址直接開得到圖 | 網頁的網域不在 `ALLOWED_ORIGINS`（例如自己架在別的網址），把網頁的來源加進去重新部署。 |
