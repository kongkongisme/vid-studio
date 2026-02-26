"""智谱 GLM-4V-Flash 视频理解模块

全局分析：提取 N 帧 → 拼成时间轴网格图（每帧标注时间戳）→ 单张图片发给 GLM
段落分析：提取段落中间帧 → 直接发给 GLM → 返回简短视觉描述

帧提取改为多线程并行 ffmpeg 调用，加速提取过程
"""
import base64
import io
import math
import subprocess
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import List, Optional, Tuple

import requests
from PIL import Image, ImageDraw, ImageFont

from src.config import get_config
from src.utils import seconds_to_hms

_CHAT_API = "https://open.bigmodel.cn/api/paas/v4/chat/completions"

# 网格图样式
_LABEL_H = 22
_BG_COLOR = (15, 15, 15)
_LABEL_BG = (0, 0, 0)
_LABEL_FG = (255, 220, 0)

_GLOBAL_PROMPT = """\
上图是视频按时间顺序均匀抽取的少量关键帧（样本，非完整覆盖），每帧左下角标注了时间戳。

请整体观察这些样本帧，用中文输出以下内容：

1. **视频形式**：一句话描述主要的拍摄或制作形式

2. **视觉内容**：仅当帧中出现了图表、幻灯片、白板板书、代码、公式、产品演示界面等有实质信息量的内容时，简要描述其类型和大意。若无此类内容，跳过本条，不要输出任何说明

3. **场景氛围**：拍摄环境、画面风格等，一句话即可

注意：屏幕边缘或底部的字幕条已由其他模块处理，请勿描述字幕文字。有什么说什么，没有的内容不要输出占位说明。直接输出，不重复问题本身。\
"""

_SEGMENT_PROMPT = """\
这是视频 {start_time} - {end_time} 时间段的截图。
请简短描述（50字以内）画面的关键视觉元素：PPT标题/文字、公式、图表、代码、板书、演示界面等。
若无特殊视觉信息则输出"无"。直接输出描述，不要解释。\
"""


def _get_video_duration(video_path: str) -> float:
    cmd = [
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        video_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    try:
        return float(result.stdout.strip())
    except ValueError:
        return 0.0


def _extract_single_frame(
    video_path: str, timestamp: float, output_path: str, width: int, height: int
) -> bool:
    """用 ffmpeg 提取单帧并缩放，成功返回 True"""
    cmd = [
        "ffmpeg", "-y",
        "-ss", str(timestamp),
        "-i", video_path,
        "-vframes", "1",
        "-vf", f"scale={width}:{height}",
        "-q:v", "3",
        "-loglevel", "error",
        output_path,
    ]
    result = subprocess.run(cmd, capture_output=True)
    return result.returncode == 0 and Path(output_path).exists()


def _compute_grid_params(duration: float) -> Tuple[int, int, int, int, int]:
    """根据视频时长动态计算网格参数，返回 (n_frames, cols, rows, cell_w, cell_h)"""
    cfg = get_config()
    minutes = duration / 60
    n_frames = int(round(minutes * cfg.vu_frames_per_minute))
    n_frames = max(cfg.vu_min_frames, min(cfg.vu_max_frames, n_frames))

    cols = math.ceil(math.sqrt(n_frames))
    rows = math.ceil(n_frames / cols)

    cell_w = cfg.vu_max_grid_width // cols
    cell_h = cell_w * 9 // 16

    return n_frames, cols, rows, cell_w, cell_h


def _extract_frames_parallel(
    video_path: str,
    timestamps: List[float],
    cell_w: int,
    cell_h: int,
    max_workers: int = 4,
) -> List[Tuple[float, Image.Image]]:
    """并行提取多帧（多线程 ffmpeg，比串行快 3-4x）"""
    # 结果槽，保持原始顺序
    slots: List[Optional[Tuple[float, Image.Image]]] = [None] * len(timestamps)

    def _extract_one(args: Tuple[int, float, str]) -> Tuple[int, float, Optional[Image.Image]]:
        idx, timestamp, frame_path = args
        ok = _extract_single_frame(video_path, timestamp, frame_path, cell_w, cell_h)
        if ok:
            return idx, timestamp, Image.open(frame_path).convert("RGB")
        return idx, timestamp, None

    with tempfile.TemporaryDirectory() as tmp:
        tasks = [
            (i, ts, str(Path(tmp) / f"frame_{i:03d}.jpg"))
            for i, ts in enumerate(timestamps)
        ]
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            future_to_task = {executor.submit(_extract_one, t): t for t in tasks}
            for future in as_completed(future_to_task):
                idx, timestamp, img = future.result()
                if img is not None:
                    slots[idx] = (timestamp, img)

    return [f for f in slots if f is not None]


def _build_grid(
    frames: List[Tuple[float, Image.Image]],
    cols: int,
    cell_w: int,
    cell_h: int,
) -> Image.Image:
    """将帧列表拼成网格图，每帧左下角叠加时间戳标签"""
    rows = math.ceil(len(frames) / cols)
    cell_total_h = cell_h + _LABEL_H

    grid = Image.new("RGB", (cols * cell_w, rows * cell_total_h), _BG_COLOR)
    draw = ImageDraw.Draw(grid)

    try:
        font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 13)
    except Exception:
        font = ImageFont.load_default()

    for i, (timestamp, frame) in enumerate(frames):
        row, col = i // cols, i % cols
        x, y = col * cell_w, row * cell_total_h

        grid.paste(frame, (x, y))
        draw.rectangle([x, y + cell_h, x + cell_w, y + cell_total_h], fill=_LABEL_BG)
        draw.text((x + 5, y + cell_h + 4), seconds_to_hms(timestamp), fill=_LABEL_FG, font=font)

    return grid


def _image_to_b64(img: Image.Image, quality: int = 85) -> str:
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality)
    return base64.b64encode(buf.getvalue()).decode("utf-8")


class VideoUnderstanding:

    def __init__(self):
        cfg = get_config()
        self.api_key = cfg.zhipuai_api_key
        if not self.api_key:
            raise ValueError("环境变量 ZHIPUAI_API_KEY 未设置")
        self.model = cfg.vu_model

    def analyze_local(self, video_path: str) -> Optional[str]:
        """从本地视频提取关键帧网格，发给 GLM-4V 进行全局分析"""
        duration = _get_video_duration(video_path)
        n_frames, cols, rows, cell_w, cell_h = _compute_grid_params(duration)

        interval = duration / (n_frames + 1)
        timestamps = [interval * (i + 1) for i in range(n_frames)]

        print(f"  视频时长 {seconds_to_hms(duration)}，并行提取 {n_frames} 帧（{cols}×{rows} 网格）...")
        frames = _extract_frames_parallel(video_path, timestamps, cell_w, cell_h)
        if not frames:
            print("  帧提取失败，跳过视频理解")
            return None

        grid_img = _build_grid(frames, cols, cell_w, cell_h)
        b64 = _image_to_b64(grid_img)
        size_kb = len(base64.b64decode(b64)) // 1024
        print(f"  网格图 {cols}×{rows}，大小 {size_kb}KB，发送给 GLM-4V...")

        return self._call_glm(b64, _GLOBAL_PROMPT)

    def analyze_segment(
        self, video_path: str, start: float, end: float
    ) -> Optional[str]:
        """
        提取段落中间时刻的 1 帧，发给 GLM-4V 返回简短视觉描述

        用于段落级视觉-文本融合（将视觉信息附加到 LLM Prompt 中）
        """
        mid = (start + end) / 2
        cell_w, cell_h = 640, 360  # 段落分析无需高分辨率

        with tempfile.TemporaryDirectory() as tmp:
            frame_path = str(Path(tmp) / "segment_frame.jpg")
            ok = _extract_single_frame(video_path, mid, frame_path, cell_w, cell_h)
            if not ok:
                return None
            img = Image.open(frame_path).convert("RGB")

        b64 = _image_to_b64(img, quality=80)
        prompt = _SEGMENT_PROMPT.format(
            start_time=seconds_to_hms(start),
            end_time=seconds_to_hms(end),
        )
        return self._call_glm(b64, prompt)

    def _call_glm(
        self, image_b64: str, prompt: str, max_retries: int = 3
    ) -> Optional[str]:
        """发送单张图片给 GLM-4V"""
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": self.model,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image_url",
                            "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"},
                        },
                        {"type": "text", "text": prompt},
                    ],
                }
            ],
        }

        for attempt in range(max_retries):
            try:
                response = requests.post(
                    _CHAT_API, json=payload, headers=headers, timeout=180,
                )

                if response.status_code == 200:
                    return response.json()["choices"][0]["message"]["content"].strip()

                if response.status_code == 429:
                    time.sleep(2 ** attempt)
                    continue

                print(f"  GLM 返回 {response.status_code}：{response.text[:300]}")
                return None

            except requests.RequestException as e:
                if attempt < max_retries - 1:
                    time.sleep(2)
                else:
                    print(f"  GLM 请求失败：{e}")
                    return None

        return None
