import js from '@eslint/js'
import vue from 'eslint-plugin-vue'
import globals from 'globals'

export default [
  { ignores: ['dist/', 'test-results/', 'playwright-report/'] },
  js.configs.recommended,
  ...vue.configs['flat/recommended'],
  { files: ['src/**/*.{js,vue}'], languageOptions: { globals: globals.browser } },
  { files: ['*.config.js', 'tests/**/*.js'], languageOptions: { globals: globals.node } },
]
