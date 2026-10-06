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

## 連結 SUPER 8 Studio（OAuth，階段一：只讀）

試驗版右上角的「S8 未連結／已連結」按鈕，會跳到 S8 的登入與授權頁，讓這個 Worker 取得**唯讀**權限。更新 Worker 程式後即可使用，**不需要新增任何變數或儲存空間**（沿用 `LAB_PASSWORD` 衍生的金鑰加密）。

| 項目 | 說明 |
|---|---|
| 流程 | 網頁 → `POST /s8/login-start`（需試驗功能憑證）→ 彈出視窗登入並按「允許」→ S8 跳回 `GET /s8/callback` → Worker 用 PKCE 換憑證 → 加密後交給網頁 → `POST /s8/status` 呼叫 `auth_me`、`auth_organizations` |
| 授權範圍 | 只請求 `insightark-mcp:read`；程式內只允許這兩個唯讀工具，**沒有任何建立、發送、排程的程式路徑** |
| 憑證保存 | 網頁只存一串加密字串（分頁關閉就消失）；解密只有 Worker 能做；改 `LAB_PASSWORD` 後舊字串全部失效 |
| 用戶端註冊 | 第一次連結時 Worker 向 S8 動態註冊（公開用戶端、跳轉位址 `https://<worker網址>/s8/callback`），之後瀏覽器記住 client id，不重複註冊 |
| 升級為可建立草稿 | `POST /s8/login-start` 帶 `upgrade:true`：向 S8 另外註冊一個帶 `insightark-mcp:write` 的用戶端並重新授權；預設（沒帶）仍只請求 read |
| 建立群發（階段三） | `POST /s8/prepare`（上傳兩張 PNG 到 S8、產生預覽、封存要建立的內容，20 分鐘有效）→ `POST /s8/create`（需帶使用者輸入的人數；Worker 重新試算人數，差距超過 1%（至少 5 人）就拒絕）→ 依 `mode` 排程並處理（見下一列）；`POST /s8/pause` 可暫停（含重試暫停、暫停保留中的排程） |
| `/s8/create` 的 `mode` | 只接受 `"draft"`（沒帶就是它）或 `"schedule"`，其他任何值（含 `null`、大小寫不同、空字串）一律回 400，且完全不呼叫 S8。<br>`draft`：建立 → `broadcast_get` → `broadcast_update(pause)` → `broadcast_get`，回 `{ok, mode:'draft', taskId, status, phase, scheduledWas, total, orgId}`。<br>`schedule`（使用者明確選擇、**不暫停**）：body 必須帶 `scheduleAt`（台北時間 `YYYY-MM-DDTHH:mm:00+08:00`，到分鐘），Worker 檢查格式、日期真的存在、且落在**建立當下 +30 分鐘 ～ +7 天**，不合格回 400 且完全不呼叫 S8；建立後只呼叫唯讀的 `broadcast_get` 確認狀態，回 `{ok:true, mode:'schedule', taskId, scheduleAt, status, phase, allowedActions, total, orgId}`；這筆群發會在 `scheduleAt` **實際發送**。讀不到狀態或找不到 taskId 時回 `ok:false` 與 `warning`（明寫實際發送時間），網頁會提示立即處理。<br>`draft` 的 `scheduleAt` 由 Worker 固定為建立當下 +24 小時（+08:00），帶 `scheduleAt` 會回 400；兩種模式的 `recipients` 一律忽略（固定全部 LINE 顧客） |
| 程式內的硬規則 | 工具參數一律先過把關：發送對象只能是 LINE + 不加條件；`scheduleAt` 必須是 +08:00 的 RFC 3339，且在建立當下 +25 分鐘 ～ +7 天又 1 小時之間（把關層；`/s8/create` 對使用者指定的時間更嚴：+30 分鐘 ～ +7 天）；`broadcast_update` 只允許 `action:"pause"`；只允許 imagemap、連結只允許網址；整個程式沒有 resume、sendNow，也沒有省略 `scheduleAt` 的建立；`schedule` 模式只是「不呼叫 pause」並改用使用者指定的時間，其他把關完全沒有放寬 |
| 試算人數 | `POST /s8/audience` 呼叫 `broadcast_audience_preview`（唯讀）：組織只能是 `news`（TVBS新聞）或 `ent`（TVBS娛樂頭條），由 Worker 依名稱向 S8 解析 id；參數固定為 LINE、只限定平台、不加標籤或其他條件、不取樣本，網頁傳來的任何篩選一律忽略 |
| 查看工具定義 | `POST /s8/tools` 只做 MCP 的 `tools/list`（列出與群發有關的工具名稱、說明、欄位），不執行任何工具 |
| 撤銷授權 | S8 Console → 使用者資訊 → Connected Apps；網頁上的「中斷連線」只會清掉這個分頁的連結資料 |

> 若 S8 不接受 `workers.dev` 當跳轉位址，視窗會顯示 S8 回報的原因，請把那段文字貼給維護者。

## 自動測試

```bash
node --test worker/test/*.test.mjs          # Worker：用假的 S8 MCP 驗證 /s8/create 的 mode（預設 draft、非法 mode 被拒、schedule 不呼叫 broadcast_update、無 resume／sendNow、排程時間必須在 +30 分鐘 ～ +7 天、格式與日期檢查）
python3 -m http.server 8960 &               # 前端（Playwright，Worker 回應全由攔截假造；截圖在 test/e2e/screenshots/）
NODE_PATH=$(npm root -g) node test/e2e/s8-steps.mjs
```

## 快速自我檢查

瀏覽器直接開 `https://<worker網址>/?url=<一篇 TVBS 文章網址>`：看到文章首圖就代表 Worker 正常（直接用網址列開不會帶 `Origin`，所以只是檢查抓圖，不涉及網頁授權）。

## 常見問題

| 狀況 | 原因與處理 |
|---|---|
| 回應「圖片網域不在允許名單：xxx」 | TVBS 把圖放在別的網域。把該網域的尾段（例如 `tvbs.com.tw`、`xxx.net`）加進檔案開頭的 `ALLOWED_HOST_SUFFIXES` 後重新部署。 |
| 回應「文章網域不在允許名單」 | 貼的不是 TVBS 網址。 |
| 網頁顯示抓圖失敗但 Worker 網址直接開得到圖 | 網頁的網域不在 `ALLOWED_ORIGINS`（例如自己架在別的網址），把網頁的來源加進去重新部署。 |
