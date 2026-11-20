// 對帳分類與人員查核結論分開呈現，標記已處理不改變原始金額差異。
export const classifications = {
  matched: '一致',
  amount_mismatch: '金額不符',
  missing_sales: '缺營業資料',
  missing_payments: '缺收款資料',
}
export const investigationStatuses = { pending: '待處理', processed: '已處理' }
export const paymentMethods = { cash: '現金', credit_card: '信用卡' }
export const sourceNames = { sales: '營業 CSV', payments: '收款 CSV' }
export const eventTypes = { normal: '正常', refund: '退款', cancel: '取消' }
export const integer = new Intl.NumberFormat('zh-TW')
export const signedInteger = new Intl.NumberFormat('zh-TW', { signDisplay: 'exceptZero' })
export const batchTime = new Intl.DateTimeFormat('zh-TW', { dateStyle: 'medium', timeStyle: 'short' })
export const investigationTime = new Intl.DateTimeFormat('zh-TW', { dateStyle: 'medium', timeStyle: 'medium' })

// 缺側顯示破折號而零元保留 0，淨額不取絕對值，差額可使用有號格式。
export function amount(value, formatter = integer) {
  return value === null ? '—' : formatter.format(value)
}

export function groupLabel(row) {
  return `${row.store_id} ${row.business_date} ${paymentMethods[row.payment_method]}`
}
