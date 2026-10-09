import argparse
import csv
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

import yaml


ROOT_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("VOICE_DATA_DIR", str(ROOT_DIR / "shared" / "voice-data")))
GSV_DIR = Path(os.environ.get("GPT_SOVITS_DIR", str(ROOT_DIR / "runtimes" / "GPT-SoVITS-v3lora-20250228")))
PROJECTS_DIR = DATA_DIR / "projects"
PROFILES_DIR = DATA_DIR / "profiles"
PYTHON = Path(os.environ.get("VOICE_PYTHON", str(GSV_DIR / "runtime" / "python.exe") if os.name == 'nt' else sys.executable))
FFMPEG = Path(os.environ.get("VOICE_FFMPEG", str(GSV_DIR / "ffmpeg.exe") if os.name == 'nt' else 'ffmpeg'))
ASR_MODEL = GSV_DIR / "tools" / "asr" / "modelscope_cache_turbo" / "pengzhendong" / "faster-whisper-large-v3-turbo"


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp.replace(path)


def load_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def update_status(project_dir, stage, message, progress=None, **extra):
    status_path = project_dir / "status.json"
    current = {}
    if status_path.exists():
        try:
            current = load_json(status_path)
        except Exception:
            current = {}
    current.update({
        "stage": stage,
        "message": message,
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        **extra,
    })
    if stage != "failed":
        current.pop("error", None)
    if progress is not None:
        current["progress"] = progress
    atomic_json(status_path, current)
    print(f"[voice-training] {stage}: {message}", flush=True)


def safe_id(value):
    value = re.sub(r"[^a-zA-Z0-9_-]+", "_", str(value).strip()).strip("_")
    if not value:
        raise ValueError("项目 ID 不能为空")
    return value[:64]


def clean_text(value):
    return re.sub(r"\s+", " ", str(value or "")).strip().replace("|", "，")


def run(command, cwd=None, env=None):
    print("[voice-training] RUN", " ".join(map(str, command)), flush=True)
    merged = os.environ.copy()
    if env:
        merged.update({str(k): str(v) for k, v in env.items()})
    for key in ["ALL_PROXY", "HTTP_PROXY", "HTTPS_PROXY"]:
        merged.pop(key, None)
    result = subprocess.run(command, cwd=str(cwd or GSV_DIR), env=merged)
    if result.returncode != 0:
        raise RuntimeError(f"命令失败（退出码 {result.returncode}）：{command[1] if len(command) > 1 else command[0]}")


def prepare(project_id):
    project_id = safe_id(project_id)
    project_dir = PROJECTS_DIR / project_id
    project = load_json(project_dir / "project.json")
    sources_dir = project_dir / "sources"
    clips_dir = project_dir / "clips"
    sources_dir.mkdir(parents=True, exist_ok=True)
    clips_dir.mkdir(parents=True, exist_ok=True)
    language = str(project.get("sourceLanguage", "ja")).lower()
    if language not in {"ja", "zh"}:
        raise ValueError("当前自动训练只支持 ja 或 zh")
    audio_paths = [Path(item) for item in project.get("audioPaths", [])]
    if not audio_paths:
        raise ValueError("没有导入音频")
    update_status(project_dir, "copying", f"正在复制 {len(audio_paths)} 个源文件", 2)
    copied = []
    for index, source in enumerate(audio_paths, 1):
        if not source.exists() or source.suffix.lower() not in {".wav", ".mp3", ".flac", ".m4a", ".aac", ".ogg"}:
            raise ValueError(f"不支持或不存在的音频：{source}")
        target = sources_dir / f"{index:03d}_{safe_id(source.stem)}{source.suffix.lower()}"
        if not target.exists() or target.stat().st_size != source.stat().st_size:
            shutil.copy2(source, target)
        copied.append(target)
        for suffix in [".txt", ".vtt", ".srt"]:
            sidecar = source.with_suffix(source.suffix + suffix)
            if not sidecar.exists():
                sidecar = source.with_suffix(suffix)
            if sidecar.exists():
                shutil.copy2(sidecar, sources_dir / f"{target.name}{suffix}")

    update_status(project_dir, "asr", "正在加载 Faster-Whisper 并识别音频", 8)
    from faster_whisper import WhisperModel
    model = WhisperModel(str(ASR_MODEL), device="cuda", compute_type="float16")
    rows = []
    clip_index = 0
    for source_index, source in enumerate(copied, 1):
        update_status(project_dir, "asr", f"正在识别 {source.name}（{source_index}/{len(copied)}）", 8 + int(source_index / len(copied) * 55))
        segments, info = model.transcribe(
            str(source), language=language, beam_size=5, vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500}, word_timestamps=False,
        )
        for segment in segments:
            text = clean_text(segment.text)
            duration = float(segment.end - segment.start)
            logprob = float(getattr(segment, "avg_logprob", -9.0))
            no_speech = float(getattr(segment, "no_speech_prob", 1.0))
            compression = float(getattr(segment, "compression_ratio", 99.0))
            reasons = []
            if duration < 2.5:
                reasons.append("过短")
            if duration > 10.0:
                reasons.append("过长")
            if not text:
                reasons.append("无文本")
            if logprob < -0.8:
                reasons.append("识别置信度低")
            if no_speech > 0.25:
                reasons.append("疑似静音")
            if compression > 2.4:
                reasons.append("疑似重复文本")
            if language == "ja" and not re.search(r"[\u3040-\u30ff\u4e00-\u9fff]", text):
                reasons.append("不像日语")
            included = len(reasons) == 0
            clip_index += 1
            clip_name = f"{clip_index:04d}.wav"
            clip_path = clips_dir / clip_name
            run([
                str(FFMPEG), "-y", "-v", "error", "-ss", f"{segment.start:.3f}",
                "-to", f"{segment.end:.3f}", "-i", str(source), "-ac", "1", "-ar", "32000",
                "-c:a", "pcm_s16le", str(clip_path),
            ], cwd=GSV_DIR)
            rows.append({
                "included": "1" if included else "0",
                "audio_path": str(clip_path),
                "source_file": str(source),
                "start": f"{segment.start:.3f}",
                "end": f"{segment.end:.3f}",
                "duration": f"{duration:.3f}",
                "language": language,
                "text": text,
                "avg_logprob": f"{logprob:.4f}",
                "no_speech_prob": f"{no_speech:.4f}",
                "compression_ratio": f"{compression:.4f}",
                "reason": "；".join(reasons),
            })
    if not rows:
        raise RuntimeError("没有识别到可用语音片段")
    review_path = project_dir / "review.csv"
    with review_path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)
    included_count = sum(row["included"] == "1" for row in rows)
    project["copiedAudioPaths"] = [str(item) for item in copied]
    project["reviewPath"] = str(review_path)
    project["clipCount"] = len(rows)
    project["includedCount"] = included_count
    atomic_json(project_dir / "project.json", project)
    update_status(project_dir, "review_ready", f"预处理完成：{len(rows)} 段，其中保守纳入 {included_count} 段", 100, reviewPath=str(review_path), clipCount=len(rows), includedCount=included_count)


def merge_prepare_outputs(exp_dir):
    text_part = exp_dir / "2-name2text-0.txt"
    semantic_part = exp_dir / "6-name2semantic-0.tsv"
    if not text_part.exists() or not semantic_part.exists():
        raise RuntimeError("数据格式化输出不完整")
    shutil.copy2(text_part, exp_dir / "2-name2text.txt")
    semantic_lines = semantic_part.read_text(encoding="utf-8").strip().splitlines()
    (exp_dir / "6-name2semantic.tsv").write_text("item_name\tsemantic_audio\n" + "\n".join(semantic_lines) + "\n", encoding="utf-8")


def make_s2_config(project_id, exp_dir, config_path):
    base = load_json(GSV_DIR / "GPT_SoVITS" / "configs" / "s2.json")
    base["train"].update({
        "epochs": 2, "batch_size": 1, "fp16_run": True, "text_low_lr_rate": 0.4,
        "grad_ckpt": False, "lora_rank": "32",
        "pretrained_s2G": str(GSV_DIR / "GPT_SoVITS" / "pretrained_models" / "s2Gv3.pth"),
        "if_save_latest": True, "if_save_every_weights": True, "save_every_epoch": 1,
        "gpu_numbers": "0",
    })
    base["data"]["exp_dir"] = str(exp_dir)
    base["model"]["version"] = "v3"
    base["s2_ckpt_dir"] = str(exp_dir)
    base["save_weight_dir"] = str(GSV_DIR / "SoVITS_weights_v3")
    base["name"] = project_id
    base["version"] = "v3"
    atomic_json(config_path, base)


def make_s1_config(project_id, exp_dir, config_path):
    base = yaml.safe_load((GSV_DIR / "GPT_SoVITS" / "configs" / "s1longer-v2.yaml").read_text(encoding="utf-8"))
    base["train"].update({
        "batch_size": 2, "epochs": 15, "save_every_n_epoch": 5,
        "if_save_every_weights": True, "if_save_latest": True, "if_dpo": False,
        "half_weights_save_dir": str(GSV_DIR / "GPT_weights_v3"), "exp_name": project_id,
    })
    base["pretrained_s1"] = str(GSV_DIR / "GPT_SoVITS" / "pretrained_models" / "s1v3.ckpt")
    base["train_semantic_path"] = str(exp_dir / "6-name2semantic.tsv")
    base["train_phoneme_path"] = str(exp_dir / "2-name2text.txt")
    base["output_dir"] = str(exp_dir / "logs_s1_v3")
    config_path.write_text(yaml.safe_dump(base, allow_unicode=True, sort_keys=False), encoding="utf-8")


def train(project_id):
    project_id = safe_id(project_id)
    project_dir = PROJECTS_DIR / project_id
    project = load_json(project_dir / "project.json")
    review_path = project_dir / "review.csv"
    if not review_path.exists():
        raise RuntimeError("请先完成预处理")
    with review_path.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    selected = [row for row in rows if str(row.get("included", "")).strip().lower() in {"1", "true", "yes", "y", "是"} and clean_text(row.get("text"))]
    if len(selected) < 5:
        raise RuntimeError(f"纳入训练的片段只有 {len(selected)} 段，至少需要 5 段")
    speaker = safe_id(project.get("speaker") or project_id)
    train_list = project_dir / "train.final.list"
    train_list.write_text("\n".join(f"{row['audio_path']}|{speaker}|{row.get('language') or project.get('sourceLanguage','ja')}|{clean_text(row['text'])}" for row in selected) + "\n", encoding="utf-8")
    exp_dir = GSV_DIR / "logs" / project_id
    exp_dir.mkdir(parents=True, exist_ok=True)
    configs_dir = project_dir / "configs"
    configs_dir.mkdir(parents=True, exist_ok=True)
    s2_config = configs_dir / "s2_v3_lora.json"
    s2_semantic_config = configs_dir / "s2_v3_semantic.json"
    s1_config = configs_dir / "s1_v3.yaml"
    make_s2_config(project_id, exp_dir, s2_config)
    semantic_config = load_json(s2_config)
    # 3-get-semantic.py supplies version explicitly, while s2_train_v3_lora.py
    # reads hps.model.version. They therefore need separate config variants.
    semantic_config["model"].pop("version", None)
    atomic_json(s2_semantic_config, semantic_config)
    make_s1_config(project_id, exp_dir, s1_config)
    common_env = {
        "inp_text": str(train_list), "inp_wav_dir": "", "exp_name": project_id,
        "i_part": "0", "all_parts": "1", "_CUDA_VISIBLE_DEVICES": "0",
        "opt_dir": str(exp_dir), "is_half": "True", "version": "v3",
    }
    update_status(project_dir, "format_text", "正在生成文本与音素特征", 8, selectedCount=len(selected))
    run([str(PYTHON), "GPT_SoVITS/prepare_datasets/1-get-text.py"], env={
        **common_env,
        "bert_pretrained_dir": str(GSV_DIR / "GPT_SoVITS" / "pretrained_models" / "chinese-roberta-wwm-ext-large"),
    })
    update_status(project_dir, "format_audio", "正在生成 HuBERT 和 32k 音频特征", 22)
    run([str(PYTHON), "GPT_SoVITS/prepare_datasets/2-get-hubert-wav32k.py"], env={
        **common_env,
        "cnhubert_base_dir": str(GSV_DIR / "GPT_SoVITS" / "pretrained_models" / "chinese-hubert-base"),
    })
    update_status(project_dir, "format_semantic", "正在提取语义特征", 38)
    run([str(PYTHON), "GPT_SoVITS/prepare_datasets/3-get-semantic.py"], env={
        **common_env,
        "pretrained_s2G": str(GSV_DIR / "GPT_SoVITS" / "pretrained_models" / "s2Gv3.pth"),
        "s2config_path": str(s2_semantic_config),
    })
    merge_prepare_outputs(exp_dir)
    update_status(project_dir, "train_sovits", "正在训练 SoVITS V3 LoRA（2 epochs）", 52)
    run([str(PYTHON), "GPT_SoVITS/s2_train_v3_lora.py", "--config", str(s2_config)], env={"_CUDA_VISIBLE_DEVICES": "0"})
    update_status(project_dir, "train_gpt", "正在训练 GPT（15 epochs）", 72)
    run([str(PYTHON), "GPT_SoVITS/s1_train.py", "--config_file", str(s1_config)], env={"_CUDA_VISIBLE_DEVICES": "0", "hz": "25hz"})
    gpt_candidates = sorted((GSV_DIR / "GPT_weights_v3").glob(f"{project_id}-e*.ckpt"), key=lambda p: p.stat().st_mtime)
    sovits_candidates = sorted((GSV_DIR / "SoVITS_weights_v3").glob(f"{project_id}_e*_l*.pth"), key=lambda p: p.stat().st_mtime)
    if not gpt_candidates or not sovits_candidates:
        raise RuntimeError("训练结束但未找到最终权重")
    reference = sorted(selected, key=lambda row: (abs(float(row.get("duration", 5)) - 5.0), -float(row.get("avg_logprob", -9))))[0]
    profile = {
        "id": project_id,
        "name": project.get("name") or project_id,
        "version": "v3",
        "speaker": speaker,
        "sourceLanguage": project.get("sourceLanguage", "ja"),
        "gptWeight": str(gpt_candidates[-1]),
        "sovitsWeight": str(sovits_candidates[-1]),
        "referenceAudio": reference["audio_path"],
        "referenceText": clean_text(reference["text"]),
        "referenceLanguage": reference.get("language") or project.get("sourceLanguage", "ja"),
        "supportedTargetLanguages": ["ja", "zh"],
        "enabled": True,
        "notes": f"控制台保守训练：{len(selected)} 条片段；自动发布。",
    }
    PROFILES_DIR.mkdir(parents=True, exist_ok=True)
    atomic_json(PROFILES_DIR / f"{project_id}.json", profile)
    project["publishedProfile"] = str(PROFILES_DIR / f"{project_id}.json")
    project["gptWeight"] = profile["gptWeight"]
    project["sovitsWeight"] = profile["sovitsWeight"]
    project["selectedCount"] = len(selected)
    atomic_json(project_dir / "project.json", project)
    update_status(project_dir, "completed", f"训练完成并已发布音色：{profile['name']}", 100, profileId=project_id, gptWeight=profile["gptWeight"], sovitsWeight=profile["sovitsWeight"])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["prepare", "train"])
    parser.add_argument("project_id")
    args = parser.parse_args()
    project_dir = PROJECTS_DIR / safe_id(args.project_id)
    try:
        if args.mode == "prepare":
            prepare(args.project_id)
        else:
            train(args.project_id)
    except Exception as error:
        update_status(project_dir, "failed", str(error), error=str(error))
        raise


if __name__ == "__main__":
    main()
