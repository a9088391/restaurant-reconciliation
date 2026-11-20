# frozen_string_literal: true

require "test_helper"
require_relative "import_api_test_helpers"

class InvestigationsTest < ActionDispatch::IntegrationTest
  include ImportApiTestHelpers

  SALES_ROW = "T,A,2026-01-01,cash,normal,10,\n"

  self.use_transactional_tests = false

  setup do
    host! "localhost"
    @created_batch_ids = []
  end

  teardown do
    results = ReconciliationResult.where(import_batch_id: @created_batch_ids)
    InvestigationRecord.where(reconciliation_result_id: results.select(:id)).delete_all
    results.delete_all
    SourceEvent.where(import_batch_id: @created_batch_ids).delete_all
    ImportBatch.where(id: @created_batch_ids).delete_all
  end

  test "F02–F04 的異常完成查核及恢復待處理後保留歷史順序、分類與金額" do
    batch = create_batch(*sample_pair.map { |bytes| "\xEF\xBB\xBF".b + bytes })
    %w[amount_mismatch missing_sales missing_payments].each do |classification|
      result = batch.fetch("results").find { |row| row.fetch("classification") == classification }
      assert_match(/\A[1-9][0-9]*\z/, result.fetch("id"))
      path = investigation_path(batch, result)
      assert_equal({ "investigation_status" => "pending", "records" => [] }, fetch_investigation(path))

      processing_note = "  已核對 <span>原始資料</span>\n"
      patch_investigation(path, { status: "processed", note: processing_note })
      assert_response :ok
      completed = response.parsed_body
      assert_investigation(completed, "processed", [["processed", processing_note]])
      assert_equal result.merge("investigation_status" => "processed"), fetch_result(batch, result)

      patch_investigation(path, { status: "pending", note: "有新資料待查" })
      assert_response :ok
      reopened = response.parsed_body
      assert_investigation(reopened, "pending", [["processed", processing_note], %w[pending 有新資料待查]])
      assert_equal completed.fetch("records").sole, reopened.fetch("records").first
      assert_equal reopened, fetch_investigation(path)
      assert_equal result, fetch_result(batch, result)
    end
  end

  test "查核只接受狀態與有內容的 JSON 字串，拒絕時沒有歷史" do
    batch = create_batch(HEADER + SALES_ROW, HEADER)
    result = batch.fetch("results").sole
    path = investigation_path(batch, result)
    [{}, { status: nil }, { status: true }, { status: ["processed"] }, { status: " " }, { status: "unknown" }]
      .each do |payload|
        patch_investigation(path, payload.merge(note: "已查核"))
        assert_error :unprocessable_content, "invalid_investigation_status"
      end
    [{}, { note: nil }, { note: false }, { note: 10 }, { note: ["查核"] }, { note: { value: "查核" } },
     { note: "" }, { note: " \t\n\u00A0\u3000" }].each do |payload|
      patch_investigation(path, payload.merge(status: "processed"))
      assert_error :unprocessable_content, "invalid_investigation_note"
    end
    raw_payload = JSON.generate(status: "processed", note: "查核\0說明")
    assert_includes JSON.parse(raw_payload).fetch("note").bytes, 0
    patch path, params: raw_payload, headers: csrf_headers.merge("Content-Type" => "application/json")
    assert_error :unprocessable_content, "invalid_investigation_note"

    patch_investigation("#{path}?status=processed&note=not-from-json", {})
    assert_error :unprocessable_content, "invalid_investigation_status"
    assert_equal({ "investigation_status" => "pending", "records" => [] }, fetch_investigation(path))
    assert_equal result, fetch_result(batch, result)
  end

  test "查核只允許同一批次的異常，拒絕不存在的識別碼與重複狀態" do
    batch = create_batch(HEADER + SALES_ROW, HEADER)
    result = batch.fetch("results").sole
    path = investigation_path(batch, result)
    matched_batch = create_batch(HEADER + SALES_ROW, HEADER + SALES_ROW)
    matched = matched_batch.fetch("results").sole
    matched_path = investigation_path(matched_batch, matched)
    get matched_path
    assert_error :not_found, "investigation_not_found"
    patch_investigation(matched_path, { status: "processed", note: "一致" })
    assert_error :conflict, "investigation_conflict"
    assert_equal matched, fetch_result(matched_batch, matched)

    invalid_paths = [investigation_path(matched_batch, result), path.sub(batch.fetch("id"), "not-a-uuid"),
                     path.sub(batch.fetch("id"), "00000000-0000-0000-0000-000000000000")]
    invalid_paths += %w[0 1xyz 9223372036854775808 9999999].map do |invalid_id|
      investigation_path(batch, { "id" => invalid_id })
    end
    invalid_paths.each do |invalid_path|
      get invalid_path
      assert_error :not_found, "investigation_not_found"
      patch_investigation(invalid_path, { status: "processed", note: "不應寫入" })
      assert_error :not_found, "investigation_not_found"
    end

    patch_investigation(path, { status: "pending", note: "仍待處理" })
    assert_error :conflict, "investigation_conflict"
    assert_equal({ "investigation_status" => "pending", "records" => [] }, fetch_investigation(path))
    patch_investigation(path, { status: "processed", note: "完成" })
    assert_response :ok
    done = response.parsed_body
    patch_investigation(path, { status: "processed", note: "重複送出" })
    assert_error :conflict, "investigation_conflict"
    assert_equal done, fetch_investigation(path)
  end

  test "查核 PATCH 延續同源、會話 CSRF 與 Host 防護" do
    batch = create_batch(HEADER + SALES_ROW, HEADER)
    path = investigation_path(batch, batch.fetch("results").sole)
    valid_headers = csrf_headers
    payload = { status: "processed", note: "核對完畢" }
    [nil, "invalid"].each do |token|
      patch path, params: payload, as: :json, headers: valid_headers.merge("X-CSRF-Token" => token)
      assert_error :forbidden, "invalid_csrf_token"
    end
    %w[https://outside.example null].each do |origin|
      patch path, params: payload, as: :json, headers: valid_headers.merge("Origin" => origin)
      assert_error :forbidden, "invalid_csrf_token"
    end
    stranger = open_session { |client| client.host! "localhost" }
    stranger.patch path, params: payload, as: :json, headers: valid_headers
    assert_equal 403, stranger.response.status
    assert_equal "invalid_csrf_token", stranger.response.parsed_body.dig("error", "code")
    patch path, params: payload, as: :json, headers: valid_headers.merge("X-Forwarded-Host" => "outside.example")
    assert_response :forbidden

    assert_equal({ "investigation_status" => "pending", "records" => [] }, fetch_investigation(path))
    patch_investigation(path, payload)
    assert_response :ok
    assert_investigation(response.parsed_body, "processed", [%w[processed 核對完畢]])
  end

  test "結果識別碼超過 JavaScript 安全整數時仍可原值讀寫查核" do
    batch = create_batch(HEADER + SALES_ROW, HEADER)
    result = batch.fetch("results").sole
    large_id = 9_007_199_254_740_993
    ReconciliationResult.find(result.fetch("id")).update!(id: large_id)

    actual = fetch_batch(batch.fetch("id")).fetch("results").sole
    assert_equal "9007199254740993", actual.fetch("id")
    path = investigation_path(batch, actual)
    patch_investigation(path, { status: "processed", note: "完整識別碼" })
    assert_response :ok
    assert_investigation(fetch_investigation(path), "processed", [%w[processed 完整識別碼]])
  end

  test "狀態更新後歷史寫入失敗時一併回滾，保留既有歷史且允許重試" do
    batch = create_batch(HEADER + SALES_ROW, HEADER)
    result = batch.fetch("results").sole
    path = investigation_path(batch, result)
    patch_investigation(path, { status: "processed", note: "第一次查核" })
    assert_response :ok
    done = response.parsed_body
    InvestigationRecord.with_connection do |db|
      # 在隔離測試庫讓新增歷史失敗，驗證同一交易中已執行的狀態更新回滾。
      db.execute(<<~SQL)
        ALTER TABLE investigation_records
        ADD CONSTRAINT test_investigation_write_failure CHECK (note <> 'FORCE_FAILURE')
      SQL
      begin
        patch_investigation(path, { status: "pending", note: "FORCE_FAILURE" })
        assert_error :internal_server_error, "persistence_failed"
        assert_equal done, fetch_investigation(path)
        assert_equal result.merge("investigation_status" => "processed"), fetch_result(batch, result)
      ensure
        db.execute("ALTER TABLE investigation_records DROP CONSTRAINT test_investigation_write_failure")
      end
    end

    patch_investigation(path, { status: "pending", note: "FORCE_FAILURE" })
    assert_response :ok
    assert_investigation(fetch_investigation(path), "pending", [%w[processed 第一次查核], %w[pending FORCE_FAILURE]])
  end

  test "兩個重疊的查核請求只寫入一次，提交前的讀取仍保有一致狀態" do
    batch = create_batch(HEADER + SALES_ROW, HEADER)
    result = batch.fetch("results").sole
    path = investigation_path(batch, result)
    workers = []
    InvestigationRecord.with_connection do |db|
      db.transaction do
        # 首個請求先取得結果列鎖，再暫停於新增歷史；第二個請求會實際等待該筆交易。
        db.execute("LOCK TABLE investigation_records IN SHARE MODE")
        workers << patch_in_thread(path, "第一筆")
        writer = wait_for_lock(db, "relation", "AND relation = 'investigation_records'::regclass")
        workers << patch_in_thread(path, "第二筆")
        waiter = wait_for_lock(db, "transactionid", "AND #{db.quote(writer)} = ANY(pg_blocking_pids(pid))")
        refute_equal writer, waiter
        # 讀取使用獨立會話和連線，避免與持有測試鎖的連線共用查詢快取。
        reader = Thread.new do
          session = open_session { |client| client.host! "localhost" }
          session.get path
          [session.response.status, session.response.parsed_body]
        end
        workers << reader
        assert_equal [200, { "investigation_status" => "pending", "records" => [] }], thread_result(reader)
      end
    end

    first_status, first_body = thread_result(workers.first)
    second_status, second_body = thread_result(workers.fetch(1))
    assert_equal [200, 409], [first_status, second_status]
    assert_equal "investigation_conflict", second_body.dig("error", "code")
    assert_investigation(first_body, "processed", [%w[processed 第一筆]])
    assert_equal first_body, fetch_investigation(path)
    assert_equal result.merge("investigation_status" => "processed"), fetch_result(batch, result)
  ensure
    workers&.each { |worker| stop_worker(worker) }
  end

  test "相同內容保留歷史，合法更正建立獨立待處理結果，拒絕更正不改兩批資料" do
    sales = HEADER + SALES_ROW
    batch = create_batch(sales, HEADER)
    result = batch.fetch("results").sole
    path = investigation_path(batch, result)
    patch_investigation(path, { status: "processed", note: "既有查核" })
    assert_response :ok
    original_history = response.parsed_body
    processed = result.merge("investigation_status" => "processed")

    submit(sales, HEADER, sales_filename: "不同檔名.csv")
    assert_response :ok
    assert_equal batch.fetch("id"), response.parsed_body.dig("batch", "id")
    assert_equal processed, response.parsed_body.dig("batch", "results").sole
    assert_equal original_history, fetch_investigation(path)

    corrected = create_batch(sales.sub(",10,", ",11,"), HEADER)
    refute_equal batch.fetch("id"), corrected.fetch("id")
    corrected_result = corrected.fetch("results").sole
    assert_equal [11, "pending"], corrected_result.values_at("sales_net", "investigation_status")
    corrected_path = investigation_path(corrected, corrected_result)
    assert_equal({ "investigation_status" => "pending", "records" => [] }, fetch_investigation(corrected_path))

    submit(sales.sub(",10,", ",1.5,"), HEADER)
    assert_error :unprocessable_content, "invalid_amount", "sales", 2
    assert_equal processed, fetch_result(batch, result)
    assert_equal original_history, fetch_investigation(path)
    assert_equal corrected_result, fetch_result(corrected, corrected_result)
    assert_equal({ "investigation_status" => "pending", "records" => [] }, fetch_investigation(corrected_path))
  end

  private

  def investigation_path(batch, result)
    "/api/import_batches/#{batch.fetch('id')}/results/#{result.fetch('id')}/investigation"
  end

  def fetch_investigation(path)
    get path
    assert_response :ok
    response.parsed_body
  end

  def patch_investigation(path, payload, session: self)
    session.patch path, params: payload, headers: csrf_headers(session), as: :json
  end

  def patch_in_thread(path, note)
    Thread.new do
      session = open_session { |client| client.host! "localhost" }
      patch_investigation(path, { status: "processed", note: note }, session: session)
      [session.response.status, session.response.parsed_body]
    end
  end

  def fetch_result(batch, result)
    fetch_batch(batch.fetch("id")).fetch("results").find { |row| row.fetch("id") == result.fetch("id") }
  end

  def assert_investigation(snapshot, status, transitions)
    assert_equal %w[investigation_status records], snapshot.keys.sort
    assert_equal status, snapshot.fetch("investigation_status")
    records = snapshot.fetch("records")
    assert_equal(transitions, records.map { |record| record.values_at("status", "note") })
    records.each do |record|
      assert_equal %w[created_at note status], record.keys.sort
      assert_match(/\A\d{4}-\d{2}-\d{2}T/, record.fetch("created_at"))
    end
  end

  def create_batch(sales, payments)
    submit(sales, payments)
    body = response.parsed_body
    @created_batch_ids << body.dig("batch", "id") if response.status == 201
    assert_response :created
    body.fetch("batch")
  end
end
