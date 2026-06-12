import json
import os
import time
import threading
from datetime import datetime, timezone

# Archivo compartido para trackear progreso de descargas en tiempo real
PROGRESS_FILE = "data/download_progress.json"
_lock = threading.Lock()

class DownloadProgress:
    """Guarda y lee el progreso de descargas en un archivo JSON compartido."""

    @staticmethod
    def _read():
        try:
            if os.path.exists(PROGRESS_FILE):
                with open(PROGRESS_FILE, "r", encoding="utf-8") as f:
                    return json.load(f)
        except (json.JSONDecodeError, IOError):
            pass
        return {}

    @staticmethod
    def _write(data):
        os.makedirs(os.path.dirname(PROGRESS_FILE), exist_ok=True)
        with open(PROGRESS_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

    @staticmethod
    def start(vod_id, channel, video_id):
        """Marca el inicio de una descarga."""
        with _lock:
            data = DownloadProgress._read()
            data[vod_id] = {
                "vod_id": vod_id,
                "channel": channel,
                "video_id": video_id,
                "status": "downloading",
                "percent": 0.0,
                "speed": "",
                "eta": "",
                "file_size_mb": 0,
                "started_at": datetime.now(timezone.utc).isoformat(),
                "updated_at": datetime.now(timezone.utc).isoformat(),
                "error": None
            }
            DownloadProgress._write(data)

    @staticmethod
    def update(vod_id, percent=None, speed=None, eta=None, file_size_mb=None,
               total_size_mb=None, downloaded_mb=None, elapsed_seconds=None):
        """Actualiza el progreso de una descarga."""
        with _lock:
            data = DownloadProgress._read()
            if vod_id not in data:
                return
            if percent is not None:
                data[vod_id]["percent"] = round(percent, 1)
            if speed is not None:
                data[vod_id]["speed"] = speed
            if eta is not None:
                data[vod_id]["eta"] = eta
            if file_size_mb is not None:
                data[vod_id]["file_size_mb"] = round(file_size_mb, 1)
            if total_size_mb is not None:
                data[vod_id]["total_size_mb"] = round(total_size_mb, 1)
            if downloaded_mb is not None:
                data[vod_id]["downloaded_mb"] = round(downloaded_mb, 1)
            if elapsed_seconds is not None:
                data[vod_id]["elapsed_seconds"] = int(elapsed_seconds)
            data[vod_id]["updated_at"] = datetime.now(timezone.utc).isoformat()
            DownloadProgress._write(data)

    @staticmethod
    def complete(vod_id, file_size_mb=None):
        """Marca una descarga como completada."""
        with _lock:
            data = DownloadProgress._read()
            if vod_id not in data:
                return
            data[vod_id]["status"] = "completed"
            data[vod_id]["percent"] = 100.0
            if file_size_mb:
                data[vod_id]["file_size_mb"] = round(file_size_mb, 1)
            data[vod_id]["completed_at"] = datetime.now(timezone.utc).isoformat()
            data[vod_id]["updated_at"] = datetime.now(timezone.utc).isoformat()
            DownloadProgress._write(data)

    @staticmethod
    def fail(vod_id, error):
        """Marca una descarga como fallida."""
        with _lock:
            data = DownloadProgress._read()
            if vod_id not in data:
                return
            data[vod_id]["status"] = "failed"
            data[vod_id]["error"] = str(error)
            data[vod_id]["updated_at"] = datetime.now(timezone.utc).isoformat()
            DownloadProgress._write(data)

    @staticmethod
    def get_all():
        """Retorna todos los progresos activos."""
        return DownloadProgress._read()

    @staticmethod
    def get(vod_id):
        """Retorna el progreso de un VOD específico."""
        data = DownloadProgress._read()
        return data.get(vod_id)

    @staticmethod
    def cleanup_old(max_age_seconds=3600, stale_downloading_seconds=300):
        """Elimina entradas antiguas completadas/fallidas y stuck 'downloading'."""
        with _lock:
            data = DownloadProgress._read()
            now = datetime.now(timezone.utc).timestamp()
            to_delete = []
            for vod_id, info in data.items():
                status = info.get("status")
                updated = info.get("updated_at", "")
                try:
                    dt = datetime.fromisoformat(updated.replace("Z", "+00:00"))
                    age = now - dt.timestamp()
                except Exception:
                    age = 0
                if status in ("completed", "failed") and age > max_age_seconds:
                    to_delete.append(vod_id)
                elif status == "downloading" and age > stale_downloading_seconds:
                    to_delete.append(vod_id)
            for vod_id in to_delete:
                del data[vod_id]
            if to_delete:
                DownloadProgress._write(data)

    @staticmethod
    def clear(vod_id):
        """Elimina un VOD del progreso."""
        with _lock:
            data = DownloadProgress._read()
            if vod_id in data:
                del data[vod_id]
                DownloadProgress._write(data)
