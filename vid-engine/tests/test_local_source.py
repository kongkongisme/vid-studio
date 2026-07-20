import subprocess
import sys

import pytest

import main
import src.pipeline as pipeline
from src.pipeline import _extract_local_audio, _fetch_local_meta


def test_fetch_local_meta_uses_file_name_duration_and_stable_id(tmp_path, monkeypatch):
    video = tmp_path / "课程片段.wmv"
    video.write_bytes(b"fake-video")

    def fake_run(cmd, capture_output, text):
        assert cmd[:3] == ["ffprobe", "-v", "error"]
        assert cmd[-1] == str(video)
        return subprocess.CompletedProcess(cmd, 0, stdout="125.4\n", stderr="")

    monkeypatch.setattr("src.pipeline.subprocess.run", fake_run)

    meta, raw_info = _fetch_local_meta(str(video))

    assert raw_info is None
    assert meta.id.startswith("local_")
    assert meta.title == "课程片段"
    assert meta.duration == 125
    assert meta.uploader == "本地文件"


def test_fetch_local_meta_rejects_missing_file(tmp_path):
    with pytest.raises(RuntimeError, match="本地视频文件不存在"):
        _fetch_local_meta(str(tmp_path / "missing.mp4"))


def test_extract_local_audio_streams_ffmpeg_progress(tmp_path, monkeypatch, capsys):
    video = tmp_path / "sample.mp4"
    video.write_bytes(b"fake-video")
    work_dir = tmp_path / "work"
    work_dir.mkdir()

    class FakeStdout:
        def __iter__(self):
            return iter([
                "out_time_ms=12000000\n",
                "progress=continue\n",
                "out_time_ms=120000000\n",
                "progress=end\n",
            ])

    class FakePopen:
        def __init__(self, cmd, stdout, stderr, text, bufsize):
            self.cmd = cmd
            self.stdout = FakeStdout()
            self.returncode = 0

            assert cmd[:3] == ["ffmpeg", "-y", "-hide_banner"]
            assert "-map" in cmd
            assert "0:a:0" in cmd
            assert "-vn" in cmd
            assert "-progress" in cmd
            assert "pipe:1" in cmd
            assert cmd[-1] == str(work_dir / "sample.mp3")

        def wait(self):
            (work_dir / "sample.mp3").write_bytes(b"fake-audio")
            return self.returncode

    def fail_run(*args, **kwargs):
        raise AssertionError("audio extraction should stream ffmpeg progress with Popen")

    monkeypatch.setattr(pipeline, "_probe_local_duration", lambda _: 120)
    monkeypatch.setattr("src.pipeline.subprocess.Popen", FakePopen)
    monkeypatch.setattr("src.pipeline.subprocess.run", fail_run)

    assert _extract_local_audio(str(video), str(work_dir)) == str(work_dir / "sample.mp3")

    captured = capsys.readouterr()
    assert "提取音频进度：10%" in captured.out
    assert "提取音频进度：100%" in captured.out


def test_extract_local_audio_reports_ffmpeg_failure(tmp_path, monkeypatch):
    video = tmp_path / "broken.wmv"
    video.write_bytes(b"fake-video")
    work_dir = tmp_path / "work"
    work_dir.mkdir()

    class FakeStdout:
        def __iter__(self):
            return iter(["codec failed\n"])

    class FakePopen:
        def __init__(self, cmd, stdout, stderr, text, bufsize):
            self.stdout = FakeStdout()
            self.returncode = 1

        def wait(self):
            return self.returncode

    monkeypatch.setattr(pipeline, "_probe_local_duration", lambda _: 120)
    monkeypatch.setattr("src.pipeline.subprocess.Popen", FakePopen)

    with pytest.raises(RuntimeError, match="ffmpeg 提取音频失败"):
        _extract_local_audio(str(video), str(work_dir))

def test_parse_args_accepts_local_file(monkeypatch):
    monkeypatch.setattr(
        sys,
        "argv",
        ["main.py", "/videos/local.mp4", "--local-file", "--skip-video", "-o", "out.txt"],
    )

    args = main.parse_args()

    assert args.url == "/videos/local.mp4"
    assert args.local_file is True
    assert args.skip_video is True
    assert args.output == "out.txt"
