import { describe, expect, it, vi, type Mock } from 'vitest'
import { exportTimelinePdf } from '../src/main/pdf-export'
import { buildTimelineExportHtml } from '../src/main/timeline-export'
import type { TimelineExportPayload, TimelineExportReceipt } from '../src/shared/export'

const receipt: TimelineExportReceipt = {
  purpose: '标题',
  provider: 'deepseek',
  requestedModel: 'test-model',
  endpoint: 'https://private.example/v1',
  timestamp: '',
  durationMs: 10,
  status: 'success',
  requestId: 'private-request'
}
const payload: TimelineExportPayload = {
  title: '我的课程笔记',
  sourceLabel: '测试资料',
  sourceKind: 'subtitle',
  modeLabel: '导入',
  exportedAt: '',
  includeTranscript: true,
  llmProvider: 'deepseek',
  llmReceipt: receipt,
  chunks: [
    {
      startTime: '00:01',
      endTime: '00:05',
      title: '章节一',
      summary: '',
      keyPoints: [],
      tags: [],
      transcript: []
    }
  ]
}
function services(): {
  chooseFile: Mock<() => Promise<string | null>>
  suggestTitle: Mock<() => Promise<{ title: string; receipt: TimelineExportReceipt }>>
  writePdf: Mock<() => Promise<void>>
} {
  return {
    chooseFile: vi.fn(async () => '/tmp/test.pdf' as string | null),
    suggestTitle: vi.fn(async () => ({ title: 'AI 建议标题', receipt })),
    writePdf: vi.fn(async () => undefined)
  }
}

describe('offline PDF export', () => {
  it('does not call a model or expose provider metadata by default', async () => {
    const api = services()
    expect(await exportTimelinePdf(payload, api)).toMatchObject({
      success: true,
      title: '我的课程笔记'
    })
    expect(api.suggestTitle).not.toHaveBeenCalled()
    expect(api.writePdf).toHaveBeenCalledWith(
      expect.objectContaining({ title: '我的课程笔记', llmReceipt: undefined }),
      '/tmp/test.pdf'
    )
    const html = buildTimelineExportHtml(payload)
    expect(html).not.toContain('private.example')
    expect(html).not.toContain('private-request')
    expect(html).toContain('未生成 AI 摘要')
  })

  it('never spends a model request when the save dialog is canceled', async () => {
    const api = services()
    api.chooseFile.mockResolvedValue(null)
    expect(await exportTimelinePdf({ ...payload, useAiTitle: true }, api)).toEqual({
      success: false,
      canceled: true
    })
    expect(api.suggestTitle).not.toHaveBeenCalled()
    expect(api.writePdf).not.toHaveBeenCalled()
  })

  it('generates a title only after choosing the file and includes receipts only when selected', async () => {
    const api = services()
    const result = await exportTimelinePdf(
      { ...payload, useAiTitle: true, includeModelReceipt: true },
      api
    )
    expect(result).toMatchObject({ success: true, title: 'AI 建议标题', llmReceipt: receipt })
    expect(api.chooseFile.mock.invocationCallOrder[0]).toBeLessThan(
      api.suggestTitle.mock.invocationCallOrder[0]
    )
    expect(api.writePdf).toHaveBeenCalledWith(
      expect.objectContaining({ llmReceipt: receipt }),
      '/tmp/test.pdf'
    )
    expect(buildTimelineExportHtml({ ...payload, includeModelReceipt: true })).toContain(
      'private.example'
    )
  })

  it('reports write failures and rejects empty documents before showing a save dialog', async () => {
    const api = services()
    api.writePdf.mockRejectedValue(new Error('disk is full'))
    expect(await exportTimelinePdf(payload, api)).toEqual({
      success: false,
      error: 'Error: disk is full'
    })
    api.chooseFile.mockClear()
    expect((await exportTimelinePdf({ ...payload, chunks: [] }, api)).success).toBe(false)
    expect(api.chooseFile).not.toHaveBeenCalled()
  })
})
