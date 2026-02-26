"""全局配置管理：集中管理所有常量，支持通过环境变量覆盖"""
import os
from dataclasses import dataclass
from typing import Optional


@dataclass
class Config:
    # API Keys
    siliconflow_api_key: str = ""
    deepseek_api_key: str = ""
    zhipuai_api_key: str = ""

    # ASR
    asr_max_file_size_mb: int = 20        # 超过此大小触发分片
    asr_chunk_duration_min: int = 20      # 每片时长（分钟）
    asr_model: str = "FunAudioLLM/SenseVoiceSmall"

    # Embedding
    embed_model: str = "BAAI/bge-m3"
    embed_batch_size: int = 32            # SiliconFlow 单次最多 32 条
    embed_cache_enabled: bool = True      # 是否启用磁盘缓存

    # LLM
    llm_model: str = "deepseek-chat"
    llm_base_url: str = "https://api.deepseek.com"
    llm_max_tokens: int = 800
    llm_temperature: float = 0.3
    llm_max_workers: int = 4             # 并行调用线程数

    # Video Understanding
    vu_model: str = "glm-4v-flash"
    vu_frames_per_minute: int = 2         # 全局分析：每分钟抽取帧数
    vu_min_frames: int = 4
    vu_max_frames: int = 36              # 最多帧数（6×6 网格）
    vu_max_grid_width: int = 1280

    # Cache
    cache_dir: str = ".cache"


def load_config() -> "Config":
    """从环境变量加载配置（优先级：env > 默认值）"""
    c = Config()
    c.siliconflow_api_key = os.environ.get("SILICONFLOW_API_KEY", "")
    c.deepseek_api_key = os.environ.get("DEEPSEEK_API_KEY", "")
    c.zhipuai_api_key = os.environ.get("ZHIPUAI_API_KEY", "")

    if v := os.environ.get("LLM_MAX_WORKERS"):
        c.llm_max_workers = int(v)
    if v := os.environ.get("EMBED_CACHE_ENABLED"):
        c.embed_cache_enabled = v.lower() not in ("0", "false", "no")
    if v := os.environ.get("VID_CACHE_DIR"):
        c.cache_dir = v

    return c


_config: Optional[Config] = None


def get_config() -> Config:
    global _config
    if _config is None:
        _config = load_config()
    return _config


def reset_config(cfg: Optional[Config] = None) -> None:
    """用于测试或在 load_dotenv() 之后重新加载"""
    global _config
    _config = cfg
