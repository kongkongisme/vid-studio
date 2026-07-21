from http.cookiejar import Cookie

import pytest

from src import downloader
from src.downloader import VideoDownloader, _build_cookie_opts
from src.pipeline import _fetch_meta


def _cookie(domain: str, name: str) -> Cookie:
    return Cookie(
        version=0,
        name=name,
        value="value",
        port=None,
        port_specified=False,
        domain=domain,
        domain_specified=True,
        domain_initial_dot=domain.startswith("."),
        path="/",
        path_specified=True,
        secure=True,
        expires=None,
        discard=True,
        comment=None,
        comment_url=None,
        rest={},
        rfc2109=False,
    )


def test_build_cookie_opts_skips_browser_without_bilibili_login(monkeypatch):
    cookies = {
        "chrome": [_cookie(".bilibili.com", "b_nut")],
        "edge": [_cookie(".bilibili.com", "SESSDATA")],
    }

    monkeypatch.setattr(
        downloader,
        "extract_cookies_from_browser",
        lambda browser: cookies.get(browser, []),
    )

    assert _build_cookie_opts("bilibili") == {"cookiesfrombrowser": ("edge",)}


def test_downloader_caches_cookie_browser_per_site(monkeypatch, tmp_path):
    calls = []

    def fake_extract(browser):
        calls.append(browser)
        return [_cookie(".bilibili.com", "SESSDATA")] if browser == "edge" else []

    monkeypatch.setattr(downloader, "extract_cookies_from_browser", fake_extract)
    instance = VideoDownloader(str(tmp_path))

    first = instance._base_opts("https://www.bilibili.com/video/BV123")
    second = instance._base_opts("https://www.bilibili.com/video/BV456")

    assert first["cookiesfrombrowser"] == ("edge",)
    assert second["cookiesfrombrowser"] == ("edge",)
    assert calls == ["chrome", "edge"]


def test_fetch_meta_explains_bilibili_412():
    class FailingDownloader:
        def get_video_meta_with_info(self, url):
            raise RuntimeError("HTTP Error 412: Precondition Failed")

    with pytest.raises(RuntimeError, match="请先在 Edge 或 Chrome 中登录 B 站"):
        _fetch_meta(
            FailingDownloader(),
            "https://www.bilibili.com/video/BV1X4KU66E5i",
        )
