#!/usr/bin/env python3
"""VidEngine CLI - 视频结构化理解引擎

用法：
    python main.py <B站视频URL> [-o output.txt]
    python main.py <本地视频路径> --local-file [-o output.txt]
"""
import argparse
import os

from dotenv import load_dotenv

from src.config import reset_config
from src.pipeline import PipelineOptions, run


def parse_args():
    parser = argparse.ArgumentParser(
        description="VidEngine - 将B站视频转为结构化知识时间轴",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例：
  python main.py "https://www.bilibili.com/video/BV1xxxxxx"
  python main.py "https://www.bilibili.com/video/BV1xxxxxx" -o result.txt

  # 跳过视频理解，速度更快
  python main.py "https://..." --skip-video

  # 断点续跑（网络中断后继续）
  python main.py "https://..." --resume

  # 清除缓存，强制全量重跑
  python main.py "https://..." --fresh

  # 启用段落级视觉融合（每段关键帧 → GLM-4V → 视觉描述注入 Prompt）
  python main.py "https://..." --visual-per-segment

  # 禁用 embedding 缓存
  python main.py "https://..." --no-cache

  # 跳过弹幕获取
  python main.py "https://..." --skip-danmaku

  # 解析本地视频文件
  python main.py "/path/to/video.mp4" --local-file
        """,
    )
    parser.add_argument("url", help="视频 URL 或本地视频路径")
    parser.add_argument(
        "-o", "--output",
        default="output.txt",
        metavar="FILE",
        help="输出文件路径（默认：output.txt）",
    )
    parser.add_argument(
        "--skip-video",
        action="store_true",
        help="跳过视频理解，仅处理字幕/语音（节省时间和 API 费用）",
    )
    parser.add_argument(
        "--visual-per-segment",
        action="store_true",
        help="启用段落级视觉融合，需要 ZHIPUAI_API_KEY",
    )
    parser.add_argument(
        "--resume",
        action="store_true",
        help="从断点续跑，跳过已完成的块（适合网络中断后重试）",
    )
    parser.add_argument(
        "--fresh",
        action="store_true",
        help="清除断点缓存，强制全量重跑（与 --resume 互斥，--fresh 优先）",
    )
    parser.add_argument(
        "--no-cache",
        action="store_true",
        help="禁用 embedding 缓存，每次重新调用 API",
    )
    parser.add_argument(
        "--skip-danmaku",
        action="store_true",
        help="跳过弹幕获取，加快处理速度",
    )
    parser.add_argument(
        "--local-file",
        action="store_true",
        help="将输入参数按本地视频文件路径处理",
    )
    parser.add_argument(
        "--llm-provider",
        choices=("deepseek", "gpt-5.6-sol"),
        default=os.environ.get("LLM_PROVIDER", "deepseek"),
        help="结构化处理模型（默认：deepseek）",
    )
    return parser.parse_args()


def main():
    load_dotenv()
    args = parse_args()
    os.environ["LLM_PROVIDER"] = args.llm_provider
    # load_dotenv 和命令行模型选择之后重置配置，确保读取到最新配置
    reset_config()
    options = PipelineOptions(
        skip_video=args.skip_video,
        visual_per_segment=args.visual_per_segment,
        resume=args.resume,
        fresh=args.fresh,
        no_cache=args.no_cache,
        skip_danmaku=args.skip_danmaku,
        local_file=args.local_file,
    )
    run(args.url, args.output, options)


if __name__ == "__main__":
    main()
