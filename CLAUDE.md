# CLAUDE.md — Line推播套版產生器

給 Claude Code 的專案指引。**細節以 `README.md`（前端功能）與 `worker/README.md`（Worker 端點、安全規則、部署）為準**；這份只放「動手前必須知道」的架構、規則與工作約定，不重複那兩份的內文。

## 1. 專案是什麼

- 電視台新聞部小編用的網頁工具：貼上過審的推播新聞，自動套進固定版型（新聞 6 宮格／娛樂拍立得 4 格／拼圖），下載 PNG，並可（試驗功能）直接用 LINE 官方帳號推播。
- 線上版：GitHub Pages（`https://unnn3ing-oss.github.io/LinePushPatternTool/`），從 `main` 部署。
- 兩個部署單位，**各自獨立部署**：
  - **前端**：`index.html`，推到 `main` 即上線。
  - **Worker**：`worker/og-image-proxy.js`，**不會**隨 `main` 自動部署，要手動貼到 Cloudflare 後 Deploy。前後端改動若有相依（例如新欄位、新端點），兩邊要一起部署，commit 說明要寫清楚。

## 2. 使用者與溝通約定

- 使用者：莊鈞評，電視台社群小編，也是攝影師（個人帳號 `its.jeannn_`，兩個身分不要混用）。
- **回覆一律繁體中文（台灣口吻）**；結論先行；善用標題、粗體、表格；多方案時列優缺比較；**事實與推論要分開標示**。
- 語氣冷靜、像同事兼顧問；錯誤先理解再修正，不說教。
- 不確定對方代名詞時用「他們／they」，不要從名字推測。
- 介面文字沿用專案既有用語：「推播」不寫「發佈」；測試叫「推播測試」；按鈕 2–4 字動詞片語；全形標點、數字與英文半形；不用 emoji（狀態符號只用 `✓ ✗ ! … · › ×`）。

## 3. 目錄與檔案

| 路徑 | 說明 |
|---|---|
| `index.html` | **全部前端**：純 HTML＋CSS＋原生 JS（Canvas 2D），單檔約 480 KB、約 7900 行，無框架、無建置流程、無外部相依 |
| `worker/og-image-proxy.js` | Cloudflare Worker 單檔（抓文章首圖、試驗功能驗證、S8 OAuth／群發、LINE 直接發送、排程 Cron、推播列表） |
| `worker/test/*.test.mjs` | Worker 單元測試（`node --test`，假 S8／假 LINE） |
| `test/e2e/*.mjs` | 前端 Playwright 驗證（Worker 回應全部攔截假造，不會連真的 LINE／S8）；截圖輸出到 `test/e2e/screenshots/` |
| `assets/` | 版型模板 PNG（Canva 原始匯出，**直接 `drawImage` 疊上，不用程式重繪近似**）、T 寶貼圖、`icons/`（新版圖示，含 `icon.svg` 原始檔）、`help/` |
| `TaipeiSansTCBeta-Bold.woff2／.ttf` | 標題字型；瀏覽器優先 woff2，ttf 僅備援 |
| `.claude/settings.json` | 允許直接編輯 `index.html`、`README.md`、`worker/og-image-proxy.js`、`worker/README.md` |

在 `index.html` 內可用 `grep -n "^// =====" index.html` 找區段；已知的關鍵位置：`TOP_ROW_TEXT_GAP`（約 2569 行）、`DEFAULT_IMAGE_PROXY`（約 4473 行）、`LINE 原生推播（五步驟）`（約 6357 行起）。

## 4. 前端核心規則（改動前先確認不會破壞）

**版型與輸出**
- 新聞 1040×800（兩頁各自獨立，第 1 頁含黃色標籤列）、娛樂 1040×1040（內部 1200 算圖）、拼圖 1080×1080；一律**無損 PNG、內嵌 300dpi（pHYs）**，匯出先 3 倍算圖再精準縮回。
- **檔案必須 < 2MB**（推播平台限制）：超過時自動微調色階（每色 2／4／8／16 階）仍不行才提示換圖。
- 檔名：`下載當天日期＋版型＋Line推播圖_第幾頁.png`（拼圖為 `yyyymmdd拼圖.png`）。
- 本機開啟一定要用 HTTP 伺服器（`file://` 會讓 canvas 被視為跨來源而無法匯出）。

**兩步驟流程（新聞／娛樂）**：① 編輯畫面 → ② 畫面檢查。步驟 2 **鎖定照片、標籤、貼圖**；只有步驟 2 才有「下載本頁／全部下載」。缺圖、缺標題會鎖住「全部下載」；露白（四邊各 3px 有 ≥90% 近白或透明）只提示、不鎖定，但下載前要確認。拼圖沒有這兩步。

**文字排版**：兩行標題左右貼齊格線；字沒塞滿維持自然字距，塞不下才先壓字距（到 0 為止）再縮字級一級，重複到放得下。標點自動轉半形（標題、標籤、頂部標籤、快速填入）。

**快速填入**：`★標題` ＋下一行網址；碰到空格或 `!`／`?` 自動換第二行；標籤兩種寫法（`標籤)標題` 或 `(標籤)標題`），「國際」自動灰底、其餘紅底；兩段標籤的放置規則見 README。
**複製推播連結**：先清掉文章編號之後所有參數，再加追蹤碼——新聞 `?utm_source=LineNewsPush&utm_medium=push`、娛樂 `?utm_source=LineNewsPush&utm_medium=enewsline`。
**抓首圖**：必須經 Worker 代理，只允許 `tvbs.com.tw`；`?imageProxy=` 換成非預設網址（且非 localhost）要先跳確認視窗，因為該網址會收到試驗功能密碼與憑證。

**試驗功能**（右上角，需密碼，8 小時）：第二套介面，含「排入S8」「排入LINE推播（五步驟精靈）」「訊息推播（推播列表／LINE推播設定／S8連結設定）」「右下角狀態泡泡」。**這一塊仍在開發，之後會再更動**（尤其「進階設定」）。

## 5. LINE 原生推播：不可退讓的安全規則

推播送出就收不回，所以這套規則前後端都要守，**前端擋是為了好用，後端擋才算數**：

1. **五步驟**：推播內容 → 推播設定（操作人／帳號／立即或排程）→ **推播測試（滑動才送、只傳給操作人一位）** → 推播預覽（**親手輸入好友數**才亮紅色確認鈕）→ 推播狀態（**成功才鎖定**，失敗不鎖定）。
2. 換操作人、換帳號、內容有更動 → 測試結果作廢，退回對應步驟並說明原因。
3. 群發一定要「**同一個帳號先成功測試過**」（`testToken`，1 小時，綁頻道）＋好友數比對（差距 2%、至少 50 人；小帳號更嚴）＋額度足夠＋先 `validate`＋每次帶 `X-Line-Retry-Key`（UUID，重送不會重複發）。
4. **`LINE_ALLOW_OFFICIAL` 保持不設**：新聞／娛樂正式帳號的 broadcast 因此維持鎖死；測試帳號可直接群發給所有好友；正式帳號的「測試推播」靠權限管理名單 multicast，不需要這個旗標。**不要為了方便把它打開。**
5. 測試推播每次最多 1 位、只能是權限名單內的人；Worker 只允許約 12 個 LINE 端點，**沒有 push／narrowcast**，不改頻道設定、不重發 token。
6. **不確定有沒有成功時要老實講**：網路中斷時既不說失敗也不說成功，請使用者先到推播列表確認；並沿用同一把重試金鑰。
7. 排程：由 Worker Cron 每分鐘發送（**Cron Trigger `* * * * *` 要自己設**）；時間限制 5 分鐘後～14 天內；精靈內不能改時間，只能到推播列表取消；超過預定時間 30 分鐘未發就放棄。
8. S8 路徑：只建立草稿，或使用者明確選「設定排程」（+30 分鐘～+7 天，會實際發送）；程式內**不存在** resume／立即發送路徑，也不要新增。

**絕對不要做**：在 LINE 後台重新發行 Channel secret／長效 token、改頻道 Webhook URL（正式帳號是 S8 在用，會讓串接中斷）；把 Channel secret、`LAB_PASSWORD`、`LINE_ADMIN_*` 貼進對話、程式碼或 commit。**也不要向使用者索取這些密碼或 token**——設定由使用者自己在 Cloudflare 完成。

## 6. Worker 設定備忘

Secrets（Cloudflare → Worker → Settings → Variables and Secrets）：`LAB_PASSWORD`（試驗功能密碼；沒設＝一律 503）、選填 `LAB_SIGNING_KEY`、`LINE_CHANNEL_ID_/SECRET_` + `TEST｜NEWS｜ENT`、`LINE_ADMIN_USER`／`LINE_ADMIN_PASS`（沒設＝進階設定整個關閉）、`LINE_ALLOW_OFFICIAL`（不設）。R2 bucket 綁定變數名必須是 `LINE_IMG`（存圖片、`testers/`、`sched/`、`hist/`，**圖片要一直留著**）。`ALLOWED_ORIGINS`、`ALLOWED_HOST_SUFFIXES` 在檔案開頭。完整步驟見 `worker/README.md`。

## 7. 開發、測試與 Git 流程

```bash
node --test worker/test/*.test.mjs            # Worker；目前基準：110 全過
python3 -m http.server 8960 &                 # 前端 e2e 前先起伺服器（專案根目錄）
NODE_PATH=$(npm root -g) node test/e2e/<檔名>.mjs   # Playwright；各檔頭註解寫明用途
```

- 改前端行為 → 跑相關的 `test/e2e/*.mjs`；改 Worker → 跑 `worker/test`；**新增行為要補測試**，並維持「Worker 回應全用假的」原則，測試不得連真的 LINE／S8。
- **功能改動要同步更新 `README.md`（前端）與／或 `worker/README.md`（Worker）**——這兩份就是功能規格，使用者靠它確認行為。
- **分支**：在指定開發分支（目前 `claude/ecstatic-curie-6oztus`）開發、commit、push。**只有使用者明確說「推」才合併到 `main`**（上線）；沒被要求不要開 PR。合併前先 `git fetch` 確認 `main` 有沒有新 commit，以快轉（ff-only）合併，不覆蓋他人提交。
- Commit 訊息用繁體中文，描述「改了什麼、為什麼」；結尾加專案要求的 `Co-Authored-By`／`Claude-Session` 兩行；**不要在 commit、程式註解或產出物中寫入模型型號**。
- 驗證要誠實：沒實際看到的（例如真實 LINE 手機畫面、瀏覽器 favicon 快取、iOS 主畫面圖示）要講「未驗證」。

## 8. 視覺與圖示

- **品牌黃** `#FFE600`、墨色 `#151515`；圖示為「推」字（取自 `TaipeiSansTCBeta-Bold.ttf` 轉成 SVG 路徑）＋右上角圓點與雙道訊號弧，原始檔 `assets/icons/icon.svg`。要改圖示就改 SVG 再重新匯出 `favicon.ico`（16/32/48/64/128/256）、`favicon-16/32.png`、`icon-192/512.png`、`apple-touch-icon.png`（180，滿版方形，不做透明圓角）。檔名與 `index.html` 第 7–11 行的引用要維持不變。
- 「推播精靈」的畫面與流程規格已另存為 Claude Design 設計系統（artifact `QsDEmR9h8wwpiEY8HanfyD`，預設私人）；要把精靈搬到別的專案時以它為準，**專案內不再保留該設計成品的檔案**。

## 9. 已知待辦與暫緩項目（已與使用者確認，勿擅自處理）

| 項目 | 狀態 |
|---|---|
| 管理者登入安全性建議：`/line/testers/list` 回傳 userId 給任何有試驗憑證者、`/line/admin/login` 缺少次數限制（需另靠 Cloudflare rate limiting）、登入簽章金鑰的組成方式 | **使用者決定暫緩**；「進階設定」與試驗功能之後會再改，等通知再動 |
| 部署相關：Worker 重新部署、設定 `LINE_ADMIN_USER`／`LINE_ADMIN_PASS`、確認 github.io 上線結果、`LAB_SIGNING_KEY` 是否已設 | 使用者自行操作；**目前是否已完成未驗證** |
| `README.md` 與 `worker/README.md` 內若仍有「喇叭」圖示或舊流程描述 | 發現就順手更正 |
