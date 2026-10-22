import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { effectScope, nextTick, ref, type EffectScope, type Ref } from 'vue'
import {
  useAnnotations,
  type AnnotationState
} from '../src/renderer/src/composables/useAnnotations'
import type { AnnotationInput, ChunkAnnotation } from '../src/shared/annotations'
import type { TimelineChunk } from '../src/shared/timeline'

const chunk: TimelineChunk = {
  id: 'chapter',
  startTime: '00:00',
  endTime: '01:00',
  startSeconds: 0,
  endSeconds: 60,
  title: '章节',
  summary: '',
  keyPoints: [],
  tags: [],
  transcript: []
}
const scopes: EffectScope[] = []
afterEach(() => scopes.splice(0).forEach((scope) => scope.stop()))

interface TestSetup {
  source: Ref<string>
  storage: Map<string, ChunkAnnotation[]>
  api: {
    getAnnotations: Mock<(key: string) => Promise<ChunkAnnotation[]>>
    saveAnnotation: Mock<(input: AnnotationInput) => Promise<ChunkAnnotation>>
  }
  state: AnnotationState
  select: (key: string) => Promise<void>
}

function setup(chunks: TimelineChunk[] = [chunk]): TestSetup {
  const source = ref('')
  const storage = new Map<string, ChunkAnnotation[]>()
  const api = {
    getAnnotations: vi.fn(async (key: string) => storage.get(key) ?? []),
    saveAnnotation: vi.fn(async (input: AnnotationInput) => {
      const saved = { ...input, updatedAt: Date.now() }
      storage.set(input.sourceKey, [
        ...(storage.get(input.sourceKey) ?? []).filter((note) => note.chunkId !== input.chunkId),
        saved
      ])
      return saved
    })
  }
  const scope = effectScope()
  scopes.push(scope)
  const state = scope.run(() => useAnnotations(source, api, ref(chunks)))!
  async function select(key: string): Promise<void> {
    source.value = key
    await nextTick()
    await vi.waitFor(() => expect(state.loading.value).toBe(false))
  }
  return { source, storage, api, state, select }
}

describe('annotation state across source changes', () => {
  it('captures the source when saving so delayed writes cannot affect another document', async () => {
    const { state, api, select } = setup()
    await select('a')
    let finish!: () => void
    api.saveAnnotation.mockImplementationOnce(
      (input) =>
        new Promise((resolve) => {
          finish = () => resolve({ ...input, updatedAt: 1 })
        })
    )
    const saving = state.update(chunk, { note: '属于 A 的笔记' })
    await select('b')
    finish()
    await saving
    expect(api.saveAnnotation.mock.calls[0][0].sourceKey).toBe('a')
    expect(state.annotations.value.size).toBe(0)
  })

  it('retains failed drafts across navigation and supports retry', async () => {
    const { state, api, select } = setup()
    await select('a')
    api.saveAnnotation.mockRejectedValueOnce(new Error('disk full'))
    await state.update(chunk, { note: '还没保存的想法' })
    expect(state.statuses.value.get(chunk.id)).toBe('error')
    await select('b')
    await select('a')
    expect(state.annotations.value.get(chunk.id)?.note).toBe('还没保存的想法')
    await state.update(chunk, {})
    expect(state.statuses.value.get(chunk.id)).toBe('saved')
  })

  it('does not restore imported notes after the user explicitly clears them', async () => {
    const { state, api, select } = setup([
      { ...chunk, userNote: '随文件导入的笔记', bookmarked: true }
    ])
    await select('a')
    await vi.waitFor(() => expect(api.saveAnnotation).toHaveBeenCalledTimes(1))
    await state.update(chunk, { note: '', bookmarked: false })
    await state.load()
    expect(state.annotations.value.get(chunk.id)).toMatchObject({ note: '', bookmarked: false })
    expect(api.saveAnnotation).toHaveBeenCalledTimes(2)
  })

  it('ignores a delayed load response after changing sources', async () => {
    const { state, source, api, select } = setup()
    let finish!: (rows: ChunkAnnotation[]) => void
    api.getAnnotations.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    source.value = 'a'
    await nextTick()
    await vi.waitFor(() => expect(api.getAnnotations).toHaveBeenCalledTimes(1))
    await select('b')
    finish([
      {
        sourceKey: 'a',
        chunkId: chunk.id,
        startSeconds: 0,
        title: 'A',
        note: '旧请求',
        bookmarked: true,
        updatedAt: 1
      }
    ])
    await nextTick()
    expect(state.annotations.value.size).toBe(0)
  })
})
