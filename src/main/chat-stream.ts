export interface StreamToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ChatStreamResult {
  content: string
  responseModel: string
  finishReason: string
  toolCalls: StreamToolCall[]
}

/** Read SSE frames across arbitrary UTF-8/chunk/CRLF boundaries, including a final unterminated frame. */
export async function readChatStream(
  response: Response,
  signal: AbortSignal,
  onDelta: (text: string) => void
): Promise<ChatStreamResult> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('无法读取回答流')
  const decoder = new TextDecoder()
  const calls = new Map<number, StreamToolCall>()
  const result: ChatStreamResult = {
    content: '',
    responseModel: '',
    finishReason: '',
    toolCalls: []
  }
  let buffer = ''
  let dataLines: string[] = []
  let dataLength = 0
  let doneMarker = false
  const abort = (): void => {
    void reader.cancel(signal.reason).catch(() => undefined)
  }
  signal.addEventListener('abort', abort, { once: true })

  function dispatch(): void {
    if (!dataLines.length) return
    const data = dataLines.join('\n')
    dataLines = []
    dataLength = 0
    if (data.trim() === '[DONE]') {
      doneMarker = true
      return
    }
    let parsed: {
      model?: string
      error?: { message?: string }
      choices?: Array<{
        finish_reason?: string | null
        delta?: {
          content?: string
          tool_calls?: Array<{
            index: number
            id?: string
            function?: { name?: string; arguments?: string }
          }>
        }
      }>
    }
    try {
      parsed = JSON.parse(data)
    } catch {
      throw new Error('回答流包含无法读取的数据，请重试。')
    }
    if (!parsed || typeof parsed !== 'object') throw new Error('回答流的数据格式无效。')
    if (parsed.error)
      throw new Error(`模型返回错误：${String(parsed.error.message ?? '未知错误').slice(0, 500)}`)
    if (typeof parsed.model === 'string') result.responseModel = parsed.model
    const choice = parsed.choices?.[0]
    if (!choice) return
    if (choice.finish_reason) result.finishReason = choice.finish_reason
    const delta = choice.delta
    if (typeof delta?.content === 'string') {
      if (result.content.length + delta.content.length > 100000)
        throw new Error('回答过长，已保留收到的内容。')
      result.content += delta.content
      onDelta(delta.content)
    }
    for (const partial of delta?.tool_calls ?? []) {
      if (!Number.isInteger(partial.index) || partial.index < 0 || partial.index > 2)
        throw new Error('模型请求了过多搜索，请缩小问题范围后重试。')
      const call = calls.get(partial.index) ?? {
        id: '',
        type: 'function',
        function: { name: '', arguments: '' }
      }
      if (partial.id) call.id = partial.id
      if (partial.function?.name) call.function.name += partial.function.name
      if (partial.function?.arguments) call.function.arguments += partial.function.arguments
      if (call.function.arguments.length > 20000) throw new Error('搜索请求过长')
      calls.set(partial.index, call)
    }
  }

  function line(value: string): void {
    const clean = value.replace(/\r$/, '')
    if (!clean) {
      dispatch()
      return
    }
    if (clean.startsWith('data:')) {
      dataLength += clean.length
      if (dataLength > 256000) throw new Error('回答流数据异常，已停止读取。')
      dataLines.push(clean.slice(5).replace(/^ /, ''))
    }
  }

  try {
    signal.throwIfAborted()
    while (!doneMarker) {
      const { value, done } = await reader.read()
      signal.throwIfAborted()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      if (buffer.length > 256000) throw new Error('回答流数据异常，已停止读取。')
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0 && !doneMarker) {
        line(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
      }
      if (done) {
        if (buffer) line(buffer)
        dispatch()
        break
      }
    }
    if (!doneMarker && !result.finishReason) throw new Error('连接中断，已保留收到的回答。请重试。')
    result.toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call)
    if (!result.content.trim() && !result.toolCalls.length)
      throw new Error('模型没有返回回答，请重试。')
    return result
  } finally {
    signal.removeEventListener('abort', abort)
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
