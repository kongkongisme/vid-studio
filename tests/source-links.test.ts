import { describe, expect, it } from 'vitest'
import { sourceTimestampUrl } from '../src/shared/source-links'
import { buildTextExport } from '../src/shared/timeline-formats'
import { importTimeline } from '../src/shared/timeline-import'
import { buildTimelineExportHtml } from '../src/main/timeline-export'
import type { TimelineExportPayload } from '../src/shared/export'

const bv = 'BV1xx411c7mD'
const youtubeId = 'abcdefgh-_1'

describe('source timestamp links', () => {
  it('canonicalizes Bilibili links and bare IDs, retains part number and removes tracking', () => {
    expect(
      sourceTimestampUrl(
        `https://m.bilibili.com/video/${bv}/?p=2&t=1&spm_id_from=tracking#reply`,
        123.9
      )
    ).toBe(`https://www.bilibili.com/video/${bv}?p=2&t=123`)
    expect(sourceTimestampUrl(bv, 0)).toBe(`https://www.bilibili.com/video/${bv}?t=0`)
    expect(sourceTimestampUrl(`http://www.bilibili.com/video/${bv}?p=bad`, 3601)).toBe(
      `https://www.bilibili.com/video/${bv}?t=3601`
    )
  })

  it.each([
    `https://www.youtube.com/watch?v=${youtubeId}&list=tracking&t=4`,
    `https://m.youtube.com/watch?v=${youtubeId}`,
    `https://youtu.be/${youtubeId}?si=tracking`,
    `https://youtube.com/embed/${youtubeId}`,
    `https://youtube.com/shorts/${youtubeId}`,
    `https://youtube.com/live/${youtubeId}`
  ])('canonicalizes supported YouTube forms: %s', (url) => {
    expect(sourceTimestampUrl(url, 65.75)).toBe(`https://www.youtube.com/watch?v=${youtubeId}&t=65`)
  })

  it('rejects arbitrary hosts, credentials, scripts, invalid IDs and invalid times', () => {
    for (const url of [
      undefined,
      '',
      'document:abc',
      'file:///private/movie.mp4',
      'javascript:alert(1)',
      `https://youtube.com.evil.example/watch?v=${youtubeId}`,
      `https://evil.example/youtube.com/watch?v=${youtubeId}`,
      `https://youtube.com@evil.example/watch?v=${youtubeId}`,
      `https://user:password@youtube.com/watch?v=${youtubeId}`,
      `https://youtube.com:1234/watch?v=${youtubeId}`,
      'https://youtube.com/watch?v=too-short',
      `https://bilibili.com/video/${bv}/unexpected`,
      `https://youtu.be/${youtubeId}/unexpected`
    ])
      expect(sourceTimestampUrl(url, 10), String(url)).toBeNull()
    for (const time of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
      expect(sourceTimestampUrl(bv, time)).toBeNull()
  })

  const payload = (): TimelineExportPayload => ({
    title: '有来源的课程',
    sourceLabel: '测试视频',
    sourceUrl: `https://youtu.be/${youtubeId}?si=secret-tracking`,
    modeLabel: 'ASR',
    exportedAt: '',
    includeTranscript: true,
    llmProvider: 'deepseek',
    chunks: [
      {
        startTime: '01:05',
        startSeconds: 65.75,
        endTime: '02:00',
        title: '关键概念',
        summary: '概念总结',
        keyPoints: [],
        tags: [],
        transcript: [{ time: '01:06', seconds: 66, text: '证据原文' }]
      }
    ]
  })

  it('adds source links to Markdown and PDF and preserves supported source metadata after Markdown import', () => {
    const input = payload()
    const markdown = buildTextExport(input, 'markdown')
    expect(markdown).toContain(
      `[回看原视频 · 01:05](https://www.youtube.com/watch?v=${youtubeId}&t=65)`
    )
    expect(markdown).not.toContain('secret-tracking')
    const imported = importTimeline('notes.md', markdown)
    expect(imported.sourceUrl).toBe(`https://www.youtube.com/watch?v=${youtubeId}&t=0`)
    expect(imported.chunks[0]).toMatchObject({
      summary: '概念总结',
      transcript: [{ seconds: 66, text: '证据原文' }]
    })
    expect(buildTimelineExportHtml(input)).toContain(
      `href="https://www.youtube.com/watch?v=${youtubeId}&amp;t=65"`
    )
  })

  it('does not add unsupported links or read malformed optional Markdown source metadata', () => {
    const input = { ...payload(), sourceUrl: 'javascript:alert(1)' }
    expect(buildTextExport(input, 'markdown')).not.toContain('回看原视频')
    expect(buildTimelineExportHtml(input)).not.toContain('javascript:')
    for (const source of [
      '%invalid',
      encodeURIComponent('https://evil.example'),
      encodeURIComponent('javascript:alert(1)')
    ]) {
      const md = `<!-- vidstudio:markdown:1 -->\n<!-- vidstudio:source-url:${source} -->\n## 00:00 - 01:00 | 章节\n`
      expect(importTimeline('notes.md', md).sourceUrl).toBeUndefined()
    }
    expect(buildTextExport({ ...payload(), sourceUrl: undefined }, 'markdown')).not.toContain(
      '回看原视频'
    )
  })
})
