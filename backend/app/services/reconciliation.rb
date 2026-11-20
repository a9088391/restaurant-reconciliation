# frozen_string_literal: true

class Reconciliation
  # 各組獨立比較營業與收款淨額，只有異常結果需要初始查核狀態。
  def self.calculate(events)
    totals_by_group(events).map do |(store_id, date, method), totals|
      sales = totals.fetch("sales", nil)
      payments = totals.fetch("payments", nil)
      # nil 表示缺資料；零元仍有資料，兩側都有值才計算有號差額。
      difference = sales - payments if sales && payments
      classification = classification_for(sales, payments, difference)
      { store_id: store_id, business_date: date, payment_method: method,
        sales_net: sales, payments_net: payments, difference: difference, classification: classification,
        investigation_status: classification == "matched" ? nil : "pending" }
    end
  end

  # 退款扣在自身營業日；取消連存在性都不計入，但已完成零元事件仍建立分組。
  def self.totals_by_group(events)
    groups = {}
    events.each do |event|
      next if event[:event_type] == "cancel"

      key = event.values_at(:store_id, :business_date, :payment_method)
      totals = groups[key] ||= Hash.new(0)
      amount = event[:amount]
      totals[event[:source]] += event[:event_type] == "refund" ? -amount : amount
    end
    groups
  end
  private_class_method :totals_by_group

  # 先區分單側缺資料，再以精確差額判定一致，不用零元填補缺少的一側。
  def self.classification_for(sales, payments, difference)
    return "missing_sales" if sales.nil?
    return "missing_payments" if payments.nil?

    difference.zero? ? "matched" : "amount_mismatch"
  end
  private_class_method :classification_for
end
