# 弹幕解析功能实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 为 vid-studio 添加弹幕解析功能：B 站弹幕/YouTube 评论获取 → LLM 上下文注入 → 前端弹幕洞察 Tab + 时间轴卡片展示。

**Architecture:** 新增 `vid-engine/src/danmaku.py` 核心模块，在 pipeline 阶段 2 并行获取弹幕，写出 `.danmaku.json`；Electron 主进程读取后随解析结果返回前端；Vue 新增「弹幕洞察」Tab（纯 CSS 热力图 + 词云）并在时间轴卡片中展示代表性弹幕。

**Tech Stack:** Python `requests` + `xml.etree.ElementTree`（已有依赖）；yt-dlp comments（YouTube）；TypeScript / Vue 3 / CSS（前端）

---

## Task 1: danmaku.py — 数据模型 + B站弹幕获取

**Files:**
- Create: `vid-engine/src/danmaku.py`
- Create: `vid-engine/tests/__init__.py`
- Create: `vid-engine/tests/test_danmaku.py`

---

**Step 1: 创建测试文件，写第一个失败测试（数据模型）**

```python
# vid-engine/tests/test_danmaku.py
import pytest
from src.danmaku import DanmakuItem, DanmakuData, DanmakuProcessor


def test_danmaku_item_defaults():
    item = DanmakuItem(start=10.5, text="牛逼")
    assert item.start == 10.5
    assert item.text == "牛逼"
    assert item.likes == 0


def test_danmaku_data_fields():
    data = DanmakuData(
        platform="bilibili",
        items=[DanmakuItem(start=0, text="test")],
        word_freq=[("test", 1)],
        density_bins=[(0, 30, 1)],
        chunk_top={"00:00-01:00": ["test"]},
    )
    assert data.total_count == 1
```

**Step 2: 运行测试，确认失败**

```bash
cd vid-engine && python -m pytest tests/test_danmaku.py -v
```
预期：`ModuleNotFoundError: No module named 'src.danmaku'`

**Step 3: 创建 danmaku.py，实现数据模型**

```python
# vid-engine/src/danmaku.py
"""弹幕/评论获取与处理：B站弹幕 XML + YouTube yt-dlp 评论"""
import re
import xml.etree.ElementTree as ET
from collections import Counter
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

import requests


@dataclass
class DanmakuItem:
    start: float   # 弹幕出现时间（秒）；YouTube 评论为 -1
    text: str
    likes: int = 0


@dataclass
class DanmakuData:
    platform: str                                    # 'bilibili' | 'youtube'
    items: List[DanmakuItem] = field(default_factory=list)
    word_freq: List[Tuple[str, int]] = field(default_factory=list)        # Top 50
    density_bins: List[Tuple[float, float, int]] = field(default_factory=list)  # (start, end, count)
    chunk_top: Dict[str, List[str]] = field(default_factory=dict)         # key → Top 3

    @property
    def total_count(self) -> int:
        return len(self.items)


class DanmakuProcessor:
    """弹幕数据获取、统计、chunk 映射"""

    _HEADERS = {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/120.0.0.0 Safari/537.36"
        ),
        "Referer": "https://www.bilibili.com",
    }

    # ── B 站 ──────────────────────────────────────────────

    def fetch_bilibili(self, bvid: str) -> Optional[DanmakuData]:
        """获取 B 站弹幕，失败返回 None"""
        try:
            cid = self._get_cid(bvid)
            if not cid:
                return None
            items = self._fetch_xml(cid)
            if not items:
                return None
            return self._build_data("bilibili", items)
        except Exception as e:
            print(f"  弹幕获取失败（{e}），跳过")
            return None

    def _get_cid(self, bvid: str) -> Optional[int]:
        url = f"https://api.bilibili.com/x/web-interface/view?bvid={bvid}"
        resp = requests.get(url, headers=self._HEADERS, timeout=10)
        data = resp.json()
        return data.get("data", {}).get("cid")

    def _fetch_xml(self, cid: int) -> List[DanmakuItem]:
        url = f"https://comment.bilibili.com/{cid}.xml"
        resp = requests.get(url, headers=self._HEADERS, timeout=15)
        resp.encoding = "utf-8"
        root = ET.fromstring(resp.text)
        items: List[DanmakuItem] = []
        for d in root.findall("d"):
            p = d.get("p", "")
            text = (d.text or "").strip()
            if not text or not p:
                continue
            try:
                start = float(p.split(",")[0])
                items.append(DanmakuItem(start=start, text=text))
            except (ValueError, IndexError):
                continue
        return items

    # ── YouTube ───────────────────────────────────────────

    def fetch_youtube(self, comments: List[dict]) -> Optional[DanmakuData]:
        """从 yt-dlp comments 列表构建弹幕数据（无时间戳）"""
        if not comments:
            return None
        items = [
            DanmakuItem(start=-1, text=c.get("text", "").strip(), likes=c.get("like_count", 0))
            for c in comments[:2000]
            if c.get("text", "").strip()
        ]
        if not items:
            return None
        return self._build_data("youtube", items)

    # ── 统计处理 ──────────────────────────────────────────

    def _build_data(self, platform: str, items: List[DanmakuItem]) -> DanmakuData:
        return DanmakuData(
            platform=platform,
            items=items,
            word_freq=self._calc_word_freq(items),
            density_bins=self._calc_density(items),
            chunk_top={},   # 由 build_chunk_contexts() 填充
        )

    @staticmethod
    def _extract_words(text: str) -> List[str]:
        """从弹幕文本提取词汇：短文本整体保留，长文本提取中文双字词"""
        clean = re.sub(r'[^\u4e00-\u9fa5a-zA-Z0-9]', '', text)
        if not clean:
            return []
        if len(clean) <= 8:
            return [clean]
        # 中文双字词（bigram）+ 英文单词
        zh = re.findall(r'[\u4e00-\u9fa5]{2,}', clean)
        words = []
        for chunk in zh:
            for i in range(len(chunk) - 1):
                words.append(chunk[i:i + 2])
        words += re.findall(r'[a-zA-Z]{3,}', clean.lower())
        return words

    def _calc_word_freq(self, items: List[DanmakuItem], top_n: int = 50) -> List[Tuple[str, int]]:
        counter: Counter = Counter()
        stopwords = {"的", "了", "吗", "呢", "啊", "哦", "嗯", "哈", "呀", "就", "都", "也", "不", "是"}
        for item in items:
            for word in self._extract_words(item.text):
                if word not in stopwords and len(word) >= 2:
                    counter[word] += 1
        return counter.most_common(top_n)

    @staticmethod
    def _calc_density(items: List[DanmakuItem], bin_seconds: int = 30) -> List[Tuple[float, float, int]]:
        timed = [i for i in items if i.start >= 0]
        if not timed:
            return []
        max_time = max(i.start for i in timed)
        n_bins = int(max_time / bin_seconds) + 1
        counts = [0] * n_bins
        for item in timed:
            idx = int(item.start / bin_seconds)
            counts[idx] += 1
        return [(b * bin_seconds, (b + 1) * bin_seconds, counts[b]) for b in range(n_bins)]

    def build_chunk_contexts(self, data: DanmakuData, chunks) -> Dict[int, str]:
        """
        将弹幕按时间段归入 chunk，返回 {chunk_index: danmaku_summary_str}
        同时填充 data.chunk_top
        """
        contexts: Dict[int, str] = {}
        timed_items = [i for i in data.items if i.start >= 0]

        for idx, chunk in enumerate(chunks):
            bucket = [
                i for i in timed_items
                if chunk.start <= i.start < chunk.end
            ]
            if not bucket:
                continue
            # Top 5：先按 likes 降序，再按重复次数降序
            text_counts: Counter = Counter(i.text for i in bucket)
            top_texts = [t for t, _ in text_counts.most_common(5)]
            data.chunk_top[chunk.id_str] = top_texts[:3]

            # 供 LLM 的一行汇总
            contexts[idx] = "  /  ".join(top_texts[:5])

        return contexts
```

**Step 4: 补充 `TimelineChunk.id_str` property（需要在 models.py 添加）**

在 `vid-engine/src/models.py` 的 `TimelineChunk` 类中，`start_str` 和 `end_str` 已存在，chunk_top 的 key 格式为 `"{start_str}-{end_str}"`：

```python
# 在 TimelineChunk 中新增（models.py 约第 27 行之后）
@property
def id_str(self) -> str:
    """对应前端 chunk.id 的格式：startTime-endTime"""
    return f"{self.start_str}-{self.end_str}"
```

**Step 5: 运行测试，确认通过**

```bash
cd vid-engine && python -m pytest tests/test_danmaku.py -v
```
预期：全部 PASS

---

**Step 6: 补充词频和密度统计的单元测试**

```python
# 追加到 tests/test_danmaku.py

def test_extract_words_short():
    from src.danmaku import DanmakuProcessor
    proc = DanmakuProcessor()
    assert proc._extract_words("牛逼") == ["牛逼"]
    assert proc._extract_words("666") == ["666"]
    assert proc._extract_words("") == []


def test_calc_density_basic():
    from src.danmaku import DanmakuProcessor, DanmakuItem
    proc = DanmakuProcessor()
    items = [DanmakuItem(start=10, text="a"), DanmakuItem(start=45, text="b")]
    bins = proc._calc_density(items, bin_seconds=30)
    assert bins[0] == (0, 30, 1)
    assert bins[1] == (30, 60, 1)


def test_calc_word_freq():
    from src.danmaku import DanmakuProcessor, DanmakuItem
    proc = DanmakuProcessor()
    items = [DanmakuItem(start=0, text="牛逼")] * 5 + [DanmakuItem(start=0, text="哈哈哈")]
    freq = proc._calc_word_freq(items)
    assert freq[0] == ("牛逼", 5)
```

**Step 7: 运行所有测试**

```bash
cd vid-engine && python -m pytest tests/ -v
```
预期：全部 PASS

**Step 8: 创建 tests/__init__.py**

```bash
touch vid-engine/tests/__init__.py
```

**Step 9: 提交**

```bash
git add vid-engine/src/danmaku.py vid-engine/src/models.py vid-engine/tests/
git commit -m "feat: 添加弹幕模块 danmaku.py + 数据模型 + 单元测试"
```

---

## Task 2: pipeline.py — 并行集成弹幕获取

**Files:**
- Modify: `vid-engine/src/pipeline.py`
- Modify: `vid-engine/main.py`

---

**Step 1: 在 `PipelineOptions` 中新增 `skip_danmaku` 字段**

在 `vid-engine/src/pipeline.py` 第 20-26 行的 `PipelineOptions` 中添加：

```python
@dataclass
class PipelineOptions:
    skip_video: bool = False
    visual_per_segment: bool = False
    resume: bool = False
    fresh: bool = False
    no_cache: bool = False
    skip_danmaku: bool = False   # 新增：跳过弹幕获取
```

**Step 2: 新增 `_fetch_danmaku` 函数**

在 `pipeline.py` 中，在 `_analyze_segment_visuals` 函数之前添加：

```python
def _fetch_danmaku(url: str, meta: VideoMeta, ydl_info: Optional[dict] = None):
    """获取弹幕/评论数据，返回 DanmakuData 或 None"""
    from src.danmaku import DanmakuProcessor
    proc = DanmakuProcessor()

    # 判断平台：B站 BV ID 以 BV 开头
    if meta.id.startswith("BV"):
        print("  获取 B 站弹幕...")
        data = proc.fetch_bilibili(meta.id)
    elif ydl_info and ydl_info.get("comments"):
        print("  处理 YouTube 评论...")
        data = proc.fetch_youtube(ydl_info["comments"])
    else:
        print("  非 B 站视频且无评论数据，跳过弹幕获取")
        return None

    if data:
        print(f"  获取到 {data.total_count} 条弹幕/评论")
    return data
```

> **注意**：此时 `_fetch_meta` 需要同时返回 ydl_info 以便 YouTube 评论访问。为简化实现，YouTube 评论通过在 `_fetch_meta` 中开启 `getcomments` 选项获取（见下一步）。

**Step 3: 修改 `_fetch_meta` 支持 YouTube 评论获取**

`_fetch_meta` 返回值扩展为同时返回原始 info（用于 YouTube 评论）：

在 `pipeline.py` 中修改 `_fetch_meta` 函数签名和实现：

```python
def _fetch_meta(downloader: VideoDownloader, url: str) -> Tuple[VideoMeta, Optional[dict]]:
    """获取视频元信息，同时返回原始 ydl info（含 YouTube 评论）"""
    print("获取视频信息...")
    try:
        meta, raw_info = downloader.get_video_meta_with_info(url)
    except Exception as e:
        raise RuntimeError(f"无法获取视频信息（{e}）\n请检查 URL 是否正确，网络是否畅通。")
    print(f"  标题：{meta.title}")
    print(f"  时长：{meta.duration}秒  UP主：{meta.uploader}")
    return meta, raw_info
```

在 `vid-engine/src/downloader.py` 中新增方法：

```python
def get_video_meta_with_info(self, url: str) -> Tuple[VideoMeta, dict]:
    """获取视频元信息，同时返回完整 info 字典"""
    # YouTube 视频额外获取评论（Top 100）
    is_youtube = "youtube.com" in url or "youtu.be" in url
    opts = {
        **self._base_opts(),
        "extract_flat": False,
    }
    if is_youtube:
        opts["getcomments"] = True
        opts["extractor_args"] = {"youtube": {"comment_sort": ["top"], "max_comments": ["100"]}}

    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
        meta = VideoMeta(
            id=info.get("id", ""),
            title=info.get("title", "未知标题"),
            duration=int(info.get("duration") or 0),
            uploader=info.get("uploader", ""),
            language=info.get("language", "") or "",
        )
        return meta, info
```

同时更新 `downloader.py` 顶部导入：

```python
from typing import Optional, Tuple
```

**Step 4: 在 `run()` 阶段 2 并行中新增弹幕获取 future**

在 `pipeline.py` 的 `run()` 函数中，将阶段 2 的并行 executor max_workers 从 2 改为 3，并新增弹幕 future：

```python
# 原来 skip_video 分支的 _fetch_meta 调用也需更新
# 在 run() 开始处，将：
meta = _fetch_meta(downloader, url)
# 改为：
meta, raw_info = _fetch_meta(downloader, url)

# 在 skip_video=True 分支中（约第 166-173 行）：
danmaku_data = None
if not options.skip_danmaku:
    danmaku_data = _fetch_danmaku(url, meta, raw_info)

# 在并行分支（约第 176-187 行），max_workers 改为 3，新增弹幕 future：
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
    danmaku_data = dm_future.result() if dm_future else None
```

**Step 5: 在阶段 3 之后建立 chunk 上下文映射**

在语义分块完成后（约第 199 行 `chunks = segmenter.chunk(segments)` 之后）：

```python
# 弹幕 chunk 映射
danmaku_contexts: Dict[int, str] = {}
if danmaku_data:
    from src.danmaku import DanmakuProcessor
    proc = DanmakuProcessor()
    print("\n构建弹幕段落映射...")
    danmaku_contexts = proc.build_chunk_contexts(danmaku_data, chunks)
    print(f"  {len(danmaku_contexts)}/{len(chunks)} 个段落有弹幕数据")
```

**Step 6: 将 `danmaku_contexts` 传入 LLM（准备好接口，实际在 Task 3 修改 llm.py）**

将 `structurer.process_chunks_parallel` 调用改为：

```python
structured_sections = structurer.process_chunks_parallel(
    chunks,
    meta.title,
    visual_contexts=visual_contexts,
    danmaku_contexts=danmaku_contexts,   # 新增
    checkpoint=checkpoint,
)
```

**Step 7: 写出 `.danmaku.json`**

在 `run()` 阶段 7（写入输出）之后，追加：

```python
# 写出弹幕 JSON（可选）
if danmaku_data:
    import json as _json
    from dataclasses import asdict
    danmaku_path = Path(output_path + ".danmaku.json")
    danmaku_dict = {
        "platform": danmaku_data.platform,
        "total_count": danmaku_data.total_count,
        "word_freq": danmaku_data.word_freq,
        "density_bins": danmaku_data.density_bins,
        "chunk_top": danmaku_data.chunk_top,
    }
    danmaku_path.write_text(_json.dumps(danmaku_dict, ensure_ascii=False), encoding="utf-8")
    print(f"弹幕数据已写入：{danmaku_path.resolve()}")
```

**Step 8: 在 `main.py` 添加 `--skip-danmaku` 参数**

在 `main.py` 的 `parse_args()` 中添加：

```python
parser.add_argument(
    "--skip-danmaku",
    action="store_true",
    help="跳过弹幕获取，加快处理速度",
)
```

在 `main()` 的 `PipelineOptions` 初始化中添加：

```python
options = PipelineOptions(
    skip_video=args.skip_video,
    visual_per_segment=args.visual_per_segment,
    resume=args.resume,
    fresh=args.fresh,
    no_cache=args.no_cache,
    skip_danmaku=args.skip_danmaku,   # 新增
)
```

**Step 9: 手动验证（可选）**

```bash
cd vid-engine
python main.py "https://www.bilibili.com/video/BVxxxxxxxx" --skip-video -o /tmp/test_out.txt
# 检查是否生成 /tmp/test_out.txt.danmaku.json
```

**Step 10: 提交**

```bash
git add vid-engine/src/pipeline.py vid-engine/src/downloader.py vid-engine/main.py
git commit -m "feat: pipeline 集成弹幕并行获取，写出 .danmaku.json"
```

---

## Task 3: llm.py — 弹幕上下文注入 LLM Prompt

**Files:**
- Modify: `vid-engine/src/llm.py`

---

**Step 1: 新增 `_DANMAKU_SECTION` 模板**

在 `vid-engine/src/llm.py` 的 `_VISUAL_SECTION` 常量之后添加：

```python
_DANMAKU_SECTION = """\
观众弹幕反应（该时间段热门弹幕，反映观众实时关注点）：
{danmaku_summary}
"""
```

**Step 2: 修改 `_process_single` 签名，添加 `danmaku_context` 参数**

将第 152 行的函数签名：

```python
def _process_single(
    self,
    chunk: TimelineChunk,
    video_title: str,
    visual_context: Optional[str] = None,
    max_retries: int = 3,
) -> str:
```

改为：

```python
def _process_single(
    self,
    chunk: TimelineChunk,
    video_title: str,
    visual_context: Optional[str] = None,
    danmaku_context: Optional[str] = None,
    max_retries: int = 3,
) -> str:
```

**Step 3: 在 `_process_single` 中注入弹幕段落**

在构建 `visual_section` 的代码之后（约第 162-163 行），追加弹幕 section：

```python
danmaku_section = ""
if danmaku_context and danmaku_context.strip():
    danmaku_section = _DANMAKU_SECTION.format(danmaku_summary=danmaku_context)
```

将 `prompt` 构建改为在 `visual_section` 之后附加 `danmaku_section`：

```python
prompt = _CHUNK_PROMPT.format(
    subtitle_text=chunk.text_for_llm,
    visual_section=visual_section + danmaku_section,   # 合并到同一 placeholder
    start_time=chunk.start_str,
    end_time=chunk.end_str,
)
```

**Step 4: 修改 `process_chunks_parallel` 接受并传递 `danmaku_contexts`**

在第 88 行函数签名中添加参数：

```python
def process_chunks_parallel(
    self,
    chunks: List[TimelineChunk],
    video_title: str,
    visual_contexts: Optional[Dict[int, str]] = None,
    danmaku_contexts: Optional[Dict[int, str]] = None,   # 新增
    checkpoint: Optional["ChunkCheckpoint"] = None,
) -> List[str]:
```

在第 106 行初始化之后添加：

```python
danmaku_contexts = danmaku_contexts or {}
```

在第 129-135 行的 `executor.submit` 调用中，传入 `danmaku_context`：

```python
future = executor.submit(
    self._process_single,
    chunks[i],
    video_title,
    visual_contexts.get(i),
    danmaku_contexts.get(i),   # 新增
)
```

**Step 5: 运行弹幕相关测试，确认无报错**

```bash
cd vid-engine && python -m pytest tests/ -v
```
预期：全部 PASS

**Step 6: 提交**

```bash
git add vid-engine/src/llm.py
git commit -m "feat: LLM Prompt 融入弹幕上下文（danmaku_contexts）"
```

---

## Task 4: main/index.ts — IPC 读取 .danmaku.json

**Files:**
- Modify: `src/main/index.ts`

---

**Step 1: 在 `parse-video` handler 中读取 danmaku JSON**

在 `src/main/index.ts` 的 `parse-video` handler 中，找到成功分支（约第 208-212 行）：

```typescript
// 原来：
if (code === 0) {
  try {
    resolve({ success: true, output: await readFile(outputPath, 'utf-8') })
  } catch {
    resolve({ success: false, error: '读取输出文件失败' })
  }
}
```

改为：

```typescript
if (code === 0) {
  try {
    const output = await readFile(outputPath, 'utf-8')
    let danmaku: object | null = null
    try {
      const raw = await readFile(`${outputPath}.danmaku.json`, 'utf-8')
      danmaku = JSON.parse(raw)
    } catch {
      // 弹幕数据可选，获取失败静默忽略
    }
    resolve({ success: true, output, danmaku })
  } catch {
    resolve({ success: false, error: '读取输出文件失败' })
  }
}
```

**Step 2: 更新 `parse-video` IPC 返回类型**

在 `src/main/index.ts` 约第 194 行的 Promise 类型注解：

```typescript
return new Promise<{ success: boolean; output?: string; danmaku?: object | null; error?: string }>((resolve) => {
```

**Step 3: 检查 TypeScript 编译无报错**

```bash
npm run typecheck
```
预期：无新增错误

**Step 4: 提交**

```bash
git add src/main/index.ts
git commit -m "feat: parse-video IPC 返回弹幕 JSON 数据"
```

---

## Task 5: preload/index.ts — 类型扩展

**Files:**
- Modify: `src/preload/index.ts`

---

**Step 1: 新增 `DanmakuData` 接口**

在 `src/preload/index.ts` 的 `ParseOptions` 接口之后添加：

```typescript
interface DanmakuData {
  platform: string
  total_count: number
  word_freq: [string, number][]
  density_bins: [number, number, number][]
  chunk_top: Record<string, string[]>
}
```

**Step 2: 更新 `parseVideo` 返回类型**

将：

```typescript
parseVideo: (
  url: string,
  options?: ParseOptions
): Promise<{ success: boolean; output?: string; error?: string }> =>
  ipcRenderer.invoke('parse-video', url, options),
```

改为：

```typescript
parseVideo: (
  url: string,
  options?: ParseOptions
): Promise<{ success: boolean; output?: string; danmaku?: DanmakuData | null; error?: string }> =>
  ipcRenderer.invoke('parse-video', url, options),
```

**Step 3: 检查 TypeScript 编译**

```bash
npm run typecheck
```
预期：无新增错误

**Step 4: 提交**

```bash
git add src/preload/index.ts
git commit -m "feat: preload 添加 DanmakuData 类型，扩展 parseVideo 返回值"
```

---

## Task 6: App.vue — 弹幕洞察 Tab + 时间轴卡片弹幕

**Files:**
- Modify: `src/renderer/src/App.vue`

---

### Step 1: 新增 DanmakuData 类型定义

在 `App.vue` 的类型定义区（`<script setup>` 顶部，`TimelineChunk` 接口之前）添加：

```typescript
interface DanmakuData {
  platform: string
  total_count: number
  word_freq: [string, number][]
  density_bins: [number, number, number][]
  chunk_top: Record<string, string[]>
}
```

### Step 2: 新增 danmakuData ref，扩展 activeTab 类型

将 `activeTab` 的类型定义（约第 138 行）从：

```typescript
const activeTab = ref<'timeline' | 'chat'>('timeline')
```

改为：

```typescript
const activeTab = ref<'timeline' | 'danmaku' | 'chat'>('timeline')
const danmakuData = ref<DanmakuData | null>(null)
```

### Step 3: 在 `parseVideo()` 中处理弹幕数据

在 `parseVideo()` 函数的初始化清空区（约第 568-572 行，`progressLog.value = []` 附近）添加：

```typescript
danmakuData.value = null
```

在成功处理结果区（约第 596-599 行）：

```typescript
if (result.success && result.output) {
  timelineChunks.value = parseMarkdown(result.output)
  danmakuData.value = result.danmaku ?? null   // 新增
  await saveHistory(result.output)
}
```

### Step 4: 新增弹幕词频计算的计算属性

```typescript
const danmakuWordCloudItems = computed(() => {
  if (!danmakuData.value?.word_freq?.length) return []
  const freq = danmakuData.value.word_freq
  const maxCount = freq[0][1]
  const minCount = freq[freq.length - 1][1]
  const range = maxCount - minCount || 1
  return freq.slice(0, 40).map(([word, count]) => ({
    word,
    count,
    size: Math.round(12 + ((count - minCount) / range) * 20) // 12px ~ 32px
  }))
})

const danmakuMaxBin = computed(() => {
  if (!danmakuData.value?.density_bins?.length) return 1
  return Math.max(...danmakuData.value.density_bins.map((b) => b[2])) || 1
})
```

### Step 5: 在右侧面板 Tab 区域添加「弹幕洞察」按钮

找到现有的 Tab 按钮区域（搜索 `activeTab === 'timeline'` 的按钮），在「时间轴」和「AI对话」Tab 按钮之间插入：

```html
<!-- 弹幕洞察 Tab 按钮（仅在有弹幕数据时显示） -->
<button
  v-if="danmakuData"
  @click="activeTab = 'danmaku'"
  :class="[
    'px-3 py-1.5 text-sm font-medium rounded-md transition-colors',
    activeTab === 'danmaku'
      ? 'bg-white text-gray-900 shadow-sm'
      : 'text-gray-500 hover:text-gray-700'
  ]"
>
  弹幕洞察
  <span class="ml-1 text-xs text-gray-400">{{ danmakuData.total_count }}</span>
</button>
```

### Step 6: 新增「弹幕洞察」Tab 面板

在现有时间轴 Tab 面板（`v-if="activeTab === 'timeline'"` 的 div）之后，AI 对话面板之前，插入：

```html
<!-- 弹幕洞察 Tab -->
<div v-else-if="activeTab === 'danmaku'" class="flex-1 overflow-y-auto p-4 space-y-5">

  <!-- 弹幕密度热力图 -->
  <div v-if="danmakuData?.platform === 'bilibili' && danmakuData?.density_bins?.length">
    <div class="flex items-center justify-between mb-2">
      <span class="text-xs font-medium text-gray-600">弹幕密度</span>
      <span class="text-xs text-gray-400">共 {{ danmakuData.total_count }} 条</span>
    </div>
    <div class="flex items-end gap-px h-16 bg-gray-50 rounded-lg p-2 overflow-x-auto">
      <div
        v-for="(bin, i) in danmakuData.density_bins"
        :key="i"
        class="flex-shrink-0 w-1.5 rounded-sm transition-all cursor-pointer"
        :style="{
          height: `${Math.max(4, Math.round((bin[2] / danmakuMaxBin) * 48))}px`,
          backgroundColor: `hsl(${210 - Math.round((bin[2] / danmakuMaxBin) * 150)}, 80%, ${65 - Math.round((bin[2] / danmakuMaxBin) * 25)}%)`
        }"
        :title="`${Math.floor(bin[0] / 60)}:${String(Math.floor(bin[0] % 60)).padStart(2, '0')} — ${bin[2]} 条弹幕`"
      />
    </div>
    <div class="flex justify-between text-xs text-gray-400 mt-1 px-2">
      <span>0:00</span>
      <span v-if="danmakuData.density_bins.length > 4">
        {{ Math.floor(danmakuData.density_bins[Math.floor(danmakuData.density_bins.length / 2)][0] / 60) }}min
      </span>
      <span>
        {{ Math.floor(danmakuData.density_bins[danmakuData.density_bins.length - 1][1] / 60) }}min
      </span>
    </div>
  </div>

  <!-- YouTube 无时间轴提示 -->
  <div v-else-if="danmakuData?.platform === 'youtube'" class="text-xs text-gray-400 text-center py-2">
    YouTube 评论无时间轴信息，仅展示高频词
  </div>

  <!-- 高频词词云 -->
  <div v-if="danmakuWordCloudItems.length">
    <div class="text-xs font-medium text-gray-600 mb-2">高频词</div>
    <div class="flex flex-wrap gap-2 p-3 bg-gray-50 rounded-lg min-h-[80px]">
      <span
        v-for="item in danmakuWordCloudItems"
        :key="item.word"
        class="text-gray-700 cursor-default select-none transition-colors hover:text-blue-600"
        :style="{ fontSize: `${item.size}px`, lineHeight: '1.4' }"
        :title="`出现 ${item.count} 次`"
      >{{ item.word }}</span>
    </div>
  </div>

  <!-- 空状态 -->
  <div v-if="!danmakuWordCloudItems.length && !danmakuData?.density_bins?.length"
       class="text-center text-sm text-gray-400 py-8">
    暂无弹幕数据
  </div>
</div>
```

### Step 7: 在时间轴卡片中添加代表性弹幕区域

找到时间轴卡片中「**原文记录**」相关区域（搜索 `transcript` 或 `原文记录`），在其之前插入弹幕反应区：

```html
<!-- 弹幕反应（仅当有弹幕数据时显示） -->
<div
  v-if="danmakuData?.chunk_top?.[chunk.id]?.length"
  class="mt-3 pt-3 border-t border-gray-100"
>
  <div class="text-xs font-medium text-gray-400 mb-1.5">弹幕反应</div>
  <div class="space-y-1">
    <div
      v-for="(dm, i) in danmakuData.chunk_top[chunk.id]"
      :key="i"
      class="flex items-start gap-1.5 text-xs text-gray-500"
    >
      <span class="flex-shrink-0 mt-0.5">💬</span>
      <span>{{ dm }}</span>
    </div>
  </div>
</div>
```

> **注意**：`chunk.id` 在 App.vue 中格式为 `"MM:SS-MM:SS"`（`parseMarkdown` 生成），与 Python 侧的 `chunk.id_str` 格式一致。

### Step 8: TypeScript 检查

```bash
npm run typecheck
```
预期：无新增错误

### Step 9: 启动开发服务器目测 UI

```bash
npm run dev
```

检查：
- [ ] 解析 B 站视频后，「弹幕洞察」Tab 出现
- [ ] 热力图条带按密度高低呈现颜色梯度
- [ ] 词云字体大小随频次缩放
- [ ] 时间轴卡片展开后可看到弹幕反应区

### Step 10: 提交

```bash
git add src/renderer/src/App.vue
git commit -m "feat: 前端弹幕洞察 Tab + 时间轴卡片代表性弹幕"
```

---

## Task 7: 端到端整合验证与收尾

**Files:**
- Modify: `CLAUDE.md`（更新 IPC API 表格）

---

**Step 1: 运行完整 Python 测试套件**

```bash
cd vid-engine && python -m pytest tests/ -v
```
预期：全部 PASS

**Step 2: TypeScript 类型检查**

```bash
npm run typecheck && npm run lint
```
预期：无报错

**Step 3: 更新 CLAUDE.md 的 IPC API 表格**

在 `CLAUDE.md` 的 IPC API 表中，`parseVideo` 行的说明列更新为：

```
启动 Python 解析，结果含 `output`（Markdown）和 `danmaku`（弹幕 JSON，可选）
```

新增 `PipelineOptions` 说明：`skipDanmaku?: boolean` — 跳过弹幕获取（默认 false）

**Step 4: 最终提交**

```bash
git add CLAUDE.md
git commit -m "docs: 更新 CLAUDE.md，补充弹幕功能说明"
```

---

## 快速参考：关键文件路径

| 文件 | 变更类型 | 核心内容 |
|------|---------|---------|
| `vid-engine/src/danmaku.py` | **新建** | 弹幕获取、解析、统计全部逻辑 |
| `vid-engine/src/models.py` | 修改 | `TimelineChunk.id_str` property |
| `vid-engine/src/downloader.py` | 修改 | `get_video_meta_with_info()` |
| `vid-engine/src/pipeline.py` | 修改 | 并行获取弹幕，写出 JSON |
| `vid-engine/src/llm.py` | 修改 | `danmaku_contexts` 参数注入 |
| `vid-engine/tests/test_danmaku.py` | **新建** | 单元测试 |
| `src/main/index.ts` | 修改 | 读取 `.danmaku.json` |
| `src/preload/index.ts` | 修改 | 类型扩展 |
| `src/renderer/src/App.vue` | 修改 | 弹幕洞察 Tab + 卡片弹幕区 |

## 容错说明

- B 站 API 返回非 200 / JSON 解析失败 → `fetch_bilibili` 返回 `None`，pipeline 静默跳过
- 弹幕 XML 为空 / 网络超时 → 同上
- `.danmaku.json` 不存在 → Electron 主进程 try/catch 静默，`danmaku` 字段为 `null`
- 前端 `danmakuData` 为 `null` → Tab 按钮不显示，卡片弹幕区不渲染
