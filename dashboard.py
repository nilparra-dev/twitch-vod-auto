import os
import asyncio
import json
import pickle
import secrets
import logging
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from fastapi import FastAPI, Request, Depends, HTTPException, Form, Query
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from google_auth_oauthlib.flow import Flow
from starlette.middleware.sessions import SessionMiddleware

from db import PipelineDB
from utils import parse_twitch_vod_url
from progress import DownloadProgress
from youtube_uploader import SCOPES

# =============================================================================
# Config & globals
# =============================================================================

CONFIG_PATH = os.getenv("CONFIG_PATH", "config.json")
config = {}
if os.path.exists(CONFIG_PATH):
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        config = json.load(f)

DB_PATH = config.get("monitoring", {}).get("db_path", "data/pipeline.db")
LOG_PATH = config.get("app", {}).get("log_file", "logs/pipeline.log")

# Auth: lee de env vars; si no hay password, genera una aleatoria y la loguea
ADMIN_USER = os.getenv("ADMIN_USER", "admin")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD")
SECRET_KEY = os.getenv("SECRET_KEY")
COOKIE_SECURE = os.getenv("COOKIE_SECURE", "false").lower() in ("1", "true", "yes")
ALLOW_RANDOM_ADMIN_PASSWORD = os.getenv("ALLOW_RANDOM_ADMIN_PASSWORD", "false").lower() in ("1", "true", "yes")
_login_attempts = {}

if not SECRET_KEY:
    SECRET_KEY = secrets.token_urlsafe(32)
    logging.warning("[Auth] SECRET_KEY no definido, usando aleatorio (sesiones se invalidan al reiniciar)")

if not ADMIN_PASSWORD:
    if not ALLOW_RANDOM_ADMIN_PASSWORD:
        raise RuntimeError("ADMIN_PASSWORD no definido. Define ADMIN_PASSWORD en .env.")
    ADMIN_PASSWORD = secrets.token_urlsafe(24)
    logging.warning("[Auth] ADMIN_PASSWORD no definido. Usuario: %s Password temporal: %s", ADMIN_USER, ADMIN_PASSWORD)

logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)-7s | %(name)-12s | %(message)s")
log = logging.getLogger("dashboard")

app = FastAPI(title="Twitch VOD Auto - Admin", docs_url=None, redoc_url=None)
app.add_middleware(
    SessionMiddleware,
    secret_key=SECRET_KEY,
    max_age=86400 * 7,
    same_site="lax",
    https_only=COOKIE_SECURE,
)


@app.middleware("http")
async def security_middleware(request: Request, call_next):
    if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
        host = request.headers.get("host", "").split(":", 1)[0]
        origin = request.headers.get("origin")
        referer = request.headers.get("referer")
        origin_host = urlparse(origin).hostname if origin else None
        referer_host = urlparse(referer).hostname if referer else None
        if origin_host and origin_host != host:
            return JSONResponse(status_code=403, content={"detail": "Origen no permitido"})
        if not origin_host and referer_host and referer_host != host:
            return JSONResponse(status_code=403, content={"detail": "Origen no permitido"})

    response = await call_next(request)
    response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault(
        "Content-Security-Policy",
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline'; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "font-src 'self' https://fonts.gstatic.com; "
        "img-src 'self' data:; "
        "connect-src 'self'; "
        "base-uri 'self'; frame-ancestors 'self'; form-action 'self'",
    )
    if COOKIE_SECURE:
        response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
    return response


def get_db():
    return PipelineDB(DB_PATH)


def get_conn():
    return sqlite3.connect(DB_PATH)


def _youtube_cfg():
    return config.get("youtube", {})


def _youtube_client_secret_file() -> str:
    return _youtube_cfg().get("client_secrets_file", "client_secret.json")


def _youtube_credentials_file() -> str:
    return _youtube_cfg().get("credentials_file", "youtube_credentials.pkl")


def _client_secret_type(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if "web" in data:
            return "web"
        if "installed" in data:
            return "installed"
    except Exception:
        return "invalid"
    return "unknown"


def _youtube_redirect_uri(request: Request) -> str:
    explicit = os.getenv("YOUTUBE_OAUTH_REDIRECT_URI", "").strip()
    if explicit:
        return explicit.rstrip("/")

    public_url = os.getenv("DASHBOARD_PUBLIC_URL", "").strip().rstrip("/")
    if public_url:
        return f"{public_url}/api/youtube/oauth/callback"

    proto = request.headers.get("x-forwarded-proto") or request.url.scheme
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.netloc
    return f"{proto}://{host}/api/youtube/oauth/callback"


def _youtube_installed_redirect_uri() -> str:
    return os.getenv("YOUTUBE_OAUTH_LOCAL_REDIRECT_URI", "http://localhost:53682/").strip()


def _youtube_credentials_status(path: str) -> dict:
    status = {
        "exists": os.path.isfile(path),
        "valid": False,
        "expired": None,
        "has_refresh_token": False,
        "expiry": None,
        "updated_at": None,
        "error": None,
    }
    if not status["exists"]:
        return status

    try:
        mtime = os.path.getmtime(path)
        status["updated_at"] = datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat()
        with open(path, "rb") as token:
            credentials = pickle.load(token)
        status["valid"] = bool(getattr(credentials, "valid", False))
        status["expired"] = bool(getattr(credentials, "expired", False))
        status["has_refresh_token"] = bool(getattr(credentials, "refresh_token", None))
        expiry = getattr(credentials, "expiry", None)
        if expiry:
            if expiry.tzinfo is None:
                expiry = expiry.replace(tzinfo=timezone.utc)
            status["expiry"] = expiry.astimezone(timezone.utc).isoformat()
    except Exception as e:
        status["error"] = str(e)

    return status


def _extract_oauth_code(value: str) -> str:
    value = (value or "").strip()
    if not value:
        return ""
    if "://" not in value and "&" not in value and "code=" not in value:
        return value

    parsed = urlparse(value)
    query = parsed.query or value
    params = parse_qs(query)
    return (params.get("code") or [""])[0]


def _write_youtube_credentials(credentials, path: str):
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    if os.path.isdir(path):
        raise RuntimeError(f"{path} es un directorio; revisa el bind mount de Docker")

    with open(path, "wb") as token:
        pickle.dump(credentials, token)
        token.flush()
        os.fsync(token.fileno())
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def require_auth(request: Request):
    user = request.session.get("user")
    if not user:
        raise HTTPException(401, "No autenticado")
    return user


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",", 1)[0].strip()
    return request.client.host if request.client else "unknown"


def _check_login_rate_limit(request: Request):
    ip = _client_ip(request)
    now = time.time()
    window = 300
    max_attempts = 8
    attempts = [ts for ts in _login_attempts.get(ip, []) if now - ts < window]
    if len(attempts) >= max_attempts:
        _login_attempts[ip] = attempts
        raise HTTPException(429, "Demasiados intentos. Espera unos minutos.")
    attempts.append(now)
    _login_attempts[ip] = attempts


def _clear_login_attempts(request: Request):
    _login_attempts.pop(_client_ip(request), None)


# =============================================================================
# Auth endpoints
# =============================================================================

@app.get("/login", response_class=HTMLResponse)
def login_page(request: Request):
    if request.session.get("user"):
        return RedirectResponse("/", status_code=302)
    return HTMLResponse(LOGIN_HTML)


@app.post("/api/login")
def api_login(request: Request, user: str = Form(...), password: str = Form(...)):
    _check_login_rate_limit(request)
    if secrets.compare_digest(user, ADMIN_USER) and secrets.compare_digest(password, ADMIN_PASSWORD):
        _clear_login_attempts(request)
        request.session.clear()
        request.session["user"] = user
        return {"status": "ok", "user": user}
    raise HTTPException(401, "Credenciales invalidas")


@app.post("/api/logout")
def api_logout(request: Request, _: str = Depends(require_auth)):
    request.session.clear()
    return {"status": "ok"}


@app.get("/api/me")
def api_me(request: Request, user: str = Depends(require_auth)):
    return {"user": user, "admin_user": ADMIN_USER}


# =============================================================================
# API endpoints (protegidos)
# =============================================================================

@app.get("/api/stats")
def api_stats(_: str = Depends(require_auth)):
    db = get_db()
    return {
        "summary": db.get_summary_counts(),
        "queue": db.get_queue_summary(),
        "channels": db.get_channels(),
        "stats": db.get_stats(),
        "vods": db.get_vods(limit=10),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/api/vods")
def api_vods(status: str = None, channel: str = None, search: str = None,
             limit: int = 25, offset: int = 0, _: str = Depends(require_auth)):
    db = get_db()
    limit = max(1, min(int(limit), 100))
    offset = max(0, int(offset))
    vods = db.get_vods(status=status, channel=channel, search=search, limit=limit, offset=offset)
    total = db.count_vods(status=status, channel=channel, search=search)
    return {"vods": vods, "total": total, "limit": limit, "offset": offset}


@app.get("/api/vods/{vod_id}")
def api_vod_detail(vod_id: str, _: str = Depends(require_auth)):
    db = get_db()
    vod = db.get_vod(vod_id)
    if not vod:
        raise HTTPException(404, "VOD no encontrado")
    return vod


@app.post("/api/vods/{vod_id}/retry")
def api_vod_retry(vod_id: str, _: str = Depends(require_auth)):
    db = get_db()
    vod = db.get_vod(vod_id)
    if not vod:
        raise HTTPException(404, "VOD no encontrado")
    db.reset_vod(vod_id)
    db.enqueue({
        "vod_id": vod_id,
        "channel": vod["channel"],
        "video_id": vod["video_id"],
        "source": vod.get("source", "manual"),
        "start_time": 0,
        "tracker_url": vod.get("tracker_url"),
        "download_url": vod.get("download_url"),
    }, force=True)
    return {"status": "ok", "message": "VOD reencolado"}


@app.delete("/api/vods/{vod_id}")
def api_vod_delete(vod_id: str, _: str = Depends(require_auth)):
    db = get_db()
    db.delete_vod(vod_id)
    return {"status": "ok"}


@app.get("/api/queue")
def api_queue(_: str = Depends(require_auth)):
    return {"queue": _queue_rows(limit=100)}


@app.delete("/api/queue/{vod_id}")
def api_queue_delete(vod_id: str, _: str = Depends(require_auth)):
    db = get_db()
    db.delete_from_queue(vod_id)
    return {"status": "ok"}


@app.get("/api/activity")
def api_activity(days: int = 7, _: str = Depends(require_auth)):
    db = get_db()
    days = max(1, min(int(days), 90))
    return {"activity": db.get_daily_activity(days=days)}


@app.get("/api/progress")
def api_progress(_: str = Depends(require_auth)):
    DownloadProgress.cleanup_old(max_age_seconds=3600)
    progress_data = DownloadProgress.get_all()
    active = {}
    for vod_id, info in progress_data.items():
        if info.get("status") in ("downloading", "encoding", "uploading"):
            active[vod_id] = info
    return {"active_downloads": active, "count": len(active)}


def _queue_rows(limit: int = 100):
    db = get_db()
    with db._connect() as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT * FROM download_queue ORDER BY created_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [dict(r) for r in rows]


def _active_progress():
    DownloadProgress.cleanup_old(max_age_seconds=3600)
    progress_data = DownloadProgress.get_all()
    return {
        vod_id: info
        for vod_id, info in progress_data.items()
        if info.get("status") in ("downloading", "encoding", "uploading")
    }


def _dashboard_state():
    db = get_db()
    return {
        "summary": db.get_summary_counts(),
        "queue_summary": db.get_queue_summary(),
        "channels": db.get_channels(),
        "stats": db.get_stats(),
        "recent_vods": db.get_vods(limit=10),
        "activity": db.get_daily_activity(days=7),
        "active_downloads": _active_progress(),
        "queue": _queue_rows(limit=100),
    }


@app.get("/api/events")
async def api_events(request: Request, _: str = Depends(require_auth)):
    async def event_stream():
        last_payload = None
        last_keepalive = time.monotonic()
        while True:
            if await request.is_disconnected():
                break
            try:
                state = _dashboard_state()
                payload = json.dumps(state, ensure_ascii=False, sort_keys=True, default=str)
                if payload != last_payload:
                    last_payload = payload
                    last_keepalive = time.monotonic()
                    yield f"event: state\ndata: {payload}\n\n"
                elif time.monotonic() - last_keepalive > 15:
                    last_keepalive = time.monotonic()
                    yield ": keepalive\n\n"
            except Exception as e:
                err = json.dumps({"error": str(e)}, ensure_ascii=False)
                yield f"event: error\ndata: {err}\n\n"
            await asyncio.sleep(1)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/api/progress/{vod_id}")
def api_progress_vod(vod_id: str, _: str = Depends(require_auth)):
    progress = DownloadProgress.get(vod_id)
    if not progress:
        raise HTTPException(404, "No hay progreso")
    return progress


@app.get("/api/health")
def api_health(_: str = Depends(require_auth)):
    db_ok = os.path.exists(DB_PATH)
    log_exists = os.path.exists(LOG_PATH)
    log_size = os.path.getsize(LOG_PATH) if log_exists else 0
    return {
        "status": "ok" if db_ok else "db_missing",
        "db_path": DB_PATH,
        "log_path": LOG_PATH,
        "log_size_bytes": log_size,
        "uptime": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/api/youtube/oauth/status")
def api_youtube_oauth_status(request: Request, _: str = Depends(require_auth)):
    client_secret_file = _youtube_client_secret_file()
    credentials_file = _youtube_credentials_file()
    client_secret_exists = os.path.isfile(client_secret_file)
    client_type = _client_secret_type(client_secret_file) if client_secret_exists else "missing"
    redirect_uri = _youtube_redirect_uri(request)
    return {
        "client_secret_exists": client_secret_exists,
        "client_secret_type": client_type,
        "credentials": _youtube_credentials_status(credentials_file),
        "redirect_uri": redirect_uri,
        "installed_redirect_uri": _youtube_installed_redirect_uri(),
        "mode": "web" if client_type == "web" else ("installed" if client_type == "installed" else "unsupported"),
        "ready": client_secret_exists and client_type in {"web", "installed"},
    }


@app.post("/api/youtube/oauth/start")
def api_youtube_oauth_start(request: Request, _: str = Depends(require_auth)):
    client_secret_file = _youtube_client_secret_file()
    if not os.path.isfile(client_secret_file):
        raise HTTPException(400, "Falta client_secret.json en el servidor")

    client_type = _client_secret_type(client_secret_file)
    if client_type == "web":
        redirect_uri = _youtube_redirect_uri(request)
        mode = "web"
    elif client_type == "installed":
        redirect_uri = _youtube_installed_redirect_uri()
        mode = "installed"
    else:
        raise HTTPException(400, "client_secret.json no es OAuth Web application ni Desktop app")

    flow = Flow.from_client_secrets_file(
        client_secret_file,
        scopes=SCOPES,
        redirect_uri=redirect_uri,
    )
    authorization_url, state = flow.authorization_url(
        access_type="offline",
        include_granted_scopes="true",
        prompt="consent",
    )
    request.session["youtube_oauth_state"] = state
    request.session["youtube_oauth_redirect_uri"] = redirect_uri
    request.session["youtube_oauth_mode"] = mode
    request.session["youtube_oauth_code_verifier"] = flow.code_verifier
    request.session["youtube_oauth_started_at"] = int(time.time())
    return {"authorization_url": authorization_url, "redirect_uri": redirect_uri, "mode": mode}


@app.post("/api/youtube/oauth/complete")
def api_youtube_oauth_complete(request: Request, payload: dict, _: str = Depends(require_auth)):
    expected_state = request.session.get("youtube_oauth_state")
    redirect_uri = request.session.get("youtube_oauth_redirect_uri")
    mode = request.session.get("youtube_oauth_mode")
    code_verifier = request.session.get("youtube_oauth_code_verifier")
    started_at = int(request.session.get("youtube_oauth_started_at") or 0)

    if mode != "installed" or not expected_state or not redirect_uri:
        raise HTTPException(400, "No hay una renovacion OAuth Desktop pendiente")
    if not code_verifier:
        raise HTTPException(400, "Falta code_verifier; inicia otra renovacion OAuth")
    if time.time() - started_at > 15 * 60:
        for key in ("youtube_oauth_state", "youtube_oauth_redirect_uri", "youtube_oauth_mode", "youtube_oauth_code_verifier", "youtube_oauth_started_at"):
            request.session.pop(key, None)
        raise HTTPException(400, "La renovacion OAuth ha caducado; inicia otra")

    callback_url = str(payload.get("callback_url") or "")
    code = _extract_oauth_code(callback_url or str(payload.get("code") or ""))
    pasted_state = (parse_qs(urlparse(callback_url).query).get("state") or [""])[0] if callback_url else ""
    if pasted_state and not secrets.compare_digest(pasted_state, expected_state):
        raise HTTPException(400, "El state de OAuth no coincide; inicia otra renovacion")
    if not code:
        raise HTTPException(400, "No se encontro el parametro code en el texto pegado")

    try:
        flow = Flow.from_client_secrets_file(
            _youtube_client_secret_file(),
            scopes=SCOPES,
            state=expected_state,
            redirect_uri=redirect_uri,
            code_verifier=code_verifier,
        )
        flow.fetch_token(code=code)
        credentials = flow.credentials
        if not getattr(credentials, "refresh_token", None):
            raise RuntimeError("Google no devolvio refresh_token")
        _write_youtube_credentials(credentials, _youtube_credentials_file())
        log.info("[YouTubeOAuth] Token de YouTube renovado desde dashboard con flujo Desktop")
        return {"status": "ok"}
    except Exception as e:
        log.error("[YouTubeOAuth] Error completando OAuth Desktop: %s", e)
        raise HTTPException(400, f"No se pudo completar OAuth: {e}")
    finally:
        for key in ("youtube_oauth_state", "youtube_oauth_redirect_uri", "youtube_oauth_mode", "youtube_oauth_code_verifier", "youtube_oauth_started_at"):
            request.session.pop(key, None)


@app.get("/api/youtube/oauth/callback", name="youtube_oauth_callback")
def youtube_oauth_callback(request: Request, state: str = None, code: str = None, error: str = None):
    if not request.session.get("user"):
        return RedirectResponse("/login?next=/", status_code=302)

    def done(result: str):
        return RedirectResponse(f"/?youtube_oauth={result}", status_code=302)

    expected_state = request.session.get("youtube_oauth_state")
    redirect_uri = request.session.get("youtube_oauth_redirect_uri")
    code_verifier = request.session.get("youtube_oauth_code_verifier")
    started_at = int(request.session.get("youtube_oauth_started_at") or 0)
    for key in ("youtube_oauth_state", "youtube_oauth_redirect_uri", "youtube_oauth_mode", "youtube_oauth_code_verifier", "youtube_oauth_started_at"):
        request.session.pop(key, None)

    if error:
        log.warning("[YouTubeOAuth] Google devolvio error: %s", error)
        return done("error")
    if not code or not state or not expected_state or not redirect_uri or not code_verifier:
        log.warning("[YouTubeOAuth] Callback incompleto")
        return done("error")
    if not secrets.compare_digest(state, expected_state):
        log.warning("[YouTubeOAuth] State invalido")
        return done("error")
    if time.time() - started_at > 15 * 60:
        log.warning("[YouTubeOAuth] State caducado")
        return done("error")

    try:
        flow = Flow.from_client_secrets_file(
            _youtube_client_secret_file(),
            scopes=SCOPES,
            state=state,
            redirect_uri=redirect_uri,
            code_verifier=code_verifier,
        )
        query = request.url.query
        authorization_response = f"{redirect_uri}?{query}" if query else redirect_uri
        flow.fetch_token(authorization_response=authorization_response)
        credentials = flow.credentials
        if not getattr(credentials, "refresh_token", None):
            log.warning("[YouTubeOAuth] Google no devolvio refresh_token")
            return done("error")
        _write_youtube_credentials(credentials, _youtube_credentials_file())
        log.info("[YouTubeOAuth] Token de YouTube renovado desde dashboard")
        return done("success")
    except Exception as e:
        log.error("[YouTubeOAuth] Error renovando token: %s", e)
        return done("error")


@app.get("/healthz")
def healthz():
    return {"status": "ok", "timestamp": datetime.now(timezone.utc).isoformat()}


@app.get("/api/logs")
def api_logs(lines: int = 100, _: str = Depends(require_auth)):
    lines = max(1, min(int(lines), 1000))
    if not os.path.exists(LOG_PATH):
        return {"logs": []}
    try:
        with open(LOG_PATH, "r", encoding="utf-8", errors="ignore") as f:
            all_lines = f.readlines()
        tail = all_lines[-lines:] if len(all_lines) > lines else all_lines
        return {"logs": [l.rstrip("\n") for l in tail]}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/api/manual_upload")
def api_manual_upload(payload: dict, _: str = Depends(require_auth)):
    def payload_str(key: str, default: str = "", max_len: int = 500) -> str:
        value = payload.get(key, default)
        if value is None:
            return ""
        if not isinstance(value, str):
            value = str(value)
        return value.strip()[:max_len]

    url_or_id = payload_str("url_or_id", max_len=1000)
    custom_channel = payload_str("channel", max_len=80)
    custom_title = payload_str("title", max_len=100)
    privacy = payload_str("privacy", default="private", max_len=20)
    tags = payload.get("tags", [])

    if not url_or_id:
        return JSONResponse(status_code=400, content={"error": "url_or_id requerido"})

    parsed = parse_twitch_vod_url(url_or_id)
    if not parsed or not parsed.get("video_id"):
        return JSONResponse(status_code=400, content={"error": "No se pudo parsear la URL/VOD ID"})

    db = get_db()
    vod_id = parsed["vod_id"]
    channel = (custom_channel or parsed.get("channel") or "manual").lower()
    video_id = parsed["video_id"]
    start_time = parsed.get("start_time", 0)
    tracker_url = parsed.get("tracker_url")
    download_url = parsed.get("download_url")
    if privacy not in {"private", "unlisted", "public"}:
        return JSONResponse(status_code=400, content={"error": "privacy invalida"})
    if not isinstance(tags, list):
        tags = []
    tags = [str(tag).strip()[:50] for tag in tags if str(tag).strip()][:20]

    if db.is_processed(vod_id):
        return JSONResponse(status_code=409, content={"error": "Este VOD ya fue procesado", "vod_id": vod_id})

    source_meta = json.dumps({
        "type": "manual_upload",
        "custom_title": custom_title,
        "privacy": privacy,
        "tags": tags,
    })

    db.add_vod(vod_id, channel, video_id, source_meta, tracker_url=tracker_url, download_url=download_url)
    db.increment_stat(channel, "detected")
    db.enqueue({
        "vod_id": vod_id,
        "channel": channel,
        "video_id": video_id,
        "source": source_meta,
        "start_time": start_time,
        "tracker_url": tracker_url,
        "download_url": download_url,
    })

    return {"status": "queued", "vod_id": vod_id, "channel": channel, "video_id": video_id}


# =============================================================================
# Pages
# =============================================================================

@app.get("/", response_class=HTMLResponse)
def dashboard_page(request: Request):
    if not request.session.get("user"):
        return RedirectResponse("/login", status_code=302)
    return HTMLResponse(MAIN_HTML)


# =============================================================================
# HTML: Login page
# =============================================================================

LOGIN_HTML = """<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Login - Twitch VOD Auto</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#0a0b10;
  --surface:#12141d;
  --surface-2:#1a1d28;
  --border:#262a39;
  --text:#e4e6ef;
  --text-dim:#8b8fa3;
  --text-muted:#5b5f73;
  --accent:#9146ff;
  --accent-2:#772ce8;
  --accent-glow:rgba(145,70,255,0.4);
  --error:#e74c3c;
  --success:#2ecc71;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{
  font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  background:var(--bg);
  color:var(--text);
  display:flex;align-items:center;justify-content:center;
  background-image:
    radial-gradient(at 20% 20%,rgba(145,70,255,0.15) 0,transparent 50%),
    radial-gradient(at 80% 80%,rgba(86,90,200,0.12) 0,transparent 50%);
  background-attachment:fixed;
}
.login-card{
  width:380px;max-width:calc(100vw - 32px);
  background:rgba(18,20,29,0.8);
  backdrop-filter:blur(20px);
  -webkit-backdrop-filter:blur(20px);
  border:1px solid var(--border);
  border-radius:16px;
  padding:40px 32px;
  box-shadow:0 25px 50px -12px rgba(0,0,0,0.5);
  animation:slideUp .4s cubic-bezier(.16,1,.3,1);
}
@keyframes slideUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
.logo{
  display:flex;align-items:center;justify-content:center;gap:10px;
  font-size:20px;font-weight:700;margin-bottom:6px;
}
.logo-icon{width:32px;height:32px;background:linear-gradient(135deg,var(--accent),var(--accent-2));border-radius:8px;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;box-shadow:0 8px 20px var(--accent-glow)}
.subtitle{text-align:center;color:var(--text-dim);font-size:13px;margin-bottom:28px}
.form-group{margin-bottom:14px}
label{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--text-dim);margin-bottom:6px;font-weight:600}
.input{
  width:100%;background:var(--bg);border:1px solid var(--border);
  color:var(--text);padding:11px 14px;border-radius:8px;
  font-size:14px;font-family:inherit;transition:.15s;
}
.input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-glow)}
.btn{
  width:100%;background:linear-gradient(135deg,var(--accent),var(--accent-2));
  color:#fff;border:none;padding:12px;border-radius:8px;
  font-size:14px;font-weight:600;cursor:pointer;margin-top:8px;
  transition:.15s;font-family:inherit;
}
.btn:hover{transform:translateY(-1px);box-shadow:0 10px 20px var(--accent-glow)}
.btn:active{transform:translateY(0)}
.btn:disabled{opacity:.6;cursor:not-allowed;transform:none}
.error-msg{
  background:rgba(231,76,60,.1);border:1px solid rgba(231,76,60,.3);
  color:#ff6b5b;padding:10px 12px;border-radius:8px;
  font-size:13px;margin-bottom:14px;display:none;
}
.error-msg.show{display:block;animation:shake .3s}
@keyframes shake{0%,100%{transform:translateX(0)}25%,75%{transform:translateX(-4px)}50%{transform:translateX(4px)}}
.footer{text-align:center;margin-top:20px;font-size:11px;color:var(--text-muted)}
.spinner{display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin .8s linear infinite;vertical-align:middle}
@keyframes spin{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<div class="login-card">
  <div class="logo"><div class="logo-icon">T</div>Twitch VOD Auto</div>
  <div class="subtitle">Panel de administracion interno</div>
  <div id="error" class="error-msg"></div>
  <form id="loginForm">
    <div class="form-group">
      <label>Usuario</label>
      <input type="text" name="user" class="input" autocomplete="username" required autofocus>
    </div>
    <div class="form-group">
      <label>Contrasena</label>
      <input type="password" name="password" class="input" autocomplete="current-password" required>
    </div>
    <button type="submit" class="btn" id="submitBtn">Entrar</button>
  </form>
  <div class="footer">Acceso restringido &middot; v2.0</div>
</div>
<script>
const form=document.getElementById('loginForm');
const err=document.getElementById('error');
const btn=document.getElementById('submitBtn');
form.addEventListener('submit',async e=>{
  e.preventDefault();
  err.classList.remove('show');
  btn.disabled=true;
  btn.innerHTML='<span class="spinner"></span> Verificando...';
  const fd=new FormData(form);
  try{
    const r=await fetch('/api/login',{method:'POST',body:fd});
    if(r.ok){window.location='/';return}
    const d=await r.json().catch(()=>({detail:'Error'}));
    err.textContent=d.detail||'Credenciales invalidas';
    err.classList.add('show');
  }catch(e){
    err.textContent='Error de conexion';
    err.classList.add('show');
  }finally{
    btn.disabled=false;
    btn.textContent='Entrar';
  }
});
</script>
</body>
</html>"""


# =============================================================================
# HTML: Main dashboard
# =============================================================================

MAIN_HTML = """<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Twitch VOD Auto - Admin</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#0a0b10;
  --surface:#0f1117;
  --surface-2:#161924;
  --surface-3:#1d2030;
  --border:#262a39;
  --border-soft:#1d2030;
  --text:#e4e6ef;
  --text-dim:#8b8fa3;
  --text-muted:#5b5f73;
  --accent:#9146ff;
  --accent-2:#772ce8;
  --accent-glow:rgba(145,70,255,0.35);
  --green:#2ecc71;
  --red:#e74c3c;
  --blue:#3498db;
  --orange:#f39c12;
  --yellow:#f1c40f;
  --shadow-sm:0 1px 2px rgba(0,0,0,.2);
  --shadow:0 4px 12px rgba(0,0,0,.25);
  --shadow-lg:0 12px 32px rgba(0,0,0,.4);
  --radius:10px;
  --radius-sm:6px;
  --radius-lg:14px;
  --transition:all .15s cubic-bezier(.4,0,.2,1);
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{
  font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  background:var(--bg);
  color:var(--text);
  font-size:14px;
  line-height:1.5;
  -webkit-font-smoothing:antialiased;
  background-image:
    radial-gradient(at 0% 0%,rgba(145,70,255,0.06) 0,transparent 50%),
    radial-gradient(at 100% 100%,rgba(86,90,200,0.04) 0,transparent 50%);
  background-attachment:fixed;
}
a{color:inherit;text-decoration:none}
button{font-family:inherit;cursor:pointer;border:none;background:none;color:inherit}
input,select,textarea{font-family:inherit}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:5px}
::-webkit-scrollbar-thumb:hover{background:var(--text-muted)}

/* ===== Layout ===== */
.layout{display:flex;min-height:100vh}
.sidebar{
  width:240px;background:var(--surface);border-right:1px solid var(--border-soft);
  display:flex;flex-direction:column;position:fixed;height:100vh;
  z-index:10;
}
.sidebar-header{
  padding:18px 20px;border-bottom:1px solid var(--border-soft);
  display:flex;align-items:center;gap:10px;
}
.brand-icon{width:30px;height:30px;background:linear-gradient(135deg,var(--accent),var(--accent-2));border-radius:7px;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:14px;box-shadow:0 4px 12px var(--accent-glow)}
.brand-text{font-weight:700;font-size:15px;letter-spacing:-.3px}
.sidebar-nav{flex:1;padding:14px 12px;overflow-y:auto}
.nav-section{margin-bottom:18px}
.nav-section-title{font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);padding:0 10px;margin-bottom:6px;font-weight:600}
.nav-item{
  display:flex;align-items:center;gap:10px;padding:9px 12px;
  color:var(--text-dim);border-radius:8px;font-size:13.5px;
  font-weight:500;margin-bottom:2px;cursor:pointer;transition:var(--transition);
  position:relative;
}
.nav-item:hover{background:var(--surface-2);color:var(--text)}
.nav-item.active{background:linear-gradient(90deg,rgba(145,70,255,.15),rgba(145,70,255,.05));color:var(--text);box-shadow:inset 2px 0 0 var(--accent)}
.nav-item svg{width:17px;height:17px;flex-shrink:0;opacity:.8}
.nav-item.active svg{opacity:1;color:var(--accent)}
.nav-badge{margin-left:auto;background:var(--accent);color:#fff;font-size:10px;font-weight:700;padding:2px 6px;border-radius:10px;min-width:18px;text-align:center}
.sidebar-footer{padding:14px 16px;border-top:1px solid var(--border-soft);font-size:11px;color:var(--text-muted)}

/* Main */
.main{flex:1;margin-left:240px;min-height:100vh;display:flex;flex-direction:column}
.topbar{
  height:60px;background:rgba(15,17,23,.7);backdrop-filter:blur(12px);
  -webkit-backdrop-filter:blur(12px);
  border-bottom:1px solid var(--border-soft);
  display:flex;align-items:center;justify-content:space-between;
  padding:0 28px;position:sticky;top:0;z-index:5;
}
.topbar h1{font-size:16px;font-weight:600;letter-spacing:-.2px}
.topbar-actions{display:flex;align-items:center;gap:10px}
.stream-pill{
  display:flex;align-items:center;gap:7px;background:var(--surface-2);
  border:1px solid var(--border-soft);color:var(--text-dim);
  border-radius:999px;padding:6px 10px;font-size:12px;font-weight:500;
}
.stream-pill .status-dot{margin-right:0}
.user-menu{
  display:flex;align-items:center;gap:8px;padding:5px 10px 5px 5px;
  background:var(--surface-2);border:1px solid var(--border);
  border-radius:20px;cursor:pointer;transition:var(--transition);
}
.user-menu:hover{border-color:var(--accent)}
.user-avatar{width:28px;height:28px;background:linear-gradient(135deg,#3498db,#9b59b6);border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px}
.user-name{font-size:13px;font-weight:500}
.content{flex:1;padding:28px;max-width:100%;overflow-x:hidden}

/* ===== Cards / KPI ===== */
.kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin-bottom:24px}
.kpi-card{
  background:var(--surface);border:1px solid var(--border-soft);
  border-radius:var(--radius);padding:18px 20px;
  position:relative;overflow:hidden;transition:var(--transition);
}
.kpi-card:hover{border-color:var(--border);transform:translateY(-1px);box-shadow:var(--shadow)}
.kpi-card::before{content:"";position:absolute;top:0;left:0;width:3px;height:100%;background:var(--accent)}
.kpi-card.green::before{background:var(--green)}
.kpi-card.red::before{background:var(--red)}
.kpi-card.blue::before{background:var(--blue)}
.kpi-card.orange::before{background:var(--orange)}
.kpi-label{font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.6px;font-weight:600;margin-bottom:6px;display:flex;align-items:center;gap:5px}
.kpi-value{font-size:28px;font-weight:700;letter-spacing:-1px;font-feature-settings:"tnum"}
.kpi-sub{font-size:11px;color:var(--text-muted);margin-top:3px}

/* ===== Card ===== */
.card{
  background:var(--surface);border:1px solid var(--border-soft);
  border-radius:var(--radius-lg);padding:20px 22px;margin-bottom:18px;
  transition:var(--transition);
}
.card-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;gap:10px;flex-wrap:wrap}
.card-title{font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.4px;color:var(--text-dim);display:flex;align-items:center;gap:6px}
.card-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}

/* ===== Buttons ===== */
.btn{
  background:var(--surface-2);border:1px solid var(--border);
  color:var(--text);padding:7px 14px;border-radius:var(--radius-sm);
  font-size:13px;font-weight:500;transition:var(--transition);
  display:inline-flex;align-items:center;gap:6px;
}
.btn:hover{background:var(--surface-3);border-color:var(--text-muted)}
.btn.primary{background:linear-gradient(135deg,var(--accent),var(--accent-2));border-color:transparent;color:#fff;box-shadow:0 4px 12px var(--accent-glow)}
.btn.primary:hover{transform:translateY(-1px);box-shadow:0 8px 20px var(--accent-glow)}
.btn.danger{background:rgba(231,76,60,.12);border-color:rgba(231,76,60,.3);color:#ff7a6b}
.btn.danger:hover{background:rgba(231,76,60,.2)}
.btn.ghost{background:transparent;border-color:transparent;color:var(--text-dim)}
.btn.ghost:hover{background:var(--surface-2);color:var(--text)}
.btn.small{padding:4px 10px;font-size:12px}
.btn.icon{padding:6px;width:30px;height:30px;justify-content:center}
.btn svg{width:14px;height:14px}
.btn:disabled{opacity:.5;cursor:not-allowed}

/* ===== Inputs ===== */
.input, .select{
  background:var(--bg);border:1px solid var(--border);
  color:var(--text);padding:9px 12px;border-radius:var(--radius-sm);
  font-size:13px;transition:var(--transition);min-width:0;
}
.input:focus,.select:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-glow)}
.input::placeholder{color:var(--text-muted)}
.form-group{margin-bottom:14px}
.form-group label{display:block;font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.5px;margin-bottom:5px;font-weight:600}
.form-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.form-hint{font-size:11px;color:var(--text-muted);margin-top:4px}

/* ===== Tables ===== */
.table-wrap{overflow-x:auto;margin:0 -22px;padding:0 22px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{
  text-align:left;padding:10px 12px;color:var(--text-dim);
  font-weight:600;background:var(--surface-2);
  border-bottom:1px solid var(--border);
  font-size:11px;text-transform:uppercase;letter-spacing:.5px;
  position:sticky;top:0;z-index:1;
}
th:first-child{border-radius:var(--radius-sm) 0 0 0}
th:last-child{border-radius:0 var(--radius-sm) 0 0}
td{padding:11px 12px;border-bottom:1px solid var(--border-soft)}
tr{transition:background .1s}
tbody tr:hover{background:var(--surface-2)}
tbody tr:last-child td{border-bottom:none}

/* ===== Badges ===== */
.badge{
  display:inline-flex;align-items:center;gap:4px;
  padding:3px 9px;border-radius:20px;font-size:11px;font-weight:600;
  text-transform:uppercase;letter-spacing:.3px;
}
.badge::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.badge-pending{background:rgba(243,156,18,.12);color:#f5b041}
.badge-downloading,.badge-descargando{background:rgba(52,152,219,.12);color:#5dade2}
.badge-encoding,.badge-reencoding{background:rgba(155,89,182,.15);color:#bb8fce}
.badge-uploaded{background:rgba(46,204,113,.12);color:#58d68d}
.badge-failed{background:rgba(231,76,60,.12);color:#ec7063}
.badge-queued{background:rgba(139,143,163,.15);color:var(--text-dim)}

/* ===== Live download card ===== */
.live-item{
  background:var(--surface-2);border:1px solid var(--border-soft);
  border-radius:var(--radius);padding:14px 16px;margin-bottom:10px;
  display:grid;grid-template-columns:1fr auto;gap:10px 20px;align-items:center;
}
.live-name{font-weight:600;font-size:14px;display:flex;align-items:center;gap:8px}
.live-pct{font-family:'JetBrains Mono',monospace;font-size:18px;font-weight:600;color:var(--accent);font-feature-settings:"tnum"}
.live-bar{grid-column:1/-1;background:var(--bg);border-radius:6px;height:8px;overflow:hidden;border:1px solid var(--border-soft)}
.live-bar-fill{background:linear-gradient(90deg,var(--accent),#c084fc);height:100%;border-radius:6px;transition:width .5s ease;box-shadow:0 0 12px var(--accent-glow)}
.live-meta{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;grid-column:1/-1;font-size:12px}
.live-meta-item{display:flex;flex-direction:column;gap:2px}
.live-meta-label{color:var(--text-muted);font-size:10px;text-transform:uppercase;letter-spacing:.5px;font-weight:600}
.live-meta-value{font-family:'JetBrains Mono',monospace;font-weight:500;font-size:13px}
.live-message{
  grid-column:1/-1;color:var(--text-dim);font-size:12px;
  display:flex;flex-direction:column;gap:3px;min-width:0;
}
.live-message strong{color:var(--text);font-weight:600}
.live-raw{
  font-family:'JetBrains Mono',monospace;color:var(--text-muted);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}

/* ===== Modal ===== */
.modal-overlay{
  position:fixed;inset:0;background:rgba(0,0,0,.6);backdrop-filter:blur(4px);
  display:none;align-items:center;justify-content:center;z-index:100;padding:20px;
  animation:fadeIn .15s;
}
.modal-overlay.show{display:flex}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
.modal{
  background:var(--surface);border:1px solid var(--border);
  border-radius:var(--radius-lg);width:480px;max-width:100%;
  max-height:90vh;overflow-y:auto;padding:24px;
  box-shadow:var(--shadow-lg);animation:slideUp .2s;
}
.modal-title{font-size:16px;font-weight:600;margin-bottom:14px;display:flex;align-items:center;gap:8px}
.modal-body{font-size:13.5px;color:var(--text-dim);margin-bottom:18px;line-height:1.6}
.modal-footer{display:flex;justify-content:flex-end;gap:8px}
.modal-close{position:absolute;top:12px;right:12px;background:transparent;border:none;color:var(--text-dim);font-size:20px;cursor:pointer;width:32px;height:32px;border-radius:6px;display:flex;align-items:center;justify-content:center}
.modal-close:hover{background:var(--surface-2);color:var(--text)}

/* ===== Toast ===== */
.toast-container{position:fixed;bottom:20px;right:20px;display:flex;flex-direction:column;gap:8px;z-index:200;pointer-events:none}
.toast{
  background:var(--surface);border:1px solid var(--border);
  border-radius:var(--radius);padding:12px 16px;font-size:13px;
  box-shadow:var(--shadow-lg);display:flex;align-items:center;gap:10px;
  min-width:240px;max-width:380px;animation:slideInRight .25s;
  pointer-events:auto;
}
.toast.success{border-left:3px solid var(--green)}
.toast.error{border-left:3px solid var(--red)}
.toast.info{border-left:3px solid var(--blue)}
.toast.fade-out{opacity:0;transform:translateX(20px);transition:.25s}
@keyframes slideInRight{from{opacity:0;transform:translateX(20px)}to{opacity:1;transform:translateX(0)}}
.toast svg{width:18px;height:18px;flex-shrink:0}
.toast.success svg{color:var(--green)}
.toast.error svg{color:var(--red)}
.toast.info svg{color:var(--blue)}

/* ===== Logs ===== */
.logs-box{
  background:#050608;border:1px solid var(--border-soft);border-radius:var(--radius);
  padding:14px 16px;font-family:'JetBrains Mono',monospace;font-size:12px;
  line-height:1.7;max-height:520px;overflow-y:auto;color:var(--text-dim);
}
.logs-box .log-line{display:flex;gap:10px;padding:2px 0;white-space:pre-wrap;word-break:break-all}
.logs-box .log-time{color:var(--text-muted);flex-shrink:0}
.logs-box .log-level{font-weight:600;flex-shrink:0;min-width:60px}
.logs-box .log-level-INFO{color:var(--blue)}
.logs-box .log-level-WARNING,.logs-box .log-level-WARN{color:var(--orange)}
.logs-box .log-level-ERROR{color:var(--red)}
.logs-box .log-level-DEBUG{color:var(--text-muted)}
.logs-box .log-msg{color:var(--text);flex:1}

/* ===== Skeleton ===== */
.skeleton{background:linear-gradient(90deg,var(--surface-2) 0,var(--surface-3) 50%,var(--surface-2) 100%);background-size:200% 100%;animation:skel 1.5s infinite;border-radius:var(--radius-sm);height:14px}
@keyframes skel{0%{background-position:200% 0}100%{background-position:-200% 0}}
.skel-row{display:flex;gap:10px;padding:10px 12px;border-bottom:1px solid var(--border-soft)}
.skel-row .skeleton{flex:1}
.skel-row .skeleton:nth-child(1){flex:2}
.skel-row .skeleton:nth-child(2){flex:1}
.skel-row .skeleton:nth-child(3){flex:0 0 80px}

/* ===== Empty state ===== */
.empty{
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  padding:50px 20px;color:var(--text-muted);text-align:center;
}
.empty svg{width:48px;height:48px;opacity:.4;margin-bottom:12px}
.empty-text{font-size:13px}
.empty-sub{font-size:12px;margin-top:4px;color:var(--text-muted);opacity:.7}

/* ===== Status indicator ===== */
.status-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle;position:relative}
.status-dot.online{background:var(--green);box-shadow:0 0 0 0 rgba(46,204,113,.5);animation:pulse 2s infinite}
.status-dot.offline{background:var(--red)}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(46,204,113,.4)}70%{box-shadow:0 0 0 8px rgba(46,204,113,0)}100%{box-shadow:0 0 0 0 rgba(46,204,113,0)}}

/* ===== Chart ===== */
.chart-container{height:220px;position:relative}

/* ===== Mobile ===== */
.mobile-toggle{display:none;background:var(--surface-2);border:1px solid var(--border);width:36px;height:36px;border-radius:8px;align-items:center;justify-content:center}
.mobile-toggle svg{width:18px;height:18px}
@media(max-width:900px){
  .sidebar{transform:translateX(-100%);transition:.2s}
  .sidebar.open{transform:translateX(0);box-shadow:var(--shadow-lg)}
  .main{margin-left:0}
  .mobile-toggle{display:flex}
  .content{padding:18px}
  .live-meta{grid-template-columns:repeat(2,1fr)}
}

/* ===== Section visibility ===== */
.section{display:none}
.section.active{display:block;animation:fadeIn .2s}
@keyframes fadeIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}

/* ===== Filter row ===== */
.filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;align-items:center}
.filters .input,.filters .select{width:auto;min-width:140px}
</style>
</head>
<body>
<div class="layout">

<aside class="sidebar" id="sidebar">
  <div class="sidebar-header">
    <div class="brand-icon">T</div>
    <div class="brand-text">Twitch VOD Auto</div>
  </div>
  <nav class="sidebar-nav">
    <div class="nav-section">
      <div class="nav-section-title">General</div>
      <a class="nav-item active" data-section="overview" onclick="showSection('overview',this)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
        Dashboard
      </a>
      <a class="nav-item" data-section="vods" onclick="showSection('vods',this)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 12h16M4 18h10"/></svg>
        VODs
        <span class="nav-badge" id="badge-vods" style="display:none">0</span>
      </a>
      <a class="nav-item" data-section="queue" onclick="showSection('queue',this)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M3 12h18M3 18h12"/></svg>
        Cola
        <span class="nav-badge" id="badge-queue" style="display:none">0</span>
      </a>
    </div>
    <div class="nav-section">
      <div class="nav-section-title">Acciones</div>
      <a class="nav-item" data-section="manual" onclick="showSection('manual',this)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
        Subida manual
      </a>
      <a class="nav-item" data-section="youtube" onclick="showSection('youtube',this)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
        YouTube
      </a>
      <a class="nav-item" data-section="logs" onclick="showSection('logs',this)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6M9 17h6"/></svg>
        Logs
      </a>
    </div>
  </nav>
  <div class="sidebar-footer">
    <span class="status-dot online" id="statusDot"></span>
    <span id="statusText">Conectado</span>
    &middot; v2.0
  </div>
</aside>

<main class="main">
  <div class="topbar">
    <div style="display:flex;align-items:center;gap:12px">
      <button class="mobile-toggle" onclick="document.getElementById('sidebar').classList.toggle('open')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12h18M3 6h18M3 18h18"/></svg>
      </button>
      <h1 id="page-title">Dashboard</h1>
    </div>
    <div class="topbar-actions">
      <div class="stream-pill" title="Actualizaciones en tiempo real">
        <span class="status-dot online" id="streamDot"></span>
        <span id="streamText">Tiempo real</span>
      </div>
      <button class="btn ghost" onclick="refreshAll()" title="Refrescar">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
      </button>
      <div class="user-menu" onclick="showUserMenu()">
        <div class="user-avatar" id="userAvatar">A</div>
        <span class="user-name" id="userName">admin</span>
      </div>
    </div>
  </div>

  <div class="content">

    <!-- OVERVIEW -->
    <div id="section-overview" class="section active">
      <div class="kpi-grid">
        <div class="kpi-card">
          <div class="kpi-label">Total VODs</div>
          <div class="kpi-value" id="kpi-total">&mdash;</div>
          <div class="kpi-sub">registrados en el sistema</div>
        </div>
        <div class="kpi-card green">
          <div class="kpi-label">Subidos</div>
          <div class="kpi-value" id="kpi-uploaded">&mdash;</div>
          <div class="kpi-sub">publicados en YouTube</div>
        </div>
        <div class="kpi-card orange">
          <div class="kpi-label">En proceso</div>
          <div class="kpi-value" id="kpi-pending">&mdash;</div>
          <div class="kpi-sub" id="kpi-pending-sub">en cola o descargando</div>
        </div>
        <div class="kpi-card red">
          <div class="kpi-label">Fallidos</div>
          <div class="kpi-value" id="kpi-failed">&mdash;</div>
          <div class="kpi-sub">requieren atencion</div>
        </div>
      </div>

      <div class="card" id="live-card" style="display:none">
        <div class="card-header">
          <div class="card-title">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Descargas en curso <span id="live-count" style="color:var(--accent);font-weight:700"></span>
          </div>
          <span class="form-hint" id="live-updated"></span>
        </div>
        <div id="live-body"></div>
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title">Actividad ultimos 7 dias</div>
        </div>
        <div class="chart-container"><canvas id="activityChart"></canvas></div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px">
        <div class="card">
          <div class="card-header"><div class="card-title">Ultimos VODs subidos</div></div>
          <div id="overview-vods"></div>
        </div>
        <div class="card">
          <div class="card-header"><div class="card-title">Estadisticas por canal</div></div>
          <div id="overview-stats"></div>
        </div>
      </div>
    </div>

    <!-- VODS -->
    <div id="section-vods" class="section">
      <div class="card">
        <div class="card-header"><div class="card-title">Todos los VODs</div></div>
        <div class="filters">
          <input type="text" id="vod-search" class="input" placeholder="Buscar VOD ID, canal, video ID..." oninput="loadVods(0)">
          <select id="vod-status" class="select" onchange="loadVods(0)">
            <option value="">Todos los estados</option>
            <option value="pending">Pendiente</option>
            <option value="downloading">Descargando</option>
            <option value="encoding">Reencoding</option>
            <option value="uploaded">Subido</option>
            <option value="failed">Fallido</option>
          </select>
          <select id="vod-channel" class="select" onchange="loadVods(0)">
            <option value="">Todos los canales</option>
          </select>
        </div>
        <div id="vods-table"></div>
        <div class="pagination" id="vods-pagination"></div>
      </div>
    </div>

    <!-- QUEUE -->
    <div id="section-queue" class="section">
      <div class="card">
        <div class="card-header">
          <div class="card-title">Cola de descargas</div>
          <button class="btn small ghost" onclick="loadQueue()">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
            Refrescar
          </button>
        </div>
        <div id="queue-table"></div>
      </div>
    </div>

    <!-- MANUAL -->
    <div id="section-manual" class="section">
      <div class="card" style="max-width:620px">
        <div class="card-header">
          <div class="card-title">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><path d="M12 5v14M5 12h14"/></svg>
            Encolar VOD manualmente
          </div>
        </div>
        <div class="form-group">
          <label>URL o VOD ID de Twitch</label>
          <input type="text" id="manual-url" class="input" placeholder="https://www.twitch.tv/videos/123456789 o https://twitchtracker.com/canal/streams/123">
          <div class="form-hint">Acepta URLs de Twitch, TwitchTracker, StreamsCharts o VOD IDs internos</div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Canal (opcional)</label>
            <input type="text" id="manual-channel" class="input" placeholder="nombre_canal">
          </div>
          <div class="form-group">
            <label>Privacidad YouTube</label>
            <select id="manual-privacy" class="select">
              <option value="private">Private</option>
              <option value="unlisted">Unlisted</option>
              <option value="public">Public</option>
            </select>
          </div>
        </div>
        <div class="form-group">
          <label>Titulo personalizado (opcional)</label>
          <input type="text" id="manual-title" class="input" placeholder="Vacio = titulo automatico">
        </div>
        <div class="form-group">
          <label>Tags (opcional)</label>
          <input type="text" id="manual-tags" class="input" placeholder="twitch, vod, stream">
        </div>
        <button class="btn primary" onclick="manualUpload()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
          Encolar VOD
        </button>
      </div>
    </div>

    <!-- YOUTUBE -->
    <div id="section-youtube" class="section">
      <div class="card" style="max-width:720px">
        <div class="card-header">
          <div class="card-title">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
            Credenciales YouTube
          </div>
          <button class="btn small ghost" onclick="loadYouTubeOAuthStatus()">Refrescar</button>
        </div>
        <div id="youtube-oauth-status" class="table-wrap"></div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:14px">
          <button class="btn primary" id="youtube-oauth-btn" onclick="startYouTubeOAuth()">
            Renovar token
          </button>
        </div>
      </div>
    </div>

    <!-- LOGS -->
    <div id="section-logs" class="section">
      <div class="card">
        <div class="card-header">
          <div class="card-title">Logs del pipeline (ultimas lineas)</div>
          <div class="card-actions">
            <select id="logs-lines" class="select" onchange="loadLogs()">
              <option value="50">50</option>
              <option value="100" selected>100</option>
              <option value="300">300</option>
              <option value="1000">1000</option>
            </select>
            <button class="btn small ghost" onclick="loadLogs()">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
            </button>
          </div>
        </div>
        <div class="logs-box" id="logs-box"></div>
      </div>
    </div>

  </div>
</main>

</div>

<div class="modal-overlay" id="modal">
  <div class="modal" onclick="event.stopPropagation()">
    <button class="modal-close" onclick="closeModal()">&times;</button>
    <div class="modal-title" id="modal-title"></div>
    <div class="modal-body" id="modal-body"></div>
    <div class="modal-footer" id="modal-footer"></div>
  </div>
</div>

<div class="toast-container" id="toasts"></div>

<script>
const titles={overview:'Dashboard',vods:'VODs',queue:'Cola de descargas',manual:'Subida manual',youtube:'YouTube',logs:'Logs'};
let events=null;
let fallbackInterval=null;
let currentVodOffset=0;
let currentUser='admin';
let activeProgress={};
let lastState=null;
let lastVodsData=[];
let lastVodsTotal=0;
let lastActivityKey='';

const SVG={ok:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>',err:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',info:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'};

function toast(msg,type='success'){
  const t=document.createElement('div');
  t.className='toast '+safeClass(type);
  t.innerHTML=(type==='success'?SVG.ok:type==='error'?SVG.err:SVG.info)+'<span>'+escapeHtml(String(msg))+'</span>';
  document.getElementById('toasts').appendChild(t);
  setTimeout(()=>{t.classList.add('fade-out');setTimeout(()=>t.remove(),250)},3500);
}

function showSection(id,el){
  document.querySelectorAll('.section').forEach(s=>s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  document.getElementById('section-'+id).classList.add('active');
  if(el) el.classList.add('active');
  document.getElementById('page-title').textContent=titles[id]||id;
  document.getElementById('sidebar').classList.remove('open');
  if(id==='vods') loadVods(0);
  if(id==='queue') lastState?renderQueue(lastState.queue||[]):loadQueue();
  if(id==='youtube') loadYouTubeOAuthStatus();
  if(id==='logs') loadLogs();
}

function refreshAll(){
  loadStats();loadProgress();
  const vSec=document.getElementById('section-vods');
  if(vSec.classList.contains('active')) loadVods(currentVodOffset);
  const qSec=document.getElementById('section-queue');
  if(qSec.classList.contains('active')) loadQueue();
  const lSec=document.getElementById('section-logs');
  if(lSec.classList.contains('active')) loadLogs();
}

function setRealtimeStatus(online,text){
  const dot=document.getElementById('streamDot');
  const label=document.getElementById('streamText');
  if(dot){dot.classList.toggle('online',!!online);dot.classList.toggle('offline',!online)}
  if(label) label.textContent=text;
}

function connectEvents(){
  if(!window.EventSource){
    setRealtimeStatus(false,'Fallback 10s');
    fallbackInterval=setInterval(refreshAll,10000);
    return;
  }
  events=new EventSource('/api/events');
  events.addEventListener('open',()=>{
    setRealtimeStatus(true,'Tiempo real');
    if(fallbackInterval){clearInterval(fallbackInterval);fallbackInterval=null}
  });
  events.addEventListener('state',event=>{
    try{applyState(JSON.parse(event.data))}
    catch(e){console.error(e)}
  });
  events.addEventListener('error',()=>{
    setRealtimeStatus(false,'Reconectando');
  });
}

function applyState(state){
  lastState=state;
  activeProgress=state.active_downloads||{};
  renderStats(state);
  renderLiveDownloads();
  const activityKey=JSON.stringify(state.activity||[]);
  if(activityKey!==lastActivityKey){
    lastActivityKey=activityKey;
    renderActivityChart(state.activity||[]);
  }
  const qSec=document.getElementById('section-queue');
  if(qSec.classList.contains('active')) renderQueue(state.queue||[]);
  if(lastVodsData.length){
    mergeRecentVods(state.recent_vods||[]);
    const vSec=document.getElementById('section-vods');
    if(vSec.classList.contains('active')) renderVodsTable(lastVodsData,lastVodsTotal,currentVodOffset);
  }
}

async function api(path,opts={}){
  const r=await fetch(path,opts);
  if(r.status===401){window.location='/login';return Promise.reject('auth')}
  if(!r.ok){const d=await r.json().catch(()=>({}));throw new Error(d.detail||d.error||'Error '+r.status)}
  return r.json();
}

function fmtSecs(s){
  if(s==null) return '--';
  s=Math.max(0,parseInt(s));
  const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=s%60;
  return (h>0?h+':':'')+String(m).padStart(2,'0')+':'+String(sec).padStart(2,'0');
}

function fmtBytes(mb){
  const n=Number(mb);
  if(!Number.isFinite(n)||n<=0) return '0 MB';
  if(n>1024) return (n/1024).toFixed(2)+' GB';
  return n.toFixed(1)+' MB';
}

function safeClass(s){return String(s??'').toLowerCase().replace(/[^a-z0-9_-]/g,'')||'unknown'}
function esc(s){return escapeHtml(String(s??''))}
function escAttr(s){return esc(s).replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
function jsArg(s){return escAttr(JSON.stringify(String(s??'')))}
function clampPct(value){const n=Number(value);return Number.isFinite(n)?Math.min(100,Math.max(0,n)):0}
function badge(status){
  const raw=String(status??'');
  return `<span class="badge badge-${safeClass(raw)}">${esc(raw)}</span>`;
}
function skeletonRow(){return '<div class="skel-row"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>'}
function emptyState(msg,sub=''){
  return `<div class="empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01"/></svg><div class="empty-text">${esc(msg)}</div>${sub?`<div class="empty-sub">${esc(sub)}</div>`:''}</div>`;
}

function renderStats(d){
  if(!d||!d.summary) return;
  document.getElementById('kpi-total').textContent=d.summary.total||0;
  document.getElementById('kpi-uploaded').textContent=d.summary.uploaded||0;
  document.getElementById('kpi-pending').textContent=(d.summary.pending||0)+(d.summary.downloading||0);
  document.getElementById('kpi-failed').textContent=d.summary.failed||0;

  const chSel=document.getElementById('vod-channel');
  const known=new Set([...chSel.options].map(o=>o.value));
  (d.channels||[]).forEach(c=>{
    if(!known.has(c)){
      const o=document.createElement('option');
      o.value=c;o.textContent=c;chSel.appendChild(o);
    }
  });

  const statsBox=document.getElementById('overview-stats');
  if(!(d.stats||[]).length){statsBox.innerHTML=emptyState('Sin datos','Aun no hay estadisticas de canales')}
  else{
    statsBox.innerHTML='<div class="table-wrap"><table><thead><tr><th>Canal</th><th>Detectados</th><th>Subidos</th><th>Fallidos</th></tr></thead><tbody>'+
      d.stats.map(s=>`<tr><td>${esc(s.channel)}</td><td>${Number(s.total_detected)||0}</td><td>${Number(s.total_uploaded)||0}</td><td>${Number(s.total_failed)||0}</td></tr>`).join('')+'</tbody></table></div>';
  }

  const vodsBox=document.getElementById('overview-vods');
  const recent=(d.recent_vods||d.vods||[]).slice(0,6);
  if(!recent.length){vodsBox.innerHTML=emptyState('Sin VODs','Los VODs apareceran aqui cuando se procesen')}
  else{
    vodsBox.innerHTML='<div class="table-wrap"><table><thead><tr><th>Canal</th><th>Estado</th><th>YouTube</th></tr></thead><tbody>'+
      recent.map(v=>{
        const progress=activeProgress[v.vod_id];
        const status=progress?progress.status:v.status;
        const yt=v.youtube_id?`<a href="https://youtu.be/${escAttr(v.youtube_id)}" target="_blank" rel="noopener" style="color:var(--accent)">${esc(v.youtube_id)}</a>`:'-';
        return `<tr><td>${esc(v.channel)}</td><td>${badge(status)}</td><td>${yt}</td></tr>`;
      }).join('')+'</tbody></table></div>';
  }
}

async function loadStats(){
  try{
    const d=await api('/api/stats');
    renderStats(d);
    loadActivityChart();
  }catch(e){console.error(e)}
}

async function loadProgress(){
  try{
    const d=await api('/api/progress');
    activeProgress=d.active_downloads||{};
    renderLiveDownloads();
  }catch(e){console.error(e)}
}

function renderLiveDownloads(){
  const card=document.getElementById('live-card');
  const body=document.getElementById('live-body');
  const countEl=document.getElementById('live-count');
  const updEl=document.getElementById('live-updated');
  const items=Object.values(activeProgress);
  if(!items.length){card.style.display='none';return}
  card.style.display='block';
  countEl.textContent=` (${items.length})`;
  updEl.textContent='Actualizado '+new Date().toLocaleTimeString();
  body.innerHTML=items.map(p=>{
    const pct=clampPct(p.percent);
    const isEncoding=p.status==='encoding';
    const isUpload=p.status==='uploading'||p.stage==='upload';
    const statusLabel=isEncoding?'Reencoding':(isUpload?'Subiendo':'Descargando');
    const totalMb=p.total_size_mb||0;
    const downMb=p.downloaded_mb||0;
    const sizeInfo=totalMb?`${fmtBytes(downMb)} / ${fmtBytes(totalMb)}`:(p.file_size_mb?fmtBytes(p.file_size_mb):'-');
    const encodedInfo=isEncoding?fmtBytes(p.encoded_mb||p.file_size_mb||0):sizeInfo;
    const timeInfo=p.duration_seconds?`${fmtSecs(p.processed_seconds||0)} / ${fmtSecs(p.duration_seconds)}`:(p.processed_seconds!=null?fmtSecs(p.processed_seconds):'-');
    const message=p.message||statusLabel;
    const raw=p.raw_line?`<span class="live-raw" title="${escAttr(p.raw_line)}">${esc(p.raw_line)}</span>`:'';
    const channel=p.channel||(String(p.vod_id||'').split('_')[0]||'').replace('video:','');
    return `<div class="live-item">
      <div class="live-name">${esc(channel)} ${badge(statusLabel)}</div>
      <div class="live-pct">${pct.toFixed(1)}%</div>
      <div class="live-bar"><div class="live-bar-fill" style="width:${pct}%"></div></div>
      <div class="live-message"><strong>${esc(message)}</strong>${raw}</div>
      <div class="live-meta">
        <div class="live-meta-item"><span class="live-meta-label">${isEncoding?'Codificado':(isUpload?'Subido':'Tamano')}</span><span class="live-meta-value">${encodedInfo}</span></div>
        <div class="live-meta-item"><span class="live-meta-label">Velocidad</span><span class="live-meta-value">${esc(p.speed||'-')}</span></div>
        <div class="live-meta-item"><span class="live-meta-label">ETA</span><span class="live-meta-value">${esc(p.eta||'-')}</span></div>
        <div class="live-meta-item"><span class="live-meta-label">${isEncoding?'Video':'Transcurrido'}</span><span class="live-meta-value">${isEncoding?timeInfo:fmtSecs(p.elapsed_seconds)}</span></div>
      </div>
    </div>`;
  }).join('');
}

async function loadVods(offset=0){
  currentVodOffset=offset;
  const box=document.getElementById('vods-table');
  box.innerHTML=skeletonRow()+skeletonRow()+skeletonRow();
  try{
    const status=document.getElementById('vod-status').value;
    const channel=document.getElementById('vod-channel').value;
    const search=document.getElementById('vod-search').value;
    const d=await api(`/api/vods?status=${encodeURIComponent(status)}&channel=${encodeURIComponent(channel)}&search=${encodeURIComponent(search)}&limit=25&offset=${offset}`);
    lastVodsData=d.vods||[];
    lastVodsTotal=d.total||0;
    renderVodsTable(lastVodsData,lastVodsTotal,offset);
  }catch(e){box.innerHTML=emptyState('Error','No se pudieron cargar los VODs');console.error(e)}
}

function mergeRecentVods(recent){
  if(!recent||!recent.length||!lastVodsData.length) return;
  const byId=new Map(recent.map(v=>[v.vod_id,v]));
  lastVodsData=lastVodsData.map(v=>byId.has(v.vod_id)?{...v,...byId.get(v.vod_id)}:v);
}

function renderVodsTable(vods,total,offset=currentVodOffset){
  const box=document.getElementById('vods-table');
  if(!vods.length){
    box.innerHTML=emptyState('Sin resultados','Prueba a cambiar los filtros');
    document.getElementById('vods-pagination').innerHTML='';
    document.getElementById('badge-vods').textContent=total||0;
    document.getElementById('badge-vods').style.display=total?'inline':'none';
    return;
  }
  box.innerHTML='<div class="table-wrap"><table><thead><tr><th>VOD ID</th><th>Canal</th><th>Estado</th><th>Tamano</th><th>YouTube</th><th>Detectado</th><th></th></tr></thead><tbody>'+
    vods.map(v=>{
      const progress=activeProgress[v.vod_id];
      const rowStatus=progress?progress.status:v.status;
      const size=v.file_size_mb?fmtBytes(v.file_size_mb):'-';
      const yt=v.youtube_id?`<a href="https://youtu.be/${escAttr(v.youtube_id)}" target="_blank" rel="noopener" style="color:var(--accent)">${esc(v.youtube_id)}</a>`:'-';
      const detected=v.detected_at?v.detected_at.replace('T',' ').slice(0,16):'-';
      const vodShort=String(v.vod_id).length>32?String(v.vod_id).slice(0,29)+'...':String(v.vod_id);
      const pPct=progress?clampPct(progress.percent):0;
      const detail=progress?(progress.message||progress.speed||'En curso'):'';
      const sizeCell=progress?`<div style="min-width:150px"><div style="background:var(--bg);border-radius:4px;height:6px;overflow:hidden;border:1px solid var(--border-soft)"><div style="background:var(--accent);height:100%;width:${pPct}%;transition:width .5s"></div></div><div style="font-size:10px;color:var(--text-dim);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${pPct.toFixed(1)}% &middot; ${esc(detail)}</div></div>`:size;
      let actions='';
      if(rowStatus==='failed'||rowStatus==='pending') actions+=`<button class="btn small ghost" onclick="retryVod(${jsArg(v.vod_id)})" title="Reintentar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg></button>`;
      actions+=`<button class="btn small ghost" onclick="deleteVod(${jsArg(v.vod_id)})" title="Eliminar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>`;
      return `<tr><td title="${escAttr(v.vod_id)}" style="font-family:'JetBrains Mono',monospace;font-size:12px">${esc(vodShort)}</td><td>${esc(v.channel)}</td><td>${badge(rowStatus)}</td><td>${sizeCell}</td><td>${yt}</td><td style="font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text-dim)">${esc(detected)}</td><td><div style="display:flex;gap:4px">${actions}</div></td></tr>`;
    }).join('')+'</tbody></table></div>';
  const totalPages=Math.max(1,Math.ceil(total/25));
  const curPage=Math.floor(offset/25)+1;
  const pagHtml=`<button class="btn small" ${offset===0?'disabled':''} onclick="loadVods(${Math.max(0,offset-25)})">&laquo; Anterior</button><span>Pagina ${curPage} de ${totalPages} (${total} total)</span><button class="btn small" ${offset+25>=total?'disabled':''} onclick="loadVods(${offset+25})">Siguiente &raquo;</button>`;
  document.getElementById('vods-pagination').innerHTML=pagHtml;
  document.getElementById('badge-vods').textContent=total;document.getElementById('badge-vods').style.display='inline';
}

async function loadQueue(){
  const box=document.getElementById('queue-table');
  box.innerHTML=skeletonRow()+skeletonRow();
  try{
    const d=await api('/api/queue');
    renderQueue(d.queue||[]);
  }catch(e){box.innerHTML=emptyState('Error','No se pudo cargar la cola');console.error(e)}
}

function renderQueue(queue){
  const box=document.getElementById('queue-table');
  if(!queue.length){
    box.innerHTML=emptyState('Cola vacia','Encola un VOD desde la seccion Subida manual');
    document.getElementById('badge-queue').style.display='none';
    return;
  }
  box.innerHTML='<div class="table-wrap"><table><thead><tr><th>VOD ID</th><th>Canal</th><th>Estado</th><th>Intentos</th><th>Creado</th><th></th></tr></thead><tbody>'+
    queue.map(q=>{
      const progress=activeProgress[q.vod_id];
      const status=progress?progress.status:q.status;
      const vid=String(q.vod_id).length>32?String(q.vod_id).slice(0,29)+'...':String(q.vod_id);
      const created=q.created_at?q.created_at.replace('T',' ').slice(0,16):'-';
      return `<tr><td title="${escAttr(q.vod_id)}" style="font-family:'JetBrains Mono',monospace;font-size:12px">${esc(vid)}</td><td>${esc(q.channel)}</td><td>${badge(status)}</td><td>${Number(q.attempts)||0}</td><td style="font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text-dim)">${esc(created)}</td><td><button class="btn small ghost" onclick="deleteFromQueue(${jsArg(q.vod_id)})"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg></button></td></tr>`;
    }).join('')+'</tbody></table></div>';
  const active=queue.filter(q=>['queued','downloading','encoding','uploading'].includes(q.status)).length;
  document.getElementById('badge-queue').textContent=active;document.getElementById('badge-queue').style.display=active?'inline':'none';
}

async function loadLogs(){
  const box=document.getElementById('logs-box');
  const lines=document.getElementById('logs-lines').value;
  try{
    const d=await api(`/api/logs?lines=${lines}`);
    if(!d.logs.length){box.innerHTML=emptyState('Sin logs','El archivo de log esta vacio');return}
    box.innerHTML=d.logs.map(l=>{
      const m=l.match(/^(\\S+)\\s+\\|\\s+(\\w+)\\s+\\|/);
      if(m){
        const ts=m[1];const lvl=m[2];
        const msg=l.replace(/^\\S+\\s+\\|\\s+\\w+\\s+\\|\\s+/,'');
        return `<div class="log-line"><span class="log-time">${esc(ts)}</span><span class="log-level log-level-${safeClass(lvl)}">${esc(lvl.padEnd(7))}</span><span class="log-msg">${escapeHtml(msg)}</span></div>`;
      }
      return `<div class="log-line"><span class="log-msg">${escapeHtml(l)}</span></div>`;
    }).join('');
    box.scrollTop=box.scrollHeight;
  }catch(e){console.error(e)}
}

function escapeHtml(s){
  return String(s??'')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}

async function manualUpload(){
  const url=document.getElementById('manual-url').value.trim();
  if(!url){toast('Introduce una URL o VOD ID','error');return}
  try{
    const d=await api('/api/manual_upload',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      url_or_id:url,
      channel:document.getElementById('manual-channel').value.trim(),
      privacy:document.getElementById('manual-privacy').value,
      title:document.getElementById('manual-title').value.trim(),
      tags:document.getElementById('manual-tags').value.split(',').map(t=>t.trim()).filter(Boolean),
    })});
    toast(`VOD encolado: ${d.vod_id}`,'success');
    document.getElementById('manual-url').value='';
    document.getElementById('manual-title').value='';
    document.getElementById('manual-tags').value='';
  }catch(e){toast(e.message,'error')}
}

function renderYouTubeOAuthStatus(d){
  const box=document.getElementById('youtube-oauth-status');
  const c=d.credentials||{};
  const tokenState=!c.exists?'No existe':(c.error?'Invalido':(c.has_refresh_token?'Disponible':'Sin refresh token'));
  const validState=c.valid?'Valido':(c.expired?'Caducado':'No validado');
  const mode=d.mode==='web'?'Callback directa':(d.mode==='installed'?'Desktop con pegado de URL':'No soportado');
  const rows=[
    ['OAuth client', d.client_secret_exists?d.client_secret_type:'No encontrado'],
    ['Modo', mode],
    ['Callback', d.redirect_uri||'-'],
    ['Token', tokenState],
    ['Estado', validState],
    ['Actualizado', c.updated_at?c.updated_at.replace('T',' ').slice(0,19):'-'],
  ];
  box.innerHTML='<table><tbody>'+rows.map(r=>`<tr><td style="color:var(--text-dim);width:160px">${esc(r[0])}</td><td style="font-family:${r[0]==='Callback'?'JetBrains Mono, monospace':'inherit'};font-size:${r[0]==='Callback'?'12px':'inherit'}">${esc(r[1])}</td></tr>`).join('')+'</tbody></table>';
  const btn=document.getElementById('youtube-oauth-btn');
  if(btn){
    btn.disabled=!d.ready;
    btn.title=d.ready?'Renovar token de YouTube':'Falta client_secret.json o no es un OAuth client valido';
  }
}

async function loadYouTubeOAuthStatus(){
  const box=document.getElementById('youtube-oauth-status');
  box.innerHTML=skeletonRow()+skeletonRow();
  try{
    const d=await api('/api/youtube/oauth/status');
    renderYouTubeOAuthStatus(d);
  }catch(e){
    box.innerHTML=emptyState('Error','No se pudo leer el estado de YouTube');
    toast(e.message,'error');
  }
}

async function startYouTubeOAuth(){
  const btn=document.getElementById('youtube-oauth-btn');
  try{
    if(btn){btn.disabled=true;btn.textContent='Abriendo Google...'}
    const d=await api('/api/youtube/oauth/start',{method:'POST'});
    if(d.mode==='web'){
      window.location=d.authorization_url;
      return;
    }
    showInstalledOAuthModal(d.authorization_url,d.redirect_uri);
    if(btn){btn.disabled=false;btn.textContent='Renovar token'}
  }catch(e){
    toast(e.message,'error');
    if(btn){btn.disabled=false;btn.textContent='Renovar token'}
  }
}

function showInstalledOAuthModal(url,redirectUri){
  showModal({
    title:'Renovar YouTube',
    body:`<p>Abre Google, acepta el permiso y copia la URL final que empieza por <code style="font-family:'JetBrains Mono',monospace;background:var(--surface-2);padding:2px 6px;border-radius:4px">${esc(redirectUri)}</code>.</p>
      <p style="margin-top:10px"><a class="btn primary" href="${escAttr(url)}" target="_blank" rel="noopener">Abrir Google</a></p>
      <div class="form-group" style="margin-top:14px">
        <label>URL final o parametro code</label>
        <textarea id="youtube-oauth-callback" class="input" style="min-height:92px;resize:vertical;font-family:'JetBrains Mono',monospace" placeholder="http://localhost:53682/?state=...&code=..."></textarea>
      </div>`,
    confirm:{label:'Guardar token',class:'primary',action:completeInstalledOAuth},
  });
}

async function completeInstalledOAuth(){
  const input=document.getElementById('youtube-oauth-callback');
  const callbackUrl=input?input.value.trim():'';
  if(!callbackUrl){throw new Error('Pega la URL final de Google')}
  await api('/api/youtube/oauth/complete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({callback_url:callbackUrl})});
  toast('Token de YouTube renovado','success');
  loadYouTubeOAuthStatus();
}

async function retryVod(vodId){
  try{await api(`/api/vods/${encodeURIComponent(vodId)}/retry`,{method:'POST'});toast('VOD reencolado');loadVods(currentVodOffset)}catch(e){toast(e.message,'error')}
}

function deleteVod(vodId){
  showModal({
    title:'Eliminar VOD',
    body:`<p>Vas a eliminar el VOD <code style="font-family:'JetBrains Mono',monospace;background:var(--surface-2);padding:2px 6px;border-radius:4px">${esc(vodId)}</code> del sistema. Esto borrara su registro, progreso y entrada en la cola. La accion no se puede deshacer.</p>`,
    confirm:{label:'Eliminar',class:'danger',action:async()=>{try{await api(`/api/vods/${encodeURIComponent(vodId)}`,{method:'DELETE'});toast('VOD eliminado');loadVods(currentVodOffset);loadStats()}catch(e){toast(e.message,'error')}}},
  });
}

function deleteFromQueue(vodId){
  showModal({
    title:'Quitar de la cola',
    body:`<p>Quitar <code style="font-family:'JetBrains Mono',monospace;background:var(--surface-2);padding:2px 6px;border-radius:4px">${esc(vodId)}</code> de la cola de descargas?</p>`,
    confirm:{label:'Quitar',class:'danger',action:async()=>{try{await api(`/api/queue/${encodeURIComponent(vodId)}`,{method:'DELETE'});toast('Quitado de la cola');loadQueue()}catch(e){toast(e.message,'error')}}},
  });
}

let _modalConfirmAction=null;
function showModal({title,body,confirm}){
  document.getElementById('modal-title').textContent=title;
  document.getElementById('modal-body').innerHTML=body;
  const footer=document.getElementById('modal-footer');
  _modalConfirmAction=confirm?confirm.action:null;
  footer.innerHTML=`<button class="btn ghost" onclick="closeModal()">Cancelar</button>`+(confirm?`<button class="btn ${safeClass(confirm.class||'primary')}" id="modal-confirm-btn">${esc(confirm.label)}</button>`:'');
  const btn=document.getElementById('modal-confirm-btn');
  if(btn){
    btn.onclick=async()=>{
      if(_modalConfirmAction){
        try{await _modalConfirmAction()}catch(e){toast(e.message||String(e),'error')}
      }
      closeModal();
    };
  }
  document.getElementById('modal').classList.add('show');
}
function closeModal(){document.getElementById('modal').classList.remove('show')}
document.getElementById('modal').addEventListener('click',e=>{if(e.target.id==='modal')closeModal()});

function showUserMenu(){
  showModal({
    title:'Sesion',
    body:`<p>Conectado como <strong>${esc(currentUser)}</strong></p><p style="margin-top:10px">Sesion valida 7 dias. Para cerrarla, pulsa el boton de abajo.</p>`,
    confirm:{label:'Cerrar sesion',class:'danger',action:async()=>{try{await api('/api/logout',{method:'POST'});window.location='/login'}catch(e){toast(e.message,'error')}}},
  });
}

async function loadActivityChart(){
  try{
    const d=await api('/api/activity?days=7');
    renderActivityChart(d.activity||[]);
  }catch(e){console.error(e)}
}

function renderActivityChart(data=[]){
  const canvas=document.getElementById('activityChart');
  if(!canvas) return;
  const ctx=canvas.getContext('2d');
  const w=canvas.parentElement.offsetWidth;
  const h=canvas.parentElement.offsetHeight;
  canvas.width=w;canvas.height=h;
  const pad=40;const chartW=w-pad*2;const chartH=h-pad*2;
  ctx.clearRect(0,0,w,h);
  if(!data.length){ctx.fillStyle='#5b5f73';ctx.font='13px Inter';ctx.textAlign='center';ctx.fillText('Sin datos en los ultimos 7 dias',w/2,h/2);return}
  const maxVal=Math.max(...data.map(d=>d.total),1);
  const barW=Math.max(20,(chartW/data.length)*0.6);
  const gap=(chartW-(barW*data.length))/(data.length+1);
  ctx.strokeStyle='#262a39';ctx.lineWidth=1;
  ctx.beginPath();ctx.moveTo(pad,pad);ctx.lineTo(pad,h-pad);ctx.lineTo(w-pad,h-pad);ctx.stroke();
  data.forEach((d,i)=>{
    const x=pad+gap+i*(barW+gap);
    const totalH=(d.total/maxVal)*chartH;
    const upH=(d.uploaded/maxVal)*chartH;
    const failH=(d.failed/maxVal)*chartH;
    ctx.fillStyle='#1d2030';
    ctx.fillRect(x,h-pad-totalH,barW,totalH);
    ctx.fillStyle='#2ecc71';
    ctx.fillRect(x,h-pad-upH,barW,upH);
    ctx.fillStyle='#e74c3c';
    ctx.fillRect(x,h-pad-upH-failH,barW,failH);
    ctx.fillStyle='#8b8fa3';ctx.font='11px JetBrains Mono';ctx.textAlign='center';
    ctx.fillText(d.day.slice(5),x+barW/2,h-pad+15);
    ctx.fillStyle='#e4e6ef';ctx.font='11px Inter';
    ctx.fillText(d.total,x+barW/2,h-pad-totalH-6);
  });
  const legY=pad-15;
  ctx.font='11px Inter';ctx.textAlign='left';
  ctx.fillStyle='#2ecc71';ctx.fillRect(pad,legY,10,10);ctx.fillStyle='#e4e6ef';ctx.fillText('Subidos',pad+14,legY+9);
  ctx.fillStyle='#e74c3c';ctx.fillRect(pad+80,legY,10,10);ctx.fillStyle='#e4e6ef';ctx.fillText('Fallidos',pad+94,legY+9);
  ctx.fillStyle='#1d2030';ctx.fillRect(pad+160,legY,10,10);ctx.fillStyle='#e4e6ef';ctx.fillText('Total',pad+174,legY+9);
}

window.addEventListener('resize',()=>{const s=document.getElementById('section-overview');if(s.classList.contains('active'))loadActivityChart()});

// Init
(async()=>{
  try{
    const me=await api('/api/me');
    currentUser=me.user;
    document.getElementById('userName').textContent=me.user;
    document.getElementById('userAvatar').textContent=me.user.charAt(0).toUpperCase();
  }catch(e){}
  const params=new URLSearchParams(window.location.search);
  const ytResult=params.get('youtube_oauth');
  if(ytResult){
    toast(ytResult==='success'?'Token de YouTube renovado':'No se pudo renovar YouTube',ytResult==='success'?'success':'error');
    window.history.replaceState({},document.title,window.location.pathname);
  }
  refreshAll();
  connectEvents();
})();
</script>
</body>
</html>"""


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080)
