import type { TimelineChunk } from './timeline'

export interface ReadingPositionInput {
  sourceKey: string
  chunkId: string
  seconds: number
}

export interface ReadingPosition extends ReadingPositionInput {
  updatedAt: number
}

export function validateReadingSource(sourceKey: string): void {
  if (typeof sourceKey !== 'string' || !sourceKey || sourceKey.length > 4096)
    throw new Error('资料标识无效')
}

export function validateReadingPosition(input: ReadingPositionInput): void {
  if (!input || typeof input !== 'object') throw new Error('阅读位置格式无效')
  validateReadingSource(input.sourceKey)
  if (typeof input.chunkId !== 'string' || !input.chunkId || input.chunkId.length > 500)
    throw new Error('片段标识无效')
  if (!Number.isFinite(input.seconds) || input.seconds < 0) throw new Error('阅读时间无效')
}

export function findReadingChunk(
  position: ReadingPositionInput,
  chunks: TimelineChunk[]
): TimelineChunk | undefined {
  return (
    chunks.find((chunk) => chunk.id === position.chunkId) ??
    chunks.find(
      (chunk) => chunk.startSeconds <= position.seconds && position.seconds <= chunk.endSeconds
    )
  )
}
