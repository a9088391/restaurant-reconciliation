# frozen_string_literal: true

class ImportBatchesController < ApplicationController
  SOURCE_EVENT_FIELDS = %i[source record_number event_id store_id business_date payment_method event_type amount
                           original_event_id].freeze

  rescue_from SourceCsv::Invalid do |error|
    render json: { error: error.details }, status: :unprocessable_content
  end
  rescue_from ImportPair::Busy do
    render_error("import_busy", "同一批資料正在匯入，請使用原檔重試。", :service_unavailable)
  end
  rescue_from ActiveRecord::RecordNotFound do
    render_error("batch_not_found", "找不到指定的對帳批次。", :not_found)
  end

  # 批次清單僅取摘要，避免連同原始檔位元組及完整來源資料載入。
  def index
    batches = ImportBatch.summary.order(created_at: :desc, id: :desc)
    render json: { batches: batches.as_json }
  end

  # 先確認 UUID 語法再查詢，無效識別與不存在批次皆使用相同的找不到回應。
  def show
    id = params[:id]
    raise ActiveRecord::RecordNotFound unless ImportBatch::UUID.match?(id)

    render json: { batch: batch_json(ImportBatch.summary.find(id)) }
  end

  # 成對 multipart 匯入：新批次回傳 201，重用既有內容回傳 200。
  def create
    unless request.media_type == "multipart/form-data"
      return render_error("multipart_required", "須以 multipart/form-data 上傳兩份 CSV。", :unprocessable_content)
    end

    outcome = ImportPair.new(sales: uploaded_csv("sales"), payments: uploaded_csv("payments")).call
    render json: { batch: batch_json(outcome.batch) }, status: outcome.reused ? :ok : :created
  rescue ActiveRecord::StatementInvalid => e
    # 儲存失敗不宣稱結果已確認；以原檔重試時仍會先比對既有批次。
    Rails.error.report(e, handled: true)
    render_error("persistence_failed", "目前無法確認匯入結果，請使用原檔重試。", :internal_server_error)
  end

  private

  # 僅接受請求本文的上傳檔案，query 參數或檔案路徑字串都不能代替。
  def uploaded_csv(source)
    upload = request.request_parameters[source]
    unless upload.is_a?(ActionDispatch::Http::UploadedFile)
      raise SourceCsv::Invalid.new(source, "file_required", "請指定要上傳的 CSV 檔案。")
    end

    # 檔名只作顯示資料，讀取 Rack 建立的暫存檔並保留原始位元組。
    # 多讀一個位元組供解析器辨識超限，避免把截斷的內容誤當合法檔案。
    bytes = upload.read(SourceCsv::MAX_BYTES + 1).to_s.b
    filename = upload.original_filename.encode("UTF-8", invalid: :replace, undef: :replace).delete("\0")
    ImportPair::UploadedCsv.new(bytes: bytes, filename: filename)
  end

  # 詳情保留全部來源事件供追查，包含未產生對帳結果的取消；不輸出原始檔與檔案雜湊值。
  def batch_json(batch)
    metadata = batch.as_json(only: ImportBatch::SUMMARY_FIELDS)
    results = batch.reconciliation_results.order(:store_id, :business_date, :payment_method)
    source_events = batch.source_events.order(:source, :record_number)
    # 結果使用 bigint 識別碼，轉為字串以免 JavaScript 數值轉換損失精度。
    metadata.merge(
      results: results.map { |result| result.as_json(except: :import_batch_id).merge("id" => result.id.to_s) },
      source_events: source_events.as_json(only: SOURCE_EVENT_FIELDS)
    )
  end
end
