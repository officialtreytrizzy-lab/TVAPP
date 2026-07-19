from __future__ import annotations

import os
from pathlib import Path

import cv2
import numpy as np

REALESRGAN_WEIGHTS_DIR = Path(os.environ.get("REALESRGAN_WEIGHTS_DIR", "/opt/realesrgan_weights"))
PHOTO_MODEL_PATH = Path(os.environ.get("REALESRGAN_PHOTO_MODEL", str(REALESRGAN_WEIGHTS_DIR / "RealESRGAN_x4plus.pth")))
ANIME_MODEL_PATH = Path(os.environ.get("REALESRGAN_ANIME_MODEL", str(REALESRGAN_WEIGHTS_DIR / "RealESRGAN_x4plus_anime_6B.pth")))
GFPGAN_MODEL_PATH = Path(os.environ.get("GFPGAN_MODEL", str(REALESRGAN_WEIGHTS_DIR / "GFPGANv1.4.pth")))


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def bool_env(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name, str(default)).strip().lower()
    return raw in {"1", "true", "yes", "on"}


def int_env(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(float(os.environ.get(name, str(default))))
    except Exception:
        value = default
    return max(min(value, maximum), minimum)


def read_image(path: Path) -> np.ndarray:
    data = np.fromfile(str(path), dtype=np.uint8)
    image = cv2.imdecode(data, cv2.IMREAD_UNCHANGED)
    if image is None:
        raise RuntimeError(f"Could not read input image: {path}")
    if image.ndim == 2:
        image = cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)
    if image.ndim == 3 and image.shape[2] == 4:
        alpha = image[:, :, 3]
        bgr = image[:, :, :3]
        white = np.full_like(bgr, 255)
        image = np.where(alpha[:, :, None] > 0, bgr, white)
    if image.ndim != 3 or image.shape[2] != 3:
        raise RuntimeError("Unsupported image format")
    return image


def write_image(path: Path, image: np.ndarray, output_format: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fmt = output_format.lower().strip()
    if fmt not in {"png", "jpg", "jpeg", "webp"}:
        fmt = "png"
    ext = ".jpg" if fmt == "jpeg" else f".{fmt}"
    encode_params: list[int] = []
    if ext in {".jpg", ".jpeg"}:
        encode_params = [int(cv2.IMWRITE_JPEG_QUALITY), 96]
    elif ext == ".webp":
        encode_params = [int(cv2.IMWRITE_WEBP_QUALITY), 96]
    ok, encoded = cv2.imencode(ext, image, encode_params)
    if not ok:
        raise RuntimeError(f"Could not encode output image as {fmt}")
    encoded.tofile(str(path))


def build_upsampler(mode: str, scale: int, tile: int):
    import torch
    from realesrgan import RealESRGANer

    normalized_mode = mode.lower().strip()
    half = torch.cuda.is_available()
    gpu_id = 0 if torch.cuda.is_available() else None

    if normalized_mode == "anime":
        from realesrgan.archs.srvgg_arch import SRVGGNetCompact

        model_path = ANIME_MODEL_PATH
        model = SRVGGNetCompact(
            num_in_ch=3,
            num_out_ch=3,
            num_feat=64,
            num_conv=16,
            upscale=4,
            act_type="prelu",
        )
    else:
        from basicsr.archs.rrdbnet_arch import RRDBNet

        model_path = PHOTO_MODEL_PATH
        model = RRDBNet(
            num_in_ch=3,
            num_out_ch=3,
            num_feat=64,
            num_block=23,
            num_grow_ch=32,
            scale=4,
        )

    if not model_path.exists() or model_path.stat().st_size <= 0:
        raise RuntimeError(f"Real-ESRGAN model is missing: {model_path}")

    return RealESRGANer(
        scale=4,
        model_path=str(model_path),
        dni_weight=None,
        model=model,
        tile=tile,
        tile_pad=10,
        pre_pad=0,
        half=half,
        gpu_id=gpu_id,
    )


def enhance_with_realesrgan(input_image: np.ndarray, mode: str, scale: int, tile: int) -> np.ndarray:
    upsampler = build_upsampler(mode, scale, tile)
    output, _ = upsampler.enhance(input_image, outscale=scale)
    return output


def enhance_with_gfpgan(input_image: np.ndarray, mode: str, scale: int, tile: int) -> np.ndarray:
    from gfpgan import GFPGANer

    if not GFPGAN_MODEL_PATH.exists() or GFPGAN_MODEL_PATH.stat().st_size <= 0:
        raise RuntimeError(f"GFPGAN model is missing: {GFPGAN_MODEL_PATH}")

    bg_upsampler = build_upsampler(mode, scale, tile)
    face_enhancer = GFPGANer(
        model_path=str(GFPGAN_MODEL_PATH),
        upscale=scale,
        arch="clean",
        channel_multiplier=2,
        bg_upsampler=bg_upsampler,
    )
    _cropped_faces, _restored_faces, restored_image = face_enhancer.enhance(
        input_image,
        has_aligned=False,
        only_center_face=False,
        paste_back=True,
    )
    return restored_image


def main() -> None:
    input_path = Path(required_env("ENHANCER_INPUT_IMAGE"))
    output_path = Path(required_env("ENHANCER_OUTPUT_IMAGE"))
    mode = os.environ.get("ENHANCER_MODE", "photo").strip().lower()
    if mode not in {"photo", "anime"}:
        mode = "photo"
    scale = int_env("ENHANCER_SCALE", 4, 2, 4)
    if scale not in {2, 4}:
        scale = 4
    face_enhance = bool_env("ENHANCER_FACE_ENHANCE", False)
    output_format = os.environ.get("ENHANCER_OUTPUT_FORMAT", "png").strip().lower()
    tile = int_env("ENHANCER_TILE", 384, 0, 1024)

    print("enhancer request received", flush=True)
    print(f"selected mode={mode}", flush=True)
    print(f"selected scale={scale}", flush=True)
    print(f"face enhance={face_enhance}", flush=True)
    print(f"tile={tile}", flush=True)

    if not input_path.exists() or input_path.stat().st_size <= 0:
        raise RuntimeError(f"Input image is missing or empty: {input_path}")

    image = read_image(input_path)
    print(f"input image shape={image.shape}", flush=True)

    if face_enhance:
        print("loading Real-ESRGAN + GFPGAN", flush=True)
        enhanced = enhance_with_gfpgan(image, mode, scale, tile)
    else:
        print("loading Real-ESRGAN", flush=True)
        enhanced = enhance_with_realesrgan(image, mode, scale, tile)

    write_image(output_path, enhanced, output_format)
    if not output_path.exists() or output_path.stat().st_size <= 0:
        raise RuntimeError("Image enhancer did not write an output image")
    print(f"enhancement complete: {output_path} bytes={output_path.stat().st_size}", flush=True)


if __name__ == "__main__":
    main()
