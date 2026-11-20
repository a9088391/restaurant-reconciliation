# frozen_string_literal: true

# 保存批次內各門市、營業日及付款方式的對帳結果與查核狀態，並關聯處理紀錄。
class ReconciliationResult < ApplicationRecord
  INVESTIGATION_STATUSES = %w[pending processed].freeze

  # 一致分組或目前已是目標狀態時中止轉換，由控制器回傳 409。
  class InvestigationConflict < StandardError; end

  belongs_to :import_batch
  has_many :investigation_records, -> { order(:id) }, inverse_of: :reconciliation_result

  def anomaly?
    classification != "matched"
  end

  # 鎖定並重讀結果後才判定轉換，查核狀態與歷史共用交易，不改原始對帳分類及金額。
  def transition_investigation!(status:, note:)
    with_lock do
      # 目前已是目標狀態時回報衝突，避免再次新增相同狀態的歷史。
      raise InvestigationConflict if !anomaly? || investigation_status == status

      update!(investigation_status: status)
      investigation_records.create!(status: status, note: note)
      investigation_records.to_a
    end
  end
end
