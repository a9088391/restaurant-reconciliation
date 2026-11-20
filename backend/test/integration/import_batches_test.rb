# frozen_string_literal: true

require "csv"
require "digest"
require "test_helper"
require_relative "import_api_test_helpers"

class ImportBatchesTest < ActionDispatch::IntegrationTest
  include ImportApiTestHelpers

  self.use_transactional_tests = false

  setup do
    host! "localhost"
    clear_batches
  end

  teardown do
    clear_batches
  end

  test "兩側合法表頭建立零結果批次，空清單及批次可讀回" do
    get "/api/import_batches"
    assert_response :ok
    assert_equal({ "batches" => [] }, response.parsed_body)

    submit(HEADER, HEADER)
    assert_response :created
    batch = response.parsed_body.fetch("batch")
    assert_equal [], batch.fetch("results")
    assert_equal [], batch.fetch("source_events")

    get "/api/import_batches/#{batch.fetch('id')}"
    assert_response :ok
    assert_equal batch, response.parsed_body.fetch("batch")
  end

  test "F01–F08 產生七個獨立分組並保存退款與取消的來源證據" do
    sales, payments = sample_pair
    submit(sales, payments)
    assert_response :created
    batch = response.parsed_body.fetch("batch")
    keys = %w[store_id business_date payment_method sales_net payments_net difference classification
              investigation_status]

    assert_equal([
                   ["A", "2026-11-01", "cash", 1_000, 1_000, 0, "matched", nil],
                   ["A", "2026-11-01", "credit_card", 800, 750, 50, "amount_mismatch", "pending"],
                   ["A", "2026-11-03", "cash", -500, -500, 0, "matched", nil],
                   ["A", "2026-11-04", "credit_card", -800, -750, -50, "amount_mismatch", "pending"],
                   ["B", "2026-11-01", "cash", 400, nil, nil, "missing_payments", "pending"],
                   ["B", "2026-11-01", "credit_card", nil, 300, nil, "missing_sales", "pending"],
                   ["C", "2026-11-01", "cash", 0, 0, 0, "matched", nil]
                 ], batch.fetch("results").map { |result| result.values_at(*keys) })

    source_keys = %w[source record_number event_id store_id business_date payment_method event_type amount
                     original_event_id]
    source_rows = [
      ["payments", 2, "cash-1", "A", "2026-11-01", "cash", "normal", 1_000, nil],
      ["payments", 3, "card-1", "A", "2026-11-01", "credit_card", "normal", 750, nil],
      ["payments", 4, "card-1", "B", "2026-11-01", "credit_card", "normal", 300, nil],
      ["payments", 5, "cash-0", "C", "2026-11-01", "cash", "normal", 0, nil],
      ["payments", 6, "refund-cash-1", "A", "2026-11-03", "cash", "refund", 300, "cash-1"],
      ["payments", 7, "refund-cash-2", "A", "2026-11-03", "cash", "refund", 200, "cash-1"],
      ["payments", 8, "refund-card-1", "A", "2026-11-04", "credit_card", "refund", 750, "card-1"],
      ["payments", 9, "cancel-card-1", "C", "2026-11-01", "credit_card", "cancel", 150, nil],
      ["sales", 2, "cash-1", "A", "2026-11-01", "cash", "normal", 1_000, nil],
      ["sales", 3, "card-1", "A", "2026-11-01", "credit_card", "normal", 800, nil],
      ["sales", 4, "cash-1", "B", "2026-11-01", "cash", "normal", 400, nil],
      ["sales", 5, "cash-0", "C", "2026-11-01", "cash", "normal", 0, nil],
      ["sales", 6, "refund-cash-1", "A", "2026-11-03", "cash", "refund", 300, "cash-1"],
      ["sales", 7, "refund-cash-2", "A", "2026-11-03", "cash", "refund", 200, "cash-1"],
      ["sales", 8, "refund-card-1", "A", "2026-11-04", "credit_card", "refund", 800, "card-1"],
      ["sales", 9, "cancel-card-1", "C", "2026-11-01", "credit_card", "cancel", 600, nil]
    ]
    assert_equal source_rows.map { |row| source_keys.zip(row).to_h }, batch.fetch("source_events")
    assert_equal batch, fetch_batch(batch.fetch("id"))
    get "/api/import_batches"
    assert_response :ok
    assert_equal [batch.slice("id", "created_at", "sales_filename", "payments_filename")],
                 response.parsed_body.fetch("batches")

    stored = ImportBatch.find(batch.fetch("id"))
    assert_equal [sales, payments], [stored.sales_bytes, stored.payments_bytes]
    %w[sales payments].each do |source|
      events = stored.source_events.where(source: source).order(:record_number).to_a
      assert_equal (2..9).to_a, events.map(&:record_number)
      assert_equal %w[normal normal normal normal refund refund refund cancel], events.map(&:event_type)
      assert_equal %w[cash-1 cash-1 card-1], events.filter_map(&:original_event_id)
      assert_equal %w[cancel-card-1 C 2026-11-01 credit_card], [
        events.last.event_id, events.last.store_id, events.last.business_date.iso8601, events.last.payment_method
      ]
    end
  end

  test "退在自身營業日，原交易排於退款之後也能保存，零元及負淨額均為有資料" do
    sales = HEADER + <<~CSV
      R1,A,2026-01-01,cash,refund,300,T1
      T1,A,2026-01-01,cash,normal,800,
      R2,A,2026-01-01,cash,refund,500,T1
      R3,A,2026-01-03,credit_card,refund,200,T2
      T2,A,2026-01-02,credit_card,normal,200,
    CSV
    payments = HEADER + <<~CSV
      P1,A,2026-01-01,cash,cancel,300,
      P2,A,2026-01-03,credit_card,cancel,0,
    CSV
    submit(sales, payments)
    assert_response :created
    batch = response.parsed_body.fetch("batch")
    keys = %w[business_date sales_net payments_net difference classification]
    assert_equal([
                   ["2026-01-01", 0, nil, nil, "missing_payments"],
                   ["2026-01-02", 200, nil, nil, "missing_payments"],
                   ["2026-01-03", -200, nil, nil, "missing_payments"]
                 ], batch.fetch("results").map { |result| result.values_at(*keys) })
    assert_equal [[2, "R1", "T1"], [3, "T1", nil], [4, "R2", "T1"], [5, "R3", "T2"], [6, "T2", nil]],
                 SourceEvent.where(import_batch_id: batch.fetch("id"), source: "sales").order(:record_number)
                            .pluck(:record_number, :event_id, :original_event_id)

    submit(payments, sales)
    assert_response :created
    reversed = response.parsed_body.fetch("batch").fetch("results")
    assert_equal([[nil, 0], [nil, 200], [nil, -200]], reversed.map { |r| r.values_at("sales_net", "payments_net") })
    assert(reversed.all? { |r| r["classification"] == "missing_sales" && r["difference"].nil? })
  end

  test "接受 BOM、CRLF、引號、前導零、合法識別碼與無檔尾換行" do
    file = "\uFEFF" + HEADER.strip.split(",").map { |column| %("#{column}") }.join(",") + "\r\n"
    file += %("T_1","ABC-123",2000-02-29,"cash","normal","00012",""\r\n)
    file += "t_1,ABC-123,1582-10-10,cash,normal,0,\r\n"
    file += "#{'X' * 64},abc-123,0001-01-01,credit_card,cancel,42,"
    submit(file, HEADER.chomp)
    assert_response :created
    batch = response.parsed_body.fetch("batch")
    assert_equal([["1582-10-10", 0], ["2000-02-29", 12]], batch.fetch("results")
                                                               .map { |r| r.values_at("business_date", "sales_net") })
    stored = ImportBatch.find(batch.fetch("id"))
    assert_equal file.b, stored.sales_bytes
    assert_equal [%w[T_1 ABC-123], %w[t_1 ABC-123], ["X" * 64, "abc-123"]],
                 stored.source_events.order(:record_number).pluck(:event_id, :store_id)
  end

  test "格式、表頭、解析及列寬錯誤精確定位且不影響已提交資料" do
    original = create_batch(HEADER + normal_row, HEADER)
    cases = [
      ["", "empty_file", nil],
      ["\uFEFF", "empty_file", nil],
      [HEADER.b + "\xFF".b, "invalid_encoding", nil],
      [HEADER.delete_suffix(",original_event_id\n"), "invalid_header", 1],
      [HEADER.sub("event_id", "store_id"), "invalid_header", 1],
      [HEADER.sub("event_id,store_id", "store_id,event_id"), "invalid_header", 1],
      [HEADER.chomp + ",extra\n", "invalid_header", 1],
      [HEADER.sub("event_id", "EVENT_ID"), "invalid_header", 1],
      [HEADER.sub("event_id", " event_id"), "invalid_header", 1],
      [HEADER + "\n", "blank_row", 2],
      [HEADER + " \n", "invalid_column_count", 2],
      [HEADER + "T,A,2026-01-01,cash,normal,10\n", "invalid_column_count", 2],
      [HEADER + "T,A,2026-01-01,cash,normal,10,,\n", "invalid_column_count", 2],
      [(HEADER + normal_row).tr("\n", "\r"), "malformed_csv", 1],
      [HEADER + "\"unclosed\n", "malformed_csv", 2],
      [HEADER + normal_row + "T,\"A\"x,2026-01-01,cash,normal,10,\n", "malformed_csv", 3],
      [HEADER + %("T""A",A,2026-01-01,cash,normal,10,\n), "invalid_identifier", 2],
      [HEADER + %("T\nA",A,2026-01-01,cash,normal,10,\n), "invalid_identifier", 2]
    ]
    cases.each do |file, code, position|
      assert_rejected(file, HEADER, "sales", code, position)
    end
    assert_rejected(HEADER, HEADER + "\"x", "payments", "malformed_csv", 2)
    assert_only_batch(original)
  end

  test "欄位不修剪、不轉大小寫且不寬鬆轉譯日期與整數" do
    original = create_batch(HEADER, HEADER)
    invalid_values = {
      0 => ["invalid_identifier", ["", " T", "T ", "T.", "é", "X" * 65]],
      1 => ["invalid_identifier", ["", " A", "A ", "門市", "A/B", "X" * 65]],
      2 => ["invalid_date", ["", "2026-2-01", "2026-01-1", "20260101", "2026/01/01", " 2026-01-01",
                             "2026-02-29", "2026-04-31", "2026-00-01", "2026-13-01", "2026-02-00", "0000-01-01",
                             "1500-02-29"]],
      3 => ["invalid_payment_method", ["", "Cash", "credit_card ", "wire"]],
      4 => ["invalid_event_type", ["", "Normal", "refund ", "unknown"]],
      5 => ["invalid_amount", ["", "-1", "+1", "1.0", "1e3", " 1", "1 ", "１", "NT$1"]]
    }
    invalid_values.each do |index, (code, values)|
      values.each do |value|
        fields = %w[T A 2026-01-01 cash normal 10] << ""
        fields[index] = value
        assert_rejected(HEADER, HEADER + CSV.generate_line(fields), "payments", code, 2)
      end
    end
    assert_rejected(HEADER, HEADER + %("T",A,2026-01-01,cash,normal,"1,000",\n), "payments", "invalid_amount", 2)
    assert_rejected(HEADER, HEADER + "T,A,2026-01-01,cash,normal,10,T1\n", "payments", "unexpected_original_event", 2)
    assert_rejected(HEADER, HEADER + "T,A,2026-01-01,cash,cancel,10,T1\n", "payments", "unexpected_original_event", 2)
    assert_only_batch(original)
  end

  test "事件鍵限同批次、來源、門市且區分大小寫" do
    row = normal_row
    original = create_batch(HEADER + row + row.sub(",A,", ",B,") + row.sub(/\AT,/, "t,"), HEADER + row)
    assert_equal 2, original.fetch("results").size
    assert_equal 4, SourceEvent.where(import_batch_id: original.fetch("id")).count
    assert_rejected(HEADER + row + row, HEADER, "sales", "duplicate_event", 3)
    assert_rejected(HEADER, HEADER + row + row.sub(",10,", ",11,"), "payments", "duplicate_event", 3)
    assert_only_batch(original)
  end

  test "退款逐來源檢查退款原交易、付款方式、日期及累計金額" do
    orig = normal_row
    prior = create_batch(HEADER + orig, HEADER + orig)
    cases = [
      ["R,A,2026-01-01,cash,refund,0,T\n" + orig, "zero_refund", 2],
      ["R,A,2026-01-01,cash,refund,1,\n" + orig, "invalid_identifier", 2],
      ["R,A,2026-01-01,cash,refund,1, T\n" + orig, "invalid_identifier", 2],
      ["R,A,2026-01-01,cash,refund,1,#{'X' * 65}\n" + orig, "invalid_identifier", 2],
      ["R,A,2026-01-01,cash,refund,1,t\n" + orig, "invalid_refund_original", 2],
      ["R,A,2026-01-01,cash,refund,1,T\n", "invalid_refund_original", 2],
      ["R,A,2026-01-01,cash,refund,1,T\n" + orig.sub(",A,", ",B,"), "invalid_refund_original", 2],
      ["R,A,2026-01-01,cash,refund,1,T\n" + orig.sub(",normal,", ",cancel,"), "invalid_refund_original", 2],
      ["R,A,2026-01-01,cash,refund,1,P\nP,A,2026-01-01,cash,refund,2,T\n" + orig, "invalid_refund_original", 2],
      ["R,A,2026-01-01,cash,refund,1,R\n", "invalid_refund_original", 2],
      ["R,A,2026-01-01,credit_card,refund,1,T\n" + orig, "refund_payment_mismatch", 2],
      ["R,A,2025-12-31,cash,refund,1,T\n" + orig, "refund_before_original", 2],
      ["R,A,2026-01-01,cash,refund,11,T\n" + orig, "refund_exceeds_original", 2],
      ["R,A,2026-01-01,cash,refund,5,T\n" + orig + "R2,A,2026-01-02,cash,refund,6,T\n", "refund_exceeds_original", 4]
    ]
    cases.each do |file, code, position|
      assert_rejected(HEADER + file, HEADER, "sales", code, position)
      assert_rejected(HEADER + orig, HEADER + file, "payments", code, position)
    end
    assert_only_batch(prior)
  end

  test "各來源分別接受完整 1 MiB 並拒絕 1 MiB 加一位元組" do
    prefix = "\uFEFF" + HEADER + "T,A,2026-01-01,cash,normal,"
    exact = prefix + ("0" * (1_048_576 - prefix.bytesize - 3)) + "1,\n"
    assert_equal 1_048_576, exact.bytesize
    assert_equal 1_048_577, (exact + "\n").bytesize

    sales = create_batch(exact, HEADER)
    payments = create_batch(HEADER, exact)
    assert_equal [1, nil], sales.fetch("results").sole.values_at("sales_net", "payments_net")
    assert_equal [nil, 1], payments.fetch("results").sole.values_at("sales_net", "payments_net")
    assert_equal([[1_048_576, HEADER.bytesize], [HEADER.bytesize, 1_048_576]],
                 [sales, payments].map do |b|
                   ImportBatch.find(b.fetch("id")).attributes.values_at("sales_bytes", "payments_bytes").map(&:bytesize)
                 end)

    assert_rejected(exact + "\n", HEADER, "sales", "file_too_large")
    assert_rejected(HEADER, exact + "\n", "payments", "file_too_large")
    assert_equal([sales, payments], [sales, payments].map { |b| fetch_batch(b.fetch("id")) })
    assert_equal 2, batch_ids.size
  end

  test "各來源分別驗證筆數與金額上限，雙側的有號差額精確保留 bigint" do
    exact = HEADER + (1..5_000).map { |number| normal_row(event: "T#{number}", amount: 999_999_999) }.join
    extra = exact + normal_row(event: "T5001")
    zero = HEADER + normal_row(amount: 0)
    sales = create_batch(exact, zero)
    payments = create_batch(zero, exact)
    assert_equal [4_999_999_995_000, 0, 4_999_999_995_000],
                 sales.fetch("results").sole.values_at("sales_net", "payments_net", "difference")
    assert_equal [0, 4_999_999_995_000, -4_999_999_995_000],
                 payments.fetch("results").sole.values_at("sales_net", "payments_net", "difference")
    assert_equal([5_001, 5_001], [sales, payments].map { |b| SourceEvent.where(import_batch_id: b.fetch("id")).count })

    assert_rejected(extra, HEADER, "sales", "too_many_rows", 5_002)
    assert_rejected(HEADER, extra, "payments", "too_many_rows", 5_002)
    oversized_amount = HEADER + normal_row(amount: 1_000_000_000)
    assert_rejected(oversized_amount, HEADER, "sales", "amount_too_large", 2)
    assert_rejected(HEADER, oversized_amount, "payments", "amount_too_large", 2)
    assert_equal([sales, payments], [sales, payments].map { |b| fetch_batch(b.fetch("id")) })
    assert_equal 2, batch_ids.size
  end

  test "只改檔名重用；換行、BOM、列序、數字寫法及來源互換各自產生新批次" do
    sales, payments = sample_pair
    original = create_batch(sales, payments)
    submit(sales, payments, sales_filename: "renamed-a.csv", payments_filename: "renamed-b.csv")
    assert_response :ok
    assert_equal original, response.parsed_body.fetch("batch")
    assert_only_batch(original)

    header, *rows = sales.lines
    variants = [
      sales.gsub("\n", "\r\n"),
      "\uFEFF".b + sales,
      header + rows.reverse.join,
      sales.sub(",1000,", ",0001000,")
    ]
    others = variants.map { |variant| create_batch(variant, payments) }
    distinct_payment = create_batch(sales, "\uFEFF".b + payments)
    swapped = create_batch(payments, sales)
    same_groups = others + [distinct_payment]
    all_batches = [original, swapped] + same_groups
    assert_equal 7, all_batches.pluck("id").uniq.size
    assert_equal 7, batch_ids.size
    original_groups = original.fetch("results").map { |row| row.except("id") }
    same_groups.each do |batch|
      assert_equal(original_groups, batch.fetch("results").map { |row| row.except("id") })
    end
    result_ids = all_batches.flat_map { |batch| batch.fetch("results").pluck("id") }
    assert_equal result_ids.size, result_ids.uniq.size
    assert_equal(-50, swapped.fetch("results").find do |r|
      r["business_date"] == "2026-11-01" && r["payment_method"] == "credit_card" && r["store_id"] == "A"
    end.fetch("difference"))
    assert_equal original, fetch_batch(original.fetch("id"))
    assert_rejected(sales + "\n", payments, "sales", "blank_row", 10)
    assert_equal 7, batch_ids.size
  end

  test "更正與重用各批次時，原交易及退款來源證據依各自批次保存" do
    sales, payments = sample_pair
    original = create_batch(sales, payments)
    corrected_sales = sales.gsub(",800,", ",810,")
    corrected = create_batch(corrected_sales, payments)
    refute_equal original.fetch("id"), corrected.fetch("id")

    [original, corrected].zip([800, 810]).each do |batch, amount|
      sales_rows = batch.fetch("source_events").select do |row|
        row.values_at("source", "store_id", "payment_method") == %w[sales A credit_card]
      end
      assert_equal([[3, "card-1", amount, nil], [8, "refund-card-1", amount, "card-1"]],
                   sales_rows.map { |row| row.values_at("record_number", "event_id", "amount", "original_event_id") })
      assert_equal batch, fetch_batch(batch.fetch("id"))
    end
    submit(corrected_sales, payments)
    assert_response :ok
    assert_equal corrected, response.parsed_body.fetch("batch")
    assert_equal 2, batch_ids.size
  end

  test "CSRF token 受 session、Origin 與 Host 限制；拒絕時保留原批次" do
    original = create_batch(HEADER, HEADER)
    headers = csrf_headers
    assert_match(/no-store/, response.headers["Cache-Control"])
    assert_match(/_reconciliation_session=/, response.headers["Set-Cookie"])
    assert_match(/httponly/i, response.headers["Set-Cookie"])
    refute response.headers.key?("Access-Control-Allow-Origin")

    valid_pair = -> { { sales: upload(HEADER + normal_row, "sales.csv"), payments: upload(HEADER, "payments.csv") } }
    [nil, "invalid"].each do |token|
      post "/api/import_batches", params: valid_pair.call, headers: { "Origin" => ORIGIN, "X-CSRF-Token" => token }
      assert_error :forbidden, "invalid_csrf_token"
    end
    %w[https://outside.example null].each do |origin|
      post "/api/import_batches", params: valid_pair.call, headers: headers.merge("Origin" => origin)
      assert_error :forbidden, "invalid_csrf_token"
    end
    stranger = open_session { |session| session.host! "localhost" }
    stranger.post "/api/import_batches", params: valid_pair.call, headers: headers
    assert_equal 403, stranger.response.status
    assert_equal "invalid_csrf_token", stranger.response.parsed_body.dig("error", "code")

    post "/api/import_batches", params: valid_pair.call, headers: headers.merge("X-Forwarded-Host" => "outside.example")
    assert_response :forbidden
    host! "outside.example"
    get "/api/csrf_token"
    assert_response :forbidden
    get "/api/import_batches/#{original.fetch('id')}"
    assert_response :forbidden
    host! "localhost"
    assert_only_batch(original)
  end

  test "拒絕缺檔、非檔案、query 附帶與非 multipart，錯誤不洩漏檔案路徑或內容" do
    original = create_batch(HEADER, HEADER)
    headers = csrf_headers
    post "/api/import_batches", params: { sales: "", payments: "" }, headers: headers, as: :json
    assert_error :unprocessable_content, "multipart_required"

    post "/api/import_batches", params: { sales: "/etc/passwd", payments: upload(HEADER, "payments.csv") },
                                headers: headers
    assert_error :unprocessable_content, "file_required", "sales"
    refute_includes response.body, "/etc/passwd"

    post "/api/import_batches?payments=%2Fetc%2Fpasswd", params: { sales: upload(HEADER, "sales.csv") },
                                                         headers: headers
    assert_error :unprocessable_content, "file_required", "payments"

    files = { sales: { file: upload(HEADER, "sales.csv") }, payments: upload(HEADER, "payments.csv") }
    post "/api/import_batches", params: files, headers: headers
    assert_error :unprocessable_content, "file_required", "sales"
    assert_only_batch(original)
  end

  test "上傳檔名只保存為 JSON 顯示資料，UUID 查詢僅讀取有效批次" do
    name = "<img onerror=alert(1)>.csv"
    submit(HEADER + normal_row, HEADER, sales_filename: "../../#{name}")
    assert_response :created
    assert_equal "application/json", response.media_type
    assert_equal "nosniff", response.headers["X-Content-Type-Options"]
    batch = response.parsed_body.fetch("batch")
    assert_equal name, batch.fetch("sales_filename")
    assert_equal HEADER + normal_row, ImportBatch.find(batch.fetch("id")).sales_bytes
    assert_equal batch, fetch_batch(batch.fetch("id"))

    %w[none f7c17639-d763-49e9-90d5-1b8fb200bc2a].each do |id|
      get "/api/import_batches/#{id}"
      assert_error :not_found, "batch_not_found"
    end
    assert_only_batch(batch)
  end

  test "兩條實際 DB 連線重疊匯入，同內容僅有一個 UUID" do
    prior = create_batch(HEADER, HEADER)
    csv = HEADER + normal_row
    workers = []
    ImportBatch.with_connection do |db|
      db.transaction do
        # 暫停第一個請求於結果寫入，讓第二個請求實際等待同一組摘要鎖。
        db.execute("LOCK TABLE reconciliation_results IN SHARE MODE")
        workers << submit_in_thread(csv, csv)
        writer = wait_for_lock(db, "relation", "AND relation = 'reconciliation_results'::regclass")
        workers << submit_in_thread(csv, csv)
        waiter = wait_for_lock(db, "advisory")
        refute_equal writer, waiter
        ImportBatch.uncached { assert_only_batch(prior) }
      end
    end

    first_status, first_body = thread_result(workers.first)
    second_status, second_body = thread_result(workers.last)
    assert_equal [201, 200], [first_status, second_status]
    assert_equal first_body, second_body
    batch = first_body.fetch("batch")
    assert_equal [batch.fetch("id"), prior.fetch("id")], batch_ids
    assert_equal batch, fetch_batch(batch.fetch("id"))
    assert_equal [2, 1], [SourceEvent.count, ReconciliationResult.count]
  ensure
    workers&.each { |worker| stop_worker(worker) }
  end

  test "摘要鎖實際等待逾時後，同一批位元組可重試並讀回先完成的一筆" do
    prior = create_batch(HEADER, HEADER)
    csv = HEADER + normal_row
    first = nil
    waiter = nil
    ImportBatch.with_connection do |db|
      db.transaction do
        db.execute("LOCK TABLE reconciliation_results IN SHARE MODE")
        first = submit_in_thread(csv, csv)
        writer = wait_for_lock(db, "relation", "AND relation = 'reconciliation_results'::regclass")
        waiter = submit_in_thread(csv, csv)
        refute_equal writer, wait_for_lock(db, "advisory")
        status, body = thread_result(waiter)
        assert_equal 503, status
        assert_equal "import_busy", body.dig("error", "code")
        ImportBatch.uncached { assert_only_batch(prior) }
      end
    end

    status, body = thread_result(first)
    assert_equal 201, status
    submit(csv, csv)
    assert_response :ok
    assert_equal body, response.parsed_body
    assert_equal body.fetch("batch"), fetch_batch(body.dig("batch", "id"))
    assert_equal [body.dig("batch", "id"), prior.fetch("id")], batch_ids
    assert_equal [2, 1], [SourceEvent.count, ReconciliationResult.count]
  ensure
    stop_worker(first)
    stop_worker(waiter)
  end

  test "真實 DB 結果寫入失敗回滾批次及事件，解除失敗後可成功重試" do
    prior = create_batch(HEADER + normal_row, HEADER)
    csv = HEADER + normal_row.sub(",A,", ",FAIL_STORE,")
    ImportBatch.with_connection do |db|
      db.execute(<<~SQL)
        ALTER TABLE reconciliation_results
        ADD CONSTRAINT test_result_failure CHECK (store_id <> 'FAIL_STORE')
      SQL
      begin
        submit(csv, csv)
        assert_error :internal_server_error, "persistence_failed"
        assert_includes response.parsed_body.dig("error", "message"), "無法確認匯入結果"
        assert_only_batch(prior)
        assert_equal [1, 1], [SourceEvent.count, ReconciliationResult.count]
      ensure
        db.execute("ALTER TABLE reconciliation_results DROP CONSTRAINT test_result_failure")
      end
    end

    recovered = create_batch(csv, csv)
    assert_equal "FAIL_STORE", recovered.fetch("results").sole.fetch("store_id")
    assert_equal recovered, fetch_batch(recovered.fetch("id"))
    assert_equal prior, fetch_batch(prior.fetch("id"))
    assert_equal [2, 3, 2], [batch_ids.size, SourceEvent.count, ReconciliationResult.count]
  end

  test "模擬營業或收款摘要碰撞時仍須比較兩份 raw bytes" do
    %w[sales payments].each_with_index do |source, index|
      input = [HEADER, HEADER]
      input[index] += normal_row(event: "same_digest_#{source}")
      first = create_batch(*input)

      alternate = input.dup
      alternate[index] = alternate[index].sub(",10,", ",11,")
      # 把既有索引條目調整成新輸入的摘要，保留既有 raw bytes 來模擬碰撞。
      ImportBatch.find(first.fetch("id")).update!("#{source}_digest": Digest::SHA256.hexdigest(alternate[index]))
      second = create_batch(*alternate)
      refute_equal first.fetch("id"), second.fetch("id")
      submit(*alternate)
      assert_response :ok
      assert_equal second, response.parsed_body.fetch("batch")
      assert_equal first, fetch_batch(first.fetch("id"))
      assert_equal input[index], ImportBatch.find(first.fetch("id")).public_send("#{source}_bytes")
    end
    assert_equal 4, batch_ids.size
  end

  private

  def clear_batches
    InvestigationRecord.delete_all
    ReconciliationResult.delete_all
    SourceEvent.delete_all
    ImportBatch.delete_all
  end

  def normal_row(event: "T", amount: 10)
    "#{event},A,2026-01-01,cash,normal,#{amount},\n"
  end

  def create_batch(sales, payments)
    submit(sales, payments)
    assert_response :created
    response.parsed_body.fetch("batch")
  end

  def batch_ids
    get "/api/import_batches"
    assert_response :ok
    response.parsed_body.fetch("batches").pluck("id")
  end

  def assert_only_batch(batch)
    assert_equal [batch.fetch("id")], batch_ids
    assert_equal batch, fetch_batch(batch.fetch("id"))
  end

  def assert_rejected(sales, payments, source, code, position = nil)
    submit(sales, payments)
    assert_error :unprocessable_content, code, source, position
  end

  def submit_in_thread(sales, payments)
    Thread.new do
      session = open_session { |client| client.host! "localhost" }
      submit(sales, payments, session: session)
      [session.response.status, session.response.parsed_body]
    end
  end
end
