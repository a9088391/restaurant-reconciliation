# frozen_string_literal: true

class InvestigationsController < ApplicationController
  RESULT_ID = /\A[1-9][0-9]{0,18}\z/
  MAX_RESULT_ID = (2**63) - 1

  rescue_from ActiveRecord::RecordNotFound do
    render_error("investigation_not_found", "找不到指定的異常分組。", :not_found)
  end
  rescue_from ReconciliationResult::InvestigationConflict do
    render_error("investigation_conflict", "目前狀態無法變更，請重新讀取對帳結果。", :conflict)
  end
  rescue_from ActiveRecord::StatementInvalid, ActiveRecord::RecordInvalid, ActiveRecord::RecordNotSaved do |error|
    # 寫入失敗請呼叫端先重讀現況，不將未確認的結果當作已完成查核。
    Rails.error.report(error, handled: true)
    render_error("persistence_failed", "目前無法確認查核結果，請重新讀取後再試。", :internal_server_error)
  end

  # 只有異常分組提供查核歷史；一致分組不建立查核流程。
  def show
    result = find_result
    raise ActiveRecord::RecordNotFound unless result.anomaly?

    render_investigation(result.investigation_records.to_a)
  end

  # 只讀取 JSON 本文的目標狀態與說明，驗證通過後交由模型鎖定並寫入。
  def update
    result = find_result
    status, note = request.request_parameters.values_at("status", "note") if request.media_type == "application/json"
    unless ReconciliationResult::INVESTIGATION_STATUSES.include?(status)
      return render_error("invalid_investigation_status", "請指定有效的查核狀態。", :unprocessable_content)
    end
    # 全空白不算原因；拒絕 PostgreSQL text 無法儲存的 NUL，保留其餘原文。
    unless note.is_a?(String) && note.present? && !note.include?("\0")
      return render_error("invalid_investigation_note", "請輸入有效的查核說明。", :unprocessable_content)
    end

    render_investigation(result.transition_investigation!(status: status, note: note))
  end

  private

  # 先限定 UUID 與 bigint 範圍，再以批次及結果共同查找，避免讀寫其他批次的結果。
  def find_result
    batch_id, result_id = request.path_parameters.values_at(:import_batch_id, :result_id)
    unless ImportBatch::UUID.match?(batch_id) && RESULT_ID.match?(result_id) && result_id.to_i <= MAX_RESULT_ID
      raise ActiveRecord::RecordNotFound
    end

    ReconciliationResult.find_by!(import_batch_id: batch_id, id: result_id)
  end

  # 無歷史時為初始待處理，後續以依 id 排序的最後一次轉換回報狀態。
  def render_investigation(records)
    # 從同一次歷史查詢推導狀態，避免並行更新時讀到不同時點的資料。
    render json: { investigation_status: records.last&.status || "pending",
                   records: records.as_json(only: %i[status note created_at]) }
  end
end
