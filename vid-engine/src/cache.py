"""磁盘缓存：Embedding 向量缓存 + LLM 结构化断点续跑"""
import hashlib
import json
from pathlib import Path
from typing import Dict, List, Optional

from src.config import get_config


def _text_hash(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()[:16]


class EmbeddingCache:
    """本地 JSON 文件缓存 embedding 向量，避免对相同文本重复调用 API"""

    def __init__(self, cache_dir: Optional[str] = None):
        base = Path(cache_dir or get_config().cache_dir)
        self.path = base / "embeddings.json"
        self._data: Dict[str, List[float]] = self._load()

    def _load(self) -> Dict[str, List[float]]:
        if self.path.exists():
            try:
                return json.loads(self.path.read_text(encoding="utf-8"))
            except Exception:
                return {}
        return {}

    def get(self, text: str) -> Optional[List[float]]:
        return self._data.get(_text_hash(text))

    def set(self, text: str, embedding: List[float]) -> None:
        self._data[_text_hash(text)] = embedding

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(
            json.dumps(self._data, ensure_ascii=False), encoding="utf-8"
        )

    def size(self) -> int:
        return len(self._data)


class ChunkCheckpoint:
    """按视频 ID 保存/读取已完成块的 LLM 结构化结果，实现断点续跑"""

    def __init__(self, video_id: str, cache_dir: Optional[str] = None):
        base = Path(cache_dir or get_config().cache_dir)
        self.path = base / "checkpoints" / f"{video_id}.json"
        self._data: Dict[str, str] = self._load()

    def _load(self) -> Dict[str, str]:
        if self.path.exists():
            try:
                return json.loads(self.path.read_text(encoding="utf-8"))
            except Exception:
                return {}
        return {}

    def get(self, chunk_idx: int) -> Optional[str]:
        return self._data.get(str(chunk_idx))

    def save(self, chunk_idx: int, result: str) -> None:
        """保存单个块的结果（原子写入，每块完成立即持久化）"""
        self._data[str(chunk_idx)] = result
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(
            json.dumps(self._data, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    def clear(self) -> None:
        """清除全部断点数据（用于 --fresh 模式）"""
        self._data = {}
        if self.path.exists():
            self.path.unlink()

    def count(self) -> int:
        return len(self._data)
