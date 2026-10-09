import argparse
import csv
import json
import os
import re
import subprocess
import time
from pathlib import Path

from faster_whisper import WhisperModel


PROJECT_DIR = Path(os.environ.get("QQBOT_ROOT", Path(__file__).resolve().parent.parent))
DATA_DIR = Path(os.environ.get("VOICE_DATA_DIR", Path(os.environ.get("QQBOT_DATA_DIR", PROJECT_DIR)) / "shared" / "voice-data"))
GSV_DIR = Path(os.environ.get("GPT_SOVITS_DIR", PROJECT_DIR / "runtimes" / "GPT-SoVITS-v3lora-20250228"))
FFMPEG = os.environ.get("VOICE_FFMPEG", str(GSV_DIR / "ffmpeg.exe") if os.name == "nt" else "ffmpeg")
ASR_MODEL = GSV_DIR / "tools" / "asr" / "modelscope_cache_turbo" / "pengzhendong" / "faster-whisper-large-v3-turbo"
TIME_RE = re.compile(
    r"(?P<start>\d{2}:\d{2}:\d{2}[.,]\d{3})\s+-->\s+(?P<end>\d{2}:\d{2}:\d{2}[.,]\d{3})"
)


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp.replace(path)


def stamp(value):
    hour, minute, rest = value.replace(",", ".").split(":")
    return int(hour) * 3600 + int(minute) * 60 + float(rest)


def clean_text(value):
    return re.sub(r"\s+", " ", str(value or "")).strip().replace("|", "，")


def parse_vtt(path):
    lines = path.read_text(encoding="utf-8-sig", errors="replace").splitlines()
    cues = []
    index = 0
    while index < len(lines):
        match = TIME_RE.search(lines[index])
        if not match:
            index += 1
            continue
        start = stamp(match.group("start"))
        end = stamp(match.group("end"))
        index += 1
        text = []
        while index < len(lines) and lines[index].strip():
            if not lines[index].strip().isdigit():
                text.append(lines[index].strip())
            index += 1
        cues.append((start, end, clean_text(" ".join(text))))
    return cues


def jp_ratio(text):
    meaningful = re.findall(r"[^\s、。！？!?…・,.]", text)
    if not meaningful:
        return 0.0
    japanese = re.findall(r"[ぁ-んァ-ヶ一-龯々ー]", text)
    return len(japanese) / len(meaningful)


def speech_like(text):
    compact = re.sub(r"[^ぁ-んァ-ヶ一-龯々ー]", "", text)
    if len(compact) < 6 or len(set(compact)) < 5:
        return False
    blocked = ("ご視聴", "字幕", "チャンネル登録", "ありがとうございました")
    return not any(item in text for item in blocked)


def run_ffmpeg(source, target, start, end):
    command = [
        str(FFMPEG), "-y", "-v", "error", "-ss", f"{start:.3f}", "-to", f"{end:.3f}",
        "-i", str(source), "-ac", "1", "-ar", "32000", "-c:a", "pcm_s16le", str(target),
    ]
    result = subprocess.run(command, cwd=str(GSV_DIR))
    if result.returncode:
        raise RuntimeError(f"ffmpeg failed for {source.name} at {start:.3f}-{end:.3f}")


def update_status(project_dir, stage, message, progress, **extra):
    atomic_json(project_dir / "status.json", {
        "stage": stage,
        "message": message,
        "progress": progress,
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        **extra,
    })
    print(f"[voice-vtt] {progress}% {message}", flush=True)


def prepare(args):
    source_dir = Path(args.source_dir)
    project_dir = DATA_DIR / "projects" / args.project_id
    clips_dir = project_dir / "clips"
    clips_dir.mkdir(parents=True, exist_ok=True)
    wavs = sorted(source_dir.glob("*.wav"))
    pairs = [(wav, Path(str(wav) + ".vtt")) for wav in wavs]
    pairs = [(wav, vtt) for wav, vtt in pairs if vtt.exists()]
    if not pairs:
        raise RuntimeError("没有找到 WAV 与同名 .wav.vtt 文件")

    candidates = []
    for wav, vtt in pairs:
        is_adult_track = re.match(r"^\d+H_", wav.name) is not None
        per_track = args.candidates_per_adult_track if is_adult_track else args.candidates_per_track
        cues = []
        for cue_index, (start, end, translation) in enumerate(parse_vtt(vtt), 1):
            duration = end - start
            if 3.0 <= duration <= 8.0 and 4 <= len(translation) <= 45:
                score = abs(duration - 4.5) + abs(len(translation) / duration - 3.0) * 0.08
                cues.append((score, cue_index, start, end, translation))
        # Spread candidates across the track before taking the best duration matches.
        cues.sort(key=lambda item: item[1])
        if len(cues) > per_track:
            bucket = len(cues) / per_track
            spread = []
            for slot in range(per_track):
                lo = int(slot * bucket)
                hi = max(lo + 1, int((slot + 1) * bucket))
                spread.append(min(cues[lo:hi], key=lambda item: item[0]))
            cues = spread
        for item in cues:
            candidates.append((wav, *item[1:]))

    update_status(project_dir, "vtt_extract", f"按中文字幕时间轴切分 {len(candidates)} 个候选句", 5)
    model = WhisperModel(str(ASR_MODEL), device="cuda", compute_type="float16")
    rows = []
    for offset, (wav, cue_index, start, end, translation) in enumerate(candidates, 1):
        clip_name = f"{wav.stem}_{cue_index:04d}.wav"
        clip_path = clips_dir / clip_name
        run_ffmpeg(wav, clip_path, start, end)
        segments, info = model.transcribe(
            str(clip_path), language="ja", beam_size=5, vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500}, word_timestamps=False,
        )
        segments = list(segments)
        text = clean_text("".join(segment.text for segment in segments))
        weights = [max(0.01, float(segment.end - segment.start)) for segment in segments]
        total_weight = sum(weights) or 1.0
        avg_logprob = sum(float(segment.avg_logprob) * weight for segment, weight in zip(segments, weights)) / total_weight if segments else -9.0
        no_speech = max((float(segment.no_speech_prob) for segment in segments), default=1.0)
        compression = max((float(segment.compression_ratio) for segment in segments), default=99.0)
        duration = end - start
        ratio = jp_ratio(text)
        translation_ratio = len(text) / max(1, len(translation))
        reasons = []
        if avg_logprob < -0.48:
            reasons.append("识别置信度低")
        if no_speech > 0.18:
            reasons.append("疑似静音")
        if compression > 2.2:
            reasons.append("疑似重复")
        if not 0.45 <= translation_ratio <= 2.4:
            reasons.append("与中文字幕长度差异大")
        if ratio < 0.85 or not speech_like(text):
            reasons.append("日语文本质量不足")
        rows.append({
            "included": "1" if not reasons else "0",
            "audio_path": str(clip_path),
            "source_file": str(wav),
            "start": f"{start:.3f}",
            "end": f"{end:.3f}",
            "duration": f"{duration:.3f}",
            "language": "ja",
            "text": text,
            "translation_zh": translation,
            "avg_logprob": f"{avg_logprob:.4f}",
            "no_speech_prob": f"{no_speech:.4f}",
            "compression_ratio": f"{compression:.4f}",
            "reason": "；".join(reasons),
        })
        if offset % 10 == 0 or offset == len(candidates):
            progress = 8 + int(offset / len(candidates) * 82)
            update_status(project_dir, "vtt_asr", f"正在识别并审核 {offset}/{len(candidates)}", progress)

    accepted = [row for row in rows if row["included"] == "1"]
    accepted.sort(key=lambda row: float(row["avg_logprob"]), reverse=True)
    accepted_paths = {row["audio_path"] for row in accepted[:args.max_new_clips]}
    for row in rows:
        if row["included"] == "1" and row["audio_path"] not in accepted_paths:
            row["included"] = "0"
            row["reason"] = "超过质量优先数量上限"

    review_path = project_dir / "review.csv"
    with review_path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)

    included_count = sum(row["included"] == "1" for row in rows)
    project = {
        "id": args.project_id,
        "name": args.name,
        "speaker": args.speaker,
        "sourceLanguage": "ja",
        "audioPaths": [str(wav) for wav, _ in pairs],
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "reviewPath": str(review_path),
        "clipCount": len(rows),
        "includedCount": included_count,
    }
    atomic_json(project_dir / "project.json", project)
    update_status(
        project_dir, "review_ready",
        f"中文字幕时间轴预处理完成：{len(rows)} 段，质量筛选保留 {included_count} 段",
        100, reviewPath=str(review_path), clipCount=len(rows), includedCount=included_count,
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source_dir")
    parser.add_argument("project_id")
    parser.add_argument("--name", default="我的音色")
    parser.add_argument("--speaker", default="speaker")
    parser.add_argument("--candidates-per-track", type=int, default=22)
    parser.add_argument("--candidates-per-adult-track", type=int, default=8)
    parser.add_argument("--max-new-clips", type=int, default=100)
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", args.project_id):
        raise ValueError("项目 ID 格式无效")
    prepare(args)


if __name__ == "__main__":
    main()
