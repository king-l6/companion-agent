#!/usr/bin/env python3
"""
本地音色服务：
1. 上传音频 / 视频 -> ffmpeg 抽音轨 -> sherpa-onnx 说话人分离
2. 每个说话人切一段干净的参考音频，SenseVoice 自动转写参考文本
3. 用 ZipVoice 做零样本音色克隆，返回 WAV

所有处理都在本机完成，音视频不出本机。
"""
import io
import json
import os
import re
import shutil
import subprocess
import threading
import uuid
from pathlib import Path

import numpy as np
import soundfile as sf
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from scipy.signal import resample_poly
from starlette.concurrency import run_in_threadpool

ROOT = Path(__file__).resolve().parent
MODELS = ROOT / "models"
DATA = ROOT / "data"
JOBS = DATA / "jobs"
CLIPS = DATA / "clips"
for folder in (JOBS, CLIPS):
    folder.mkdir(parents=True, exist_ok=True)

SEG_MODEL = MODELS / "sherpa-onnx-pyannote-segmentation-3-0" / "model.onnx"
EMB_MODEL = MODELS / "campplus.onnx"
ZIPVOICE_DIR = MODELS / "sherpa-onnx-zipvoice-distill-int8-zh-en-emilia"
ZIPVOICE_VOCODER = MODELS / "vocos_24khz.onnx"
ASR_DIR = MODELS / "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17"

MAX_ANALYZE_SECONDS = float(os.environ.get("MAX_ANALYZE_SECONDS", "300"))
MAX_UPLOAD_MB = int(os.environ.get("MAX_UPLOAD_MB", "300"))
MAX_TTS_CHARS = int(os.environ.get("MAX_TTS_CHARS", "1000"))
TTS_NUM_STEPS = int(os.environ.get("VOICE_NUM_STEPS", "4"))
TTS_THREADS = int(os.environ.get("VOICE_TTS_THREADS", "4"))
ASR_LANGUAGE = os.environ.get("VOICE_ASR_LANGUAGE", "zh")

ALLOWED_SUFFIXES = {
    ".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".webm",
    ".mp4", ".mov", ".mkv", ".avi", ".m4v",
}

app = FastAPI(title="companion-voice-service")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_diarizer = None
_diarizer_lock = threading.Lock()
_asr = None
_asr_lock = threading.Lock()
_tts = None
_tts_error = None
_tts_lock = threading.Lock()


def ffmpeg_bin() -> str:
    return os.environ.get("FFMPEG_BIN") or shutil.which("ffmpeg") or "ffmpeg"


def run_ffmpeg(args: list[str], timeout: int = 600) -> None:
    proc = subprocess.run(
        [ffmpeg_bin(), "-y", "-hide_banner", "-loglevel", "error", *args],
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip()[-800:] or "ffmpeg failed")


def require_files(*paths: Path) -> None:
    missing = [str(path) for path in paths if not path.exists()]
    if missing:
        raise RuntimeError(
            "缺少模型文件，请先运行 server/voice/scripts/download_models.sh：\n"
            + "\n".join(missing)
        )


# ---------------------------------------------------------------- diarization

def load_diarizer():
    import sherpa_onnx

    require_files(SEG_MODEL, EMB_MODEL)
    config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
        segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
            pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(
                model=str(SEG_MODEL)
            )
        ),
        embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(EMB_MODEL)),
        clustering=sherpa_onnx.FastClusteringConfig(num_clusters=-1, threshold=0.5),
        min_duration_on=0.3,
        min_duration_off=0.5,
    )
    return sherpa_onnx.OfflineSpeakerDiarization(config)


def get_diarizer():
    global _diarizer
    with _diarizer_lock:
        if _diarizer is None:
            _diarizer = load_diarizer()
        return _diarizer


def diarize(audio16: np.ndarray) -> list[dict]:
    result = get_diarizer().process(audio16).sort_by_start_time()
    return [
        {"start": float(seg.start), "end": float(seg.end), "speaker": int(seg.speaker)}
        for seg in result
    ]


# ------------------------------------------------------------------------ ASR

def load_asr():
    import sherpa_onnx

    require_files(ASR_DIR / "model.int8.onnx", ASR_DIR / "tokens.txt")
    return sherpa_onnx.OfflineRecognizer.from_sense_voice(
        model=str(ASR_DIR / "model.int8.onnx"),
        tokens=str(ASR_DIR / "tokens.txt"),
        use_itn=True,
        language=ASR_LANGUAGE,
        num_threads=2,
        debug=False,
    )


def get_asr():
    global _asr
    with _asr_lock:
        if _asr is None:
            _asr = load_asr()
        return _asr


def transcribe(samples: np.ndarray, sample_rate: int) -> str:
    if samples.ndim > 1:
        samples = samples[:, 0]
    recognizer = get_asr()
    stream = recognizer.create_stream()
    stream.accept_waveform(sample_rate, samples.astype(np.float32))
    recognizer.decode_stream(stream)
    return stream.result.text.strip()


# ------------------------------------------------------------------------ TTS

def load_tts():
    import sherpa_onnx

    require_files(
        ZIPVOICE_DIR / "tokens.txt",
        ZIPVOICE_DIR / "encoder.int8.onnx",
        ZIPVOICE_DIR / "decoder.int8.onnx",
        ZIPVOICE_DIR / "lexicon.txt",
        ZIPVOICE_VOCODER,
        ZIPVOICE_DIR / "espeak-ng-data",
    )
    config = sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(
            zipvoice=sherpa_onnx.OfflineTtsZipvoiceModelConfig(
                tokens=str(ZIPVOICE_DIR / "tokens.txt"),
                encoder=str(ZIPVOICE_DIR / "encoder.int8.onnx"),
                decoder=str(ZIPVOICE_DIR / "decoder.int8.onnx"),
                # 中文走 lexicon，英文由 espeak-ng（data_dir）自动处理
                lexicon=str(ZIPVOICE_DIR / "lexicon.txt"),
                vocoder=str(ZIPVOICE_VOCODER),
                data_dir=str(ZIPVOICE_DIR / "espeak-ng-data"),
            ),
            debug=False,
            num_threads=TTS_THREADS,
            provider="cpu",
        )
    )
    if not config.validate():
        raise RuntimeError("ZipVoice 配置校验失败，检查模型文件是否完整")
    return sherpa_onnx.OfflineTts(config)


def get_tts():
    global _tts, _tts_error
    if _tts is not None:
        return _tts
    with _tts_lock:
        if _tts is None:
            try:
                _tts = load_tts()
                _tts_error = None
            except Exception as exc:  # noqa: BLE001
                _tts_error = str(exc)
                raise HTTPException(503, f"TTS 模型加载失败：{exc}") from exc
    return _tts


def warm_models() -> None:
    global _tts_error
    for name, loader in (("asr", get_asr), ("tts", get_tts)):
        try:
            loader()
            print(json.dumps({"event": f"{name}_ready"}), flush=True)
        except Exception as exc:  # noqa: BLE001
            if name == "tts":
                _tts_error = str(exc)
            print(json.dumps({"event": f"{name}_error", "error": str(exc)[:500]}), flush=True)


@app.on_event("startup")
def on_startup() -> None:
    threading.Thread(target=warm_models, daemon=True).start()


@app.get("/health")
def health():
    return {
        "ok": True,
        "engine": "zipvoice",
        "ttsReady": _tts is not None,
        "ttsError": _tts_error,
        "asrReady": _asr is not None,
        "diarizationReady": _diarizer is not None,
        "maxAnalyzeSeconds": MAX_ANALYZE_SECONDS,
    }


# --------------------------------------------------------------------- utils

def merge_runs(segments: list[dict], gap: float = 0.45) -> list[tuple[float, float]]:
    runs: list[list[float]] = []
    for segment in sorted(segments, key=lambda item: item["start"]):
        if runs and segment["start"] - runs[-1][1] <= gap:
            runs[-1][1] = max(runs[-1][1], segment["end"])
        else:
            runs.append([segment["start"], segment["end"]])
    return [(start, end) for start, end in runs]


def trim_silence(audio: np.ndarray, sample_rate: int, threshold: float = 0.004) -> np.ndarray:
    frame = max(1, int(0.02 * sample_rate))
    frames = len(audio) // frame
    if frames == 0:
        return audio
    rms = np.sqrt(np.mean(audio[: frames * frame].reshape(frames, frame) ** 2, axis=1))
    voiced = np.where(rms > threshold)[0]
    if len(voiced) == 0:
        return audio
    start = max(0, voiced[0] * frame - int(0.08 * sample_rate))
    end = min(len(audio), (voiced[-1] + 1) * frame + int(0.08 * sample_rate))
    return audio[start:end]


def build_reference(
    audio16: np.ndarray,
    sample_rate: int,
    runs: list[tuple[float, float]],
    output: Path,
    target_seconds: float = 9.0,
    max_seconds: float = 15.0,
) -> float:
    """优先选最长的一段连续说话；不够长时按时间顺序拼接同一说话人的片段。"""
    if not runs:
        raise HTTPException(422, "没有检测到有效语音")

    longest = max(runs, key=lambda item: item[1] - item[0])
    chosen = [longest]
    total = longest[1] - longest[0]
    if total < target_seconds:
        for run in sorted(runs, key=lambda item: item[0]):
            if run == longest:
                continue
            chosen.append(run)
            total += run[1] - run[0]
            if total >= target_seconds:
                break

    pieces: list[np.ndarray] = []
    remaining = max_seconds
    for start, end in sorted(chosen, key=lambda item: item[0]):
        if remaining <= 0.3:
            break
        length = min(end - start, remaining)
        chunk = audio16[int(start * sample_rate) : int((start + length) * sample_rate)]
        chunk = trim_silence(chunk, sample_rate)
        if len(chunk) > sample_rate * 0.4:
            pieces.append(chunk)
            remaining -= len(chunk) / sample_rate

    if not pieces:
        raise HTTPException(422, "参考音频太短，至少需要 2 秒清晰说话")

    silence = np.zeros(int(0.12 * sample_rate), dtype=np.float32)
    merged = pieces[0]
    for piece in pieces[1:]:
        merged = np.concatenate([merged, silence, piece])

    # 16k -> 24k，ZipVoice 的 vocoder 是 24k
    if sample_rate == 16000:
        merged = resample_poly(merged, 3, 2).astype(np.float32)
        out_rate = 24000
    else:
        out_rate = sample_rate

    peak = float(np.max(np.abs(merged))) if len(merged) else 0.0
    if peak > 0:
        merged = (merged * (0.9 / peak)).astype(np.float32)

    sf.write(output, merged, out_rate, format="WAV", subtype="PCM_16")
    return len(merged) / out_rate


# ------------------------------------------------------------------- endpoints

@app.post("/extract")
async def extract(file: UploadFile = File(...)):
    job_id = uuid.uuid4().hex[:10]
    job_dir = JOBS / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in ALLOWED_SUFFIXES:
        suffix = ".bin"
    raw_path = job_dir / f"input{suffix}"

    size = 0
    limit = MAX_UPLOAD_MB * 1024 * 1024
    with raw_path.open("wb") as output:
        while chunk := await file.read(1024 * 1024):
            size += len(chunk)
            if size > limit:
                shutil.rmtree(job_dir, ignore_errors=True)
                raise HTTPException(413, f"文件超过 {MAX_UPLOAD_MB}MB，请先裁剪")
            output.write(chunk)

    if size == 0:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(400, "空文件")

    wav16_path = job_dir / "audio16.wav"
    try:
        await run_in_threadpool(
            run_ffmpeg,
            ["-i", str(raw_path), "-vn", "-ac", "1", "-ar", "16000",
             "-t", str(MAX_ANALYZE_SECONDS), str(wav16_path)],
        )
    except Exception as exc:  # noqa: BLE001
        shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(422, f"音轨解析失败：{exc}") from exc

    # 原视频/音频可能很大，抽完音轨就不必留着
    raw_path.unlink(missing_ok=True)

    audio16, sample_rate = sf.read(wav16_path, dtype="float32")
    if sample_rate != 16000:
        raise HTTPException(500, f"采样率异常：{sample_rate}")
    if len(audio16) < 16000:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(422, "音频太短，至少需要 1 秒")

    segments = await run_in_threadpool(diarize, audio16)
    if not segments:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(422, "没有分离出说话人，换一段更清晰、更长的录音再试")

    grouped: dict[int, list[dict]] = {}
    for segment in segments:
        if segment["end"] - segment["start"] < 0.25:
            continue
        grouped.setdefault(segment["speaker"], []).append(segment)

    if not grouped:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(422, "没有检测到有效语音")

    clip_dir = CLIPS / job_id
    clip_dir.mkdir(parents=True, exist_ok=True)

    speakers = []
    for speaker_id, speaker_segments in grouped.items():
        runs = merge_runs(speaker_segments)
        clip_path = clip_dir / f"{speaker_id}.wav"
        try:
            clip_seconds = build_reference(audio16, sample_rate, runs, clip_path)
        except HTTPException:
            continue

        clip_audio, clip_rate = sf.read(clip_path, dtype="float32")
        reference_text = await run_in_threadpool(transcribe, clip_audio, clip_rate)

        speakers.append(
            {
                "speaker": speaker_id,
                "seconds": round(sum(s["end"] - s["start"] for s in speaker_segments), 2),
                "segments": len(speaker_segments),
                "clipSeconds": round(clip_seconds, 2),
                "clipPath": f"/clips/{job_id}/{speaker_id}.wav",
                "referenceText": reference_text,
            }
        )

    if not speakers:
        shutil.rmtree(job_dir, ignore_errors=True)
        shutil.rmtree(clip_dir, ignore_errors=True)
        raise HTTPException(422, "每个说话人的有效语音都太短")

    speakers.sort(key=lambda item: item["seconds"], reverse=True)
    for index, speaker in enumerate(speakers, start=1):
        speaker["id"] = f"{job_id}:{speaker['speaker']}"
        speaker["label"] = f"角色 {index}"

    meta = {
        "jobId": job_id,
        "duration": round(len(audio16) / sample_rate, 2),
        "speakers": {str(item["speaker"]): item for item in speakers},
    }
    (job_dir / "meta.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    (job_dir / "segments.json").write_text(
        json.dumps(segments, ensure_ascii=False), encoding="utf-8"
    )

    return {
        "jobId": job_id,
        "duration": meta["duration"],
        "speakers": [
            {
                key: item[key]
                for key in (
                    "id", "label", "seconds", "clipSeconds", "segments",
                    "clipPath", "referenceText",
                )
            }
            for item in speakers
        ],
    }


@app.get("/clips/{job_id}/{name}")
def get_clip(job_id: str, name: str):
    if not re.fullmatch(r"[a-f0-9]{10}", job_id) or not re.fullmatch(r"\d+\.wav", name):
        raise HTTPException(404, "not_found")
    path = CLIPS / job_id / name
    if not path.exists():
        raise HTTPException(404, "not_found")
    return FileResponse(path, media_type="audio/wav")


@app.get("/tts")
def tts(text: str, speaker: str, num_steps: int = TTS_NUM_STEPS):
    text = text.strip()
    if not text:
        raise HTTPException(400, "text 为空")
    if len(text) > MAX_TTS_CHARS:
        raise HTTPException(413, f"text 超过 {MAX_TTS_CHARS} 字")

    job_id, _, speaker_id = speaker.partition(":")
    if not re.fullmatch(r"[a-f0-9]{10}", job_id) or not speaker_id.isdigit():
        raise HTTPException(400, "speaker 格式应为 job:speaker")

    meta_path = JOBS / job_id / "meta.json"
    if not meta_path.exists():
        raise HTTPException(404, "找不到这个音色，请重新上传")
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    speaker_meta = meta.get("speakers", {}).get(speaker_id)
    if not speaker_meta:
        raise HTTPException(404, "找不到这个角色")

    clip_path = CLIPS / job_id / f"{speaker_id}.wav"
    if not clip_path.exists():
        raise HTTPException(404, "参考音频不存在，请重新上传")

    reference_audio, reference_rate = sf.read(clip_path, dtype="float32")
    if reference_audio.ndim > 1:
        reference_audio = reference_audio[:, 0]

    import sherpa_onnx

    gen_config = sherpa_onnx.GenerationConfig()
    gen_config.reference_audio = reference_audio.astype(np.float32)
    gen_config.reference_sample_rate = reference_rate
    gen_config.reference_text = speaker_meta.get("referenceText", "")
    gen_config.num_steps = min(16, max(1, num_steps))
    gen_config.extra["min_char_in_sentence"] = "30"

    model = get_tts()
    with _tts_lock:
        audio = model.generate(text, gen_config)

    samples = np.asarray(audio.samples, dtype=np.float32).reshape(-1)
    if samples.size == 0:
        raise HTTPException(500, "合成结果为空")

    buffer = io.BytesIO()
    sf.write(buffer, samples, audio.sample_rate, format="WAV", subtype="PCM_16")
    return Response(
        content=buffer.getvalue(),
        media_type="audio/wav",
        headers={
            "cache-control": "no-store",
            "x-audio-seconds": f"{len(samples) / audio.sample_rate:.2f}",
            "x-tts-engine": "zipvoice",
        },
    )
