import type { DatabaseSync } from 'node:sqlite'
import {
  validateReadingPosition,
  validateReadingSource,
  type ReadingPosition,
  type ReadingPositionInput
} from '../shared/reading-position'

export class ReadingStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS reading_positions (
        source_key TEXT PRIMARY KEY,
        chunk_id TEXT NOT NULL,
        seconds REAL NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
  }

  load(sourceKey: string): ReadingPosition | null {
    validateReadingSource(sourceKey)
    const row = this.db
      .prepare(
        'SELECT source_key AS sourceKey, chunk_id AS chunkId, seconds, updated_at AS updatedAt FROM reading_positions WHERE source_key = ?'
      )
      .get(sourceKey) as ReadingPosition | undefined
    return row ? { ...row } : null
  }

  save(input: ReadingPositionInput): ReadingPosition {
    validateReadingPosition(input)
    const saved = { ...input, updatedAt: Date.now() }
    this.db
      .prepare(
        `
      INSERT INTO reading_positions (source_key, chunk_id, seconds, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(source_key) DO UPDATE SET
        chunk_id = excluded.chunk_id, seconds = excluded.seconds, updated_at = excluded.updated_at
    `
      )
      .run(saved.sourceKey, saved.chunkId, saved.seconds, saved.updatedAt)
    return saved
  }
}
