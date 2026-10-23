<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { IconLink } from '@tabler/icons-vue'
import { sourceTimestampUrl } from '../../../shared/source-links'

const props = defineProps<{ sourceUrl?: string; seconds: number }>()
const url = computed(() => sourceTimestampUrl(props.sourceUrl, props.seconds))
const status = ref<'idle' | 'copying' | 'copied' | 'error'>('idle')
let reset: ReturnType<typeof setTimeout> | undefined
watch(url, () => {
  clearTimeout(reset)
  status.value = 'idle'
})
onUnmounted(() => clearTimeout(reset))

async function copy(): Promise<void> {
  const target = url.value
  if (!target || status.value === 'copying') return
  clearTimeout(reset)
  status.value = 'copying'
  try {
    await navigator.clipboard.writeText(target)
    if (target !== url.value) return
    status.value = 'copied'
    reset = setTimeout(() => {
      status.value = 'idle'
    }, 2500)
  } catch {
    if (target === url.value) status.value = 'error'
  }
}
</script>

<template>
  <span v-if="url" class="inline-flex flex-col items-start">
    <button
      type="button"
      aria-label="复制原视频链接"
      title="复制含当前片段时间戳的原视频链接"
      class="flex min-h-9 items-center gap-1 rounded px-1 text-slate-400 hover:text-blue-600 focus-visible:outline-2 focus-visible:outline-blue-500 disabled:opacity-50"
      :disabled="status === 'copying'"
      @click.stop="copy"
    >
      <IconLink class="h-3.5 w-3.5" />{{ status === 'copied' ? '已复制' : '复制链接' }}
    </button>
    <span v-if="status === 'error'" role="alert" class="text-xs text-red-600"
      >复制失败，请重试</span
    >
    <span v-if="status === 'copied'" role="status" class="sr-only">原视频时间戳链接已复制</span>
  </span>
</template>
