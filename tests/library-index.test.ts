import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { LibraryIndex } from '../src/main/library-index'
import { AnnotationStore } from '../src/main/annotation-store'
import type { HistoryItem } from '../src/shared/history'
import type { TimelineChunk } from '../src/shared/timeline'

let db: DatabaseSync
let library: LibraryIndex
let notes: AnnotationStore
let version = 0
const source = (url: string, title = '学习资料'): HistoryItem => ({
  id: url,
  url,
  title,
  platform: 'document',
  mode: 'imported',
  favorited: false,
  createdAt: 1
})
const chunk = (id = 'chapter-1'): TimelineChunk => ({
  id,
  title: '第一节',
  startTime: '00:00',
  endTime: '02:00',
  startSeconds: 0,
  endSeconds: 120,
  summary: '知识的结构',
  keyPoints: ['低成本处理'],
  tags: ['学习'],
  transcript: [
    { time: '00:32', seconds: 32.125, endSeconds: 35.75, text: '深度学习需要可复用的原文证据。' }
  ]
})
function cache(url: string, chunks = [chunk()]): void {
  db.prepare('INSERT OR REPLACE INTO video_cache VALUES (?, ?, ?)').run(
    url,
    JSON.stringify({
      type: 'vidstudio-timeline',
      version: 1,
      title: '学习资料',
      chunks
    }),
    ++version
  )
}
function annotate(sourceKey: string, note: string, chunkId = 'chapter-1'): void {
  notes.save({
    sourceKey,
    chunkId,
    note,
    title: '记下来的片段',
    startSeconds: 32.125,
    bookmarked: false
  })
}

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE video_cache (url TEXT PRIMARY KEY, content TEXT, cached_at INTEGER)')
  notes = new AnnotationStore(db)
  library = new LibraryIndex(db)
})
afterEach(() => db.close())

describe('local library search', () => {
  it('migrates old caches on demand and finds Chinese passages with exact timestamps', async () => {
    cache('a')
    const result = await library.search([source('a')], { query: '复用' })
    expect(result.total).toBe(1)
    expect(result.entries[0].matches[0]).toMatchObject({
      chunkId: 'chapter-1',
      kind: 'transcript',
      startSeconds: 32.125,
      excerpt: '深度学习需要可复用的原文证据。'
    })
    expect(
      (await library.search([source('a')], { query: '低成本' })).entries[0].matches[0].kind
    ).toBe('summary')
    expect(
      (await library.search([source('a')], { query: '第一节' })).entries[0].matches[0].kind
    ).toBe('title')
  })

  it('updates personal notes immediately and respects explicitly cleared imported notes', async () => {
    cache('a', [{ ...chunk(), userNote: '原来的笔记' }])
    expect((await library.search([source('a')], { query: '原来' })).total).toBe(1)
    annotate('a', '')
    expect((await library.search([source('a')], { query: '原来' })).total).toBe(0)
    annotate('a', '新的 ÄÖÜ 复习计划')
    expect((await library.search([source('a')], { query: 'äöü' })).entries[0].matches[0].kind).toBe(
      'note'
    )
    cache('b')
    expect((await library.search([source('b')], { query: '复习计划' })).total).toBe(0)
  })

  it('replaces stale index rows and keeps old-version personal notes discoverable', async () => {
    cache('a')
    await library.search([source('a')], { query: '原文证据' })
    annotate('a', '重新复习这里')
    cache('a', [{ ...chunk('replacement'), transcript: [], summary: '更新结果' }])
    expect((await library.search([source('a')], { query: '原文证据' })).total).toBe(0)
    const result = await library.search([source('a')], { query: '重新复习' })
    expect(result.entries[0].matches[0]).toMatchObject({
      kind: 'legacy-note',
      chunkId: 'chapter-1'
    })
  })

  it('treats wildcard/SQL-looking queries literally and never surfaces orphan caches', async () => {
    cache('a', [{ ...chunk(), summary: "学习 100% 的内容，_ 和 ' 是普通文字" }])
    cache('orphan')
    expect((await library.search([source('a')], { query: '%' })).total).toBe(1)
    expect((await library.search([source('a')], { query: "' OR 1=1 --" })).total).toBe(0)
    expect((await library.search([], { query: '学习' })).total).toBe(0)
    expect((await library.search([source('a')], { query: '' })).total).toBe(1)
  })

  it('preserves uncached titles, filters favorites and paginates beyond 50 records', async () => {
    const history = Array.from({ length: 62 }, (_, i) => ({
      ...source(`doc:${i}`),
      favorited: i % 2 === 0
    }))
    const first = await library.search(history, { query: '' })
    expect(first.entries).toHaveLength(50)
    expect(first.total).toBe(62)
    expect(first.unavailableSources).toBe(62)
    expect(first.entries[0].cached).toBe(false)
    const next = await library.search(history, { query: '', offset: 50 })
    expect(next.entries).toHaveLength(12)
    expect(next.entries[0].item.url).toBe('doc:50')
    expect((await library.search(history, { query: '', favoritesOnly: true })).total).toBe(31)
    expect((await library.search(history, { query: 'doc:61' })).total).toBe(1)
  })

  it('isolates corrupt content and reports bounded per-source previews', async () => {
    db.prepare('INSERT INTO video_cache VALUES (?, ?, ?)').run('broken', '{broken', 1)
    cache(
      'a',
      Array.from({ length: 8 }, (_, i) => chunk(`chapter-${i}`))
    )
    const result = await library.search([source('broken'), source('a')], { query: '原文证据' })
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].matches).toHaveLength(3)
    expect(result.entries[0].moreMatches).toBe(true)
    expect(result.unavailableSources).toBe(1)
    await expect(library.search([], { query: 'x'.repeat(201) })).rejects.toThrow('200')
  })
})
