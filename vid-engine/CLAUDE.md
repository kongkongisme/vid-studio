# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

VidEngine 是一个视频结构化理解引擎，将 B 站视频转换为结构化知识时间轴（Markdown 格式）。

## 常用命令

```bash
# 安装依赖
pip install -r requirements.txt

# 配置环境变量
cp .env.example .env  # 填入 API Key

# 基础运行（跳过视频视觉理解）
python main.py "https://www.bilibili.com/video/BV1xxxxxx" --skip-video

# 完整运行（含视频视觉理解）
python main.py "https://..." --visual-per-segment

# 断点续跑（网络中断后恢复）
python main.py "https://..." --resume

# 全量重跑（清除所有断点缓存）
python main.py "https://..." --fresh
```

**必需 API Key**（写入 `.env`）：
- `SILICONFLOW_API_KEY`：ASR 语音识别 + Embedding
- `DEEPSEEK_API_KEY`：LLM 结构化处理

**可选 API Key**：
- `ZHIPUAI_API_KEY`：GLM-4V 视频视觉理解（`--visual-per-segment` 时需要）

## 架构

### 处理流程

```
URL → 元信息获取
    → 并行：视频视觉理解（GLM-4V）+ 字幕获取（字幕 > ASR）
    → 语义分块（TextTiling + Embedding）
    → LLM 结构化处理（DeepSeek，并行）
    → Markdown 输出
```

### 核心模块

| 模块 | 职责 |
|------|------|
| `main.py` | CLI 入口，参数解析 |
| `src/pipeline.py` | 主流程编排，并行协调 |
| `src/config.py` | 全局配置单例（可通过 `.env` 覆盖） |
| `src/models.py` | 数据模型：`SubtitleSegment`、`TimelineChunk`、`VideoMeta` |
| `src/downloader.py` | yt-dlp 封装，下载视频/字幕/音频 |
| `src/parser.py` | VTT / JSON3 字幕格式解析 |
| `src/asr.py` | SenseVoiceSmall ASR，支持大文件自动分片 |
| `src/embedder.py` | BAAI/bge-m3 Embedding，磁盘缓存 |
| `src/llm.py` | DeepSeek LLM 调用，结构化输出渲染 |
| `src/video_understanding.py` | GLM-4V 视频帧分析（全局网格 + 段落单帧） |
| `src/cache.py` | Embedding 缓存 + Chunk 断点续跑 |
| `src/segmenter/semantic.py` | TextTiling 语义分块（主路径） |
| `src/segmenter/timeline.py` | 固定时长分块（降级路径） |

### 并行处理策略

- **阶段 2**：视频理解 + 字幕获取并行（2 worker）
- **阶段 5**：段落关键帧提取并行（3 worker）
- **阶段 6**：LLM 结构化分析并行（4 worker，可在 `config.py` 调整）

### 缓存系统

- **Embedding 缓存**：`.cache/embeddings.json`，键为文本 SHA256 前 16 位
- **断点续跑**：`.cache/checkpoints/<video_id>.json`，每块 LLM 结果完成后立即持久化

### 容错降级

- 字幕获取失败 → 自动转为 ASR 转录
- 语义分块失败 → 降级为时长分块（`segmenter/timeline.py`）
- LLM 调用失败（3 次重试）→ 降级为原始字幕预览
- 视频理解失败 → 跳过，不影响后续处理

### 自适应分块参数

`SemanticSegmenter` 根据视频时长自动调整 `window_seconds`、`min_chunk_seconds`、`max_chunk_seconds`，详见 `src/segmenter/semantic.py` 中的 `_adaptive_params()`。
