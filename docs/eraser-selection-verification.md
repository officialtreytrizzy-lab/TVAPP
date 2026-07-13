# eTreyser exact-selection verification

A render is not successful merely because the MP4 is playable and moving. The selected frame and painted mask must also show meaningful pixel replacement.

The production worker now runs `sam2_propainter_verified.py`, which:

- verifies the painted selection on the exact selected frame;
- rejects outputs where the selected area remains effectively unchanged;
- retries with tracked OpenCV inpainting;
- expands tracked masks and retries again when the normal fallback misses selected edges;
- verifies the final muxed MP4 before reporting success.

The Platform Contracts workflow compiles all Python worker entrypoints so syntax failures cannot reach deployment.
