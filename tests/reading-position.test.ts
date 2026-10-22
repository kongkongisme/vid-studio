import { describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { ref } from 'vue'
import { ReadingStore } from '../src/main/reading-store'
import { useReadingPosition } from '../src/renderer/src/composables/useReadingPosition'
import type { ReadingPosition, ReadingPositionInput } from '../src/shared/reading-position'
import type { TimelineChunk } from '../src/shared/timeline'

const chunks: TimelineChunk[] = [0, 1].map((index) => ({
  id: `chapter-${index}`,
  startTime: `0${index}:00`,
  endTime: `0${index + 1}:00`,
  startSeconds: index * 60,
  endSeconds: (index + 1) * 60,
  title: `章节 ${index + 1}`,
  summary: '',
  keyPoints: [],
  tags: [],
  transcript: []
}))
const position: ReadingPosition = {
  sourceKey: 'a',
  chunkId: 'chapter-1',
  seconds: 75.125,
  updatedAt: 1
}

function setup(): {
  source: ReturnType<typeof ref<string>>
  active: ReturnType<typeof ref<string>>
  seconds: ReturnType<typeof ref<number | null>>
  api: {
    getReadingPosition: ReturnType<typeof vi.fn<(key: string) => Promise<ReadingPosition | null>>>
    saveReadingPosition: ReturnType<
      typeof vi.fn<(input: ReadingPositionInput) => Promise<ReadingPosition>>
    >
  }
  state: ReturnType<typeof useReadingPosition>
} {
  const source = ref('a')
  const active = ref(chunks[0].id)
  const seconds = ref<number | null>(null)
  const api = {
    getReadingPosition: vi.fn(async (key: string): Promise<ReadingPosition | null> => ({
      ...position,
      sourceKey: key
    })),
    saveReadingPosition: vi.fn(async (input: ReadingPositionInput): Promise<ReadingPosition> => ({
      ...input,
      updatedAt: 2
    }))
  }
  return { source, active, seconds, api, state: useReadingPosition(source, active, seconds, api) }
}

describe('reading position persistence', () => {
  it('keeps one exact position per source, updates it and validates IPC input', () => {
    const db = new DatabaseSync(':memory:')
    try {
      const store = new ReadingStore(db)
      expect(store.load('a')).toBeNull()
      store.save(position)
      store.save({ ...position, sourceKey: "b'", seconds: 9.25 })
      expect(store.load('a')).toMatchObject({ seconds: 75.125 })
      store.save({ ...position, seconds: 80 })
      expect(store.load('a')?.seconds).toBe(80)
      expect(store.load("b'")?.seconds).toBe(9.25)
      expect(() => store.save({ ...position, seconds: NaN })).toThrow('阅读时间无效')
      expect(() => store.save({ ...position, sourceKey: '' })).toThrow('资料标识无效')
      expect(() => store.save({ ...position, chunkId: 'x'.repeat(501) })).toThrow('片段标识无效')
    } finally {
      db.close()
    }
  })

  it('restores exact sentence time and falls back to time when chapter IDs have changed', async () => {
    const { state, active, seconds, api } = setup()
    await state.load('a', chunks)
    expect(active.value).toBe('chapter-1')
    expect(seconds.value).toBe(75.125)
    expect(api.saveReadingPosition).not.toHaveBeenCalled()
    api.getReadingPosition.mockResolvedValue({ ...position, chunkId: 'old-id' })
    await state.load('a', chunks)
    expect(active.value).toBe('chapter-1')
  })

  it('never replaces an explicit search or reader selection with a late restore', async () => {
    const { state, active, seconds, api } = setup()
    let finish!: (value: ReadingPosition) => void
    api.getReadingPosition.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    const loading = state.load('a', chunks)
    state.select(chunks[0], 8.25)
    finish(position)
    await loading
    expect(active.value).toBe('chapter-0')
    expect(seconds.value).toBe(8.25)
    await vi.waitFor(() => expect(state.status.value).toBe('阅读位置已保存'))
    expect(api.saveReadingPosition).toHaveBeenCalledWith({
      sourceKey: 'a',
      chunkId: 'chapter-0',
      seconds: 8.25
    })
  })

  it('ignores a late restore after switching sources, and binds writes to the original source', async () => {
    const { state, source, active, api } = setup()
    let finish!: (value: ReadingPosition) => void
    api.getReadingPosition.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    const loading = state.load('a', chunks)
    state.select(chunks[1])
    source.value = 'b'
    active.value = chunks[0].id
    state.reset()
    finish(position)
    await loading
    expect(active.value).toBe('chapter-0')
    expect(state.status.value).toBe('')
    expect(api.saveReadingPosition).toHaveBeenCalledWith({
      sourceKey: 'a',
      chunkId: 'chapter-1',
      seconds: 60
    })
  })

  it('allows retrying a failed save and starting over without restoring an old position', async () => {
    const { state, active, seconds, api } = setup()
    api.saveReadingPosition.mockRejectedValueOnce(new Error('disk full'))
    state.select(chunks[1], 75.125)
    await vi.waitFor(() => expect(state.error.value).toContain('未保存'))
    await state.retry()
    expect(state.error.value).toBe('')
    state.select(chunks[0])
    expect(active.value).toBe('chapter-0')
    expect(seconds.value).toBe(0)
    await vi.waitFor(() =>
      expect(api.saveReadingPosition).toHaveBeenLastCalledWith({
        sourceKey: 'a',
        chunkId: 'chapter-0',
        seconds: 0
      })
    )
  })

  it('retries a failed load without writing a guessed position', async () => {
    const { state, active, api } = setup()
    api.getReadingPosition.mockRejectedValueOnce(new Error('read failed'))
    await state.load('a', chunks)
    expect(state.error.value).toContain('无法读取')
    await state.retry()
    expect(state.error.value).toBe('')
    expect(active.value).toBe('chapter-1')
    expect(api.saveReadingPosition).not.toHaveBeenCalled()
  })
})
