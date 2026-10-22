import {
  formatTimecode,
  parseTimelineMarkdown,
  timeToSeconds,
  type TimelineChunk,
  type TranscriptLine
} from './timeline'

export const MAX_IMPORT_BYTES = 10 * 1024 * 1024
export const IMPORT_EXTENSIONS = new Set(['srt', 'vtt', 'md', 'json'])

export interface TimelineDocument {
  type: 'vidstudio-timeline'
  version: 1
  title: string
  sourceLabel: string
  sourceUrl?: string
  sourceKind: 'subtitle' | 'notes'
  fileName: string
  chunks: TimelineChunk[]
  warnings: string[]
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, entity: string) => {
    if (entity.startsWith('#')) {
      const code =
        entity[1].toLowerCase() === 'x'
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10)
      return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
        ? String.fromCodePoint(code)
        : whole
    }
    return (
      { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[entity.toLowerCase()] ?? whole
    )
  })
}

function subtitleSeconds(value: string): number {
  const match = value.match(/^(\d+:\d{2}(?::\d{2})?)[,.](\d{1,3})$/)
  if (!match) return NaN
  return timeToSeconds(match[1]) + Number(match[2].padEnd(3, '0')) / 1000
}

function parseSubtitles(content: string): { chunks: TimelineChunk[]; warnings: string[] } {
  const lines = content.replace(/\r\n?/g, '\n').split('\n')
  const cues: TranscriptLine[] = []
  let skipped = 0
  let metadata = false
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim()
    if (!line) {
      metadata = false
      continue
    }
    if (/^(NOTE(?:\s|$)|STYLE$|REGION$)/.test(line)) {
      metadata = true
      continue
    }
    if (metadata || !line.includes('-->')) continue
    const match = line.match(/^(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/)
    const start = match ? subtitleSeconds(match[1]) : NaN
    const end = match ? subtitleSeconds(match[2]) : NaN
    const body: string[] = []
    while (index + 1 < lines.length && lines[index + 1].trim()) body.push(lines[++index])
    const text = decodeEntities(
      body
        .join('\n')
        .replace(/<v\s+([^>]+)>/g, '$1：')
        .replace(/<\/?[a-z][^>]*>|<\d+:\d{2}(?::\d{2})?[.]\d+>/gi, '')
    ).trim()
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !text) {
      skipped++
      continue
    }
    cues.push({ time: formatTimecode(start), seconds: start, endSeconds: end, text })
  }
  if (!cues.length)
    throw new Error('没有找到有效字幕。请检查时间码是否采用 00:00:01,000 --> 00:00:03,000 格式。')
  if (cues.length > 100000) throw new Error('字幕超过 100,000 条，请拆分后导入。')
  cues.sort((a, b) => a.seconds - b.seconds)
  const groups = new Map<number, TranscriptLine[]>()
  for (const cue of cues) {
    const bucket = Math.floor(cue.seconds / 120)
    const group = groups.get(bucket) ?? []
    group.push(cue)
    groups.set(bucket, group)
  }
  const chunks = [...groups.values()].map((transcript, index): TimelineChunk => {
    const start = transcript[0].seconds
    const end = transcript.reduce((maximum, cue) => Math.max(maximum, cue.endSeconds!), start)
    return {
      id: `subtitle-${index + 1}-${start}`,
      startTime: formatTimecode(start),
      endTime: formatTimecode(end),
      startSeconds: start,
      endSeconds: end,
      title: `字幕片段 ${index + 1}`,
      summary: '',
      keyPoints: [],
      tags: [],
      transcript
    }
  })
  const warnings = skipped ? [`跳过 ${skipped} 条时间或内容无效的字幕。`] : []
  if (cues.some((cue, index) => index > 0 && cue.seconds < cues[index - 1].endSeconds!)) {
    warnings.push('包含时间重叠的字幕，已保留原始时间。')
  }
  return { chunks, warnings }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('时间轴 JSON 的结构无效。')
  return value as Record<string, unknown>
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function stringList(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string'))
    throw new Error('观点和标签必须是文字列表。')
  return value
}

function safeSourceUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined
  } catch {
    return undefined
  }
}

function parseJson(content: string): Omit<TimelineDocument, 'fileName'> & { fileName?: string } {
  let input: Record<string, unknown>
  try {
    input = record(JSON.parse(content))
  } catch {
    throw new Error('JSON 无法读取，请选择 VidStudio 导出的 JSON 时间轴。')
  }
  if (input.type !== 'vidstudio-timeline' || input.version !== 1)
    throw new Error('不支持此 JSON 格式或版本。请选择 VidStudio 导出的 v1 时间轴。')
  if (!Array.isArray(input.chunks) || !input.chunks.length || input.chunks.length > 10000)
    throw new Error('时间轴必须包含 1 至 10,000 个片段。')
  let cueCount = 0
  const ids = new Set<string>()
  const chunks = input.chunks.map((entry, index): TimelineChunk => {
    const chunk = record(entry)
    const start =
      typeof chunk.startSeconds === 'number'
        ? chunk.startSeconds
        : timeToSeconds(text(chunk.startTime))
    const end =
      typeof chunk.endSeconds === 'number' ? chunk.endSeconds : timeToSeconds(text(chunk.endTime))
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start)
      throw new Error(`第 ${index + 1} 个片段的时间范围无效。`)
    const source = chunk.transcript ?? []
    if (!Array.isArray(source)) throw new Error(`第 ${index + 1} 个片段的原文格式无效。`)
    cueCount += source.length
    if (cueCount > 100000) throw new Error('原文超过 100,000 条，请拆分后导入。')
    const transcript = source.map((entry): TranscriptLine => {
      const line = record(entry)
      const seconds =
        typeof line.seconds === 'number' ? line.seconds : timeToSeconds(text(line.time))
      const endSeconds = typeof line.endSeconds === 'number' ? line.endSeconds : undefined
      if (
        !Number.isFinite(seconds) ||
        seconds < 0 ||
        (endSeconds !== undefined && (!Number.isFinite(endSeconds) || endSeconds <= seconds))
      )
        throw new Error(`第 ${index + 1} 个片段含无效的原文时间。`)
      if (typeof line.text !== 'string') throw new Error('原文内容必须是文字。')
      return { time: formatTimecode(seconds), seconds, endSeconds, text: line.text }
    })
    const baseId = text(chunk.id) || `imported-${index + 1}-${start}`
    let id = baseId
    while (ids.has(id)) id += `-${index + 1}`
    ids.add(id)
    return {
      id,
      startTime: formatTimecode(start),
      endTime: formatTimecode(end),
      startSeconds: start,
      endSeconds: end,
      title: text(chunk.title, `片段 ${index + 1}`),
      summary: text(chunk.summary),
      keyPoints: stringList(chunk.keyPoints),
      tags: stringList(chunk.tags),
      transcript
    }
  })
  return {
    type: 'vidstudio-timeline',
    version: 1,
    title: text(input.title, '导入的时间轴'),
    sourceLabel: text(input.sourceLabel),
    sourceUrl: safeSourceUrl(input.sourceUrl),
    sourceKind: input.sourceKind === 'subtitle' ? 'subtitle' : 'notes',
    fileName: text(input.fileName),
    chunks,
    warnings: Array.isArray(input.warnings)
      ? input.warnings
          .filter((warning): warning is string => typeof warning === 'string')
          .slice(0, 10)
      : []
  }
}

/** The only accepted JSON is this app's versioned format; arbitrary files never become executable content. */
export function importTimeline(fileName: string, raw: string): TimelineDocument {
  if (raw.length > MAX_IMPORT_BYTES) throw new Error('文件过大，请选择不超过 10 MB 的字幕或笔记。')
  if (raw.includes('\0')) throw new Error('文件不是 UTF-8 文字，请先转换编码。')
  const content = raw.replace(/^\uFEFF/, '')
  const extension = fileName.split('.').pop()?.toLowerCase() ?? ''
  if (!IMPORT_EXTENSIONS.has(extension))
    throw new Error('支持导入 SRT、WebVTT、VidStudio Markdown 和 JSON。')
  const title = fileName.replace(/\.[^.]+$/, '') || '导入的资料'
  if (extension === 'json') {
    const document = parseJson(content)
    return { ...document, fileName: document.fileName || fileName }
  }
  const base = {
    type: 'vidstudio-timeline' as const,
    version: 1 as const,
    title,
    sourceLabel: `导入文件：${fileName}`,
    fileName
  }
  if (extension === 'md') {
    const chunks = parseTimelineMarkdown(content)
    if (!chunks.length)
      throw new Error(
        '没有找到时间轴章节。请导入 VidStudio 导出的 Markdown（## 00:00 - 02:00 | 标题）。'
      )
    return { ...base, sourceKind: 'notes', chunks, warnings: [] }
  }
  return { ...base, sourceKind: 'subtitle', ...parseSubtitles(content) }
}

export async function documentCacheKey(content: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(content.replace(/\r\n?/g, '\n').trim())
  )
  return `document:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}
