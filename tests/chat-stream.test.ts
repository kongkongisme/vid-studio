import { describe, expect, it, vi } from 'vitest'
import { readChatStream } from '../src/main/chat-stream'
import { ChatRequests } from '../src/main/chat-requests'

function response(text: string, byteByByte = false): Response {
  const bytes = new TextEncoder().encode(text)
  return new Response(
    new ReadableStream({
      start(controller) {
        if (byteByByte) for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
        else controller.enqueue(bytes)
        controller.close()
      }
    })
  )
}
const frame = (delta: object, finish_reason: string | null = null): string =>
  `data: ${JSON.stringify({ model: 'example-model', choices: [{ delta, finish_reason }] })}\r\n\r\n`

describe('chat SSE transport', () => {
  it('preserves Chinese UTF-8 across arbitrary byte and CRLF boundaries', async () => {
    const onDelta = vi.fn()
    const result = await readChatStream(
      response(
        ': keepalive\r\n\r\n' +
          frame({ content: '原文证据 [00:32]' }) +
          frame({ content: '与解释' }, 'stop') +
          'data:[DONE]\n\n',
        true
      ),
      new AbortController().signal,
      onDelta
    )
    expect(result.content).toBe('原文证据 [00:32]与解释')
    expect(result.responseModel).toBe('example-model')
    expect(onDelta.mock.calls.flat()).toEqual(['原文证据 [00:32]', '与解释'])
  })

  it('flushes a valid final frame without a trailing newline', async () => {
    const body = `data:${JSON.stringify({ choices: [{ delta: { content: '最后一句' }, finish_reason: 'stop' }] })}`
    const result = await readChatStream(
      response(body),
      new AbortController().signal,
      () => undefined
    )
    expect(result.content).toBe('最后一句')
  })

  it('reports an abrupt disconnect while keeping delivered partial content', async () => {
    const onDelta = vi.fn()
    await expect(
      readChatStream(
        response(frame({ content: '已经收到的内容' })),
        new AbortController().signal,
        onDelta
      )
    ).rejects.toThrow('连接中断')
    expect(onDelta).toHaveBeenCalledWith('已经收到的内容')
  })

  it('assembles multiple indexed tool calls and fragmented arguments', async () => {
    const text =
      frame({
        tool_calls: [
          { index: 1, id: 'b', function: { name: 'web_search', arguments: '{"query":' } },
          { index: 0, id: 'a', function: { name: 'web_search', arguments: '{"query":"A"}' } }
        ]
      }) + frame({ tool_calls: [{ index: 1, function: { arguments: '"B"}' } }] }, 'tool_calls')
    const result = await readChatStream(
      response(text),
      new AbortController().signal,
      () => undefined
    )
    expect(
      result.toolCalls.map((call) => [call.id, JSON.parse(call.function.arguments).query])
    ).toEqual([
      ['a', 'A'],
      ['b', 'B']
    ])
  })

  it('cancels a reader stalled between chunks', async () => {
    const controller = new AbortController()
    const canceled = vi.fn()
    const stream = new Response(new ReadableStream({ cancel: canceled }))
    const reading = readChatStream(stream, controller.signal, () => undefined)
    controller.abort(new DOMException('stopped', 'AbortError'))
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' })
    expect(canceled).toHaveBeenCalledTimes(1)
  })

  it('rejects malformed, empty and provider-error responses', async () => {
    const signal = new AbortController().signal
    await expect(
      readChatStream(response('data: {broken}\n\n'), signal, () => undefined)
    ).rejects.toThrow('无法读取')
    await expect(
      readChatStream(response('data: [DONE]\n\n'), signal, () => undefined)
    ).rejects.toThrow('没有返回')
    await expect(
      readChatStream(
        response('data: {"error":{"message":"quota exhausted"}}\n\n'),
        signal,
        () => undefined
      )
    ).rejects.toThrow('quota exhausted')
  })
})

describe('chat request ownership', () => {
  it('isolates renderers and ignores stale cancellation or completion', () => {
    const requests = new ChatRequests()
    const a = requests.begin(1, 'a')
    const b = requests.begin(2, 'b')
    const newer = requests.begin(1, 'new')
    expect(a.signal.aborted).toBe(true)
    requests.cancel(1, 'a')
    a.finish()
    expect(newer.signal.aborted).toBe(false)
    expect(b.signal.aborted).toBe(false)
    requests.cancel(1, 'new')
    expect(newer.signal.aborted).toBe(true)
    b.finish()
    newer.finish()
  })
})
