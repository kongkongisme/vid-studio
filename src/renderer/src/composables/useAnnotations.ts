import { ref, watch, type Ref } from 'vue'
import type { AnnotationInput, ChunkAnnotation } from '../../../shared/annotations'
import type { TimelineChunk } from '../../../shared/timeline'

type SaveStatus = 'saving' | 'saved' | 'error'
interface AnnotationApi {
  getAnnotations: (sourceKey: string) => Promise<ChunkAnnotation[]>
  saveAnnotation: (input: AnnotationInput) => Promise<ChunkAnnotation>
}

export interface AnnotationState {
  annotations: Ref<Map<string, ChunkAnnotation>>
  statuses: Ref<Map<string, SaveStatus>>
  loading: Ref<boolean>
  loadError: Ref<string>
  saveError: Ref<string>
  load: () => Promise<void>
  update: (chunk: TimelineChunk, patch: { note?: string; bookmarked?: boolean }) => Promise<void>
}

export function useAnnotations(
  source: Ref<string>,
  api: AnnotationApi,
  chunks: Ref<TimelineChunk[]> = ref([])
): AnnotationState {
  const annotations = ref(new Map<string, ChunkAnnotation>())
  const statuses = ref(new Map<string, SaveStatus>())
  const loading = ref(false)
  const loadError = ref('')
  const saveError = ref('')
  const drafts = new Map<string, Map<string, ChunkAnnotation>>()
  const revisions = new Map<string, Map<string, symbol>>()
  const pending = new Map<string, Set<Promise<void>>>()
  let generation = 0

  async function load(): Promise<void> {
    const key = source.value
    const ticket = ++generation
    annotations.value = new Map()
    statuses.value = new Map()
    loadError.value = ''
    saveError.value = ''
    if (!key) {
      loading.value = false
      return
    }
    loading.value = true
    try {
      await Promise.allSettled([...(pending.get(key) ?? [])])
      const saved = await api.getAnnotations(key)
      if (source.value !== key || ticket !== generation) return
      annotations.value = new Map(saved.map((annotation) => [annotation.chunkId, annotation]))
      for (const [id, draft] of drafts.get(key) ?? []) {
        annotations.value.set(id, draft)
        statuses.value.set(id, 'error')
      }
    } catch (error) {
      if (ticket === generation) loadError.value = `无法读取个人笔记：${String(error)}`
    } finally {
      if (ticket === generation) loading.value = false
    }
    if (ticket !== generation || loadError.value) return
    for (const chunk of chunks.value) {
      if (ticket !== generation || source.value !== key) break
      if (!annotations.value.has(chunk.id) && (chunk.userNote || chunk.bookmarked)) {
        await update(chunk, { note: chunk.userNote ?? '', bookmarked: chunk.bookmarked ?? false })
      }
    }
  }

  async function update(
    chunk: TimelineChunk,
    patch: { note?: string; bookmarked?: boolean }
  ): Promise<void> {
    const key = source.value
    if (!key || loading.value || loadError.value) return
    const previous = annotations.value.get(chunk.id)
    const draft: ChunkAnnotation = {
      sourceKey: key,
      chunkId: chunk.id,
      startSeconds: chunk.startSeconds,
      title: chunk.title,
      note: previous?.note ?? '',
      bookmarked: previous?.bookmarked ?? false,
      updatedAt: Date.now(),
      ...patch
    }
    const token = Symbol()
    const sourceRevisions = revisions.get(key) ?? new Map<string, symbol>()
    sourceRevisions.set(chunk.id, token)
    revisions.set(key, sourceRevisions)
    const sourceDrafts = drafts.get(key) ?? new Map<string, ChunkAnnotation>()
    sourceDrafts.set(chunk.id, draft)
    drafts.set(key, sourceDrafts)
    annotations.value.set(chunk.id, draft)
    statuses.value.set(chunk.id, 'saving')
    saveError.value = ''
    const writes = pending.get(key) ?? new Set<Promise<void>>()
    pending.set(key, writes)
    const operation = (async (): Promise<void> => {
      try {
        const saved = await api.saveAnnotation(draft)
        if (sourceRevisions.get(chunk.id) !== token) return
        sourceDrafts.delete(chunk.id)
        if (source.value === key) {
          annotations.value.set(chunk.id, saved)
          statuses.value.set(chunk.id, 'saved')
        }
      } catch (error) {
        if (sourceRevisions.get(chunk.id) === token && source.value === key) {
          statuses.value.set(chunk.id, 'error')
          saveError.value = String(error)
        }
      }
    })()
    writes.add(operation)
    await operation
    writes.delete(operation)
  }

  watch(source, load, { immediate: true })
  return { annotations, statuses, loading, loadError, saveError, load, update }
}
