import json
import logging
import os
import platform
import re
import shlex
import subprocess
import time
from pathlib import Path

from retry import retry_with_backoff
from thumbnail import ThumbnailGenerator
from utils import get_file_size_mb, parse_size_to_mb
from progress import DownloadProgress


log = logging.getLogger("download")
MIN_DOWNLOAD_FILE_BYTES = 1024 * 1024
OUTPUT_TAIL_LINES = 40


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


def _default_twitch_dlp_args() -> list:
    if platform.system() == "Windows":
        return []
    args = ["--webbrowser-headless", "yes"]
    for browser in ("/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"):
        if os.path.exists(browser):
            args += ["--webbrowser-executable", browser]
            break
    return args


def _extra_twitch_dlp_args(download_cfg: dict) -> list:
    configured = download_cfg.get("twitch_dlp_args")
    if configured is None:
        return _default_twitch_dlp_args()
    if not isinstance(configured, list):
        log.warning("[Download] twitch_dlp_args debe ser una lista; se ignora")
        return _default_twitch_dlp_args()
    return [str(arg) for arg in configured if str(arg).strip()]


def _is_video_candidate(path: Path, started_at: float = None) -> bool:
    try:
        if not path.is_file() or path.suffix.lower() not in {".mp4", ".mkv", ".ts"}:
            return False
        if path.stat().st_size < MIN_DOWNLOAD_FILE_BYTES:
            return False
        if started_at is not None and path.stat().st_mtime < started_at - 5:
            return False
        return True
    except OSError:
        return False


def _find_download_result(output_path: Path, video_id: str = None, started_at: float = None) -> Path:
    if _is_video_candidate(output_path):
        return output_path

    parent = output_path.parent
    if not parent.exists():
        return None

    patterns = [f"{output_path.name}.*", f"{output_path.stem}.*"]
    if video_id and str(video_id).isdigit():
        patterns.append(f"*{video_id}*")

    candidates = []
    for pattern in patterns:
        for candidate in parent.glob(pattern):
            if _is_video_candidate(candidate, started_at=started_at):
                candidates.append(candidate)

    if not candidates:
        return None
    return max(candidates, key=lambda p: p.stat().st_mtime)


def _fragment_bases(output_path: Path, video_id: str = None) -> list:
    parent = output_path.parent
    if not parent.exists():
        return []

    patterns = [f"{output_path.name}.part-Frag*", f"{output_path.stem}*.part-Frag*"]
    if video_id and str(video_id).isdigit():
        patterns.append(f"*{video_id}*.part-Frag*")

    bases = {}
    for pattern in patterns:
        for fragment in parent.glob(pattern):
            if not fragment.is_file() or ".part-Frag" not in fragment.name:
                continue
            base_name = fragment.name.split(".part-Frag", 1)[0]
            base_path = parent / base_name
            try:
                stat = fragment.stat()
            except OSError:
                continue
            item = bases.setdefault(str(base_path), {"path": base_path, "count": 0, "mtime": 0.0})
            item["count"] += 1
            item["mtime"] = max(item["mtime"], stat.st_mtime)

    ordered = sorted(bases.values(), key=lambda item: (item["count"], item["mtime"]), reverse=True)
    return [item["path"] for item in ordered]


def _fragment_count(base_path: Path) -> int:
    return len(list(base_path.parent.glob(base_path.name + ".part-Frag*")))


def _dir_contents_for_log(parent: Path, video_id: str = None, output_stem: str = None) -> list:
    files = [p for p in parent.iterdir() if p.is_file()]
    relevant = []
    if video_id:
        relevant.extend([p for p in files if str(video_id) in p.name])
    if output_stem:
        relevant.extend([p for p in files if p.name.startswith(output_stem)])

    selected = []
    seen = set()
    for p in relevant:
        key = str(p)
        if key not in seen:
            seen.add(key)
            selected.append(p)

    if not selected:
        selected = sorted(files, key=lambda p: p.stat().st_mtime, reverse=True)

    return [
        f"{p.name} ({p.stat().st_size // 1024 // 1024}MB)"
        for p in selected
    ]


def _build_target(vod_id: str, tracker_url: str = None, download_url: str = None, video_id: str = None) -> str:
    if tracker_url:
        log.info("[Download] Usando tracker URL para VOD privado: %s", tracker_url)
        return tracker_url
    if download_url:
        return download_url
    resolved_video_id = video_id or _video_id_from_internal_vod_id(vod_id)
    return _video_url(resolved_video_id) if resolved_video_id else vod_id


def _build_command(
    target: str,
    output_file: str,
    ffmpeg_folder: str,
    download_cfg: dict,
    is_windows: bool,
) -> tuple:
    use_npx = download_cfg.get("use_npx", True)
    git_bash = download_cfg.get("git_bash_path")
    twitch_dlp_args = _extra_twitch_dlp_args(download_cfg)

    if use_npx and git_bash and is_windows:
        bash_cmd = (
            f"export PATH=$PATH:{shlex.quote(ffmpeg_folder)} && "
            f"npx twitch-dlp {shlex.quote(target)} -o {shlex.quote(output_file)} "
            f'{" ".join(shlex.quote(a) for a in twitch_dlp_args)}'
        )
        return [git_bash, "-c", bash_cmd], None

    twitch_dlp_cmd = "twitch-dlp"
    try:
        subprocess.run([twitch_dlp_cmd, "--version"], capture_output=True, timeout=5)
        base_args = []
    except FileNotFoundError:
        twitch_dlp_cmd = "npx"
        base_args = ["twitch-dlp"]

    cmd = [twitch_dlp_cmd] + base_args + [target, "-o", output_file] + twitch_dlp_args
    env = os.environ.copy()
    env["PATH"] = ffmpeg_folder + os.pathsep + env["PATH"]
    return cmd, env


def _build_merge_command(base_path: Path, ffmpeg_folder: str, download_cfg: dict, is_windows: bool) -> tuple:
    use_npx = download_cfg.get("use_npx", True)
    git_bash = download_cfg.get("git_bash_path")
    base = str(base_path)

    if use_npx and git_bash and is_windows:
        bash_cmd = (
            f"export PATH=$PATH:{shlex.quote(ffmpeg_folder)} && "
            f"npx twitch-dlp {shlex.quote(base)} --merge-fragments"
        )
        return [git_bash, "-c", bash_cmd], None

    twitch_dlp_cmd = "twitch-dlp"
    try:
        subprocess.run([twitch_dlp_cmd, "--version"], capture_output=True, timeout=5)
        base_args = []
    except FileNotFoundError:
        twitch_dlp_cmd = "npx"
        base_args = ["twitch-dlp"]

    cmd = [twitch_dlp_cmd] + base_args + [base, "--merge-fragments"]
    env = os.environ.copy()
    env["PATH"] = ffmpeg_folder + os.pathsep + env["PATH"]
    return cmd, env


def _try_merge_fragments(output_path: Path, video_id: str, ffmpeg_folder: str, download_cfg: dict, is_windows: bool) -> Path:
    for base_path in _fragment_bases(output_path, video_id=video_id):
        count = _fragment_count(base_path)
        if count <= 0:
            continue
        log.info("[Download] Intentando merge de %d fragmentos existentes: %s", count, base_path)
        cmd, env = _build_merge_command(base_path, ffmpeg_folder, download_cfg, is_windows)
        popen_kwargs = {
            "stdout": subprocess.PIPE,
            "stderr": subprocess.STDOUT,
            "text": True,
        }
        if env is not None:
            popen_kwargs["env"] = env
        if is_windows:
            popen_kwargs["creationflags"] = 0x08000000

        process = subprocess.Popen(cmd, **popen_kwargs)
        tail = []
        for line in process.stdout:
            line = line.rstrip()
            if line.strip():
                tail.append(line[:1000])
                tail = tail[-10:]
                lower_line = line.lower()
                if any(kw in lower_line for kw in ["error", "warning", "merging", "ffmpeg", "download"]):
                    log.info("[Download][Merge] %s", line[:500])
        process.wait()

        merged = _find_download_result(base_path, video_id=video_id)
        if process.returncode == 0 and merged and merged.exists():
            log.info("[Download] Merge de fragmentos OK: %s", merged)
            return merged
        log.warning(
            "[Download] Merge de fragmentos fallo rc=%s para %s. Ultima salida: %s",
            process.returncode,
            base_path,
            " || ".join(tail[-5:]),
        )

    return None


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
    output_path = Path(output_file)

    if _is_video_candidate(output_path):
        log.info("[Download] El archivo ya existe y parece completo: %s", output_file)
        return output_file

    cookies_file = twitch_cfg.get("cookies_file")
    if cookies_file and not os.path.isfile(cookies_file):
        log.warning("[Download] cookies_file configurado pero no es un archivo valido: %s", cookies_file)
    elif cookies_file:
        log.info("[Download] cookies_file configurado (%s), pero twitch-dlp no soporta --cookies; se ignora", cookies_file)
    elif twitch_cfg.get("cookies_browser"):
        log.info(
            "[Download] cookies_browser configurado (%s), pero twitch-dlp no soporta --cookies-from-browser; se ignora",
            twitch_cfg["cookies_browser"],
        )

    ffmpeg_folder = os.path.abspath(download_cfg.get("ffmpeg_folder", "./bin"))
    target = _build_target(vod_id, tracker_url=tracker_url, download_url=download_url, video_id=video_id)
    is_windows = platform.system() == "Windows"
    cmd, env = _build_command(target, output_file, ffmpeg_folder, download_cfg, is_windows)

    log.info("[Download] Descargando VOD: %s", vod_id)
    log.info("[Download] Target: %s", target)
    if env is None:
        log.info("[Download] Destino: %s", output_file)

    popen_kwargs = {
        "stdout": subprocess.PIPE,
        "stderr": subprocess.STDOUT,
        "text": True,
    }
    if env is not None:
        popen_kwargs["env"] = env
    if is_windows:
        popen_kwargs["creationflags"] = 0x08000000

    process = subprocess.Popen(cmd, **popen_kwargs)

    DownloadProgress.start(vod_id, channel=channel or "", video_id=video_id or "")

    progress_pattern = re.compile(r"(\d{1,3}\.\d)%")
    speed_pattern = re.compile(r"at\s+([\d\.]+\s*[KMG]iB/s)")
    eta_pattern = re.compile(r"ETA\s+([\d:]+)")
    size_pattern = re.compile(r"of\s+([\d\.]+\s*[KMG]iB)")

    last_update = 0
    last_log = 0
    start_ts = time.time()
    total_size_str = ""
    total_size_mb = 0.0
    output_tail = []
    error_lines = []

    log.info("[Download] Iniciando transferencia a disco...")
    for line in process.stdout:
        line = line.rstrip()
        if line.strip():
            output_tail.append(line[:1000])
            output_tail = output_tail[-OUTPUT_TAIL_LINES:]
            lower_line = line.lower()
            if lower_line.startswith("error") or "error:" in lower_line:
                error_lines.append(line[:1000])
                error_lines = error_lines[-10:]

        match = progress_pattern.search(line)
        if match:
            percent = float(match.group(1))
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
                    vod_id,
                    percent=percent,
                    speed=speed,
                    eta=eta,
                    total_size_mb=total_size_mb or None,
                    downloaded_mb=downloaded_mb,
                    elapsed_seconds=elapsed,
                    stage="download",
                    message="Descargando VOD",
                    raw_line=line,
                )
                last_update = now

            if now - last_log > 5:
                speed_match = speed_pattern.search(line)
                eta_match = eta_pattern.search(line)
                elapsed = int(now - start_ts)
                elapsed_str = f"{elapsed//60:02d}:{elapsed%60:02d}"
                speed = speed_match.group(1) if speed_match else "?"
                eta = eta_match.group(1) if eta_match else "?"
                size_info = f" de {total_size_str}" if total_size_str else ""
                log.info(
                    "[Download] %s | %5.1f%%%s | %s | ETA %s | transcurrido %s",
                    vod_id,
                    percent,
                    size_info,
                    speed,
                    eta,
                    elapsed_str,
                )
                last_log = now
        elif line.strip():
            lower_line = line.lower()
            if any(kw in lower_line for kw in ["error", "warning", "merging", "ffmpeg", "format", "vod", "download"]):
                log.info("[Download] %s", line[:500])

    process.wait()

    parent_dir = output_path.parent
    final_name = output_path.name
    final_path = _find_download_result(output_path, video_id=video_id, started_at=start_ts)
    if final_path and final_path != output_path:
        log.info("[Download] Archivo generado con nombre distinto: %s", final_path)

    if not final_path and not error_lines:
        log.warning("[Download] Archivo no presente tras exit (rc=%s), esperando merge/ffmpeg...", process.returncode)
        for i in range(30):
            time.sleep(2)
            final_path = _find_download_result(output_path, video_id=video_id, started_at=start_ts)
            if final_path:
                log.info("[Download] Archivo aparecio tras %ds de espera: %s", (i + 1) * 2, final_path)
                break
            parts = sorted(
                set(parent_dir.glob(final_name + ".*")) | set(parent_dir.glob(output_path.stem + ".*")),
                key=lambda p: p.stat().st_mtime,
                reverse=True,
            )
            for p in parts:
                if p == output_path:
                    continue
                if p.stat().st_size > MIN_DOWNLOAD_FILE_BYTES:
                    log.info(
                        "[Download] Encontrado parcial %s (%.1f MB), esperando rename...",
                        p.name,
                        p.stat().st_size / 1024 / 1024,
                    )

    elapsed_total = int(time.time() - start_ts)
    elapsed_str = f"{elapsed_total//60:02d}:{elapsed_total%60:02d}"
    if not final_path:
        final_path = _try_merge_fragments(output_path, video_id, ffmpeg_folder, download_cfg, is_windows)

    if final_path and final_path.exists():
        output_file = str(final_path)
        size_mb = get_file_size_mb(output_file)
        avg_speed = size_mb / max(elapsed_total, 1) * 60
        log.info("[Download] Completado: %s (%.1f MB) en %s (~%.1f MB/min)", output_file, size_mb, elapsed_str, avg_speed)
        DownloadProgress.complete(vod_id, file_size_mb=size_mb)

        ffmpeg_exe = os.path.join(ffmpeg_folder, "ffmpeg")
        if is_windows:
            ffmpeg_exe += ".exe"
        thumb_gen = ThumbnailGenerator(ffmpeg_path=ffmpeg_exe if os.path.exists(ffmpeg_exe) else "ffmpeg")
        thumb_gen.generate(output_file)

        return output_file

    if error_lines:
        error_msg = "twitch-dlp reporto error: " + " | ".join(error_lines[-3:])
    else:
        error_msg = f"Codigo de salida: {process.returncode}"

    try:
        contents = _dir_contents_for_log(Path(output_file).parent, video_id=video_id, output_stem=Path(output_file).stem)
        log.error("[Download] Error tras %s. %s. Dir: %s", elapsed_str, error_msg, ", ".join(contents[:20]))
        tail = " || ".join(output_tail[-10:])
        if tail:
            log.error("[Download] Ultima salida twitch-dlp: %s", tail)
    except Exception as e:
        log.error("[Download] Error tras %s. %s (no se pudo listar dir: %s)", elapsed_str, error_msg, e)

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
