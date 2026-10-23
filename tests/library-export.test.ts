import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { exportLibrary, writeLibraryCollection } from '../src/main/library-export'
import { validateLibraryExport, type LibraryExportRequest } from '../src/shared/library-export'
import { importTimeline } from '../src/shared/timeline-import'
import type { HistoryItem } from '../src/shared/history'
import type { ChunkAnnotation } from '../src/shared/annotations'

const subtitle = importTimeline('精确字幕.srt', '1\n00:00:01,250 --> 00:00:04,500\n原文证据\n')
subtitle.chunks[0].userNote = '导入的旧笔记'
subtitle.chunks[0].bookmarked = true
const markdown =
  '## 00:00 - 02:00 | 缓存\n**一句话总结**：减少重复计算\n**原文记录**\n[00:03] 第二份原文\n'
const items: HistoryItem[] = ['one', 'two'].map((id) => ({
  id,
  url: `document:${id}`,
  title: '../同名 [课程] <内容>',
  platform: 'document',
  mode: 'imported',
  createdAt: 1,
  favorited: false
}))
const request: LibraryExportRequest = {
  ids: ['one', 'two'],
  format: 'json',
  includeTranscript: true,
  includeAnnotations: true
}

describe('library collection export', () => {
  let directory: string
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'vidstudio-export-test-'))
  })
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  function dependencies(): Parameters<typeof exportLibrary>[1] {
    return {
      history: async () => structuredClone(items),
      cache: (source: string) => (source === 'document:one' ? JSON.stringify(subtitle) : markdown),
      annotations: (): ChunkAnnotation[] => [],
      chooseDirectory: vi.fn(async (): Promise<string | null> => directory)
    }
  }

  it('exports mixed caches, safe unique filenames, a linked index and reimportable exact times', async () => {
    const result = await exportLibrary(request, dependencies())
    expect(result).toMatchObject({ success: true, count: 2 })
    const files = await readdir(result.path!)
    expect(files).toHaveLength(3)
    expect(files).toContain('目录.md')
    const timelines = files.filter((name) => name.endsWith('.json')).sort()
    expect(timelines[0]).toMatch(/^001-/)
    expect(timelines[1]).toMatch(/^002-/)
    expect(timelines.every((name) => name === basename(name) && !name.includes('..'))).toBe(true)
    const imported = importTimeline(
      timelines[0],
      await readFile(join(result.path!, timelines[0]), 'utf8')
    )
    expect(imported.chunks[0]).toMatchObject({ userNote: '导入的旧笔记', bookmarked: true })
    expect(imported.chunks[0].transcript[0]).toMatchObject({
      seconds: 1.25,
      endSeconds: 4.5,
      text: '原文证据'
    })
    const index = await readFile(join(result.path!, '目录.md'), 'utf8')
    expect(index).toContain(encodeURIComponent(timelines[0]))
    expect(index).toContain('聊天记录')
    const again = await exportLibrary(request, dependencies())
    expect(again.path).not.toBe(result.path)
    expect(await readdir(directory)).toHaveLength(2)
  })

  it('uses current annotations including cleared imported values, and keeps orphan notes separately', async () => {
    const deps = dependencies()
    deps.annotations = (source) =>
      source === 'document:one'
        ? [
            {
              sourceKey: source,
              chunkId: subtitle.chunks[0].id,
              startSeconds: 1.25,
              title: '字幕',
              note: '',
              bookmarked: false,
              updatedAt: 1
            },
            {
              sourceKey: source,
              chunkId: 'old-chapter',
              startSeconds: 30,
              title: '旧版章节',
              note: '不能丢失的旧版笔记',
              bookmarked: true,
              updatedAt: 1
            }
          ]
        : []
    const result = await exportLibrary(request, deps)
    const files = await readdir(result.path!)
    const current = files.find((name) => name.startsWith('001-') && !name.includes('旧版笔记'))!
    const imported = importTimeline(current, await readFile(join(result.path!, current), 'utf8'))
    expect(imported.chunks[0].userNote).toBe('')
    expect(imported.chunks[0].bookmarked).toBe(false)
    const old = files.find((name) => name.endsWith('.旧版笔记.json'))!
    expect(JSON.parse(await readFile(join(result.path!, old), 'utf8'))[0].note).toBe(
      '不能丢失的旧版笔记'
    )
  })

  it('exports readable Markdown and honors privacy options for imported and stored notes', async () => {
    const deps = dependencies()
    deps.annotations = () => {
      throw new Error('Annotations must not be read when excluded')
    }
    const result = await exportLibrary(
      { ...request, format: 'markdown', includeTranscript: false, includeAnnotations: false },
      deps
    )
    const files = (await readdir(result.path!)).filter((name) => name !== '目录.md')
    expect(files).toHaveLength(2)
    for (const file of files) {
      const text = await readFile(join(result.path!, file), 'utf8')
      const document = importTimeline(file, text)
      expect(document.chunks).toHaveLength(1)
      expect(document.chunks[0].transcript).toEqual([])
      expect(text).not.toContain('导入的旧笔记')
      expect(text).not.toContain('片段收藏')
    }
  })

  it('canceling the native folder picker writes nothing', async () => {
    const deps = dependencies()
    deps.chooseDirectory = async () => null
    expect(await exportLibrary(request, deps)).toEqual({ success: false, canceled: true })
    expect(await readdir(directory)).toEqual([])
  })

  it('writes long multilingual titles and old-note sidecars within portable filename limits', async () => {
    const deps = dependencies()
    deps.history = async () =>
      items.map((item, index) => ({
        ...item,
        title: index ? '中文课程'.repeat(40) : 'A' + '😀'.repeat(40)
      }))
    deps.annotations = (source) => [
      {
        sourceKey: source,
        chunkId: 'orphan',
        startSeconds: 0,
        title: '旧版',
        note: '保留',
        bookmarked: false,
        updatedAt: 1
      }
    ]
    const result = await exportLibrary(request, deps)
    expect(result.success, result.error).toBe(true)
    const files = await readdir(result.path!)
    expect(files).toHaveLength(5)
    expect(files.filter((file) => file.endsWith('.旧版笔记.json'))).toHaveLength(2)
    for (const file of files) {
      expect(Buffer.byteLength(file)).toBeLessThanOrEqual(255)
      expect(() => encodeURIComponent(file)).not.toThrow()
    }
  })

  it.each(['missing', 'broken', 'removed'])(
    'fails the whole selection before choosing a folder for %s sources',
    async (kind) => {
      const deps = dependencies()
      if (kind === 'removed') deps.history = async () => [items[0]]
      else
        deps.cache = (source) =>
          source === 'document:one' ? JSON.stringify(subtitle) : kind === 'missing' ? '' : '{broken'
      const result = await exportLibrary(request, deps)
      expect(result.success).toBe(false)
      expect(result.error).toBeTruthy()
      expect(deps.chooseDirectory).not.toHaveBeenCalled()
      expect(await readdir(directory)).toEqual([])
    }
  )

  it('rolls back a partial disk write without touching existing files', async () => {
    await writeFile(join(directory, 'keep.md'), 'existing')
    let calls = 0
    await expect(
      writeLibraryCollection(
        directory,
        [
          { name: 'one.md', content: 'one' },
          { name: 'two.md', content: 'two' }
        ],
        async (path, text) => {
          if (++calls === 2) throw new Error('disk full')
          await writeFile(path, text)
        }
      )
    ).rejects.toThrow('disk full')
    expect(await readdir(directory)).toEqual(['keep.md'])
    expect(await readFile(join(directory, 'keep.md'), 'utf8')).toBe('existing')
  })

  it('rejects empty, duplicate, oversized and malformed IPC requests', () => {
    for (const ids of [[], ['one', 'one'], Array.from({ length: 201 }, (_, n) => String(n))])
      expect(() => validateLibraryExport({ ...request, ids })).toThrow()
    expect(() =>
      validateLibraryExport({ ...request, format: 'pdf' } as unknown as LibraryExportRequest)
    ).toThrow()
    expect(() =>
      validateLibraryExport({
        ...request,
        includeAnnotations: undefined
      } as unknown as LibraryExportRequest)
    ).toThrow()
  })
})
