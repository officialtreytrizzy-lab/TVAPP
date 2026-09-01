from __future__ import annotations

import os
import subprocess
from pathlib import Path

import modal

APP_NAME = "trizzy-audio-ace"
ROOT = Path(__file__).parent

app = modal.App(APP_NAME)

models = modal.Volume.from_name("trizzy-audio-ace-models", create_if_missing=True)

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
    "ACESTEP_INIT_SERVICE": "true",
    "ACESTEP_LM_BACKEND": "pt",
    "ACESTEP_LM_MODEL_PATH": "acestep-5Hz-lm-0.6B",
    "ACESTEP_QUEUE_WORKERS": "1",
    "HF_HOME": "/opt/ace-step/checkpoints/hf-cache",
    "TRIZZY_SUPABASE_URL": "https://lxdpbxnnohtzcqetbzxo.supabase.co",
    "TRIZZY_SUPABASE_PUBLISHABLE_KEY": "sb_publishable_nQN7Ns7ldNX5Xl7o8bxZiA_ynYR_qIE",
    "TRIZZY_SUPABASE_LEGACY_URL": "https://sdibjsjokhadjzruehbu.supabase.co",
    "TRIZZY_SUPABASE_LEGACY_PUBLISHABLE_KEY": "sb_publishable_GZT1zi2PQt-8-0QM6sl5yA_1nCM867H",
    "TRIZZY_ACE_LOCAL_URL": "http://127.0.0.1:8001",
}


def start_stack(config_path: str) -> None:
    env = os.environ.copy()
    env.update(COMMON_ENV)
    env["ACESTEP_CONFIG_PATH"] = config_path

    subprocess.Popen(
        [
            "/usr/local/bin/uv",
            "run",
            "python",
            "-m",
            "acestep.api_server",
            "--host",
            "127.0.0.1",
            "--port",
            "8001",
        ],
        cwd="/opt/ace-step",
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
    startup_timeout=60 * 20,
    scaledown_window=60 * 10,
    max_containers=1,
    volumes={"/opt/ace-step/checkpoints": models},
)
@modal.web_server(8000, startup_timeout=60 * 20)
def turbo_api():
    start_stack("acestep-v15-turbo")


@app.function(
    image=image,
    gpu="A10G",
    timeout=60 * 60,
    startup_timeout=60 * 20,
    scaledown_window=60 * 10,
    max_containers=1,
    volumes={"/opt/ace-step/checkpoints": models},
)
@modal.web_server(8000, startup_timeout=60 * 20)
def base_api():
    start_stack("acestep-v15-base")
