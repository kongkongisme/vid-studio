import { describe, expect, it } from 'vitest'
import { buildTextExport } from '../src/shared/timeline-formats'
import { importTimeline } from '../src/shared/timeline-import'
import { buildTimelineExportHtml } from '../src/main/timeline-export'
import type { TimelineExportPayload } from '../src/shared/export'

function payload(): TimelineExportPayload {
  const document = importTimeline('source.srt', '1\n00:00:01,000 --> 00:00:03,000\n原文')
  document.chunks[0].userNote = '\n我的理解 <script>alert(1)</script> &\n\n- 待验证的问题'
  document.chunks[0].bookmarked = true
  return {
    ...document,
    modeLabel: '导入',
    exportedAt: '',
    includeTranscript: true,
    includeAnnotations: true,
    llmProvider: 'deepseek'
  }
}

describe('portable personal notes', () => {
  it('round trips multiline notes and bookmarks through Markdown and JSON', () => {
    const input = payload()
    for (const format of ['markdown', 'json'] as const) {
      const fileName = format === 'markdown' ? 'notes.md' : 'notes.json'
      const document = importTimeline(fileName, buildTextExport(input, format))
      expect(document.chunks[0].userNote).toBe(input.chunks[0].userNote)
      expect(document.chunks[0].bookmarked).toBe(true)
      expect(document.chunks[0].transcript[0].text).toBe('原文')
    }
  })

  it('respects the personal-note opt-out in every document format', () => {
    const input = { ...payload(), includeAnnotations: false }
    expect(buildTextExport(input, 'markdown')).not.toContain('我的笔记')
    const json = JSON.parse(buildTextExport(input, 'json'))
    expect(json.chunks[0]).not.toHaveProperty('userNote')
    expect(json.chunks[0]).not.toHaveProperty('bookmarked')
    expect(buildTimelineExportHtml(input)).not.toContain('我的笔记')
  })

  it('renders PDF notes safely and highlights characters without breaking HTML entities', () => {
    const html = buildTimelineExportHtml({ ...payload(), highlightTerm: '&' })
    expect(html).toContain('我的笔记')
    expect(html).toContain('已收藏')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('<mark>&amp;</mark>')
    expect(buildTextExport(payload(), 'srt')).not.toContain('我的理解')
  })
})
