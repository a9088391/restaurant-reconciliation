import { defineConfig } from '@playwright/test'

const project = process.env.BROWSER_TEST_PROJECT
const ticket03 = project === 'restaurant-reconciliation-t03-browser'
const ticket02 = project === 'restaurant-reconciliation-t02-browser'
const ticket04 = project === 'restaurant-reconciliation-t04-browser'
const ticket04Output = process.env.BROWSER_TEST_T04_OUTPUT
const fixedSampleMode = process.env.BROWSER_TEST_T04_FIXED_SAMPLE
const fixedSampleTitle = /T04 固定樣本重跑/

if ((!ticket02 && !ticket03 && !ticket04)
  || ticket03 !== (process.env.BROWSER_TEST_T03_OUTPUT === 'yes')
  || ticket04 !== (ticket04Output === 'yes')
  || (ticket04Output !== undefined && ticket04Output !== 'yes')) {
  throw new Error('瀏覽器測試只允許在指定的隔離 Compose 專案執行。')
}

if (fixedSampleMode !== undefined && (fixedSampleMode !== 'yes' || !ticket04)) {
  throw new Error('T04 固定樣本重跑只允許在第 04 票隔離 Compose 專案以 BROWSER_TEST_T04_FIXED_SAMPLE=yes 執行。')
}

if (fixedSampleMode !== 'yes' && (process.env.BROWSER_TEST_T04_OLD_BATCH_ID !== undefined
  || process.env.BROWSER_TEST_T04_OLD_RESULT_ID !== undefined)) {
  throw new Error('T04 舊批次與結果 ID 只允許在固定樣本重跑時提供。')
}

export default defineConfig({
  testDir: './tests',
  ...(fixedSampleMode === 'yes' ? { grep: fixedSampleTitle } : { grepInvert: fixedSampleTitle }),
  outputDir: './test-results',
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:3000',
    viewport: { width: 1280, height: 900 },
    screenshot: 'only-on-failure',
  },
})
