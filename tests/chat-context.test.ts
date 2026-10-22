import { describe, expect, it } from 'vitest'
import { buildVideoContext } from '../src/shared/chat-context'
import { importTimeline } from '../src/shared/timeline-import'

describe('source-backed chat context', () => {
  it('includes original subtitle text even when there are no AI summaries', () => {
    const { chunks } = importTimeline(
      'test.srt',
      '1\n00:00:01,000 --> 00:00:05,000\n主动回忆是一个有效方法'
    )
    expect(buildVideoContext(chunks, '什么是主动回忆？')).toContain(
      '[00:01] 主动回忆是一个有效方法'
    )
  })

  it('retrieves a matching later chapter and bounds long source content', () => {
    const chunks = Array.from({ length: 30 }, (_, index) => ({
      id: String(index),
      startTime: `${index}:00`,
      endTime: `${index + 1}:00`,
      startSeconds: index * 60,
      endSeconds: (index + 1) * 60,
      title: '标题',
      summary: '',
      keyPoints: [],
      tags: [],
      transcript: [
        {
          time: `${index}:01`,
          seconds: index * 60 + 1,
          text: index === 28 ? '量子纠错是后面讲的内容' : '不相关内容'.repeat(1000)
        }
      ]
    }))
    const context = buildVideoContext(chunks, '量子纠错如何实现？')
    expect(context).toContain('量子纠错是后面讲的内容')
    expect(context.length).toBeLessThan(25000)
  })

  it('keeps a deliberately quoted chapter even when the question has no keyword overlap', () => {
    const { chunks } = importTimeline('test.srt', '1\n00:00:01,000 --> 00:00:05,000\n专有概念解释')
    expect(buildVideoContext(chunks, '展开解释', chunks[0].id)).toContain('专有概念解释')
  })

  it('keeps the matching passage inside a very long subtitle sentence', () => {
    const { chunks } = importTimeline(
      'test.srt',
      '1\n00:00:01,000 --> 00:00:05,000\n' + '无关填充'.repeat(2000) + '量子纠错的具体方法'
    )
    expect(buildVideoContext(chunks, '量子纠错的具体方法')).toContain('量子纠错的具体方法')
  })
})
