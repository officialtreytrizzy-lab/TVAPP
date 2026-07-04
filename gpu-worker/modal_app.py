import subprocess
import modal

# Deploy with:
#   pip install modal
#   modal setup
#   modal deploy gpu-worker/modal_app.py
#
# The deployed URL becomes VITE_ERASER_GPU_WORKER_URL in Vercel.
# Wan model weights live in the Modal volume mounted at /models.
# Download/update weights with:
#   modal run gpu-worker/modal_app.py::download_wan_model

wan_models = modal.Volume.from_name("tvapp-wan-models", create_if_missing=True)

worker_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "git", "libgl1", "libglib2.0-0")
    .pip_install("torch", "torchvision", index_url="https://download.pytorch.org/whl/cu121")
    .pip_install_from_requirements("gpu-worker/requirements.txt")
    .run_commands(
        "rm -rf /opt/ProPainter && git clone --depth 1 https://github.com/sczhou/ProPainter.git /opt/ProPainter",
        "pip install -r /opt/ProPainter/requirements.txt",
        "rm -rf /opt/Wan2.1 && git clone --depth 1 https://github.com/Wan-Video/Wan2.1.git /opt/Wan2.1",
        "pip install -r /opt/Wan2.1/requirements.txt",
        "pip install 'huggingface_hub[cli]'",
    )
    .add_local_dir("gpu-worker", remote_path="/app")
)

app = modal.App("tvapp-video-eraser-gpu")


@app.function(
    image=worker_image,
    timeout=60 * 60,
    volumes={"/models": wan_models},
)
def download_wan_model():
    """Download Wan2.1 VACE weights into the persistent Modal volume."""
    command = [
        "huggingface-cli",
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


@app.function(
    image=worker_image,
    gpu="A10G",
    timeout=60 * 45,
    scaledown_window=60 * 5,
    max_containers=1,
    volumes={"/models": wan_models},
)
@modal.concurrent(max_inputs=1)
@modal.asgi_app()
def fastapi_app():
    import sys
    sys.path.insert(0, "/app")
    from main import app as fastapi_application
    return fastapi_application
