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
| 登入範圍 | `POST /s8/login-start` 一律請求 `insightark-mcp:read insightark-mcp:write`（不再分「升級」；舊的 `upgrade` 參數仍接受但無作用）。網頁帶著記住的用戶端 id 就沿用，沒有才向 S8 註冊一個帶 write 的用戶端，避免反覆授權 |
| 建立群發（階段三） | `POST /s8/prepare`（上傳兩張 PNG 到 S8、產生預覽、封存要建立的內容，20 分鐘有效）→ `POST /s8/create`（需帶使用者輸入的人數；Worker 重新試算人數，差距超過 1%（至少 5 人）就拒絕）→ 依 `mode` 排程並處理（見下一列）；`POST /s8/pause` 可暫停（含重試暫停、暫停保留中的排程） |
| `/s8/create` 的 `mode` | 只接受 `"draft"`（沒帶就是它）或 `"schedule"`，其他任何值（含 `null`、大小寫不同、空字串）一律回 400，且完全不呼叫 S8。<br>`draft`：建立 → `broadcast_get` → `broadcast_update(pause)` → `broadcast_get`，回 `{ok, mode:'draft', taskId, status, phase, scheduledWas, total, orgId}`。<br>`schedule`（使用者明確選擇、**不暫停**）：body 必須帶 `scheduleAt`（台北時間 `YYYY-MM-DDTHH:mm:00+08:00`，到分鐘），Worker 檢查格式、日期真的存在、且落在**建立當下 +30 分鐘 ～ +7 天**，不合格回 400 且完全不呼叫 S8；建立後只呼叫唯讀的 `broadcast_get` 確認狀態，回 `{ok:true, mode:'schedule', taskId, scheduleAt, status, phase, allowedActions, total, orgId}`；這筆群發會在 `scheduleAt` **實際發送**。讀不到狀態或找不到 taskId 時回 `ok:false` 與 `warning`（明寫實際發送時間），網頁會提示立即處理。<br>`draft` 的 `scheduleAt` 由 Worker 固定為建立當下 +24 小時（+08:00），帶 `scheduleAt` 會回 400；兩種模式的 `recipients` 一律忽略（固定全部 LINE 顧客） |
| 程式內的硬規則 | 工具參數一律先過把關：發送對象只能是 LINE + 不加條件；`scheduleAt` 必須是 +08:00 的 RFC 3339，且在建立當下 +25 分鐘 ～ +7 天又 1 小時之間（把關層；`/s8/create` 對使用者指定的時間更嚴：+30 分鐘 ～ +7 天）；`broadcast_update` 只允許 `action:"pause"`；只允許 imagemap、連結只允許網址；整個程式沒有 resume、sendNow，也沒有省略 `scheduleAt` 的建立；`schedule` 模式只是「不呼叫 pause」並改用使用者指定的時間，其他把關完全沒有放寬 |
| 試算人數 | `POST /s8/audience` 呼叫 `broadcast_audience_preview`（唯讀）：組織只能是 `news`（TVBS新聞）或 `ent`（TVBS娛樂頭條），由 Worker 依名稱向 S8 解析 id；參數固定為 LINE、只限定平台、不加標籤或其他條件、不取樣本，網頁傳來的任何篩選一律忽略 |
| 查看工具定義 | `POST /s8/tools` 只做 MCP 的 `tools/list`（列出群發相關，以及客戶資料／單一客戶發送這幾個工具的名稱、說明、欄位），不執行任何工具；這份清單只影響「列出」，沒有多開任何執行權限 |
| 撤銷授權 | S8 Console → 使用者資訊 → Connected Apps；網頁上的「中斷連線」只會清掉這個分頁的連結資料 |

> 若 S8 不接受 `workers.dev` 當跳轉位址，視窗會顯示 S8 回報的原因，請把那段文字貼給維護者。

## LINE 官方帳號直接發送（試驗，不經過 S8）

網頁的「排入 S8」視窗最下面有一個可展開的「LINE 官方帳號直接發送（試驗）」。它**不用 S8 的額度**，改用官方帳號自己的 Messaging API，把同一份預覽內容（兩頁圖文訊息、每格連結、推播標題）發給該帳號的**全部好友**。

> ⚠️ **沒有草稿、沒有排程**：LINE 的群發呼叫成功就是已經發出，無法收回。所以預設**只允許測試帳號**，正式帳號要多道手續（見下）。

### 設定（只做一次）

1. **Secret（Worker → Settings → Variables and Secrets → Secret）**

   | 名稱 | 內容 |
   |---|---|
   | `LINE_CHANNEL_ID_TEST`、`LINE_CHANNEL_SECRET_TEST` | 測試官方帳號的 Channel ID 與 Channel secret（LINE Developers Console → 該頻道 → Basic settings） |
   | `LINE_CHANNEL_ID_NEWS`、`LINE_CHANNEL_SECRET_NEWS` | TVBS新聞正式帳號（先不要設，測試穩定後再說） |
   | `LINE_CHANNEL_ID_ENT`、`LINE_CHANNEL_SECRET_ENT` | TVBS娛樂頭條正式帳號（同上） |
   | `LINE_ALLOW_OFFICIAL` | 填 `1` 才允許發正式帳號；**沒設就一律拒絕** |

   **Channel secret 等同密碼，不要貼在對話或程式碼裡。**
2. **R2 圖片空間**：Cloudflare → R2 → 建立一個 bucket（名稱隨意）；再到 Worker → Settings → Bindings → Add → **R2 bucket**，**變數名稱必須填 `LINE_IMG`**，選剛建的 bucket → Deploy。LINE 的 imagemap 要求圖片放在你自己的 HTTPS 網址，且 `baseUrl/{240,300,460,700,1040}` 五種寬度的網址都要能下載（網址不能有副檔名）。網頁只上傳「與 S8 同一張」的 1040 圖（位元組完全相同），Worker 存進 R2，並由 `GET /line-img/<id>/<寬度>`（公開）對**五種寬度的網址都回這一張 1040**：LINE 不管挑哪種寬度，抓到的都是完整畫質，由手機自己縮小，不經過我們的縮圖。**圖片要一直留著**（使用者每次開啟訊息 LINE 都會抓），不要清掉 bucket。
3. 貼上最新的 `og-image-proxy.js` 並 Deploy。

### 怎麼運作

| 端點 | 作用 |
|---|---|
| `POST /line/status` | 用 Channel ID＋secret 現場換一個 15 分鐘的 stateless token，唯讀查帳號名稱、好友數（LINE 昨日統計）、本月訊息額度與已用 |
| `POST /line/prepare` | 檢查內容、把每頁 1040 寬的圖片存進 R2、封存要發的內容（30 分鐘有效） |
| `POST /line/validate` | 交給 LINE 的 `validate/broadcast` 檢查格式，**只檢查、不發送** |
| `POST /line/send` | 再 validate 一次、確認額度與人數後發送。**測試帳號：`multicast` 只發給測試名單裡勾選的人（每次最多 2 位），不 broadcast**；正式帳號：`broadcast` 給全部好友 |
| `POST /line/webhook` | 測試帳號的 webhook（LINE 呼叫，不用試驗功能憑證，驗 `X-Line-Signature`）：同事傳「登記」就加入測試名單（見下一節） |
| `POST /line/testers/list`｜`remove` | 查看／移除測試名單（網頁只拿到 tid 與暱稱，看不到 LINE userId）；`channel` 可帶 `test`（預設）｜`news`｜`ent` |
| `POST /line/testers/lookup`｜`add` | **只有 news／ent**：貼上對方的 LINE userId → Worker 用該正式帳號的 token 查 `GET /v2/bot/profile/{userId}` 驗證有效並取得暱稱；`add` 驗證通過才存（每個帳號上限 20 人） |
| `POST /line/schedule/*` | 排程推播：建立、查看、變更時間、刪除（見下一節） |
| `POST /line/clicks` | 用發送時 LINE 回的 request id，查這次群發每個連結的點擊次數與人數（`GET /v2/bot/insight/message/event`，唯讀） |

發送的安全規則（`POST /line/send`）：

- 一定先 `validate`，沒通過就不發；每次帶 `X-Line-Retry-Key`（UUID），同一個 key 重送 LINE 不會重複發；
- 本月額度（上限－已用）不夠好友數就不發；
- **正式帳號**另外要求：Worker 設了 `LINE_ALLOW_OFFICIAL=1`；**同一份內容先成功發過測試帳號**（Worker 回的 `testToken`，1 小時有效）；內容的版型要和帳號對得上（新聞內容只能發新聞帳號）；使用者輸入的好友數和 LINE 回報的相差在 2%（至少 50 人）以內；查不到好友數就不發；
- Worker 只允許呼叫 12 個 LINE 端點（取 token、查帳號資訊、額度、已用、好友數、互動統計、validate／broadcast，以及**只限測試帳號**的 validate／multicast、reply、profile），**沒有** push／narrowcast、不改頻道設定、不重發長效 token。程式寫死：測試帳號不能 broadcast；正式帳號不能 multicast／reply／profile。

### 測試名單（測試帳號只發給「選到的人」，省額度）

LINE 的額度是**以收件人數計**（發給 1 位＝1 則，不管幾頁圖；封鎖的人不計；reply 不計）。測試帳號免費版每月 200 則，如果每次測試都 broadcast 給所有好友（例如 20 位好友）一個月只能測約 9 次。所以測試推播改成：

1. **一次性設定（只動測試帳號，新聞／娛樂帳號的 webhook 屬於 S8，完全不碰）**：LINE Developers Console → 測試帳號頻道 → Messaging API → **Webhook URL** 填 `https://<你的 Worker 網址>/line/webhook`，開啟 **Use webhook**，按 **Verify**（要顯示 Success）。LINE Official Account Manager → 回應設定：建議關掉「加入好友的歡迎訊息」與「自動回應訊息」，避免和 Worker 的回覆重複。
2. **登記**：用 LINE 傳送「登記」給測試帳號（也可傳「加入測試名單」）→ Worker 記下 userId 與暱稱（存在 R2 的 `testers/`），並回覆「已加入測試名單」。傳別的字或剛加好友只會收到提示；封鎖測試帳號會自動從名單移除；名單上限 50 人。
3. **使用**：網頁測試推播前在「測試推播給」多選下拉勾選收件人（最多 2 位，選滿後其他人不能再勾；選擇記在這個瀏覽器）；Worker 強制每次最多 2 位、只能選名單內的人。收件人換了會換一把重試金鑰。
4. 測試排程（排程對象選「測試帳號」）建立時也要選收件人，時間到只發給他們。

### 正式帳號的測試推播（不需要同事加測試帳號）

新聞／娛樂正式帳號的 webhook 屬於 S8，無法改，所以**不靠 webhook 取得 userId**：S8 客戶中心裡每位 LINE 客戶的客戶 ID 就是該帳號下的 LINE userId（`U` 加 32 碼）。

1. **設定（一次性）**：Worker Secret 設 `LINE_CHANNEL_ID_NEWS`／`LINE_CHANNEL_SECRET_NEWS`（娛樂同理 `_ENT`）。**`LINE_ALLOW_OFFICIAL` 照樣不設**——這個功能不需要它，正式 broadcast 仍然鎖死。
2. **建立名單**：網頁「排入LINE推播」→ 折疊區「帳號與額度…」→ 選「正式帳號」→ 貼上 userId →「查詢」（Worker 向 LINE 查暱稱，顯示給你確認是不是對的人；LINE 查不到＝不是該帳號好友或不同 Provider，不能加）→「加入名單」。名單存 R2 `testers/<news|ent>/`，每帳號最多 20 人。
3. **測試推播**：第 3 步「測試推播發到」選「TVBS新聞（正式帳號）」，勾選收件人（最多 2 位）→ `POST /line/send` 帶 `mode:"test"`＋`testers`，Worker 用該帳號的 token **multicast**（不是 broadcast）。只發給名單內勾選的人；版型要和帳號對得上；成功回 `testToken`，之後正式推播的「先測試過」閘門一樣通過（測試帳號或正式帳號測試都算）。
4. **安全**：`lineCall` 內強制正式帳號的 multicast 最多 2 位、每個都是合法 userId；reply 仍只有測試帳號能用；沒有 push／narrowcast；正式 broadcast 的所有閘門（旗標、先測試、輸入好友數、版型）完全沒變。測試排程仍然只能排給測試帳號。

### 排程推播（LINE 本身沒有排程，所以由 Worker 自己排）

網頁的「排程推播」會把要發的內容（圖片已在 R2、連結、推播標題）和時間存成一筆排程，**時間到了由 Worker 的 Cron 自動發送**。排程資料放在同一個 R2 bucket 的 `sched/` 底下（不用另外建資料庫）。

**一定要做的設定：Cron Trigger。** Cloudflare → Worker → Settings → Triggers → **Cron Triggers** → Add → 填 `* * * * *`（每分鐘）。沒設的話排程**不會發送**；網頁的「排程狀態」會讀 Worker 每分鐘寫的「心跳」，有待發送的排程卻沒有心跳時，會用紅字警告。

| 端點 | 作用 |
|---|---|
| `POST /line/schedule/create` | 建立排程。條件與立即推播相同（正式帳號要 `LINE_ALLOW_OFFICIAL=1`、同一份內容先成功推播過測試帳號、輸入正確好友數）；時間要在 **5 分鐘後 ～ 14 天內**（台北時間，到分鐘）；待發送最多 30 筆 |
| `POST /line/schedule/list` | 查看排程（狀態、時間、嘗試次數、錯誤、發送後的 request id）與 Cron 心跳 |
| `POST /line/schedule/update` | 變更時間（只有「待發送」的，且發送前不到 1 分鐘就來不及） |
| `POST /line/schedule/cancel` | 刪除（取消）排程（同上） |

到時間時（`scheduled()`，每分鐘一次）Worker 會：先檢查格式（validate）、重新查好友數與額度、好友數和建立排程時確認的差距要在 10% 內（否則不發）、正式帳號的 `LINE_ALLOW_OFFICIAL` 還要是 1，才用建立排程時產生的 `retryKey` 發出（LINE 24 小時內同一個 key 不會重複發，所以重試或 Cron 重疊都不會發兩次）。LINE 暫時失敗（5xx／429／網路）會每分鐘重試；格式或額度問題直接標成「發送失敗」；**超過預定時間 30 分鐘還沒發出去就放棄**（標成「逾時未發送」，避免新聞過時才推）。狀態有：待發送、發送中、已發送、發送失敗、已取消、逾時未發送。

排程自動發出去的，網頁在你下次打開視窗時會把 request id 補進「發送紀錄」，才能用來查點擊次數。

### 發送後查點擊次數

每次發送成功，網頁會把 LINE 回的 request id 與「第幾頁哪一格是哪個連結」記在這台瀏覽器（最近 30 筆）。在「發送紀錄與點擊次數」選一筆按「查詢點擊次數」，會列出每個連結的點擊次數、點擊人數，最後一列是整則訊息的發送數、開啟人數與點了任何連結的人數，可「複製成表格」貼到試算表。LINE 的限制（官方文件）：**統計只在發送後 14 天內更新**；**數字小於 20（或實際人數小於 20）時 LINE 不提供**，會顯示「—」（測試帳號好友很少，所以幾乎都是「—」）；每小時最多查 60 次。網頁每次查到的數字都會存成快照，超過 14 天 LINE 不再提供時還能看最後一次查到的；試驗功能憑證只有 8 小時，過期時查詢會自動跳出密碼視窗，輸入後繼續。

### 絕對不要做的事（會讓 S8 的串接中斷）

- 不要在 LINE 後台**重新發行 Channel secret** 或**長效 channel access token**：正式帳號的頻道是 S8 在用的，重發會讓舊的立刻失效。
- 不要改頻道的 **Webhook URL**。
- 這個功能發出的訊息，S8 後台不一定看得到（推論）；額度則和 S8 發送共用同一個官方帳號的每月訊息額度。

## 自動測試

```bash
node --test worker/test/*.test.mjs          # Worker：用假的 S8 MCP 驗證 /s8/create 的 mode（預設 draft、非法 mode 被拒、schedule 不呼叫 broadcast_update、無 resume／sendNow、排程時間必須在 +30 分鐘 ～ +7 天、格式與日期檢查）
python3 -m http.server 8960 &               # 前端（Playwright，Worker 回應全由攔截假造；截圖在 test/e2e/screenshots/）
NODE_PATH=$(npm root -g) node test/e2e/s8-steps.mjs      # 步驟流程、顏色、尺寸、選擇器
NODE_PATH=$(npm root -g) node test/e2e/s8-per-mode.mjs   # 新聞／娛樂各自保留進度
NODE_PATH=$(npm root -g) node test/e2e/s8-connect.mjs    # 連結彈窗
NODE_PATH=$(npm root -g) node test/e2e/line-direct.mjs   # LINE 直接發送區塊
NODE_PATH=$(npm root -g) node test/e2e/lab-toggle-pos.mjs # 試驗功能按鈕位置
NODE_PATH=$(npm root -g) node test/e2e/badge-anchor.mjs  # 步驟 2 的「!」位置
```

## 快速自我檢查

瀏覽器直接開 `https://<worker網址>/?url=<一篇 TVBS 文章網址>`：看到文章首圖就代表 Worker 正常（直接用網址列開不會帶 `Origin`，所以只是檢查抓圖，不涉及網頁授權）。

## 常見問題

| 狀況 | 原因與處理 |
|---|---|
| 回應「圖片網域不在允許名單：xxx」 | TVBS 把圖放在別的網域。把該網域的尾段（例如 `tvbs.com.tw`、`xxx.net`）加進檔案開頭的 `ALLOWED_HOST_SUFFIXES` 後重新部署。 |
| 回應「文章網域不在允許名單」 | 貼的不是 TVBS 網址。 |
| 網頁顯示抓圖失敗但 Worker 網址直接開得到圖 | 網頁的網域不在 `ALLOWED_ORIGINS`（例如自己架在別的網址），把網頁的來源加進去重新部署。 |
