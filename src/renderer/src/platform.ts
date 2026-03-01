// 平台工具模块：集中管理 B 站 / YouTube 的 URL 识别、webview 配置、注入脚本

export type Platform = 'bilibili' | 'youtube'

// ─── URL 识别 ─────────────────────────────────────────────

export function detectPlatform(url: string): Platform | null {
  const u = url.trim()
  if (/bilibili\.com|BV[a-zA-Z0-9]+/.test(u)) return 'bilibili'
  if (/youtube\.com\/watch|youtu\.be\//.test(u)) return 'youtube'
  return null
}

export function extractVideoId(url: string, platform: Platform): string | null {
  if (platform === 'bilibili') {
    const m = url.match(/BV[a-zA-Z0-9]+/)
    return m ? m[0] : null
  }
  // youtube.com/watch?v=xxx 或 youtu.be/xxx 或 youtube.com/embed/xxx（11 位 ID）
  let m = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/)
  if (m) return m[1]
  m = url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/)
  if (m) return m[1]
  m = url.match(/\/embed\/([a-zA-Z0-9_-]{11})/)
  return m ? m[1] : null
}

export function validateUrl(url: string): string | null {
  const trimmed = url.trim()
  if (!trimmed) return '请输入视频链接'
  const platform = detectPlatform(trimmed)
  if (!platform) return '链接不合法，请输入 B 站或 YouTube 视频链接'
  if (!extractVideoId(trimmed, platform)) return '无法提取视频 ID，请检查链接格式'
  return null
}

// ─── webview 配置 ─────────────────────────────────────────

export function getWebviewUrl(videoId: string, platform: Platform): string {
  if (platform === 'bilibili') return `https://www.bilibili.com/video/${videoId}`
  return `https://www.youtube.com/watch?v=${videoId}`
}

export function getWebviewSession(platform: Platform): string {
  return platform === 'bilibili' ? 'persist:bilibili' : 'persist:youtube'
}

// ─── 注入脚本 ─────────────────────────────────────────────

/** 两平台全屏按钮注入脚本 */
export function getFullscreenScript(platform: Platform): string {
  if (platform === 'youtube') {
    return `
      (function() {
        var btn = document.querySelector('.ytp-fullscreen-button');
        if (btn) { btn.click(); return true; }
        return false;
      })()
    `
  }
  return `
    (function() {
      var selectors = [
        '.bpx-player-ctrl-web',
        '.squirtle-pagefullscreen-icon',
        '[data-key="web-full-screen"]'
      ];
      for (var i = 0; i < selectors.length; i++) {
        var btn = document.querySelector(selectors[i]);
        if (btn) { btn.click(); return true; }
      }
      return false;
    })()
  `
}

/** 两平台通用：直接操作 video 元素的 currentTime */
export function getSeekScript(seconds: number): string {
  return `
    (function(){
      const v = document.querySelector('video');
      if (v) { v.currentTime = ${seconds}; v.play(); return true; }
      return false;
    })()
  `
}

/** 时间跳转降级 URL（无法通过 JS 跳转时重新加载） */
export function getSeekFallbackUrl(videoId: string, platform: Platform, seconds: number): string {
  if (platform === 'bilibili') return `https://www.bilibili.com/video/${videoId}?t=${seconds}`
  return `https://www.youtube.com/watch?v=${videoId}&t=${seconds}`
}
