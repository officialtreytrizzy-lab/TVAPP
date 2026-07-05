"""Wan2.1 VACE prompt-video remix pipeline for TVAPP / TrizzyCut.

This wrapper is intentionally strict about output validation and intentionally
configurable around the final Wan command. Wan/VACE upstream CLI flags may change;
set AI_REMIX_WAN_CMD_TEMPLATE when you need to override the default command
without changing API code.
"""

from __future__ import annotations

import os
import shlex
import shutil
import subprocess
import time
from pathlib import Path


WAN_ROOT = Path(os.environ.get("WAN_ROOT", "/opt/Wan2.1"))
WAN_CKPT_DIR = Path(os.environ.get("WAN_CKPT_DIR", "/models/Wan2.1-VACE-1.3B"))
MAX_SECONDS = float(os.environ.get("AI_REMIX_MAX_SECONDS", "5"))
TARGET_SIZE = os.environ.get("AI_REMIX_SIZE", "832*480")
LOG_PATH = os.environ.get("AI_REMIX_LOG_PATH", "").strip()


def append_log(line: str) -> None:
    if not LOG_PATH:
        return
    path = Path(LOG_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(line.rstrip("\n") + "\n")
        handle.flush()


def command_text(cmd: list[str] | str) -> str:
    return cmd if isinstance(cmd, str) else shlex.join(cmd)


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def run(cmd: list[str] | str, cwd: Path | None = None) -> str:
    append_log(f"command={command_text(cmd)}")
    completed = subprocess.Popen(
        cmd,
        cwd=str(cwd) if cwd else None,
        shell=isinstance(cmd, str),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    lines: list[str] = []
    assert completed.stdout is not None
    for line in completed.stdout:
        clean = line.rstrip("\n")
        lines.append(clean)
        append_log(clean)
    return_code = completed.wait()
    output = "\n".join(lines)
    if return_code != 0:
        raise RuntimeError(output[-6000:] or f"Command failed: {command_text(cmd)}")
    return output


def ffprobe_has_video(path: Path) -> bool:
    try:
        out = run([
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=codec_type", "-of", "csv=p=0", str(path),
        ])
        return "video" in out
    except Exception:
        return False


def normalize_video(input_video: Path, output_video: Path) -> None:
    append_log("starting normalize_video")
    # V1 keeps generated jobs short and 480p-ish so A10G costs stay predictable.
    # Scale/pad preserves composition and creates dimensions Wan accepts.
    width, height = TARGET_SIZE.split("*", 1)
    vf = (
        f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=16,format=yuv420p"
    )
    run([
        "ffmpeg", "-y", "-i", str(input_video), "-t", f"{MAX_SECONDS:.3f}",
        "-map", "0:v:0", "-vf", vf, "-an", "-c:v", "libx264",
        "-preset", "veryfast", "-crf", "18", "-movflags", "+faststart", str(output_video),
    ])


def mux_original_audio(remixed_video: Path, source_video: Path, output_video: Path) -> None:
    try:
        run([
            "ffmpeg", "-y", "-i", str(remixed_video), "-i", str(source_video),
            "-map", "0:v:0", "-map", "1:a?", "-c:v", "copy", "-c:a", "aac",
            "-b:a", "192k", "-shortest", "-movflags", "+faststart", str(output_video),
        ])
    except Exception:
        shutil.copyfile(remixed_video, output_video)


def find_newest_mp4(root: Path, newer_than: float | None = None) -> Path:
    candidates = [
        p for p in root.rglob("*.mp4")
        if p.is_file() and p.stat().st_size > 0 and (newer_than is None or p.stat().st_mtime >= newer_than)
    ]
    if not candidates:
        raise RuntimeError(f"Wan completed but no mp4 output was found under {root}")
    return max(candidates, key=lambda p: p.stat().st_mtime)


def render_with_wan(normalized_video: Path, mask_path: Path | None, prompt: str, work_dir: Path) -> Path:
    append_log(f"checking Wan root={WAN_ROOT}")
    append_log(f"checking Wan checkpoint={WAN_CKPT_DIR}")
    if not WAN_ROOT.exists():
        raise RuntimeError(f"Wan2.1 is not installed at {WAN_ROOT}. Redeploy the Modal worker image.")
    if not (WAN_ROOT / "generate.py").exists():
        raise RuntimeError(f"Wan generate.py is missing at {WAN_ROOT / 'generate.py'}. Redeploy the Modal worker image.")
    if not WAN_CKPT_DIR.exists():
        raise RuntimeError(
            f"Wan model weights are missing at {WAN_CKPT_DIR}. Download Wan-AI/Wan2.1-VACE-1.3B into the /models Modal volume."
        )

    output_dir = work_dir / "wan_outputs"
    if output_dir.exists():
        shutil.rmtree(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    marker_time = output_dir.stat().st_mtime

    template = os.environ.get("AI_REMIX_WAN_CMD_TEMPLATE", "").strip()
    if template:
        command = template.format(
            wan_root=str(WAN_ROOT),
            ckpt_dir=str(WAN_CKPT_DIR),
            input_video=str(normalized_video),
            mask=str(mask_path or ""),
            prompt=shlex.quote(prompt),
            prompt_raw=prompt,
            output_dir=str(output_dir),
            size=TARGET_SIZE,
        )
        append_log("starting Wan subprocess")
        append_log(f"wan_command={command}")
        run(command, cwd=WAN_ROOT)
    else:
        # Run from the Wan repo. Running from the job output directory makes
        # python look for /tmp/.../wan_outputs/generate.py, which fails.
        cmd = [
            "python", "-u", "generate.py",
            "--task", "vace-1.3B",
            "--size", TARGET_SIZE,
            "--ckpt_dir", str(WAN_CKPT_DIR),
            "--src_video", str(normalized_video),
            "--prompt", prompt,
            "--offload_model", "True",
            "--t5_cpu",
            "--sample_shift", "8",
            "--sample_guide_scale", "6",
        ]
        if mask_path and mask_path.exists():
            cmd += ["--src_mask", str(mask_path)]
        try:
            append_log("starting Wan subprocess")
            append_log(f"wan_command={command_text(cmd)}")
            run(cmd, cwd=WAN_ROOT)
        except Exception as exc:
            raise RuntimeError(
                "Wan VACE command failed. Set AI_REMIX_WAN_CMD_TEMPLATE if your installed Wan/VACE CLI uses different flags. "
                f"Original error: {exc}"
            )

    for search_root in (output_dir, work_dir, WAN_ROOT):
        try:
            return find_newest_mp4(search_root, newer_than=marker_time)
        except Exception:
            continue
    raise RuntimeError("Wan completed but did not write a new MP4 output.")


def main() -> None:
    input_video = Path(required_env("AI_REMIX_INPUT_VIDEO"))
    output_video = Path(required_env("AI_REMIX_OUTPUT_VIDEO"))
    prompt = required_env("AI_REMIX_PROMPT")
    preserve_audio = os.environ.get("AI_REMIX_PRESERVE_AUDIO", "true").strip().lower() != "false"
    input_mask_raw = os.environ.get("AI_REMIX_INPUT_MASK", "").strip()
    input_mask = Path(input_mask_raw) if input_mask_raw else None

    if not input_video.exists() or input_video.stat().st_size <= 0:
        raise RuntimeError(f"Input video is missing or empty: {input_video}")

    append_log(f"pipeline_started_at={time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}")
    append_log(f"pipeline_pid={os.getpid()}")
    append_log(f"pipeline_input={input_video}")
    append_log(f"pipeline_output={output_video}")
    output_video.parent.mkdir(parents=True, exist_ok=True)
    work_dir = output_video.parent
    normalized = work_dir / "wan_input_480p.mp4"
    raw_wan_output = work_dir / "wan_raw_output.mp4"

    normalize_video(input_video, normalized)
    generated = render_with_wan(normalized, input_mask, prompt, work_dir)
    shutil.copyfile(generated, raw_wan_output)

    if preserve_audio:
        mux_original_audio(raw_wan_output, input_video, output_video)
    else:
        shutil.copyfile(raw_wan_output, output_video)

    if not ffprobe_has_video(output_video):
        raise RuntimeError("Wan remix did not create a playable video output")


if __name__ == "__main__":
    main()
