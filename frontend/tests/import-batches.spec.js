import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const batchesPath = '/api/import_batches'
const samples = new URL('../../samples/', import.meta.url)
const sales = await readFile(new URL('sales.csv', samples))
const payments = await readFile(new URL('payments.csv', samples))
const header = Buffer.from(`${sales.toString().split('\n')[0]}\n`)
// 異常優先，各類維持 API 原順序；查核狀態變更不應重新排列。
const expectedSampleRows = [
  ['A', '2026-11-01', '信用卡', '800', '750', '+50', '金額不符', '待處理'],
  ['A', '2026-11-04', '信用卡', '-800', '-750', '-50', '金額不符', '待處理'],
  ['B', '2026-11-01', '現金', '400', '—', '—', '缺收款資料', '待處理'],
  ['B', '2026-11-01', '信用卡', '—', '300', '—', '缺營業資料', '待處理'],
  ['A', '2026-11-01', '現金', '1,000', '1,000', '0', '一致', '—'],
  ['A', '2026-11-03', '現金', '-500', '-500', '0', '一致', '—'],
  ['C', '2026-11-01', '現金', '0', '0', '0', '一致', '—'],
]

const oldBatchId = process.env.BROWSER_TEST_T04_OLD_BATCH_ID
const oldResultId = process.env.BROWSER_TEST_T04_OLD_RESULT_ID
const validBatchId = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i

if ((oldBatchId === undefined) !== (oldResultId === undefined)
  || (oldBatchId !== undefined && (!validBatchId.test(oldBatchId)
    || !/^[1-9]\d{0,18}$/.test(oldResultId)
    || BigInt(oldResultId) > 9_223_372_036_854_775_807n))) {
  throw new Error('T04 舊批次與結果 ID 必須成對提供，且符合 API 識別碼格式。')
}

function file(name, buffer) {
  return { name, mimeType: 'text/csv', buffer }
}

async function selectFiles(page, salesFile = file('sales.csv', sales), paymentsFile = file('payments.csv', payments)) {
  await page.getByLabel('營業 CSV').setInputFiles(salesFile)
  await page.getByLabel('收款 CSV').setInputFiles(paymentsFile)
}

async function submit(page, status = [200, 201]) {
  const response = page.waitForResponse((response) =>
    new URL(response.url()).pathname === batchesPath && response.request().method() === 'POST',
  )
  await page.getByRole('button', { name: '匯入並對帳' }).click()
  const result = await response
  expect([status].flat()).toContain(result.status())
  return result.json()
}

test.beforeAll(async ({ request }) => {
  const marker = await request.get('/__ticket01_browser_target.txt', { maxRedirects: 0 })
  expect(marker.status()).toBe(200)
  expect((await marker.text()).trim()).toBe(process.env.BROWSER_TEST_PROJECT)
})

test('F01–F08 成對匯入、讀回七組結果並保留零元與有號差額', async ({ page, request, browser }, testInfo) => {
  const batches = await getBatches(request)
  const existing = batches.find((batch) => batch.sales_filename === 'sales.csv' && batch.payments_filename === 'payments.csv')
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))

  await page.goto('/')
  await expect(page.getByRole('heading', { name: '門市營業對帳' })).toBeVisible()
  await expect(page.getByText('請匯入兩份 CSV 或開啟既有批次。')).toBeVisible()
  if (batches.length === 0) {
    await openBatchMenu(page)
    await expect(page.getByText('尚無對帳批次。')).toBeVisible()
    expect(await getBatches(request)).toEqual([])
    await page.screenshot({ path: testInfo.outputPath('空資料.png'), fullPage: true })
    console.log('空資料啟動：批次清單為空，畫面未自動匯入。')
  }
  await selectFiles(page)
  await page.getByLabel('收款 CSV').focus()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: '匯入並對帳' })).toBeFocused()
  const { batch } = await submit(page, existing ? 200 : 201)
  await expect(page).toHaveURL(`/?batch=${batch.id}`)
  await expect(page.getByRole('status').filter({ hasText: existing ? '已開啟既有批次。' : '已建立新批次。' })).toBeVisible()

  const table = page.getByRole('table', { name: '對帳分組' })
  await expectTableRows(table, expectedSampleRows)
  expect(await getBatch(request, batch.id)).toEqual(batch)
  await page.reload()
  await expect(page).toHaveURL(`/?batch=${batch.id}`)
  await expectTableRows(table, expectedSampleRows)
  expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280)
  await page.screenshot({ path: testInfo.outputPath('對帳結果.png'), fullPage: true })
  expect(errors).toEqual([])
  console.log(`Chromium ${browser.version()}；標準案例 HTTP ${existing ? 200 : 201}，批次 ${batch.id}。`)
})

test('B 版批次選單、查核摘要與獨立來源證據在桌面及手機可操作', async ({ page }, testInfo) => {
  await page.goto('/')
  const menu = page.locator('.batch-menu')
  await expect(menu).not.toHaveAttribute('open', '')
  await menu.locator('summary').focus()
  await page.keyboard.press('Enter')
  await expect(menu).toHaveAttribute('open', '')
  await page.keyboard.press('Escape')
  await expect(menu).not.toHaveAttribute('open', '')
  await expect(menu.locator('summary')).toBeFocused()

  const batch = await importInvestigationFixture(page)
  const summary = page.getByRole('region', { name: '本批次', exact: true })
  const metric = (label) => summary.getByText(label, { exact: true }).locator('..').locator('dd')
  await expect(metric('待處理')).toHaveText('4')
  await expect(metric('一致')).toHaveText('3')
  const table = page.getByRole('table', { name: '對帳分組' })
  await expectTableRows(table, expectedSampleRows)
  // 完整來源刻意選 B 分組，右側查核仍須只呈現 A 分組的證據。
  await table.getByRole('button', { name: '查看 B 2026-11-01 現金來源' }).click()
  const trace = page.getByRole('region', { name: '來源追查結果' })
  const opener = investigationButton(page, 'A 2026-11-01 信用卡')
  await opener.click()
  const panel = investigationPanel(page)
  await expect(panel.getByRole('heading', { level: 3 })).toBeFocused()
  const evidence = panel.getByRole('region', { name: '查核分組來源摘要' })
  await expect(evidence).toContainText('investigation-sales.csv')
  await expect(evidence).toContainText('payments.csv')
  await expect(evidence).toContainText('第 3 筆 · card-1')
  await expect(evidence).toContainText('800')
  await expect(evidence).toContainText('750')
  await expect(evidence).not.toContainText('cash-2')
  await expect(trace.getByRole('heading', { level: 3 })).toHaveText('來源紀錄：B · 2026-11-01 · 現金')
  await panel.getByRole('textbox', { name: '處理說明' }).fill('B 版確認所選分組的來源證據')
  await panel.getByRole('button', { name: '標記已處理' }).click()
  await expect(panel.getByText('已標記已處理。')).toBeVisible()
  await expect(metric('待處理')).toHaveText('3')
  await expect(metric('已處理')).toHaveText('1')
  await expect(metric('一致')).toHaveText('3')
  const expected = expectedSampleRows.map((row, index) => index === 0 ? [...row.slice(0, 7), '已處理'] : row)
  await expectTableRows(table, expected)
  await expect(panel.getByRole('textbox', { name: '恢復原因' })).toBeVisible()
  await expect(page.getByRole('button', { name: '標記已處理' })).toHaveCount(0)
  expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280)
  await page.screenshot({ path: testInfo.outputPath('B-查核面板-1280px.png'), fullPage: true })

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(panel.getByRole('textbox', { name: '恢復原因' })).toBeVisible()
  expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await panel.getByRole('button', { name: '關閉查核' }).click()
  await expect(opener).toBeFocused()
  await (await batchLink(page, batch.id)).click()
  await expect(menu).not.toHaveAttribute('open', '')
  await expect(menu.locator('summary')).toBeFocused()
  await expect(trace).not.toBeVisible()
  await expectTableRows(table, expected)
})

test('T04 固定樣本重跑：空資料、舊連結隔離及查核歷史', async ({ page, request }) => {
  test.skip(
    process.env.BROWSER_TEST_PROJECT !== 'restaurant-reconciliation-t04-browser'
      || process.env.BROWSER_TEST_T04_FIXED_SAMPLE !== 'yes',
    '固定樣本重跑須在第 04 票隔離環境明確啟用',
  )

  expect(await getBatches(request)).toEqual([])
  await page.goto('/')
  await openBatchMenu(page)
  await expect(page.getByText('尚無對帳批次。')).toBeVisible()
  await expect(page.getByRole('table')).toHaveCount(0)

  let oldHistoryPath
  if (oldBatchId !== undefined) {
    const oldBatchPath = `${batchesPath}/${oldBatchId}`
    oldHistoryPath = `${oldBatchPath}/results/${oldResultId}/investigation`
    const oldDetail = page.waitForResponse((response) =>
      new URL(response.url()).pathname === oldBatchPath && response.request().method() === 'GET',
    )
    await page.goto(`/?batch=${oldBatchId}`)
    expect((await oldDetail).status()).toBe(404)
    await expect(page.getByText('找不到指定的對帳批次。')).toBeVisible()
    await expect(page.getByRole('table')).toHaveCount(0)

    const [oldBatchResponse, oldHistoryResponse] = await Promise.all([
      request.get(oldBatchPath),
      request.get(oldHistoryPath),
    ])
    expect(oldBatchResponse.status()).toBe(404)
    expect((await oldBatchResponse.json()).error.code).toBe('batch_not_found')
    expect(oldHistoryResponse.status()).toBe(404)
    expect((await oldHistoryResponse.json()).error.code).toBe('investigation_not_found')
  }

  await selectFiles(page)
  const { batch } = await submit(page, 201)
  expect(batch.id).toMatch(validBatchId)
  if (oldBatchId !== undefined) expect(batch.id).not.toBe(oldBatchId)
  expect(batch.results).toHaveLength(7)
  expect(batch.source_events).toHaveLength(16)
  await expect(page).toHaveURL(`/?batch=${batch.id}`)
  await expect(page.getByRole('status').filter({ hasText: '已建立新批次。' })).toBeVisible()
  await expectTableRows(page.getByRole('table', { name: '對帳分組' }), expectedSampleRows)
  expect(await getBatch(request, batch.id)).toEqual(batch)

  const f02 = batch.results.find((row) => row.store_id === 'A'
    && row.business_date === '2026-11-01' && row.payment_method === 'credit_card')
  expect(f02).toMatchObject({ classification: 'amount_mismatch', investigation_status: 'pending' })
  const f02Path = investigationPath(batch, f02)
  const emptyHistory = { investigation_status: 'pending', records: [] }
  expect(await getInvestigation(request, f02Path)).toEqual(emptyHistory)

  if (oldHistoryPath) {
    const tokenResponse = await request.get('/api/csrf_token')
    expect(tokenResponse.status()).toBe(200)
    const { csrf_token: csrfToken } = await tokenResponse.json()
    expect(csrfToken).toEqual(expect.any(String))
    expect(csrfToken).not.toBe('')
    const stalePatch = await request.patch(oldHistoryPath, {
      headers: { 'X-CSRF-Token': csrfToken },
      data: { status: 'processed', note: '不得套用至新批次' },
    })
    const status = stalePatch.status()
    expect(status).toBe(404)
    const { error: { code } } = await stalePatch.json()
    expect(code).toBe('investigation_not_found')
    expect(await getInvestigation(request, f02Path)).toEqual(emptyHistory)
    expect(await getBatch(request, batch.id)).toEqual(batch)
    console.log(`T04_STALE_OPERATION_REJECTED old_batch_id=${oldBatchId} old_result_id=${oldResultId} status=${status} error_code=${code}`)
  }

  await investigationButton(page, 'A 2026-11-01 信用卡').click()
  const panel = investigationPanel(page)
  await expect(panel.getByText('目前狀態：待處理')).toBeVisible()
  await expect(panel.getByText('尚無處理紀錄。')).toBeVisible()
  const note = '已核對信用卡收款'
  await panel.getByRole('textbox', { name: '處理說明' }).fill(note)
  const patch = waitForPatch(page, f02Path)
  await panel.getByRole('button', { name: '標記已處理' }).click()
  expect((await patch).status()).toBe(200)
  await expect(panel.getByText('目前狀態：已處理')).toBeVisible()
  await expect(panel.getByText(note)).toBeVisible()
  const saved = await getInvestigation(request, f02Path)
  expect(saved).toEqual({ investigation_status: 'processed', records: [
    { status: 'processed', note, created_at: expect.any(String) },
  ] })
  expect(Date.parse(saved.records[0].created_at)).not.toBeNaN()
  await expect(panel.locator('time')).toHaveAttribute('datetime', saved.records[0].created_at)

  // 留下處理與恢復歷史，同時讓固定樣本回到既有回歸預期的待處理狀態。
  const reopenNote = '已再次確認信用卡差額，恢復待處理'
  await panel.getByRole('textbox', { name: '恢復原因' }).fill(reopenNote)
  const reopen = waitForPatch(page, f02Path)
  await panel.getByRole('button', { name: '恢復待處理' }).click()
  expect((await reopen).status()).toBe(200)
  await expect(panel.getByText('已恢復待處理。')).toBeVisible()
  await expect(panel.getByText('目前狀態：待處理')).toBeVisible()
  const history = await getInvestigation(request, f02Path)
  expect(history).toEqual({ investigation_status: 'pending', records: [
    { status: 'processed', note, created_at: saved.records[0].created_at },
    { status: 'pending', note: reopenNote, created_at: expect.any(String) },
  ] })
  expect(Date.parse(history.records[0].created_at)).toBeLessThanOrEqual(Date.parse(history.records[1].created_at))
  await expect(panel.getByRole('listitem')).toHaveCount(2)
  await expect(panel.getByRole('listitem').nth(0)).toContainText(note)
  await expect(panel.getByRole('listitem').nth(1)).toContainText(reopenNote)
  await expect(groupRow(page, 'A 2026-11-01 信用卡').getByRole('cell', { name: '待處理' })).toBeVisible()
  expect(await getBatch(request, batch.id)).toEqual(batch)
  expect(await panel.locator('time').evaluateAll((nodes) => nodes.map((node) => node.dateTime)))
    .toEqual(history.records.map((record) => record.created_at))
  console.log(`T04_FIXED_SAMPLE_REIMPORT batch_id=${batch.id} f02_result_id=${f02.id}`)
})

async function expectTableRows(table, expectedRows) {
  await expect(table.getByRole('row')).toHaveCount(expectedRows.length + 1)
  const actualRows = await table.locator('tbody tr').evaluateAll((rows) =>
    rows.map((row) => Array.from(row.cells, (cell) => cell.textContent.trim())),
  )
  expect(actualRows.map((row) => row.slice(0, expectedRows[0].length))).toEqual(expectedRows)
  expect(actualRows.map((row) => row.length)).toEqual(expectedRows.map((row) => row.length + 2))
}

async function expectTraceMetric(trace, label, value) {
  const metric = trace.getByText(label, { exact: true }).locator('..').locator('dd')
  await expect(metric).toHaveText(value)
}

async function sourceCellRows(table) {
  return table.locator('tbody tr').evaluateAll((rows) => rows.map((row) =>
    Array.from(row.cells, (cell) => cell.textContent.trim()).slice(0, 10),
  ))
}

async function expectSourceRows(table, expectedRows, { contains = false } = {}) {
  const rows = await sourceCellRows(table)
  if (contains) {
    for (const expected of expectedRows) expect(rows).toContainEqual(expected)
  } else {
    expect(rows).toEqual(expectedRows)
  }
}

async function expectOriginRows(table, source, filename, eventId, amount, refundAmount) {
  const rows = await sourceCellRows(table)
  const originalRows = rows.filter((row) => row[3] === eventId && row[4] === 'A' && row[5] === '2026-11-01' && row[7] === '正常')
  expect(originalRows).toHaveLength(1)
  expect(originalRows[0]).toEqual([source, filename, eventId === 'card-1' ? '3' : '2', eventId, 'A', '2026-11-01', eventId === 'card-1' ? '信用卡' : '現金', '正常', amount, '—'])
  expect(rows.every((row) => row[0] === source && row[1] === filename && row[4] === 'A')).toBe(true)
  expect(rows).toHaveLength(2)
  const refund = rows.find((row) => row[7] === '退款')
  expect(refund).toEqual([source, filename, eventId === 'card-1' ? '8' : '6', eventId === 'card-1' ? 'refund-card-1' : 'refund-cash-1', 'A', eventId === 'card-1' ? '2026-11-04' : '2026-11-03', eventId === 'card-1' ? '信用卡' : '現金', '退款', refundAmount, eventId])
}

function batchList(page) {
  return page.getByRole('region', { name: '對帳批次' })
}

async function openBatchMenu(page) {
  const menu = page.locator('.batch-menu')
  if (await menu.getAttribute('open') === null) {
    await menu.locator('summary').click()
  }
}

async function batchLink(page, id) {
  await openBatchMenu(page)
  return batchList(page).locator(`a[href="/?batch=${id}"]`)
}

async function openExample(page) {
  await page.goto('/')
  await selectFiles(page)
  const { batch } = await submit(page)
  await expect(page).toHaveURL(`/?batch=${batch.id}`)
  await expect((await batchLink(page, batch.id))).toBeVisible()
  await page.locator('.batch-menu summary').click()
  return batch
}

async function openEmptyBatch(page) {
  await selectFiles(page, file('sales-header.csv', header), file('payments-header.csv', header))
  const { batch } = await submit(page)
  await expect(page.getByText('沒有可比較資料。')).toBeVisible()
  await expect((await batchLink(page, batch.id))).toBeVisible()
  await page.locator('.batch-menu summary').click()
  return batch
}

function uniqueSales(name) {
  return file(name, Buffer.from(sales.toString().replace('cash-0,C,', `cash-${randomUUID()},C,`)))
}

function onlyEventType(buffer, eventType) {
  const [headerLine, ...rows] = buffer.toString().trimEnd().split('\n')
  return Buffer.from(`${[headerLine, ...rows.filter((row) => row.split(',')[4] === eventType)].join('\n')}\n`)
}

async function getBatches(request) {
  const response = await request.get(batchesPath)
  expect(response.status()).toBe(200)
  return (await response.json()).batches
}

async function getBatch(request, id) {
  const response = await request.get(`${batchesPath}/${id}`)
  expect(response.status()).toBe(200)
  return (await response.json()).batch
}

test('兩側只有表頭時開啟零結果批次，單側只有表頭時顯示缺資料及有值側', async ({ page }) => {
  await page.goto('/')
  const empty = await openEmptyBatch(page)
  expect(empty.results).toEqual([])
  await expect(page.getByRole('table')).toHaveCount(0)

  await selectFiles(page, file('sales-header.csv', header))
  const { batch } = await submit(page)
  expect(batch.id).not.toBe(empty.id)
  await expect(page.getByRole('row', { name: 'A 2026-11-01 現金 — 1,000 — 缺營業資料 待處理' })).toBeVisible()
  await page.goBack()
  await expect(page).toHaveURL(`/?batch=${empty.id}`)
  await expect(page.getByText('沒有可比較資料。')).toBeVisible()
})

test('5,000 筆最大單筆金額匯入後，表格及重開顯示完整淨額、正負差額、零與缺側', async ({ page, request }) => {
  const maxRows = Array.from({ length: 5000 }, (_, index) =>
    `limit-${index},A,2026-11-01,cash,normal,999999999,\n`,
  ).join('')
  const limit = file('limit.csv', Buffer.concat([header, Buffer.from(maxRows)]))
  const zeroRows = 'zero-a,A,2026-11-01,cash,normal,0,\nzero-b,B,2026-11-01,cash,normal,0,\n'
  const zero = file('zero.csv', Buffer.concat([header, Buffer.from(zeroRows)]))
  expect(limit.buffer.length).toBeLessThanOrEqual(1_048_576)

  const table = page.getByRole('table', { name: '對帳分組' })
  const cases = [
    {
      name: '營業側達上限，差額為正',
      files: [limit, zero],
      rows: [
        ['A', '2026-11-01', '現金', '4,999,999,995,000', '0', '+4,999,999,995,000', '金額不符', '待處理'],
        ['B', '2026-11-01', '現金', '—', '0', '—', '缺營業資料', '待處理'],
      ],
    },
    {
      name: '收款側達上限，差額為負',
      files: [zero, limit],
      rows: [
        ['A', '2026-11-01', '現金', '0', '4,999,999,995,000', '-4,999,999,995,000', '金額不符', '待處理'],
        ['B', '2026-11-01', '現金', '0', '—', '—', '缺收款資料', '待處理'],
      ],
    },
  ]
  const batchIds = []
  await page.goto('/')
  for (const scenario of cases) {
    await test.step(scenario.name, async () => {
      await selectFiles(page, ...scenario.files)
      const { batch } = await submit(page)
      batchIds.push(batch.id)
      await expect(page).toHaveURL(`/?batch=${batch.id}`)
      await expectTableRows(table, scenario.rows)
      await investigationButton(page, 'A 2026-11-01 現金').click()
      const evidence = investigationPanel(page).getByRole('region', { name: '查核分組來源摘要' })
      await expect(evidence).toContainText('共 5001 筆，預覽 4 筆')
      await expect(evidence.locator('.evidence-row')).toHaveCount(4)
      await expect(evidence).toContainText('營業 CSV')
      await expect(evidence).toContainText('收款 CSV')
      await expect(investigationPanel(page).getByRole('textbox', { name: '處理說明' })).toBeVisible()
      await investigationPanel(page).getByRole('button', { name: '關閉查核' }).click()
      await expect(page.getByRole('table', { name: /來源紀錄/ })).toHaveCount(0)
      expect(await getBatch(request, batch.id)).toEqual(batch)
      await page.reload()
      await expect(page).toHaveURL(`/?batch=${batch.id}`)
      await expectTableRows(table, scenario.rows)
    })
  }
  expect(batchIds[0]).not.toBe(batchIds[1])
})

test('真實 422 定位收款紀錄，保留原檔及舊結果，更正建立新批次，改名重用', async ({ page, request }) => {
  const original = await openExample(page)
  const previous = await getBatches(request)
  const invalidPayments = Buffer.from(payments.toString().replace(',normal,750,', ',normal,750.5,'))
  await selectFiles(page, file('sales.csv', sales), file('invalid-payments.csv', invalidPayments))
  await submit(page, 422)
  await expect(page.getByRole('alert')).toHaveText('收款 CSV，第 3 筆紀錄，金額必須是不含符號的十進位整數。')
  await expect(page.getByLabel('收款 CSV')).toHaveValue(/invalid-payments\.csv$/)
  await expect(page.getByLabel('營業 CSV')).toHaveValue(/sales\.csv$/)
  await expect(page).toHaveURL(`/?batch=${original.id}`)
  await expect(page.getByRole('row', { name: 'B 2026-11-01 信用卡 — 300 — 缺營業資料 待處理' })).toBeVisible()
  expect(await getBatches(request)).toEqual(previous)
  expect(await getBatch(request, original.id)).toEqual(original)

  const corrected = Buffer.from(payments.toString().replace('card-1,B,2026-11-01,credit_card,normal,300,', `card-${randomUUID()},B,2026-11-01,credit_card,normal,301,`))
  await page.getByLabel('收款 CSV').setInputFiles(file('corrected-payments.csv', corrected))
  const { batch } = await submit(page, 201)
  expect(batch.id).not.toBe(original.id)
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByLabel('收款 CSV')).toHaveValue('')
  await expect(page.getByRole('row', { name: 'B 2026-11-01 信用卡 — 301 — 缺營業資料 待處理' })).toBeVisible()
  await (await batchLink(page, original.id)).click()
  await expect((await batchLink(page, original.id))).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('row', { name: 'B 2026-11-01 信用卡 — 300 — 缺營業資料 待處理' })).toBeVisible()
  await page.goBack()
  await expect(page).toHaveURL(`/?batch=${batch.id}`)
  await expect(page.getByRole('row', { name: 'B 2026-11-01 信用卡 — 301 — 缺營業資料 待處理' })).toBeVisible()

  await selectFiles(page, file('renamed-sales.csv', sales), file('renamed-payments.csv', corrected))
  const { batch: reused } = await submit(page, 200)
  expect(reused).toEqual(batch)
  await expect(page.getByRole('status').filter({ hasText: '已開啟既有批次。' })).toBeVisible()
  expect(await getBatches(request)).toHaveLength(previous.length + 1)
})

test('Rails 保存的上傳檔名及受控錯誤文字均以純文字顯示', async ({ page }) => {
  const filename = `<img src=x onerror=window.ticket01Executed=1>${'a'.repeat(110)}.csv`
  const message = '<img src=x onerror=window.ticket01Executed=2>'
  await page.goto('/')
  await selectFiles(page, uniqueSales(filename))
  const { batch } = await submit(page, 201)
  expect(batch.sales_filename).toBe(filename)
  await expect(page.getByRole('region', { name: '對帳結果' }).getByText(filename, { exact: true })).toBeVisible()
  await expect((await batchLink(page, batch.id))).toContainText(filename)
  await page.keyboard.press('Escape')
  await expect(page.locator('.batch-menu')).not.toHaveAttribute('open', '')
  await page.getByRole('button', { name: '查看批次來源紀錄' }).click()
  await expect(page.getByRole('table', { name: /來源紀錄/ }).getByRole('cell', { name: filename, exact: true }).first())
    .toHaveText(filename)
  await expect(page.locator('img')).toHaveCount(0)
  expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280)

  await page.route(batchesPath, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    await route.fulfill({ status: 422, json: { error: { source: 'sales', code: 'invalid_csv', message } } })
  })
  await selectFiles(page)
  await submit(page, 422)
  await expect(page.getByRole('alert')).toHaveText(`營業 CSV，${message}`)
  await expect(page.locator('img')).toHaveCount(0)
  expect(await page.evaluate(() => globalThis.window.ticket01Executed)).toBeUndefined()
})

test('F01–F08 可追查分組來源、同源原交易與取消列位置', async ({ page }, testInfo) => {
  const batch = await openExample(page)
  const results = page.getByRole('table', { name: '對帳分組' })
  const openGroup = (store, date, method) => results.getByRole('button', {
    name: new RegExp(`^(?:查看|隱藏) ${store} ${date} ${method}來源$`),
  })
  const trace = page.getByRole('region', { name: '來源追查結果' })
  const closeTrace = trace.getByRole('button', { name: '關閉來源追查' })
  const openOrigin = (source, eventId = 'cash-1') => trace.getByRole('table')
    .getByRole('button', { name: new RegExp(`^(?:查看|隱藏)原交易：${source} ${eventId}$`) })

  const f01 = openGroup('A', '2026-11-01', '現金')
  await f01.focus()
  await page.keyboard.press('Enter')
  await expect(trace.getByRole('heading', { name: '來源紀錄：A · 2026-11-01 · 現金' })).toBeFocused()
  await expect(f01).toHaveAttribute('aria-expanded', 'true')
  await page.keyboard.press('Tab')
  await expect(closeTrace).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(trace.getByRole('region', { name: '來源紀錄表格' })).toBeFocused()
  await expectTraceMetric(trace, '營業淨額', '1,000')
  await expectTraceMetric(trace, '收款淨額', '1,000')
  await expectTraceMetric(trace, '差額', '0')
  await expectSourceRows(trace.getByRole('table', { name: /來源紀錄/ }), [
    ['收款 CSV', 'payments.csv', '2', 'cash-1', 'A', '2026-11-01', '現金', '正常', '1,000', '—'],
    ['營業 CSV', 'sales.csv', '2', 'cash-1', 'A', '2026-11-01', '現金', '正常', '1,000', '—'],
  ])
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Enter')
  await expect(trace).toBeHidden()
  await expect(f01).toBeFocused()
  await expect(f01).toHaveAttribute('aria-expanded', 'false')

  await openGroup('A', '2026-11-01', '信用卡').click()
  await expect(trace.getByRole('heading', { name: '來源紀錄：A · 2026-11-01 · 信用卡' })).toBeFocused()
  await expectTraceMetric(trace, '營業淨額', '800')
  await expectTraceMetric(trace, '收款淨額', '750')
  await expectTraceMetric(trace, '差額', '+50')
  await expectSourceRows(trace.getByRole('table', { name: /來源紀錄/ }), [
    ['收款 CSV', 'payments.csv', '3', 'card-1', 'A', '2026-11-01', '信用卡', '正常', '750', '—'],
    ['營業 CSV', 'sales.csv', '3', 'card-1', 'A', '2026-11-01', '信用卡', '正常', '800', '—'],
  ])

  await openGroup('B', '2026-11-01', '現金').click()
  await expectTraceMetric(trace, '營業淨額', '400')
  await expectTraceMetric(trace, '收款淨額', '—')
  await expectTraceMetric(trace, '差額', '—')
  await expectSourceRows(trace.getByRole('table', { name: /來源紀錄/ }), [
    ['營業 CSV', 'sales.csv', '4', 'cash-1', 'B', '2026-11-01', '現金', '正常', '400', '—'],
  ])

  await openGroup('B', '2026-11-01', '信用卡').click()
  await expectTraceMetric(trace, '營業淨額', '—')
  await expectTraceMetric(trace, '收款淨額', '300')
  await expectTraceMetric(trace, '差額', '—')
  await expectSourceRows(trace.getByRole('table', { name: /來源紀錄/ }), [
    ['收款 CSV', 'payments.csv', '4', 'card-1', 'B', '2026-11-01', '信用卡', '正常', '300', '—'],
  ])

  await openGroup('C', '2026-11-01', '現金').click()
  await expectTraceMetric(trace, '營業淨額', '0')
  await expectTraceMetric(trace, '收款淨額', '0')
  await expectTraceMetric(trace, '差額', '0')
  await expectSourceRows(trace.getByRole('table', { name: /來源紀錄/ }), [
    ['收款 CSV', 'payments.csv', '5', 'cash-0', 'C', '2026-11-01', '現金', '正常', '0', '—'],
    ['營業 CSV', 'sales.csv', '5', 'cash-0', 'C', '2026-11-01', '現金', '正常', '0', '—'],
  ])

  await openGroup('A', '2026-11-03', '現金').click()
  await expectTraceMetric(trace, '營業淨額', '-500')
  await expectTraceMetric(trace, '收款淨額', '-500')
  await expectTraceMetric(trace, '差額', '0')
  await expectSourceRows(trace.getByRole('table', { name: /來源紀錄/ }), [
    ['收款 CSV', 'payments.csv', '6', 'refund-cash-1', 'A', '2026-11-03', '現金', '退款', '300', 'cash-1'],
    ['收款 CSV', 'payments.csv', '7', 'refund-cash-2', 'A', '2026-11-03', '現金', '退款', '200', 'cash-1'],
    ['營業 CSV', 'sales.csv', '6', 'refund-cash-1', 'A', '2026-11-03', '現金', '退款', '300', 'cash-1'],
    ['營業 CSV', 'sales.csv', '7', 'refund-cash-2', 'A', '2026-11-03', '現金', '退款', '200', 'cash-1'],
  ])
  const salesOriginAction = openOrigin('營業 CSV').first()
  await salesOriginAction.focus()
  await page.keyboard.press('Enter')
  await expect(salesOriginAction).toBeFocused()
  await expectOriginRows(trace.getByRole('table', { name: '原交易與退款紀錄' }), '營業 CSV', 'sales.csv', 'cash-1', '1,000', '300')
  await expectTraceMetric(trace, '差額', '0')
  await page.keyboard.press('Enter')
  await expect(salesOriginAction).toBeFocused()
  await expect(salesOriginAction).toHaveAttribute('aria-expanded', 'false')
  await expect(trace.getByRole('table', { name: /來源紀錄/ }).getByRole('row')).toHaveCount(5)
  await openGroup('A', '2026-11-03', '現金').click()
  await expect(trace).toBeHidden()
  await openGroup('A', '2026-11-03', '現金').click()
  await openOrigin('收款 CSV').first().click()
  await expectOriginRows(trace.getByRole('table', { name: '原交易與退款紀錄' }), '收款 CSV', 'payments.csv', 'cash-1', '1,000', '300')

  await openGroup('A', '2026-11-04', '信用卡').click()
  await expectTraceMetric(trace, '營業淨額', '-800')
  await expectTraceMetric(trace, '收款淨額', '-750')
  await expectTraceMetric(trace, '差額', '-50')
  await openOrigin('營業 CSV', 'card-1').click()
  await expectOriginRows(trace.getByRole('table', { name: '原交易與退款紀錄' }), '營業 CSV', 'sales.csv', 'card-1', '800', '800')
  await openGroup('A', '2026-11-04', '信用卡').click()
  await expect(trace).toBeHidden()
  await openGroup('A', '2026-11-04', '信用卡').click()
  await openOrigin('收款 CSV', 'card-1').click()
  await expectOriginRows(trace.getByRole('table', { name: '原交易與退款紀錄' }), '收款 CSV', 'payments.csv', 'card-1', '750', '750')

  await expect(results.getByRole('row', { name: /^C 2026-11-01 信用卡/ })).toHaveCount(0)
  const batchSourcesButton = page.getByRole('button', { name: /^(?:查看|隱藏)批次來源紀錄$/ })
  await batchSourcesButton.focus()
  await page.keyboard.press('Space')
  await expect(trace.getByRole('heading', { name: '批次來源紀錄' })).toBeFocused()
  await expect(batchSourcesButton).toHaveAttribute('aria-expanded', 'true')
  const batchSources = trace.getByRole('table', { name: /來源紀錄/ })
  await expect(batchSources.getByRole('row')).toHaveCount(17)
  await expectSourceRows(batchSources, [
    ['收款 CSV', 'payments.csv', '9', 'cancel-card-1', 'C', '2026-11-01', '信用卡', '取消', '150', '—'],
    ['營業 CSV', 'sales.csv', '9', 'cancel-card-1', 'C', '2026-11-01', '信用卡', '取消', '600', '—'],
  ], { contains: true })
  await page.keyboard.press('Tab')
  await expect(closeTrace).toBeFocused()
  await page.keyboard.press('Space')
  await expect(trace).toBeHidden()
  await expect(batchSourcesButton).toBeFocused()
  await expect(batchSourcesButton).toHaveAttribute('aria-expanded', 'false')
  await page.reload()
  await expect(page).toHaveURL(`/?batch=${batch.id}`)
  await page.getByRole('button', { name: '查看批次來源紀錄' }).click()
  await expect(trace.getByRole('heading', { name: '批次來源紀錄' })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('來源追查.png'), fullPage: true })
})

test('空結果批次可開啟來源；表頭空批次與取消資料仍不產生分組', async ({ page }) => {
  await page.goto('/')
  const empty = await openEmptyBatch(page)
  const trace = page.getByRole('region', { name: '來源追查結果' })
  await expect(page.getByRole('button', { name: '查看批次來源紀錄' })).toBeVisible()
  await expect(trace.getByRole('table')).toHaveCount(0)
  await page.getByRole('button', { name: '查看批次來源紀錄' }).click()
  await expect(trace.getByRole('table', { name: /來源紀錄/ })).toHaveCount(1)
  await expect(trace.getByRole('table', { name: /來源紀錄/ }).getByRole('row')).toHaveCount(1)
  expect(empty.results).toEqual([])

  const salesCancels = onlyEventType(sales, 'cancel')
  const paymentsCancels = onlyEventType(payments, 'cancel')
  expect(salesCancels.toString()).toContain('cancel-card-1')
  expect(paymentsCancels.toString()).toContain('cancel-card-1')
  await selectFiles(page, file('sales-cancel-only.csv', salesCancels), file('payments-cancel-only.csv', paymentsCancels))
  const { batch } = await submit(page)
  expect(batch.results).toEqual([])
  await expect(page.getByText('沒有可比較資料。')).toBeVisible()
  await expect(trace.getByRole('table')).toHaveCount(0)
  await page.getByRole('button', { name: '查看批次來源紀錄' }).click()
  await expectSourceRows(trace.getByRole('table', { name: /來源紀錄/ }), [
    ['收款 CSV', 'payments-cancel-only.csv', '2', 'cancel-card-1', 'C', '2026-11-01', '信用卡', '取消', '150', '—'],
    ['營業 CSV', 'sales-cancel-only.csv', '2', 'cancel-card-1', 'C', '2026-11-01', '信用卡', '取消', '600', '—'],
  ])
  await expect(page.getByRole('table', { name: '對帳分組' })).toHaveCount(0)
})

test('更正批次各自保留來源值，切換批次會關閉舊追查', async ({ page }) => {
  const original = await openExample(page)
  const results = page.getByRole('table', { name: '對帳分組' })
  const trace = page.getByRole('region', { name: '來源追查結果' })
  const openF01 = () => results.getByRole('button', { name: '查看 A 2026-11-01 現金來源' })
  await openF01().click()
  await expectTraceMetric(trace, '營業淨額', '1,000')
  await expect(trace.getByRole('heading', { name: '來源紀錄：A · 2026-11-01 · 現金' })).toBeVisible()
  await page.reload()
  await expect(page).toHaveURL(`/?batch=${original.id}`)
  await expect(trace).toBeHidden()
  await expect(openF01()).toHaveAttribute('aria-expanded', 'false')
  await openF01().click()

  const correctedSales = Buffer.from(sales.toString()
    .replace('cash-1,A,2026-11-01,cash,normal,1000,', 'cash-1,A,2026-11-01,cash,normal,1100,')
    .replace('refund-cash-1,A,2026-11-03,cash,refund,300,cash-1', 'refund-cash-1,A,2026-11-03,cash,refund,350,cash-1'))
  expect(correctedSales).not.toEqual(sales)
  await selectFiles(page, file('corrected-sales.csv', correctedSales), file('payments.csv', payments))
  const { batch: corrected } = await submit(page)
  expect(corrected.id).not.toBe(original.id)
  await expect(trace).toBeHidden()
  await expect(page.getByRole('button', { name: '查看 A 2026-11-01 現金來源' })).toHaveAttribute('aria-expanded', 'false')
  await openF01().click()
  await expectTraceMetric(trace, '營業淨額', '1,100')
  await expectTraceMetric(trace, '差額', '+100')

  const f06 = results.getByRole('button', { name: '查看 A 2026-11-03 現金來源' })
  await f06.click()
  await trace.getByRole('table', { name: /來源紀錄/ })
    .getByRole('button', { name: '查看原交易：營業 CSV cash-1' }).first().click()
  await expectOriginRows(trace.getByRole('table', { name: '原交易與退款紀錄' }), '營業 CSV', 'corrected-sales.csv', 'cash-1', '1,100', '350')

  await (await batchLink(page, original.id)).click()
  await expect(page.locator('.batch-menu summary')).toBeFocused()
  await expect(trace).toBeHidden()
  await expect(page.getByRole('button', { name: '查看 A 2026-11-01 現金來源' })).toHaveAttribute('aria-expanded', 'false')
  await openF01().click()
  await expectTraceMetric(trace, '營業淨額', '1,000')
  await expectTraceMetric(trace, '差額', '0')
  await results.getByRole('button', { name: '查看 A 2026-11-03 現金來源' }).click()
  await trace.getByRole('table')
    .getByRole('button', { name: '查看原交易：營業 CSV cash-1' }).first().click()
  const oldOrigin = trace.getByRole('table', { name: '原交易與退款紀錄' })
  await expectOriginRows(oldOrigin, '營業 CSV', 'sales.csv', 'cash-1', '1,000', '300')
  await expect(oldOrigin.getByText('1,100', { exact: true })).toHaveCount(0)
})

test('上游已建立批次後中斷回應，保留兩原檔，手動重送重開同一批次', async ({ page, request }) => {
  const previous = await openExample(page)
  const before = await getBatches(request)
  const selectedSales = uniqueSales('recover-sales.csv')
  let committed
  let posts = 0
  await page.route(batchesPath, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    posts += 1
    if (posts > 1) return route.fallback()
    // 先經真實 Rails API 寫入，再只對瀏覽器中斷第一個回應。
    const upstream = await route.fetch()
    expect(upstream.status()).toBe(201)
    committed = (await upstream.json()).batch
    await route.abort('connectionreset')
  })

  await selectFiles(page, selectedSales)
  await page.getByRole('button', { name: '匯入並對帳' }).click()
  await expect(page.getByRole('alert')).toHaveText('目前無法確認匯入結果，請使用原檔重試。')
  await expect(page).toHaveURL(`/?batch=${previous.id}`)
  await expect(page.getByLabel('營業 CSV')).toHaveValue(/recover-sales\.csv$/)
  await expect(page.getByLabel('收款 CSV')).toHaveValue(/payments\.csv$/)
  expect(await getBatch(request, committed.id)).toEqual(committed)
  expect(posts).toBe(1)
  const { batch } = await submit(page, 200)
  expect(batch).toEqual(committed)
  await expect(page).toHaveURL(`/?batch=${committed.id}`)
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '匯入並對帳' })).toBeEnabled()
  await expect(page.getByRole('table').getByRole('row')).toHaveCount(8)
  expect(posts).toBe(2)
  expect(await getBatches(request)).toHaveLength(before.length + 1)
})

test('503 忙碌及真實 CSRF 拒絕後，恢復控制項並由使用者原檔重試', async ({ page, request }) => {
  const before = await getBatches(request)
  const selectedSales = uniqueSales('retry-sales.csv')
  let posts = 0
  let tokenReads = 0
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/csrf_token') tokenReads += 1
  })
  await page.route(batchesPath, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    posts += 1
    if (posts === 1) {
      return route.fulfill({ status: 503, json: { error: { source: null, code: 'import_busy' } } })
    }
    if (posts === 2) {
      return route.continue({ headers: { ...route.request().headers(), 'x-csrf-token': 'expired-test-token' } })
    }
    return route.fallback()
  })

  await page.goto('/')
  await selectFiles(page, selectedSales)
  await submit(page, 503)
  await expect(page.getByRole('alert')).toHaveText('同一批資料正在匯入，請稍後使用原檔重試。')
  await expect(page.getByLabel('營業 CSV')).toBeEnabled()
  expect(posts).toBe(1)
  const rejection = await submit(page, 403)
  expect(rejection.error.code).toBe('invalid_csrf_token')
  await expect(page.getByRole('alert')).toHaveText('提交憑證已失效或請求遭拒，請使用原檔重新提交。')
  await expect(page.getByLabel('營業 CSV')).toHaveValue(/retry-sales\.csv$/)
  await expect(page.getByLabel('收款 CSV')).toHaveValue(/payments\.csv$/)
  expect(await getBatches(request)).toEqual(before)
  expect(posts).toBe(2)
  const { batch } = await submit(page, 201)
  await expect(page).toHaveURL(`/?batch=${batch.id}`)
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(tokenReads).toBe(3)
  expect(posts).toBe(3)
})

test('暫時讀取失敗可重試，真正不存在的批次仍可切換至正確批次', async ({ page }) => {
  const original = await openExample(page)
  const missing = randomUUID()
  await page.route(batchesPath, (route) => route.fulfill({ status: 503, json: {} }), { times: 1 })
  await page.route(`${batchesPath}/${original.id}`, (route) => route.abort('failed'), { times: 1 })
  const missingResponse = page.waitForResponse((response) => new URL(response.url()).pathname === `${batchesPath}/${missing}`)
  await page.goto(`/?batch=${missing}`)
  expect((await missingResponse).status()).toBe(404)
  await expect(page.getByText('找不到指定的對帳批次。')).toBeVisible()
  await openBatchMenu(page)
  await expect(page.getByText('無法讀取批次清單，請重試。')).toBeVisible()
  await expect(page.getByText('尚無對帳批次。')).toHaveCount(0)
  await page.getByRole('button', { name: '重試讀取清單' }).click()
  await (await batchLink(page, original.id)).click()
  await expect(page.getByText('無法讀取對帳批次，請重試。')).toBeVisible()
  await expect(page.getByRole('table')).toHaveCount(0)
  await page.getByRole('button', { name: '重試讀取批次' }).click()
  await expect(page.getByRole('table').getByRole('row')).toHaveCount(8)
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '匯入並對帳' })).toBeEnabled()
})

test('較早的明細讀取與遲到的已提交結果均不覆蓋最新批次選擇', async ({ page, request }) => {
  const original = await openExample(page)
  const empty = await openEmptyBatch(page)
  const oldResponseReady = Promise.withResolvers()
  const resumeOldResponse = Promise.withResolvers()
  const oldResponseReleased = Promise.withResolvers()

  await page.route(`${batchesPath}/${empty.id}`, async (route) => {
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    oldResponseReady.resolve()
    await resumeOldResponse.promise
    await route.fulfill({ response })
    oldResponseReleased.resolve()
  }, { times: 1 })

  await (await batchLink(page, original.id)).click()
  await expect(page.getByRole('table').getByRole('row')).toHaveCount(8)
  await (await batchLink(page, empty.id)).click()
  await expect(page.getByText('正在讀取對帳批次…')).toBeVisible()
  await oldResponseReady.promise
  const canceled = page.waitForEvent('requestfailed', (request) => new URL(request.url()).pathname === `${batchesPath}/${empty.id}`)
  await (await batchLink(page, original.id)).click()
  await canceled
  await expect(page.getByRole('table').getByRole('row')).toHaveCount(8)
  resumeOldResponse.resolve()
  await oldResponseReleased.promise
  await expect(page).toHaveURL(`/?batch=${original.id}`)
  await expect(page.getByText('沒有可比較資料。')).toHaveCount(0)

  const posted = Promise.withResolvers()
  const resumePostResponse = Promise.withResolvers()
  let posts = 0
  await page.route(batchesPath, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    posts += 1
    const response = await route.fetch()
    expect(response.status()).toBe(201)
    posted.resolve((await response.json()).batch)
    await resumePostResponse.promise
    await route.fulfill({ response })
  })

  await selectFiles(page, uniqueSales('delayed-sales.csv'))
  await page.getByRole('button', { name: '匯入並對帳' }).click()
  await expect(page.getByRole('button', { name: '匯入中…' })).toBeDisabled()
  await expect(page.getByLabel('營業 CSV')).toBeDisabled()
  await expect(page.getByLabel('收款 CSV')).toBeDisabled()
  const committed = await posted.promise
  expect(await getBatch(request, committed.id)).toEqual(committed)
  await (await batchLink(page, empty.id)).click()
  await expect(page.getByText('沒有可比較資料。')).toBeVisible()
  resumePostResponse.resolve()
  const openImportedBatch = page.getByRole('link', { name: '開啟新批次' })
  await expect(openImportedBatch).toHaveAttribute('href', `/?batch=${committed.id}`)
  await expect(page).toHaveURL(`/?batch=${empty.id}`)
  await expect(page.getByText('沒有可比較資料。')).toBeVisible()
  await expect((await batchLink(page, committed.id))).toBeVisible()
  await expect(page.getByRole('button', { name: '匯入並對帳' })).toBeEnabled()
  await expect(page.getByLabel('營業 CSV')).toHaveValue('')
  await openImportedBatch.click()
  await expect(page).toHaveURL(`/?batch=${committed.id}`)
  await expect(page.getByRole('table').getByRole('row')).toHaveCount(8)
  expect(posts).toBe(1)
})

function investigationPath(batch, result) {
  return `${batchesPath}/${batch.id}/results/${result.id}/investigation`
}

function investigationPanel(page) {
  return page.getByRole('region', { name: '異常查核' })
}

function investigationButton(page, group) {
  return page.getByRole('button', { name: `查核 ${group}`, exact: true })
}

function groupRow(page, result) {
  return page.getByRole('row').filter({
    has: investigationButton(page, result),
  })
}

async function importInvestigationFixture(page, salesFile = uniqueSales('investigation-sales.csv')) {
  await selectFiles(page, salesFile)
  const { batch } = await submit(page, 201)
  await expect((await batchLink(page, batch.id))).toBeVisible()
  await page.locator('.batch-menu summary').click()
  return batch
}

async function getInvestigation(request, path) {
  const response = await request.get(path)
  expect(response.status()).toBe(200)
  return response.json()
}

function waitForPatch(page, path) {
  return page.waitForResponse((response) =>
    new URL(response.url()).pathname === path && response.request().method() === 'PATCH',
  )
}

test.describe('T03 查核歷史', () => {
  test.skip(
    !['restaurant-reconciliation-t03-browser', 'restaurant-reconciliation-t04-browser'].includes(process.env.BROWSER_TEST_PROJECT),
    '使用第 03 或 04 票專屬資料卷',
  )

  const f02 = 'A 2026-11-01 信用卡'
  const f03 = 'B 2026-11-01 現金'
  const f04 = 'B 2026-11-01 信用卡'

  test('處理與恢復保留金額、完整歷史，並在原檔改名後讀回', async ({ page, request }, testInfo) => {
    const fixture = uniqueSales('history-sales.csv')
    await page.goto('/')
    const batch = await importInvestigationFixture(page, fixture)
    const result = batch.results.find((row) => row.store_id === 'A' && row.business_date === '2026-11-01' && row.payment_method === 'credit_card')
    const path = investigationPath(batch, result)
    await expect(groupRow(page, f02).getByRole('cell', { name: '待處理' })).toBeVisible()
    await expect(groupRow(page, f03).getByRole('cell', { name: '待處理' })).toBeVisible()
    await expect(groupRow(page, f04).getByRole('cell', { name: '待處理' })).toBeVisible()
    expect(await getInvestigation(request, path)).toEqual({ investigation_status: 'pending', records: [] })

    const opener = investigationButton(page, f02)
    await opener.focus()
    await page.keyboard.press('Enter')
    const panel = investigationPanel(page)
    await expect(panel.getByRole('heading', { level: 3 })).toBeFocused()
    const explanation = panel.getByRole('textbox', { name: '處理說明' })
    const process = panel.getByRole('button', { name: '標記已處理' })
    await explanation.fill('   ')
    await process.click()
    await expect(panel.getByRole('alert')).toHaveText('請輸入處理說明。')
    await expect(explanation).toBeFocused()
    expect(await getInvestigation(request, path)).toEqual({ investigation_status: 'pending', records: [] })

    // 改寫送出的說明，讓 Rails 實際拒絕；瀏覽器草稿保留原文。
    await page.route(path, (route) => route.continue({
      postData: { ...route.request().postDataJSON(), note: '' },
    }), { times: 1 })
    const note = `<em>已核對</em>\n${'長'.repeat(8)}${'A'.repeat(200)}`
    await explanation.fill(note)
    let response = waitForPatch(page, path)
    await process.click()
    expect((await response).status()).toBe(422)
    await expect(panel.getByRole('alert')).toHaveText('請輸入有效的處理說明。')
    await expect(explanation).toHaveValue(note)
    expect(await getInvestigation(request, path)).toEqual({ investigation_status: 'pending', records: [] })

    response = waitForPatch(page, path)
    await process.click()
    expect((await response).status()).toBe(200)
    await expect(panel.getByText('已標記已處理。')).toBeVisible()
    await expect(groupRow(page, f02).getByRole('cell', { name: '已處理' })).toBeVisible()
    await expect(panel.getByText(note)).toBeVisible()
    await expect(panel.locator('em')).toHaveCount(0)

    const reopenNote = '補查收款紀錄'
    const reason = panel.getByRole('textbox', { name: '恢復原因' })
    await expect(reason).toHaveValue('')
    await reason.fill(reopenNote)
    response = waitForPatch(page, path)
    await panel.getByRole('button', { name: '恢復待處理' }).click()
    expect((await response).status()).toBe(200)
    await expect(panel.getByText('已恢復待處理。')).toBeVisible()
    const saved = await getInvestigation(request, path)
    expect(saved).toEqual({ investigation_status: 'pending', records: [
      { status: 'processed', note, created_at: expect.any(String) },
      { status: 'pending', note: reopenNote, created_at: expect.any(String) },
    ] })
    expect(Date.parse(saved.records[0].created_at)).toBeLessThanOrEqual(Date.parse(saved.records[1].created_at))
    expect(await getBatch(request, batch.id)).toEqual(batch)
    await panel.getByRole('button', { name: '關閉查核' }).click()
    await expect(opener).toBeFocused()

    await selectFiles(page, { ...fixture, name: 'renamed-history-sales.csv' }, file('renamed-payments.csv', payments))
    expect((await submit(page, 200)).batch).toEqual(batch)
    await expect(page.getByText('已開啟既有批次。')).toBeVisible()
    const corrected = file('corrected-history-sales.csv', Buffer.from(fixture.buffer.toString().replace('cash-1,B,2026-11-01,cash,normal,400,', 'cash-1,B,2026-11-01,cash,normal,405,')))
    const newBatch = await importInvestigationFixture(page, corrected)
    expect(newBatch.id).not.toBe(batch.id)
    const newResult = newBatch.results.find((row) => row.store_id === 'A' && row.business_date === '2026-11-01' && row.payment_method === 'credit_card')
    expect(await getInvestigation(request, investigationPath(newBatch, newResult))).toEqual({ investigation_status: 'pending', records: [] })
    await (await batchLink(page, batch.id)).click()
    await page.reload()
    await page.setViewportSize({ width: 390, height: 844 })
    await investigationButton(page, f02).click()
    await expect(panel.getByRole('listitem')).toHaveCount(2)
    await expect(panel.getByRole('listitem').nth(0)).toContainText(note)
    await expect(panel.getByRole('listitem').nth(1)).toContainText(reopenNote)
    const times = await panel.locator('time').evaluateAll((nodes) => nodes.map((node) => node.dateTime))
    expect(times).toEqual(saved.records.map((record) => record.created_at))
    await expect(panel.locator('time').first()).not.toBeEmpty()
    await expect(opener).toHaveAttribute('aria-expanded', 'true')
    const sizes = await panel.getByText(note).evaluate((node) => ({
      viewport: globalThis.innerWidth,
      page: globalThis.document.documentElement.scrollWidth,
      note: node.clientWidth,
      noteContent: node.scrollWidth,
    }))
    expect(sizes.viewport).toBe(390)
    expect(sizes.page).toBeLessThanOrEqual(390)
    expect(sizes.note).toBeGreaterThan(0)
    expect(sizes.noteContent).toBeLessThanOrEqual(sizes.note)
    await page.screenshot({ path: testInfo.outputPath('查核歷史-390px.png'), fullPage: true })
    expect(await getInvestigation(request, path)).toEqual(saved)
    const processedResult = batch.results.find((row) => row.classification === 'missing_payments')
    const processedPath = investigationPath(batch, processedResult)
    await investigationButton(page, f03).click()
    await panel.getByRole('textbox', { name: '處理說明' }).fill('已確認缺收款資料')
    response = waitForPatch(page, processedPath)
    await panel.getByRole('button', { name: '標記已處理' }).click()
    expect((await response).status()).toBe(200)
    await expect(panel.getByText('已標記已處理。')).toBeVisible()
    console.log(`查核歷史重啟讀回：batch_id=${batch.id} result_id=${result.id} processed_result_id=${processedResult.id}`)
  })

  test('已提交但回應中斷時，須明確讀回、保留草稿且不重送', async ({ page, request }) => {
    await page.goto('/')
    const batch = await importInvestigationFixture(page)
    const result = batch.results.find((row) => row.classification === 'missing_payments')
    const path = investigationPath(batch, result)
    const panel = investigationPanel(page)
    await investigationButton(page, f03).click()
    await expect(panel.getByRole('button', { name: '標記已處理' })).toBeEnabled()
    let writes = 0
    let reads = 0
    await page.route(path, async (route) => {
      if (route.request().method() === 'GET') {
        reads += 1
        if (reads === 1) return route.fulfill({ status: 503, json: {} })
        return route.fallback()
      }
      writes += 1
      const response = await route.fetch({ maxRedirects: 0 })
      expect(response.status()).toBe(200)
      // 實際更新 Rails，再模擬瀏覽器收不到 PATCH 回應。
      await route.abort('failed')
    })

    const note = '已確認營業資料'
    await panel.getByRole('textbox', { name: '處理說明' }).fill(note)
    await panel.getByRole('button', { name: '標記已處理' }).click()
    await expect(panel.getByRole('alert')).toHaveText('目前無法確認查核結果，請先重新讀取再決定是否重試。')
    const summary = page.getByRole('region', { name: '本批次', exact: true })
    await expect(summary.getByText('待確認', { exact: true }).locator('..').locator('dd')).toHaveText('1')
    await expect(summary.getByText('待處理', { exact: true }).locator('..').locator('dd')).toHaveText('3')
    await expect(panel.getByRole('textbox', { name: '處理說明' })).toHaveValue(note)
    await expect(panel.getByRole('button', { name: '標記已處理' })).toBeDisabled()
    expect(writes).toBe(1)
    expect(reads).toBe(0)
    const saved = await getInvestigation(request, path)
    expect(saved.records).toEqual([{ status: 'processed', note, created_at: expect.any(String) }])
    await panel.getByRole('button', { name: '重新讀取查核' }).click()
    await expect(panel.getByRole('alert')).toHaveText('無法讀取查核紀錄，請重試讀取。')
    await expect(panel.getByRole('textbox', { name: '處理說明' })).toHaveValue(note)
    await expect(panel.getByRole('button', { name: '標記已處理' })).toBeDisabled()
    await panel.getByRole('button', { name: '重新讀取查核' }).click()
    await expect(panel.getByText('已讀回相符的處理紀錄。')).toBeVisible()
    await expect(panel.getByRole('textbox', { name: '恢復原因' })).toHaveValue('')
    await expect(panel.getByRole('listitem')).toHaveCount(1)
    await expect(panel.getByRole('listitem')).toContainText(note)
    await expect(groupRow(page, f03).getByRole('cell', { name: '已處理' })).toBeVisible()
    expect(await getInvestigation(request, path)).toEqual(saved)
    expect(reads).toBe(2)
    expect(writes).toBe(1)
  })

  test('Rails 的憑證拒絕與狀態衝突要求手動處理，且保留草稿', async ({ page, request }) => {
    await page.goto('/')
    const batch = await importInvestigationFixture(page)
    const result = batch.results.find((row) => row.classification === 'missing_sales')
    const path = investigationPath(batch, result)
    const panel = investigationPanel(page)
    await investigationButton(page, f04).click()
    const note = '待補查營業來源'
    const explanation = panel.getByRole('textbox', { name: '處理說明' })
    await explanation.fill(note)
    await page.route(path, (route) => route.continue({
      headers: { ...route.request().headers(), 'x-csrf-token': 'expired-test-token' },
    }), { times: 1 })
    let submitted = waitForPatch(page, path)
    await panel.getByRole('button', { name: '標記已處理' }).click()
    const forbidden = await submitted
    expect(forbidden.status()).toBe(403)
    expect((await forbidden.json()).error.code).toBe('invalid_csrf_token')
    await expect(panel.getByRole('alert')).toContainText('請保留說明並重試送出')
    await expect(explanation).toHaveValue(note)
    expect(await getInvestigation(request, path)).toEqual({ investigation_status: 'pending', records: [] })

    const tokenResponse = await request.get('/api/csrf_token')
    expect(tokenResponse.status()).toBe(200)
    const { csrf_token: csrfToken } = await tokenResponse.json()
    const committed = await request.patch(path, {
      headers: { 'X-CSRF-Token': csrfToken },
      data: { status: 'processed', note: '已由另一工作階段比對' },
    })
    expect(committed.status()).toBe(200)
    const saved = await committed.json()
    submitted = waitForPatch(page, path)
    await panel.getByRole('button', { name: '標記已處理' }).click()
    const conflict = await submitted
    expect(conflict.status()).toBe(409)
    expect((await conflict.json()).error.code).toBe('investigation_conflict')
    await expect(panel.getByRole('alert')).toHaveText('查核狀態已變更，請重新讀取後再試。')
    await expect(explanation).toHaveValue(note)
    await expect(panel.getByRole('button', { name: '標記已處理' })).toBeDisabled()
    await panel.getByRole('button', { name: '重新讀取查核' }).click()
    await expect(panel.getByRole('button', { name: '恢復待處理' })).toBeEnabled()
    await expect(panel.getByRole('textbox', { name: '恢復原因' })).toHaveValue(note)
    await expect(panel.getByRole('listitem')).toHaveText(/已由另一工作階段比對/)
    expect(await getInvestigation(request, path)).toEqual(saved)
  })

  test('切換分組或批次時，遲到的查核讀取與更新仍只作用於原分組', async ({ page, request }) => {
    await page.goto('/')
    const first = await importInvestigationFixture(page)
    const second = await importInvestigationFixture(page)
    const firstResult = first.results.find((row) => row.classification === 'missing_payments')
    const secondResult = second.results.find((row) => row.classification === 'missing_payments')
    const firstPath = investigationPath(first, firstResult)
    const secondPath = investigationPath(second, secondResult)
    const panel = investigationPanel(page)
    const get = Promise.withResolvers()
    const releaseGet = Promise.withResolvers()
    await page.route(firstPath, async (route) => {
      const response = await route.fetch()
      expect(response.status()).toBe(200)
      get.resolve()
      await releaseGet.promise
      await route.fulfill({ response })
    }, { times: 1 })

    await (await batchLink(page, first.id)).click()
    await investigationButton(page, f03).click()
    await get.promise
    await expect(panel.getByText('正在讀取查核紀錄…')).toBeVisible()
    await investigationButton(page, f04).click()
    const otherGroupDraft = '查核信用卡收款'
    await panel.getByRole('textbox', { name: '處理說明' }).fill(otherGroupDraft)
    const tokenResponse = await request.get('/api/csrf_token')
    expect(tokenResponse.status()).toBe(200)
    const { csrf_token: csrfToken } = await tokenResponse.json()
    const changed = await request.patch(firstPath, {
      headers: { 'X-CSRF-Token': csrfToken },
      data: { status: 'processed', note: '另一工作階段確認' },
    })
    expect(changed.status()).toBe(200)
    await (await batchLink(page, second.id)).click()
    await expect(page).toHaveURL(`/?batch=${second.id}`)
    await (await batchLink(page, first.id)).click()
    await expect(groupRow(page, f03).getByRole('cell', { name: '已處理' })).toBeVisible()
    await investigationButton(page, f04).click()
    await expect(panel.getByRole('textbox', { name: '處理說明' })).toHaveValue(otherGroupDraft)
    await investigationButton(page, f03).click()
    const initialRead = page.waitForResponse((response) => new URL(response.url()).pathname === firstPath)
    releaseGet.resolve()
    expect((await initialRead).status()).toBe(200)
    await expect(panel.getByRole('button', { name: '恢復待處理' })).toBeEnabled()
    await expect(groupRow(page, f03).getByRole('cell', { name: '已處理' })).toBeVisible()
    await expect(panel.getByRole('heading', { level: 3 })).toContainText(f03)

    const write = Promise.withResolvers()
    const releaseWrite = Promise.withResolvers()
    let writes = 0
    await page.route(firstPath, async (route) => {
      if (route.request().method() !== 'PATCH') return route.fallback()
      writes += 1
      const response = await route.fetch()
      expect(response.status()).toBe(200)
      write.resolve()
      await releaseWrite.promise
      await route.fulfill({ response })
    })
    const oldNote = '第一批次仍需查核'
    await panel.getByRole('textbox', { name: '恢復原因' }).fill(oldNote)
    await panel.getByRole('button', { name: '恢復待處理' }).click()
    await write.promise
    await expect(panel.getByRole('button', { name: '恢復待處理' })).toBeDisabled()
    await expect(panel.getByRole('textbox', { name: '恢復原因' })).toHaveValue(oldNote)
    const committed = await getInvestigation(request, firstPath)
    expect(committed.investigation_status).toBe('pending')
    expect(committed.records).toHaveLength(2)

    await (await batchLink(page, second.id)).click()
    await investigationButton(page, f03).click()
    const newDraft = '第二批次獨立草稿'
    const secondNote = panel.getByRole('textbox', { name: '處理說明' })
    await secondNote.fill(newDraft)
    const saved = waitForPatch(page, firstPath)
    releaseWrite.resolve()
    expect((await saved).status()).toBe(200)
    await expect(page).toHaveURL(`/?batch=${second.id}`)
    await expect(secondNote).toHaveValue(newDraft)
    await expect(panel.getByText(oldNote)).toHaveCount(0)
    await expect(panel.getByText('已恢復待處理。')).toHaveCount(0)
    await expect(panel.getByRole('button', { name: '標記已處理' })).toBeEnabled()
    expect(await getInvestigation(request, secondPath)).toEqual({ investigation_status: 'pending', records: [] })
    expect(writes).toBe(1)

    await (await batchLink(page, first.id)).click()
    await investigationButton(page, f04).click()
    await expect(panel.getByRole('textbox', { name: '處理說明' })).toHaveValue(otherGroupDraft)
    await investigationButton(page, f03).click()
    await expect(panel.getByRole('listitem').last()).toContainText(oldNote)
    await expect(panel.getByRole('textbox', { name: '處理說明' })).toHaveValue('')
    await expect(panel.getByText('已恢復待處理。')).toBeVisible()
    expect(await getInvestigation(request, firstPath)).toEqual(committed)
  })

  for (const snapshotSource of ['先發出的匯入', '後發出的批次明細']) {
    test(`${snapshotSource}套用較新狀態後，遲到的寫入確認須補讀且失敗可恢復`, async ({ page, request }) => {
      const fixture = uniqueSales('newer-snapshot-sales.csv')
      await page.goto('/')
      const batch = await importInvestigationFixture(page, fixture)
      const result = batch.results.find((row) => row.classification === 'missing_payments')
      const path = investigationPath(batch, result)
      const panel = investigationPanel(page)
      const importStarted = Promise.withResolvers()
      const allowImport = Promise.withResolvers()
      const writeCommitted = Promise.withResolvers()
      const allowWriteResponse = Promise.withResolvers()
      let writes = 0
      let reads = 0

      await investigationButton(page, f03).click()
      await expect(panel.getByRole('button', { name: '標記已處理' })).toBeEnabled()
      await page.route(path, async (route) => {
        if (route.request().method() === 'GET') {
          reads += 1
          if (reads === 1) return route.fulfill({ status: 503, json: {} })
          return route.fallback()
        }
        writes += 1
        const response = await route.fetch()
        expect(response.status()).toBe(200)
        writeCommitted.resolve(await response.json())
        await allowWriteResponse.promise
        await route.fulfill({ response })
      })
      await page.route(batchesPath, async (route) => {
        if (route.request().method() !== 'POST') return route.fallback()
        importStarted.resolve()
        await allowImport.promise
        await route.continue()
      })

      if (snapshotSource === '先發出的匯入') {
        await selectFiles(page, fixture)
        await page.getByRole('button', { name: '匯入並對帳' }).click()
        await importStarted.promise
      }
      const note = '本工作階段已確認缺收款資料'
      await panel.getByRole('textbox', { name: '處理說明' }).fill(note)
      const patch = waitForPatch(page, path)
      await panel.getByRole('button', { name: '標記已處理' }).click()
      expect((await writeCommitted.promise).records).toEqual([
        { status: 'processed', note, created_at: expect.any(String) },
      ])

      // 真正提交第二次轉換；批次回應讀到的是較新的 DB 狀態，並非偽造 JSON。
      const tokenResponse = await request.get('/api/csrf_token')
      expect(tokenResponse.status()).toBe(200)
      const { csrf_token: csrfToken } = await tokenResponse.json()
      const peerNote = '另一工作階段恢復查核'
      const peerResponse = await request.patch(path, {
        headers: { 'X-CSRF-Token': csrfToken },
        data: { status: 'pending', note: peerNote },
      })
      expect(peerResponse.status()).toBe(200)
      const latest = await peerResponse.json()
      expect(latest.records.map((record) => record.status)).toEqual(['processed', 'pending'])
      const snapshotResponse = page.waitForResponse((response) =>
        snapshotSource === '先發出的匯入'
          ? new URL(response.url()).pathname === batchesPath && response.request().method() === 'POST'
          : new URL(response.url()).pathname === `${batchesPath}/${batch.id}`,
      )
      if (snapshotSource === '先發出的匯入') allowImport.resolve()
      else await (await batchLink(page, batch.id)).click()
      const snapshot = await snapshotResponse
      expect(snapshot.status()).toBe(200)
      expect((await snapshot.json()).batch.results.find((row) => row.id === result.id).investigation_status).toBe('pending')
      await expect(groupRow(page, f03).getByRole('cell', { name: '待處理', exact: true })).toBeVisible()
      await investigationButton(page, f03).click()
      await expect(panel.getByText('正在儲存查核紀錄…')).toBeVisible()

      allowWriteResponse.resolve()
      expect((await patch).status()).toBe(200)
      await expect(groupRow(page, f03).getByRole('cell', { name: '查核狀態待確認', exact: true })).toBeVisible()
      await expect(panel.getByText('目前狀態：查核狀態待確認')).toBeVisible()
      await expect(panel.getByText('已標記已處理。')).toBeVisible()
      await expect(panel.getByRole('listitem')).toContainText(note)
      await expect(panel.getByRole('alert')).toHaveText('無法讀取查核紀錄，請重試讀取。')
      await expect(panel.getByRole('button', { name: '恢復待處理' })).toBeDisabled()
      await expect(groupRow(page, f04).getByRole('cell', { name: '待處理', exact: true })).toBeVisible()
      await panel.getByRole('button', { name: '關閉查核' }).click()
      await investigationButton(page, f03).click()
      await expect(panel.getByRole('button', { name: '重新讀取查核' })).toBeEnabled()
      expect(reads).toBe(1)

      await panel.getByRole('button', { name: '重新讀取查核' }).click()
      await expect(panel.getByRole('button', { name: '標記已處理' })).toBeEnabled()
      await expect(panel.getByText('目前狀態：待處理')).toBeVisible()
      await expect(groupRow(page, f03).getByRole('cell', { name: '待處理', exact: true })).toBeVisible()
      await expect(panel.getByRole('listitem')).toHaveCount(2)
      await expect(panel.getByRole('listitem').last()).toContainText(peerNote)
      expect(await getInvestigation(request, path)).toEqual(latest)
      expect(reads).toBe(2)
      expect(writes).toBe(1)
    })
  }

  for (const oldRead of ['成功', '404', '網路中斷', '補讀期間再套用快照']) {
    test(`批次快照使在途歷史失效：${oldRead}後須補讀，失敗仍可手動恢復`, async ({ page, request }) => {
      const fixture = uniqueSales('read-fence-sales.csv')
      await page.goto('/')
      const batch = await importInvestigationFixture(page, fixture)
      const result = batch.results.find((row) => row.classification === 'missing_payments')
      const path = investigationPath(batch, result)
      const panel = investigationPanel(page)
      const importStarted = Promise.withResolvers()
      const allowImport = Promise.withResolvers()
      const oldReadReady = Promise.withResolvers()
      const allowOldRead = Promise.withResolvers()
      const refreshReady = Promise.withResolvers()
      const allowRefresh = Promise.withResolvers()
      let reads = 0
      let writes = 0

      await investigationButton(page, f03).click()
      await expect(panel.getByRole('button', { name: '標記已處理' })).toBeEnabled()
      await page.route(batchesPath, async (route) => {
        if (route.request().method() !== 'POST') return route.fallback()
        importStarted.resolve()
        await allowImport.promise
        await route.continue()
      })
      const startImport = async () => {
        await selectFiles(page, fixture)
        await page.getByRole('button', { name: '匯入並對帳' }).click()
        await importStarted.promise
      }
      // 另三例先確認寫入，涵蓋 entry.revision 等於批次請求界線的正常讀取。
      if (oldRead === '成功') await startImport()
      const note = '本工作階段確認完成'
      await panel.getByRole('textbox', { name: '處理說明' }).fill(note)
      const patch = waitForPatch(page, path)
      await panel.getByRole('button', { name: '標記已處理' }).click()
      expect((await patch).status()).toBe(200)
      await expect(panel.getByText('已標記已處理。')).toBeVisible()
      const confirmed = await getInvestigation(request, path)
      if (oldRead !== '成功') await startImport()

      await page.route(path, async (route) => {
        if (route.request().method() !== 'GET') {
          writes += 1
          return route.fallback()
        }
        reads += 1
        if (reads === 1) {
          const response = await route.fetch()
          expect(response.status()).toBe(200)
          oldReadReady.resolve(await response.json())
          await allowOldRead.promise
          if (oldRead === '404') return route.fulfill({ status: 404, json: {} })
          if (oldRead === '網路中斷') return route.abort('failed')
          return route.fulfill({ response })
        }
        if (reads === 2 && oldRead === '補讀期間再套用快照') {
          const response = await route.fetch()
          expect(response.status()).toBe(200)
          refreshReady.resolve(await response.json())
          await allowRefresh.promise
          return route.fulfill({ response })
        }
        if (reads === (oldRead === '補讀期間再套用快照' ? 3 : 2)) {
          return route.fulfill({ status: 503, json: {} })
        }
        return route.fallback()
      })
      await panel.getByRole('button', { name: '關閉查核' }).click()
      await investigationButton(page, f03).click()
      expect(await oldReadReady.promise).toEqual(confirmed)

      // 真實 peer PATCH 在舊 GET 取得快照後提交，匯入才開始讀 DB。
      const tokenResponse = await request.get('/api/csrf_token')
      expect(tokenResponse.status()).toBe(200)
      const { csrf_token: csrfToken } = await tokenResponse.json()
      const peerNote = '另一工作階段恢復待處理'
      const peerResponse = await request.patch(path, {
        headers: { 'X-CSRF-Token': csrfToken },
        data: { status: 'pending', note: peerNote },
      })
      expect(peerResponse.status()).toBe(200)
      const latest = await peerResponse.json()
      expect(latest).toEqual({ investigation_status: 'pending', records: [
        ...confirmed.records,
        { status: 'pending', note: peerNote, created_at: expect.any(String) },
      ] })
      const snapshotResponse = page.waitForResponse((response) =>
        new URL(response.url()).pathname === batchesPath && response.request().method() === 'POST',
      )
      allowImport.resolve()
      const snapshot = await snapshotResponse
      expect(snapshot.status()).toBe(200)
      expect((await snapshot.json()).batch.results.find((row) => row.id === result.id).investigation_status).toBe('pending')
      await expect(page.getByText('已開啟既有批次。')).toBeVisible()
      await investigationButton(page, f03).click()
      await expect(panel.getByText('目前狀態：查核狀態待確認')).toBeVisible()
      allowOldRead.resolve()

      if (oldRead === '補讀期間再套用快照') {
        expect(await refreshReady.promise).toEqual(latest)
        const detailResponse = page.waitForResponse((response) => new URL(response.url()).pathname === `${batchesPath}/${batch.id}`)
        await (await batchLink(page, batch.id)).click()
        expect((await detailResponse).status()).toBe(200)
        await investigationButton(page, f03).click()
        await expect(panel.getByText('目前狀態：查核狀態待確認')).toBeVisible()
        allowRefresh.resolve()
      }
      await expect(panel.getByRole('alert')).toHaveText('無法讀取查核紀錄，請重試讀取。')
      await expect(panel.getByText('目前狀態：查核狀態待確認')).toBeVisible()
      await expect(groupRow(page, f03).getByRole('cell', { name: '查核狀態待確認', exact: true })).toBeVisible()
      await expect(panel.getByRole('listitem')).toHaveCount(1)
      await expect(panel.getByRole('listitem')).toContainText(note)
      await expect(panel.getByText('已標記已處理。')).toBeVisible()
      await expect(panel.getByRole('button', { name: '恢復待處理' })).toBeDisabled()
      expect(await getInvestigation(request, path)).toEqual(latest)
      expect((await getBatch(request, batch.id)).results.find((row) => row.id === result.id).investigation_status).toBe('pending')

      await panel.getByRole('button', { name: '重新讀取查核' }).click()
      await expect(panel.getByRole('button', { name: '標記已處理' })).toBeEnabled()
      await expect(panel.getByText('目前狀態：待處理')).toBeVisible()
      await expect(panel.getByRole('listitem')).toHaveCount(2)
      await expect(panel.getByRole('listitem').nth(0)).toContainText(note)
      await expect(panel.getByRole('listitem').nth(1)).toContainText(peerNote)
      expect(await panel.locator('time').evaluateAll((nodes) => nodes.map((node) => node.dateTime)))
        .toEqual(latest.records.map((record) => record.created_at))
      expect(await getInvestigation(request, path)).toEqual(latest)
      expect(reads).toBe(oldRead === '補讀期間再套用快照' ? 4 : 3)
      expect(writes).toBe(0)
    })
  }

  test('確認寫入抵擋遲到的同內容匯入快照', async ({ page, request }) => {
    const fixture = uniqueSales('overlap-sales.csv')
    await page.goto('/')
    const batch = await importInvestigationFixture(page, fixture)
    const result = batch.results.find((row) => row.classification === 'missing_payments')
    const path = investigationPath(batch, result)
    const panel = investigationPanel(page)
    const writeStarted = Promise.withResolvers()
    const allowWrite = Promise.withResolvers()
    const staleBatchReady = Promise.withResolvers()
    const allowBatch = Promise.withResolvers()
    const readbackStarted = Promise.withResolvers()
    const allowReadback = Promise.withResolvers()
    let writes = 0
    let holdReadback = false

    await page.route(path, async (route) => {
      if (route.request().method() === 'GET') {
        if (holdReadback) {
          readbackStarted.resolve()
          await allowReadback.promise
        }
        return route.fallback()
      }
      writes += 1
      writeStarted.resolve()
      await allowWrite.promise
      await route.continue()
    })
    await page.route(batchesPath, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback()
      const response = await route.fetch()
      expect(response.status()).toBe(200)
      staleBatchReady.resolve((await response.json()).batch)
      await allowBatch.promise
      await route.fulfill({ response })
    })

    const note = '核對完成，保留處理結果'
    const patch = waitForPatch(page, path)
    await investigationButton(page, f03).click()
    await panel.getByRole('textbox', { name: '處理說明' }).fill(note)
    await panel.getByRole('button', { name: '標記已處理' }).click()
    await writeStarted.promise
    await selectFiles(page, { ...fixture, name: 'renamed-overlap-sales.csv' })
    await page.getByRole('button', { name: '匯入並對帳' }).click()
    expect(await staleBatchReady.promise).toEqual(batch)
    expect(await getInvestigation(request, path)).toEqual({ investigation_status: 'pending', records: [] })

    allowWrite.resolve()
    expect((await patch).status()).toBe(200)
    await expect(panel.getByText('已標記已處理。')).toBeVisible()
    const saved = await getInvestigation(request, path)
    expect(saved.records).toEqual([{ status: 'processed', note, created_at: expect.any(String) }])
    holdReadback = true
    allowBatch.resolve()
    await expect(page.getByText('已開啟既有批次。')).toBeVisible()
    await expect(groupRow(page, f03).getByRole('cell', { name: '查核狀態待確認', exact: true })).toBeVisible()
    await expect(groupRow(page, f04).getByRole('cell', { name: '待處理' })).toBeVisible()
    expect((await getBatch(request, batch.id)).results.find((row) => row.id === result.id)).toEqual({
      ...result, investigation_status: 'processed',
    })
    await readbackStarted.promise
    allowReadback.resolve()
    await investigationButton(page, f03).click()
    await expect(panel.getByRole('listitem')).toContainText(note)
    await expect(panel.getByRole('button', { name: '恢復待處理' })).toBeEnabled()
    expect(await getInvestigation(request, path)).toEqual(saved)
    expect(writes).toBe(1)
  })

  test('較早批次明細與補讀失敗仍保留確認的寫入，且可手動恢復', async ({ page, request }) => {
    await page.goto('/')
    const batch = await importInvestigationFixture(page)
    const result = batch.results.find((row) => row.classification === 'missing_sales')
    const path = investigationPath(batch, result)
    const panel = investigationPanel(page)
    const writeStarted = Promise.withResolvers()
    const allowWrite = Promise.withResolvers()
    let writes = 0
    let failReadback = false

    await page.route(path, async (route) => {
      if (route.request().method() === 'GET') {
        if (!failReadback) return route.fallback()
        failReadback = false
        return route.fulfill({ status: 503, json: {} })
      }
      writes += 1
      writeStarted.resolve()
      await allowWrite.promise
      await route.continue()
    })

    const note = '已確認缺營業資料'
    const patch = waitForPatch(page, path)
    await investigationButton(page, f04).click()
    await panel.getByRole('textbox', { name: '處理說明' }).fill(note)
    await panel.getByRole('button', { name: '標記已處理' }).click()
    await writeStarted.promise
    const batchGet = page.waitForResponse((response) => new URL(response.url()).pathname === `${batchesPath}/${batch.id}`)
    await (await batchLink(page, batch.id)).click()
    const stale = await batchGet
    expect(stale.status()).toBe(200)
    expect((await stale.json()).batch).toEqual(batch)
    await expect(groupRow(page, f04).getByRole('cell', { name: '待處理' })).toBeVisible()
    await investigationButton(page, f04).click()
    await expect(panel.getByText('正在儲存查核紀錄…')).toBeVisible()
    failReadback = true
    allowWrite.resolve()
    expect((await patch).status()).toBe(200)
    await expect(panel.getByRole('alert')).toHaveText('無法讀取查核紀錄，請重試讀取。')
    await expect(panel.getByText('已標記已處理。')).toBeVisible()
    await expect(panel.getByText('目前狀態：查核狀態待確認')).toBeVisible()
    await expect(panel.getByRole('listitem')).toContainText(note)
    await expect(groupRow(page, f04).getByRole('cell', { name: '查核狀態待確認', exact: true })).toBeVisible()
    await expect(panel.getByRole('button', { name: '恢復待處理' })).toBeDisabled()
    const saved = await getInvestigation(request, path)
    expect(saved.records).toEqual([{ status: 'processed', note, created_at: expect.any(String) }])

    await panel.getByRole('button', { name: '重新讀取查核' }).click()
    await expect(panel.getByRole('alert')).toHaveCount(0)
    await expect(panel.getByRole('button', { name: '恢復待處理' })).toBeEnabled()
    await expect(panel.getByRole('listitem')).toContainText(note)
    await expect(groupRow(page, f04).getByRole('cell', { name: '已處理', exact: true })).toBeVisible()
    expect((await getBatch(request, batch.id)).results.find((row) => row.id === result.id)).toEqual({
      ...result, investigation_status: 'processed',
    })
    expect(await getInvestigation(request, path)).toEqual(saved)
    expect(writes).toBe(1)
  })
})
