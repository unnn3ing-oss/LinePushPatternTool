# 推播精靈（五步驟）設計成品

「發出去就收不回」的操作流程範本：**推播內容 → 推播設定 → 推播測試 → 推播預覽 → 推播狀態**。從「Line推播套版產生器」的「LINE原生推播」抽出來，給其他專案重複使用。

| 檔案 | 說明 |
|---|---|
| [`wizard-template.html`](wizard-template.html) | 可執行的範本。單一檔案、零依賴、內建假後端，**雙擊就能玩**（右上示範控制列可模擬測試失敗、網路中斷、操作人被移出名單…） |
| [`SPEC.md`](SPEC.md) | 設計規格：原則、流程、擋關規則、作廢規則、狀態模型、安全與冪等、後端 API 契約、元件規格、搬運指南、踩過的坑、給 AI 的移植提示詞 |
| [`shots/`](shots) | 各步驟截圖（`1-content`、`2-setup`、`3-test`、`4-preview`、`4b-confirm`、`5-status`、`6-dark`） |

## 快速開始

1. 用瀏覽器打開 `wizard-template.html`，從第 1 步按到第 5 步。
2. 讀 `SPEC.md` 第 2～4 節（流程／擋關／作廢），這是整個設計的核心。
3. 搬運：照 `SPEC.md` 第 9 節的清單，改 `CONFIG`、換 `Api`、接你的內容模型，刪掉 `Mock` 與示範控制列。

## 驗證

```bash
NODE_PATH=$(npm root -g) node test/e2e/wizard-template.mjs        # 47 項；範本用 file:// 開，不需要 server
SHOTS=1 NODE_PATH=$(npm root -g) node test/e2e/wizard-template.mjs  # 同時更新 shots/ 的截圖
```
