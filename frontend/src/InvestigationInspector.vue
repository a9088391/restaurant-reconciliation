<script setup>
import { computed, ref } from 'vue'
import { amount, classifications, eventTypes, investigationStatuses, investigationTime, signedInteger, sourceNames } from './reconciliationPresentation.js'

// 面板只呈現父層傳入的分組與查核狀態，草稿修改及讀寫都交回 App 處理。
const props = defineProps({
  entry: { type: Object, default: null },
  group: { type: Object, default: null },
  events: { type: Array, required: true },
  filenames: { type: Object, default: null },
  status: { type: String, required: true },
  noteLabel: { type: String, required: true },
  isReopening: Boolean,
})
// 每側只預覽三筆，完整來源仍由既有追查入口提供，避免大量紀錄推遠查核表單。
const evidencePreview = computed(() => ['sales', 'payments'].flatMap((source) =>
  props.events.filter((event) => event.source === source).slice(0, 3),
))
const emit = defineEmits(['close', 'read', 'submit', 'update:draft'])
const investigationHeading = ref(null)
const investigationNote = ref(null)

// 父層確認目前分組仍有效後才呼叫，避免遲到回應搶走另一分組的焦點。
defineExpose({
  focusHeading: () => investigationHeading.value?.focus(),
  focusNote: () => investigationNote.value?.focus(),
})
</script>

<template>
  <section
    v-show="entry"
    id="investigation"
    class="panel investigation"
    role="region"
    aria-label="異常查核"
  >
    <template v-if="entry">
      <div class="inspector-header">
        <h3
          ref="investigationHeading"
          tabindex="-1"
        >
          異常查核：{{ entry.label }}
        </h3>
        <button
          class="secondary"
          type="button"
          @click="emit('close')"
        >
          關閉查核
        </button>
      </div>
      <template v-if="group">
        <div class="inspector-badges">
          <span class="classification">{{ classifications[group.classification] ?? '未知結果' }}</span>
          <span class="status-badge">{{ status }}</span>
        </div>
        <div class="inspector-difference">
          <span>差額<small>新臺幣元</small></span>
          <strong>{{ amount(group.difference, signedInteger) }}</strong>
        </div>
        <dl class="inspector-nets">
          <div><dt>營業淨額</dt><dd>{{ amount(group.sales_net) }}</dd></div>
          <div><dt>收款淨額</dt><dd>{{ amount(group.payments_net) }}</dd></div>
        </dl>
        <section
          class="inspector-evidence"
          aria-label="查核分組來源摘要"
        >
          <h4>來源追查</h4>
          <p
            v-if="events.length > evidencePreview.length"
            class="muted evidence-hint"
          >
            此查核分組共 {{ events.length }} 筆，預覽 {{ evidencePreview.length }} 筆 · 每來源最多 3 筆，完整追查請使用結果列的來源按鈕
          </p>
          <div
            v-for="event in evidencePreview"
            :key="`${event.source}:${event.record_number}`"
            class="evidence-row"
          >
            <span class="source-tag">{{ sourceNames[event.source] }}</span>
            <span class="evidence-identity">{{ filenames[`${event.source}_filename`] }}<small>第 {{ event.record_number }} 筆 · {{ event.event_id }}</small></span>
            <span class="event-type">{{ eventTypes[event.event_type] }}</span>
            <strong>{{ amount(event.amount) }}</strong>
            <span
              v-if="event.original_event_id"
              class="evidence-original"
            >原交易 {{ event.original_event_id }}</span>
          </div>
        </section>
      </template>
      <p
        v-if="entry.loading || entry.saving"
        class="muted feedback"
        role="status"
      >
        {{ entry.loading ? '正在讀取查核紀錄…' : '正在儲存查核紀錄…' }}
      </p>
      <p
        v-if="entry.error"
        class="error feedback"
        role="alert"
      >
        {{ entry.error }}
      </p>
      <button
        v-if="!entry.missing && (entry.readRequired || (!entry.readReady && entry.error))"
        class="secondary feedback"
        type="button"
        :disabled="entry.loading || entry.saving"
        @click="emit('read')"
      >
        重新讀取查核
      </button>
      <p
        v-if="entry.notice"
        class="notice feedback"
        role="status"
      >
        {{ entry.notice }}
      </p>
      <template v-if="entry.data">
        <p class="feedback">
          目前狀態：<strong>{{ entry.readRequired ? '查核狀態待確認' : investigationStatuses[entry.data.investigation_status] }}</strong>
        </p>
        <p v-if="entry.readRequired">
          請重新讀取查核，確認目前狀態後再操作。下方保留先前已確認的紀錄。
        </p>
        <h4>{{ entry.readRequired ? '已知處理紀錄' : '處理紀錄' }}</h4>
        <p
          v-if="entry.data.records.length === 0"
          class="muted"
        >
          尚無處理紀錄。
        </p>
        <ol
          v-else
          class="investigation-records"
        >
          <li
            v-for="(record, index) in entry.data.records"
            :key="index"
          >
            <strong>{{ investigationStatuses[record.status] }}</strong>
            <time :datetime="record.created_at">{{ investigationTime.format(new Date(record.created_at)) }}</time>
            <p class="investigation-note">
              {{ record.note }}
            </p>
          </li>
        </ol>
        <form
          v-if="!entry.missing"
          @submit.prevent="emit('submit')"
        >
          <label for="investigation-note">{{ noteLabel }}</label>
          <textarea
            id="investigation-note"
            ref="investigationNote"
            :value="entry.draft"
            rows="3"
            required
            :readonly="!entry.readReady || entry.readRequired || entry.saving"
            @input="emit('update:draft', $event.target.value)"
          />
          <button
            type="submit"
            :disabled="!entry.readReady || entry.readRequired || entry.saving"
          >
            {{ isReopening ? '恢復待處理' : '標記已處理' }}
          </button>
        </form>
      </template>
    </template>
  </section>
</template>
