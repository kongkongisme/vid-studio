import { describe, expect, it } from 'vitest'
import { formatTimecode, parseTimelineMarkdown, timeToSeconds } from '../src/shared/timeline'

describe('timeline timecodes', () => {
  it('supports long videos and rejects malformed times', () => {
    expect(timeToSeconds('01:02:03')).toBe(3723)
    expect(timeToSeconds('123:45')).toBe(7425)
    for (const time of ['1:99', '-1:00', '1:02:99', 'abc', '1:2', '']) {
      expect(timeToSeconds(time)).toBeNaN()
    }
    expect(formatTimecode(3723.5)).toBe('01:02:03')
  })
})

describe('timeline Markdown', () => {
  it('reads legacy output, CRLF, Unicode tags, and numbered duplicate ranges', () => {
    const markdown =
      '\uFEFF# Lecture\r\n## 00:00 - 02:00 | 标题\r\n' +
      '**一句话总结**： 一句话\r\n**核心观点**\r\n- 观点一\r\n- 观点二\r\n' +
      '**标签**：#机器学习 #résumé #deep-learning\r\n**原文记录**\r\n[00:01] 原文\r\n' +
      '## 00:00 - 02:00 | 再次出现\r\n'
    const chunks = parseTimelineMarkdown(markdown)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toMatchObject({
      id: '00:00-02:00',
      title: '标题',
      summary: '一句话',
      keyPoints: ['观点一', '观点二'],
      tags: ['机器学习', 'résumé', 'deep-learning'],
      transcript: [{ time: '00:01', seconds: 1, text: '原文' }]
    })
    expect(chunks[1].id).not.toBe(chunks[0].id)
  })

  it('does not attach unrelated sections or invalid ranges to a valid chunk', () => {
    const chunks = parseTimelineMarkdown(
      '## 00:00 - 00:20 | Good\n**核心观点**\n- yes\n' +
        '## 00:30 - 00:10 | Bad\n**核心观点**\n- no\n## Appendix\n- no'
    )
    expect(chunks).toHaveLength(1)
    expect(chunks[0].keyPoints).toEqual(['yes'])
  })

  it('keeps markup as plain source text and ignores invalid transcript timestamps', () => {
    const chunks = parseTimelineMarkdown(
      '## 00:00 - 02:00 | <img onerror=alert(1)>\n' +
        '**原文记录**\n[00:99] invalid\n[00:01] <script>bad</script>'
    )
    expect(chunks[0].transcript).toEqual([
      { time: '00:01', seconds: 1, text: '<script>bad</script>' }
    ])
  })
})
