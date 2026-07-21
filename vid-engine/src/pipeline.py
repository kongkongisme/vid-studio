"""处理管道：编排从下载到输出的完整流程"""
import hashlib
import json
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Dict, List, Optional, Tuple

if TYPE_CHECKING:
    from src.danmaku import DanmakuData

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
    skip_danmaku: bool = False         # 跳过弹幕获取
    local_file: bool = False           # 输入为本地视频文件路径


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


def _fetch_meta(downloader: VideoDownloader, url: str) -> Tuple[VideoMeta, Optional[dict]]:
    """获取视频元信息，同时返回原始 ydl info（YouTube 含评论）"""
    print("获取视频信息...")
    try:
        meta, raw_info = downloader.get_video_meta_with_info(url)
    except Exception as e:
        detail = str(e)
        if "bilibili" in url and "HTTP Error 412" in detail:
            raise RuntimeError(
                "B 站拒绝了视频信息请求（HTTP 412）。"
                "请先在 Edge 或 Chrome 中登录 B 站，再重启应用后重试。"
            ) from e
        raise RuntimeError(f"无法获取视频信息（{e}）\n请检查 URL 是否正确，网络是否畅通。")
    print(f"  标题：{meta.title}")
    print(f"  时长：{meta.duration}秒  UP主：{meta.uploader}")
    return meta, raw_info


def _local_video_id(video_path: Path) -> str:
    """为本地视频生成稳定 ID，用于断点缓存等内部标识。"""
    key = str(video_path.resolve())
    return f"local_{hashlib.sha256(key.encode('utf-8')).hexdigest()[:16]}"


def _probe_local_duration(video_path: Path) -> int:
    cmd = [
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        str(video_path),
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True)
    except FileNotFoundError as e:
        raise RuntimeError("未找到 ffprobe，请先安装 ffmpeg/ffprobe") from e

    if result.returncode != 0:
        raise RuntimeError(f"无法读取本地视频信息：{result.stderr.strip()}")

    try:
        return int(float(result.stdout.strip()))
    except ValueError as e:
        raise RuntimeError("无法读取本地视频时长，请确认文件是可解析的视频格式") from e


def _run_ffmpeg_with_progress(cmd: List[str], duration_seconds: int, error_prefix: str) -> None:
    """运行 ffmpeg 并把 -progress 输出转成人类可读进度。"""
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
    except FileNotFoundError as e:
        raise RuntimeError("未找到 ffmpeg，请先安装 ffmpeg") from e

    error_lines: List[str] = []
    last_percent = -10
    total = max(duration_seconds, 1)

    if proc.stdout:
        for raw_line in proc.stdout:
            line = raw_line.strip()
            if not line:
                continue

            if line.startswith("out_time_ms="):
                try:
                    elapsed = int(line.split("=", 1)[1]) / 1_000_000
                except ValueError:
                    continue
                percent = min(100, int((elapsed / total) * 100))
                if percent >= last_percent + 10 or percent == 100:
                    print(f"  提取音频进度：{percent}%", flush=True)
                    last_percent = percent
                continue

            if line.startswith("progress="):
                continue

            error_lines.append(line)

    code = proc.wait()
    if code != 0:
        detail = "\n".join(error_lines[-10:]) or f"ffmpeg 退出码 {code}"
        raise RuntimeError(f"{error_prefix}：{detail}")


def _fetch_local_meta(file_path: str) -> Tuple[VideoMeta, Optional[dict]]:
    """读取本地视频元信息。"""
    print("读取本地视频信息...")
    video_path = Path(file_path).expanduser()
    if not video_path.exists() or not video_path.is_file():
        raise RuntimeError(f"本地视频文件不存在：{video_path}")

    meta = VideoMeta(
        id=_local_video_id(video_path),
        title=video_path.stem,
        duration=_probe_local_duration(video_path),
        uploader="本地文件",
        language="",
    )
    print(f"  标题：{meta.title}")
    print(f"  时长：{meta.duration}秒  来源：本地文件")
    return meta, None


def _extract_local_audio(file_path: str, work_dir: str) -> str:
    """从本地视频提取 128kbps mp3 音频，返回音频路径。"""
    video_path = Path(file_path).expanduser()
    audio_path = Path(work_dir) / f"{video_path.stem}.mp3"
    duration = _probe_local_duration(video_path)
    cmd = [
        "ffmpeg", "-y",
        "-hide_banner",
        "-loglevel", "error",
        "-fflags", "+genpts",
        "-i", str(video_path),
        "-map", "0:a:0",
        "-vn",
        "-acodec", "libmp3lame",
        "-b:a", "128k",
        "-progress", "pipe:1",
        "-nostats",
        str(audio_path),
    ]

    _run_ffmpeg_with_progress(cmd, duration, "ffmpeg 提取音频失败")
    if not audio_path.exists():
        raise RuntimeError("ffmpeg 未生成音频文件")
    return str(audio_path)


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


def _run_local_video_understanding(file_path: str) -> Tuple[Optional[str], Optional[str]]:
    """对本地视频做全局视觉分析。"""
    try:
        vu = VideoUnderstanding()
    except ValueError:
        print("  未配置 ZHIPUAI_API_KEY，跳过视频理解")
        return None, None

    try:
        print("  正在调用 GLM-4V 视频理解...")
        analysis = vu.analyze_local(file_path)
        if analysis:
            print("  视频理解完成")
        else:
            print("  视频理解返回空，跳过")
        return analysis, file_path
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


def _get_local_segments(file_path: str, work_dir: str) -> List[SubtitleSegment]:
    """从本地视频提取音频并进行 ASR。"""
    print("  提取本地视频音频进行语音识别...")
    try:
        audio_file = _extract_local_audio(file_path, work_dir)
        print(f"  音频已提取：{Path(audio_file).name}")
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


def _fetch_danmaku(url: str, meta: VideoMeta, raw_info: Optional[dict] = None) -> Optional["DanmakuData"]:
    """获取弹幕/评论数据，失败返回 None"""
    from src.danmaku import DanmakuProcessor
    proc = DanmakuProcessor()

    if meta.id.startswith("BV"):
        print("  获取 B 站弹幕...")
        data = proc.fetch_bilibili(meta.id)
    elif raw_info and raw_info.get("comments"):
        print("  处理 YouTube 评论...")
        data = proc.fetch_youtube(raw_info["comments"])
    else:
        print("  非 B 站视频且无评论数据，跳过弹幕获取")
        return None

    if data:
        print(f"  获取到 {data.total_count} 条弹幕/评论")
    return data


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
            if options.local_file:
                meta, raw_info = _fetch_local_meta(url)
            else:
                meta, raw_info = _fetch_meta(downloader, url)
        except RuntimeError as e:
            print(f"错误：{e}")
            sys.exit(1)

        # 2. 并行：视频理解 + 字幕/ASR
        video_analysis: Optional[str] = None
        video_file: Optional[str] = None
        segments: List[SubtitleSegment] = []

        if options.local_file:
            if options.skip_video:
                print("\n已跳过视频理解（--skip-video）")
                try:
                    segments = _get_local_segments(url, tmp_dir)
                except RuntimeError as e:
                    print(f"错误：{e}")
                    sys.exit(1)
                danmaku_data = None
            else:
                print("\n并行执行本地视频理解 + 语音识别...")
                with ThreadPoolExecutor(max_workers=2) as executor:
                    vu_future = executor.submit(_run_local_video_understanding, url)
                    seg_future = executor.submit(_get_local_segments, url, tmp_dir)

                    try:
                        segments = seg_future.result()
                    except RuntimeError as e:
                        print(f"错误：{e}")
                        sys.exit(1)

                    video_analysis, video_file = vu_future.result()
                    danmaku_data = None
        elif options.skip_video:
            print("\n已跳过视频理解（--skip-video）")
            print("\n尝试获取字幕...")
            try:
                segments = _get_segments(downloader, url, meta.language)
            except RuntimeError as e:
                print(f"错误：{e}")
                sys.exit(1)
            # skip_video 分支：串行获取弹幕
            danmaku_data = None
            if not options.skip_danmaku:
                print("\n获取弹幕数据...")
                danmaku_data = _fetch_danmaku(url, meta, raw_info)
        else:
            # 视频理解 + 字幕/音频 + 弹幕 并行执行，节省等待时间
            print("\n并行执行视频理解 + 字幕/语音获取 + 弹幕...")
            with ThreadPoolExecutor(max_workers=3) as executor:
                vu_future = executor.submit(_run_video_understanding, downloader, url)
                seg_future = executor.submit(_get_segments, downloader, url, meta.language)
                dm_future = (
                    executor.submit(_fetch_danmaku, url, meta, raw_info)
                    if not options.skip_danmaku
                    else None
                )

                try:
                    segments = seg_future.result()
                except RuntimeError as e:
                    print(f"错误：{e}")
                    sys.exit(1)

                video_analysis, video_file = vu_future.result()
                try:
                    danmaku_data = dm_future.result() if dm_future else None
                except Exception as e:
                    print(f"  弹幕获取失败（{e}），跳过")
                    danmaku_data = None

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

        # 弹幕 chunk 映射
        danmaku_contexts: Dict[int, str] = {}
        if danmaku_data:
            from src.danmaku import DanmakuProcessor
            proc = DanmakuProcessor()
            print("\n构建弹幕段落映射...")
            danmaku_contexts = proc.build_chunk_contexts(danmaku_data, chunks)
            print(f"  {len(danmaku_contexts)}/{len(chunks)} 个段落有弹幕数据")

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
            danmaku_contexts=danmaku_contexts,   # 传入弹幕段落摘要
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

        # 写出弹幕 JSON（可选）
        if danmaku_data:
            danmaku_path = Path(output_path + ".danmaku.json")
            danmaku_dict = {
                "platform": danmaku_data.platform,
                "total_count": danmaku_data.total_count,
                "word_freq": danmaku_data.word_freq,
                "density_bins": danmaku_data.density_bins,
                "chunk_top": danmaku_data.chunk_top,
            }
            danmaku_path.write_text(json.dumps(danmaku_dict, ensure_ascii=False), encoding="utf-8")
            print(f"弹幕数据已写入：{danmaku_path.resolve()}")
