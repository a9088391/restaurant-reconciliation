# frozen_string_literal: true

require "timeout"

module ImportApiTestHelpers
  HEADER = "event_id,store_id,business_date,payment_method,event_type,amount,original_event_id\n"
  ORIGIN = "http://localhost"

  private

  def submit(sales, payments, sales_filename: "sales.csv", payments_filename: "payments.csv", session: self)
    session.post "/api/import_batches",
                 params: { sales: upload(sales, sales_filename), payments: upload(payments, payments_filename) },
                 headers: csrf_headers(session)
  end

  def csrf_headers(session = self)
    session.get "/api/csrf_token"
    token = session.response.parsed_body.fetch("csrf_token")
    { "X-CSRF-Token" => token, "Origin" => ORIGIN }
  end

  def sample_pair
    %w[sales payments].map { |source| File.binread(Rails.root.join("../samples/#{source}.csv")) }
  end

  def fetch_batch(id)
    get "/api/import_batches/#{id}"
    assert_response :ok
    response.parsed_body.fetch("batch")
  end

  def assert_error(status, code, source = nil, position = nil)
    assert_response status
    error = response.parsed_body.fetch("error")
    assert_equal [source, code], error.values_at("source", "code")
    assert_predicate error.fetch("message"), :present?
    if position
      assert_equal position, error.fetch("record_number")
    else
      refute error.key?("record_number")
    end
  end

  def wait_for_lock(db, type, condition = "")
    Timeout.timeout(5) do
      loop do
        pid = ImportBatch.uncached do
          db.select_value(<<~SQL)
            SELECT pid FROM pg_locks
            WHERE NOT granted AND locktype = #{db.quote(type)} #{condition}
          SQL
        end
        break pid if pid

        sleep 0.01
      end
    end
  end

  def thread_result(worker)
    raise "請求未在測試時間內完成。" unless worker.join(5)

    worker.value
  end

  def stop_worker(worker)
    return if !worker || worker.join(5)

    worker.kill.join
  end

  def upload(bytes, filename)
    Rack::Test::UploadedFile.new(StringIO.new(bytes.dup), "text/csv", true, original_filename: filename)
  end
end
