// 呼叫端先限定同一批次，再以門市、營業日與付款方式識別對帳分組。
export function sameReconciliationGroup(left, right) {
  return left.store_id === right.store_id
    && left.business_date === right.business_date
    && left.payment_method === right.payment_method
}

// 取消保留在批次來源，但不參與分組對帳或所選分組的證據摘要。
export function participatingSourceEvents(events, group) {
  return group ? events.filter((event) => event.event_type !== 'cancel'
    && sameReconciliationGroup(event, group)) : []
}
