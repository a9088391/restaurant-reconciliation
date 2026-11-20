<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef } from 'vue'
import InvestigationInspector from './InvestigationInspector.vue'
import { validBatch, validInvestigation } from './reconciliationDtos.js'
import { participatingSourceEvents, sameReconciliationGroup } from './reconciliationGroup.js'
import { amount, batchTime, classifications, eventTypes, groupLabel, investigationStatuses, paymentMethods, signedInteger, sourceNames } from './reconciliationPresentation.js'

const batchesPath = '/api/import_batches'
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i

const batches = shallowRef([])
// 批次選取與 Escape 都會收合原生選單，並把焦點交回選單入口。
const batchMenu = ref(null)
const listError = ref('')
const loadingList = ref(false)
// 網址選取與已讀回快照分開保存，明細尚未確認時不沿用上一批的結果。
const selectedId = ref(null)
const selectedBatch = shallowRef(null)
const detailError = ref('')
const loadingDetail = ref(false)
const importing = ref(false)
const importError = ref('')
const importNotice = shallowRef(null)
// 來源追查與異常查核各自選取分組，開啟其中一側不改另一側的目標。
const sourceTrace = ref(null)
const sourceTraceHeading = ref(null)
const refundTrace = ref(null)
// 草稿、已知歷史與待確認寫入依批次及分組保存，關閉面板不清除它們。
const investigations = ref(new Map())
const activeInvestigation = ref(null)
const investigationInspector = ref(null)
const investigationRequests = new Set()
let investigationOpener
// 序號只隔離前端交錯回應，不能推定資料庫快照的新舊順序。
let investigationRevision = 0
let batchReadRevision = 0
let sourceTraceOpener
let listRequest
let detailRequest
let importRequest
let navigation = 0

const tracedGroup = computed(() => {
  const trace = sourceTrace.value
  if (trace?.type !== 'group') return null
  return selectedBatch.value?.results.find((row) => sameReconciliationGroup(row, trace)) ?? null
})

// 完整追查依來源選取切換批次、分組或退款，不借用查核面板的選取。
const tracedEvents = computed(() => {
  const batch = selectedBatch.value
  const trace = sourceTrace.value
  if (!batch || !trace) return []
  const events = batch.source_events ?? []
  if (refundTrace.value) {
    // 原交易可跨營業日，但必須與所選退款同來源、同門市，且只顯示這一筆退款。
    const { source, store_id: storeId, event_id: refundEventId, original_event_id: originalEventId } = refundTrace.value
    return events.filter((event) => event.source === source && event.store_id === storeId && (
      (event.event_type === 'normal' && event.event_id === originalEventId)
      || (event.event_type === 'refund' && event.event_id === refundEventId)
    ))
  }
  // 批次檢視保留取消；只有分組檢視排除不參與對帳的來源列。
  if (trace.type === 'batch') return events
  return participatingSourceEvents(events, trace)
})

const sourceTraceTitle = computed(() => {
  if (refundTrace.value) {
    return `原交易追查：${sourceNames[refundTrace.value.source]} · ${refundTrace.value.original_event_id}`
  }
  if (sourceTrace.value?.type === 'batch') return '批次來源紀錄'
  if (sourceTrace.value?.type === 'group') {
    const { store_id: storeId, business_date: businessDate, payment_method: paymentMethod } = sourceTrace.value
    return `來源紀錄：${storeId} · ${businessDate} · ${paymentMethods[paymentMethod]}`
  }
  return ''
})

const isReopening = computed(() => activeInvestigation.value?.data?.investigation_status === 'processed')
const noteLabel = computed(() => isReopening.value ? '恢復原因' : '處理說明')

function batchLink(id) {
  const url = new URL(window.location.href)
  url.searchParams.set('batch', id)
  return `${url.pathname}${url.search}${url.hash}`
}

// 保留修飾鍵開新分頁的原生連結行為，普通點選才接手頁內導航。
function openBatch(event, id) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  event.preventDefault()
  // 選單收合後把焦點交回入口，避免留在已隱藏的批次連結。
  if (batchMenu.value?.contains(event.currentTarget)) {
    batchMenu.value.open = false
    batchMenu.value.querySelector('summary')?.focus()
  }
  navigateToBatch(id)
}

// 只有切換批次才新增瀏覽紀錄，同一批次重讀不堆疊重複網址。
function navigateToBatch(id, batch, readRevision) {
  if (new URLSearchParams(window.location.search).get('batch') !== id) {
    window.history.pushState(null, '', batchLink(id))
  }
  showBatch(id, batch, readRevision)
}

// 上一頁、下一頁與初次開啟深連結共用相同的批次讀取流程。
function readLocation() {
  showBatch(new URLSearchParams(window.location.search).get('batch'))
}

// 新清單讀取取代舊請求，失敗時保留已載入項目及手動重試入口。
async function loadBatches() {
  listRequest?.abort()
  const request = new AbortController()
  listRequest = request
  loadingList.value = true
  listError.value = ''

  try {
    const response = await fetch(batchesPath, { signal: request.signal })
    if (!response.ok) throw new Error('讀取批次清單失敗')
    const { batches: items } = await response.json()
    if (!Array.isArray(items)) throw new Error('批次清單格式錯誤')
    if (!request.signal.aborted) batches.value = items
  } catch {
    if (!request.signal.aborted) listError.value = '無法讀取批次清單，請重試。'
  } finally {
    if (!request.signal.aborted) loadingList.value = false
  }
}

// 套用批次快照時一併核對已知查核狀態，衝突先補讀而非覆蓋處理歷史。
function applyBatch(batch) {
  selectedBatch.value = batch
  if (!batch || investigations.value.size === 0) return
  for (const row of batch.results) {
    const entry = investigations.value.get(`${batch.id}/${row.id}`)
    if (!entry) continue
    // 每次實際套用快照都使先前啟動的歷史讀取失效，包含補讀中的再次套用。
    entry.snapshotRevision += 1
    if ((entry.revision > batchReadRevision || entry.loading) && !entry.saving
      && entry.data && entry.data.investigation_status !== row.investigation_status) {
      // 回應先後不能排序 DB 快照；保留已知紀錄，補讀成功前不宣稱目前狀態。
      const alreadyRequired = entry.readRequired
      entry.readRequired = true
      if (!alreadyRequired) readInvestigation(entry)
    }
  }
}

// 切換批次先撤銷舊明細與面板選取；原分組的草稿及在途查核仍留在快取。
async function showBatch(id, batch = null, readRevision = investigationRevision) {
  navigation += 1
  detailRequest?.abort()
  clearSourceTrace()
  clearInvestigation()
  batchReadRevision = readRevision
  selectedId.value = id
  applyBatch(batch)
  detailError.value = ''
  loadingDetail.value = false
  if (id === null || batch) return
  if (!uuid.test(id)) {
    detailError.value = '找不到指定的對帳批次。'
    return
  }

  const request = new AbortController()
  detailRequest = request
  loadingDetail.value = true

  try {
    const response = await fetch(`${batchesPath}/${id}`, { signal: request.signal })
    if (request.signal.aborted) return
    if (response.status === 404) {
      detailError.value = '找不到指定的對帳批次。'
      return
    }
    if (!response.ok) throw new Error('讀取批次失敗')
    const { batch: result } = await response.json()
    if (!validBatch(result)) throw new Error('批次結果格式錯誤')
    if (!request.signal.aborted) applyBatch(result)
  } catch {
    if (!request.signal.aborted) detailError.value = '無法讀取對帳批次，請重試。'
  } finally {
    if (!request.signal.aborted) loadingDetail.value = false
  }
}

// 422 定位來源與紀錄，403 提示拒絕，503 僅在 import_busy 時提示等待，其餘維持待確認。
function formatImportError(response, payload) {
  const { status } = response
  const error = payload?.error
  if (status === 422) {
    const source = sourceNames[error?.source]
    const record = error?.record_number == null ? '' : `第 ${error.record_number} 筆紀錄`
    const reason = error?.message || '請檢查兩份 CSV 後再提交。'
    return [source, record, reason].filter(Boolean).join('，')
  }
  if (status === 403) return '提交憑證已失效或請求遭拒，請使用原檔重新提交。'
  if (status === 503 && error?.code === 'import_busy') return '同一批資料正在匯入，請稍後使用原檔重試。'
  return '目前無法確認匯入結果，請使用原檔重試。'
}

// 每次寫入即時取得同源防偽憑證，不沿用服務重啟前的舊值。
async function fetchCsrfToken(signal) {
  const response = await fetch('/api/csrf_token', { signal, cache: 'no-store' })
  if (!response.ok) throw new Error('取得提交憑證失敗')
  const { csrf_token: token } = await response.json()
  if (!token) throw new Error('缺少提交憑證')
  return token
}

// 一次送出兩份原檔，失敗或結果不明都保留選檔，僅由使用者明確重試。
async function submitImport(event) {
  if (importing.value) return
  const form = event.currentTarget
  const files = new FormData(form)
  const submittedAt = navigation
  const request = new AbortController()
  importRequest = request
  importing.value = true
  importNotice.value = null
  importError.value = ''
  let sent = false

  try {
    // 每次由使用者送出時取得憑證，讓重啟後可保留原檔重試。
    const csrfToken = await fetchCsrfToken(request.signal)
    const readRevision = investigationRevision
    sent = true
    const response = await fetch(batchesPath, {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrfToken },
      body: files,
      signal: request.signal,
    })
    const payload = await response.json().catch(() => null)
    if (request.signal.aborted) return
    const batch = payload?.batch
    if (!response.ok || !uuid.test(batch?.id) || !validBatch(batch)) {
      importError.value = formatImportError(response, payload)
      return
    }

    // 只有成功且包含可讀批次的回應才清空檔案，重用批次也視為已確認。
    form.reset()
    importNotice.value = { id: batch.id, reused: response.status === 200 }
    // 遲到的匯入只留下回饋與清單入口，不搶回使用者已切換的批次。
    if (submittedAt === navigation) navigateToBatch(batch.id, batch, readRevision)
    loadBatches()
  } catch {
    if (!request.signal.aborted) {
      importError.value = sent
        ? '目前無法確認匯入結果，請使用原檔重試。'
        : '無法取得提交憑證，請重試。'
    }
  } finally {
    if (!request.signal.aborted) importing.value = false
  }
}

// 摘要與表格共用讀回狀態，未確認的寫入不歸入待處理或已處理。
function currentInvestigationStatus(row) {
  const entry = investigations.value.get(`${selectedBatch.value.id}/${row.id}`)
  if (entry?.readRequired) return null
  return entry?.revision > batchReadRevision ? entry.data?.investigation_status : row.investigation_status
}

function investigationStatus(row) {
  const status = currentInvestigationStatus(row)
  return investigationStatuses[status] ?? (row.classification === 'matched' ? '—' : '查核狀態待確認')
}

// 查核變更不參與排序，避免儲存後移動使用者正在操作的列。
const resultRows = computed(() => [...(selectedBatch.value?.results ?? [])].sort((a, b) =>
  Number(a.classification === 'matched') - Number(b.classification === 'matched'),
))
// 一致是對帳分類；已處理只是查核結論，不能把原異常算成一致。
const summary = computed(() => {
  const counts = { pending: 0, processed: 0, matched: 0, unknown: 0 }
  for (const row of selectedBatch.value?.results ?? []) {
    if (row.classification === 'matched') counts.matched += 1
    else {
      const status = currentInvestigationStatus(row)
      if (status === 'pending' || status === 'processed') counts[status] += 1
      else counts.unknown += 1
    }
  }
  return counts
})
const inspectedGroup = computed(() => selectedBatch.value?.results.find((row) => row.id === activeInvestigation.value?.id) ?? null)
// 面板證據只取查核分組，不沿用可能指向另一分組或退款的來源追查狀態。
const inspectedEvents = computed(() => participatingSourceEvents(
  selectedBatch.value?.source_events ?? [], inspectedGroup.value,
))

function isInvestigationOpen(row) {
  return activeInvestigation.value?.id === row.id
}

// 離開批次只移除查核選取與舊按鈕參照，不把關閉面板當成撤銷寫入。
function clearInvestigation() {
  activeInvestigation.value = null
  investigationOpener = null
}

// 明確關閉時回到原結果列，仍保留該分組未送出或待確認的內容。
function closeInvestigation() {
  const opener = investigationOpener
  clearInvestigation()
  opener?.focus()
}

// 每個批次與分組共用自己的查核狀態，重新展開時可接續原草稿。
async function toggleInvestigation(event, row) {
  if (isInvestigationOpen(row)) {
    closeInvestigation()
    return
  }

  const batchId = selectedBatch.value.id
  const key = `${batchId}/${row.id}`
  if (!investigations.value.has(key)) {
    investigations.value.set(key, {
      id: row.id,
      batchId,
      label: groupLabel(row),
      path: `${batchesPath}/${batchId}/results/${row.id}/investigation`,
      data: null,
      revision: 0,
      snapshotRevision: 0,
      draft: '',
      error: '',
      notice: '',
      loading: false,
      saving: false,
      readReady: false,
      readRequired: false,
      missing: false,
      attempt: null,
    })
  }
  const entry = investigations.value.get(key)
  investigationOpener = event.currentTarget
  activeInvestigation.value = entry
  // 待確認時重開面板只保留草稿與讀回入口，不因展開而再次發起讀取。
  if (!entry.readRequired) readInvestigation(entry)
  await nextTick()
  if (activeInvestigation.value === entry) investigationInspector.value?.focusHeading()
}

function publishInvestigation(entry, data, revision) {
  entry.data = data
  entry.revision = revision
}

// 只讀回原分組以恢復操作資格，查詢失敗保留既有歷史與草稿。
async function readInvestigation(entry) {
  if (entry.loading || entry.saving || entry.missing) return
  const request = new AbortController()
  investigationRequests.add(request)
  entry.loading = true
  entry.readReady = false
  const revision = ++investigationRevision
  const snapshotRevision = entry.snapshotRevision
  // 讀取期間若已套用批次快照，這次歷史就不能再作為目前狀態的依據。
  const isSuperseded = () => snapshotRevision !== entry.snapshotRevision
    || (entry.batchId === selectedId.value && revision <= batchReadRevision)

  try {
    const response = await fetch(entry.path, { signal: request.signal, cache: 'no-store' })
    const data = response.ok ? await response.json() : null
    if (request.signal.aborted) return
    if (isSuperseded()) return
    // 原分組已不存在時停止讀寫，保留已知內容並引導重新開啟批次。
    if (response.status === 404) {
      entry.missing = true
      entry.error = '找不到此異常分組，請重新開啟對帳批次。'
      return
    }
    if (!response.ok || !validInvestigation(data)) throw new Error('讀取查核紀錄失敗')
    publishInvestigation(entry, data, revision)
    entry.error = ''
    if (entry.readRequired) {
      const attempt = entry.attempt
      // 只有原歷史後恰好多出同狀態、同說明的一筆，才清除待確認操作的草稿。
      const record = attempt && data.records[attempt.recordCount]
      if (record && data.records.length === attempt.recordCount + 1 && record.status === attempt.status && record.note === attempt.note) {
        entry.draft = ''
        entry.notice = '已讀回相符的處理紀錄。'
      } else {
        // 無法核對與本次操作完全相符的新增紀錄，恢復查核後仍保留文字供使用者確認。
        entry.notice = '已更新查核狀態與歷史，請核對目前狀態後再送出。'
      }
      entry.attempt = null
      entry.readRequired = false
    }
    entry.readReady = true
  } catch {
    if (!request.signal.aborted && !isSuperseded()) entry.error = '無法讀取查核紀錄，請重試讀取。'
  } finally {
    investigationRequests.delete(request)
    entry.loading = false
    // 舊讀取失效後只替目前仍需確認的批次補讀，不重送任何查核寫入。
    if (!request.signal.aborted && isSuperseded() && entry.batchId === selectedId.value
      && (activeInvestigation.value === entry || entry.readRequired)) readInvestigation(entry)
  }
}

// 等唯讀與錯誤狀態完成更新，且面板仍屬原分組時才移回輸入欄。
async function focusInvestigationNote(entry) {
  await nextTick()
  if (activeInvestigation.value === entry) investigationInspector.value?.focusNote()
}

// 僅在已讀回且無未確認寫入時送出一次狀態變更，說明原文交由後端驗證。
async function submitInvestigation() {
  const entry = activeInvestigation.value
  if (!entry || !entry.readReady || entry.readRequired || entry.saving || entry.loading) return
  entry.notice = ''
  entry.error = ''
  const label = noteLabel.value
  if (!entry.draft.trim()) {
    entry.error = `請輸入${label}。`
    focusInvestigationNote(entry)
    return
  }

  const status = isReopening.value ? 'pending' : 'processed'
  const note = entry.draft
  const batchBeforeWrite = selectedBatch.value
  const request = new AbortController()
  investigationRequests.add(request)
  entry.saving = true
  let sent = false
  let refresh = false

  try {
    const csrfToken = await fetchCsrfToken(request.signal)
    sent = true
    const response = await fetch(entry.path, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ status, note }),
      signal: request.signal,
    })
    const payload = await response.json().catch(() => null)
    if (request.signal.aborted) return
    if (response.ok && validInvestigation(payload) && payload.investigation_status === status
      && payload.records.at(-1)?.note === note && payload.records.length > entry.data.records.length) {
      // 確認的是這筆操作；寫入期間實際套用的同批快照可能來自另一工作階段。
      const currentBatch = selectedBatch.value
      const overlappingRow = currentBatch !== batchBeforeWrite && currentBatch?.id === entry.batchId
        ? currentBatch.results.find((row) => row.id === entry.id) : null
      refresh = overlappingRow != null && overlappingRow.investigation_status !== payload.investigation_status
      publishInvestigation(entry, payload, ++investigationRevision)
      entry.readRequired = refresh
      entry.draft = ''
      entry.notice = status === 'processed' ? '已標記已處理。' : '已恢復待處理。'
      return
    }
    // 憑證拒絕未確認任何查核變更，保留草稿供使用者明確重試。
    if (response.status === 403) {
      entry.error = '查核憑證已失效或請求遭拒，請保留說明並重試送出。'
      return
    }
    // 說明無效可直接更正；其他拒絕須先重讀狀態，不能沿用舊的操作資格。
    if (response.status === 422) {
      if (payload?.error?.code === 'invalid_investigation_note') {
        entry.error = `請輸入有效的${label}。`
        focusInvestigationNote(entry)
      } else {
        entry.readRequired = true
        entry.error = '查核狀態未能變更，請重新讀取後再試。'
      }
      return
    }
    // 競爭衝突只開放讀回，不自動以原草稿再送一次。
    if (response.status === 409) {
      entry.readRequired = true
      entry.error = '查核狀態已變更，請重新讀取後再試。'
      return
    }
    if (response.status === 404) {
      entry.missing = true
      entry.error = '找不到此異常分組，請重新開啟對帳批次。'
      return
    }
    throw new Error('未確認查核結果')
  } catch {
    if (request.signal.aborted) return
    if (sent) {
      // 已送出的請求可能生效，記下本次狀態、原文及歷史長度供讀回核對。
      entry.readRequired = true
      entry.attempt = { status, note, recordCount: entry.data.records.length }
      entry.error = '目前無法確認查核結果，請先重新讀取再決定是否重試。'
    } else {
      entry.error = '無法取得查核憑證，請重試送出。'
    }
  } finally {
    investigationRequests.delete(request)
    entry.saving = false
    // 成功寫入若與期間套用的同批快照不同，解除儲存鎖後只補讀原分組。
    if (refresh) readInvestigation(entry)
  }
}

function isGroupTrace(row) {
  const trace = sourceTrace.value
  return trace?.type === 'group' && sameReconciliationGroup(trace, row)
}

// 切換批次一併清除來源與退款選取，避免舊識別套到新批資料。
function clearSourceTrace() {
  sourceTrace.value = null
  refundTrace.value = null
  sourceTraceOpener = null
}

// 關閉完整追查只清除來源選取，查核面板仍維持原分組與草稿。
function closeSourceTrace() {
  const opener = sourceTraceOpener
  clearSourceTrace()
  opener?.focus()
}

// 切換完整來源時清掉退款子選取，標題更新後才交付焦點。
async function toggleSourceTrace(opener, trace) {
  if (!trace) {
    closeSourceTrace()
    return
  }
  sourceTraceOpener = opener
  sourceTrace.value = trace
  refundTrace.value = null
  // 等標題更新後再移焦點；批次切換會清掉舊觸發按鈕。
  await nextTick()
  if (sourceTraceOpener === opener) sourceTraceHeading.value?.focus()
}

function toggleGroupTrace(event, row) {
  toggleSourceTrace(event.currentTarget, isGroupTrace(row) ? null : {
    type: 'group',
    store_id: row.store_id,
    business_date: row.business_date,
    payment_method: row.payment_method,
  })
}

function toggleBatchTrace(event) {
  toggleSourceTrace(event.currentTarget, sourceTrace.value?.type === 'batch' ? null : { type: 'batch' })
}

function isRefundTrace(event) {
  const trace = refundTrace.value
  return trace?.source === event.source
    && trace.store_id === event.store_id
    && trace.event_id === event.event_id
    && trace.original_event_id === event.original_event_id
}

// 同一退款再次點選會回到原批次或分組檢視，不改變父層來源選取。
function toggleRefundTrace(event) {
  if (isRefundTrace(event)) {
    refundTrace.value = null
    return
  }
  refundTrace.value = {
    source: event.source,
    store_id: event.store_id,
    event_id: event.event_id,
    original_event_id: event.original_event_id,
  }
}

function filenameForSource(source) {
  return selectedBatch.value?.[`${source}_filename`] ?? '—'
}

function formatBatchTime(value) {
  return batchTime.format(new Date(value))
}

// 初次掛載只讀網址批次與清單，不自動匯入或提交查核。
onMounted(() => {
  window.addEventListener('popstate', readLocation)
  readLocation()
  loadBatches()
})

// 卸載時停止導航監聽及所有傳輸；中止寫入不代表伺服器已回滾。
onUnmounted(() => {
  window.removeEventListener('popstate', readLocation)
  listRequest?.abort()
  detailRequest?.abort()
  importRequest?.abort()
  for (const request of investigationRequests) request.abort()
})
</script>

<template>
  <header class="page-header">
    <div class="page-width header-content">
      <div class="brand">
        <span
          class="brand-icon"
          aria-hidden="true"
        />
        <h1>門市營業對帳</h1>
      </div>
      <details
        ref="batchMenu"
        class="batch-menu"
        @keydown.esc.prevent="batchMenu.open = false; batchMenu.querySelector('summary').focus()"
      >
        <summary>對帳批次 <span aria-hidden="true">⌄</span></summary>
        <section
          class="batch-menu-panel"
          aria-labelledby="history-title"
        >
          <h2 id="history-title">
            對帳批次
          </h2>
          <p
            v-if="loadingList && batches.length === 0"
            class="muted"
            role="status"
          >
            正在讀取批次清單…
          </p>
          <div
            v-if="listError"
            class="feedback-row"
          >
            <p
              class="error"
              role="alert"
            >
              {{ listError }}
            </p>
            <button
              class="secondary"
              type="button"
              @click="loadBatches"
            >
              重試讀取清單
            </button>
          </div>
          <ul
            v-if="batches.length"
            class="batch-list"
          >
            <li
              v-for="batch in batches"
              :key="batch.id"
            >
              <a
                :href="batchLink(batch.id)"
                :aria-current="selectedId === batch.id ? 'page' : undefined"
                @click="openBatch($event, batch.id)"
              >
                <time :datetime="batch.created_at">{{ formatBatchTime(batch.created_at) }}</time>
                <span>營業 · {{ batch.sales_filename }}</span>
                <span>收款 · {{ batch.payments_filename }}</span>
              </a>
            </li>
          </ul>
          <p
            v-else-if="!loadingList && !listError"
            class="muted"
          >
            尚無對帳批次。
          </p>
        </section>
      </details>
    </div>
  </header>

  <main class="page-width workspace">
    <div class="primary">
      <div class="import-overview">
        <section
          class="panel import-panel"
          aria-labelledby="import-title"
        >
          <h2 id="import-title">
            匯入對帳資料
          </h2>
          <p class="muted">
            請選擇同一批次的兩份 CSV 檔案，再成對匯入。
          </p>
          <form @submit.prevent="submitImport">
            <fieldset
              class="upload-fields"
              :disabled="importing"
            >
              <div class="file-field">
                <label for="sales">營業 CSV</label>
                <input
                  id="sales"
                  name="sales"
                  type="file"
                  accept=".csv,text/csv"
                  required
                >
              </div>
              <div class="file-field">
                <label for="payments">收款 CSV</label>
                <input
                  id="payments"
                  name="payments"
                  type="file"
                  accept=".csv,text/csv"
                  required
                >
              </div>
              <button type="submit">
                {{ importing ? '匯入中…' : '匯入並對帳' }}
              </button>
            </fieldset>
          </form>
          <p
            v-if="importing"
            class="muted feedback"
            role="status"
          >
            正在提交對帳資料。
          </p>
          <p
            v-if="importError"
            class="error feedback"
            role="alert"
          >
            {{ importError }}
          </p>
          <p
            v-if="importNotice"
            class="notice feedback"
            role="status"
          >
            <template v-if="selectedBatch?.id === importNotice.id">
              {{ importNotice.reused ? '已開啟既有批次。' : '已建立新批次。' }}
            </template>
            <template v-else>
              {{ importNotice.reused ? '這對檔案已有對帳結果。' : '已建立新批次。' }}
              <a
                :href="batchLink(importNotice.id)"
                @click="openBatch($event, importNotice.id)"
              >{{ importNotice.reused ? '開啟既有批次' : '開啟新批次' }}</a>
            </template>
          </p>
        </section>

        <section
          class="panel batch-overview"
          aria-labelledby="summary-title"
        >
          <h2 id="summary-title">
            本批次
          </h2>
          <dl
            v-if="selectedBatch"
            class="summary-counts"
          >
            <div class="summary-pending">
              <dt>待處理</dt><dd>{{ summary.pending }}</dd>
            </div>
            <div class="summary-matched">
              <dt>一致</dt><dd>{{ summary.matched }}</dd>
            </div>
            <div
              v-if="summary.processed"
              class="summary-processed"
            >
              <dt>已處理</dt><dd>{{ summary.processed }}</dd>
            </div>
            <div
              v-if="summary.unknown"
              class="summary-unknown"
            >
              <dt>待確認</dt><dd>{{ summary.unknown }}</dd>
            </div>
          </dl>
          <p
            v-else
            class="muted"
          >
            {{ loadingDetail ? '正在讀取批次…' : '開啟批次後顯示摘要' }}
          </p>
        </section>
      </div>
      <div
        class="results-workspace"
        :class="{ 'has-inspector': activeInvestigation }"
      >
        <section
          class="panel results-panel"
          aria-labelledby="result-title"
        >
          <div class="result-header">
            <h2 id="result-title">
              對帳結果
            </h2>
            <template v-if="selectedBatch">
              <dl class="batch-info">
                <div>
                  <dt>營業 CSV</dt>
                  <dd>{{ selectedBatch.sales_filename }}</dd>
                </div>
                <div>
                  <dt>收款 CSV</dt>
                  <dd>{{ selectedBatch.payments_filename }}</dd>
                </div>
                <div>
                  <dt>匯入時間</dt>
                  <dd><time :datetime="selectedBatch.created_at">{{ formatBatchTime(selectedBatch.created_at) }}</time></dd>
                </div>
              </dl>
              <p class="source-entry">
                <button
                  class="secondary"
                  type="button"
                  aria-controls="source-trace"
                  :aria-expanded="sourceTrace?.type === 'batch'"
                  @click="toggleBatchTrace"
                >
                  {{ sourceTrace?.type === 'batch' ? '隱藏批次來源紀錄' : '查看批次來源紀錄' }}
                </button>
              </p>
            </template>
          </div>
          <p
            v-if="loadingDetail"
            class="muted"
            role="status"
          >
            正在讀取對帳批次…
          </p>
          <div
            v-else-if="detailError"
            class="feedback-row"
          >
            <p
              class="error"
              role="alert"
            >
              {{ detailError }}
            </p>
            <button
              v-if="uuid.test(selectedId)"
              class="secondary"
              type="button"
              @click="showBatch(selectedId)"
            >
              重試讀取批次
            </button>
          </div>
          <template v-else-if="selectedBatch">
            <p
              v-if="selectedBatch.results.length === 0"
              class="empty-state"
              role="status"
            >
              沒有可比較資料。
            </p>
            <div
              v-else
              class="table-scroll"
              role="region"
              aria-label="對帳分組表格"
              tabindex="0"
            >
              <table>
                <caption>對帳分組<span>（新臺幣元）</span></caption>
                <thead>
                  <tr>
                    <th scope="col">
                      門市
                    </th>
                    <th scope="col">
                      營業日
                    </th>
                    <th scope="col">
                      付款方式
                    </th>
                    <th
                      scope="col"
                      class="number"
                    >
                      營業淨額
                    </th>
                    <th
                      scope="col"
                      class="number"
                    >
                      收款淨額
                    </th>
                    <th
                      scope="col"
                      class="number"
                    >
                      差額
                    </th>
                    <th scope="col">
                      結果
                    </th>
                    <th scope="col">
                      查核狀態
                    </th>
                    <th scope="col">
                      來源
                    </th>
                    <th scope="col">
                      查核
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="row in resultRows"
                    :key="row.id"
                    :class="{ 'row-selected': isInvestigationOpen(row), 'row-anomaly': row.classification !== 'matched' }"
                  >
                    <th
                      scope="row"
                      class="store"
                    >
                      {{ row.store_id }}
                    </th>
                    <td>{{ row.business_date }}</td>
                    <td>{{ paymentMethods[row.payment_method] }}</td>
                    <td class="number">
                      {{ amount(row.sales_net) }}
                    </td>
                    <td class="number">
                      {{ amount(row.payments_net) }}
                    </td>
                    <td class="number">
                      {{ amount(row.difference, signedInteger) }}
                    </td>
                    <td>
                      <span
                        class="classification"
                        :class="{ 'classification-matched': row.classification === 'matched' }"
                      >{{ classifications[row.classification] ?? '未知結果' }}</span>
                    </td>
                    <td><span :class="{ 'status-badge': row.classification !== 'matched' }">{{ investigationStatus(row) }}</span></td>
                    <td>
                      <button
                        class="source-action"
                        type="button"
                        aria-controls="source-trace"
                        :aria-expanded="isGroupTrace(row)"
                        :aria-label="isGroupTrace(row) ? `隱藏 ${groupLabel(row)}來源` : `查看 ${groupLabel(row)}來源`"
                        @click="toggleGroupTrace($event, row)"
                      >
                        {{ isGroupTrace(row) ? '隱藏來源' : '來源' }}
                      </button>
                    </td>
                    <td>
                      <button
                        v-if="row.investigation_status"
                        class="secondary"
                        type="button"
                        aria-controls="investigation"
                        :aria-label="`查核 ${groupLabel(row)}`"
                        :aria-expanded="isInvestigationOpen(row)"
                        @click="toggleInvestigation($event, row)"
                      >
                        查核
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <section
              v-show="sourceTrace"
              id="source-trace"
              class="source-trace"
              role="region"
              aria-label="來源追查結果"
            >
              <template v-if="sourceTrace">
                <h3
                  ref="sourceTraceHeading"
                  aria-live="polite"
                  tabindex="-1"
                >
                  {{ sourceTraceTitle }}
                </h3>
                <dl
                  v-if="tracedGroup"
                  class="trace-summary"
                >
                  <div>
                    <dt>門市</dt>
                    <dd>{{ tracedGroup.store_id }}</dd>
                  </div>
                  <div>
                    <dt>營業日</dt>
                    <dd>{{ tracedGroup.business_date }}</dd>
                  </div>
                  <div>
                    <dt>付款方式</dt>
                    <dd>{{ paymentMethods[tracedGroup.payment_method] }}</dd>
                  </div>
                  <div>
                    <dt>營業淨額</dt>
                    <dd>{{ amount(tracedGroup.sales_net) }}</dd>
                  </div>
                  <div>
                    <dt>收款淨額</dt>
                    <dd>{{ amount(tracedGroup.payments_net) }}</dd>
                  </div>
                  <div>
                    <dt>差額</dt>
                    <dd>{{ amount(tracedGroup.difference, signedInteger) }}</dd>
                  </div>
                </dl>
                <button
                  class="secondary"
                  type="button"
                  @click="closeSourceTrace"
                >
                  關閉來源追查
                </button>
                <div
                  class="table-scroll source-table-scroll"
                  role="region"
                  aria-label="來源紀錄表格"
                  tabindex="0"
                >
                  <table class="source-events">
                    <caption>{{ refundTrace ? '原交易與退款紀錄' : '來源紀錄' }}<span>（新臺幣元；CSV 表頭為第 1 紀錄）</span></caption>
                    <thead>
                      <tr>
                        <th scope="col">
                          來源
                        </th>
                        <th scope="col">
                          檔名
                        </th>
                        <th scope="col">
                          CSV 紀錄
                        </th>
                        <th scope="col">
                          事件編號
                        </th>
                        <th scope="col">
                          門市
                        </th>
                        <th scope="col">
                          營業日
                        </th>
                        <th scope="col">
                          付款方式
                        </th>
                        <th scope="col">
                          事件種類
                        </th>
                        <th
                          scope="col"
                          class="number"
                        >
                          來源列金額
                        </th>
                        <th scope="col">
                          原交易編號
                        </th>
                        <th scope="col">
                          追查
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr
                        v-for="event in tracedEvents"
                        :key="`${event.source}:${event.record_number}`"
                      >
                        <td>{{ sourceNames[event.source] }}</td>
                        <td class="filename">
                          {{ filenameForSource(event.source) }}
                        </td>
                        <td>{{ event.record_number }}</td>
                        <td>{{ event.event_id }}</td>
                        <td>{{ event.store_id }}</td>
                        <td>{{ event.business_date }}</td>
                        <td>{{ paymentMethods[event.payment_method] }}</td>
                        <td>{{ eventTypes[event.event_type] }}</td>
                        <td class="number">
                          {{ amount(event.amount) }}
                        </td>
                        <td>{{ event.original_event_id ?? '—' }}</td>
                        <td>
                          <button
                            v-if="event.event_type === 'refund'"
                            class="secondary"
                            type="button"
                            aria-controls="source-trace"
                            :aria-expanded="isRefundTrace(event)"
                            @click="toggleRefundTrace(event)"
                          >
                            {{ isRefundTrace(event) ? `隱藏原交易：${sourceNames[event.source]} ${event.original_event_id}` : `查看原交易：${sourceNames[event.source]} ${event.original_event_id}` }}
                          </button>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </template>
            </section>
          </template>
          <p
            v-else
            class="empty-state"
          >
            請匯入兩份 CSV 或開啟既有批次。
          </p>
        </section>
        <InvestigationInspector
          ref="investigationInspector"
          :entry="activeInvestigation"
          :group="inspectedGroup"
          :events="inspectedEvents"
          :filenames="selectedBatch"
          :status="inspectedGroup ? investigationStatus(inspectedGroup) : ''"
          :note-label="noteLabel"
          :is-reopening="isReopening"
          @close="closeInvestigation"
          @read="readInvestigation(activeInvestigation)"
          @submit="submitInvestigation"
          @update:draft="activeInvestigation.draft = $event"
        />
      </div>
    </div>
  </main>
</template>
