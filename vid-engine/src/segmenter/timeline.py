"""基于时长和静默断点的分块策略"""
from typing import List, Optional

from src.models import SubtitleSegment, TimelineChunk


class TimelineSegmenter:

    def __init__(
        self,
        target_seconds: float = 150.0,
        gap_threshold: float = 1.0,
        flex_window: float = 30.0,
    ):
        """
        Args:
            target_seconds: 目标分块时长（秒），默认 2.5 分钟
            gap_threshold:  静默断点阈值（秒），超过此值视为语义断点
            flex_window:    在目标时间前后搜索断点的窗口（秒）
        """
        self.target_seconds = target_seconds
        self.gap_threshold = gap_threshold
        self.flex_window = flex_window

    def chunk(self, segments: List[SubtitleSegment]) -> List[TimelineChunk]:
        """
        将字幕片段分组为时间块

        策略：
        1. 以 target_seconds 为目标窗口
        2. 在 (target - flex, target + flex) 内找最大静默间隔作为切割点
        3. 若无合适断点，直接在目标时间处切割
        """
        if not segments:
            return []

        chunks: List[TimelineChunk] = []
        chunk_start_idx = 0
        chunk_idx = 0

        while chunk_start_idx < len(segments):
            chunk_start_time = segments[chunk_start_idx].start
            target_time = chunk_start_time + self.target_seconds
            window_end = target_time + self.flex_window

            cut_idx = len(segments)

            for i in range(chunk_start_idx, len(segments)):
                if segments[i].start >= window_end:
                    cut_idx = i
                    break
                if segments[i].start >= target_time - self.flex_window:
                    best = self._find_best_gap(
                        segments, i, target_time - self.flex_window, window_end
                    )
                    if best is not None:
                        cut_idx = best
                    else:
                        for j in range(i, len(segments)):
                            if segments[j].start >= target_time:
                                cut_idx = j
                                break
                    break

            chunk_segs = segments[chunk_start_idx:cut_idx]
            if chunk_segs:
                chunks.append(TimelineChunk(
                    index=chunk_idx,
                    start=chunk_segs[0].start,
                    end=chunk_segs[-1].end,
                    segments=chunk_segs,
                ))
                chunk_idx += 1

            chunk_start_idx = cut_idx

        return chunks

    def _find_best_gap(
        self,
        segments: List[SubtitleSegment],
        start_idx: int,
        window_start: float,
        window_end: float,
    ) -> Optional[int]:
        """在时间窗口内找最大静默间隔，返回间隔后的片段索引"""
        best_gap = self.gap_threshold
        best_idx: Optional[int] = None

        for i in range(start_idx, len(segments) - 1):
            seg_end = segments[i].end
            next_start = segments[i + 1].start

            if seg_end < window_start:
                continue
            if segments[i].start > window_end:
                break

            gap = next_start - seg_end
            if gap > best_gap:
                best_gap = gap
                best_idx = i + 1

        return best_idx
