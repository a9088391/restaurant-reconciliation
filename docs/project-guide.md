# 餐飲多門市營業資料對帳與異常追查 v0.1｜專案與測試指南

這是一套供餐飲營運人員在本機使用的對帳工具。操作員同時匯入營業與收款 CSV，按門市、營業日及付款方式比較兩側淨額，再從異常結果追到原始資料列並留下查核紀錄。展示使用固定樣本，採本機單人、免登入模式。

## 使用的程式語言與技術

| 層面 | 技術 | 用途 |
| --- | --- | --- |
| 前端 | JavaScript、Vue 3.5.45、Vite 8.3.8、HTML、CSS | 選擇 CSV、查看對帳批次與來源、處理異常。以 Node.js 24.22.3 建置靜態檔案 |
| 後端 | Ruby 3.4.12、Rails 8.1.4.1、Puma 8.1.0 | 提供同源網頁及 JSON API，驗證 CSV、計算對帳結果並記錄查核。寫入請求使用 Rails 的 CSRF 防護 |
| 資料庫 | PostgreSQL 18.7、Active Record、SQL | 保存原始檔案、來源、結果與查核歷史。以交易、鎖及外鍵維持成對匯入與查核寫入的一致性 |
| 本機環境 | Docker Compose、Dockerfile、Shell | 建置前後端和資料庫，將展示網站綁定在 `127.0.0.1:3216`，用獨立資料卷執行測試與確認式重設 |
| 自動化測試 | Minitest 5.27.0、Playwright 1.64.1、Chromium | 驗證真實 PostgreSQL 上的匯入及交易，以及使用者在瀏覽器中的完整流程 |

## 已交付的功能

- **成對匯入與資料驗證。** 一次提交營業及收款 CSV。每份最多 1 MiB、5,000 筆資料列，每筆金額最高 999,999,999 元。任一側無效就拒絕整次匯入，並指出來源、可定位的紀錄與原因。[CSV 欄位和完整限制](operations.md#固定範例預期結果f01f08)
- **分組對帳。** 按門市、營業日及現金或信用卡分組。正常交易計入淨額，退款扣在退款的營業日，取消只留在來源紀錄。兩側都有資料時顯示「營業淨額減收款淨額」的有號差額。單側缺資料會指出缺少哪一側，已完成的零元交易仍算有資料。
- **來源追查。** 查看分組兩側的原始 CSV 紀錄與位置。退款可追到同批次、同來源及同門市的原交易。只有取消紀錄的分組可在批次來源中查到。
- **異常處理與歷史。** 異常從待處理開始。填寫說明可標記已處理，填寫原因可恢復待處理。每次變更保留狀態、說明和時間，原對帳分類與金額維持原樣。
- **批次重用、更正與重設。** 同一對 CSV 的原始位元組都相同時直接重開既有批次，即使檔名不同。更正內容通過驗證後可建立獨立批次，保留舊結果與歷史。正常重啟會保留資料。確認重設會清空指定本機專案的對帳資料，舊批次識別失效，範例需手動重新匯入。

## 如何測試

以下指令從專案根目錄執行。需要本機 Docker、Docker Compose 和瀏覽器。首次建置會下載映像及套件，Ruby、Node.js 和 PostgreSQL 都在容器內執行。

### 手動操作

1. 依 [操作手冊的本機展示操作](operations.md#本機展示操作)設定 Docker context 並啟動 app。開啟 [本機展示網站](http://localhost:3216)，新資料卷的批次清單應為空。
2. 在「營業 CSV」選取 [sales.csv](../samples/sales.csv)，在「收款 CSV」選取 [payments.csv](../samples/payments.csv)，按「匯入並對帳」。應得到七組結果。A 門市 2026-11-01 信用卡顯示 `+50`，B 門市有分組顯示缺營業或缺收款，C 門市現金零元顯示一致。[F01–F08 完整預期結果](operations.md#固定範例預期結果f01f08)
3. 展開 A 門市 2026-11-03 現金分組的來源。兩側淨額都應是 `-500`，可從部分退款回查 `1,000` 元的原交易。再開啟「查看批次來源紀錄」，確認 C 門市信用卡取消列可查到，對帳表沒有該分組。
4. 在 A 門市 2026-11-01 信用卡分組按「查核」，填寫說明並按「標記已處理」，再填原因按「恢復待處理」。歷史應有兩筆紀錄，差額仍為 `+50`。保存批次網址，依 [正常重啟保存](operations.md#正常重啟保存)停止並啟動服務，再開同一網址確認結果、來源及兩筆歷史仍在。
5. 將兩份樣本各複製一份並改名，原樣重傳應開啟同一批次。另將營業樣本副本第 2 筆 CSV 紀錄的 `1000` 改成 `-1000`，搭配原收款 CSV 重新提交。應顯示營業 CSV 的金額錯誤，批次清單與原查核歷史維持原樣。
6. 如需測試清除，使用可清除的展示資料，依 [明確重設本機展示資料](operations.md#明確重設本機展示資料)核對目標再確認。重設成功並啟動後，清單應為空，舊網址應顯示找不到對帳批次。再次手動上傳固定樣本應建立新批次。

### 自動化測試

Rails 測試使用 `restaurant-reconciliation-t04` 專屬的 `test-db` 與資料卷，涵蓋 CSV 格式和上限、全額與部分退款、匯入重試與併發、交易回滾、查核歷史及請求防護。

```sh
rr_test() {
  docker compose -f compose.test.yaml -p restaurant-reconciliation-t04 "$@"
}
rr_test build backend &&
  rr_test up -d --no-build --wait test-db &&
  rr_test run --rm -T --no-deps backend bin/rails db:migrate &&
  rr_test run --rm -T --no-deps backend bin/rails test
```

執行完畢後用 `rr_test stop test-db` 停止容器，保留測試資料卷。

瀏覽器測試使用 `restaurant-reconciliation-t04-browser`、專屬資料卷及容器內 Chromium。依 [隔離瀏覽器驗證](operations.md#第-04-票隔離瀏覽器驗證)定義 `rr_t04` 並啟動 app。平常執行 25 個回歸案例，涵蓋匯入、來源、查核、重試和批次切換。

```sh
rr_t04 run --rm -T --no-deps browser npm run test:browser
```

若要驗證空庫或重設後的第一輪匯入，先跑下方固定樣本案例，再跑會寫入測試資料的回歸套件。要核對舊批次與查核請求失效，依操作手冊的重設驗證步驟帶入重設前的批次和結果 ID。

```sh
rr_t04 run --rm -T --no-deps -e BROWSER_TEST_T04_FIXED_SAMPLE=yes browser npm run test:browser
```

重啟前後資料比對、模擬寫入鎖衝突及重設重試見 [操作手冊的隔離驗證流程](operations.md#第-04-票隔離瀏覽器驗證)。執行完畢後可用 `rr_t04 stop app db` 停止容器。Playwright 測試輸出位於 `.test-output/t04-browser/playwright/`。

## v0.1 實測結果

- Rails **27 項、1,000 個斷言**通過。Chromium 預設回歸 **24/24**，重設後固定樣本及來源追查均通過。Vite 建置、ESLint、Zeitwerk、RuboCop 與 Brakeman 檢查通過。
- 正常重啟前後，批次、來源及查核歷史一致。隔離測試中，寫入鎖使重設安全失敗，資料維持原樣。解除鎖後重試，四張資料表均清空。重新匯入後，帶有效 CSRF 憑證的舊查核請求回 `404 investigation_not_found`，新批次的查核歷史保持原樣。
- 實測環境為 macOS Apple Silicon、OrbStack、Docker Compose 5.5.0 與 Chromium 156.0.8078.80。重設驗收只使用隔離測試資料卷。
