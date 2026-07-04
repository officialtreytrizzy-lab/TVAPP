import modal

# Deploy with:
#   pip install modal
#   modal setup
#   modal deploy gpu-worker/modal_app.py
#
# The deployed URL becomes VITE_ERASER_GPU_WORKER_URL in Vercel.
# Wan model weights should live in the Modal volume mounted at /models.
# First-time model download example inside a Modal shell/job:
#   huggingface-cli download Wan-AI/Wan2.1-VACE-1.3B --local-dir /models/Wan2.1-VACE-1.3B

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
