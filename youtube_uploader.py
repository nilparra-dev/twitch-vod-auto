import os
import pickle
import logging
import google.auth
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload
from googleapiclient.errors import HttpError
from retry import retry_with_backoff

SCOPES = ["https://www.googleapis.com/auth/youtube.upload"]
log = logging.getLogger("youtube")

class YouTubeUploader:
    def __init__(self, client_secrets_file: str, credentials_file: str = "youtube_credentials.pkl"):
        self.client_secrets_file = client_secrets_file
        self.credentials_file = credentials_file
        self.service = self._get_authenticated_service()

    def _get_authenticated_service(self):
        credentials = None

        if os.path.exists(self.credentials_file):
            with open(self.credentials_file, "rb") as token:
                credentials = pickle.load(token)

        if not credentials or not credentials.valid:
            if credentials and credentials.expired and credentials.refresh_token:
                log.info("Refrescando token de YouTube...")
                credentials.refresh(Request())
            else:
                if not os.path.exists(self.client_secrets_file):
                    raise FileNotFoundError(
                        f"No se encontró {self.client_secrets_file}. "
                        "Descárgalo desde Google Cloud Console > Credentials."
                    )
                log.info("Iniciando flujo OAuth de YouTube...")
                flow = InstalledAppFlow.from_client_secrets_file(
                    self.client_secrets_file, SCOPES
                )
                credentials = flow.run_local_server(port=0)

            with open(self.credentials_file, "wb") as token:
                pickle.dump(credentials, token)

        return build("youtube", "v3", credentials=credentials, cache_discovery=False)

    @retry_with_backoff(max_retries=3, base_delay=10.0, max_delay=300.0,
                        exceptions=(HttpError, Exception))
    def upload_video(self, file_path: str, title: str, description: str = "",
                     tags: list = None, category_id: str = "20",
                     privacy_status: str = "private", default_language: str = None,
                     made_for_kids: bool = False, thumbnail_path: str = None):
        if not os.path.exists(file_path):
            raise FileNotFoundError(f"No se encontró: {file_path}")

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

        log.info("Subiendo a YouTube: %s | Titulo: %s | Privacidad: %s",
                 os.path.basename(file_path), title, privacy_status)

        insert_request = self.service.videos().insert(
            part=",".join(body.keys()),
            body=body,
            media_body=MediaFileUpload(file_path, chunksize=-1, resumable=True),
        )

        try:
            response = insert_request.execute()
            vid = response["id"]
            log.info("Subida OK. Video ID: %s | URL: https://youtu.be/%s", vid, vid)

            # Subir thumbnail si existe
            if thumbnail_path and os.path.exists(thumbnail_path):
                self.set_thumbnail(vid, thumbnail_path)

            return response
        except HttpError as e:
            log.error("Error HTTP %s subiendo a YouTube: %s", e.resp.status, e._get_reason())
            raise

    def set_thumbnail(self, video_id: str, thumbnail_path: str):
        if not os.path.exists(thumbnail_path):
            return
        try:
            self.service.thumbnails().set(
                videoId=video_id,
                media_body=MediaFileUpload(thumbnail_path)
            ).execute()
            log.info("Miniatura actualizada para %s", video_id)
        except Exception as e:
            log.warning("No se pudo subir miniatura: %s", e)

if __name__ == "__main__":
    import json
    with open("config.json", "r", encoding="utf-8") as f:
        cfg = json.load(f)
    yt = YouTubeUploader(cfg["youtube"]["client_secrets_file"])
    print("Autenticación OK.")
