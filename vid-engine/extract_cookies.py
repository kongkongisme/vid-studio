#!/usr/bin/env python3
"""
从 Edge / Chrome 浏览器提取指定网站的 cookies，输出 JSON。
支持 B 站（bilibili）和 YouTube，依赖 yt-dlp（已在 requirements.txt 中）。
"""
import sys
import json
import tempfile
import os
import subprocess
from http.cookiejar import MozillaCookieJar

# 各站点对应的域名关键词
SITE_DOMAINS = {
    'bilibili': ('bilibili', 'bilivideo', 'hdslb', 'biliimg'),
    'youtube': ('youtube', 'ytimg', 'googlevideo', 'yt'),
}

# 各站点用于触发 Cookie 写入的种子 URL
SITE_SEED_URLS = {
    'bilibili': 'https://www.bilibili.com/',
    'youtube': 'https://www.youtube.com/',
}


def _is_target_site(domain: str, site: str) -> bool:
    """判断 domain 是否属于目标站点。"""
    return any(d in domain for d in SITE_DOMAINS[site])


def _cookie_to_dict(c) -> dict:
    return {
        'url': f'https://{c.domain.lstrip(".")}',
        'name': c.name,
        'value': c.value,
        'domain': c.domain,
        'path': c.path or '/',
        'secure': bool(c.secure),
        'httpOnly': False,
    }


def extract_via_api(browser: str, site: str) -> list:
    """优先使用 yt-dlp Python API 直接提取，速度快。"""
    import yt_dlp

    # 使用 mkstemp 替代 mktemp，避免 TOCTOU 竞态条件安全漏洞
    fd, tmp = tempfile.mkstemp(suffix='.txt')
    os.close(fd)
    opts = {
        'cookiesfrombrowser': (browser, None, None, None),
        'cookiefile': tmp,
        'quiet': True,
        'no_warnings': True,
    }
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            cookies = [_cookie_to_dict(c) for c in ydl.cookiejar if _is_target_site(c.domain, site)]
        return cookies
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def extract_via_cli(browser: str, site: str) -> list:
    """Fallback：通过 yt-dlp CLI 写出 Netscape 格式文件再解析。"""
    # 使用 mkstemp 替代 mktemp，避免 TOCTOU 竞态条件安全漏洞
    fd, tmp = tempfile.mkstemp(suffix='.txt')
    os.close(fd)
    try:
        subprocess.run(
            [sys.executable, '-m', 'yt_dlp',
             '--cookies-from-browser', browser,
             '--cookies', tmp,
             '--skip-download',
             '--quiet',
             '--ignore-errors',
             SITE_SEED_URLS[site]],  # 使用对应站点的种子 URL
            capture_output=True,
            timeout=30,
        )
        if not os.path.exists(tmp):
            return []
        jar = MozillaCookieJar(tmp)
        jar.load(ignore_discard=True, ignore_expires=True)
        return [_cookie_to_dict(c) for c in jar if _is_target_site(c.domain, site)]
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def main():
    import argparse

    parser = argparse.ArgumentParser(description='从浏览器提取指定网站的 Cookie')
    # 可选位置参数：指定浏览器，默认依次尝试 Edge / Chrome
    parser.add_argument('browser', nargs='?', default=None, help='浏览器名称（edge / chrome），不填则自动尝试')
    # --site 参数：指定目标站点
    parser.add_argument('--site', choices=['bilibili', 'youtube'], default='bilibili', help='目标站点（默认 bilibili）')
    args = parser.parse_args()

    browsers = [args.browser] if args.browser else ['edge', 'chrome']
    site = args.site

    for browser in browsers:
        for extractor in (extract_via_api, extract_via_cli):
            try:
                cookies = extractor(browser, site)
                if cookies:
                    print(json.dumps({
                        'success': True,
                        'browser': browser,
                        'count': len(cookies),
                        'cookies': cookies,
                    }))
                    return
            except Exception:
                continue

    # 根据站点生成友好的错误提示
    site_name = 'B 站' if site == 'bilibili' else 'YouTube'
    print(json.dumps({
        'success': False,
        'error': f'未在 Edge 或 Chrome 中找到 {site_name} 登录信息，请先在浏览器中登录',
    }))


if __name__ == '__main__':
    main()
