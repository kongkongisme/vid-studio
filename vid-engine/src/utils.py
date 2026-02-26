"""共享工具函数"""


def seconds_to_hms(seconds: float) -> str:
    """将秒数转为 HH:MM:SS 或 MM:SS 格式"""
    total = int(seconds)
    h = total // 3600
    m = (total % 3600) // 60
    s = total % 60
    if h > 0:
        return f"{h:02d}:{m:02d}:{s:02d}"
    return f"{m:02d}:{s:02d}"


def format_duration(seconds: int) -> str:
    """将秒数格式化为人类可读时长（如"12分30秒"）"""
    h = seconds // 3600
    m = (seconds % 3600) // 60
    s = seconds % 60
    if h > 0:
        return f"{h}小时{m}分钟"
    elif m > 0:
        return f"{m}分{s}秒"
    return f"{s}秒"
