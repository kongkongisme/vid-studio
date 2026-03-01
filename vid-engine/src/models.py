"""共享数据模型"""
from typing import List
from dataclasses import dataclass, field

from src.utils import seconds_to_hms


@dataclass
class SubtitleSegment:
    """单条字幕片段"""
    start: float  # 秒
    end: float
    text: str


@dataclass
class TimelineChunk:
    """时间轴章节块，由多条字幕片段组成"""
    index: int
    start: float  # 秒
    end: float
    segments: List[SubtitleSegment] = field(default_factory=list)

    @property
    def start_str(self) -> str:
        return seconds_to_hms(self.start)

    @property
    def end_str(self) -> str:
        return seconds_to_hms(self.end)

    @property
    def text_for_llm(self) -> str:
        """供 LLM 处理的格式化文本（含时间戳前缀）"""
        lines = []
        for seg in self.segments:
            ts = seconds_to_hms(seg.start)
            lines.append(f"[{ts}] {seg.text}")
        return "\n".join(lines)


@dataclass
class VideoMeta:
    """视频元信息"""
    id: str
    title: str
    duration: int  # 秒
    uploader: str
    language: str = ''  # yt-dlp 返回的视频主语言代码，如 "en"、"zh"
