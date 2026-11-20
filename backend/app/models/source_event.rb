# frozen_string_literal: true

# 保存已驗證的來源事件欄位與 CSV 紀錄序號，供批次內追查交易、退款及取消。
class SourceEvent < ApplicationRecord
  belongs_to :import_batch
end
