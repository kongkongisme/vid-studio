"""处理管道：编排从下载到输出的完整流程"""
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from src.config import get_config
from src.downloader import VideoDownloader
from src.models import SubtitleSegment, VideoMeta
from src.parser import parse
from src.asr import ASRProcessor
from src.segmenter import SemanticSegmenter
from src.llm import LLMStructurer
from src.video_understanding import VideoUnderstanding


@dataclass
class PipelineOptions:
    skip_video: bool = False           # 跳过视频理解（全局 + 段落视觉均跳过）
    visual_per_segment: bool = False   # 启用段落级视觉融合（需要 ZHIPUAI_API_KEY）
    resume: bool = False               # 从断点续跑，跳过已完成的块
    fresh: bool = False                # 清除断点缓存，强制全量重跑（优先于 resume）
    no_cache: bool = False             # 禁用 embedding 缓存


def _adaptive_seg_params(duration_seconds: int) -> dict:
    """
    根据视频时长自适应调整语义分块参数

    时长越长，窗口和块尺寸越大，避免超长视频切得太碎
    """
    if duration_seconds < 300:       # < 5 分钟
        return dict(window_seconds=15, min_chunk_seconds=30,  max_chunk_seconds=120)
    elif duration_seconds < 1800:    # 5-30 分钟
        return dict(window_seconds=30, min_chunk_seconds=60,  max_chunk_seconds=300)
    elif duration_seconds < 7200:    # 30 分钟-2 小时
        return dict(window_seconds=60, min_chunk_seconds=120, max_chunk_seconds=600)
    else:                            # > 2 小时
        return dict(window_seconds=90, min_chunk_seconds=180, max_chunk_seconds=900)


def _fetch_meta(downloader: VideoDownloader, url: str) -> VideoMeta:
    """获取视频元信息"""
    print("获取视频信息...")
    try:
        meta = downloader.get_video_meta(url)
    except Exception as e:
        raise RuntimeError(f"无法获取视频信息（{e}）\n请检查 URL 是否正确，网络是否畅通。")
    print(f"  标题：{meta.title}")
    print(f"  时长：{meta.duration}秒  UP主：{meta.uploader}")
    return meta


def _run_video_understanding(
    downloader: VideoDownloader, url: str
) -> Tuple[Optional[str], Optional[str]]:
    """
    下载视频并进行全局视觉分析

    返回：(video_analysis, video_file_path)
    两者均可能为 None（未配置 API Key 或分析失败时）
    """
    try:
        vu = VideoUnderstanding()
    except ValueError:
        print("  未配置 ZHIPUAI_API_KEY，跳过视频理解")
        return None, None

    try:
        video_file = downloader.download_video(url)
        print(f"  视频已下载：{Path(video_file).name}")
        print("  正在调用 GLM-4V 视频理解...")
        analysis = vu.analyze_local(video_file)
        if analysis:
            print("  视频理解完成")
        else:
            print("  视频理解返回空，跳过")
        return analysis, video_file
    except Exception as e:
        print(f"  视频理解失败（{e}），跳过")
        return None, None


def _get_segments(
    downloader: VideoDownloader, url: str, primary_lang: str = ''
) -> List[SubtitleSegment]:
    """
    获取字幕片段：优先下载字幕，否则走 ASR

    primary_lang：优先选择的字幕语言（来自视频元信息），透传给下载器
    抛出 RuntimeError 而非 sys.exit，让调用方统一处理
    """
    subtitle_file = downloader.download_subtitle(url, primary_lang)
    if subtitle_file:
        print(f"  找到字幕：{Path(subtitle_file).name}")
        segments = parse(subtitle_file)
        print(f"  解析到 {len(segments)} 个字幕片段")
        return segments

    print("  未找到字幕，提取音频进行语音识别...")
    try:
        audio_file = downloader.download_audio(url)
        print(f"  音频已下载：{Path(audio_file).name}")
        asr = ASRProcessor()
        print("  正在调用 ASR API...")
        segments = asr.transcribe(audio_file)
        print(f"  识别到 {len(segments)} 个片段")
        return segments
    except Exception as e:
        raise RuntimeError(f"语音识别失败（{e}）") from e


def _analyze_segment_visuals(
    video_file: str,
    chunks,
    max_workers: int = 3,
) -> Dict[int, str]:
    """并行提取各段落关键帧，返回 {chunk_index: visual_description}"""
    vu = VideoUnderstanding()
    results: Dict[int, str] = {}

    def analyze_one(args: Tuple[int, object]) -> Tuple[int, Optional[str]]:
        idx, chunk = args
        desc = vu.analyze_segment(video_file, chunk.start, chunk.end)
        return idx, desc

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        future_to_idx = {
            executor.submit(analyze_one, (i, c)): i
            for i, c in enumerate(chunks)
        }
        for future in as_completed(future_to_idx):
            idx, desc = future.result()
            if desc and desc.strip() not in ("无", ""):
                results[idx] = desc

    return results


def run(url: str, output_path: str, options: Optional[PipelineOptions] = None) -> None:
    """主处理流程"""
    options = options or PipelineOptions()
    cfg = get_config()

    # 临时禁用 embedding 缓存
    if options.no_cache:
        cfg.embed_cache_enabled = False

    with tempfile.TemporaryDirectory() as tmp_dir:
        downloader = VideoDownloader(tmp_dir)

        # 1. 元信息
        try:
            meta = _fetch_meta(downloader, url)
        except RuntimeError as e:
            print(f"错误：{e}")
            sys.exit(1)

        # 2. 并行：视频理解 + 字幕/ASR
        video_analysis: Optional[str] = None
        video_file: Optional[str] = None
        segments: List[SubtitleSegment] = []

        if options.skip_video:
            print("\n已跳过视频理解（--skip-video）")
            print("\n尝试获取字幕...")
            try:
                segments = _get_segments(downloader, url, meta.language)
            except RuntimeError as e:
                print(f"错误：{e}")
                sys.exit(1)
        else:
            # 视频理解 + 字幕/音频 并行执行，节省等待时间
            print("\n并行执行视频理解 + 字幕/语音获取...")
            with ThreadPoolExecutor(max_workers=2) as executor:
                vu_future = executor.submit(_run_video_understanding, downloader, url)
                seg_future = executor.submit(_get_segments, downloader, url, meta.language)

                try:
                    segments = seg_future.result()
                except RuntimeError as e:
                    print(f"错误：{e}")
                    sys.exit(1)

                video_analysis, video_file = vu_future.result()

        if not segments:
            print("错误：未能获取任何字幕或语音内容，无法处理。")
            sys.exit(1)

        # 3. 语义分块（根据视频时长自适应参数）
        print("\n进行语义分块...")
        seg_params = _adaptive_seg_params(meta.duration)
        print(f"  自适应参数（时长 {meta.duration}s）：{seg_params}")
        segmenter = SemanticSegmenter(block_size=2, smoothing_width=2, **seg_params)
        chunks = segmenter.chunk(segments)
        print(f"  分为 {len(chunks)} 个章节块")

        # 4. 段落级视觉融合（可选，需要视频文件 + ZHIPUAI_API_KEY）
        visual_contexts: Dict[int, str] = {}
        if options.visual_per_segment and video_file and not options.skip_video:
            print("\n提取各段落关键帧视觉描述（并行）...")
            try:
                visual_contexts = _analyze_segment_visuals(video_file, chunks)
                print(f"  完成 {len(visual_contexts)}/{len(chunks)} 个段落的视觉分析")
            except Exception as e:
                print(f"  段落视觉分析失败（{e}），跳过")

        # 5. LLM 结构化处理
        print("\n开始结构化处理...")
        try:
            structurer = LLMStructurer()
        except ValueError as e:
            print(f"错误：{e}")
            sys.exit(1)

        # 断点处理：fresh 优先于 resume
        checkpoint = None
        if options.fresh or options.resume:
            from src.cache import ChunkCheckpoint
            checkpoint = ChunkCheckpoint(meta.id)
            if options.fresh:
                checkpoint.clear()
                print("  已清除断点缓存，全量重新处理")
            elif options.resume and checkpoint.count() > 0:
                print(f"  找到断点缓存：已完成 {checkpoint.count()}/{len(chunks)} 块")

        structured_sections = structurer.process_chunks_parallel(
            chunks,
            meta.title,
            visual_contexts=visual_contexts,
            checkpoint=checkpoint,
        )

        # 6. 对视频整体理解做 LLM 二次提炼
        if video_analysis:
            print("\n提炼视频整体理解...")
            video_analysis = structurer.refine_video_analysis(video_analysis, meta.title)

        # 7. 写入输出
        output = structurer.render_output(meta, structured_sections, video_analysis)
        output_file = Path(output_path)
        output_file.write_text(output, encoding="utf-8")
        print(f"\n完成！结果已写入：{output_file.resolve()}")
