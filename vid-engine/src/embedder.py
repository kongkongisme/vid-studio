"""SiliconFlow BAAI/bge-m3 Embedding 调用，支持磁盘缓存避免重复请求"""
import time
from typing import List, Optional

import requests

from src.config import get_config

_API_URL = "https://api.siliconflow.cn/v1/embeddings"


def get_embeddings(texts: List[str]) -> List[List[float]]:
    """
    批量获取文本 embedding

    若缓存已启用，命中的文本直接返回缓存值，仅对未命中文本调用 API
    """
    cfg = get_config()
    if not cfg.siliconflow_api_key:
        raise ValueError("环境变量 SILICONFLOW_API_KEY 未设置")

    results: List[Optional[List[float]]] = [None] * len(texts)
    miss_indices: List[int] = []
    cache = None

    if cfg.embed_cache_enabled:
        from src.cache import EmbeddingCache
        cache = EmbeddingCache()
        for i, text in enumerate(texts):
            hit = cache.get(text)
            if hit is not None:
                results[i] = hit
            else:
                miss_indices.append(i)
    else:
        miss_indices = list(range(len(texts)))

    if miss_indices:
        n_hit = len(texts) - len(miss_indices)
        if n_hit > 0:
            print(f"  缓存命中 {n_hit}/{len(texts)}，调用 API 获取剩余 {len(miss_indices)} 条...")
        miss_texts = [texts[i] for i in miss_indices]
        fetched = _fetch_embeddings(miss_texts, cfg)

        for local_idx, global_idx in enumerate(miss_indices):
            results[global_idx] = fetched[local_idx]
            if cache:
                cache.set(texts[global_idx], fetched[local_idx])

        if cache:
            cache.save()

    return results


def _fetch_embeddings(texts: List[str], cfg) -> List[List[float]]:
    """实际调用 API，自动分批处理"""
    headers = {
        "Authorization": f"Bearer {cfg.siliconflow_api_key}",
        "Content-Type": "application/json",
    }
    all_embeddings: List[List[float]] = []

    for batch_start in range(0, len(texts), cfg.embed_batch_size):
        batch = texts[batch_start : batch_start + cfg.embed_batch_size]

        for attempt in range(3):
            try:
                response = requests.post(
                    _API_URL,
                    headers=headers,
                    json={
                        "model": cfg.embed_model,
                        "input": batch,
                        "encoding_format": "float",
                    },
                    timeout=30,
                )

                if response.status_code == 200:
                    data = response.json()
                    items = sorted(data["data"], key=lambda x: x["index"])
                    all_embeddings.extend(item["embedding"] for item in items)
                    break

                if response.status_code == 429:
                    time.sleep(2 ** attempt)
                    continue

                raise RuntimeError(
                    f"Embedding API 错误 {response.status_code}：{response.text[:200]}"
                )

            except requests.RequestException as e:
                if attempt < 2:
                    time.sleep(2)
                else:
                    raise RuntimeError(f"Embedding 网络请求失败：{e}") from e
        else:
            raise RuntimeError("Embedding 获取失败，已达最大重试次数")

    return all_embeddings
