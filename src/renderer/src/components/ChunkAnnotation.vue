<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { IconBookmark, IconPencil, IconRefresh } from '@tabler/icons-vue'
import { MAX_NOTE_LENGTH, type ChunkAnnotation } from '../../../shared/annotations'

defineProps<{
  annotation?: ChunkAnnotation
  status?: 'saving' | 'saved' | 'error'
  disabled: boolean
}>()
const emit = defineEmits<{ note: [value: string]; bookmark: []; retry: [] }>()
const editorOpen = ref(false)
const editor = ref<HTMLTextAreaElement | null>(null)
watch(editorOpen, async (open) => {
  if (open) {
    await nextTick()
    editor.value?.focus()
  }
})
</script>

<template>
  <div class="mt-2">
    <div class="flex items-center justify-between gap-2 text-[11px]">
      <slot name="leading" />
      <div class="flex items-center gap-2">
        <button
          class="flex items-center gap-1 rounded px-1 py-1 transition-colors disabled:opacity-40"
          :class="annotation?.bookmarked ? 'text-amber-600' : 'text-slate-400 hover:text-amber-600'"
          :disabled="disabled"
          :aria-pressed="Boolean(annotation?.bookmarked)"
          :aria-label="annotation?.bookmarked ? '取消收藏片段' : '收藏片段'"
          @click="emit('bookmark')"
        >
          <IconBookmark
            class="h-3.5 w-3.5"
            :class="annotation?.bookmarked ? 'fill-amber-100' : ''"
          />
          {{ annotation?.bookmarked ? '已收藏' : '收藏' }}
        </button>
        <button
          class="flex items-center gap-1 rounded px-1 py-1 text-slate-400 hover:text-blue-500 disabled:opacity-40"
          :disabled="disabled"
          :aria-expanded="editorOpen"
          @click="editorOpen = !editorOpen"
        >
          <IconPencil class="h-3.5 w-3.5" />{{
            editorOpen ? '收起笔记' : annotation?.note ? '编辑笔记' : '写笔记'
          }}
        </button>
        <slot name="trailing" />
      </div>
    </div>
    <div v-if="editorOpen" class="mt-2 rounded-lg border border-blue-100 bg-blue-50/40 p-2">
      <label class="block text-xs font-medium text-slate-500">
        我的笔记
        <textarea
          ref="editor"
          :value="annotation?.note ?? ''"
          :maxlength="MAX_NOTE_LENGTH"
          rows="3"
          class="mt-1.5 w-full resize-y rounded-md border border-slate-200 bg-white px-2 py-2 text-sm leading-6 text-slate-700 outline-none focus:border-blue-400"
          placeholder="记录自己的理解、问题或待办…"
          @input="emit('note', ($event.target as HTMLTextAreaElement).value)"
        />
      </label>
      <div class="mt-1 flex items-center justify-between gap-2 text-[10px] text-slate-400">
        <span v-if="status !== 'error'">{{
          status === 'saving'
            ? '正在保存…'
            : status === 'saved'
              ? '已保存到本机'
              : '输入后自动保存到本机'
        }}</span>
        <button
          v-else
          type="button"
          class="flex items-center gap-1 text-red-600"
          @click="emit('retry')"
        >
          <IconRefresh class="h-3 w-3" />保存失败，点击重试
        </button>
        <span>{{ (annotation?.note.length ?? 0).toLocaleString() }} / 20,000</span>
      </div>
    </div>
    <div v-else-if="annotation?.note" class="mt-2 rounded-lg bg-amber-50/60 px-2.5 py-2">
      <div class="mb-1 text-[10px] font-medium text-amber-700">
        我的笔记<span v-if="status === 'error'" class="ml-2 text-red-600">尚未保存</span>
      </div>
      <p class="whitespace-pre-wrap break-words text-xs leading-6 text-slate-600 select-text">
        {{ annotation.note }}
      </p>
    </div>
  </div>
</template>
