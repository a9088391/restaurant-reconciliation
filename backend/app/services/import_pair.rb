# frozen_string_literal: true

require "digest"

class ImportPair
  UploadedCsv = Data.define(:bytes, :filename)
  Outcome = Data.define(:batch, :reused)
  LOCK_TIMEOUT = "2s"

  class Busy < StandardError; end

  def initialize(sales:, payments:)
    @sales = sales
    @payments = payments
  end

  # 兩份來源完整驗證及計算後，才在同一交易中重用或建立整個批次。
  def call
    events = SourceCsv.new("sales", @sales.bytes).parse + SourceCsv.new("payments", @payments.bytes).parse
    results = Reconciliation.calculate(events)
    identity = pair_identity

    ImportBatch.transaction(isolation: :read_committed) do
      acquire_lock(identity.values_at(:sales_digest, :payments_digest))
      # 每條 READ COMMITTED 查詢有自己的快照，鎖後重新讀取才能看見先提交的批次。
      existing = ImportBatch.uncached { ImportBatch.summary.find_by(identity) }
      if existing
        Outcome.new(batch: existing, reused: true)
      else
        Outcome.new(batch: persist(identity, events, results), reused: false)
      end
    end
  end

  private

  # 摘要供索引查找，仍比對兩側原始位元組；檔名及解析後數值不參與內容身分。
  def pair_identity
    {
      sales_digest: Digest::SHA256.hexdigest(@sales.bytes),
      payments_digest: Digest::SHA256.hexdigest(@payments.bytes),
      sales_bytes: @sales.bytes,
      payments_bytes: @payments.bytes
    }
  end

  # 同組摘要共用交易鎖，提交或回滾時釋放；64-bit 鎖鍵碰撞只增加等待，不決定重用。
  def acquire_lock(digests)
    key = Digest::SHA256.digest(digests.join).unpack1("q>")
    ImportBatch.with_connection do |connection|
      connection.execute("SET LOCAL lock_timeout = '#{LOCK_TIMEOUT}'")
      connection.execute("SELECT pg_advisory_xact_lock((#{key})::bigint)")
      connection.execute("SET LOCAL lock_timeout = DEFAULT")
    end
  rescue ActiveRecord::LockWaitTimeout
    # 不在此處重送寫入，交由呼叫端以原檔重試並重新查找已提交結果。
    raise Busy
  end

  # 批次、來源證據及結果由外層交易一起提交；任一寫入失敗就整批回滾。
  def persist(identity, events, results)
    batch = ImportBatch.create!(**identity, sales_filename: @sales.filename, payments_filename: @payments.filename)
    batch.source_events.insert_all!(events) if events.any?
    batch.reconciliation_results.insert_all!(results) if results.any?
    batch
  end
end
