import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { HistoryStore } from '../src/main/history-store'
import type { HistoryItem } from '../src/shared/history'

let directory: string
let file: string
let store: HistoryStore
const entry = (url: string): Omit<HistoryItem, 'id' | 'createdAt'> => ({
  url,
  title: '第一章',
  platform: 'bilibili',
  mode: 'asr',
  favorited: false
})

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vidstudio-history-'))
  file = path.join(directory, 'data', 'history.json')
  store = new HistoryStore(file)
})
afterEach(() => fs.rm(directory, { recursive: true, force: true }))

describe('history persistence', () => {
  it('serializes concurrent writes and retains more than 50 records across restart', async () => {
    await Promise.all(Array.from({ length: 65 }, (_, i) => store.add(entry(`video:${i}`))))
    const saved = await new HistoryStore(file).list()
    expect(saved).toHaveLength(65)
    expect(new Set(saved.map((item) => item.url)).size).toBe(65)
    expect((await fs.readdir(path.dirname(file))).sort()).toEqual([
      'history.json',
      'history.json.bak'
    ])
  })

  it('keeps stable identifiers, user titles and favorites when parsing again', async () => {
    await store.add(entry('video:1'))
    const original = (await store.list())[0]
    await Promise.all([
      store.rename(original.id, '我自己的标题'),
      store.toggleFavorite(original.id),
      store.add({ ...entry('video:1'), mode: 'visual' })
    ])
    expect(await store.list()).toEqual([
      { ...original, title: '我自己的标题', favorited: true, mode: 'visual' }
    ])
  })

  it('preserves corrupt files and the last good backup, then allows recovery', async () => {
    await store.add(entry('video:1'))
    await store.add(entry('video:2'))
    const backup = await fs.readFile(`${file}.bak`, 'utf8')
    await fs.writeFile(file, '{broken')
    await expect(store.list()).rejects.toThrow('损坏')
    await expect(store.add(entry('video:3'))).rejects.toThrow('损坏')
    expect(await fs.readFile(file, 'utf8')).toBe('{broken')
    expect(await fs.readFile(`${file}.bak`, 'utf8')).toBe(backup)
    await fs.writeFile(file, backup)
    await store.add(entry('video:3'))
    expect((await store.list()).map((item) => item.url)).toEqual(['video:3', 'video:1'])
  })

  it('rejects wrong-shaped data without replacing it or removing other records', async () => {
    await store.add(entry('video:1'))
    await store.remove('missing')
    expect(await store.list()).toHaveLength(1)
    await expect(store.rename('missing', '  ')).rejects.toThrow('标题')
    await fs.writeFile(file, '[{"url":"video:1"}]')
    await expect(store.remove('any')).rejects.toThrow('损坏')
    expect(await fs.readFile(file, 'utf8')).toBe('[{"url":"video:1"}]')
  })
})
