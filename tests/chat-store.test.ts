import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { ChatStore } from '../src/main/chat-store'
import {
  conversationMarkdown,
  recentChatContext,
  validateChatRequest,
  type ChatMessage
} from '../src/shared/chat'

let db: DatabaseSync
let store: ChatStore
const user: ChatMessage = {
  id: 'q1',
  role: 'user',
  content: '这个观点的依据是什么？',
  createdAt: 1,
  status: 'complete'
}
const answer: ChatMessage = {
  id: 'a1',
  role: 'assistant',
  content: '见 [00:32] 的原文。',
  createdAt: 2,
  status: 'complete'
}
beforeEach(() => {
  db = new DatabaseSync(':memory:')
  store = new ChatStore(db)
})
afterEach(() => db.close())

describe('conversation persistence', () => {
  it('keeps conversations by source and survives a new store instance', () => {
    store.save('a', [user, answer])
    store.save('b', [{ ...user, content: '另一个问题' }])
    expect(new ChatStore(db).load('a')).toEqual([user, answer])
    expect(store.load('b')[0].content).toBe('另一个问题')
    store.save('a', [])
    expect(store.load('a')).toEqual([])
    expect(store.load('b')).toHaveLength(1)
  })

  it('recovers saved partial responses as stopped after restart', () => {
    store.save('a', [user, { ...answer, content: '只收到前半段', status: 'streaming' }])
    expect(store.load('a')[1]).toMatchObject({ content: '只收到前半段', status: 'stopped' })
  })

  it('preserves corrupt data and rejects duplicate or invalid messages before writing', () => {
    store.save('a', [user])
    expect(() => store.save('a', [user, user])).toThrow('格式')
    expect(store.load('a')).toEqual([user])
    db.prepare('UPDATE conversations SET messages_json = ? WHERE source_key = ?').run(
      '{broken',
      'a'
    )
    expect(() => store.load('a')).toThrow('原始数据已保留')
    expect(
      db.prepare('SELECT messages_json FROM conversations WHERE source_key = ?').get('a')
    ).toMatchObject({ messages_json: '{broken' })
  })

  it('bounds API context and preserves useful partial replies without sending error metadata', () => {
    const history = [user, { ...answer, status: 'error' as const, error: 'private failure detail' }]
    const context = recentChatContext(history)
    expect(context).toEqual([
      { role: 'user', content: user.content },
      { role: 'assistant', content: answer.content + '\n（此回答未完成）' }
    ])
    expect(JSON.stringify(context)).not.toContain('private failure')
    expect(recentChatContext(history, 1)).toEqual([])
    expect(() =>
      validateChatRequest({
        requestId: 'a',
        provider: 'deepseek',
        messages: [{ role: 'user', content: 'x'.repeat(100001) }]
      })
    ).toThrow('过长')
  })

  it('exports portable content, quoted timestamps and explicit incomplete status', () => {
    const quoted = {
      ...user,
      quotedChunk: {
        id: 'chapter',
        startTime: '00:32',
        endTime: '01:00',
        startSeconds: 32,
        title: '证据',
        summary: '',
        keyPoints: []
      }
    }
    const markdown = conversationMarkdown('课程\n标题', [quoted, { ...answer, status: 'stopped' }])
    expect(markdown).toContain('# 课程 标题 · 对话记录')
    expect(markdown).toContain('> 引用 [00:32] 证据')
    expect(markdown).toContain('助手 · 已停止')
    expect(markdown).toContain(answer.content)
  })
})
