"""基于 TextTiling 思路的语义分块器

改进点（对比简单相邻窗口对比）：
- 窗口扩大到 30s，语义内容更充分
- 对每个潜在边界，比较左右各 block_size 个窗口的平均向量
  而非单窗口对比，大幅减少噪声
- 用 1-similarity 得到"差异分"，找局部极大值作为断点
  而非全局阈值，对不同视频适应性更强
- 对差异分曲线做移动平均平滑，过滤细碎波动
"""
from typing import List

import numpy as np

from src.models import SubtitleSegment, TimelineChunk
from src.segmenter.timeline import TimelineSegmenter


def _cosine_similarity(a: List[float], b: List[float]) -> float:
    """计算两个向量的余弦相似度"""
    va = np.array(a)
    vb = np.array(b)
    denom = np.linalg.norm(va) * np.linalg.norm(vb)
    if denom == 0:
        return 0.0
    return float(np.dot(va, vb) / denom)


class SemanticSegmenter:

    def __init__(
        self,
        window_seconds: float = 30.0,
        block_size: int = 2,
        smoothing_width: int = 2,
        min_chunk_seconds: float = 60.0,
        max_chunk_seconds: float = 300.0,
    ):
        """
        Args:
            window_seconds:     embedding 窗口时长（秒），建议 20-40s
            block_size:         边界两侧各取多少个窗口做平均对比
            smoothing_width:    差异分曲线平滑半径（窗口数）
            min_chunk_seconds:  章节最短时长，避免切太碎
            max_chunk_seconds:  章节最长时长，超过则强制切割
        """
        self.window_seconds = window_seconds
        self.block_size = block_size
        self.smoothing_width = smoothing_width
        self.min_chunk_seconds = min_chunk_seconds
        self.max_chunk_seconds = max_chunk_seconds

    def chunk(self, segments: List[SubtitleSegment]) -> List[TimelineChunk]:
        """语义分块，失败时自动降级为时长分块"""
        if not segments:
            return []

        try:
            return self._semantic_chunk(segments)
        except Exception as e:
            print(f"  语义分块失败（{e}），降级为时长分块...")
            return TimelineSegmenter().chunk(segments)

    def _semantic_chunk(self, segments: List[SubtitleSegment]) -> List[TimelineChunk]:
        from src.embedder import get_embeddings

        windows = self._build_windows(segments)
        if len(windows) < self.block_size * 2 + 1:
            return TimelineSegmenter().chunk(segments)

        print(f"  计算 {len(windows)} 个语义窗口的 embedding...")
        embeddings = get_embeddings([w["text"] for w in windows])
        emb_matrix = np.array(embeddings)

        gap_scores = self._compute_gap_scores(emb_matrix)
        smoothed = self._smooth(gap_scores)
        breakpoint_times = self._find_breakpoints(windows, smoothed)
        print(f"  检测到 {len(breakpoint_times)} 个语义断点")

        return self._build_chunks(segments, breakpoint_times)

    def _build_windows(self, segments: List[SubtitleSegment]) -> List[dict]:
        """将字幕片段按时长合并为 embedding 窗口"""
        windows = []
        current_texts: List[str] = []
        window_start = segments[0].start

        for seg in segments:
            current_texts.append(seg.text)
            if seg.end - window_start >= self.window_seconds:
                windows.append({
                    "start": window_start,
                    "end": seg.end,
                    "text": " ".join(current_texts),
                })
                window_start = seg.end
                current_texts = []

        if current_texts:
            if windows:
                windows[-1]["end"] = segments[-1].end
                windows[-1]["text"] += " " + " ".join(current_texts)
            else:
                windows.append({
                    "start": window_start,
                    "end": segments[-1].end,
                    "text": " ".join(current_texts),
                })

        return windows

    def _compute_gap_scores(self, emb_matrix: np.ndarray) -> List[float]:
        """
        TextTiling 风格的边界差异分

        对第 i 个间隙：
        - 左块 = emb_matrix[i-k+1 : i+1] 的均值向量
        - 右块 = emb_matrix[i+1 : i+1+k] 的均值向量
        - gap_score = 1 - cosine_similarity(左块, 右块)
        """
        n = len(emb_matrix)
        k = self.block_size
        scores = []

        for i in range(n - 1):
            left = emb_matrix[max(0, i - k + 1) : i + 1].mean(axis=0)
            right = emb_matrix[i + 1 : min(n, i + 1 + k)].mean(axis=0)
            scores.append(1.0 - _cosine_similarity(left.tolist(), right.tolist()))

        return scores

    def _smooth(self, scores: List[float]) -> List[float]:
        """移动平均平滑"""
        w = self.smoothing_width
        arr = np.array(scores)
        smoothed = []
        for i in range(len(arr)):
            smoothed.append(arr[max(0, i - w) : i + w + 1].mean())
        return smoothed

    def _find_breakpoints(self, windows: List[dict], gap_scores: List[float]) -> List[float]:
        """找 gap_scores 的局部极大值作为断点"""
        scores = np.array(gap_scores)
        mean_score = scores.mean()

        breakpoint_times: List[float] = []
        last_break_time = windows[0]["start"]

        for i in range(1, len(scores) - 1):
            boundary_time = windows[i]["end"]

            is_local_max = scores[i] > scores[i - 1] and scores[i] > scores[i + 1]
            above_mean = scores[i] > mean_score
            far_enough = boundary_time - last_break_time >= self.min_chunk_seconds

            if is_local_max and above_mean and far_enough:
                breakpoint_times.append(boundary_time)
                last_break_time = boundary_time
                continue

            if boundary_time - last_break_time >= self.max_chunk_seconds:
                breakpoint_times.append(boundary_time)
                last_break_time = boundary_time

        return breakpoint_times

    def _build_chunks(
        self, segments: List[SubtitleSegment], breakpoint_times: List[float]
    ) -> List[TimelineChunk]:
        """按断点时间将字幕片段切割为 TimelineChunk"""
        chunks: List[TimelineChunk] = []
        current_segs: List[SubtitleSegment] = []
        chunk_idx = 0
        break_idx = 0

        for seg in segments:
            if (
                break_idx < len(breakpoint_times)
                and seg.start >= breakpoint_times[break_idx]
            ):
                if current_segs:
                    chunks.append(TimelineChunk(
                        index=chunk_idx,
                        start=current_segs[0].start,
                        end=current_segs[-1].end,
                        segments=current_segs,
                    ))
                    chunk_idx += 1
                    current_segs = []
                break_idx += 1

            current_segs.append(seg)

        if current_segs:
            chunks.append(TimelineChunk(
                index=chunk_idx,
                start=current_segs[0].start,
                end=current_segs[-1].end,
                segments=current_segs,
            ))

        return chunks
