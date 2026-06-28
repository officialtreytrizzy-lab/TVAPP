import modal

# Deploy with:
#   pip install modal
#   modal setup
#   modal deploy gpu-worker/modal_app.py
#
# The deployed URL becomes VITE_ERASER_GPU_WORKER_URL in Vercel.

worker_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "git", "libgl1", "libglib2.0-0")
    .pip_install("torch", "torchvision", index_url="https://download.pytorch.org/whl/cu121")
    .pip_install_from_requirements("gpu-worker/requirements.txt")
    .run_commands(
        "rm -rf /opt/ProPainter && git clone --depth 1 https://github.com/sczhou/ProPainter.git /opt/ProPainter",
        "pip install -r /opt/ProPainter/requirements.txt",
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
)
@modal.concurrent(max_inputs=1)
@modal.asgi_app()
def fastapi_app():
    import sys
    sys.path.insert(0, "/app")
    from main import app as fastapi_application
    return fastapi_application
