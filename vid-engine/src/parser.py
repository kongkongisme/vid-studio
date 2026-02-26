"""VTT / JSON3 字幕解析，输出统一的片段列表"""
import re
import json
from pathlib import Path
from typing import List

from src.models import SubtitleSegment


# 匹配 VTT 时间戳行：HH:MM:SS.mmm --> HH:MM:SS.mmm 或 MM:SS.mmm --> MM:SS.mmm
_TIMESTAMP_RE = re.compile(
    r"(\d{1,2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})"
    r"\s*-->\s*"
    r"(\d{1,2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})"
)

# 过滤 VTT 内联标签（<c>、<b>、<00:01:23.000> 等）
_VTT_TAG_RE = re.compile(r"<[^>]+>")


def _vtt_time_to_seconds(time_str: str) -> float:
    """将 HH:MM:SS.mmm 或 MM:SS.mmm 转为秒数"""
    parts = time_str.split(":")
    if len(parts) == 3:
        h, m, s = parts
        return int(h) * 3600 + int(m) * 60 + float(s)
    else:
        m, s = parts
        return int(m) * 60 + float(s)


def parse_vtt(file_path: str) -> List[SubtitleSegment]:
    """解析 WebVTT 格式字幕"""
    content = Path(file_path).read_text(encoding="utf-8", errors="ignore")
    segments: List[SubtitleSegment] = []
    lines = content.split("\n")
    i = 0

    while i < len(lines):
        line = lines[i].strip()
        match = _TIMESTAMP_RE.match(line)
        if match:
            start = _vtt_time_to_seconds(match.group(1))
            end = _vtt_time_to_seconds(match.group(2))

            text_lines = []
            i += 1
            while i < len(lines) and lines[i].strip():
                text = _VTT_TAG_RE.sub("", lines[i].strip()).strip()
                if text:
                    text_lines.append(text)
                i += 1

            full_text = " ".join(text_lines).strip()
            # 去重：跳过与上一条相同的文本（滚动字幕）
            if full_text and (not segments or segments[-1].text != full_text):
                segments.append(SubtitleSegment(start=start, end=end, text=full_text))
        else:
            i += 1

    return segments


def parse_json3(file_path: str) -> List[SubtitleSegment]:
    """解析 B站 JSON3 格式字幕：{"body": [{"from", "to", "content"}]}"""
    content = Path(file_path).read_text(encoding="utf-8", errors="ignore")
    data = json.loads(content)
    segments: List[SubtitleSegment] = []

    for item in data.get("body", []):
        start = float(item.get("from", 0))
        end = float(item.get("to", start + 3))
        text = item.get("content", "").strip()
        if text:
            segments.append(SubtitleSegment(start=start, end=end, text=text))

    return segments


def parse(file_path: str) -> List[SubtitleSegment]:
    """自动识别格式并解析，支持 .vtt 和 .json3/.json"""
    path = Path(file_path)
    suffix = path.suffix.lower()

    if suffix == ".vtt":
        return parse_vtt(file_path)
    elif suffix in (".json3", ".json"):
        return parse_json3(file_path)
    else:
        content = path.read_text(encoding="utf-8", errors="ignore")
        if content.strip().startswith("WEBVTT"):
            return parse_vtt(file_path)
        return parse_json3(file_path)
