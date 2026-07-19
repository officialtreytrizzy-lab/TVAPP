import os
import subprocess

import modal

# Deploy with:
#   pip install modal
#   modal token new --profile wthemif --activate
#   MODAL_PROFILE=wthemif modal deploy gpu-worker/modal_app.py
#
# The deployed URL becomes VITE_ERASER_GPU_WORKER_URL in Vercel.
# Wan model weights live in the Modal volume mounted at /models.
# Download/update weights with:
#   MODAL_PROFILE=wthemif modal run gpu-worker/modal_app.py::download_models

wan_models = modal.Volume.from_name("tvapp-wan-models", create_if_missing=True)

worker_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "git", "curl", "libgl1", "libglib2.0-0")
    .pip_install("torch", "torchvision", index_url="https://download.pytorch.org/whl/cu121")
    .pip_install_from_requirements("gpu-worker/requirements.txt")
    .run_commands(
        "rm -rf /opt/Wan2.1 && git clone --depth 1 https://github.com/Wan-Video/Wan2.1.git /opt/Wan2.1",
        "python - <<'PY'\nfrom pathlib import Path\nsrc = Path('/opt/Wan2.1/requirements.txt')\nout = Path('/tmp/wan-requirements-no-flash.txt')\nskip = {'flash-attn', 'flash_attn'}\nlines = []\nfor line in src.read_text().splitlines():\n    stripped = line.strip()\n    normalized = stripped.split('==')[0].split('>=')[0].split('<=')[0].split('~=')[0].split('[')[0].replace('_', '-').lower()\n    if normalized in skip:\n        print(f'Skipping optional CUDA build dependency: {stripped}')\n        continue\n    lines.append(line)\nout.write_text('\\n'.join(lines) + '\\n')\nPY",
        "pip install -r /tmp/wan-requirements-no-flash.txt",
        "pip install decord",
        "pip install 'huggingface_hub[cli]'",
        "pip install 'numpy<2' 'Pillow>=9,<12' realesrgan==0.3.0 gfpgan==1.3.8 basicsr==1.4.2 facexlib==0.3.0 lmdb yapf",
        "python - <<'PY'\nfrom pathlib import Path\nimport site\nfor site_dir in site.getsitepackages():\n    path = Path(site_dir) / 'basicsr' / 'data' / 'degradations.py'\n    if path.exists():\n        text = path.read_text()\n        text = text.replace('from torchvision.transforms.functional_tensor import rgb_to_grayscale', 'from torchvision.transforms.functional import rgb_to_grayscale')\n        path.write_text(text)\n        print(f'Patched basicsr torchvision import: {path}')\nPY",
        "mkdir -p /opt/realesrgan_weights && python - <<'PY'\nfrom pathlib import Path\nfrom urllib.request import urlretrieve\nweights = {\n    'RealESRGAN_x4plus.pth': 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth',\n    'RealESRGAN_x4plus_anime_6B.pth': 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.2.4/RealESRGAN_x4plus_anime_6B.pth',\n    'GFPGANv1.4.pth': 'https://github.com/TencentARC/GFPGAN/releases/download/v1.3.4/GFPGANv1.4.pth',\n}\nroot = Path('/opt/realesrgan_weights')\nfor name, url in weights.items():\n    out = root / name\n    if not out.exists() or out.stat().st_size < 1000000:\n        print(f'Downloading {name}: {url}')\n        urlretrieve(url, out)\n    print(f'Ready {name}: {out.stat().st_size} bytes')\nPY",
    )
    # Some third-party requirements can replace the CUDA-enabled torch wheel.
    # Reinstall the exact CUDA build last so the deployed worker cannot silently
    # fall back to a CPU-only PyTorch package.
    .pip_install(
        "torch==2.5.1+cu121",
        "torchvision==0.20.1+cu121",
        index_url="https://download.pytorch.org/whl/cu121",
    )
    .run_commands(
        "pip install einops==0.8.1",
        "pip install --no-deps 'https://github.com/Dao-AILab/flash-attention/releases/download/v2.7.4.post1/flash_attn-2.7.4.post1+cu12torch2.5cxx11abiFALSE-cp311-cp311-linux_x86_64.whl'",
        "python - <<'PY'\nimport einops\nimport flash_attn\nimport torch\nif torch.version.cuda is None:\n    raise RuntimeError(f'CPU-only PyTorch wheel installed: torch={torch.__version__}')\nif einops.__version__ != '0.8.1':\n    raise RuntimeError(f'Unexpected einops build: {einops.__version__}')\nif flash_attn.__version__ != '2.7.4.post1':\n    raise RuntimeError(f'Unexpected Flash Attention build: {flash_attn.__version__}')\nprint(f'CUDA image verified: torch={torch.__version__} cuda_build={torch.version.cuda} einops={einops.__version__} flash_attn={flash_attn.__version__}')\nPY",
    )
    .add_local_dir("gpu-worker", remote_path="/app")
)

app = modal.App("tvapp-video-eraser-gpu")


def require_gpu_runtime() -> dict[str, str | bool]:
    """Refuse to start a worker that cannot actually see its assigned GPU."""
    import einops
    import flash_attn
    import torch

    cuda_available = bool(torch.cuda.is_available())
    if not cuda_available:
        raise RuntimeError(
            "TVAPP GPU worker started without CUDA. Refusing CPU fallback. "
            f"torch={torch.__version__} cuda_build={torch.version.cuda} "
            f"CUDA_VISIBLE_DEVICES={os.environ.get('CUDA_VISIBLE_DEVICES', '<unset>')}"
        )

    device_name = torch.cuda.get_device_name(0)
    details = {
        "cuda_available": True,
        "device": device_name,
        "torch": str(torch.__version__),
        "cuda_build": str(torch.version.cuda),
        "einops": str(einops.__version__),
        "flash_attn": str(flash_attn.__version__),
    }
    print(
        "TVAPP GPU runtime verified: "
        f"device={device_name} torch={torch.__version__} cuda_build={torch.version.cuda} "
        f"einops={einops.__version__} flash_attn={flash_attn.__version__}",
        flush=True,
    )
    return details


@app.function(
    image=worker_image,
    timeout=60 * 60,
    volumes={"/models": wan_models},
)
def download_wan_model():
    """Download Wan2.1 VACE weights into the persistent Modal volume."""
    command = [
        "hf",
        "download",
        "Wan-AI/Wan2.1-VACE-1.3B",
        "--local-dir",
        "/models/Wan2.1-VACE-1.3B",
    ]
    completed = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, check=False)
    if completed.returncode != 0:
        raise RuntimeError(completed.stdout[-8000:] or "Wan model download failed")
    wan_models.commit()
    return "Wan2.1 VACE 1.3B is installed at /models/Wan2.1-VACE-1.3B"


@app.local_entrypoint()
def download_models():
    """Local command wrapper: modal run gpu-worker/modal_app.py::download_models"""
    print(download_wan_model.remote())


@app.function(
    image=worker_image,
    gpu="A10G",
    timeout=60 * 45,
    scaledown_window=60 * 50,
    max_containers=1,
    volumes={"/models": wan_models},
)
@modal.concurrent(max_inputs=1)
@modal.asgi_app()
def fastapi_app():
    import sys

    os.environ["CUDA_VISIBLE_DEVICES"] = "0"
    os.environ["ERASER_REQUIRE_CUDA"] = "true"
    os.environ["ERASER_PIPELINE_CMD"] = "python /app/pipelines/optical_flow_vace_inpaint.py"
    os.environ.setdefault("ERASER_MASK_DILATION_PX", "2")
    os.environ.setdefault("ERASER_TRACK_MAX_SIDE", "960")
    os.environ.setdefault("ERASER_DIFFUSION_FPS", "16")
    os.environ.setdefault("ERASER_DIFFUSION_STEPS", "24")
    gpu_details = require_gpu_runtime()

    sys.path.insert(0, "/app")
    from main import app as fastapi_application

    @fastapi_application.get("/gpu-health", include_in_schema=False)
    async def gpu_health():
        return {"ok": True, "worker": "tvapp-video-eraser-gpu", **gpu_details}

    return fastapi_application


@app.function(
    image=worker_image,
    gpu="A10G",
    timeout=60 * 20,
    scaledown_window=60 * 20,
    max_containers=1,
)
@modal.concurrent(max_inputs=1)
@modal.asgi_app()
def image_enhancer_app():
    import sys

    os.environ["CUDA_VISIBLE_DEVICES"] = "0"
    gpu_details = require_gpu_runtime()

    sys.path.insert(0, "/app")
    from image_enhancer_app import app as fastapi_application

    @fastapi_application.get("/gpu-health", include_in_schema=False)
    async def gpu_health():
        return {"ok": True, "worker": "tvapp-image-enhancer-gpu", **gpu_details}

    return fastapi_application

