# Fecha real del stream en la subida a YouTube

Fecha: 2026-06-14

## Problema

Al subir un VOD, el título, la descripción y la metadata de fecha de YouTube
muestran la fecha de subida en vez de la fecha real en que se emitió el stream.

Dos causas raíz:

1. **Fecha fabricada a partir del ID.** `utils.parse_twitch_vod_url` trata el
   `video_id` de Twitch como un timestamp Unix
   (`start_time = vid_int if vid_int < 10_000_000_000 else 0`). Los IDs de
   Twitch son secuenciales, no timestamps, así que `start_time` queda en `0`
   (IDs grandes) o en una fecha falsa (IDs pequeños). Con `start_time` inválido,
   `auto_pipeline._safe_stream_date` cae a `datetime.now(UTC)` → fecha de subida.

2. **Metadata de YouTube sin fecha de grabación.** `youtube_uploader.upload_video`
   nunca envía `recordingDetails.recordingDate`, así que YouTube usa la fecha de
   subida como fecha del vídeo aunque el texto fuese correcto.

Fuente autoritativa de la fecha real: Twitch Helix `GET /videos?id=<video_id>`,
campo `created_at`.

## Decisión de diseño

Resolver la fecha real **en el pipeline, en el momento de la subida** (una sola
fuente de verdad que cubre alta manual, monitor y retry por igual). Una única
fecha resuelta alimenta título, descripción y `recordingDate`.

## Componentes

### 1. `twitch_api.py` — `get_video_by_id`

```
def get_video_by_id(self, video_id: str) -> dict | None
```

- Llama a `_request("/videos", {"id": video_id})`.
- Si no hay datos, devuelve `None`.
- Devuelve `{"video_id", "title", "created_at", "start_time", "duration_sec"}`,
  con `start_time` = epoch UTC parseado de `created_at` (misma lógica que
  `get_recent_archives`).

### 2. `auto_pipeline.py` — cliente Twitch perezoso + `_resolve_stream_date`

- En `__init__`, crear `self.twitch_client` igual que en `monitor.py`: solo si
  `config["twitch_api"]["enabled"]` y hay `TWITCH_CLIENT_ID`. Si no, `None`.
- Nuevo helper:

```
def _resolve_stream_date(self, stream_info: dict) -> datetime
```

  Orden de resolución:
  1. Si `start_time` es un epoch **plausible** (entre 2011-01-01 y ahora+1día),
     usarlo.
  2. Si no, y hay `twitch_client` + `video_id`, consultar
     `get_video_by_id(video_id)` y usar su `created_at`.
  3. Si no se pudo resolver, `datetime.now(UTC)` con `log.warning`.

- `_generate_title` y `_generate_description` reciben la fecha ya resuelta (un
  `datetime`) en vez de llamar a `_safe_stream_date` por su cuenta. La resolución
  se hace una vez en el flujo de subida y se pasa a ambos + a `upload_video`.

### 3. `youtube_uploader.py` — `recordingDate`

- `upload_video` gana un parámetro opcional `recording_date: datetime | None`.
- Extraer la construcción del cuerpo a un helper estático testeable
  `_build_request_body(...)` que devuelve `(body, part)`.
- Si `recording_date` no es `None`, añadir
  `body["recordingDetails"] = {"recordingDate": <RFC3339 UTC>}` y `"recordingDetails"`
  al `part`. Formato: `dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")`.
- El pipeline pasa la fecha resuelta como `recording_date`.

### 4. `utils.parse_twitch_vod_url` — no fabricar fecha del ID

- Para URLs/IDs de Twitch (y trackers que solo aportan el id), dejar de derivar
  `start_time` del `video_id`. Poner `start_time = 0`; la fecha real la resuelve
  el pipeline vía API. El `vod_id` pasa a `video:{channel}_{video_id}_0`.

## Manejo de errores

- API deshabilitada / sin creds / error de red / vídeo borrado → fallback a
  `now()` con warning. Sin regresión respecto al comportamiento actual.
- `recordingDate` solo se envía si hay fecha resuelta no nula.

## Testing (TDD)

- `twitch_api.get_video_by_id`: mock de `_request`, parseo de `created_at` →
  `start_time`; caso sin datos → `None`.
- `auto_pipeline._resolve_stream_date`: (a) `start_time` válido → esa fecha, sin
  llamar a la API; (b) `start_time` inválido + API con `created_at` → fecha de la
  API; (c) inválido + sin cliente → `now()` (hoy).
- `youtube_uploader._build_request_body`: incluye `recordingDetails` y el `part`
  correcto cuando hay `recording_date`; lo omite cuando es `None`; formato RFC3339.
- `utils.parse_twitch_vod_url`: URL normal de Twitch → `start_time == 0`.

## Fuera de alcance

- Resolver la fecha en el alta del dashboard.
- Cambiar el formato del `vod_id` más allá del `start_time`.
- Reescribir la lógica de fecha del monitor (ya usa `created_at` / fecha scrapeada).
