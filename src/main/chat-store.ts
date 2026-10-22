import type { DatabaseSync } from 'node:sqlite'
import { validateConversation, type ChatMessage } from '../shared/chat'

export class ChatStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS conversations (
      source_key TEXT PRIMARY KEY,
      messages_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`)
  }

  load(sourceKey: string): ChatMessage[] {
    validateConversation(sourceKey, [])
    const row = this.db
      .prepare('SELECT messages_json FROM conversations WHERE source_key = ?')
      .get(sourceKey) as { messages_json: string } | undefined
    if (!row) return []
    try {
      return validateConversation(sourceKey, JSON.parse(row.messages_json)).map((message) =>
        message.status === 'streaming'
          ? { ...message, status: 'stopped', error: '上次生成已中断，已恢复保存的内容。' }
          : message
      )
    } catch (error) {
      throw new Error('无法读取此资料的对话记录，原始数据已保留。', { cause: error })
    }
  }

  save(sourceKey: string, input: ChatMessage[]): void {
    const messages = validateConversation(sourceKey, input)
    this.db
      .prepare(
        `INSERT INTO conversations (source_key, messages_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(source_key) DO UPDATE SET messages_json = excluded.messages_json, updated_at = excluded.updated_at`
      )
      .run(sourceKey, JSON.stringify(messages), Date.now())
  }
}
