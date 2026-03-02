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
        """返回弹幕总数"""
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
        """通过 bvid 获取视频 cid（弹幕 XML 依赖此参数）"""
        url = f"https://api.bilibili.com/x/web-interface/view?bvid={bvid}"
        resp = requests.get(url, headers=self._HEADERS, timeout=10)
        resp.raise_for_status()
        data = resp.json()
        return (data.get("data") or {}).get("cid")

    def _fetch_xml(self, cid: int) -> List[DanmakuItem]:
        """下载并解析 B 站弹幕 XML，返回 DanmakuItem 列表"""
        url = f"https://comment.bilibili.com/{cid}.xml"
        resp = requests.get(url, headers=self._HEADERS, timeout=15)
        resp.raise_for_status()
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
        """从 yt-dlp comments 列表构建弹幕数据（无时间戳，start 统一为 -1）"""
        if not comments:
            return None
        # 上游 downloader.py 已通过 max_comments=100 限制数量，此处无需再切片
        items = [
            DanmakuItem(start=-1, text=c.get("text", "").strip(), likes=c.get("like_count", 0))
            for c in comments
            if c.get("text", "").strip()
        ]
        if not items:
            return None
        return self._build_data("youtube", items)

    # ── 统计处理 ──────────────────────────────────────────

    def _build_data(self, platform: str, items: List[DanmakuItem]) -> DanmakuData:
        """构建 DanmakuData，计算词频和密度分布"""
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
        """统计弹幕词频，过滤停用词，返回 Top N"""
        counter: Counter = Counter()
        stopwords = {"的", "了", "吗", "呢", "啊", "哦", "嗯", "哈", "呀", "就", "都", "也", "不", "是"}
        for item in items:
            for word in self._extract_words(item.text):
                if word not in stopwords and len(word) >= 2:
                    counter[word] += 1
        return counter.most_common(top_n)

    @staticmethod
    def _calc_density(items: List[DanmakuItem], bin_seconds: int = 30) -> List[Tuple[float, float, int]]:
        """按时间窗口统计弹幕密度，返回 (start, end, count) 列表"""
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
            # 筛选落在当前 chunk 时间范围内的弹幕
            bucket = [
                i for i in timed_items
                if chunk.start <= i.start < chunk.end
            ]
            if not bucket:
                continue
            # Top 5：按重复次数降序（B 站弹幕 XML 不含点赞数，YouTube 评论已按 like_count 排序传入）
            text_counts: Counter = Counter(i.text for i in bucket)
            top_texts = [t for t, _ in text_counts.most_common(5)]
            data.chunk_top[chunk.id_str] = top_texts[:3]

            # 供 LLM 的一行汇总
            contexts[idx] = "  /  ".join(top_texts[:5])

        return contexts
