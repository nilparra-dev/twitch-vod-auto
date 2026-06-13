import logging
import os
import ssl
import time

from google.auth.exceptions import RefreshError
from google.auth.transport.requests import Request
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from googleapiclient.http import MediaFileUpload
from httplib2 import HttpLib2Error

from credentials_store import load_credentials, save_credentials


SCOPES = ["https://www.googleapis.com/auth/youtube.upload"]
log = logging.getLogger("youtube")

DEFAULT_UPLOAD_CHUNK_SIZE_MB = 64
RETRIABLE_UPLOAD_STATUS_CODES = {429, 500, 502, 503, 504}
RETRIABLE_UPLOAD_EXCEPTIONS = (HttpLib2Error, OSError, TimeoutError, ssl.SSLError)


class YouTubeAuthError(RuntimeError):
    """Raised when the saved OAuth credentials cannot be refreshed."""


class YouTubeUploader:
    def __init__(self, client_secrets_file: str, credentials_file: str = "youtube_credentials.pkl"):
        self.client_secrets_file = client_secrets_file
        self.credentials_file = credentials_file
        self.service = self._get_authenticated_service()

    @staticmethod
    def _is_invalid_grant(exc: Exception) -> bool:
        text = str(exc).lower()
        return "invalid_grant" in text or "expired or revoked" in text

    @staticmethod
    def _chunk_size_bytes(chunk_size_mb: int = DEFAULT_UPLOAD_CHUNK_SIZE_MB) -> int:
        try:
            mb = int(chunk_size_mb)
        except (TypeError, ValueError):
            mb = DEFAULT_UPLOAD_CHUNK_SIZE_MB
        mb = max(1, min(mb, 256))
        chunk = mb * 1024 * 1024
        multiple = 256 * 1024
        return max(multiple, chunk - (chunk % multiple))

    @staticmethod
    def _http_reason(error: HttpError) -> str:
        try:
            return error._get_reason()
        except Exception:
            return str(error)

    @staticmethod
    def _is_retriable_upload_error(error: Exception) -> bool:
        if isinstance(error, HttpError):
            return getattr(error.resp, "status", None) in RETRIABLE_UPLOAD_STATUS_CODES
        return isinstance(error, RETRIABLE_UPLOAD_EXCEPTIONS)

    def _archive_bad_credentials(self):
        if not os.path.exists(self.credentials_file):
            return None

        base = f"{self.credentials_file}.revoked"
        target = base
        idx = 1
        while os.path.exists(target):
            idx += 1
            target = f"{base}.{idx}"

        try:
            os.replace(self.credentials_file, target)
            return target
        except OSError as e:
            log.warning("No se pudo apartar el token OAuth invalido: %s", e)
            return None

    def _raise_invalid_grant(self, exc: Exception):
        archived = self._archive_bad_credentials()
        archived_msg = f" Se movio el token antiguo a {archived}." if archived else ""
        raise YouTubeAuthError(
            "Token de YouTube expirado o revocado (invalid_grant)."
            f"{archived_msg} Ejecuta `python youtube_uploader.py` en una sesion con navegador "
            "para generar un nuevo youtube_credentials.pkl y vuelve a lanzar el pipeline."
        ) from exc

    def _get_authenticated_service(self):
        credentials = load_credentials(self.credentials_file)

        if not credentials or not credentials.valid:
            if credentials and credentials.expired and credentials.refresh_token:
                log.info("Refrescando token de YouTube...")
                try:
                    credentials.refresh(Request())
                except RefreshError as e:
                    if self._is_invalid_grant(e):
                        self._raise_invalid_grant(e)
                    raise
            else:
                if not os.path.exists(self.client_secrets_file):
                    raise FileNotFoundError(
                        f"No se encontro {self.client_secrets_file}. "
                        "Descargalo desde Google Cloud Console > Credentials."
                    )
                log.info("Iniciando flujo OAuth de YouTube...")
                flow = InstalledAppFlow.from_client_secrets_file(
                    self.client_secrets_file, SCOPES
                )
                credentials = flow.run_local_server(port=0)

            save_credentials(credentials, self.credentials_file)

        return build("youtube", "v3", credentials=credentials, cache_discovery=False)

    def upload_video(
        self,
        file_path: str,
        title: str,
        description: str = "",
        tags: list = None,
        category_id: str = "20",
        privacy_status: str = "private",
        default_language: str = None,
        made_for_kids: bool = False,
        thumbnail_path: str = None,
        chunk_size_mb: int = DEFAULT_UPLOAD_CHUNK_SIZE_MB,
        progress_callback=None,
    ):
        if not os.path.exists(file_path):
            raise FileNotFoundError(f"No se encontro: {file_path}")

        file_size_mb = os.path.getsize(file_path) / 1024 / 1024
        chunk_size = self._chunk_size_bytes(chunk_size_mb)
        body = {
            "snippet": {
                "title": title,
                "description": description,
                "tags": tags or [],
                "categoryId": category_id,
            },
            "status": {
                "privacyStatus": privacy_status,
                "selfDeclaredMadeForKids": made_for_kids,
            },
        }
        if default_language:
            body["snippet"]["defaultLanguage"] = default_language

        log.info(
            "Subiendo a YouTube: %s | %.1f MB | chunk=%d MB | Titulo: %s | Privacidad: %s",
            os.path.basename(file_path),
            file_size_mb,
            chunk_size // 1024 // 1024,
            title,
            privacy_status,
        )

        insert_request = self.service.videos().insert(
            part=",".join(body.keys()),
            body=body,
            media_body=MediaFileUpload(
                file_path,
                mimetype="video/mp4",
                chunksize=chunk_size,
                resumable=True,
            ),
        )

        response = None
        retry_count = 0
        last_logged_percent = -1.0
        while response is None:
            try:
                status, response = insert_request.next_chunk(num_retries=3)
                retry_count = 0
                if status:
                    percent = status.progress() * 100
                    uploaded_mb = file_size_mb * status.progress()
                    if progress_callback:
                        progress_callback(percent, uploaded_mb, file_size_mb)
                    if percent - last_logged_percent >= 5 or percent >= 99.9:
                        log.info(
                            "[YouTubeUpload] %.1f%% (%.1f/%.1f MB)",
                            percent,
                            uploaded_mb,
                            file_size_mb,
                        )
                        last_logged_percent = percent
            except RefreshError as e:
                if self._is_invalid_grant(e):
                    self._raise_invalid_grant(e)
                raise
            except HttpError as e:
                if not self._is_retriable_upload_error(e) or retry_count >= 5:
                    log.error(
                        "Error HTTP %s subiendo a YouTube: %s",
                        e.resp.status,
                        self._http_reason(e),
                    )
                    raise
                retry_count += 1
                delay = min(120, 5 * (2 ** (retry_count - 1)))
                log.warning(
                    "[YouTubeUpload] Error temporal HTTP %s: %s. Reintento %d/5 en %ds",
                    e.resp.status,
                    self._http_reason(e),
                    retry_count,
                    delay,
                )
                time.sleep(delay)
            except RETRIABLE_UPLOAD_EXCEPTIONS as e:
                if retry_count >= 5:
                    raise
                retry_count += 1
                delay = min(120, 5 * (2 ** (retry_count - 1)))
                log.warning(
                    "[YouTubeUpload] Error temporal de red: %s. Reintento %d/5 en %ds",
                    e,
                    retry_count,
                    delay,
                )
                time.sleep(delay)

        if progress_callback:
            progress_callback(100.0, file_size_mb, file_size_mb)

        vid = response["id"]
        log.info("Subida OK. Video ID: %s | URL: https://youtu.be/%s", vid, vid)

        if thumbnail_path and os.path.exists(thumbnail_path):
            self.set_thumbnail(vid, thumbnail_path)

        return response

    def set_thumbnail(self, video_id: str, thumbnail_path: str):
        if not os.path.exists(thumbnail_path):
            return
        try:
            self.service.thumbnails().set(
                videoId=video_id,
                media_body=MediaFileUpload(thumbnail_path),
            ).execute()
            log.info("Miniatura actualizada para %s", video_id)
        except Exception as e:
            log.warning("No se pudo subir miniatura: %s", e)


if __name__ == "__main__":
    import json

    with open("config.json", "r", encoding="utf-8") as f:
        cfg = json.load(f)
    yt = YouTubeUploader(
        cfg["youtube"]["client_secrets_file"],
        cfg["youtube"].get("credentials_file", "youtube_credentials.pkl"),
    )
    print("Autenticacion OK.")
