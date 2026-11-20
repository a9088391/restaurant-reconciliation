# frozen_string_literal: true

# 保存單次查核轉換的狀態、說明與時間，供結果依新增順序回查歷史。
class InvestigationRecord < ApplicationRecord
  belongs_to :reconciliation_result
end
