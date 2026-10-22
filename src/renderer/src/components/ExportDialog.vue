<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue'
import { IconDownload, IconX, IconLoader2 } from '@tabler/icons-vue'
import type { TextExportFormat } from '../../../shared/export'

const props = defineProps<{
  open: boolean
  busy: boolean
  totalCount: number
  filteredCount: number
  hasFilter: boolean
  transcriptCount: number
  includeTranscript: boolean
  error: string
}>()
const emit = defineEmits<{
  close: []
  export: [format: TextExportFormat | 'pdf', filteredOnly: boolean, includeTranscript: boolean]
}>()
const dialog = ref<HTMLDialogElement | null>(null)
const format = ref<TextExportFormat | 'pdf'>('markdown')
const filteredOnly = ref(false)
const withTranscript = ref(true)
const isSubtitle = computed(() => format.value === 'srt' || format.value === 'vtt')
const selectionCount = computed(() => (filteredOnly.value ? props.filteredCount : props.totalCount))

watch(
  () => props.open,
  async (open) => {
    await nextTick()
    if (open) {
      filteredOnly.value = false
      withTranscript.value = props.includeTranscript
      dialog.value?.showModal()
    } else dialog.value?.close()
  }
)

function close(): void {
  if (!props.busy) dialog.value?.close()
}
</script>

<template>
  <dialog
    ref="dialog"
    class="export-dialog w-[440px] max-w-[calc(100vw-32px)] rounded-2xl border border-slate-200 p-0 text-slate-800 shadow-xl"
    aria-labelledby="export-dialog-title"
    @close="emit('close')"
    @cancel="busy && $event.preventDefault()"
    @click="$event.target === dialog && close()"
  >
    <form class="p-6" @submit.prevent="emit('export', format, filteredOnly, withTranscript)">
      <div class="flex items-center justify-between gap-4">
        <h2 id="export-dialog-title" class="text-lg font-semibold">导出时间轴</h2>
        <button
          type="button"
          aria-label="关闭导出"
          class="rounded-md p-1 text-slate-400 hover:bg-slate-100"
          :disabled="busy"
          @click="close"
        >
          <IconX class="h-5 w-5" />
        </button>
      </div>
      <p class="mt-1 text-sm text-slate-500">保留时间戳，把内容带到你的笔记或剪辑工具。</p>

      <label for="export-format" class="mt-5 block text-sm font-medium">文件格式</label>
      <select
        id="export-format"
        v-model="format"
        :disabled="busy"
        class="mt-2 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
      >
        <option value="markdown">Markdown · 可编辑笔记</option>
        <option value="json">JSON · 完整时间轴数据</option>
        <option value="srt">SRT · 通用字幕</option>
        <option value="vtt">WebVTT · 网页字幕</option>
        <option value="pdf">PDF · 排版文档与 AI 标题</option>
      </select>
      <p class="mt-2 text-xs leading-relaxed text-slate-500">
        {{
          format === 'pdf'
            ? 'PDF 会使用当前模型生成文档标题，其余格式在本地直接导出。'
            : '在本地生成，无需联网或调用模型。'
        }}
      </p>

      <fieldset class="mt-5 space-y-3 text-sm" :disabled="busy">
        <legend class="mb-2 font-medium">导出内容</legend>
        <label v-if="hasFilter" class="flex items-center gap-2">
          <input v-model="filteredOnly" type="checkbox" class="accent-blue-500" />
          仅导出当前筛选结果（{{ filteredCount }} 个片段）
        </label>
        <label v-if="!isSubtitle" class="flex items-center gap-2">
          <input v-model="withTranscript" type="checkbox" class="accent-blue-500" />
          包含逐句原文
        </label>
        <p v-else class="rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
          字幕使用逐句原文。解析结果只有起始时间时，结束时间按下一句、片段边界及最长 8 秒推断。
        </p>
      </fieldset>
      <p v-if="isSubtitle && !transcriptCount" role="status" class="mt-3 text-sm text-amber-700">
        当前结果没有逐句原文，无法导出字幕。
      </p>

      <p v-if="error" role="alert" class="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
        {{ error }}
      </p>

      <div class="mt-6 flex items-center justify-between gap-3 border-t border-slate-100 pt-4">
        <span class="text-xs text-slate-400">{{ selectionCount }} 个片段</span>
        <div class="flex gap-2">
          <button
            type="button"
            class="rounded-lg border border-slate-200 px-3 py-2 text-sm hover:bg-slate-50"
            :disabled="busy"
            @click="close"
          >
            取消
          </button>
          <button
            type="submit"
            class="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            :disabled="busy || !selectionCount || (isSubtitle && !transcriptCount)"
          >
            <IconLoader2 v-if="busy" class="h-4 w-4 animate-spin" />
            <IconDownload v-else class="h-4 w-4" />
            {{ busy ? '正在导出' : '选择保存位置' }}
          </button>
        </div>
      </div>
    </form>
  </dialog>
</template>

<style scoped>
.export-dialog {
  margin: auto;
}
.export-dialog::backdrop {
  background: rgb(15 23 42 / 35%);
}
</style>
