import os
import sys
import time
import json
import logging
import queue
import threading
import traceback
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

from db import PipelineDB
from monitor import VodMonitor
from download_vod import download_vod_with_retry
from youtube_uploader import YouTubeUploader
from thumbnail import ThumbnailGenerator
from progress import DownloadProgress
from utils import setup_logging, sanitize_filename, get_file_size_mb

log = logging.getLogger("pipeline")

class AutoPipeline:
    def __init__(self, config_path: str = "config.json"):
        with open(config_path, "r", encoding="utf-8") as f:
            self.config = json.load(f)

        # Logging
        app_cfg = self.config.get("app", {})
        setup_logging(
            log_level=app_cfg.get("log_level", "INFO"),
            log_file=app_cfg.get("log_file", "logs/pipeline.log")
        )

        # DB
        self.db = PipelineDB(self.config["monitoring"]["db_path"])
        self.monitor = VodMonitor(self.config, self.db)
        self.uploader = None

        # Workers / queue
        self.download_queue = queue.Queue()
        self.upload_queue = queue.Queue()
        self.running = True
        self._current_vod_id = None

        # Config de canales
        self.channel_cfgs = {ch["name"].lower(): ch for ch in self.config["twitch"]["channels"]}

        # Cleanup siempre activo (no quedan archivos locales)
        self.cleanup = True

        # Asegura directorios
        os.makedirs(self.config["download"]["output_folder"], exist_ok=True)

    def _get_uploader(self):
        if self.uploader is None:
            yt_cfg = self.config["youtube"]
            self.uploader = YouTubeUploader(
                yt_cfg["client_secrets_file"],
                yt_cfg.get("credentials_file", "youtube_credentials.pkl")
            )
        return self.uploader

    def _get_channel_config(self, channel: str):
        global_yt = self.config["youtube"].copy()
        ch = self.channel_cfgs.get(channel.lower(), {})
        overrides = ch.get("youtube_overrides", {})
        for k, v in overrides.items():
            global_yt[k] = v
        return global_yt

    def _safe_stream_date(self, start_time):
        try:
            if not start_time or start_time <= 0 or start_time > 9_999_999_999:
                return datetime.now(timezone.utc)
            return datetime.fromtimestamp(start_time, tz=timezone.utc)
        except (ValueError, OSError, OverflowError):
            return datetime.now(timezone.utc)

    def _generate_title(self, stream_info: dict, yt_cfg: dict) -> str:
        channel = stream_info["channel"]
        dt = self._safe_stream_date(stream_info.get("start_time", 0))
        date_str = f"{dt.day}/{dt.month}/{dt.year}"
        title = f"{channel} twitch vod - {date_str}"
        return title[:100]

    def _generate_description(self, stream_info: dict) -> str:
        channel = stream_info["channel"]
        dt = self._safe_stream_date(stream_info.get("start_time", 0))
        return (
            f"Stream de {channel} del {dt.strftime('%d/%m/%Y')}.\n\n"
            f"Video ID Twitch: {stream_info['video_id']}\n"
            f"VOD ID: {stream_info['vod_id']}\n\n"
            f"Subido automáticamente por twitch-vod-auto."
        )

    def _reencode_for_youtube(self, file_path: str) -> str:
        """Reencode el archivo a h264/aac + faststart para que YouTube lo procese siempre.
        Devuelve la ruta al nuevo archivo o None si falla (en cuyo caso se usa el original)."""
        try:
            download_cfg = self.config.get("download", {})
            ffmpeg_folder = os.path.abspath(download_cfg.get("ffmpeg_folder", "./bin"))
            ffmpeg_exe = os.path.join(ffmpeg_folder, "ffmpeg")
            if not os.path.exists(ffmpeg_exe):
                ffmpeg_exe = "ffmpeg"

            src = Path(file_path)
            tmp = src.with_name(src.stem + "_yt.mp4")
            if tmp.exists():
                tmp.unlink()

            cmd = [
                ffmpeg_exe, "-y", "-i", str(src),
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
                "-c:a", "aac", "-b:a", "160k",
                "-movflags", "+faststart",
                "-progress", "pipe:1", "-nostats",
                str(tmp),
            ]

            log.info("[Reencode] Iniciando: %s -> %s", src.name, tmp.name)
            start = time.time()
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)

            last_pct_log = 0
            for line in proc.stdout:
                line = line.strip()
                if line.startswith("out_time_ms="):
                    # ffmpeg -progress emite out_time_ms=...; lo ignoramos, usamos size
                    continue
                if "size=" in line and ("speed=" in line or "time=" in line):
                    pct_match = None
                    if "time=" in line:
                        # No tenemos duración total, mostramos progreso por tamaño
                        pass
                    # Loguear cada ~10s
                    now = time.time()
                    if now - last_pct_log > 10:
                        log.info("[Reencode] %s: %s", src.name, line[:200])
                        last_pct_log = now

            proc.wait()
            elapsed = int(time.time() - start)

            if proc.returncode == 0 and tmp.exists() and tmp.stat().st_size > 1024:
                # Reemplazar original
                try:
                    src.unlink()
                except Exception:
                    pass
                tmp.rename(src)
                new_size = src.stat().st_size / 1024 / 1024
                log.info("[Reencode] OK: %s -> %.1f MB en %ds", src.name, new_size, elapsed)
                DownloadProgress.update(
                    self._current_vod_id or "", percent=100.0,
                    file_size_mb=new_size, elapsed_seconds=elapsed,
                )
                return str(src)
            else:
                log.error("[Reencode] Fallo rc=%s, size=%s", proc.returncode,
                          tmp.stat().st_size if tmp.exists() else 0)
                if tmp.exists():
                    tmp.unlink()
                return None
        except Exception as e:
            log.error("[Reencode] Excepcion: %s", e)
            return None

    def _download_worker(self):
        while self.running:
            try:
                item = self.download_queue.get(timeout=5)
            except queue.Empty:
                continue

            vod_id = item["vod_id"]
            channel = item["channel"]
            video_id = item["video_id"]
            source = item.get("source", "unknown")
            start_time = item.get("start_time", 0)
            self._current_vod_id = vod_id

            log.info("[DownloadWorker] Iniciando descarga: %s", vod_id)
            self.db.update_vod_status(vod_id, "downloading")

            safe_name = sanitize_filename(f"{channel}_{video_id}")
            output_filename = f"{safe_name}.mp4"

            try:
                tracker_url = item.get("tracker_url")
                file_path = download_vod_with_retry(vod_id, self.config, output_filename=output_filename, tracker_url=tracker_url)
            except Exception as e:
                err = f"Descarga fallida tras retries: {e}"
                self.db.update_vod_status(vod_id, "failed", error=err)
                self.db.mark_queue_status(vod_id, "failed", error=err)
                self.db.increment_stat(channel, "failed")
                log.error("[DownloadWorker] ERROR %s: %s", vod_id, err)
                self.download_queue.task_done()
                continue

            if file_path and os.path.exists(file_path):
                # Reencode a h264/aac para que YouTube lo procese siempre bien
                if self.config.get("download", {}).get("reencode_for_youtube", True):
                    log.info("[DownloadWorker] Reencoding para YouTube...")
                    self.db.update_vod_status(vod_id, "encoding")
                    DownloadProgress.update(vod_id, percent=100.0)
                    reencoded = self._reencode_for_youtube(file_path)
                    if reencoded:
                        file_path = reencoded

                size_mb = get_file_size_mb(file_path)
                self.db.update_vod_status(vod_id, "downloaded", file_path=file_path, file_size_mb=size_mb)
                self.db.mark_queue_status(vod_id, "completed")
                self.upload_queue.put({
                    "vod_id": vod_id,
                    "channel": channel,
                    "video_id": video_id,
                    "source": source,
                    "start_time": start_time,
                    "file_path": file_path
                })
                log.info("[DownloadWorker] Descarga OK: %s -> %s (%.1f MB)", vod_id, file_path, size_mb)
            else:
                err = "Fallo la descarga o archivo no generado"
                self.db.update_vod_status(vod_id, "failed", error=err)
                self.db.mark_queue_status(vod_id, "failed", error=err)
                self.db.increment_stat(channel, "failed")
                log.error("[DownloadWorker] ERROR %s: %s", vod_id, err)

            self.download_queue.task_done()

    def _upload_worker(self):
        while self.running:
            try:
                item = self.upload_queue.get(timeout=5)
            except queue.Empty:
                continue

            vod_id = item["vod_id"]
            channel = item["channel"]
            file_path = item["file_path"]
            stream_info = {
                "channel": channel,
                "video_id": item["video_id"],
                "vod_id": vod_id,
                "start_time": item["start_time"]
            }

            log.info("[UploadWorker] Iniciando subida: %s", vod_id)
            self.db.update_vod_status(vod_id, "uploading")

            try:
                yt_cfg = self._get_channel_config(channel)
                title = self._generate_title(stream_info, yt_cfg)
                description = self._generate_description(stream_info)

                # Thumbnail
                thumb_path = str(Path(file_path).with_suffix(".jpg"))
                if not os.path.exists(thumb_path):
                    thumb_path = None

                response = self._get_uploader().upload_video(
                    file_path=file_path,
                    title=title,
                    description=description,
                    tags=yt_cfg.get("tags", self.config["youtube"]["default_tags"]),
                    category_id=yt_cfg.get("category_id", self.config["youtube"]["default_category_id"]),
                    privacy_status=yt_cfg.get("privacy_status", self.config["youtube"]["default_privacy_status"]),
                    thumbnail_path=thumb_path,
                )

                youtube_id = response["id"]
                size_mb = get_file_size_mb(file_path)
                self.db.update_vod_status(vod_id, "uploaded", youtube_id=youtube_id)
                self.db.increment_stat(channel, "uploaded")
                log.info("[UploadWorker] Subida OK %s -> https://youtu.be/%s", vod_id, youtube_id)

            except Exception as e:
                err = str(e)
                self.db.update_vod_status(vod_id, "failed", error=err)
                self.db.increment_stat(channel, "failed")
                log.error("[UploadWorker] ERROR subiendo %s: %s", vod_id, err)
                traceback.print_exc()

            finally:
                # Limpieza SIEMPRE (el usuario lo pidio)
                if os.path.exists(file_path):
                    try:
                        os.remove(file_path)
                        log.info("[UploadWorker] Archivo local eliminado: %s", file_path)
                    except Exception as e:
                        log.warning("[UploadWorker] No se pudo eliminar %s: %s", file_path, e)
                # Eliminar thumbnail tambien
                thumb = str(Path(file_path).with_suffix(".jpg"))
                if os.path.exists(thumb):
                    try:
                        os.remove(thumb)
                    except Exception:
                        pass

            self.upload_queue.task_done()

    def _start_workers(self):
        max_dl = self.config["app"].get("max_workers_download", 2)
        max_ul = self.config["app"].get("max_workers_upload", 1)

        log.info("[Pipeline] Arrancando %d download workers y %d upload workers", max_dl, max_ul)

        self.dl_threads = []
        for _ in range(max_dl):
            t = threading.Thread(target=self._download_worker, daemon=True)
            t.start()
            self.dl_threads.append(t)

        self.ul_threads = []
        for _ in range(max_ul):
            t = threading.Thread(target=self._upload_worker, daemon=True)
            t.start()
            self.ul_threads.append(t)

        # Hilo separado para verificar cola manual cada 5 segundos
        self.manual_queue_thread = threading.Thread(target=self._manual_queue_loop, daemon=True)
        self.manual_queue_thread.start()
        log.info("[Pipeline] Hilo de cola manual iniciado (chequeo cada 5s)")

    def _manual_queue_loop(self):
        """Loop infinito que revisa la cola manual de la DB cada 5 segundos."""
        while self.running:
            try:
                count = 0
                while True:
                    had = self._check_manual_queue()
                    if not had:
                        break
                    count += 1
                if count > 0:
                    log.info("[Pipeline] %d VOD(s) encolado(s) desde cola manual", count)
            except Exception as e:
                log.error("[Pipeline] ERROR en hilo de cola manual: %s", e)
                traceback.print_exc()
            time.sleep(5)

    def _check_manual_queue(self):
        """Lee la cola manual de la DB y la pone en la queue de Python."""
        try:
            queued = self.db.dequeue()
            if queued:
                item = {
                    "vod_id": queued["vod_id"],
                    "channel": queued["channel"],
                    "video_id": queued["video_id"],
                    "source": queued.get("source", "manual"),
                    "start_time": queued.get("start_time", 0),
                    "tracker_url": queued.get("tracker_url"),
                }
                self.download_queue.put(item)
                log.info("[Pipeline] Encolado desde cola manual: %s", item["vod_id"])
                return True
        except Exception as e:
            log.error("[Pipeline] ERROR leyendo cola manual: %s", e)
        return False

    def run_once(self):
        log.info("=" * 60)
        log.info("[Pipeline] Ciclo de monitoreo: %s", datetime.now(timezone.utc).isoformat())
        log.info("=" * 60)

        # Monitorear canales automáticos
        try:
            new_streams = self.monitor.check_all_channels()
        except Exception as e:
            log.error("[Pipeline] ERROR en monitoreo: %s", e)
            traceback.print_exc()
            return

        if not new_streams:
            log.info("[Pipeline] No hay streams nuevos.")
        else:
            for s in new_streams:
                self.download_queue.put(s)
                log.info("[Pipeline] Encolado para descarga: %s", s["vod_id"])

    def run_loop(self):
        interval = self.config["twitch"]["global"].get("check_interval_minutes", 30)
        interval_seconds = interval * 60

        self._start_workers()

        log.info("[Pipeline] Bucle automatico iniciado. Intervalo: %d min", interval)
        log.info("[Pipeline] Presiona Ctrl+C para detener")

        while self.running:
            try:
                self.run_once()
            except KeyboardInterrupt:
                log.info("[Pipeline] Detenido por usuario.")
                self.running = False
                break
            except Exception as e:
                log.error("[Pipeline] ERROR inesperado: %s", e)
                traceback.print_exc()

            if self.running:
                log.info("[Pipeline] Proximo chequeo en %d minutos...", interval)
                try:
                    time.sleep(interval_seconds)
                except KeyboardInterrupt:
                    log.info("[Pipeline] Detenido por usuario.")
                    self.running = False

        log.info("[Pipeline] Esperando que terminen workers...")
        self.download_queue.join()
        self.upload_queue.join()
        log.info("[Pipeline] Apagado completo.")

if __name__ == "__main__":
    pipeline = AutoPipeline(os.getenv("CONFIG_PATH", "config.json"))
    if len(sys.argv) > 1 and sys.argv[1] == "--once":
        pipeline.run_once()
    else:
        pipeline.run_loop()
