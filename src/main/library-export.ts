import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { HistoryItem } from '../shared/history'
import type { ChunkAnnotation } from '../shared/annotations'
import {
  validateLibraryExport,
  type LibraryExportRequest,
  type LibraryExportResult
} from '../shared/library-export'
import { importTimeline, MAX_IMPORT_BYTES } from '../shared/timeline-import'
import { parseTimelineMarkdown } from '../shared/timeline'
import { buildTextExport, safeExportFilename, EXPORT_FORMATS } from '../shared/timeline-formats'

interface ExportDependencies {
  history: () => Promise<HistoryItem[]>
  cache: (source: string) => string | null
  annotations: (source: string) => ChunkAnnotation[]
  chooseDirectory: () => Promise<string | null>
}

interface ExportFile {
  name: string
  content: string
}

/** Publish a complete collection in one rename; failed writes leave no partial collection. */
export async function writeLibraryCollection(
  parent: string,
  files: ExportFile[],
  write: (path: string, content: string) => Promise<unknown> = (path, content) =>
    writeFile(path, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
): Promise<string> {
  const staging = await mkdtemp(join(parent, '.vidstudio-export-'))
  try {
    for (const file of files) await write(join(staging, file.name), file.content)
    const target = join(parent, `VidStudio-${basename(staging).slice('.vidstudio-export-'.length)}`)
    await rename(staging, target)
    return target
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
}

export async function exportLibrary(
  request: LibraryExportRequest,
  dependencies: ExportDependencies
): Promise<LibraryExportResult> {
  try {
    validateLibraryExport(request)
    const history = new Map((await dependencies.history()).map((item) => [item.id, item]))
    const files: ExportFile[] = []
    const index = ['# VidStudio 资料目录', '', `导出时间：${new Date().toISOString()}`, '']
    let bytes = 0
    let outputBytes = 0
    for (const [position, id] of request.ids.entries()) {
      const item = history.get(id)
      if (!item) throw new Error('部分资料已被移除，请刷新资料库后重新选择')
      const content = dependencies.cache(item.url)
      if (!content) throw new Error(`《${item.title}》缺少解析缓存，未导出任何资料`)
      bytes += Buffer.byteLength(content)
      if (bytes > 100 * 1024 * 1024) throw new Error('所选资料超过 100 MB，请分批导出')
      const document = content.trimStart().startsWith('{')
        ? importTimeline('cache.json', content)
        : null
      const chunks = document?.chunks ?? parseTimelineMarkdown(content)
      if (!chunks.length) throw new Error(`《${item.title}》没有有效章节，未导出任何资料`)
      const annotations = request.includeAnnotations ? dependencies.annotations(item.url) : []
      const byId = new Map(annotations.map((annotation) => [annotation.chunkId, annotation]))
      const prefix = `${String(position + 1).padStart(3, '0')}-${safeExportFilename(item.title)}`
      const name = `${prefix}.${EXPORT_FORMATS[request.format].extension}`
      const exported = buildTextExport(
        {
          title: item.title,
          sourceLabel: document?.sourceLabel ?? item.url,
          sourceUrl: document?.sourceUrl ?? (item.platform === 'document' ? undefined : item.url),
          sourceKind: document?.sourceKind ?? 'notes',
          modeLabel:
            item.mode === 'imported'
              ? '导入资料'
              : item.mode === 'visual'
                ? '视觉解析'
                : '语音解析',
          exportedAt: new Date().toISOString(),
          includeTranscript: request.includeTranscript,
          includeAnnotations: request.includeAnnotations,
          llmProvider: 'deepseek',
          chunks: chunks.map((chunk) => {
            const annotation = byId.get(chunk.id)
            return {
              ...chunk,
              userNote: annotation ? annotation.note : chunk.userNote,
              bookmarked: annotation ? annotation.bookmarked : chunk.bookmarked
            }
          })
        },
        request.format
      )
      if (Buffer.byteLength(exported) > MAX_IMPORT_BYTES)
        throw new Error(`《${item.title}》导出后超过 10 MB，无法重新导入，请单独按章节导出`)
      files.push({ name, content: exported })
      outputBytes += Buffer.byteLength(exported)
      const title = item.title
        .replace(/[\r\n]/g, ' ')
        .replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]!)
        .replace(/([\\[\]`*_])/g, '\\$1')
      index.push(`- [${title}](${encodeURIComponent(name)}) · ${chunks.length} 个章节`)
      // Older annotations can outlive regenerated chapters. Keep them in a readable sidecar.
      const chunkIds = new Set(chunks.map((chunk) => chunk.id))
      const old = annotations.filter(
        (note) => !chunkIds.has(note.chunkId) && (note.note || note.bookmarked)
      )
      if (old.length) {
        const notesName = `${prefix}.旧版笔记.json`
        const notesContent = JSON.stringify(old, null, 2) + '\n'
        outputBytes += Buffer.byteLength(notesContent)
        files.push({ name: notesName, content: notesContent })
        index.push(
          `  - [旧版章节笔记](${encodeURIComponent(notesName)})（仅供查阅，不能作为时间轴导入）`
        )
      }
      if (outputBytes > 100 * 1024 * 1024) throw new Error('导出内容超过 100 MB，请分批导出')
    }
    index.push(
      '',
      '各时间轴文件可分别通过「导入资料」重新导入；JSON 保留精确字幕时间，Markdown 方便笔记软件阅读。',
      '仅包含所选资料的章节内容及勾选的原文、笔记。视频文件、聊天记录、阅读位置、账号和模型配置不包含在内。',
      ''
    )
    files.push({ name: '目录.md', content: index.join('\n') })
    const directory = await dependencies.chooseDirectory()
    if (!directory) return { success: false, canceled: true }
    const path = await writeLibraryCollection(directory, files)
    return { success: true, path, count: request.ids.length }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}
