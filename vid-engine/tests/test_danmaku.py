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


def test_build_chunk_contexts():
    from src.danmaku import DanmakuProcessor, DanmakuItem, DanmakuData

    class FakeChunk:
        def __init__(self, start, end, id_str):
            self.start = start
            self.end = end
            self.id_str = id_str

    proc = DanmakuProcessor()
    items = [
        DanmakuItem(start=10, text="牛逼"),
        DanmakuItem(start=20, text="牛逼"),
        DanmakuItem(start=70, text="不懂"),
    ]
    data = DanmakuData(platform="bilibili", items=items)
    chunks = [FakeChunk(0, 60, "00:00-01:00"), FakeChunk(60, 120, "01:00-02:00")]
    contexts = proc.build_chunk_contexts(data, chunks)

    assert 0 in contexts
    assert "牛逼" in contexts[0]
    assert data.chunk_top["00:00-01:00"] == ["牛逼"]
    assert data.chunk_top["01:00-02:00"] == ["不懂"]
