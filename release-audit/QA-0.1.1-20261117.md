# Docxwise 0.1.1 候選 — 使用者驗收報告（2026-11-17，台北時間）

範圍：只在本機。沒有推送、沒打 tag、沒發 release、沒部署閘道或 Pages、沒登入任何網站、沒花錢、沒聯絡任何人。
本機分支 `release-0.1.1`（基於 main c1cf68c）。發布包 `release/0.1.1/`（main.js、manifest.json、styles.css、SHA256SUMS、RELEASE-INFO.md；release/ 在 .gitignore 內，不進 git）。

最終 main.js sha256：`05b298635874d12cd9c1d88082abecde6869c9475f7b7f8d63b5756c9a97d68b`（1606501 bytes；再建一次相同）。
manifest.json `e66adece…b55b04b`（只有 version 改 0.1.1，minAppVersion 仍 1.5.0）、styles.css `6f3b979a…eca2ea6`（與 0.1.0 相同）。

## 1. 建置與程式修改
| 項目 | 結果 |
|---|---|
| CHECKOUT_READY | false → **true**（src/license/checkout.ts）；測試改成斷言 true 與網址 |
| 過時註解 | checkout.ts、consent.ts 的 PLACEHOLDER 註解已改（條款頁 11/16 上線，今天 curl terms／privacy 皆 200） |
| 版本 | manifest.json／package.json／package-lock.json 0.1.1；versions.json `{"0.1.0":"1.5.0","0.1.1":"1.5.0"}` |
| Buy Pro 網址 | `https://formchime.com/api/checkout?product=docxwise-pro`（原碼已是此網址）；進入前先查 /api/region，日本隱藏（BuyGate，單元測試覆蓋；真日本 IP 未實測） |
| npm run build + npm test | 通過（授權 17 項、5 個 docx xml-ok）→ npm-build-test-20261117.txt |
| 官方 eslint | 0 錯誤、1 警告（getSettingDefinitions，刻意保留）→ eslint-20261117.txt |
| OpenXmlValidator（Office2019、Microsoft365） | 6 檔（用 0.1.1 在全新 vault 匯出）0 錯誤 → openxml-validate-20261117*.txt；暫存的 .NET SDK 已刪 |

## 2. 真 Obsidian 1.15.1 使用者驗收
環境：box 上 Xvfb，`.obsidian-app/`，全新 vault（只放 release/0.1.1 三個檔、sha256 驗證 OK；信任作者後啟用）。截圖在 `qa-0.1.1-20261117/`，匯出的 docx 在 `qa-0.1.1-20261117/docx/`，LibreOffice 轉出的頁面圖在 `render/`。
注意：截圖 00–f 與 g-buy／g-fake-key／g-pro-locked 是修正前的 build 拍的（修正只動「Merging notes」檢查順序和一句說明文字，見第 3 節）；最後一次建置後，我重新匯出 6 個 docx 驗證（OpenXmlValidator 驗的就是這批），並重測了資料夾合併的提示。

| 項 | 做了什麼 | 結果 | 截圖 |
|---|---|---|---|
| (a) | 什麼都不設定，匯出含清單、表格、callout 的一般筆記 | 成功，通知「Updated/Saved Welcome.docx」＋ Show in folder；通知含「Exporting…」進度提示 | a-welcome-default.png |
| (b) | 空筆記、只有標題的筆記 | 都成功產出（空筆記是空文件、不報錯；只有標題＝一個 Heading 1）；check.py xml-ok | b-empty.png、b-title-only.png |
| (c) | 150 節＋150 行內公式＋150 顯示公式（共 300 個 oMath）＋150 個引用＋ 301 列×8 欄表格 | 從下指令到通知出現 441–581 ms（兩次量測），介面沒卡；docx 內 300 個 oMath、301 個表格列，無殘留佔位字 | c-big.png |
| (d) | 含參考文獻與數學式的研究筆記，APA 與 Chicago 註腳 | APA：書目與 8 個公式；Chicago：4 條 Word 註腳＋書目；LibreOffice 目視正確（公式、callout、註腳都在） | d-research-apa.png、d-research-chicago-notes.png、render/Research-ChicagoNotes-1.png |
| (e) | 淺色／深色主題的設定頁與 Pro 區 | 全部跟隨主題變數，樣式與 Obsidian 原生設定一致，沒看到黑底白字寫死的地方（深色圖用 X 螢幕擷取，因為 CDP 對彈出視窗會拍到舊畫面） | e-settings-light-*.png、e-settings-dark-top／pro.png |
| (f) | `app.emulateMobile(true)` 匯出與設定頁 | 匯出成功（docx xml-ok）；設定頁以手機式彈窗顯示、Pro 區排版正常 | f-mobile-export.png、f-mobile-settings*.png |
| (g) | Pro 未授權、Buy Pro、假授權碼 | ① 未勾同意按 Buy Pro：按鈕 aria-disabled，紅字「Check the box above to continue.」，沒有開網址。② 勾同意後按：攔截 window.open，記到唯一一次 `https://formchime.com/api/checkout?product=docxwise-pro`（沒真的開、沒付款）。③ 條款／隱私連結：/docxwise/terms、/docxwise/privacy。④ 假碼：「Pro is locked: this key isn't active. License key not recognised, revoked or expired.」（有對 api.polar.sh 打一次啟用請求，假碼，無扣款）；之後按 Remove 清掉。⑤ 未授權按合併指令：「Merging notes is part of Docxwise Pro. Add a license key in Settings → Docxwise.」 | g-buy-unchecked-click.png、g-buy-checked-click.png、g-fake-key-error.png、g-pro-locked-notice.png、g-pro-folder-gate-mobile.png |

## 3. 發現並修掉的問題
1. **資料夾合併（Pro）指令**：免費使用者要先選完資料夾，才被告知這是 Pro。改成一按指令就先提示、不開選單（src/main.ts）。重建後重測：提示出現、選單沒開（手機模擬也測）。
2. **設定頁說明「not available in Japan (see README)」**：使用者不知道 README 在哪。改成「not sold in Japan.」（條款連結就在下方）。
3. CHECKOUT_READY、註解、版本號（第 1 節）。

沒有發現需要修的醜或難懂之處；沒做版面微調。

## 4. 仍未查證
- **Word 實機顯示**：本次沒在 Word 開（OpenXmlValidator 0 錯誤、LibreOffice 目視正常，不等於 Word 顯示正常）。0.1.0 範例檔 11/14 Roger 用 Word 開過無錯誤，0.1.1 的輸出沒有人在 Word 開過。
- **真手機**（iOS／Android）：只做過 emulateMobile。
- **Obsidian 1.5–1.14**：只在 1.15.1 跑過（minAppVersion 1.5.0 由 lint 的 API 檢查支撐）。
- **日本 IP 隱藏 Buy Pro**：只有單元測試，沒真日本 IP。
- **真實付款與授權碼啟用**（含 benefit_id 比對）：沒有真碼可測；線上閘道 docxwise-pro 目前 410（停用，屬正常），enabled:true 版尚未部署，所以「從 Buy Pro 到 Polar 結帳頁」整條路要等送審當天部署閘道後才能走（不付款，只確認 302）。
- 這次匯出的 docx 在 Obsidian 內「Open after export」啟動預設程式：沒測（box 沒有 Word）。
- 模擬手機模式下通知仍顯示 Open／Show in folder 按鈕（emulateMobile 不等於真手機行為）。
- 環境怪癖：1.15.1 設定視窗是獨立彈出視窗，此時通知會出現在該視窗；非外掛問題。

## 5. 結論
見 PIPELINE.md 第 4 天段落：**可送審品質：是**（附帶「Word 實機未查證」的風險，建議送審前請 Roger 用 Word 開 Research-ChicagoNotes.docx 與 Big.docx 各一次）。
