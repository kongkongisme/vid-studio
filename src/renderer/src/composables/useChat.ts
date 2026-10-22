import { ref, watch, onScopeDispose, type Ref } from 'vue'
import {
  MAX_CHAT_INPUT,
  MAX_CHAT_MESSAGES,
  MAX_CHAT_CHARACTERS,
  recentChatContext,
  toChatQuote,
  validateConversation,
  type ChatMessage,
  type ChatQuote,
  type ChatRequest,
  type ChatResult,
  type ChatEvent
} from '../../../shared/chat'
import type { TimelineExportLlmProvider } from '../../../shared/export'

export interface ChatApi {
  getConversation: (sourceKey: string) => Promise<ChatMessage[]>
  saveConversation: (sourceKey: string, messages: ChatMessage[]) => Promise<void>
  chatWithVideo: (request: ChatRequest) => Promise<ChatResult>
  stopChat: (requestId: string) => Promise<void>
  onChatEvent: (callback: (event: ChatEvent) => void) => () => void
}

interface SendOptions {
  text: string
  quotedChunk?: ChatQuote
  systemPrompt: string
  provider: TimelineExportLlmProvider
}
interface ChatRun {
  id: string
  key: string
  messages: ChatMessage[]
  assistantId: string
  unsubscribe: () => void
  timer?: ReturnType<typeof setTimeout>
}
export interface ChatState {
  messages: Ref<ChatMessage[]>
  loading: Ref<boolean>
  restoring: Ref<boolean>
  loadError: Ref<string>
  saveError: Ref<string>
  actionError: Ref<string>
  saveStatus: Ref<'idle' | 'saving' | 'saved' | 'error'>
  load: () => Promise<void>
  save: () => Promise<void>
  send: (options: SendOptions) => Promise<ChatResult | undefined>
  retry: (
    messageId: string,
    options: Pick<SendOptions, 'systemPrompt' | 'provider'>
  ) => Promise<ChatResult | undefined>
  stop: () => void
  clear: () => Promise<void>
}

export function useChat(source: Ref<string>, api: ChatApi, onEvent?: () => void): ChatState {
  const messages = ref<ChatMessage[]>([])
  const loading = ref(false)
  const restoring = ref(false)
  const loadError = ref('')
  const saveError = ref('')
  const actionError = ref('')
  const saveStatus = ref<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const drafts = new Map<string, ChatMessage[]>()
  const pending = new Map<string, Promise<void>>()
  const revisions = new Map<string, symbol>()
  let generation = 0
  let loadedKey = ''
  let active: ChatRun | null = null

  async function persist(key: string, input: ChatMessage[]): Promise<void> {
    if (!key) return
    let snapshot: ChatMessage[]
    try {
      snapshot = validateConversation(key, input)
    } catch (error) {
      revisions.set(key, Symbol())
      if (source.value === key) {
        saveError.value = String(error)
        saveStatus.value = 'error'
      }
      // Keep the in-memory data available for export if a size limit prevents saving.
      drafts.set(
        key,
        input.map((message) => ({ ...message }))
      )
      return
    }
    const revision = Symbol()
    revisions.set(key, revision)
    drafts.set(key, snapshot)
    if (source.value === key) {
      saveStatus.value = 'saving'
      saveError.value = ''
    }
    const operation = (pending.get(key) ?? Promise.resolve())
      .then(async () => {
        if (revisions.get(key) !== revision) return
        await api.saveConversation(key, snapshot)
        if (revisions.get(key) === revision) {
          drafts.delete(key)
          if (source.value === key) {
            saveStatus.value = 'saved'
            saveError.value = ''
          }
        }
      })
      .catch((error) => {
        if (source.value === key && revisions.get(key) === revision) {
          saveStatus.value = 'error'
          saveError.value = `对话尚未保存：${String(error)}`
        }
      })
    pending.set(key, operation)
    await operation
    if (pending.get(key) === operation) pending.delete(key)
  }

  function cleanup(run: ChatRun): void {
    clearTimeout(run.timer)
    run.unsubscribe()
  }

  function stop(): void {
    const run = active
    if (!run) return
    active = null
    cleanup(run)
    const assistant = run.messages.find((message) => message.id === run.assistantId)
    if (assistant) assistant.status = 'stopped'
    loading.value = false
    void persist(run.key, run.messages)
    void api.stopChat(run.id).catch((error) => {
      if (source.value === run.key) actionError.value = `无法确认停止请求：${String(error)}`
    })
  }

  async function load(): Promise<void> {
    stop()
    const ticket = ++generation
    const key = source.value
    loadedKey = ''
    messages.value = []
    loadError.value = ''
    saveError.value = ''
    actionError.value = ''
    saveStatus.value = 'idle'
    restoring.value = Boolean(key)
    if (!key) return
    try {
      await pending.get(key)
      const draft = drafts.get(key)
      const saved = draft ?? (await api.getConversation(key))
      if (ticket !== generation || source.value !== key) return
      messages.value = saved.map((message) => ({ ...message }))
      loadedKey = key
      if (draft) {
        saveError.value = '已恢复本次会话中尚未保存的对话，请重试保存。'
        saveStatus.value = 'error'
      } else saveStatus.value = saved.length ? 'saved' : 'idle'
    } catch (error) {
      if (ticket === generation) loadError.value = `无法恢复对话：${String(error)}`
    } finally {
      if (ticket === generation) restoring.value = false
    }
  }

  async function send(options: SendOptions): Promise<ChatResult | undefined> {
    if (
      loading.value ||
      restoring.value ||
      loadError.value ||
      !source.value ||
      loadedKey !== source.value
    )
      return
    const text = options.text.trim()
    if (!text) return
    if (text.length > MAX_CHAT_INPUT) {
      actionError.value = `问题不能超过 ${MAX_CHAT_INPUT} 个字`
      return
    }
    if (messages.value.length + 2 > MAX_CHAT_MESSAGES) {
      actionError.value = '对话已达到 1,000 条，请导出后清空再继续。'
      return
    }
    if (JSON.stringify(messages.value).length > MAX_CHAT_CHARACTERS) {
      actionError.value = '对话内容过大，请导出备份后清空再继续。'
      return
    }
    actionError.value = ''
    const prior = recentChatContext(messages.value)
    const user: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      createdAt: Date.now(),
      status: 'complete',
      ...(options.quotedChunk ? { quotedChunk: toChatQuote(options.quotedChunk) } : {})
    }
    const assistant: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      status: 'streaming'
    }
    messages.value = [...messages.value, user, assistant]
    const run: ChatRun = {
      id: crypto.randomUUID(),
      key: source.value,
      messages: messages.value,
      assistantId: assistant.id,
      unsubscribe: () => undefined
    }
    active = run
    loading.value = true
    try {
      run.unsubscribe = api.onChatEvent((event) => {
        if (active !== run || source.value !== run.key || event.requestId !== run.id) return
        const target = run.messages.find((message) => message.id === run.assistantId)
        if (!target) return
        if (event.type === 'search') target.searchQuery = event.text.slice(0, 1000)
        else target.content += event.text
        if (!run.timer)
          run.timer = setTimeout(() => {
            run.timer = undefined
            void persist(run.key, run.messages)
          }, 1000)
        onEvent?.()
      })
      void persist(run.key, run.messages)
      onEvent?.()
      const prefix = user.quotedChunk
        ? `[引用片段 ${user.quotedChunk.startTime}: ${user.quotedChunk.title}]\n`
        : ''
      const response = await api.chatWithVideo({
        requestId: run.id,
        provider: options.provider,
        messages: [
          { role: 'system', content: options.systemPrompt },
          ...prior,
          { role: 'user', content: prefix + text }
        ]
      })
      if (active !== run || source.value !== run.key) return
      const target = run.messages.find((message) => message.id === run.assistantId)!
      target.status = response.canceled ? 'stopped' : response.success ? 'complete' : 'error'
      target.error = response.error
      return response
    } catch (error) {
      if (active !== run || source.value !== run.key) return
      const target = run.messages.find((message) => message.id === run.assistantId)!
      target.status = 'error'
      target.error = String(error).slice(0, 2000)
      return { success: false, error: target.error }
    } finally {
      cleanup(run)
      if (active === run) {
        active = null
        loading.value = false
        await persist(run.key, run.messages)
        onEvent?.()
      }
    }
  }

  async function retry(
    messageId: string,
    options: Pick<SendOptions, 'systemPrompt' | 'provider'>
  ): Promise<ChatResult | undefined> {
    if (loading.value || restoring.value || loadError.value || loadedKey !== source.value) return
    const assistant = messages.value.at(-1)
    const user = messages.value.at(-2)
    if (
      assistant?.id !== messageId ||
      !['error', 'stopped'].includes(assistant.status) ||
      user?.role !== 'user'
    )
      return
    if (user.content.length > MAX_CHAT_INPUT) {
      actionError.value = '问题过长，请精简后重新发送。'
      return
    }
    messages.value = messages.value.slice(0, -2)
    return send({ ...options, text: user.content, quotedChunk: user.quotedChunk })
  }

  async function clear(): Promise<void> {
    if (restoring.value || loadError.value || loadedKey !== source.value) return
    stop()
    messages.value = []
    await persist(source.value, [])
  }

  watch(source, load, { immediate: true })
  onScopeDispose(() => {
    generation++
    stop()
  })
  return {
    messages,
    loading,
    restoring,
    loadError,
    saveError,
    actionError,
    saveStatus,
    load,
    send,
    retry,
    stop,
    clear,
    save: () => persist(source.value, messages.value)
  }
}
