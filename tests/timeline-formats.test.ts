import { describe, expect, it } from 'vitest'
import {
  buildTextExport,
  getSubtitleCues,
  safeExportFilename
} from '../src/shared/timeline-formats'
import type { TimelineExportPayload } from '../src/shared/export'
import { parseTimelineMarkdown } from '../src/shared/timeline'

const payload: TimelineExportPayload = {
  title: '学习笔记',
  sourceLabel: '来源：本地视频',
  modeLabel: 'ASR',
  exportedAt: '2026-10-22',
  includeTranscript: true,
  llmProvider: 'deepseek',
  chunks: [
    {
      startTime: '01:00:00',
      endTime: '01:00:15',
      title: '关键概念',
      summary: '理解概念',
      keyPoints: ['先理解，再实践'],
      tags: ['学习'],
      transcript: [
        { time: '01:00:00', text: '第一句话' },
        { time: '01:00:03', text: '第二句话' },
        { time: '01:00:14', text: '最后一句话' }
      ]
    }
  ]
}

describe('portable timeline exports', () => {
  it('exports structured Markdown with source, timestamps and optional transcript', () => {
    const markdown = buildTextExport(payload, 'markdown')
    expect(markdown).toContain('## 01:00:00 - 01:00:15 | 关键概念')
    expect(markdown).toContain('[01:00:03] 第二句话')
    expect(buildTextExport({ ...payload, includeTranscript: false }, 'markdown')).not.toContain(
      '原文记录'
    )
  })

  it('does not turn source text into HTML or extra Markdown sections', () => {
    const copy = structuredClone(payload)
    copy.chunks[0].title = '<img src=x>\n## fake'
    const markdown = buildTextExport(copy, 'markdown')
    expect(markdown).not.toContain('<img')
    expect(markdown).toContain('&lt;img src=x&gt; \\#\\# fake')
  })

  it('round trips escaped Markdown text without adding formatting characters', () => {
    const copy = structuredClone(payload)
    copy.chunks[0].title = '<标签> & 原文 [a_b] | #词'
    copy.chunks[0].transcript[0].text = '`code` 与 **重点** &lt;'
    const parsed = parseTimelineMarkdown(buildTextExport(copy, 'markdown'))
    expect(parsed[0].title).toBe(copy.chunks[0].title)
    expect(parsed[0].transcript[0].text).toBe(copy.chunks[0].transcript[0].text)
  })

  it('makes versioned JSON with transcript opt-out and no API receipts', () => {
    const data = JSON.parse(buildTextExport({ ...payload, includeTranscript: false }, 'json'))
    expect(data).toMatchObject({ type: 'vidstudio-timeline', version: 1, title: '学习笔记' })
    expect(data.chunks[0].transcript).toEqual([])
    expect(data).not.toHaveProperty('llmProvider')
  })

  it('bounds estimated subtitle times by the next cue, 8 seconds, and chapter end', () => {
    expect(getSubtitleCues(payload).map(({ start, end }) => [start, end])).toEqual([
      [3600, 3603],
      [3603, 3611],
      [3614, 3615]
    ])
    expect(buildTextExport(payload, 'srt')).toContain('01:00:00,000 --> 01:00:03,000')
    expect(buildTextExport(payload, 'vtt')).toMatch(/^WEBVTT\n\nNOTE/)
  })

  it('preserves exact cue ends, sorts cues, merges same-time text, and escapes tags', () => {
    const copy = structuredClone(payload)
    copy.chunks[0].transcript = [
      { time: '01:00:03', endSeconds: 3604.125, text: 'second' },
      { time: '01:00:00', endSeconds: 3601.5, text: '<b>first</b>' },
      { time: '01:00:00', endSeconds: 3602, text: 'same time' }
    ]
    const result = buildTextExport(copy, 'srt')
    expect(result).toContain('01:00:00,000 --> 01:00:02,000')
    expect(result).toContain('&lt;b&gt;first&lt;/b&gt;\nsame time')
    expect(result).toContain('01:00:04,125')
    expect(buildTextExport(copy, 'vtt')).not.toContain('NOTE')
  })

  it('reports missing subtitles and creates portable filenames', () => {
    expect(() => buildTextExport({ ...payload, chunks: [] }, 'srt')).toThrow('原文')
    expect(safeExportFilename('../A:B/C')).toBe('A B C')
    expect(safeExportFilename('CON')).toBe('视频时间轴')
    expect(safeExportFilename('   ')).toBe('视频时间轴')
  })

  it('keeps filename Unicode intact and leaves byte room for collection suffixes', () => {
    const emoji = safeExportFilename('A' + '😀'.repeat(40))
    expect(() => encodeURIComponent(emoji)).not.toThrow()
    expect(emoji).toBe('A' + '😀'.repeat(39))
    expect(Buffer.byteLength(safeExportFilename('中文'.repeat(100)))).toBeLessThanOrEqual(200)
    expect(safeExportFilename('a'.repeat(79) + '.tail')).not.toMatch(/[. ]$/)
    expect(() => encodeURIComponent(safeExportFilename('broken\ud800title'))).not.toThrow()
  })
})
