from __future__ import annotations

import asyncio
import ipaddress
import os
import socket
import tempfile
from pathlib import Path
from urllib.parse import urlparse

import httpx
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

SUPABASE_URL = os.environ.get(
    "TRIZZY_SUPABASE_URL",
    "https://sdibjsjokhadjzruehbu.supabase.co",
).rstrip("/")
SUPABASE_PUBLISHABLE_KEY = os.environ.get(
    "TRIZZY_SUPABASE_PUBLISHABLE_KEY",
    "sb_publishable_GZT1zi2PQt-8-0QM6sl5yA_1nCM867H",
)
ACE_URL = os.environ.get("TRIZZY_ACE_LOCAL_URL", "http://127.0.0.1:8001").rstrip("/")
REF_DIR = Path(os.environ.get("TRIZZY_REFERENCE_DIR", "/tmp/trizzy-audio-refs"))
REF_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Trizzy ACE Gateway", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


async def require_user(authorization: str | None) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Authentication required")

    async with httpx.AsyncClient(timeout=15.0) as client:
        response = await client.get(
            f"{SUPABASE_URL}/auth/v1/user",
            headers={
                "apikey": SUPABASE_PUBLISHABLE_KEY,
                "Authorization": authorization,
            },
        )
    if response.status_code != 200:
        raise HTTPException(status_code=401, detail="Invalid or expired session")
    return response.json()


def _public_https_url(url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname:
        raise HTTPException(status_code=400, detail="Reference audio must use HTTPS")

    try:
        addresses = {
            item[4][0]
            for item in socket.getaddrinfo(parsed.hostname, parsed.port or 443, type=socket.SOCK_STREAM)
        }
    except socket.gaierror as exc:
        raise HTTPException(status_code=400, detail="Reference-audio hostname could not be resolved") from exc

    for raw in addresses:
        ip = ipaddress.ip_address(raw)
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_multicast
            or ip.is_reserved
            or ip.is_unspecified
        ):
            raise HTTPException(status_code=400, detail="Reference-audio URL is not public")
    return url


async def download_reference(url: str) -> str:
    url = _public_https_url(url)
    suffix = Path(urlparse(url).path).suffix.lower()
    if suffix not in {".wav", ".mp3", ".flac", ".m4a", ".aac", ".ogg", ".opus"}:
        suffix = ".audio"

    fd, name = tempfile.mkstemp(prefix="trizzy-ref-", suffix=suffix, dir=REF_DIR)
    os.close(fd)
    target = Path(name)

    try:
        async with httpx.AsyncClient(timeout=120.0, follow_redirects=True) as client:
            async with client.stream("GET", url) as response:
                response.raise_for_status()
                total = 0
                with target.open("wb") as handle:
                    async for chunk in response.aiter_bytes(1024 * 1024):
                        total += len(chunk)
                        if total > 300 * 1024 * 1024:
                            raise HTTPException(status_code=413, detail="Reference audio exceeds 300 MB")
                        handle.write(chunk)
        if target.stat().st_size == 0:
            raise HTTPException(status_code=400, detail="Reference audio is empty")
        return str(target)
    except Exception:
        target.unlink(missing_ok=True)
        raise


async def proxy_json(path: str, body: dict, authorization: str | None) -> dict:
    await require_user(authorization)
    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(f"{ACE_URL}{path}", json=body)
    try:
        data = response.json()
    except Exception as exc:
        raise HTTPException(status_code=502, detail="ACE-Step returned a non-JSON response") from exc
    if response.status_code >= 400:
        raise HTTPException(status_code=response.status_code, detail=data)
    return data


@app.get("/health")
async def health():
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.get(f"{ACE_URL}/health")
        backend = "ready" if response.status_code == 200 else f"http_{response.status_code}"
    except Exception:
        backend = "starting"
    return {"status": "ok", "gateway": "ready", "ace_backend": backend}


@app.post("/release_task")
async def release_task(
    request: Request,
    authorization: str | None = Header(default=None),
):
    await require_user(authorization)
    body = await request.json()
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="JSON object required")

    reference_url = body.pop("reference_audio_url", None)
    src_url = body.pop("src_audio_url", None)
    task_type = str(body.get("task_type") or "text2music")

    downloaded: list[str] = []
    try:
        if src_url:
            local = await download_reference(str(src_url))
            downloaded.append(local)
            body["src_audio_path"] = local
        elif reference_url and task_type in {"cover", "repaint", "lego", "extract", "complete"}:
            local = await download_reference(str(reference_url))
            downloaded.append(local)
            body["src_audio_path"] = local
        elif reference_url:
            local = await download_reference(str(reference_url))
            downloaded.append(local)
            body["reference_audio_path"] = local

        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(f"{ACE_URL}/release_task", json=body)
        data = response.json()
        if response.status_code >= 400:
            raise HTTPException(status_code=response.status_code, detail=data)
        return data
    finally:
        # ACE-Step copies/loads uploaded audio during task submission. Delay cleanup
        # slightly so its in-process queue can open the path even under load.
        if downloaded:
            async def cleanup(paths: list[str]):
                await asyncio.sleep(30)
                for path in paths:
                    Path(path).unlink(missing_ok=True)
            asyncio.create_task(cleanup(downloaded))


@app.post("/query_result")
async def query_result(
    request: Request,
    authorization: str | None = Header(default=None),
):
    body = await request.json()
    return await proxy_json("/query_result", body, authorization)


@app.post("/format_input")
async def format_input(
    request: Request,
    authorization: str | None = Header(default=None),
):
    body = await request.json()
    return await proxy_json("/format_input", body, authorization)


@app.get("/v1/models")
async def models(authorization: str | None = Header(default=None)):
    await require_user(authorization)
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.get(f"{ACE_URL}/v1/models")
    return Response(
        content=response.content,
        status_code=response.status_code,
        media_type=response.headers.get("content-type", "application/json"),
    )


@app.get("/v1/audio")
async def audio(
    path: str,
    authorization: str | None = Header(default=None),
):
    await require_user(authorization)
    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.get(f"{ACE_URL}/v1/audio", params={"path": path})
    return Response(
        content=response.content,
        status_code=response.status_code,
        media_type=response.headers.get("content-type", "application/octet-stream"),
        headers={
            "Content-Disposition": response.headers.get(
                "content-disposition",
                'attachment; filename="trizzy-render.wav"',
            )
        },
    )
