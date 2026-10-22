import type { TimelineChunk } from './timeline'
import type { TimelineExportReceipt, TimelineExportLlmProvider } from './export'

export const MAX_CHAT_MESSAGES = 1000
export const MAX_CHAT_INPUT = 8000
export const MAX_CHAT_CHARACTERS = 5_000_000
export type ChatStatus = 'complete' | 'streaming' | 'stopped' | 'error'
export type ChatQuote = Pick<
  TimelineChunk,
  'id' | 'startTime' | 'endTime' | 'startSeconds' | 'title' | 'summary' | 'keyPoints'
>

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
  status: ChatStatus
  quotedChunk?: ChatQuote
  searchQuery?: string
  error?: string
}

export interface ApiChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatRequest {
  requestId: string
  messages: ApiChatMessage[]
  provider: TimelineExportLlmProvider
}

export interface ChatEvent {
  requestId: string
  type: 'delta' | 'search'
  text: string
}

export interface ChatResult {
  success: boolean
  canceled?: boolean
  llmReceipt?: TimelineExportReceipt
  error?: string
}

export function toChatQuote(chunk: ChatQuote): ChatQuote {
  return {
    id: chunk.id,
    startTime: chunk.startTime,
    endTime: chunk.endTime,
    startSeconds: chunk.startSeconds,
    title: chunk.title.slice(0, 1000),
    summary: chunk.summary.slice(0, 2000),
    keyPoints: chunk.keyPoints.slice(0, 5).map((point) => point.slice(0, 500))
  }
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length <= maximum
}

export function validateConversation(
  sourceKey: string,
  input: unknown,
  maximumCharacters = MAX_CHAT_CHARACTERS
): ChatMessage[] {
  if (!sourceKey || typeof sourceKey !== 'string' || sourceKey.length > 4096)
    throw new Error('对话来源标识无效')
  if (!Array.isArray(input) || input.length > MAX_CHAT_MESSAGES)
    throw new Error(`每份资料最多保存 ${MAX_CHAT_MESSAGES} 条消息，请导出后清空对话。`)
  const ids = new Set<string>()
  const messages = input.map((value): ChatMessage => {
    if (!value || typeof value !== 'object') throw new Error('对话消息格式无效')
    const message = value as ChatMessage
    if (
      !boundedText(message.id, 100) ||
      !message.id ||
      ids.has(message.id) ||
      !['user', 'assistant'].includes(message.role) ||
      !boundedText(message.content, 100000) ||
      !Number.isFinite(message.createdAt) ||
      !['complete', 'streaming', 'stopped', 'error'].includes(message.status) ||
      (message.error !== undefined && !boundedText(message.error, 2000)) ||
      (message.searchQuery !== undefined && !boundedText(message.searchQuery, 1000))
    )
      throw new Error('对话消息格式无效')
    ids.add(message.id)
    const quote = message.quotedChunk
    if (
      quote &&
      (!boundedText(quote.id, 1000) ||
        !boundedText(quote.title, 1000) ||
        !boundedText(quote.startTime, 30) ||
        !boundedText(quote.endTime, 30) ||
        !Number.isFinite(quote.startSeconds) ||
        quote.startSeconds < 0 ||
        !boundedText(quote.summary, 2000) ||
        !Array.isArray(quote.keyPoints) ||
        quote.keyPoints.length > 5 ||
        !quote.keyPoints.every((point) => boundedText(point, 500)))
    )
      throw new Error('对话引用片段无效')
    return {
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
      status: message.status,
      ...(quote ? { quotedChunk: toChatQuote(quote) } : {}),
      ...(message.error ? { error: message.error } : {}),
      ...(message.searchQuery ? { searchQuery: message.searchQuery } : {})
    }
  })
  if (JSON.stringify(messages).length > maximumCharacters)
    throw new Error('对话内容过大，请先导出备份再清空对话。')
  return messages
}

export function validateChatRequest(request: ChatRequest): void {
  if (
    !request ||
    typeof request.requestId !== 'string' ||
    !/^[\w:.-]{1,100}$/.test(request.requestId) ||
    !['deepseek', 'gpt-5.6-sol'].includes(request.provider) ||
    !Array.isArray(request.messages) ||
    !request.messages.length ||
    request.messages.length > 80 ||
    request.messages.some(
      (message) =>
        !message ||
        !['system', 'user', 'assistant'].includes(message.role) ||
        !boundedText(message.content, 100000)
    ) ||
    request.messages.reduce((sum, message) => sum + message.content.length, 0) > 100000
  )
    throw new Error('对话请求无效或上下文过长')
}

/** Persist all history; send only recent conversation within a separate API budget. */
export function recentChatContext(
  messages: ChatMessage[],
  maxCharacters = 24000
): ApiChatMessage[] {
  const selected: ApiChatMessage[] = []
  let remaining = maxCharacters
  for (const message of [...messages].reverse()) {
    if (message.status === 'streaming' || !message.content.trim()) continue
    const prefix = message.quotedChunk
      ? `[引用片段 ${message.quotedChunk.startTime}: ${message.quotedChunk.title}]\n`
      : ''
    const content =
      prefix + message.content + (message.status !== 'complete' ? '\n（此回答未完成）' : '')
    if (content.length > remaining || selected.length >= 20) break
    selected.unshift({ role: message.role, content })
    remaining -= content.length
  }
  while (selected[0]?.role === 'assistant') selected.shift()
  return selected
}

export function conversationMarkdown(title: string, messages: ChatMessage[]): string {
  const sections = messages.map((message) => {
    const state =
      message.status === 'complete'
        ? ''
        : message.status === 'error'
          ? ' · 回答未完成'
          : ' · 已停止'
    const quote = message.quotedChunk
      ? `> 引用 [${message.quotedChunk.startTime}] ${message.quotedChunk.title.replace(/\n/g, ' ')}\n\n`
      : ''
    const search = message.searchQuery ? `已联网搜索：${message.searchQuery}\n\n` : ''
    return `## ${message.role === 'user' ? '我' : '助手'}${state}\n\n${quote}${search}${message.content || '（未生成内容）'}${message.error ? `\n\n> ${message.error}` : ''}`
  })
  return `# ${title.replace(/[\r\n]/g, ' ')} · 对话记录\n\n${sections.join('\n\n---\n\n')}\n`
}
