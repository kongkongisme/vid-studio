export interface TranscriptLine {
  time: string
  seconds: number
  /** Present for imported subtitles; generated timelines usually contain only start times. */
  endSeconds?: number
  text: string
}

export interface TimelineChunk {
  id: string
  startTime: string
  endTime: string
  startSeconds: number
  endSeconds: number
  title: string
  summary: string
  keyPoints: string[]
  tags: string[]
  transcript: TranscriptLine[]
  userNote?: string
  bookmarked?: boolean
}

export function timeToSeconds(time: string): number {
  const match = time.trim().match(/^(\d+):(\d{2})(?::(\d{2}))?$/)
  if (!match) return NaN
  const first = Number(match[1])
  const second = Number(match[2])
  const third = match[3] === undefined ? undefined : Number(match[3])
  if (second >= 60 || (third !== undefined && third >= 60)) return NaN
  const total = third === undefined ? first * 60 + second : first * 3600 + second * 60 + third
  return Number.isSafeInteger(total) ? total : NaN
}

export function formatTimecode(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const tail = `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  return hours ? `${String(hours).padStart(2, '0')}:${tail}` : tail
}

/** Parse VidEngine's Markdown without interpreting any HTML from the source. */
export function parseTimelineMarkdown(markdown: string): TimelineChunk[] {
  const isPortable = markdown.replace(/^\uFEFF/, '').startsWith('<!-- vidstudio:markdown:1 -->')
  const decode = (value: string): string =>
    isPortable
      ? value
          .replace(/\\([\\`*_[\]#|])/g, '$1')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&')
      : value
  const chunks: TimelineChunk[] = []
  const ids = new Map<string, number>()
  let current: TimelineChunk | null = null
  let section: 'none' | 'points' | 'transcript' | 'note' = 'none'
  let noteHasLine = false

  for (const rawLine of markdown.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim()
    const heading = line.match(
      /^##\s+(\d+:\d{2}(?::\d{2})?)\s*[-–]\s*(\d+:\d{2}(?::\d{2})?)\s*\|\s*(.+)$/
    )
    if (heading) {
      current = null
      section = 'none'
      const start = timeToSeconds(heading[1])
      const end = timeToSeconds(heading[2])
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue
      const baseId = `${heading[1]}-${heading[2]}`
      const count = (ids.get(baseId) ?? 0) + 1
      ids.set(baseId, count)
      current = {
        id: count === 1 ? baseId : `${baseId}-${count}`,
        startTime: heading[1],
        endTime: heading[2],
        startSeconds: start,
        endSeconds: end,
        title: decode(heading[3].trim()),
        summary: '',
        keyPoints: [],
        tags: [],
        transcript: []
      }
      chunks.push(current)
      continue
    }
    if (/^##\s/.test(line)) {
      current = null
      section = 'none'
    }
    if (!current) continue
    const summary = line.match(/^\*\*一句话总结\*\*\s*[：:]\s*(.*)$/)
    if (summary) {
      current.summary = decode(summary[1])
      section = 'none'
    } else if (line.startsWith('**核心观点**')) {
      section = 'points'
    } else if (line.startsWith('**原文记录**')) {
      section = 'transcript'
    } else if (line.startsWith('**我的笔记**')) {
      section = 'note'
      current.userNote = ''
      noteHasLine = false
    } else if (line.startsWith('**片段收藏**')) {
      current.bookmarked = /[：:]\s*是$/.test(line)
      section = 'none'
    } else if (line.startsWith('**标签**')) {
      current.tags = (line.match(/#[\p{L}\p{N}_-]+/gu) ?? []).map((tag) => tag.slice(1))
      section = 'none'
    } else if (line.startsWith('**')) {
      section = 'none'
    } else if (section === 'note' && (line === '>' || line.startsWith('> '))) {
      current.userNote += (noteHasLine ? '\n' : '') + decode(line.slice(2))
      noteHasLine = true
    } else if (section === 'points' && /^[-*]\s/.test(line)) {
      current.keyPoints.push(decode(line.slice(2).trim()))
    } else if (section === 'transcript') {
      const cue = line.match(/^\[(\d+:\d{2}(?::\d{2})?)\]\s+(.+)$/)
      if (cue) {
        const seconds = timeToSeconds(cue[1])
        if (Number.isFinite(seconds)) {
          current.transcript.push({ time: cue[1], seconds, text: decode(cue[2].trim()) })
        }
      }
    }
  }
  return chunks
}
