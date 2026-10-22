import { describe, expect, it } from 'vitest'
import { documentCacheKey, importTimeline, MAX_IMPORT_BYTES } from '../src/shared/timeline-import'
import { buildTextExport } from '../src/shared/timeline-formats'
import type { TimelineExportPayload } from '../src/shared/export'

const srt =
  '\uFEFF1\r\n00:00:01,125 --> 00:00:03,750\r\n第一行\r\n第二行\r\n\r\n2\r\n00:02:05,500 --> 00:02:08,900\r\n另一片段\r\n'

describe('subtitle import', () => {
  it('reads BOM, CRLF, multiline SRT, and exact millisecond timing', () => {
    const document = importTimeline('课程.SRT', srt)
    expect(document).toMatchObject({ title: '课程', sourceKind: 'subtitle' })
    expect(document.chunks).toHaveLength(2)
    expect(document.chunks[0].summary).toBe('')
    expect(document.chunks[0].transcript[0]).toMatchObject({
      seconds: 1.125,
      endSeconds: 3.75,
      text: '第一行\n第二行'
    })
  })

  it('reads WebVTT cue identifiers/settings and ignores note and style blocks', () => {
    const input =
      'WEBVTT\n\nNOTE note\n00:00.000 --> 00:03.000\nfake\n\nSTYLE\n::cue { color:red }\n\ncue-1\n00:01.500 --> 00:02.250 align:start\n<v Alice><b>Hello</b> &amp; welcome</v>\n\ncue-2\n00:02.000 --> 00:03.500\n<c.yellow>重叠</c>'
    const document = importTimeline('lesson.vtt', input)
    expect(document.chunks[0].transcript).toHaveLength(2)
    expect(document.chunks[0].transcript[0].text).toBe('Alice：Hello & welcome')
    expect(document.warnings.join('')).toContain('重叠')
  })

  it('sorts unordered cues, skips invalid intervals with a visible warning', () => {
    const input =
      '1\n00:00:05,000 --> 00:00:07,000\nlater\n\n2\n00:00:01,000 --> 00:00:02,000\nearly\n\n3\n00:00:99,000 --> 00:00:01,000\nbad\n\n4\n00:00:03,000 --> 00:00:03,000\nzero'
    const document = importTimeline('test.srt', input)
    expect(document.chunks[0].transcript.map((cue) => cue.text)).toEqual(['early', 'later'])
    expect(document.warnings[0]).toContain('2 条')
  })

  it('decodes numeric entities without interpreting escaped HTML as markup', () => {
    const document = importTimeline(
      'test.srt',
      '1\n00:00:01,000 --> 00:00:02,000\n&lt;script&gt; &#x1F600; &#20013; &#99999999;'
    )
    expect(document.chunks[0].transcript[0].text).toBe('<script> 😀 中 &#99999999;')
  })

  it('rejects empty, binary, oversized, and unsupported files without inventing content', () => {
    expect(() => importTimeline('test.srt', '')).toThrow('有效字幕')
    expect(() => importTimeline('test.srt', '\0bad')).toThrow('编码')
    expect(() => importTimeline('test.md', 'x'.repeat(MAX_IMPORT_BYTES + 1))).toThrow('10 MB')
    expect(() => importTimeline('test.txt', 'hello')).toThrow('支持导入')
    expect(() => importTimeline('test.md', '# 普通笔记')).toThrow('时间轴章节')
  })

  it('keeps exact cue times through JSON save/load and SRT export', () => {
    const document = importTimeline('课程.srt', srt)
    const restored = importTimeline('cached.json', JSON.stringify(document))
    expect(restored.chunks[0].id).toBe(document.chunks[0].id)
    expect(restored.chunks[0].startSeconds).toBe(1.125)
    const payload: TimelineExportPayload = {
      ...restored,
      modeLabel: '导入',
      exportedAt: '',
      includeTranscript: true,
      llmProvider: 'deepseek'
    }
    const exported = buildTextExport(payload, 'srt')
    expect(exported).toContain('00:00:01,125 --> 00:00:03,750')
    expect(exported).toContain('00:02:05,500 --> 00:02:08,900')
  })
})

describe('portable note import', () => {
  const json = {
    type: 'vidstudio-timeline',
    version: 1,
    title: '学习',
    sourceUrl: 'https://example.com/video',
    chunks: [
      {
        startTime: '00:00',
        endTime: '00:20',
        title: 'Intro',
        keyPoints: ['a'],
        tags: ['学习'],
        transcript: [{ time: '00:01', text: 'hello' }]
      }
    ]
  }
  it('reads versioned exports and drops unsafe source URL schemes', () => {
    const document = importTimeline('notes.json', JSON.stringify(json))
    expect(document.sourceUrl).toBe('https://example.com/video')
    expect(document.chunks[0].transcript[0].seconds).toBe(1)
    expect(
      importTimeline('notes.json', JSON.stringify({ ...json, sourceUrl: 'file:///private' }))
        .sourceUrl
    ).toBeUndefined()
  })

  it('rejects unsupported versions and invalid structure with useful errors', () => {
    expect(() => importTimeline('notes.json', '{bad')).toThrow('JSON 无法读取')
    expect(() => importTimeline('notes.json', JSON.stringify({ ...json, version: 2 }))).toThrow(
      '版本'
    )
    expect(() => importTimeline('notes.json', JSON.stringify({ ...json, chunks: [] }))).toThrow(
      '片段'
    )
    const broken = structuredClone(json)
    broken.chunks[0].endTime = 'wrong'
    expect(() => importTimeline('notes.json', JSON.stringify(broken))).toThrow('时间范围')
    broken.chunks[0].endTime = '00:20'
    broken.chunks[0].transcript[0].time = '-1:00'
    expect(() => importTimeline('notes.json', JSON.stringify(broken))).toThrow('原文时间')
  })

  it('reads legacy timeline Markdown and escaped portable Markdown', () => {
    const document = importTimeline('notes.md', '## 00:00 - 01:00 | 标题\n**一句话总结**：总结')
    expect(document.chunks[0].summary).toBe('总结')
  })

  it('deduplicates repeated imports independently of line endings', async () => {
    expect(await documentCacheKey('a\r\nb\n')).toBe(await documentCacheKey('a\nb'))
    expect(await documentCacheKey('a')).not.toBe(await documentCacheKey('b'))
  })
})
