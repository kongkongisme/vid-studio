"""硅基流动 SenseVoiceSmall ASR 封装，支持大文件自动分片"""
import re
import subprocess
import tempfile
import time
from pathlib import Path
from typing import List, Tuple

import requests

from src.config import get_config
from src.models import SubtitleSegment

# SenseVoice 特殊标签（情感、语言、事件等元信息）
_SENSEVOICE_TAG_RE = re.compile(r"<\|[^|]*\|>")
_API_URL = "https://api.siliconflow.cn/v1/audio/transcriptions"


def _clean_text(text: str) -> str:
    return _SENSEVOICE_TAG_RE.sub("", text).strip()


def _get_audio_duration(audio_path: str) -> float:
    """用 ffprobe 获取音频时长（秒）"""
    cmd = [
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        audio_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    try:
        return float(result.stdout.strip())
    except ValueError:
        return 0.0


def _split_audio(
    audio_path: str, total_duration: float, tmp_dir: str
) -> List[Tuple[str, float]]:
    """
    用 ffmpeg 将音频按指定时长切割，写入调用方提供的 tmp_dir

    返回：[(切片路径, 起始偏移秒数), ...]
    """
    chunk_duration = get_config().asr_chunk_duration_min * 60
    chunks: List[Tuple[str, float]] = []
    offset = 0.0
    idx = 0

    while offset < total_duration:
        chunk_path = str(Path(tmp_dir) / f"chunk_{idx:03d}.mp3")
        duration = min(chunk_duration, total_duration - offset)

        cmd = [
            "ffmpeg", "-y",
            "-i", audio_path,
            "-ss", str(offset),
            "-t", str(duration),
            "-acodec", "copy",
            "-loglevel", "error",
            chunk_path,
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            raise RuntimeError(f"ffmpeg 切割失败：{result.stderr}")

        chunks.append((chunk_path, offset))
        offset += chunk_duration
        idx += 1

    return chunks


class ASRProcessor:

    def __init__(self):
        self.api_key = get_config().siliconflow_api_key
        if not self.api_key:
            raise ValueError("环境变量 SILICONFLOW_API_KEY 未设置")

    def transcribe(self, audio_path: str) -> List[SubtitleSegment]:
        """
        对音频文件进行 ASR，自动处理大文件分片

        大文件分片使用 with TemporaryDirectory 确保临时文件一定被清理
        """
        cfg = get_config()
        max_bytes = cfg.asr_max_file_size_mb * 1024 * 1024
        file_size = Path(audio_path).stat().st_size
        audio_duration = _get_audio_duration(audio_path)

        if file_size <= max_bytes:
            return self._transcribe_single(audio_path, offset=0.0, audio_duration=audio_duration)

        chunk_min = cfg.asr_chunk_duration_min
        chunk_duration = chunk_min * 60
        print(f"  音频文件较大（{file_size // 1024 // 1024}MB），按 {chunk_min} 分钟分段...")

        with tempfile.TemporaryDirectory() as tmp_dir:
            chunks = _split_audio(audio_path, audio_duration, tmp_dir)
            all_segments: List[SubtitleSegment] = []

            for chunk_path, offset in chunks:
                actual_duration = min(chunk_duration, audio_duration - offset)
                print(f"  转录片段（偏移 {int(offset)}s）...")
                segs = self._transcribe_single(
                    chunk_path, offset=offset, audio_duration=actual_duration
                )
                all_segments.extend(segs)
                time.sleep(0.5)

        return all_segments

    def _transcribe_single(
        self,
        audio_path: str,
        offset: float = 0.0,
        audio_duration: float = 0.0,
        max_retries: int = 3,
    ) -> List[SubtitleSegment]:
        """调用 SiliconFlow ASR API 转录单个文件"""
        cfg = get_config()
        headers = {"Authorization": f"Bearer {self.api_key}"}
        # SiliconFlow API 可直连，无需走系统代理；
        # trust_env=False 彻底禁用环境变量代理（含 all_proxy），
        # 避免大文件通过 HTTP CONNECT 代理上传时触发 SSL EOF。
        _session = requests.Session()
        _session.trust_env = False

        for attempt in range(max_retries):
            try:
                with open(audio_path, "rb") as f:
                    response = _session.post(
                        _API_URL,
                        headers=headers,
                        files={"file": (Path(audio_path).name, f, "audio/mpeg")},
                        data={"model": cfg.asr_model},
                        timeout=120,
                    )

                if response.status_code == 200:
                    return self._parse_response(response.json(), offset, audio_duration)

                if response.status_code == 429:
                    wait = 2 ** attempt
                    print(f"  速率限制，{wait}秒后重试...")
                    time.sleep(wait)
                    continue

                raise RuntimeError(
                    f"ASR API 错误 {response.status_code}：{response.text[:200]}"
                )

            except requests.RequestException as e:
                if attempt < max_retries - 1:
                    print(f"  网络错误（{e}），重试 {attempt + 1}/{max_retries}...")
                    time.sleep(2)
                else:
                    raise

        raise RuntimeError("ASR 转录失败，已达最大重试次数")

    def _parse_response(
        self, data: dict, offset: float, audio_duration: float = 0.0
    ) -> List[SubtitleSegment]:
        """解析响应，应用时间偏移并清洗文本"""
        segments: List[SubtitleSegment] = []

        for seg in data.get("segments", []):
            start = seg.get("start", 0) + offset
            end = seg.get("end", 0) + offset
            text = _clean_text(seg.get("text", ""))
            if text:
                segments.append(SubtitleSegment(start=start, end=end, text=text))

        if segments:
            return segments

        # 降级：API 未返回 segments，从全文重建时间戳
        full_text = _clean_text(data.get("text", ""))
        if not full_text:
            return []

        duration = float(data.get("duration") or 0) or audio_duration
        if duration <= 0:
            return [SubtitleSegment(start=offset, end=offset, text=full_text)]

        return self._split_text_to_segments(full_text, offset, duration)

    @staticmethod
    def _split_text_to_segments(
        text: str, offset: float, duration: float
    ) -> List[SubtitleSegment]:
        """
        将无时间戳的全文按字符比例分配时间戳

        策略（优先级递降）：
        1. 按句号/问号/感叹号切句
        2. 无标点（口语）→ 按每 100 字一块切分
        3. 兜底 → 整段作为一条
        """
        # 按标点切句
        raw = re.split(r"([。！？!?])", text)
        sentences = []
        for i in range(0, len(raw) - 1, 2):
            s = (raw[i] + raw[i + 1]).strip()
            if s:
                sentences.append(s)
        remainder = raw[-1].strip() if len(raw) % 2 == 1 else ""
        if remainder:
            sentences.append(remainder)

        # 标点切分太粗（口语场景），改用字数切分
        if len(sentences) < 2 and len(text) > 100:
            chunk_chars = 100
            sentences = [
                text[i : i + chunk_chars]
                for i in range(0, len(text), chunk_chars)
            ]

        if not sentences:
            return [SubtitleSegment(start=offset, end=offset + duration, text=text)]

        total_chars = max(sum(len(s) for s in sentences), 1)
        current_time = offset
        segments = []

        for s in sentences:
            seg_dur = (len(s) / total_chars) * duration
            segments.append(SubtitleSegment(
                start=current_time,
                end=current_time + seg_dur,
                text=s,
            ))
            current_time += seg_dur

        return segments
