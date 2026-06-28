import modal

# Deploy with:
#   pip install modal
#   modal setup
#   modal deploy gpu-worker/modal_app.py
#
# The deployed URL becomes VITE_ERASER_GPU_WORKER_URL in Vercel.

worker_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "git")
    .pip_install_from_requirements("gpu-worker/requirements.txt")
    .add_local_dir("gpu-worker", remote_path="/app")
)

app = modal.App("tvapp-video-eraser-gpu")


@app.function(
    image=worker_image,
    gpu="A10G",
    timeout=60 * 30,
    scaledown_window=60 * 5,
    allow_concurrent_inputs=4,
)
@modal.asgi_app()
def fastapi_app():
    import sys
    sys.path.insert(0, "/app")
    from main import app as fastapi_application
    return fastapi_application
