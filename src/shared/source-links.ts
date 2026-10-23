/** Only generate canonical links for supported video hosts; discard tracking and unrelated params. */
export function sourceTimestampUrl(source: string | undefined, seconds: number): string | null {
  if (!source || !Number.isFinite(seconds) || seconds < 0 || seconds > Number.MAX_SAFE_INTEGER)
    return null
  const time = String(Math.floor(seconds))
  const trimmed = source.trim()
  const bareBv = /^BV[a-zA-Z0-9]{10}$/.test(trimmed)
  let url: URL
  try {
    url = new URL(bareBv ? `https://www.bilibili.com/video/${trimmed}` : trimmed)
  } catch {
    return null
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port)
    return null
  if (['bilibili.com', 'www.bilibili.com', 'm.bilibili.com'].includes(url.hostname)) {
    const id = url.pathname.match(/^\/video\/(BV[a-zA-Z0-9]{10})\/?$/)?.[1]
    if (!id) return null
    const target = new URL(`https://www.bilibili.com/video/${id}`)
    const part = url.searchParams.get('p')
    if (part && /^[1-9]\d{0,5}$/.test(part)) target.searchParams.set('p', part)
    target.searchParams.set('t', time)
    return target.href
  }
  let id: string | null | undefined
  if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname)) {
    id =
      url.pathname === '/watch'
        ? url.searchParams.get('v')
        : url.pathname.match(/^\/(?:embed|shorts|live)\/([a-zA-Z0-9_-]{11})\/?$/)?.[1]
  } else if (['youtu.be', 'www.youtu.be'].includes(url.hostname)) {
    id = url.pathname.match(/^\/([a-zA-Z0-9_-]{11})\/?$/)?.[1]
  }
  return id && /^[a-zA-Z0-9_-]{11}$/.test(id)
    ? `https://www.youtube.com/watch?v=${id}&t=${time}`
    : null
}
