export const MAX_NOTE_LENGTH = 20000

export interface AnnotationInput {
  sourceKey: string
  chunkId: string
  startSeconds: number
  title: string
  bookmarked: boolean
  note: string
}

export interface ChunkAnnotation extends AnnotationInput {
  updatedAt: number
}

export function validateAnnotation(value: AnnotationInput): void {
  if (!value || typeof value !== 'object') throw new Error('笔记格式无效')
  if (typeof value.sourceKey !== 'string' || !value.sourceKey || value.sourceKey.length > 4096)
    throw new Error('资料标识无效')
  if (typeof value.chunkId !== 'string' || !value.chunkId || value.chunkId.length > 500)
    throw new Error('片段标识无效')
  if (typeof value.title !== 'string' || value.title.length > 2000) throw new Error('片段标题过长')
  if (!Number.isFinite(value.startSeconds) || value.startSeconds < 0)
    throw new Error('片段时间无效')
  if (typeof value.bookmarked !== 'boolean') throw new Error('收藏状态无效')
  if (typeof value.note !== 'string' || value.note.length > MAX_NOTE_LENGTH)
    throw new Error(`笔记不能超过 ${MAX_NOTE_LENGTH.toLocaleString('en-US')} 字`)
}
