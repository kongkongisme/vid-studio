export type TimelineExportLlmProvider = 'deepseek' | 'gpt-5.6-sol'
export type TextExportFormat = 'markdown' | 'json' | 'srt' | 'vtt'

export interface TimelineExportResult {
  success: boolean
  path?: string
  title?: string
  llmReceipt?: TimelineExportReceipt
  canceled?: boolean
  error?: string
}

export interface TimelineExportReceipt {
  purpose: string
  provider: TimelineExportLlmProvider
  requestedModel: string
  responseModel?: string
  endpoint: string
  requestId?: string
  timestamp: string
  durationMs: number
  reasoningEffort?: string
  status: 'success' | 'fallback'
  error?: string
}

export interface TimelineExportChunk {
  id?: string
  userNote?: string
  bookmarked?: boolean
  startTime: string
  startSeconds?: number
  endTime: string
  endSeconds?: number
  title: string
  summary: string
  keyPoints: string[]
  tags: string[]
  transcript: { time: string; text: string; seconds?: number; endSeconds?: number }[]
}

export interface TimelineExportPayload {
  title: string
  sourceLabel: string
  sourceUrl?: string
  sourceKind?: 'subtitle' | 'notes'
  modeLabel: string
  exportedAt: string
  highlightTerm?: string
  includeTranscript: boolean
  includeAnnotations?: boolean
  llmProvider: TimelineExportLlmProvider
  llmReceipt?: TimelineExportReceipt
  chunks: TimelineExportChunk[]
}
