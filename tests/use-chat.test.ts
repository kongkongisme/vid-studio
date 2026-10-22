import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { effectScope, nextTick, ref, type EffectScope, type Ref } from 'vue'
import { useChat, type ChatApi, type ChatState } from '../src/renderer/src/composables/useChat'
import type { ChatEvent, ChatMessage, ChatRequest, ChatResult } from '../src/shared/chat'

const scopes: EffectScope[] = []
afterEach(() => {
  scopes.splice(0).forEach((scope) => scope.stop())
  vi.useRealTimers()
})
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const sendOptions = {
  text: '解释这个观点',
  systemPrompt: '根据当前资料回答',
  provider: 'deepseek' as const
}

type MockChatApi = { [K in keyof ChatApi]: Mock<ChatApi[K]> }
interface TestSetup {
  source: Ref<string>
  state: ChatState
  api: MockChatApi
  requests: Array<{ request: ChatRequest; finish: (result: ChatResult) => void }>
  listeners: Set<(event: ChatEvent) => void>
  storage: Map<string, ChatMessage[]>
  select: (key: string) => Promise<void>
  emit: (index: number, text: string, type?: ChatEvent['type']) => void
}

function setup(storage = new Map<string, ChatMessage[]>()): TestSetup {
  const source = ref('')
  const listeners = new Set<(event: ChatEvent) => void>()
  const requests: Array<{ request: ChatRequest; finish: (result: ChatResult) => void }> = []
  const api: MockChatApi = {
    getConversation: vi.fn(async (key: string) => clone(storage.get(key) ?? [])),
    saveConversation: vi.fn(async (key: string, messages: ChatMessage[]) => {
      storage.set(key, clone(messages))
    }),
    chatWithVideo: vi.fn(
      (request: ChatRequest) =>
        new Promise<ChatResult>((finish) => {
          requests.push({ request, finish })
        })
    ),
    stopChat: vi.fn<ChatApi['stopChat']>(async () => undefined),
    onChatEvent: vi.fn((callback: (event: ChatEvent) => void) => {
      listeners.add(callback)
      return () => {
        listeners.delete(callback)
      }
    })
  } satisfies ChatApi
  const scope = effectScope()
  scopes.push(scope)
  const state = scope.run(() => useChat(source, api))!
  async function select(key: string): Promise<void> {
    source.value = key
    await nextTick()
    await vi.waitFor(() => expect(state.restoring.value).toBe(false))
  }
  function emit(index: number, text: string, type: ChatEvent['type'] = 'delta'): void {
    for (const callback of listeners)
      callback({ requestId: requests[index].request.requestId, type, text })
  }
  return { source, api, state, requests, listeners, storage, select, emit }
}

describe('durable chat state', () => {
  it('saves complete conversations and restores them for the same source', async () => {
    const app = setup()
    await app.select('a')
    const sending = app.state.send(sendOptions)
    app.emit(0, '证据来自 [00:32]。')
    app.requests[0].finish({ success: true })
    await sending
    expect(app.storage.get('a')).toHaveLength(2)
    const restarted = setup(app.storage)
    await restarted.select('a')
    expect(restarted.state.messages.value[1]).toMatchObject({
      content: '证据来自 [00:32]。',
      status: 'complete'
    })
    await restarted.select('b')
    expect(restarted.state.messages.value).toEqual([])
  })

  it('stops a source before switching and ignores late events and completion', async () => {
    const app = setup()
    await app.select('a')
    const sendingA = app.state.send(sendOptions)
    const oldListener = [...app.listeners][0]
    app.emit(0, 'A 的部分回答')
    await app.select('b')
    const sendingB = app.state.send({ ...sendOptions, text: 'B 的问题' })
    oldListener({ requestId: app.requests[0].request.requestId, type: 'delta', text: '迟到的 A' })
    app.emit(0, '不应混进 B')
    app.requests[0].finish({ success: true })
    await sendingA
    expect(app.state.loading.value).toBe(true)
    expect(app.state.messages.value[1].content).toBe('')
    app.emit(1, 'B 的回答')
    app.requests[1].finish({ success: true })
    await sendingB
    expect(app.storage.get('a')?.[1]).toMatchObject({ content: 'A 的部分回答', status: 'stopped' })
    expect(app.storage.get('b')?.[1].content).toBe('B 的回答')
    expect(app.api.stopChat).toHaveBeenCalledWith(app.requests[0].request.requestId)
  })

  it('clears safely while streaming and cannot resurrect the removed messages', async () => {
    const app = setup()
    await app.select('a')
    const sending = app.state.send(sendOptions)
    const oldListener = [...app.listeners][0]
    app.emit(0, '已有片段')
    await app.state.clear()
    oldListener({ requestId: app.requests[0].request.requestId, type: 'delta', text: '晚到内容' })
    app.requests[0].finish({ success: false, canceled: true })
    await sending
    expect(app.state.messages.value).toEqual([])
    expect(app.storage.get('a')).toEqual([])
    expect(app.state.loading.value).toBe(false)
    expect(app.listeners.size).toBe(0)
  })

  it('retries only the latest failed answer without duplicating the question', async () => {
    const app = setup()
    await app.select('a')
    const sending = app.state.send(sendOptions)
    app.emit(0, '回答一半')
    app.requests[0].finish({ success: false, error: '网络中断' })
    await sending
    expect(app.state.messages.value[1]).toMatchObject({
      content: '回答一半',
      status: 'error',
      error: '网络中断'
    })
    const oldId = app.state.messages.value[1].id
    const retrying = app.state.retry(oldId, sendOptions)
    expect(app.state.messages.value).toHaveLength(2)
    expect(
      app.requests[1].request.messages.filter((message) => message.role === 'user')
    ).toHaveLength(1)
    app.emit(1, '重新完成的回答')
    app.requests[1].finish({ success: true })
    await retrying
    expect(app.state.messages.value[1]).toMatchObject({
      status: 'complete',
      content: '重新完成的回答'
    })
    expect(app.state.messages.value[1].id).not.toBe(oldId)
  })

  it('retains failed saves across source switches and supports a later retry', async () => {
    const app = setup()
    await app.select('a')
    app.api.saveConversation.mockRejectedValue(new Error('disk full'))
    const sending = app.state.send(sendOptions)
    app.emit(0, '需要保存的回答')
    app.requests[0].finish({ success: true })
    await sending
    expect(app.state.saveStatus.value).toBe('error')
    await app.select('b')
    await app.select('a')
    expect(app.state.messages.value[1].content).toBe('需要保存的回答')
    app.api.saveConversation.mockImplementation(async (key, messages) => {
      app.storage.set(key, clone(messages))
    })
    await app.state.save()
    expect(app.state.saveStatus.value).toBe('saved')
    expect(app.storage.get('a')?.[1].content).toBe('需要保存的回答')
  })

  it('blocks writes on failed restore and ignores late loads from another source', async () => {
    const app = setup()
    app.api.getConversation.mockRejectedValueOnce(new Error('unreadable'))
    await app.select('a')
    await app.state.send(sendOptions)
    expect(app.api.chatWithVideo).not.toHaveBeenCalled()
    expect(app.state.loadError.value).toContain('unreadable')
    let finish!: (messages: ChatMessage[]) => void
    app.api.getConversation.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const loading = app.state.load()
    await vi.waitFor(() => expect(app.api.getConversation).toHaveBeenCalledTimes(2))
    await app.select('b')
    finish([{ id: 'old', role: 'user', content: '迟到的历史', createdAt: 1, status: 'complete' }])
    await loading
    expect(app.state.messages.value).toEqual([])
  })

  it('checkpoints partial streams without waiting for generation to finish', async () => {
    const app = setup()
    await app.select('a')
    vi.useFakeTimers()
    const sending = app.state.send(sendOptions)
    await Promise.resolve()
    app.emit(0, '正在逐步生成')
    await vi.advanceTimersByTimeAsync(1000)
    expect(app.storage.get('a')?.[1]).toMatchObject({
      content: '正在逐步生成',
      status: 'streaming'
    })
    app.state.stop()
    app.requests[0].finish({ success: false, canceled: true })
    await sending
    await app.state.save()
    expect(app.storage.get('a')?.[1].status).toBe('stopped')
  })
})
