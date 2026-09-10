import asyncio
import json
import logging
import os
import secrets
import sqlite3
import time
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from fastapi import Depends, FastAPI, Form, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from google_auth_oauthlib.flow import Flow
from starlette.middleware.sessions import SessionMiddleware

from credentials_store import load_credentials, save_credentials
from db import PipelineDB
from m3u8_resolver import M3U8ResolveError, M3U8Resolver
from progress import DownloadProgress
from utils import parse_twitch_vod_url
from youtube_uploader import SCOPES

# =============================================================================
# Config & globals
# =============================================================================

CONFIG_PATH = os.getenv("CONFIG_PATH", "config.json")
config = {}
if os.path.exists(CONFIG_PATH):
    with open(CONFIG_PATH, encoding="utf-8") as f:
        config = json.load(f)

DB_PATH = config.get("monitoring", {}).get("db_path", "data/pipeline.db")
LOG_PATH = config.get("app", {}).get("log_file", "logs/pipeline.log")

# Authentication comes from environment variables. A random password is only allowed explicitly.
ADMIN_USER = os.getenv("ADMIN_USER", "admin")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD")
SECRET_KEY = os.getenv("SECRET_KEY")
COOKIE_SECURE = os.getenv("COOKIE_SECURE", "false").lower() in ("1", "true", "yes")
ALLOW_RANDOM_ADMIN_PASSWORD = os.getenv("ALLOW_RANDOM_ADMIN_PASSWORD", "false").lower() in ("1", "true", "yes")
_login_attempts = {}

if not SECRET_KEY:
    SECRET_KEY = secrets.token_urlsafe(32)
    logging.warning("[Auth] SECRET_KEY is not set; sessions will reset when the process restarts")
elif len(SECRET_KEY) < 32:
    logging.warning(
        "[Auth] SECRET_KEY is too short (%d characters). Use at least 32 random characters "
        "to prevent session cookie forgery.",
        len(SECRET_KEY),
    )

if not ADMIN_PASSWORD:
    if not ALLOW_RANDOM_ADMIN_PASSWORD:
        raise RuntimeError("ADMIN_PASSWORD is not set. Define it in .env.")
    ADMIN_PASSWORD = secrets.token_urlsafe(24)
    logging.warning("[Auth] ADMIN_PASSWORD is not set. User: %s Temporary password: %s", ADMIN_USER, ADMIN_PASSWORD)

logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)-7s | %(name)-12s | %(message)s")
log = logging.getLogger("dashboard")

# Do not expose the OpenAPI schema without authentication.
app = FastAPI(title="Twitch VOD Auto - Admin", docs_url=None, redoc_url=None, openapi_url=None)
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
            return JSONResponse(status_code=403, content={"detail": "Origin not allowed"})
        if not origin_host and referer_host and referer_host != host:
            return JSONResponse(status_code=403, content={"detail": "Origin not allowed"})

    response = await call_next(request)
    response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault(
        "Content-Security-Policy",
        # JavaScript and fonts are bundled locally. Inline styles remain enabled
        # because the SPA and Recharts use them.
        "default-src 'self'; "
        "script-src 'self'; "
        "style-src 'self' 'unsafe-inline'; "
        "font-src 'self'; "
        "img-src 'self' data:; "
        "connect-src 'self'; "
        "base-uri 'self'; frame-ancestors 'self'; form-action 'self'",
    )
    if COOKIE_SECURE:
        response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
    return response


_db_instance = None


def get_db():
    # PipelineDB opens a connection per operation. Reusing the instance avoids
    # running its schema setup for every request.
    global _db_instance
    if _db_instance is None:
        _db_instance = PipelineDB(DB_PATH)
    return _db_instance


def _youtube_cfg():
    return config.get("youtube", {})


def _youtube_client_secret_file() -> str:
    return _youtube_cfg().get("client_secrets_file", "client_secret.json")


def _youtube_credentials_file() -> str:
    return _youtube_cfg().get("credentials_file", "youtube_credentials.pkl")


def _client_secret_type(path: str) -> str:
    try:
        with open(path, encoding="utf-8") as f:
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
        status["updated_at"] = datetime.fromtimestamp(mtime, tz=UTC).isoformat()
        credentials = load_credentials(path)
        if credentials is None:
            status["error"] = "Could not read credentials"
            return status
        status["valid"] = bool(getattr(credentials, "valid", False))
        status["expired"] = bool(getattr(credentials, "expired", False))
        status["has_refresh_token"] = bool(getattr(credentials, "refresh_token", None))
        expiry = getattr(credentials, "expiry", None)
        if expiry:
            if expiry.tzinfo is None:
                expiry = expiry.replace(tzinfo=UTC)
            status["expiry"] = expiry.astimezone(UTC).isoformat()
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
    save_credentials(credentials, path)


def require_auth(request: Request):
    user = request.session.get("user")
    if not user:
        raise HTTPException(401, "Not authenticated")
    return user


# Use the proxy-controlled X-Real-IP header for login rate limits. Do not trust
# X-Forwarded-For because clients can control its first value.
TRUSTED_IP_HEADER = os.getenv("TRUSTED_IP_HEADER", "x-real-ip").lower()


def _client_ip(request: Request) -> str:
    value = request.headers.get(TRUSTED_IP_HEADER, "").strip()
    if value:
        return value.split(",")[-1].strip()
    return request.client.host if request.client else "unknown"


def _check_login_rate_limit(request: Request):
    ip = _client_ip(request)
    now = time.time()
    window = 300
    max_attempts = 8
    attempts = [ts for ts in _login_attempts.get(ip, []) if now - ts < window]
    if len(attempts) >= max_attempts:
        _login_attempts[ip] = attempts
        raise HTTPException(429, "Too many attempts. Wait a few minutes.")
    attempts.append(now)
    _login_attempts[ip] = attempts


def _clear_login_attempts(request: Request):
    _login_attempts.pop(_client_ip(request), None)


# =============================================================================
# Auth endpoints
# =============================================================================


@app.post("/api/login")
def api_login(request: Request, user: str = Form(...), password: str = Form(...)):
    _check_login_rate_limit(request)
    if secrets.compare_digest(user, ADMIN_USER) and secrets.compare_digest(password, ADMIN_PASSWORD):
        _clear_login_attempts(request)
        request.session.clear()
        request.session["user"] = user
        return {"status": "ok", "user": user}
    raise HTTPException(401, "Invalid credentials")


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
        "updated_at": datetime.now(UTC).isoformat(),
    }


@app.get("/api/vods")
def api_vods(
    status: str = None,
    channel: str = None,
    search: str = None,
    limit: int = 25,
    offset: int = 0,
    _: str = Depends(require_auth),
):
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
        raise HTTPException(404, "VOD not found")
    return vod


@app.post("/api/vods/{vod_id}/retry")
def api_vod_retry(vod_id: str, _: str = Depends(require_auth)):
    db = get_db()
    vod = db.get_vod(vod_id)
    if not vod:
        raise HTTPException(404, "VOD not found")
    db.reset_vod(vod_id)
    db.enqueue(
        {
            "vod_id": vod_id,
            "channel": vod["channel"],
            "video_id": vod["video_id"],
            "source": vod.get("source", "manual"),
            "start_time": 0,
            "tracker_url": vod.get("tracker_url"),
            "download_url": vod.get("download_url"),
        },
        force=True,
    )
    return {"status": "ok", "message": "VOD queued again"}


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
        raise HTTPException(404, "No progress found")
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
        "uptime": datetime.now(UTC).isoformat(),
    }


@app.post("/api/m3u8/resolve")
def api_resolve_m3u8(payload: dict, _: str = Depends(require_auth)):
    value = payload.get("input")
    if not isinstance(value, str):
        raise HTTPException(422, "The input field is required")
    try:
        return M3U8Resolver().resolve(value)
    except M3U8ResolveError as exc:
        raise HTTPException(422, str(exc)) from exc


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
        raise HTTPException(400, "client_secret.json is missing")

    client_type = _client_secret_type(client_secret_file)
    if client_type == "web":
        redirect_uri = _youtube_redirect_uri(request)
        mode = "web"
    elif client_type == "installed":
        redirect_uri = _youtube_installed_redirect_uri()
        mode = "installed"
    else:
        raise HTTPException(400, "client_secret.json is not a Web or Desktop OAuth application")

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
        raise HTTPException(400, "No Desktop OAuth renewal is pending")
    if not code_verifier:
        raise HTTPException(400, "Missing code_verifier; start the OAuth flow again")
    if time.time() - started_at > 15 * 60:
        for key in (
            "youtube_oauth_state",
            "youtube_oauth_redirect_uri",
            "youtube_oauth_mode",
            "youtube_oauth_code_verifier",
            "youtube_oauth_started_at",
        ):
            request.session.pop(key, None)
        raise HTTPException(400, "The OAuth flow expired; start it again")

    callback_url = str(payload.get("callback_url") or "")
    code = _extract_oauth_code(callback_url or str(payload.get("code") or ""))
    pasted_state = (parse_qs(urlparse(callback_url).query).get("state") or [""])[0] if callback_url else ""
    if pasted_state and not secrets.compare_digest(pasted_state, expected_state):
        raise HTTPException(400, "OAuth state mismatch; start the flow again")
    if not code:
        raise HTTPException(400, "The pasted value does not contain a code parameter")

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
            raise RuntimeError("Google did not return a refresh token")
        _write_youtube_credentials(credentials, _youtube_credentials_file())
        log.info("[YouTubeOAuth] YouTube token renewed through the desktop flow")
        return {"status": "ok"}
    except Exception as e:
        log.error("[YouTubeOAuth] Could not complete desktop OAuth: %s", e)
        raise HTTPException(400, f"Could not complete OAuth: {e}") from e
    finally:
        for key in (
            "youtube_oauth_state",
            "youtube_oauth_redirect_uri",
            "youtube_oauth_mode",
            "youtube_oauth_code_verifier",
            "youtube_oauth_started_at",
        ):
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
    for key in (
        "youtube_oauth_state",
        "youtube_oauth_redirect_uri",
        "youtube_oauth_mode",
        "youtube_oauth_code_verifier",
        "youtube_oauth_started_at",
    ):
        request.session.pop(key, None)

    if error:
        log.warning("[YouTubeOAuth] Google returned an error: %s", error)
        return done("error")
    if not code or not state or not expected_state or not redirect_uri or not code_verifier:
        log.warning("[YouTubeOAuth] Incomplete callback")
        return done("error")
    if not secrets.compare_digest(state, expected_state):
        log.warning("[YouTubeOAuth] Invalid state")
        return done("error")
    if time.time() - started_at > 15 * 60:
        log.warning("[YouTubeOAuth] State expired")
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
            log.warning("[YouTubeOAuth] Google did not return a refresh token")
            return done("error")
        _write_youtube_credentials(credentials, _youtube_credentials_file())
        log.info("[YouTubeOAuth] YouTube token renewed through the dashboard")
        return done("success")
    except Exception as e:
        log.error("[YouTubeOAuth] Could not renew the token: %s", e)
        return done("error")


@app.get("/healthz")
def healthz():
    return {"status": "ok", "timestamp": datetime.now(UTC).isoformat()}


@app.get("/api/logs")
def api_logs(lines: int = 100, _: str = Depends(require_auth)):
    lines = max(1, min(int(lines), 1000))
    if not os.path.exists(LOG_PATH):
        return {"logs": []}
    try:
        with open(LOG_PATH, encoding="utf-8", errors="ignore") as f:
            all_lines = f.readlines()
        tail = all_lines[-lines:] if len(all_lines) > lines else all_lines
        return {"logs": [line.rstrip("\n") for line in tail]}
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
        return JSONResponse(status_code=400, content={"error": "url_or_id is required"})

    parsed = parse_twitch_vod_url(url_or_id)
    if not parsed or not parsed.get("video_id"):
        return JSONResponse(status_code=400, content={"error": "Could not parse the URL or VOD ID"})

    db = get_db()
    vod_id = parsed["vod_id"]
    channel = (custom_channel or parsed.get("channel") or "manual").lower()
    video_id = parsed["video_id"]
    start_time = parsed.get("start_time", 0)
    tracker_url = parsed.get("tracker_url")
    download_url = parsed.get("download_url")
    if privacy not in {"private", "unlisted", "public"}:
        return JSONResponse(status_code=400, content={"error": "Invalid privacy value"})
    if not isinstance(tags, list):
        tags = []
    tags = [str(tag).strip()[:50] for tag in tags if str(tag).strip()][:20]

    if db.is_processed(vod_id):
        return JSONResponse(status_code=409, content={"error": "This VOD has already been processed", "vod_id": vod_id})

    source_meta = json.dumps(
        {
            "type": "manual_upload",
            "custom_title": custom_title,
            "privacy": privacy,
            "tags": tags,
        }
    )

    db.add_vod(vod_id, channel, video_id, source_meta, tracker_url=tracker_url, download_url=download_url)
    db.increment_stat(channel, "detected")
    db.enqueue(
        {
            "vod_id": vod_id,
            "channel": channel,
            "video_id": video_id,
            "source": source_meta,
            "start_time": start_time,
            "tracker_url": tracker_url,
            "download_url": download_url,
        }
    )

    return {"status": "queued", "vod_id": vod_id, "channel": channel, "video_id": video_id}


# =============================================================================
# FastAPI serves the compiled SPA from the same origin as the API.
# =============================================================================

DIST_DIR = Path(__file__).resolve().parent / "frontend" / "dist"
ASSETS_DIR = DIST_DIR / "assets"
INDEX_FILE = DIST_DIR / "index.html"

if ASSETS_DIR.is_dir():
    app.mount("/assets", StaticFiles(directory=ASSETS_DIR), name="assets")


@app.get("/{full_path:path}")
def spa(full_path: str):
    """Serve SPA routes and standalone static assets such as the favicon."""
    if full_path.startswith("api/"):
        raise HTTPException(404, "Not found")
    if full_path:
        candidate = (DIST_DIR / full_path).resolve()
        try:
            candidate.relative_to(DIST_DIR.resolve())
        except ValueError:
            raise HTTPException(404, "Not found") from None
        if candidate.is_file():
            return FileResponse(candidate)
    if INDEX_FILE.is_file():
        return FileResponse(INDEX_FILE)
    raise HTTPException(503, "Frontend not built; run `npm run build` in frontend/.")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8080)
