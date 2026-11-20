# frozen_string_literal: true

require "csv"
require "date"

class SourceCsv
  HEADER = %w[event_id store_id business_date payment_method event_type amount original_event_id].freeze
  MAX_BYTES = 1_048_576
  MAX_ROWS = 5_000
  IDENTIFIER = /\A[A-Za-z0-9_-]{1,64}\z/
  DATE = /\A[0-9]{4}-[0-9]{2}-[0-9]{2}\z/
  PAYMENTS = %w[cash credit_card].freeze
  TYPES = %w[normal refund cancel].freeze

  class Invalid < StandardError
    attr_reader :details

    # 只在能定位時附上紀錄序號；編碼、大小等檔案錯誤不捏造列號。
    def initialize(source, code, message, record_number = nil)
      super(message)
      @details = { source: source, code: code, message: message }
      @details[:record_number] = record_number if record_number
    end
  end

  def initialize(source, raw_bytes)
    @source = source
    @raw_bytes = raw_bytes
  end

  # 完整讀入單一來源後才驗證退款，允許原交易排在退款之後。
  def parse
    csv = parser
    invalid("invalid_header", "CSV 表頭及欄位順序必須符合規格。", 1) unless csv.shift == HEADER
    events = {}
    # 表頭算第 1 筆 CSV 紀錄；引號內換行不另計為資料列。
    csv.each.with_index(2) do |row, record_number|
      event = parse_event(row, record_number)
      # 此索引只屬於當次來源，另一來源或門市可使用相同事件編號。
      key = event.values_at(:store_id, :event_id)
      invalid("duplicate_event", "同來源、同門市的事件編號不得重複。", record_number) if events.key?(key)
      events[key] = event
    end

    validate_refunds(events)
    events.values
  rescue CSV::MalformedCSVError => e
    invalid("malformed_csv", "CSV 的引號、分隔符號或換行格式不正確。", e.line_number)
  end

  private

  # 先檢查原始大小與 UTF-8，再用副本移除檔頭 BOM，保留匯入去重所需的原始內容。
  def parser
    invalid("file_too_large", "每份 CSV 最多 1 MiB。") if @raw_bytes.bytesize > MAX_BYTES
    text = @raw_bytes.dup.force_encoding(Encoding::UTF_8)
    invalid("invalid_encoding", "CSV 必須使用有效的 UTF-8 編碼。") unless text.valid_encoding?
    text = text.delete_prefix("\uFEFF")
    invalid("empty_file", "CSV 必須包含表頭。") if text.empty?

    line_ending = text[/\r?\n/]
    invalid("malformed_csv", "CSV 換行必須使用 LF 或 CRLF。", 1) if line_ending.nil? && text.include?("\r")
    CSV.new(text, row_sep: line_ending || "\n")
  end

  # 先拒絕列結構錯誤，再依固定欄序驗證；只有合法欄值會進入退款關係檢查。
  def parse_event(row, record_number)
    invalid("too_many_rows", "每份 CSV 最多 5,000 筆資料列。", record_number) if record_number > MAX_ROWS + 1
    invalid("blank_row", "CSV 不可包含空白資料列。", record_number) if row.empty?
    invalid("invalid_column_count", "紀錄欄位數必須與表頭相同。", record_number) unless row.length == HEADER.length

    event_id, store_id, date, payment_method, event_type, amount, original_event_id = row
    validate_identifier(event_id, "事件編號", record_number)
    validate_identifier(store_id, "門市編號", record_number)
    business_date = parse_date(date, record_number)
    unless PAYMENTS.include?(payment_method)
      invalid("invalid_payment_method", "付款方式必須為 cash 或 credit_card。", record_number)
    end
    invalid("invalid_event_type", "事件種類必須為 normal、refund 或 cancel。", record_number) unless TYPES.include?(event_type)

    amount = parse_amount(amount, record_number)
    original_event_id = nil if original_event_id == ""
    validate_original_id(event_type, amount, original_event_id, record_number)
    { source: @source, record_number: record_number, event_id: event_id, store_id: store_id,
      business_date: business_date, payment_method: payment_method, event_type: event_type,
      amount: amount, original_event_id: original_event_id }
  end

  # 識別碼照原值驗證，不修剪空白或轉換大小寫。
  def validate_identifier(value, label, record_number)
    return if IDENTIFIER.match?(value)

    invalid("invalid_identifier", "#{label}必須為 1–64 個英數、底線或連字號。", record_number)
  end

  # 固定日期寫法搭配公曆驗證，避免寬鬆解析或歷史曆法接受不合規的日期。
  def parse_date(value, record_number)
    return Date.iso8601(value, Date::GREGORIAN) if DATE.match?(value) && !value.start_with?("0000")

    invalid("invalid_date", "營業日必須為有效的 YYYY-MM-DD 日曆日期。", record_number)
  rescue Date::Error
    invalid("invalid_date", "營業日必須為有效的 YYYY-MM-DD 日曆日期。", record_number)
  end

  # 先驗證數字語法，再以有效位數檢查上限；前導零不影響金額。
  def parse_amount(value, record_number)
    invalid("invalid_amount", "金額必須是不含符號的十進位整數。", record_number) unless /\A[0-9]+\z/.match?(value)

    digits = value.sub(/\A0+/, "")
    invalid("amount_too_large", "單筆金額最多 999,999,999 元。", record_number) if digits.length > 9
    digits.to_i
  end

  # 退款必須為正額且指定原交易；正常與取消事件不可夾帶原交易編號。
  def validate_original_id(event_type, amount, original_event_id, record_number)
    if event_type == "refund"
      invalid("zero_refund", "退款金額必須大於零。", record_number) if amount.zero?
      validate_identifier(original_event_id, "原交易編號", record_number)
    elsif original_event_id
      invalid("unexpected_original_event", "正常與取消事件的原交易編號必須留空。", record_number)
    end
  end

  # 每個來源以門市及原交易累計全部退款，跨營業日也不能超過原額。
  def validate_refunds(events)
    refunded = Hash.new(0)
    events.each_value do |event|
      next unless event[:event_type] == "refund"

      key = event.values_at(:store_id, :original_event_id)
      original = events[key]
      validate_refund_reference(event, original)

      refunded[key] += event[:amount]
      invalid("refund_exceeds_original", "累計退款金額不得超過原交易金額。", event[:record_number]) if refunded[key] > original[:amount]
    end
  end

  # 先確認同來源、同門市的正常原交易，再檢查付款方式與退款日期；同日允許。
  def validate_refund_reference(event, original)
    row = event[:record_number]
    invalid("invalid_refund_original", "退款須引用同來源及門市的正常事件。", row) if !original || original[:event_type] != "normal"
    invalid("refund_payment_mismatch", "退款付款方式必須與原交易相同。", row) if event[:payment_method] != original[:payment_method]
    return unless event[:business_date] < original[:business_date]

    invalid("refund_before_original", "退款營業日不得早於原交易。", row)
  end

  def invalid(code, message, record_number = nil)
    raise Invalid.new(@source, code, message, record_number)
  end
end
