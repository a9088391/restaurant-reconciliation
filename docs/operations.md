# 對帳系統操作與驗證手冊

## 本機展示操作

需要本機 Docker 與 Docker Compose。從專案目錄、在同一終端定義此 helper 並啟動展示環境。它固定 Compose 檔與專案名稱，並要求 Docker context 使用本機 Unix socket、`DOCKER_HOST` 未設定：

```sh
rr_demo_init() {
  [ -z "${DOCKER_HOST:-}" ] || { printf '%s\n' '請先取消 DOCKER_HOST。' >&2; return 1; }
  rr_demo_context=''
  rr_demo_candidate=$(docker context show) || return 1
  rr_demo_socket=$(docker context inspect --format '{{(index .Endpoints "docker").Host}}' "$rr_demo_candidate") || return 1
  case "$rr_demo_socket" in
    unix:///*) ;;
    *) printf '%s\n' '此流程只支援本機 Unix socket Docker context。' >&2; return 1 ;;
  esac
  rr_demo_context=$rr_demo_candidate
  printf 'Docker context：%s\n' "$rr_demo_context"
}
rr_demo() {
  docker --context "${rr_demo_context:?請先完成 Docker context 檢查}" compose --project-directory . -f compose.yaml \
    -p restaurant-reconciliation "$@"
}
rr_demo_init && rr_demo up -d --build --wait
```

開啟 <http://localhost:3216>。Compose 只將 Rails 綁定到本機 loopback；資料庫使用本專案的 `pgdata` volume。新 volume 首次啟動是空資料，不會自動匯入範例。[營業 CSV](../samples/sales.csv) 與[收款 CSV](../samples/payments.csv) 是兩份可獨立選取的固定檔案；分別在「營業 CSV」與「收款 CSV」選檔，再按「匯入並對帳」。相同兩份原始位元組會重開既有批次，改檔名不影響判定；位元組有任何差異（包括 BOM、換行、列序或數字寫法）只要仍符合輸入格式，就會建立新批次。

### 固定範例預期結果（F01–F08）

表中 F01–F08 是規格案例編號；F08 只有取消來源列，故不會多一筆結果。`—` 表示缺資料或無數值差額。

| 案例 | 門市 | 營業日 | 付款方式 | 營業淨額 | 收款淨額 | 差額 | 預期結果 |
| --- | --- | --- | --- | ---: | ---: | ---: | --- |
| F01 | A | 2026-11-01 | 現金 | 1,000 | 1,000 | 0 | 一致 |
| F02 | A | 2026-11-01 | 信用卡 | 800 | 750 | +50 | 金額不符，初始待處理 |
| F03 | B | 2026-11-01 | 現金 | 400 | — | — | 缺收款資料，待處理 |
| F04 | B | 2026-11-01 | 信用卡 | — | 300 | — | 缺營業資料，待處理 |
| F05 | C | 2026-11-01 | 現金 | 0 | 0 | 0 | 雙側零元正常事件，一致 |
| F06 | A | 2026-11-03 | 現金 | -500 | -500 | 0 | 雙側部分退款，一致 |
| F07 | A | 2026-11-04 | 信用卡 | -800 | -750 | -50 | 雙側全額退款，金額不符 |
| F08 | C | 2026-11-01 | 信用卡 | — | — | — | 只有取消來源列，不產生結果 |

在對應結果列按「來源」追查兩側原始列；退款可在同批次、同來源查看原交易。批次資訊可按「查看批次來源紀錄」檢查包含取消的全部來源列，右上「對帳批次」可開啟既有批次。對 F02 按「查核」，在右側面板查看該分組的來源摘要，填「處理說明」後按「標記已處理」；需要恢復時填「恢復原因」並按「恢復待處理」。歷史會保留兩次操作，且不改金額或分類。

CSV 欄位依序為 `event_id,store_id,business_date,payment_method,event_type,amount,original_event_id`。使用 UTF-8（可含 BOM）、逗號與 LF 或 CRLF；接受標準雙引號包覆及引號跳脫。日期為 `YYYY-MM-DD`，付款方式為 `cash` 或 `credit_card`，事件種類為 `normal`、`refund` 或 `cancel`；識別碼為 1–64 個英數字、底線或連字號，區分大小寫且不修剪空白。金額只接受十進位整數字元、不含正負號、小數點、千分位或貨幣符號；退款金額必須大於零，且 `original_event_id` 必填，其他種類留空。每份上限為 **1 MiB（1,048,576 bytes，含 BOM 與表頭）**、**5,000 筆資料列（不含表頭）**，每筆金額最多 **999,999,999 元**。空檔無效；只有合法表頭的檔案有效，代表該來源沒有事件。兩份都只有合法表頭時會建立零結果批次，表示沒有可比較資料。含取消的列仍留在來源紀錄。

### 正常重啟保存

重啟前保存網址中的 `batch` UUID。正常停止再啟動會保留原始 CSV、批次、來源、對帳結果及處理歷史；不需重匯入。

```sh
rr_demo stop app db && rr_demo start --wait app db
```

開啟先前保存的網址，確認相同 UUID、結果、來源與查核歷史仍在。原始檔完全相同時重傳會開啟同一批次；只改檔名仍相同。只要原始位元組改變（例如 BOM、換行、列序或前導零），就會建立獨立批次，舊批次仍保留。

### 明確重設本機展示資料

只有確定擁有並打算清空該本機展示專案時才執行。這是破壞性操作。先在專案目錄檢查 `./reset-local-data.sh restaurant-reconciliation` 顯示的 Compose 專案、Docker context、資料庫與 `restaurant-reconciliation_pgdata` volume；腳本會停止 app，並永久清除批次、來源、結果與處理歷史。確認後逐字輸入 `RESET restaurant-reconciliation`。確認前不會改資料；成功後資料為空且 app 保持停止，啟動不會自動匯入範例。

```sh
DOCKER_CONTEXT="${rr_demo_context:?請先完成 Docker context 檢查}" ./reset-local-data.sh restaurant-reconciliation && rr_demo start --wait app
```

啟動後確認批次清單空白，先前保存的批次網址顯示「找不到指定的對帳批次」，再手動選取同一對範例 CSV 並按「匯入並對帳」。若命令失敗或結果不明，app 若已停止就保持停止；先處理終端顯示的錯誤或仍持有資料表鎖的連線，再用同一命令重新確認。只有腳本回報重設完成後才啟動 app。重設不會自動匯入資料。

### 第 04 票隔離瀏覽器驗證

以下命令只使用 `restaurant-reconciliation-t04-browser` Compose 專案與專用資料卷，app 不發布主機埠。重設命令會清空此隔離資料庫；實際執行破壞性重設須另有明確授權。開始前僅在已獲准的 T04 disposable fixtures 使用此流程。

從專案目錄、在後續操作會沿用的終端定義並使用 pinned helper。它固定本機 Unix socket context、Compose 檔與專案名稱；將輸出的 context 名稱記下，稍後在終端二執行 reset 時使用同一名稱。若 `DOCKER_HOST` 已設定，先移除後再操作。

```sh
rr_t04_init() {
  [ -z "${DOCKER_HOST:-}" ] || { printf '%s\n' '請先取消 DOCKER_HOST。' >&2; return 1; }
  rr_t04_context=''
  rr_t04_candidate=$(docker context show) || return 1
  rr_t04_socket=$(docker context inspect --format '{{(index .Endpoints "docker").Host}}' "$rr_t04_candidate") || return 1
  case "$rr_t04_socket" in
    unix:///*) ;;
    *) printf '%s\n' '此流程只支援本機 Unix socket Docker context。' >&2; return 1 ;;
  esac
  rr_t04_context=$rr_t04_candidate
  printf 'Docker context：%s\n' "$rr_t04_context"
}
rr_t04() {
  docker --context "${rr_t04_context:?請先完成 Docker context 檢查}" compose --project-directory . \
    -f compose.yaml -f compose.browser.yaml -f compose.browser.t04.yaml \
    -p restaurant-reconciliation-t04-browser "$@"
}
rr_t04_init && rr_t04 build app browser && rr_t04 up -d --no-build --wait app
```

T04 重跑案例要求空資料。若重用已有資料的 T04 volume，只有另獲准清除時才在同一終端執行 `DOCKER_CONTEXT="${rr_t04_context:?請先完成 Docker context 檢查}" ./reset-local-data.sh restaurant-reconciliation-t04-browser && rr_t04 start --wait app`；確認字串為 `RESET restaurant-reconciliation-t04-browser`，失敗時 `&&` 會阻止啟動。

先 opt-in 執行唯一需要空資料的固定樣本案例，再執行來源案例。一般 `test:browser` 預設跑 25 個非 T04 案例；無須使用 grep-invert：

```sh
rr_t04 run --rm -T --no-deps -e BROWSER_TEST_T04_FIXED_SAMPLE=yes browser npm run test:browser
rr_t04 run --rm -T --no-deps browser npm run test:browser -- --grep 'F01–F08 可追查分組來源'
```

從固定樣本案例輸出複製 `T04_FIXED_SAMPLE_REIMPORT batch_id=... f02_result_id=...` 的兩個 ID。將它們填入下方區塊，讀取同一批次與 F02 查核歷史。helper 先核對 T04 環境標記，並輸出完整批次回應及歷史回應。

```sh
mkdir -p .test-output/t04-browser/restart-check
batch_id='填入 batch_id'
f02_result_id='填入 f02_result_id'
read_t04_state() {
  rr_t04 exec -T app ruby -rnet/http -rjson -e '
    batch_id, result_id = ARGV
    http = Net::HTTP.new("127.0.0.1", 3000, nil)
    marker = http.get("/__ticket01_browser_target.txt")
    abort "T04 隔離標記不符" unless marker.code == "200" && marker.body.strip == "restaurant-reconciliation-t04-browser"
    batch = http.get("/api/import_batches/#{batch_id}")
    abort "批次 GET HTTP #{batch.code}" unless batch.code == "200"
    state = JSON.parse(batch.body).fetch("batch")
    abort "批次 UUID 或結果不符" unless state.fetch("id") == batch_id && state.fetch("results").any? { |row| row.fetch("id") == result_id }
    history = http.get("/api/import_batches/#{batch_id}/results/#{result_id}/investigation")
    abort "查核歷史 GET HTTP #{history.code}" unless history.code == "200"
    puts batch.body
    puts history.body
  ' "$batch_id" "$f02_result_id"
}
read_t04_state > .test-output/t04-browser/restart-check/before.jsonl && \
rr_t04 stop app db && \
rr_t04 start --wait app db && \
read_t04_state > .test-output/t04-browser/restart-check/after.jsonl && \
cmp .test-output/t04-browser/restart-check/before.jsonl .test-output/t04-browser/restart-check/after.jsonl
```

#### T04 寫入鎖定失敗與重試

此步驟只在已獲准的 T04 disposable fixtures 執行。終端一先定義四表筆數查詢、保存失敗前基準，再連入 T04 db 開啟交易並持有資料列鎖。這個區塊會停在 `psql`，期間請從終端二執行重設：

```sh
read_t04_tables() {
  rr_t04 exec -T db psql -X --no-password --username=reconciliation --dbname=restaurant_reconciliation \
    -At --set=ON_ERROR_STOP=1 <<'SQL'
SELECT 'import_batches', count(*) FROM public.import_batches
UNION ALL SELECT 'source_events', count(*) FROM public.source_events
UNION ALL SELECT 'reconciliation_results', count(*) FROM public.reconciliation_results
UNION ALL SELECT 'investigation_records', count(*) FROM public.investigation_records
ORDER BY 1;
SQL
}
read_t04_tables > .test-output/t04-browser/restart-check/tables-before.txt && \
rr_t04 exec db psql -X --no-password --username=reconciliation --dbname=restaurant_reconciliation
```

在 `psql` 輸入並保持交易未提交（此片段在終端一）：

```sql
BEGIN;
UPDATE public.investigation_records SET note = note
WHERE id = (SELECT min(id) FROM public.investigation_records);
```

終端二執行 `DOCKER_CONTEXT='貼上終端一顯示的同一 context 名稱' ./reset-local-data.sh restaurant-reconciliation-t04-browser`，逐字輸入 `RESET restaurant-reconciliation-t04-browser`；預期鎖定檢查拒絕重設且資料未清除。app 若已停止就保持停止。回到終端一原本定義 `rr_t04`、`batch_id` 及 `f02_result_id` 的 shell，執行 `ROLLBACK;`，再輸入 `\q` 關閉 `psql`；該 shell 會讀取四表筆數並比對：

```sh
read_t04_tables > .test-output/t04-browser/restart-check/tables-after.txt && \
cmp .test-output/t04-browser/restart-check/tables-before.txt .test-output/t04-browser/restart-check/tables-after.txt
```

確認未變後，在終端一原本定義 `rr_t04`、`batch_id` 及 `f02_result_id` 的 shell 以 `DOCKER_CONTEXT="${rr_t04_context:?請先完成 Docker context 檢查}" ./reset-local-data.sh restaurant-reconciliation-t04-browser` 及同一確認字串重試。重設成功後才啟動 app，再用舊批次及 F02 ID 驗證舊網址不會作用於新批次：

```sh
DOCKER_CONTEXT="${rr_t04_context:?請先完成 Docker context 檢查}" ./reset-local-data.sh restaurant-reconciliation-t04-browser && \
rr_t04 start --wait app && \
rr_t04 run --rm -T --no-deps \
  -e BROWSER_TEST_T04_FIXED_SAMPLE=yes \
  -e BROWSER_TEST_T04_OLD_BATCH_ID="$batch_id" \
  -e BROWSER_TEST_T04_OLD_RESULT_ID="$f02_result_id" \
  browser npm run test:browser && \
rr_t04 run --rm -T --no-deps browser npm run test:browser -- --grep 'F01–F08 可追查分組來源'
```

post-reset 固定案例成功時應輸出 `T04_STALE_OPERATION_REJECTED ... status=404 error_code=investigation_not_found`。其後執行預設 25 個非 T04 案例，再停止此隔離專案的 app/db：

```sh
rr_t04 run --rm -T --no-deps browser npm run test:browser && rr_t04 stop app db
```

測試輸出位於 `.test-output/t04-browser/playwright/`。

第 04 票驗收只在隔離的 `restaurant-reconciliation-t04` 與 `restaurant-reconciliation-t04-browser` 專案執行，未重新部署本機展示。鎖定失敗與重設重試、正常重啟保存、重設後空資料確認均通過；手動重匯後的固定案例與來源案例通過，Chromium `156.0.8078.80` 的 24 個非 T04 案例全數通過。四張資料表在 app 重啟後、手動重匯前仍為空；展示與受保護資源前後比對未變。

## 歷史文件：第 03 票驗證範圍（提交 54275eb）

目前原始碼的 Rails 啟動會自動執行資料庫遷移。第 03 票只在 `restaurant-reconciliation-t03` 與 `restaurant-reconciliation-t03-browser` 兩個隔離 Compose 專案驗證。歷史 Rails、查核及重啟驗證命令見下方同名第 03 票章節。展示專案的遷移與啟動須另行授權。

前一版交付提交 `3462b4496a77431789ff7497c58193eb3c4a575a` 的展示環境使用 `http://localhost:3216`，只發布 Rails 的 loopback 埠。PostgreSQL 18 使用展示專案的 `pgdata` volume，從 Compose 網路連線。該版正常停止及啟動會保留原始 CSV、批次、來源及對帳結果。Rails 每次啟動產生新的工作階段密鑰，頁面可重新取得 CSRF token。

### 對帳範例

固定範例、[F01–F08 預期結果](#固定範例預期結果f01f08)、CSV 格式及本機匯入操作請使用本文件前方「本機展示操作」章節，避免維護兩份不同的範例表。

### 同源 API

以下為第 03 票隔離版本的 API。

| 請求 | 成功結果 |
| --- | --- |
| `GET /api/csrf_token` | `200`，建立或沿用工作階段 cookie，回傳 `{ "csrf_token": "…" }` |
| `POST /api/import_batches` | `201` 建立或 `200` 重用批次，回傳 `{ "batch": { … } }` |
| `GET /api/import_batches` | `200`，回傳 `{ "batches": [ … ] }`，按建立時間由新到舊 |
| `GET /api/import_batches/:uuid` | `200`，回傳 `{ "batch": { … } }` |
| `GET /api/import_batches/:uuid/results/:result_id/investigation` | `200`，讀取異常的查核狀態與歷史 |
| `PATCH /api/import_batches/:uuid/results/:result_id/investigation` | `200`，更新狀態、追加一筆處理紀錄並回傳完整歷史 |

先從同一 origin 取得 token 與 cookie。提交時用 `FormData` 放入 `sales` 和 `payments` 兩個檔案欄位，帶上 `X-CSRF-Token`。由瀏覽器設定 multipart boundary。工作階段失效時可重新取得 token 再用原檔重試。前端以 `?batch=<uuid>` 記錄目前開啟的批次。

批次清單的項目有 `id`、`created_at`、`sales_filename`、`payments_filename`。批次詳細資料與匯入回應另外包含 `results` 與 `source_events` 陣列。`results` 依門市、營業日、付款方式排序；每組包含十進位字串 `id`、`store_id`、`business_date`、`payment_method`、`sales_net`、`payments_net`、`difference`、`classification`、`investigation_status`。`source_events` 依來源及 CSV 紀錄位置排序，每列包含 `source`、`record_number`、`event_id`、`store_id`、`business_date`、`payment_method`、`event_type`、`amount`、`original_event_id`。CSV 表頭為第 1 紀錄；退款追查只在同批次、同來源及同門市內查看原事件與目前退款。

- 金額欄位為 JSON 整數或 `null`。缺側淨額為 `null`，任一側缺資料時差額亦為 `null`。
- 分類為 `matched`、`amount_mismatch`、`missing_sales` 或 `missing_payments`。一致的處理狀態為 `null`，異常初始化為 `pending`，完成查核為 `processed`。
- 應用程式錯誤為 `{ "error": { "source": "sales", "code": "invalid_amount", "message": "…", "record_number": 2 } }`。來源為 `sales`、`payments` 或 `null`，可定位時才帶 `record_number`，表頭為第 1 筆紀錄。
- `422` 表示輸入驗證拒絕，`404` 表示批次不存在，`403` 表示請求防護拒絕，`503` 的 `import_busy` 表示摘要鎖等待已達 2 秒，可用相同檔案重試。Rails 的 Host 防護可以直接回傳 `403`。
- `5xx` 或中斷連線時，客戶端可能無法確認匯入是否已提交。可使用原檔重試，由原始位元組識別既有批次。

查核 `PATCH` 帶同源 cookie 與 `X-CSRF-Token`，使用 `Content-Type: application/json` 傳送 `{ "status": "processed", "note": "已核對" }`。恢復待處理時使用 `pending` 並填入原因。`GET` 與 `PATCH` 成功都回傳 `{ "investigation_status": "…", "records": [{ "status": "…", "note": "…", "created_at": "…" }] }`，紀錄由舊到新。

查核說明無效或目標狀態無效時回 `422`（`invalid_investigation_note` 或 `invalid_investigation_status`）；分組不存在回 `404`；憑證或 Host 防護拒絕回 `403`。狀態相同或分組一致時，更新回 `409`（`investigation_conflict`）。遇到 `409`、`5xx` 或連線中斷，先 `GET` 查核紀錄，再依讀回結果決定下一步。

### Rails 驗證

測試設定只使用 `test-db`、`restaurant_reconciliation_test` 和獨立的 `test_pgdata` volume，無主機埠。以此組命令在相同隔離目標執行 schema 初始化及測試。

```sh
docker compose -f compose.test.yaml -p restaurant-reconciliation-t03 build backend
docker compose -f compose.test.yaml -p restaurant-reconciliation-t03 run --rm -T backend bin/rails db:migrate
docker compose -f compose.test.yaml -p restaurant-reconciliation-t03 run --rm -T backend bin/rails test
docker compose -f compose.test.yaml -p restaurant-reconciliation-t03 run --rm -T backend bundle exec rubocop
docker compose -f compose.test.yaml -p restaurant-reconciliation-t03 run --rm -T backend bundle exec brakeman
docker compose -f compose.test.yaml -p restaurant-reconciliation-t03 run --rm -T backend bundle exec bundle-audit check --update
```

### Vue 建置與瀏覽器驗證

Vue 靜態檔由 Node 24 的建置階段產生，再放入 Rails 映像的 `public`。前端和 JSON API 使用相同 origin。執行以下命令可單獨檢查前端建置與 ESLint。

```sh
docker build --target frontend-build -t restaurant-reconciliation-t03-frontend-check .
docker run --rm --network none restaurant-reconciliation-t03-frontend-check npm run lint
docker run --rm restaurant-reconciliation-t03-frontend-check npm audit --audit-level=low
```

#### 第 03 票查核與重啟驗證

在異常分組按「查核」。對待處理分組輸入處理說明並按「標記已處理」；需要重查時輸入恢復原因並按「恢復待處理」。查核區按時間順序保留各次狀態、文字與時間。對帳分類、淨額及差額維持原結果。憑證失效可重試送出；若狀態衝突或無法確認是否已儲存，先按「重新讀取查核」，核對目前狀態和處理紀錄。

以下命令使用 `restaurant-reconciliation-t03-browser` 的資料庫卷，app 不發布主機埠。從專案目錄執行。測試會實際匯入專用範例並新增處理紀錄，每次使用不同的匯入內容。輸出存於 `.test-output/t03-browser/playwright/`。

```sh
rr_t03() {
  docker compose -f compose.yaml -f compose.browser.yaml -f compose.browser.t03.yaml \
    -p restaurant-reconciliation-t03-browser "$@"
}
rr_t03 build app browser
rr_t03 up -d --no-build --wait app
rr_t03 run --rm -T --no-deps browser npm run test:browser -- --grep 'T03 查核歷史'
rr_t03 run --rm -T --no-deps browser
```

停止前從最後一次成功測試輸出的「查核歷史重啟讀回」複製 `batch_id`、`result_id`（F02，已恢復待處理）及 `processed_result_id`（F03，已處理）。依序執行下方區塊，核對隔離標記、兩個分組的狀態與完整歷史，並比對重啟前後的批次，以及兩組查核歷史的回應原文。

```sh
(
  set -e
  batch_id='填入查核歷史的批次 UUID'
  result_id='填入 F02 的分組 ID'
  processed_result_id='填入 F03 的分組 ID'
  evidence_dir=.test-output/t03-browser/restart-check
  mkdir -p "$evidence_dir"

  read_history() {
    rr_t03 exec -T app ruby -rnet/http -rjson -e '
      id, reopened, processed = ARGV
      abort "批次 UUID 格式錯誤" unless /\A[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\z/i.match?(id)
      abort "分組 ID 格式錯誤" unless [reopened, processed].all? { |value| /\A[1-9][0-9]{0,18}\z/.match?(value) }
      http = Net::HTTP.new("127.0.0.1", 3000, nil)
      marker = http.get("/__ticket01_browser_target.txt")
      abort "隔離測試環境標記不符" unless marker.code == "200" && marker.body.strip == "restaurant-reconciliation-t03-browser"
      path = "/api/import_batches/#{id}"
      batch_response = http.get(path)
      abort "批次明細 GET 回傳 HTTP #{batch_response.code}" unless batch_response.code == "200"
      batch = JSON.parse(batch_response.body).fetch("batch")
      abort "批次或分組 ID 不符" unless batch["id"] == id && ([reopened, processed] - batch.fetch("results").map { |row| row["id"] }).empty?
      puts batch_response.body
      { reopened => %w[processed pending], processed => %w[processed] }.each do |result_id, statuses|
        response = http.get("#{path}/results/#{result_id}/investigation")
        abort "查核歷史 GET 回傳 HTTP #{response.code}" unless response.code == "200"
        data = JSON.parse(response.body)
        records = data.fetch("records")
        abort "查核狀態或歷史不符" unless data["investigation_status"] == statuses.last && records.map { |record| record["status"] } == statuses
        abort "處理紀錄缺少說明或時間" unless records.all? { |record| !record.fetch("note").strip.empty? && !record.fetch("created_at").empty? }
        puts response.body
      end
    ' "$batch_id" "$result_id" "$processed_result_id"
  }

  read_history > "$evidence_dir/before.jsonl"
  rr_t03 stop app db
  rr_t03 start --wait app db
  read_history > "$evidence_dir/after.jsonl"
  cmp "$evidence_dir/before.jsonl" "$evidence_dir/after.jsonl"
)
```

#### 第 02 票歷史驗證流程

第 02 票的瀏覽器驗證使用 `restaurant-reconciliation-t02-browser` Compose 專案及專用資料卷；app 不發布主機埠，Playwright 從服務網路連到 Rails。測試會向這個資料庫實際匯入資料。同一環境可再次執行測試並保留結果。以下為歷史驗證流程，重跑時須在第 02 票提交 `3462b4496a77431789ff7497c58193eb3c4a575a` 的專案目錄執行。第 03 票使用上方專屬流程。

```sh
docker compose -f compose.yaml -f compose.browser.yaml -p restaurant-reconciliation-t02-browser build app browser
docker compose -f compose.yaml -f compose.browser.yaml -p restaurant-reconciliation-t02-browser up -d --no-build --wait app
docker compose -f compose.yaml -f compose.browser.yaml -p restaurant-reconciliation-t02-browser run --rm -T --no-deps browser
```

從上方測試輸出的「標準案例」複製既有批次 UUID，填入下方的 `batch_id`。在停止前與重新啟動後各讀取一次同一批次；兩次須回傳 HTTP 200，且對帳結果與來源紀錄完全相同，才會繼續執行可能匯入資料的瀏覽器測試。

```sh
(
  set -e
  batch_id='填入標準案例的批次 UUID'
  evidence_dir=.test-output/t02-browser/restart-check
  mkdir -p "$evidence_dir"

  t02_browser() {
    docker compose -f compose.yaml -f compose.browser.yaml -p restaurant-reconciliation-t02-browser "$@"
  }

  read_batch() {
    t02_browser exec -T app ruby -rnet/http -rjson -e '
      id = ARGV.fetch(0)
      abort "批次 UUID 格式錯誤" unless /\A[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\z/i.match?(id)
      http = Net::HTTP.new("127.0.0.1", 3000, nil)
      marker = http.get("/__ticket01_browser_target.txt")
      abort "隔離測試環境標記不符" unless marker.code == "200" && marker.body.strip == "restaurant-reconciliation-t02-browser"
      response = http.get("/api/import_batches/#{id}")
      abort "批次明細 GET 回傳 HTTP #{response.code}" unless response.code == "200"
      batch = JSON.parse(response.body).fetch("batch")
      abort "讀回的批次 UUID 不符" unless batch.fetch("id") == id
      abort "缺少標準案例的對帳結果或來源紀錄" unless %w[results source_events].all? { |key| batch[key].is_a?(Array) && !batch[key].empty? }
      puts JSON.generate(batch.slice("id", "results", "source_events"))
    ' "$batch_id"
  }

  read_batch > "$evidence_dir/before.json"
  t02_browser stop app db
  t02_browser start --wait app db
  read_batch > "$evidence_dir/after.json"
  cmp "$evidence_dir/before.json" "$evidence_dir/after.json"
  t02_browser run --rm -T --no-deps browser
  t02_browser stop app db
)
```

Playwright 從測試容器連到 Rails 的 `http://localhost:3000`，並在測試開始前核對隔離環境標記。截圖與失敗診斷輸出到 `.test-output/t02-browser/playwright/`。要先只跑來源追查案例，可執行：

```sh
docker compose -f compose.yaml -f compose.browser.yaml -p restaurant-reconciliation-t02-browser run --rm -T --no-deps browser npm run test:browser -- --grep 'F01–F08 可追查分組來源'
```

#### 第 01 票前端驗證紀錄

- Vue `3.5.45`、Vite `8.3.8`、ESLint `10.15.0`、Vue ESLint plugin `10.12.1`。建置及 lint 使用 Node `24.22.3`、npm `11.19.1`。Vite 建置與 ESLint 檢查通過，`docker run --rm restaurant-reconciliation-t01-frontend-check npm audit --audit-level=low` 回報 0 個漏洞。
- Playwright `1.64.1` 在官方 Noble 映像內使用 Node `26.13.0`、npm `11.20.0` 及 Chromium `156.0.8078.80`。完成版在隔離 Compose 專案重啟前後各通過 8 個案例。首次空庫的標準範例按下匯入後取得 `201` 與七組結果。重啟後清單及同一批次的明細回應一致，相同檔案取得 `200` 並開啟原批次。
- 案例包含合法表頭的空批次、來源及紀錄序號錯誤、更正與改檔名、檔名呈現、已寫入但回應中斷時的原檔重試，以及晚到回應與批次切換。用受控回應檢查 `import_busy`、暫時讀取失敗和錯誤文字呈現。CSRF 拒絕、找不到批次、已寫入後的讀回及重試均經實際 Rails API。
