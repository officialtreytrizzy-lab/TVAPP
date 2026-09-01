from __future__ import annotations

import os
import subprocess
from pathlib import Path

import modal

APP_NAME = "trizzy-audio-ace"
ROOT = Path(__file__).parent
ACE_ROOT = "/opt/ace-step"
CHECKPOINTS = f"{ACE_ROOT}/checkpoints"
UV = "/usr/local/bin/uv"

app = modal.App(APP_NAME)

models = modal.Volume.from_name(
    "trizzy-audio-ace-models",
    create_if_missing=True,
)

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git", "ffmpeg", "curl")
    .pip_install("uv", "fastapi[standard]", "httpx")
    .run_commands(
        "git clone --depth 1 https://github.com/ace-step/ACE-Step-1.5.git /opt/ace-step",
        "cd /opt/ace-step && uv sync --frozen --no-dev",
    )
    .add_local_file(str(ROOT / "gateway.py"), "/opt/trizzy/gateway.py")
)

COMMON_ENV = {
    "ACESTEP_API_HOST": "127.0.0.1",
    "ACESTEP_API_PORT": "8001",
    "ACESTEP_API_WORKERS": "1",
    "ACESTEP_DEVICE": "cuda",
    "ACESTEP_INIT_LLM": "true",
    "ACESTEP_NO_INIT": "false",
    "ACESTEP_LM_BACKEND": "vllm",
    "ACESTEP_LM_MODEL_PATH": "acestep-5Hz-lm-1.7B",
    "ACESTEP_QUEUE_WORKERS": "1",
    "ACESTEP_COMPILE_MODEL": "false",
    "ACESTEP_USE_FLASH_ATTENTION": "false",
    "ACESTEP_CHECKPOINTS_DIR": CHECKPOINTS,
    "ACESTEP_DOWNLOAD_SOURCE": "huggingface",
    "HF_HOME": f"{CHECKPOINTS}/hf-cache",
    "TRIZZY_SUPABASE_URL": "https://lxdpbxnnohtzcqetbzxo.supabase.co",
    "TRIZZY_SUPABASE_PUBLISHABLE_KEY": "sb_publishable_nQN7Ns7ldNX5Xl7o8bxZiA_ynYR_qIE",
    "TRIZZY_SUPABASE_LEGACY_URL": "https://sdibjsjokhadjzruehbu.supabase.co",
    "TRIZZY_SUPABASE_LEGACY_PUBLISHABLE_KEY": "sb_publishable_GZT1zi2PQt-8-0QM6sl5yA_1nCM867H",
    "TRIZZY_ACE_LOCAL_URL": "http://127.0.0.1:8001",
    "TRIZZY_EXPECTED_LM_MODEL": "acestep-5Hz-lm-1.7B",
}


def _ace_env() -> dict[str, str]:
    env = os.environ.copy()
    env.update(COMMON_ENV)
    return env


def _run_download(args: list[str]) -> None:
    subprocess.run(
        [UV, "run", "--no-sync", "python", "-m", "acestep.model_downloader", *args],
        cwd=ACE_ROOT,
        env=_ace_env(),
        check=True,
    )


@app.function(
    image=image,
    timeout=60 * 60,
    cpu=4,
    memory=16384,
    volumes={CHECKPOINTS: models},
)
def warm_models():
    """Populate and commit all models needed by the production web workers."""
    models.reload()

    # The main bundle contains VAE, text encoder, Turbo DiT, and the 1.7B LM.
    _run_download([])

    # Base is distributed separately and must be present for final/repaint work.
    _run_download(["--model", "acestep-v15-base", "--skip-main"])

    models.commit()

    required = [
        "acestep-v15-turbo",
        "acestep-v15-base",
        "acestep-5Hz-lm-1.7B",
        "vae",
    ]
    missing = [
        name
        for name in required
        if not (Path(CHECKPOINTS) / name).exists()
    ]
    if missing:
        raise RuntimeError(f"ACE model warmup incomplete; missing: {missing}")

    return {
        "status": "ready",
        "checkpoints": CHECKPOINTS,
        "models": required,
    }


def start_stack(config_path: str) -> None:
    models.reload()

    env = _ace_env()
    env["ACESTEP_CONFIG_PATH"] = config_path
    env["TRIZZY_EXPECTED_ACE_MODEL"] = config_path

    subprocess.Popen(
        [
            UV,
            "run",
            "--no-sync",
            "acestep-api",
            "--host",
            "127.0.0.1",
            "--port",
            "8001",
            "--init-llm",
            "--lm-model-path",
            env["ACESTEP_LM_MODEL_PATH"],
        ],
        cwd=ACE_ROOT,
        env=env,
    )

    subprocess.Popen(
        [
            "python",
            "-m",
            "uvicorn",
            "gateway:app",
            "--app-dir",
            "/opt/trizzy",
            "--host",
            "0.0.0.0",
            "--port",
            "8000",
            "--workers",
            "1",
        ],
        env=env,
    )


@app.function(
    image=image,
    gpu="A10G",
    timeout=60 * 60,
    startup_timeout=60 * 15,
    scaledown_window=60 * 10,
    max_containers=1,
    volumes={CHECKPOINTS: models},
)
@modal.web_server(8000, startup_timeout=60 * 15)
def turbo_api():
    start_stack("acestep-v15-turbo")


@app.function(
    image=image,
    gpu="A10G",
    timeout=60 * 60,
    startup_timeout=60 * 15,
    scaledown_window=60 * 10,
    max_containers=1,
    volumes={CHECKPOINTS: models},
)
@modal.web_server(8000, startup_timeout=60 * 15)
def base_api():
    start_stack("acestep-v15-base")
