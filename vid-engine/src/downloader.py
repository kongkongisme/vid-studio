"""yt-dlp 封装：视频元信息获取、字幕下载、音频提取"""
from pathlib import Path
from typing import Optional, Tuple

import yt_dlp

from src.models import VideoMeta


def _build_subtitle_langs(primary_lang: str) -> list:
    """根据视频主语言动态构建字幕语言优先列表"""
    if not primary_lang or primary_lang.startswith('zh'):
        return ['zh-Hans', 'zh-CN', 'zh-TW', 'zh', 'en']
    # 非中文：原语言优先，备选中文和英文
    base = [primary_lang, 'zh-Hans', 'zh-CN', 'en']
    seen: set = set()
    return [lang for lang in base if not (lang in seen or seen.add(lang))]  # type: ignore[func-returns-value]


def _build_cookie_opts() -> dict:
    """静默尝试从浏览器读取 Cookie，失败则返回空 dict"""
    for browser in ["chrome", "firefox", "edge", "safari"]:
        try:
            opts = {"cookiesfrombrowser": (browser,)}
            with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, **opts}) as ydl:
                pass
            return opts
        except Exception:
            continue
    return {}


class VideoDownloader:

    def __init__(self, work_dir: str):
        self.work_dir = Path(work_dir)
        self._cookie_opts = _build_cookie_opts()

    def _base_opts(self) -> dict:
        return {
            "quiet": True,
            "no_warnings": True,
            "noplaylist": True,
            "socket_timeout": 60,
            "retries": 5,
            "fragment_retries": 5,
            **self._cookie_opts,
        }

    def get_video_meta(self, url: str) -> VideoMeta:
        """获取视频元信息（不下载文件）"""
        opts = {**self._base_opts(), "extract_flat": False}
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
            return VideoMeta(
                id=info.get("id", ""),
                title=info.get("title", "未知标题"),
                duration=int(info.get("duration") or 0),
                uploader=info.get("uploader", ""),
                language=info.get("language", "") or "",
            )

    def get_video_meta_with_info(self, url: str) -> Tuple["VideoMeta", dict]:
        """获取视频元信息，同时返回完整 info 字典（YouTube 含评论）"""
        is_youtube = "youtube.com" in url or "youtu.be" in url
        opts = {
            **self._base_opts(),
            "extract_flat": False,
        }
        if is_youtube:
            opts["getcomments"] = True
            opts["extractor_args"] = {"youtube": {"comment_sort": ["top"], "max_comments": ["100"]}}

        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
            meta = VideoMeta(
                id=info.get("id", ""),
                title=info.get("title", "未知标题"),
                duration=int(info.get("duration") or 0),
                uploader=info.get("uploader", ""),
                language=info.get("language", "") or "",
            )
            return meta, info

    def download_video(self, url: str) -> str:
        """下载低画质视频文件（360p），用于视频理解模型"""
        outtmpl = str(self.work_dir / "%(id)s.%(ext)s")
        opts = {
            **self._base_opts(),
            "quiet": False,
            "format": "bestvideo[height<=360]/bestvideo[height<=480]/bestvideo",
            "outtmpl": outtmpl,
        }

        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
            video_id = info.get("id", "")

        for ext in ("mp4", "webm", "mkv", "flv"):
            path = self.work_dir / f"{video_id}.{ext}"
            if path.exists():
                return str(path)

        for ext in ("mp4", "webm", "mkv", "flv"):
            files = list(self.work_dir.glob(f"*.{ext}"))
            if files:
                return str(files[0])

        raise FileNotFoundError(
            f"视频文件未找到，work_dir 内容：{list(self.work_dir.iterdir())}"
        )

    def download_subtitle(self, url: str, primary_lang: str = '') -> Optional[str]:
        """尝试下载字幕，返回 .vtt 文件路径，失败返回 None"""
        langs = _build_subtitle_langs(primary_lang)
        for write_subs, write_auto in [(True, False), (False, True)]:
            result = self._try_download_subtitle(url, write_subs, write_auto, langs)
            if result:
                return result
        return None

    def _try_download_subtitle(
        self, url: str, write_subs: bool, write_auto: bool, langs: list
    ) -> Optional[str]:
        """执行一次字幕下载尝试"""
        outtmpl = str(self.work_dir / "%(id)s.%(ext)s")
        opts = {
            **self._base_opts(),
            "skip_download": True,
            "writesubtitles": write_subs,
            "writeautomaticsub": write_auto,
            "subtitleslangs": langs,
            "subtitlesformat": "vtt/json3/best",
            "convertsubtitles": "vtt",
            "outtmpl": outtmpl,
        }

        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=True)
                video_id = info.get("id", "")

            for lang in langs:
                vtt_path = self.work_dir / f"{video_id}.{lang}.vtt"
                if vtt_path.exists() and vtt_path.stat().st_size > 0:
                    return str(vtt_path)

            vtt_files = [
                f for f in self.work_dir.glob("*.vtt") if f.stat().st_size > 0
            ]
            if vtt_files:
                return str(vtt_files[0])

        except Exception:
            pass

        return None

    def download_audio(self, url: str) -> str:
        """提取音频为 128kbps mp3，返回文件路径"""
        outtmpl = str(self.work_dir / "%(id)s.%(ext)s")
        opts = {
            **self._base_opts(),
            "quiet": False,
            # YouTube DASH 纯音频格式（opus/m4a）会被 403 拒绝，
            # 优先使用格式 18（360p mp4，单文件合并传统格式），
            # 再依次回退到最低画质 mp4 / 纯音频 / 任意最佳。
            "format": "18/worst[ext=mp4]/bestaudio/best",
            "postprocessors": [
                {
                    "key": "FFmpegExtractAudio",
                    "preferredcodec": "mp3",
                    "preferredquality": "128",
                }
            ],
            "outtmpl": outtmpl,
        }

        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
            video_id = info.get("id", "")

        mp3_path = self.work_dir / f"{video_id}.mp3"
        if mp3_path.exists():
            return str(mp3_path)

        mp3_files = list(self.work_dir.glob("*.mp3"))
        if mp3_files:
            return str(mp3_files[0])

        raise FileNotFoundError(
            f"音频文件未找到，work_dir 内容：{list(self.work_dir.iterdir())}"
        )
