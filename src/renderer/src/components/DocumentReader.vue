<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue'
import { IconFileText, IconChevronLeft, IconChevronRight } from '@tabler/icons-vue'
import type { TimelineDocument } from '../../../shared/timeline-import'

const props = defineProps<{
  document: TimelineDocument
  activeId: string
  focusSeconds: number | null
}>()
const emit = defineEmits<{ select: [id: string] }>()
const body = ref<HTMLElement | null>(null)
const index = computed(() =>
  Math.max(
    0,
    props.document.chunks.findIndex((chunk) => chunk.id === props.activeId)
  )
)
const chunk = computed(() => props.document.chunks[index.value])
const focusedLine = computed(() => {
  if (props.focusSeconds === null || !chunk.value) return -1
  const exact = chunk.value.transcript.findIndex((line) => line.seconds === props.focusSeconds)
  return exact >= 0
    ? exact
    : chunk.value.transcript.findIndex(
        (line) => Math.floor(line.seconds) === Math.floor(props.focusSeconds!)
      )
})
const sentenceCount = computed(() =>
  props.document.chunks.reduce((total, chunk) => total + chunk.transcript.length, 0)
)
watch(
  [index, () => props.focusSeconds],
  async () => {
    await nextTick()
    const target =
      focusedLine.value < 0
        ? null
        : body.value?.querySelector<HTMLElement>(`[data-reader-line="${focusedLine.value}"]`)
    if (target) target.scrollIntoView({ block: 'center' })
    else body.value?.scrollTo({ top: 0 })
  },
  { immediate: true }
)
</script>

<template>
  <article class="flex h-full w-full flex-col bg-white" aria-label="导入资料阅读器">
    <header class="shrink-0 border-b border-slate-200 px-6 py-5">
      <div class="mb-2 flex items-center gap-2 text-xs text-slate-500">
        <IconFileText class="h-4 w-4" />
        <span>{{ document.sourceKind === 'subtitle' ? '原始字幕' : '导入笔记' }}</span>
        <span class="text-slate-300">/</span>
        <span>{{ sentenceCount }} 条原文</span>
      </div>
      <h1 class="text-xl font-semibold leading-snug text-slate-800 break-words">
        {{ document.title }}
      </h1>
      <p class="mt-2 truncate text-xs text-slate-400" :title="document.sourceLabel">
        {{ document.sourceLabel }}
      </p>
      <p class="mt-3 text-sm leading-relaxed text-slate-500">
        {{
          document.sourceKind === 'subtitle'
            ? '字幕按两分钟分组，保留原文与时间信息，未生成 AI 摘要。'
            : '从文件恢复的时间轴，可以搜索、引用和再次导出。'
        }}
      </p>
      <p
        v-for="warning in document.warnings"
        :key="warning"
        class="mt-2 text-xs text-amber-700"
        role="status"
      >
        {{ warning }}
      </p>
    </header>
    <div v-if="chunk" ref="body" class="min-h-0 flex-1 overflow-y-auto px-6 py-6 select-text">
      <div class="mx-auto max-w-2xl">
        <p class="font-mono text-xs text-blue-500">{{ chunk.startTime }} — {{ chunk.endTime }}</p>
        <h2 class="mt-2 text-lg font-semibold text-slate-800">{{ chunk.title }}</h2>
        <p v-if="chunk.summary" class="mt-3 text-sm leading-7 text-slate-600">
          {{ chunk.summary }}
        </p>
        <ul
          v-if="chunk.keyPoints.length"
          class="mt-4 list-disc space-y-2 pl-5 text-sm leading-6 text-slate-600"
        >
          <li v-for="(point, pointIndex) in chunk.keyPoints" :key="pointIndex">{{ point }}</li>
        </ul>
        <div v-if="chunk.transcript.length" class="mt-6 space-y-4 border-t border-slate-100 pt-5">
          <div
            v-for="(line, lineIndex) in chunk.transcript"
            :key="lineIndex"
            :data-reader-line="lineIndex"
            class="flex gap-4 rounded-lg px-2 py-1 -mx-2"
            :class="lineIndex === focusedLine ? 'bg-blue-50 ring-1 ring-blue-100' : ''"
          >
            <span class="mt-1 shrink-0 font-mono text-xs text-slate-400">{{ line.time }}</span>
            <p class="whitespace-pre-wrap text-sm leading-7 text-slate-700 break-words">
              {{ line.text }}
            </p>
          </div>
        </div>
        <p v-else class="mt-6 text-sm text-slate-400">此片段没有逐句原文。</p>
      </div>
    </div>
    <footer
      class="flex shrink-0 items-center justify-between gap-3 border-t border-slate-200 px-6 py-3 text-sm"
    >
      <button
        class="flex items-center gap-1 rounded-lg px-2 py-1.5 text-slate-500 hover:bg-slate-100 disabled:opacity-40"
        :disabled="index === 0"
        @click="emit('select', document.chunks[index - 1].id)"
      >
        <IconChevronLeft class="h-4 w-4" />上一片段
      </button>
      <span class="text-xs text-slate-400">{{ index + 1 }} / {{ document.chunks.length }}</span>
      <button
        class="flex items-center gap-1 rounded-lg px-2 py-1.5 text-slate-500 hover:bg-slate-100 disabled:opacity-40"
        :disabled="index === document.chunks.length - 1"
        @click="emit('select', document.chunks[index + 1].id)"
      >
        下一片段<IconChevronRight class="h-4 w-4" />
      </button>
    </footer>
  </article>
</template>
