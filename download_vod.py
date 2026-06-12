import subprocess
import os
import re
import json
import time
import logging
import platform
import shlex
from pathlib import Path
from tqdm import tqdm
from retry import retry_with_backoff
from thumbnail import ThumbnailGenerator
from utils import get_file_size_mb, parse_size_to_mb
from progress import DownloadProgress

log = logging.getLogger("download")

def _channel_twitch_config(config: dict, channel: str = None) -> dict:
    twitch_cfg = config.get("twitch", {})
    merged = dict(twitch_cfg.get("global", {}))
    if channel:
        for ch in twitch_cfg.get("channels", []):
            if ch.get("name", "").lower() == channel.lower():
                for key in ("cookies_file", "cookies_browser"):
                    if ch.get(key) is not None:
                        merged[key] = ch.get(key)
                break
    return merged


def _video_url(video_id: str) -> str:
    return f"https://www.twitch.tv/videos/{video_id}"


def _video_id_from_internal_vod_id(vod_id: str) -> str:
    if not vod_id.startswith("video:"):
        return ""
    body = vod_id.replace("video:", "", 1)
    parts = body.rsplit("_", 2)
    return parts[1] if len(parts) == 3 else ""


def download_vod_auto(
    vod_id: str,
    config: dict,
    output_filename: str = None,
    notifier=None,
    tracker_url: str = None,
    download_url: str = None,
    channel: str = None,
    video_id: str = None,
):
    download_cfg = config["download"]
    twitch_cfg = _channel_twitch_config(config, channel)
    
    save_path = download_cfg.get("output_folder", "./downloads")
    os.makedirs(save_path, exist_ok=True)
    
    if output_filename:
        filename = output_filename
    else:
        safe_vod = vod_id.replace(":", "_").replace("/", "_")
        filename = f"{safe_vod}.mp4"
    
    output_file = os.path.join(save_path, filename)
    
    # Evita descargar de nuevo si ya existe y es grande
    if os.path.exists(output_file) and os.path.getsize(output_file) > 10 * 1024 * 1024:
        log.info("[Download] El archivo ya existe y parece completo: %s", output_file)
        return output_file
    
    ffmpeg_folder = os.path.abspath(download_cfg.get("ffmpeg_folder", "./bin"))
    
    # Opciones de autenticacion
    auth_args = []
    cookies_file = twitch_cfg.get("cookies_file")
    if cookies_file and os.path.isfile(cookies_file):
        auth_args = ["--cookies", cookies_file]
        log.info("[Download] Usando cookies_file: %s", cookies_file)
    elif cookies_file:
        log.warning("[Download] cookies_file configurado pero no es un archivo valido: %s", cookies_file)
    elif twitch_cfg.get("cookies_browser"):
        auth_args = ["--cookies-from-browser", twitch_cfg["cookies_browser"]]
        log.info("[Download] Usando cookies_browser: %s", twitch_cfg["cookies_browser"])
    
    # Método nuevo: si tenemos tracker_url, usarla directamente (mejor para VODs privados)
    # Según twitch-dlp docs: npx twitch-dlp https://twitchtracker.com/CHANNEL/streams/VIDEO_ID
    if tracker_url:
        log.info("[Download] Usando tracker URL para VOD privado: %s", tracker_url)
        target = tracker_url
    elif download_url:
        target = download_url
    else:
        resolved_video_id = video_id or _video_id_from_internal_vod_id(vod_id)
        target = _video_url(resolved_video_id) if resolved_video_id else vod_id
    
    use_npx = download_cfg.get("use_npx", True)
    git_bash = download_cfg.get("git_bash_path")
    is_windows = platform.system() == "Windows"
    
    if use_npx and git_bash and is_windows:
        # Modo Windows con Git Bash (original)
        cookie_part = " ".join(shlex.quote(a) for a in auth_args)
        bash_cmd = (
            f'export PATH=$PATH:{shlex.quote(ffmpeg_folder)} && '
            f'npx twitch-dlp {shlex.quote(target)} -o {shlex.quote(output_file)} {cookie_part}'
        )
        
        log.info("[Download] Descargando VOD: %s", vod_id)
        log.info("[Download] Destino: %s", output_file)
        
        CREATE_NO_WINDOW = 0x08000000
        
        process = subprocess.Popen(
            [git_bash, "-c", bash_cmd],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            creationflags=CREATE_NO_WINDOW
        )
    else:
        # Modo Linux / headless / sin Git Bash
        # Intenta usar twitch-dlp directo o via npx sin bash intermedio
        twitch_dlp_cmd = "twitch-dlp"
        
        # Verificar si twitch-dlp esta disponible
        try:
            subprocess.run([twitch_dlp_cmd, "--version"], capture_output=True, timeout=5)
        except FileNotFoundError:
            # Probar con npx
            twitch_dlp_cmd = "npx"
            base_args = ["twitch-dlp"]
        else:
            base_args = []
        
        cmd = [twitch_dlp_cmd] + base_args + [target, "-o", output_file] + auth_args
        env = os.environ.copy()
        env["PATH"] = ffmpeg_folder + os.pathsep + env["PATH"]
        
        log.info("[Download] Descargando VOD: %s", vod_id)
        log.info("[Download] Target: %s", target)
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            env=env
        )
    
    # Inicializar progreso
    DownloadProgress.start(vod_id, channel=channel or "", video_id=video_id or "")

    # Progreso
    progress_pattern = re.compile(r"(\d{1,3}\.\d)%")
    speed_pattern = re.compile(r"at\s+([\d\.]+\s*[KMG]iB/s)")
    eta_pattern = re.compile(r"ETA\s+([\d:]+)")
    size_pattern = re.compile(r"of\s+([\d\.]+\s*[KMG]iB)")
    pbar = tqdm(total=100, bar_format="{l_bar}{bar}| {n_fmt}/{total_fmt} %", desc="Descarga", mininterval=1.0)

    last_update = 0
    last_log = 0
    start_ts = time.time()
    total_size_str = ""
    total_size_mb = 0.0
    log.info("[Download] Iniciando transferencia a disco...")
    for line in process.stdout:
        line = line.rstrip()
        match = progress_pattern.search(line)
        if match:
            percent = float(match.group(1))
            pbar.n = percent
            pbar.refresh()

            # Actualizar progreso en archivo cada 2 segundos para no saturar I/O
            now = time.time()
            if now - last_update > 2:
                speed_match = speed_pattern.search(line)
                eta_match = eta_pattern.search(line)
                size_match = size_pattern.search(line)
                speed = speed_match.group(1) if speed_match else ""
                eta = eta_match.group(1) if eta_match else ""
                if size_match and not total_size_str:
                    total_size_str = size_match.group(1)
                    total_size_mb = parse_size_to_mb(total_size_str)
                downloaded_mb = total_size_mb * (percent / 100.0) if total_size_mb else None
                elapsed = int(now - start_ts)
                DownloadProgress.update(
                    vod_id, percent=percent, speed=speed, eta=eta,
                    total_size_mb=total_size_mb or None,
                    downloaded_mb=downloaded_mb,
                    elapsed_seconds=elapsed,
                    stage="download",
                    message="Descargando VOD",
                    raw_line=line,
                )
                last_update = now

            # Log detallado cada 5s
            if now - last_log > 5:
                speed_match = speed_pattern.search(line)
                eta_match = eta_pattern.search(line)
                elapsed = int(now - start_ts)
                elapsed_str = f"{elapsed//60:02d}:{elapsed%60:02d}"
                speed = speed_match.group(1) if speed_match else "?"
                eta = eta_match.group(1) if eta_match else "?"
                size_info = f" de {total_size_str}" if total_size_str else ""
                log.info("[Download] %s | %5.1f%%%s | %s | ETA %s | transcurrido %s",
                         vod_id, percent, size_info, speed, eta, elapsed_str)
                last_log = now
        elif line.strip() and "[download]" in line and "Destination" not in line:
            # Capturar lineas relevantes no-progreso (errores, info, etc.)
            if any(kw in line.lower() for kw in ["error", "warning", "merging", "ffmpeg"]):
                log.info("[Download] %s", line)

    process.wait()
    pbar.close()

    # A veces twitch-dlp devuelve 0 antes de que ffmpeg termine el merge HLS->mp4
    # (el archivo puede aparecer segundos o incluso un minuto después). Polling.
    output_path = Path(output_file)
    parent_dir = output_path.parent
    final_name = output_path.name
    if not output_path.exists() or output_path.stat().st_size < 1024:
        log.warning("[Download] Archivo no presente tras exit (rc=%s), esperando merge/ffmpeg...",
                    process.returncode)
        for i in range(30):  # hasta 60s
            time.sleep(2)
            if output_path.exists() and output_path.stat().st_size > 1024:
                log.info("[Download] Archivo apareció tras %ds de espera", (i + 1) * 2)
                break
            parts = sorted(parent_dir.glob(final_name + ".*"),
                           key=lambda p: p.stat().st_mtime, reverse=True)
            for p in parts:
                if p == output_path:
                    continue
                if p.stat().st_size > 1024 * 1024:
                    log.info("[Download] Encontrado parcial %s (%.1f MB), esperando rename...",
                             p.name, p.stat().st_size / 1024 / 1024)

    elapsed_total = int(time.time() - start_ts)
    elapsed_str = f"{elapsed_total//60:02d}:{elapsed_total%60:02d}"
    if process.returncode == 0 and os.path.exists(output_file) and os.path.getsize(output_file) > 0:
        size_mb = get_file_size_mb(output_file)
        avg_speed = size_mb / max(elapsed_total, 1) * 60  # MB/min
        log.info("[Download] Completado: %s (%.1f MB) en %s (~%.1f MB/min)",
                 output_file, size_mb, elapsed_str, avg_speed)
        DownloadProgress.complete(vod_id, file_size_mb=size_mb)

        # Generar thumbnail automaticamente
        ffmpeg_exe = os.path.join(ffmpeg_folder, "ffmpeg")
        if is_windows:
            ffmpeg_exe += ".exe"
        thumb_gen = ThumbnailGenerator(
            ffmpeg_path=ffmpeg_exe if os.path.exists(ffmpeg_exe) else "ffmpeg"
        )
        thumb_gen.generate(output_file)

        return output_file
    else:
        error_msg = f"Codigo de salida: {process.returncode}"
        # Listar contenido del dir para debug
        try:
            parent = Path(output_file).parent
            contents = [f.name + f" ({p.stat().st_size//1024//1024}MB)"
                        for p in parent.iterdir() if p.is_file()]
            log.error("[Download] Error tras %s. %s. Dir: %s",
                      elapsed_str, error_msg, ", ".join(contents[:20]))
        except Exception as e:
            log.error("[Download] Error tras %s. %s (no se pudo listar dir: %s)",
                      elapsed_str, error_msg, e)
        DownloadProgress.fail(vod_id, error_msg)
        return None

@retry_with_backoff(max_retries=3, base_delay=5.0, max_delay=120.0)
def download_vod_with_retry(
    vod_id: str,
    config: dict,
    output_filename: str = None,
    notifier=None,
    tracker_url: str = None,
    download_url: str = None,
    channel: str = None,
    video_id: str = None,
):
    """Wrapper con retry exponencial + notificaciones opcionales."""
    result = download_vod_auto(
        vod_id,
        config,
        output_filename,
        notifier,
        tracker_url=tracker_url,
        download_url=download_url,
        channel=channel,
        video_id=video_id,
    )
    if not result:
        raise RuntimeError("Descarga fallida (sin archivo)")
    return result

if __name__ == "__main__":
    with open("config.json", "r", encoding="utf-8") as f:
        cfg = json.load(f)
    
    vod = input("VOD ID: ").strip()
    result = download_vod_with_retry(vod, cfg)
    if result:
        print(f"Archivo: {result}")
    else:
        print("Fallo la descarga")
