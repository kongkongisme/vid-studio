import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { AnnotationStore } from '../src/main/annotation-store'
import type { AnnotationInput } from '../src/shared/annotations'

let db: DatabaseSync
let store: AnnotationStore
const note: AnnotationInput = {
  sourceKey: 'video:a',
  chunkId: '00:00-01:00',
  startSeconds: 0,
  title: '第一章',
  bookmarked: false,
  note: '需要再读一遍'
}

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  store = new AnnotationStore(db)
})
afterEach(() => db.close())

describe('personal annotation persistence', () => {
  it('keeps multiple sources separate and updates in place', () => {
    store.save(note)
    store.save({ ...note, sourceKey: 'video:b', note: '另一段资料' })
    store.save({ ...note, note: '更新后的理解', bookmarked: true })
    expect(store.list('video:a')).toHaveLength(1)
    expect(store.list('video:a')[0]).toMatchObject({ note: '更新后的理解', bookmarked: true })
    expect(store.list('video:b')[0].note).toBe('另一段资料')
  })

  it('keeps notes when removing a bookmark and remembers explicit clearing', () => {
    store.save({ ...note, bookmarked: true })
    store.save(note)
    expect(store.list(note.sourceKey)[0].note).toBe(note.note)
    store.save({ ...note, note: '', bookmarked: true })
    expect(store.list(note.sourceKey)).toHaveLength(1)
    store.save({ ...note, note: '', bookmarked: false })
    expect(store.list(note.sourceKey)[0]).toMatchObject({ note: '', bookmarked: false })
  })

  it('preserves old chapter references when analysis chunks change', () => {
    store.save(note)
    store.save({ ...note, chunkId: '00:00-02:00', title: '新划分' })
    expect(store.list(note.sourceKey).map((item) => item.title)).toEqual(['第一章', '新划分'])
  })

  it('treats SQL syntax as data and rejects invalid input before writing', () => {
    store.save({
      ...note,
      sourceKey: "a'; DROP TABLE chunk_annotations; --",
      note: '<script>alert(1)</script>'
    })
    expect(store.list("a'; DROP TABLE chunk_annotations; --")[0].note).toContain('<script>')
    expect(() => store.save({ ...note, note: 'x'.repeat(20001) })).toThrow('20,000')
    expect(() => store.save({ ...note, startSeconds: NaN })).toThrow('时间')
    expect(store.list(note.sourceKey)).toEqual([])
  })
})
