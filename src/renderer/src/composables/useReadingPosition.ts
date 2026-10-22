import { ref, type Ref } from 'vue'
import {
  findReadingChunk,
  type ReadingPosition,
  type ReadingPositionInput
} from '../../../shared/reading-position'
import type { TimelineChunk } from '../../../shared/timeline'

interface ReadingApi {
  getReadingPosition: (key: string) => Promise<ReadingPosition | null>
  saveReadingPosition: (input: ReadingPositionInput) => Promise<ReadingPosition>
}

export interface ReadingPositionState {
  status: Ref<string>
  error: Ref<string>
  restored: Ref<boolean>
  load: (key: string, chunks: TimelineChunk[]) => Promise<void>
  select: (chunk: TimelineChunk, seconds?: number) => void
  reset: () => void
  retry: () => Promise<void>
}

/** Explicit navigation wins over a late restore. Saves retain their original source. */
export function useReadingPosition(
  sourceKey: Ref<string>,
  activeId: Ref<string>,
  focusSeconds: Ref<number | null>,
  api: ReadingApi
): ReadingPositionState {
  const status = ref('')
  const error = ref('')
  const restored = ref(false)
  let revision = 0
  let pending: ReadingPositionInput | null = null
  let lastLoad: { key: string; chunks: TimelineChunk[] } | null = null
  let saving = Promise.resolve()

  function reset(): void {
    revision++
    status.value = ''
    error.value = ''
    restored.value = false
    pending = null
    lastLoad = null
  }

  async function load(key: string, chunks: TimelineChunk[]): Promise<void> {
    reset()
    lastLoad = { key, chunks }
    const request = revision
    try {
      const position = await api.getReadingPosition(key)
      if (
        request !== revision ||
        sourceKey.value !== key ||
        !position ||
        position.sourceKey !== key
      )
        return
      const chunk = findReadingChunk(position, chunks)
      if (!chunk) return
      activeId.value = chunk.id
      focusSeconds.value = Math.min(
        chunk.endSeconds,
        Math.max(chunk.startSeconds, position.seconds)
      )
      restored.value = true
      status.value = '已回到上次阅读位置'
    } catch {
      if (request === revision && sourceKey.value === key) error.value = '无法读取上次阅读位置'
    }
  }

  async function save(input: ReadingPositionInput, request: number): Promise<void> {
    try {
      await api.saveReadingPosition(input)
      if (sourceKey.value !== input.sourceKey || request !== revision) return
      pending = null
      status.value = '阅读位置已保存'
      error.value = ''
    } catch {
      if (sourceKey.value !== input.sourceKey || request !== revision) return
      error.value = '阅读位置未保存，可重试'
      status.value = ''
    }
  }

  function select(chunk: TimelineChunk, seconds = chunk.startSeconds): void {
    revision++
    activeId.value = chunk.id
    focusSeconds.value = Math.min(chunk.endSeconds, Math.max(chunk.startSeconds, seconds))
    restored.value = false
    error.value = ''
    if (!sourceKey.value) return
    const input = { sourceKey: sourceKey.value, chunkId: chunk.id, seconds: focusSeconds.value }
    const request = revision
    pending = input
    status.value = '正在保存阅读位置…'
    saving = saving.then(() => save(input, request))
  }

  async function retry(): Promise<void> {
    if (!pending && lastLoad?.key === sourceKey.value) {
      await load(lastLoad.key, lastLoad.chunks)
      return
    }
    if (!pending || pending.sourceKey !== sourceKey.value) return
    const input = pending
    const request = revision
    status.value = '正在保存阅读位置…'
    error.value = ''
    saving = saving.then(() => save(input, request))
    await saving
  }

  return { status, error, restored, load, select, reset, retry }
}
