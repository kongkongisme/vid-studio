"""DeepSeek LLM 调用：对每个时间块生成结构化知识时间轴

特性：
- 并行处理（ThreadPoolExecutor）
- 断点续跑（ChunkCheckpoint）
- 段落级视觉融合（可选）
"""
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import TYPE_CHECKING, Dict, List, Optional

from openai import OpenAI

from src.config import get_config
from src.models import TimelineChunk
from src.utils import format_duration

if TYPE_CHECKING:
    from src.cache import ChunkCheckpoint


_CHUNK_PROMPT = """\
你是一个专业的视频知识结构化助手。请分析以下视频片段的字幕（格式为"[时间戳] 文字"），提取关键信息，严格按格式输出，不要添加任何额外说明。

字幕内容：
{subtitle_text}
{visual_section}
请严格按以下格式输出，直接替换尖括号中的内容，不要保留尖括号：

## {start_time} - {end_time} | <章节标题>
**一句话总结**：<用一句话概括本段核心内容，15-25字>
**核心观点**：
- <动词开头，具体陈述>
**关键词**：<3-6个专业词汇或概念，逗号分隔>
**标签**：<2-4个话题标签，#号开头>

格式要求：
- 章节标题：推断本段主题，格式"主题：副标题"，20字以内
- 核心观点：每条以动词开头（介绍/指出/强调/演示/分析/提出），3-5条，有具体信息量
- 关键词：本段最重要的专业词汇或概念
- 标签：话题分类标签，如 #AI原理 #实战技巧 #商业分析
"""

_VISUAL_SECTION = """\
画面视觉信息（关键帧内容）：
{visual_context}
"""

_REFINE_ANALYSIS_PROMPT = """\
以下是通过 AI 视觉模型对视频样本帧的整体观察：

{raw_analysis}

请结合视频标题《{title}》，整理成一份简洁的视频概览，只输出有实际价值的条目：

- **视频形式**：一句话描述呈现方式（必填）
- **视觉内容**：若视觉分析中提到了图表/幻灯片/演示等，简要描述；若无，跳过此条
- **内容脉络**：结合标题推断讲解逻辑，用"→"连接各阶段，25字以内（必填）

要求：不输出空白或否定性的占位说明，没有信息的字段直接省略。\
"""

_HEADER_TEMPLATE = """\
# 视频知识时间轴
视频标题：{title}
总时长：{duration_str}
UP主：{uploader}

---

"""


class LLMStructurer:

    def __init__(self):
        cfg = get_config()
        if not cfg.deepseek_api_key:
            raise ValueError("环境变量 DEEPSEEK_API_KEY 未设置")

        self.client = OpenAI(
            api_key=cfg.deepseek_api_key,
            base_url=cfg.llm_base_url,
            timeout=120.0,   # 单次请求最长等待 2 分钟，避免网络挂起无限阻塞
        )
        self.cfg = cfg

    def process_chunks_parallel(
        self,
        chunks: List[TimelineChunk],
        video_title: str,
        visual_contexts: Optional[Dict[int, str]] = None,
        checkpoint: Optional["ChunkCheckpoint"] = None,
    ) -> List[str]:
        """
        并行处理多个时间块，返回按原始顺序排列的结构化文本列表

        Args:
            chunks:          时间块列表
            video_title:     视频标题（提供上下文）
            visual_contexts: 段落视觉描述 {chunk_index: visual_text}（可选）
            checkpoint:      断点续跑对象，若传入则优先读缓存（可选）
        """
        results: List[Optional[str]] = [None] * len(chunks)
        pending_indices: List[int] = []
        visual_contexts = visual_contexts or {}

        # 从断点恢复已完成的块
        if checkpoint:
            for i in range(len(chunks)):
                cached = checkpoint.get(i)
                if cached is not None:
                    results[i] = cached
                    print(f"  [{i + 1}/{len(chunks)}] 断点恢复 {chunks[i].start_str} - {chunks[i].end_str}")
                else:
                    pending_indices.append(i)
        else:
            pending_indices = list(range(len(chunks)))

        if not pending_indices:
            print("  所有块均已从断点恢复，跳过 LLM 调用")
            return results

        with ThreadPoolExecutor(max_workers=self.cfg.llm_max_workers) as executor:
            # 串行提交，每提交一个就打印，让用户看到进度而非空等
            future_to_idx = {}
            for i in pending_indices:
                print(f"  → [{i + 1}/{len(chunks)}] 提交 {chunks[i].start_str} - {chunks[i].end_str}...")
                future = executor.submit(
                    self._process_single,
                    chunks[i],
                    video_title,
                    visual_contexts.get(i),
                )
                future_to_idx[future] = i

            for future in as_completed(future_to_idx):
                idx = future_to_idx[future]
                chunk = chunks[idx]
                section = future.result()
                section += f"\n\n**原文记录**：\n{chunk.text_for_llm}"
                results[idx] = section

                # 立即持久化，防止中途失败丢失已完成的工作
                if checkpoint:
                    checkpoint.save(idx, section)

                print(f"  [{idx + 1}/{len(chunks)}] 完成 {chunk.start_str} - {chunk.end_str}")

        return results

    def _process_single(
        self,
        chunk: TimelineChunk,
        video_title: str,
        visual_context: Optional[str] = None,
        max_retries: int = 3,
    ) -> str:
        """对单个时间块调用 DeepSeek，返回结构化 Markdown"""
        # 仅在有实质性视觉信息时附加（过滤掉"无"）
        visual_section = ""
        if visual_context and visual_context.strip() not in ("无", ""):
            visual_section = _VISUAL_SECTION.format(visual_context=visual_context)

        prompt = _CHUNK_PROMPT.format(
            subtitle_text=chunk.text_for_llm,
            visual_section=visual_section,
            start_time=chunk.start_str,
            end_time=chunk.end_str,
        )

        for attempt in range(max_retries):
            try:
                response = self.client.chat.completions.create(
                    model=self.cfg.llm_model,
                    messages=[
                        {
                            "role": "system",
                            "content": (
                                f"你正在处理B站视频《{video_title}》的字幕，"
                                "请提取结构化知识时间轴，严格遵循输出格式。"
                            ),
                        },
                        {"role": "user", "content": prompt},
                    ],
                    temperature=self.cfg.llm_temperature,
                    max_tokens=self.cfg.llm_max_tokens,
                )
                return response.choices[0].message.content.strip()

            except Exception as e:
                if attempt < max_retries - 1:
                    wait = 2 ** attempt
                    print(f"  LLM 调用失败（{e}），{wait}秒后重试...")
                    time.sleep(wait)
                else:
                    return self._fallback_format(chunk)

        return self._fallback_format(chunk)

    def refine_video_analysis(self, raw_analysis: str, video_title: str) -> str:
        """用 DeepSeek 对 GLM-4V 的原始视觉分析做二次提炼，生成更有价值的视频概览"""
        prompt = _REFINE_ANALYSIS_PROMPT.format(raw_analysis=raw_analysis, title=video_title)
        try:
            response = self.client.chat.completions.create(
                model=self.cfg.llm_model,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.3,
                max_tokens=600,
            )
            return response.choices[0].message.content.strip()
        except Exception as e:
            print(f"  视频分析提炼失败（{e}），使用原始输出")
            return raw_analysis

    def render_output(
        self,
        meta,
        sections: List[str],
        video_analysis: Optional[str] = None,
    ) -> str:
        """拼接最终输出文本"""
        header = _HEADER_TEMPLATE.format(
            title=meta.title,
            duration_str=format_duration(meta.duration),
            uploader=meta.uploader,
        )
        parts = [header]
        if video_analysis:
            parts.append(f"## 视频整体理解\n\n{video_analysis}\n\n---\n")
        parts.append("\n\n".join(sections))
        parts.append("\n")
        return "".join(parts)

    @staticmethod
    def _fallback_format(chunk: TimelineChunk) -> str:
        """LLM 失败时的降级输出"""
        preview = chunk.text_for_llm[:500]
        suffix = "..." if len(chunk.text_for_llm) > 500 else ""
        return (
            f"## {chunk.start_str} - {chunk.end_str} | [结构化处理失败]\n"
            f"**原始字幕**：\n{preview}{suffix}\n"
        )
