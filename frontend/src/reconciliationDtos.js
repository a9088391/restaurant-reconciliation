/**
 * 描述 API 傳輸欄位，保留 snake_case、整數金額及 null，不包含畫面的草稿或讀寫旗標。
 * @typedef {'pending' | 'processed'} InvestigationStatusDto
 * @typedef {Object} ReconciliationGroupDto
 * @property {string} id
 * @property {string} store_id
 * @property {string} business_date
 * @property {'cash' | 'credit_card'} payment_method
 * @property {number | null} sales_net
 * @property {number | null} payments_net
 * @property {number | null} difference
 * @property {'matched' | 'amount_mismatch' | 'missing_sales' | 'missing_payments'} classification
 * @property {InvestigationStatusDto | null} investigation_status
 * @typedef {Object} SourceEventDto
 * @property {'sales' | 'payments'} source
 * @property {number} record_number
 * @property {string} event_id
 * @property {string} store_id
 * @property {string} business_date
 * @property {'cash' | 'credit_card'} payment_method
 * @property {'normal' | 'refund' | 'cancel'} event_type
 * @property {number} amount
 * @property {string | null} original_event_id
 * @typedef {Object} ImportBatchDto
 * @property {string} id
 * @property {string} sales_filename
 * @property {string} payments_filename
 * @property {string} created_at
 * @property {ReconciliationGroupDto[]} results
 * @property {SourceEventDto[]} source_events
 * @typedef {Object} InvestigationDto
 * @property {InvestigationStatusDto} investigation_status
 * @property {{status: InvestigationStatusDto, note: string, created_at: string}[]} records
 */

// 匯入與讀回只共用結果及來源陣列的檢查，不在此重做 CSV 或逐欄驗證。
/** @returns {data is ImportBatchDto} */
export function validBatch(data) {
  return Array.isArray(data?.results) && Array.isArray(data?.source_events)
}

// 查核回應需有已知狀態及可呈現的歷史文字、時間，才能交給畫面恢復操作。
/** @returns {data is InvestigationDto} */
export function validInvestigation(data) {
  const statuses = ['pending', 'processed']
  return statuses.includes(data?.investigation_status) && Array.isArray(data.records)
    && data.records.every((record) => statuses.includes(record?.status)
      && typeof record.note === 'string' && typeof record.created_at === 'string' && Number.isFinite(Date.parse(record.created_at)))
}
