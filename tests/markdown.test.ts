// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { highlightText, renderMarkdown } from '../src/renderer/src/lib/markdown'

function render(source: string): HTMLDivElement {
  const element = document.createElement('div')
  element.innerHTML = renderMarkdown(source)
  return element
}

describe('safe rendering', () => {
  it('escapes search results even with an empty query or HTML metacharacters', () => {
    const value = '<img src=x onerror=alert(1)> A&B [a+b]'
    for (const query of ['', 'img', '&', '[a+b]', '  img  ']) {
      const element = document.createElement('div')
      element.innerHTML = highlightText(value, query)
      expect(element.querySelector('img')).toBeNull()
      expect(element.textContent).toBe(value)
    }
  })

  it('removes executable HTML, remote images, styles and dangerous links', () => {
    const element = render(
      '<script>alert(1)</script><img src="https://example.com/track" onerror="alert(1)">' +
        '<svg onload="alert(1)"></svg><style>body{display:none}</style>' +
        '<iframe srcdoc="hello"></iframe><a href="javascript:alert(1)">bad</a>' +
        '<a href="file:///etc/passwd">local</a><a href="custom:open">custom</a>'
    )
    expect(element.querySelector('script,img,svg,style,iframe')).toBeNull()
    expect(element.querySelector('a[href]')).toBeNull()
  })

  it('preserves Markdown tables and safe external links', () => {
    const element = render('| A | B |\n|---|---|\n| 1 | 2 |\n\n[参考](https://example.com)')
    expect(element.querySelectorAll('td')).toHaveLength(2)
    expect(element.querySelector('a')?.rel).toBe('noopener noreferrer')
  })

  it('creates timestamp links only in text, with one link per range', () => {
    const element = render(
      '[01:02] [01:02-02:03] （01:02:03） [01:99]\n\n' +
        '`[01:02]` [label [01:02]](https://example.com/01:02)'
    )
    expect(
      [...element.querySelectorAll('.ts-link')].map((link) => (link as HTMLElement).dataset.seconds)
    ).toEqual(['62', '62', '3723'])
    expect(element.querySelector('a a, code a')).toBeNull()
  })

  it('treats search query markers as text and supports incomplete streamed Markdown', () => {
    const element = render('<!-- SEARCH_BADGE:<img src=x onerror=alert(1)> -->\n\n**hello')
    expect(element.querySelector('img')).toBeNull()
    expect(element.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(renderMarkdown('hello', true)).toContain('md-cursor')
  })
})
