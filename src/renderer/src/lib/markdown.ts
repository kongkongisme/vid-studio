import DOMPurify from 'dompurify'
import { Marked } from 'marked'
import { timeToSeconds } from '../../../shared/timeline'

const marked = new Marked({ breaks: true, gfm: true })

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      })[char]!
  )
}

export function highlightText(value: string, query: string): string {
  const term = query.trim()
  if (!term) return escapeHtml(value)
  const pattern = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return value
    .split(new RegExp(`(${pattern})`, 'gi'))
    .map((part, index) =>
      index % 2
        ? `<mark class="bg-yellow-200 rounded px-0.5">${escapeHtml(part)}</mark>`
        : escapeHtml(part)
    )
    .join('')
}

const TIMESTAMP = /(?:\[|（)(\d+:\d{2}(?::\d{2})?)(?:\s*[-–]\s*\d+:\d{2}(?::\d{2})?)?(?:\]|）)/g

/** Only text nodes become timestamp links: never URLs, attributes, code, or existing links. */
export function renderMarkdown(content: string, streaming = false): string {
  if (!content) return ''
  const source = content.replace(
    /<!-- SEARCH_BADGE:([\s\S]*?) -->/g,
    (_, query: string) => `<p>已联网搜索：${escapeHtml(query)}</p>`
  )
  const fragment = DOMPurify.sanitize(marked.parse(source, { async: false }), {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: [
      'p',
      'br',
      'hr',
      'strong',
      'em',
      'del',
      's',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'ul',
      'ol',
      'li',
      'blockquote',
      'pre',
      'code',
      'table',
      'thead',
      'tbody',
      'tr',
      'th',
      'td',
      'a'
    ],
    ALLOWED_ATTR: ['href', 'title', 'start', 'colspan', 'rowspan'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false
  })
  for (const link of fragment.querySelectorAll('a')) {
    const href = link.getAttribute('href') ?? ''
    if (/^https?:\/\//i.test(href)) {
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
    } else {
      link.removeAttribute('href')
    }
  }
  const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT)
  const textNodes: Text[] = []
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text)
  for (const node of textNodes) {
    if (node.parentElement?.closest('a, code, pre')) continue
    const value = node.textContent ?? ''
    const replacement = document.createDocumentFragment()
    let offset = 0
    for (const match of value.matchAll(TIMESTAMP)) {
      const seconds = timeToSeconds(match[1])
      if (!Number.isFinite(seconds)) continue
      replacement.append(document.createTextNode(value.slice(offset, match.index)))
      const link = document.createElement('a')
      link.className = 'ts-link'
      link.dataset.seconds = String(seconds)
      link.href = '#'
      link.textContent = match[0]
      replacement.append(link)
      offset = match.index + match[0].length
    }
    if (offset) {
      replacement.append(document.createTextNode(value.slice(offset)))
      node.replaceWith(replacement)
    }
  }
  if (streaming) {
    const cursor = document.createElement('span')
    cursor.className = 'md-cursor'
    cursor.textContent = '▌'
    const paragraphs = fragment.querySelectorAll('p')
    const lastParagraph = paragraphs.item(paragraphs.length - 1)
    ;(lastParagraph ?? fragment).append(cursor)
  }
  const container = document.createElement('div')
  container.append(fragment)
  return container.innerHTML
}
