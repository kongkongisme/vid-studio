import type {
  TimelineExportPayload,
  TimelineExportReceipt,
  TimelineExportResult
} from '../shared/export'
import { safeExportFilename } from '../shared/timeline-formats'

interface PdfExportServices {
  chooseFile: (filename: string) => Promise<string | null>
  suggestTitle: (
    payload: TimelineExportPayload
  ) => Promise<{ title: string; receipt: TimelineExportReceipt }>
  writePdf: (payload: TimelineExportPayload, filePath: string) => Promise<void>
}

/** Choosing a file is the last gate before optional model work. Offline is the default. */
export async function exportTimelinePdf(
  payload: TimelineExportPayload,
  services: PdfExportServices
): Promise<TimelineExportResult> {
  try {
    if (!Array.isArray(payload?.chunks) || !payload.chunks.length)
      throw new Error('没有可导出的时间轴内容')
    const title = typeof payload.title === 'string' ? payload.title.trim().slice(0, 200) : ''
    const original = { ...payload, title: title || '视频解析文档' }
    const filePath = await services.chooseFile(`${safeExportFilename(original.title)}.pdf`)
    if (!filePath) return { success: false, canceled: true }
    const suggestion =
      payload.useAiTitle === true ? await services.suggestTitle(original) : undefined
    const document = {
      ...original,
      title: suggestion?.title || original.title,
      includeModelReceipt: payload.includeModelReceipt === true,
      llmReceipt:
        payload.includeModelReceipt === true
          ? (suggestion?.receipt ?? payload.llmReceipt)
          : undefined
    }
    await services.writePdf(document, filePath)
    return { success: true, path: filePath, title: document.title, llmReceipt: suggestion?.receipt }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}
