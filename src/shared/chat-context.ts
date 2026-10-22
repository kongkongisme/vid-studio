import type { TimelineChunk } from './timeline'

function queryTerms(question: string): string[] {
  const words = question.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  const terms = words.flatMap((word) => {
    if (/\p{Script=Han}/u.test(word) && word.length > 2) {
      return [
        word,
        ...Array.from({ length: word.length - 1 }, (_, index) => word.slice(index, index + 2))
      ]
    }
    return word.length > 1 ? [word] : []
  })
  return [...new Set(terms)].slice(0, 100)
}

function relevance(value: string, terms: string[]): number {
  const text = value.toLowerCase()
  return terms.reduce(
    (score, term) => score + (text.includes(term) ? Math.min(term.length, 8) : 0),
    0
  )
}

function excerpt(value: string, terms: string[], length: number): string {
  if (value.length <= length) return value
  const match = [...terms]
    .sort((a, b) => b.length - a.length)
    .find((term) => value.toLowerCase().includes(term))
  const position = match ? value.toLowerCase().indexOf(match) : 0
  const start = Math.max(0, position - Math.floor(length / 3))
  return `${start ? '…' : ''}${value.slice(start, start + length)}${start + length < value.length ? '…' : ''}`
}

/** Build a bounded, source-backed context locally; no embeddings or network calls are needed. */
export function buildVideoContext(
  chunks: TimelineChunk[],
  question: string,
  preferredId?: string
): string {
  const terms = queryTerms(question.slice(0, 2000))
  const overview = chunks
    .map((chunk) => `[${chunk.startTime}-${chunk.endTime}] ${chunk.title}：${chunk.summary}`)
    .join('\n')
    .slice(0, 6000)
  const selected = chunks
    .map((chunk, index) => ({
      chunk,
      index,
      score:
        relevance(
          [chunk.title, chunk.summary, ...chunk.keyPoints, ...chunk.tags].join(' '),
          terms
        ) *
          3 +
        relevance(chunk.transcript.map((line) => line.text).join(' '), terms) +
        (chunk.id === preferredId ? 10000 : 0)
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 6)
    .sort((a, b) => a.index - b.index)

  const excerpts = selected
    .map(({ chunk }) => {
      const ranked = chunk.transcript
        .map((line, index) => ({ index, score: relevance(line.text, terms) }))
        .sort((a, b) => b.score - a.score || a.index - b.index)
      const indices = new Set<number>()
      // Prioritize matching sentences and their neighbours before applying the character budget.
      for (const match of ranked.slice(0, 6)) {
        for (const index of [match.index - 1, match.index, match.index + 1]) {
          if (index >= 0 && index < chunk.transcript.length) indices.add(index)
        }
      }
      const lineBudget = Math.max(60, Math.floor(2100 / Math.max(1, indices.size)) - 20)
      const transcript = [...indices]
        .sort((a, b) => a - b)
        .map(
          (index) =>
            `[${chunk.transcript[index].time}] ${excerpt(chunk.transcript[index].text, terms, lineBudget)}`
        )
        .join('\n')
      return `[${chunk.startTime}-${chunk.endTime}] ${chunk.title.slice(0, 120)}\n${chunk.summary.slice(0, 200)}\n${chunk.keyPoints
        .slice(0, 3)
        .map((point) => point.slice(0, 100))
        .join('\n')}\n原文摘录：\n${transcript}`.slice(0, 3000)
    })
    .join('\n\n')

  return `资料时间轴（共 ${chunks.length} 个片段，长目录可能截断）：\n${overview}\n\n与当前问题相关的原文片段（最多 6 段，摘录可能不完整）：\n${excerpts}`
}
