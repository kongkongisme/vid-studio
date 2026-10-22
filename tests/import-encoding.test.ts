import { describe, expect, it } from 'vitest'
import {
  decodeTimelineBytes,
  importTimeline,
  MAX_IMPORT_BYTES
} from '../src/shared/timeline-import'

const subtitle = '1\r\n00:00:01,125 --> 00:00:03,750\r\n中文、é 和 😀 都应完整保留。\r\n'

describe('subtitle and note file encodings', () => {
  it('preserves UTF-8 content, including an optional BOM', () => {
    expect(decodeTimelineBytes(Buffer.from(subtitle))).toBe(subtitle)
    expect(decodeTimelineBytes(Buffer.from('\uFEFF' + subtitle))).toBe(subtitle)
  })

  it.each(['LE', 'BE'])(
    'imports UTF-16 %s with a BOM without losing Chinese or cue precision',
    (order) => {
      const bytes = Buffer.from('\uFEFF' + subtitle, 'utf16le')
      if (order === 'BE') bytes.swap16()
      const content = decodeTimelineBytes(bytes)
      expect(content).toBe(subtitle)
      const document = importTimeline('课程.srt', content)
      expect(document.chunks[0].transcript[0]).toMatchObject({
        seconds: 1.125,
        endSeconds: 3.75,
        text: '中文、é 和 😀 都应完整保留。'
      })
    }
  )

  it('rejects damaged or ambiguous bytes rather than silently inserting replacement characters', () => {
    expect(() => decodeTimelineBytes(Uint8Array.from([0xe4, 0xb8]))).toThrow('文字编码')
    expect(() => decodeTimelineBytes(Uint8Array.from([0xff, 0xfe, 0x61]))).toThrow('文字编码')
    expect(() => decodeTimelineBytes(Uint8Array.from([0x81, 0x30]))).toThrow('文字编码')
  })

  it('applies the byte limit before decoding multi-byte encodings', () => {
    expect(() => decodeTimelineBytes(new Uint8Array(MAX_IMPORT_BYTES + 1))).toThrow('10 MB')
  })
})
