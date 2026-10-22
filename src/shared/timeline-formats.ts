import type { TextExportFormat, TimelineExportPayload } from './export'
import { timeToSeconds } from './timeline'

export const EXPORT_FORMATS: Record<TextExportFormat, { label: string; extension: string }> = {
  markdown: { label: 'Markdown 笔记', extension: 'md' },
  json: { label: 'JSON 时间轴', extension: 'json' },
  srt: { label: 'SRT 字幕', extension: 'srt' },
  vtt: { label: 'WebVTT 字幕', extension: 'vtt' }
}

function markdownText(value: string): string {
  return value
    .replace(/\r?\n/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]!)
    .replace(/([`*_[\]#|])/g, '\\$1')
}

export function buildTimelineMarkdown(payload: TimelineExportPayload): string {
  const lines = [
    '<!-- vidstudio:markdown:1 -->',
    `# ${markdownText(payload.title)}`,
    '',
    `> ${markdownText(payload.sourceLabel)}`,
    `> ${markdownText(payload.modeLabel)} · ${markdownText(payload.exportedAt)}`,
    ''
  ]
  for (const chunk of payload.chunks) {
    lines.push(`## ${chunk.startTime} - ${chunk.endTime} | ${markdownText(chunk.title)}`, '')
    if (chunk.summary) lines.push(`**一句话总结**：${markdownText(chunk.summary)}`, '')
    if (chunk.keyPoints.length) {
      lines.push('**核心观点**', ...chunk.keyPoints.map((point) => `- ${markdownText(point)}`), '')
    }
    if (chunk.tags.length)
      lines.push(
        `**标签**：${chunk.tags.map((tag) => `#${tag.replace(/[^\p{L}\p{N}_-]/gu, '_')}`).join(' ')}`,
        ''
      )
    if (payload.includeAnnotations !== false && chunk.bookmarked) lines.push('**片段收藏**：是', '')
    if (payload.includeAnnotations !== false && chunk.userNote) {
      lines.push(
        '**我的笔记**',
        ...chunk.userNote.split(/\r?\n/).map((line) => `> ${markdownText(line)}`),
        ''
      )
    }
    if (payload.includeTranscript && chunk.transcript.length) {
      lines.push(
        '**原文记录**',
        ...chunk.transcript.map((cue) => `[${cue.time}] ${markdownText(cue.text)}`),
        ''
      )
    }
  }
  return `${lines.join('\n').trimEnd()}\n`
}

interface SubtitleCue {
  start: number
  end: number
  text: string
  inferred: boolean
}

/** Inference is limited to 8 seconds and the next distinct cue / chapter boundary. */
export function getSubtitleCues(payload: TimelineExportPayload): SubtitleCue[] {
  const rows = payload.chunks
    .flatMap((chunk) =>
      chunk.transcript.map((line) => ({
        start: line.seconds ?? timeToSeconds(line.time),
        exactEnd: line.endSeconds,
        chapterEnd: timeToSeconds(chunk.endTime),
        text: line.text.replace(/\r/g, '').trim()
      }))
    )
    .filter((row) => Number.isFinite(row.start) && row.start >= 0 && row.text)
    .sort((a, b) => a.start - b.start)
  const grouped: typeof rows = []
  for (const row of rows) {
    const previous = grouped.at(-1)
    if (previous?.start === row.start) {
      if (!previous.text.split('\n').includes(row.text)) previous.text += `\n${row.text}`
      previous.chapterEnd = Math.max(previous.chapterEnd, row.chapterEnd)
      previous.exactEnd =
        previous.exactEnd !== undefined && row.exactEnd !== undefined
          ? Math.max(previous.exactEnd, row.exactEnd)
          : undefined
    } else grouped.push({ ...row })
  }
  return grouped.map((row, index) => {
    const exact =
      row.exactEnd !== undefined && Number.isFinite(row.exactEnd) && row.exactEnd > row.start
    const next = grouped[index + 1]?.start ?? Infinity
    const chapterEnd = row.chapterEnd > row.start ? row.chapterEnd : Infinity
    const end = exact ? row.exactEnd! : Math.min(row.start + 8, next, chapterEnd)
    return { start: row.start, end, text: row.text, inferred: !exact }
  })
}

function subtitleTime(seconds: number, separator: ',' | '.'): string {
  const total = Math.max(0, Math.round(seconds * 1000))
  const hours = Math.floor(total / 3600000)
  const minutes = Math.floor((total % 3600000) / 60000)
  const secs = Math.floor((total % 60000) / 1000)
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}${separator}${String(total % 1000).padStart(3, '0')}`
}

export function buildTextExport(payload: TimelineExportPayload, format: TextExportFormat): string {
  if (format === 'markdown') return buildTimelineMarkdown(payload)
  if (format === 'json') {
    return (
      JSON.stringify(
        {
          type: 'vidstudio-timeline',
          version: 1,
          title: payload.title,
          sourceLabel: payload.sourceLabel,
          sourceUrl: payload.sourceUrl,
          sourceKind: payload.sourceKind,
          modeLabel: payload.modeLabel,
          exportedAt: payload.exportedAt,
          chunks: payload.chunks.map((chunk) => ({
            ...chunk,
            userNote: payload.includeAnnotations !== false ? chunk.userNote : undefined,
            bookmarked: payload.includeAnnotations !== false ? chunk.bookmarked : undefined,
            transcript: payload.includeTranscript ? chunk.transcript : []
          }))
        },
        null,
        2
      ) + '\n'
    )
  }
  const cues = getSubtitleCues(payload)
  if (!cues.length) throw new Error('当前时间轴没有可导出的逐句原文')
  const separator = format === 'srt' ? ',' : '.'
  const body = cues
    .map(
      (cue, index) =>
        `${index + 1}\n${subtitleTime(cue.start, separator)} --> ${subtitleTime(cue.end, separator)}\n${cue.text
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/\n{2,}/g, '\n')}`
    )
    .join('\n\n')
  const note = cues.some((cue) => cue.inferred)
    ? 'NOTE 部分结束时间由下一句、片段边界或最长 8 秒推断。\n\n'
    : ''
  return (format === 'vtt' ? `WEBVTT\n\n${note}` : '') + body + '\n'
}

export function safeExportFilename(title: string): string {
  const name = title
    // Control characters cannot appear in portable filenames.
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|[. ]+$/g, '')
    .slice(0, 80)
    .trim()
  return name && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? name : '视频时间轴'
}
