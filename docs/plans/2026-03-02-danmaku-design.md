# 弹幕解析功能设计文档

**日期**：2026-03-02
**状态**：已批准，待实现

---

## 背景

vid-studio 当前通过字幕/ASR + LLM 生成视频知识时间轴，缺少观众视角的信息层。弹幕是 B 站独特的实时互动数据，能反映观众在特定时刻的情绪、困惑点和高光反应，可显著丰富知识时间轴的生成质量和展示维度。

---

## 目标功能

1. **弹幕融入 LLM 分析**：将该时段热门弹幕作为辅助上下文注入 LLM Prompt，帮助识别高光时刻和观众关注点
2. **弹幕洞察 Tab**：右侧面板新增独立标签页，展示弹幕密度热力图 + 高频词词云
3. **时间轴卡片代表性弹幕**：每张卡片展示该时段 Top 3 弹幕，体现现场互动氛围

---

## 架构总览

```
B站弹幕 API / yt-dlp 评论
        ↓
  danmaku.py（新模块）
        ↓ 并行于现有 pipeline
  pipeline.py（集成点）
    ├→ 弹幕上下文注入 LLM Prompt（与 visual_context 同级）
    └→ 写出 .danmaku.json（与 .txt 同路径）
        ↓
  Electron 主进程
    └→ parse-video 结束时读取 .danmaku.json 一并返回
        ↓
  Vue 前端
    ├→ 右侧面板新增第三个 Tab：弹幕洞察
    │    ├── 弹幕密度热力图（时间轴条带）
    │    └── 高频词词云（CSS font-size 缩放，无需外部库）
    └→ 每张时间轴卡片底部展示该时间段 Top 3 弹幕
```

---

## 数据层设计

### Python 数据模型（`src/danmaku.py`）

```python
@dataclass
class DanmakuItem:
    start: float   # 弹幕出现时间（秒），YouTube 评论为 -1
    text: str
    likes: int = 0

@dataclass
class DanmakuData:
    platform: str                          # 'bilibili' | 'youtube'
    items: List[DanmakuItem]               # 全量弹幕/评论
    word_freq: List[Tuple[str, int]]       # Top 50 词频
    density_bins: List[Tuple[float, float, int]]  # (time_start, time_end, count)
    chunk_top: Dict[str, List[str]]        # chunk_key → Top 3-5 弹幕文本
```

### `.danmaku.json` 输出结构

```json
{
  "platform": "bilibili",
  "total_count": 1234,
  "word_freq": [["哇", 80], ["牛", 60]],
  "density_bins": [[0, 30, 15], [30, 60, 42]],
  "chunk_top": {
    "00:00-05:00": ["弹幕A", "弹幕B", "弹幕C"]
  }
}
```

### B 站弹幕获取路径

1. `GET https://api.bilibili.com/x/web-interface/view?bvid={bvid}` → 获取 `cid`
2. `GET https://comment.bilibili.com/{cid}.xml` → 弹幕 XML
3. 解析 `<d p="time,type,size,color,...">content</d>`，提取时间戳和内容

Cookie 通过读取 `vid-engine/.env` 中已有的 yt-dlp cookie 机制复用，或直接用 `requests` 库携带系统 Cookie。

### YouTube 处理

yt-dlp `extract_info` 的 `comments` 字段（无时间戳），只做全局词频分析，不生成热力图和 chunk 映射。

---

## 后端集成点

### `src/pipeline.py`

- `PipelineOptions` 新增 `skip_danmaku: bool = False`
- `run()` 中在阶段 2 的并行块内新增弹幕获取 future（第三个 worker）
- 弹幕数据经 `DanmakuProcessor.build_chunk_contexts(chunks)` 生成 `danmaku_contexts: Dict[int, str]`
- 传入 `structurer.process_chunks_parallel(..., danmaku_contexts=danmaku_contexts)`
- `run()` 结束前将 `DanmakuData` 序列化写出到 `{output_path}.danmaku.json`

### `src/llm.py`

新增 prompt 模板：

```python
_DANMAKU_SECTION = """\
观众弹幕反应（该时间段热门弹幕，可反映观众关注点）：
{danmaku_summary}
"""
```

- `_process_single` 新增参数 `danmaku_context: Optional[str]`
- `process_chunks_parallel` 新增参数 `danmaku_contexts: Optional[Dict[int, str]]`
- `danmaku_section` 注入位于 `visual_section` 之后

---

## 前端 UI

### Tab 扩展

`activeTab` 类型：`'timeline' | 'danmaku' | 'chat'`

### 弹幕洞察 Tab

```
┌─────────────────────────────────┐
│ 弹幕密度             共 1234 条  │
│ ████░░░███████░░░██░░░░░░░░░░░  │  ← 每格高度=密度
│ 0min        5min        10min   │
│                                 │
│ 高频词                          │
│  哇  牛逼  太快了  没听懂  666   │  ← font-size 按词频缩放
│    好厉害   干货   厉害          │
└─────────────────────────────────┘
```

实现方式：纯 CSS + Vue，不引入外部可视化库。

### 时间轴卡片代表性弹幕

每张卡片展开后，在「原文记录」区域之前新增「弹幕反应」折叠区，展示 Top 3 弹幕（灰色小字，`💬` 前缀）。

### 数据流

`window.api.parseVideo()` 返回结果新增 `danmaku` 可选字段，Vue 存入 `danmakuData` ref。

### 容错

- 弹幕获取失败：`danmaku` 为 `null`，Tab 显示「弹幕数据不可用」，卡片静默不渲染
- YouTube：只显示全局词云，热力图区域隐藏（无时间戳）
- `skip_danmaku` 参数：可通过 UI 选项跳过弹幕获取（加快速度）

---

## 文件变更清单

### 新增
- `vid-engine/src/danmaku.py` — 弹幕获取、解析、统计模块

### 修改
- `vid-engine/src/pipeline.py` — 并行获取弹幕，传递给 LLM，写出 JSON
- `vid-engine/src/llm.py` — 新增 `danmaku_contexts` 参数和 Prompt 模板
- `src/main/index.ts` — `parse-video` 读取 `.danmaku.json` 并返回
- `src/preload/index.ts` — 类型扩展（danmaku 字段）
- `src/renderer/src/App.vue` — 新增 Tab、弹幕洞察页面、卡片弹幕区

---

## 非目标（不在本次范围内）

- 实时弹幕滚动展示（UI 动画）
- 弹幕情感分析
- 弹幕搜索/过滤
- 付费弹幕特殊处理
