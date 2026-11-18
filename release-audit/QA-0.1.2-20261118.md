# Docxwise 0.1.2 — 修正 Obsidian 社群自動檢查（2026-11-18，台北時間）

起因：community.obsidian.md 對 0.1.1（7bc5bec）的自動檢查回報錯誤「Code creates script elements at runtime」，另有兩個警告與數個建議。0.1.2 只修這些，價格、功能、結帳流程（CHECKOUT_READY=true、`https://formchime.com/api/checkout?product=docxwise-pro`、US$19）都沒改。

本機 build：main.js sha256 `8ab02cdbc7a63e52546608fb5b72dc6a2cf1abf03634904179fba747884450fc`（1598319 bytes），manifest.json `d9eae553…f409ff`，styles.css `6f3b979a…eca2ea6`（與 0.1.1 相同）。

## 1. 建立 script 元素的來源與修法
- 來源是 jszip。`jszip` 的 package.json `browser` 欄位把入口指到預先打包好的 `dist/jszip.min.js`，裡面內建兩個舊 polyfill：
  - `lie`（Promise polyfill）→ `immediate`：用 `document.createElement("script")` 的 onreadystatechange 排程（給舊 IE）。
  - `setimmediate`：同樣的 script 技巧，另外 `typeof cb !== "function"` 時會 `new Function("" + cb)`（main.js 裡唯一的 new Function）。
- 我們自己的程式沒有建立 script。
- 修法（esbuild.config.mjs 的 `shims` 外掛）：
  - `jszip` 改從 `node_modules/jszip/lib/index.js` 原始碼打包（跳過預打包檔）。
  - `lie` → `src/shims/lie.ts`（匯出原生 Promise；jszip 只在沒有全域 Promise 時才用 lie，Obsidian 一定有，所以執行時根本不會用到）。
  - `setimmediate` → `src/shims/setimmediate.ts`：和原版一樣「只在沒有 setImmediate 時才安裝」（桌面版 Obsidian 本來就有 Node 的 setImmediate），改用 MessageChannel（後備 window.setTimeout），不建 script、不接受字串、不用 new Function。
  - `readable-stream` → `src/shims/readable-stream.ts`（空模組；只給 generateNodeStream 用，我們沒用；預打包版同樣沒有 stream）。
- 結果：main.js `grep -c 'createElement("script")\|createElement('"'"'script'"'"')'` = 0；`new Function` = 0；`eval(` 只剩 highlight.js 語法表裡的關鍵字字串。

## 2. 警告與建議
| 項目 | 處理 |
|---|---|
| 設定分頁沒有 getSettingDefinitions()（main.ts:256） | 已實作。所有列整理成同一份 rows（名稱、說明、visible、build），1.13+ 由 getSettingDefinitions() 以 group＋render 定義渲染（會進設定搜尋）；1.5–1.12 由 display() → renderLegacy() 照舊畫。重新整理改走 refresh()：`requireApiVersion('1.13.0') ? this.update() : renderLegacy()`。區域查詢只在畫面渲染時才啟動（不會在建搜尋索引時就連網）。 |
| display 已淘汰（294、304、305、335） | 這幾處原本都是 `this.display()` 重畫，已全部改成 refresh()；display() 只保留給 1.13 以前的版本（minAppVersion 1.5.0，官方 lint 的 require-display 也要求保留）。 |
| obsidianHost.ts:94 document.createElement | 改成 Obsidian 的 `createEl('canvas')`。 |
| release 附了 SHA256SUMS | release.yml 改成直接發正式 release（不是草稿），只附 main.js、manifest.json、styles.css，sha256 寫在 release 說明。attest 步驟保留。 |
| 列舉全部 vault 檔案（getAllLoadedFiles） | 沒改：用在路徑建議與資料夾選擇器，本來就需要列出全部檔案／資料夾。 |
| localStorage | 沒改：deviceLabel.ts 在 1.8.7+ 已用 app.loadLocalStorage，只有更舊的版本才退回 window.localStorage（minAppVersion 1.5.0 需要）。 |
| eval / new Function | new Function 已隨 setimmediate 移除；剩下的「eval」只是 highlight.js 語言關鍵字字串，不是呼叫。 |

## 3. 測試
| 項目 | 結果 |
|---|---|
| npm run build + npm test | 通過（授權 17 項、5 個 docx xml-ok）→ npm-build-test-20261118.txt |
| 官方 eslint-plugin-obsidianmd 0.6.0 | 0 錯誤 0 警告 → eslint-20261118.txt |
| 真 Obsidian 1.15.1（box Xvfb，全新 vault） | 6 個樣本匯出成功（Welcome、Empty、Title、Big、Research-APA、Research-ChicagoNotes），docx 在 qa-0.1.2-20261118/docx/ |
| 與 0.1.1 輸出比對 | Welcome、Empty、Title 除 docProps/core.xml（時間）外逐位元相同；Research-APA／ChicagoNotes 只差超連結隨機 rId；Big 的樣本筆記是重建的（原筆記已不在），每節多一個公式，所以數量不同（450 oMath），不是回歸 |
| 沒有 setImmediate 的環境（模擬手機）| 把 window.setImmediate 拿掉後重新載入外掛：改用 shim、匯出 Chicago 與 Big 成功、結果與正常匯出相同；傳字串會被拒絕 |
| OpenXmlValidator Office2019／Microsoft365 | 6 檔 0 錯誤 → openxml-validate-20261118*.txt；暫存 .NET 已刪 |
| 設定頁（1.13+ 宣告式） | 全部列正常；Style file 只在選 custom 時出現；區域查詢後出現 Get Docxwise Pro；同意前按 Buy 不開網址、同意後只開 `https://formchime.com/api/checkout?product=docxwise-pro`（攔截 window.open，未付款）；設定搜尋找得到「Docxwise › Citation style」→ s1/s2/s3 截圖 |
| 設定頁（舊版渲染） | 在 1.15.1 直接呼叫 renderLegacy()：列與標題順序與 0.1.1 相同 |
| 發現並修掉 | 1.13+ 重畫時會沿用同一列的 infoEl，同意區塊會重複出現；改成先移除舊區塊並回傳清除函式 |

## 4. 仍未查證
- 真的 Obsidian 1.5–1.12 執行（只用 1.15.1 呼叫舊版渲染路徑模擬）。
- 真手機、Word 實機開檔、真實付款與授權碼啟用、日本 IP。
