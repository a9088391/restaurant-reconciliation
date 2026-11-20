# frozen_string_literal: true

# 保存成對匯入的原始檔、內容雜湊與檔名，作為來源事件及對帳結果的批次邊界。
class ImportBatch < ApplicationRecord
  UUID = /\A[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\z/i
  SUMMARY_FIELDS = %i[id created_at sales_filename payments_filename].freeze

  has_many :source_events
  has_many :reconciliation_results

  scope :summary, -> { select(*SUMMARY_FIELDS) }
end
