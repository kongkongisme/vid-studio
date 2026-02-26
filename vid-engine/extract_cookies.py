#!/usr/bin/env python3
"""
从 Edge / Chrome 浏览器提取 B 站 cookies，输出 JSON。
依赖 yt-dlp（已在 requirements.txt 中）。
"""
import sys
import json
import tempfile
import os
import subprocess
from http.cookiejar import MozillaCookieJar

BILIBILI_DOMAINS = ('bilibili', 'bilivideo', 'hdslb', 'biliimg')


def _is_bilibili(domain: str) -> bool:
    return any(d in domain for d in BILIBILI_DOMAINS)


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


def extract_via_api(browser: str) -> list:
    """优先使用 yt-dlp Python API 直接提取，速度快。"""
    import yt_dlp

    tmp = tempfile.mktemp(suffix='.txt')
    opts = {
        'cookiesfrombrowser': (browser, None, None, None),
        'cookiefile': tmp,
        'quiet': True,
        'no_warnings': True,
    }
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            cookies = [_cookie_to_dict(c) for c in ydl.cookiejar if _is_bilibili(c.domain)]
        return cookies
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def extract_via_cli(browser: str) -> list:
    """Fallback：通过 yt-dlp CLI 写出 Netscape 格式文件再解析。"""
    tmp = tempfile.mktemp(suffix='.txt')
    try:
        subprocess.run(
            [sys.executable, '-m', 'yt_dlp',
             '--cookies-from-browser', browser,
             '--cookies', tmp,
             '--skip-download',
             '--quiet',
             '--ignore-errors',
             'https://www.bilibili.com/'],
            capture_output=True,
            timeout=30,
        )
        if not os.path.exists(tmp):
            return []
        jar = MozillaCookieJar(tmp)
        jar.load(ignore_discard=True, ignore_expires=True)
        return [_cookie_to_dict(c) for c in jar if _is_bilibili(c.domain)]
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def main():
    # 默认优先 Edge，其次 Chrome
    browsers = ['edge', 'chrome']
    if len(sys.argv) > 1:
        browsers = [sys.argv[1]]

    for browser in browsers:
        for extractor in (extract_via_api, extract_via_cli):
            try:
                cookies = extractor(browser)
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

    print(json.dumps({
        'success': False,
        'error': '未在 Edge 或 Chrome 中找到 B 站登录信息，请先在浏览器中登录 B 站',
    }))


if __name__ == '__main__':
    main()
