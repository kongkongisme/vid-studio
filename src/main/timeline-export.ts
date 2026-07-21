export type TimelineExportLlmProvider = 'deepseek' | 'gpt-5.6-sol'

export interface TimelineExportReceipt {
  purpose: string
  provider: TimelineExportLlmProvider
  requestedModel: string
  responseModel?: string
  endpoint: string
  requestId?: string
  timestamp: string
  durationMs: number
  reasoningEffort?: string
  status: 'success' | 'fallback'
  error?: string
}

export interface TimelineExportChunk {
  startTime: string
  endTime: string
  title: string
  summary: string
  keyPoints: string[]
  tags: string[]
  transcript: { time: string; text: string }[]
}

export interface TimelineExportPayload {
  title: string
  sourceLabel: string
  modeLabel: string
  exportedAt: string
  highlightTerm?: string
  includeTranscript: boolean
  llmProvider: TimelineExportLlmProvider
  llmReceipt?: TimelineExportReceipt
  chunks: TimelineExportChunk[]
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function renderHighlightedText(value: string, highlightTerm = ''): string {
  const escaped = escapeHtml(value)
  const term = highlightTerm.trim()
  if (!term) return escaped
  return escaped.replace(new RegExp(`(${escapeRegExp(escapeHtml(term))})`, 'gi'), '<mark>$1</mark>')
}

export function buildTimelineExportHtml(payload: TimelineExportPayload): string {
  const title = payload.title.trim() || '视频解析文档'
  const highlightTerm = payload.highlightTerm?.trim() ?? ''
  const receipt = payload.llmReceipt
  const receiptHtml = receipt
    ? `<section class="receipt">
        <div class="receipt-title">模型调用凭证 <span class="receipt-status ${receipt.status}">${receipt.status === 'success' ? '接口已响应' : '已降级'}</span></div>
        <div class="receipt-grid">
          <div><b>用途</b><p>${escapeHtml(receipt.purpose)}</p></div>
          <div><b>请求模型</b><p>${escapeHtml(receipt.requestedModel)}</p></div>
          <div><b>响应模型</b><p>${escapeHtml(receipt.responseModel || '接口未返回')}</p></div>
          <div><b>耗时</b><p>${receipt.durationMs} ms</p></div>
          <div class="wide"><b>Endpoint</b><p>${escapeHtml(receipt.endpoint || '未建立模型连接')}</p></div>
          <div class="wide"><b>Request ID</b><p>${escapeHtml(receipt.requestId || '接口未提供')}</p></div>
        </div>
        <p class="receipt-note">该凭证记录应用实际发送的模型参数及接口自报信息；第三方代理是否运行对应底层模型，仍需服务商日志或签名证明。</p>
      </section>`
    : ''
  const tableOfContents = payload.chunks
    .map(
      (chunk, index) => `
        <a class="toc-item" href="#section-${index + 1}">
          <span class="toc-index">${String(index + 1).padStart(2, '0')}</span>
          <span class="toc-copy">
            <strong>${renderHighlightedText(chunk.title, highlightTerm)}</strong>
            <small>${escapeHtml(chunk.startTime)} - ${escapeHtml(chunk.endTime)}</small>
          </span>
          <span class="toc-arrow">→</span>
        </a>`
    )
    .join('')
  const chunks = payload.chunks
    .map((chunk, index) => {
      const keyPoints = chunk.keyPoints
        .map((point) => `<li>${renderHighlightedText(point, highlightTerm)}</li>`)
        .join('')
      const tags = chunk.tags
        .map((tag) => `<span>${renderHighlightedText(tag, highlightTerm)}</span>`)
        .join('')
      const transcript = payload.includeTranscript
        ? chunk.transcript
            .map(
              (line) =>
                `<div class="transcript-line"><b>${escapeHtml(line.time)}</b><p>${renderHighlightedText(
                  line.text,
                  highlightTerm
                )}</p></div>`
            )
            .join('')
        : ''

      return `
        <section class="chunk${transcript ? ' with-transcript' : ''}" aria-labelledby="section-${index + 1}">
          <div class="chunk-index">${String(index + 1).padStart(2, '0')}</div>
          <div class="chunk-body">
            <div class="time">${escapeHtml(chunk.startTime)} - ${escapeHtml(chunk.endTime)}</div>
            <h2 id="section-${index + 1}">${renderHighlightedText(chunk.title, highlightTerm)}</h2>
            ${chunk.summary ? `<p class="summary">${renderHighlightedText(chunk.summary, highlightTerm)}</p>` : ''}
            ${keyPoints ? `<ul>${keyPoints}</ul>` : ''}
            ${tags ? `<div class="tags">${tags}</div>` : ''}
            ${transcript ? `<div class="transcript"><div class="transcript-title">原文记录</div>${transcript}</div>` : ''}
          </div>
        </section>`
    })
    .join('')

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    @page { size: A4; margin: 20mm 18mm 22mm; }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      color: #172033;
      font-family: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      background: #f8fafc;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    body::before {
      content: "视析工作站";
      position: fixed;
      inset: 0;
      z-index: 0;
      color: rgba(15, 23, 42, 0.055);
      font-size: 54px;
      font-weight: 700;
      letter-spacing: 0.18em;
      display: grid;
      place-items: center;
      transform: rotate(-28deg);
      pointer-events: none;
    }
    main { position: relative; z-index: 1; background: white; padding: 28px 30px 34px; }
    .front-matter { break-after: page; }
    header {
      border-bottom: 1px solid #dbe3ef;
      padding-bottom: 18px;
      margin-bottom: 20px;
    }
    .brand { color: #2563eb; font-size: 13px; font-weight: 700; letter-spacing: 0.16em; }
    h1 { margin: 8px 0 12px; font-size: 30px; line-height: 1.25; letter-spacing: 0; }
    .meta { display: flex; flex-wrap: wrap; gap: 8px; color: #64748b; font-size: 12px; }
    .meta span {
      border: 1px solid #dbe3ef;
      border-radius: 999px;
      padding: 5px 10px;
      background: #f8fafc;
    }
    .notice {
      margin-top: 14px;
      border-left: 3px solid #2563eb;
      padding: 8px 12px;
      color: #475569;
      background: #eff6ff;
      font-size: 12px;
      line-height: 1.6;
    }
    .toc {
      margin-top: 20px;
      border: 1px solid #dbe3ef;
      border-radius: 12px;
      background: #f8fafc;
      padding: 18px 20px 10px;
      break-inside: auto;
    }
    .toc-heading { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 8px; }
    .toc-heading strong { color: #172033; font-size: 18px; }
    .toc-heading span { color: #94a3b8; font-size: 10px; letter-spacing: 0.12em; }
    .toc-item {
      display: grid;
      grid-template-columns: 34px 1fr 18px;
      gap: 10px;
      align-items: center;
      min-height: 54px;
      padding: 10px 0;
      color: inherit;
      text-decoration: none;
      border-top: 1px solid #e2e8f0;
      break-inside: avoid;
    }
    .toc-index {
      display: grid;
      place-items: center;
      width: 28px;
      height: 28px;
      border-radius: 8px;
      color: #2563eb;
      background: #eaf2ff;
      font: 700 10px ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .toc-copy { display: grid; gap: 3px; min-width: 0; }
    .toc-copy strong { color: #1e293b; font-size: 13px; line-height: 1.45; }
    .toc-copy small {
      color: #64748b;
      font: 10px ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .toc-arrow { color: #93a7c2; font-size: 14px; text-align: right; }
    .content { break-before: page; }
    .chunk { display: grid; grid-template-columns: 44px 1fr; gap: 14px; padding: 18px 0; break-inside: avoid; }
    .chunk + .chunk { border-top: 1px solid #e2e8f0; }
    .chunk-index {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      color: #2563eb;
      background: #eff6ff;
      font-weight: 700;
      font-size: 12px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .time {
      color: #2563eb;
      font-size: 12px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      margin-bottom: 5px;
    }
    h2 { margin: 0 0 8px; font-size: 18px; line-height: 1.4; letter-spacing: 0; scroll-margin-top: 20px; }
    .summary { margin: 0 0 10px; color: #475569; font-size: 13px; line-height: 1.75; }
    ul { margin: 8px 0 10px; padding-left: 18px; }
    li { margin: 5px 0; color: #334155; font-size: 13px; line-height: 1.65; }
    .tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
    .tags span {
      color: #475569;
      background: #f1f5f9;
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      padding: 3px 7px;
      font-size: 11px;
    }
    .chunk.with-transcript { break-inside: auto; }
    .transcript {
      margin-top: 12px;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      background: #f8fafc;
      padding: 9px 11px;
      break-inside: auto;
    }
    .transcript-title { color: #64748b; font-size: 12px; font-weight: 600; }
    .transcript-line { display: grid; grid-template-columns: 52px 1fr; gap: 8px; margin-top: 8px; }
    .transcript-line b {
      color: #2563eb;
      font-size: 10px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-weight: 600;
    }
    .transcript-line p { margin: 0; color: #475569; font-size: 11px; line-height: 1.55; }
    .receipt {
      margin: 0 0 18px;
      border: 1px solid #bfdbfe;
      border-radius: 10px;
      background: #f8fbff;
      padding: 12px 14px;
      break-inside: avoid;
    }
    .receipt-title { color: #1e3a8a; font-size: 13px; font-weight: 700; }
    .receipt-status {
      margin-left: 6px;
      border-radius: 999px;
      padding: 2px 7px;
      font-size: 10px;
    }
    .receipt-status.success { color: #166534; background: #dcfce7; }
    .receipt-status.fallback { color: #92400e; background: #fef3c7; }
    .receipt-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 14px; margin-top: 10px; }
    .receipt-grid .wide { grid-column: 1 / -1; }
    .receipt-grid b { color: #64748b; font-size: 10px; font-weight: 600; }
    .receipt-grid p { margin: 2px 0 0; color: #1e293b; font-size: 11px; line-height: 1.45; overflow-wrap: anywhere; }
    .receipt-note { margin: 10px 0 0; color: #64748b; font-size: 10px; line-height: 1.5; }
    mark { background: #fef08a; color: inherit; padding: 0 2px; border-radius: 2px; }
    footer {
      margin-top: 22px;
      padding-top: 12px;
      border-top: 1px solid #e2e8f0;
      color: #94a3b8;
      font-size: 11px;
      text-align: center;
    }
  </style>
</head>
<body>
  <main>
    <div class="front-matter">
      <header>
        <div class="brand">VIDSTUDIO · 视析工作站</div>
        <h1>${escapeHtml(title)}</h1>
        <div class="meta">
          <span>${escapeHtml(payload.sourceLabel)}</span>
          <span>${escapeHtml(payload.modeLabel)}</span>
          <span>${escapeHtml(payload.exportedAt)}</span>
          <span>共 ${payload.chunks.length} 个片段</span>
        </div>
        <div class="notice">本文档由视析工作站根据视频解析内容生成，${payload.includeTranscript ? '包含原文记录，' : '未包含原文记录，'}导出为 PDF 以便查阅和归档。目录条目可点击跳转，阅读器侧边栏同时提供章节书签。</div>
      </header>
      ${receiptHtml}
      <nav class="toc" aria-label="文档目录">
        <div class="toc-heading"><strong>目录</strong><span>CONTENTS</span></div>
        ${tableOfContents}
      </nav>
    </div>
    <div class="content">
      ${chunks}
    </div>
    <footer>视析工作站 · VidStudio</footer>
  </main>
</body>
</html>`
}
