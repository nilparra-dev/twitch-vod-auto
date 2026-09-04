# Twitch VOD Auto

Pipeline automatizado que detecta nuevos VODs de canales de Twitch, los descarga
y los publica en YouTube, con un dashboard web de administración en tiempo real.

- **Detección**: API oficial de Twitch (Helix) como fuente primaria, con
  trackers (TwitchTracker / StreamsCharts) como respaldo opcional.
- **Descarga**: [`twitch-dlp`](https://www.npmjs.com/package/twitch-dlp) + ffmpeg.
- **Publicación**: YouTube Data API v3 (subida resumible con reintentos).
- **Operación**: dashboard FastAPI con autenticación, progreso en vivo (SSE),
  cola manual, renovación de OAuth de YouTube y visor de logs.
- **Reproducción sin descarga**: resuelve URLs de Twitch, TwitchTracker,
  StreamsCharts, SullyGnome y targets `video:...` a playlists M3U8 por calidad.

## CLI M3U8

La beta de la CLI obtiene un enlace reproducible sin descargar el VOD y se
ejecuta sin instalación:

```bash
npx twitch-vod-m3u8@beta 2434567890
npx twitch-vod-m3u8@beta 51582913581 --channel nombre_canal
npx twitch-vod-m3u8@beta "https://twitchtracker.com/canal/streams/51582913581"
npx twitch-vod-m3u8@beta "video:canal_51582913581_1721686515" --open vlc
```

Durante el desarrollo:

```bash
npm install
npm run build
node dist/cli.js --help
```

Opciones principales: `--quality 720p60`, `--all`, `--json`, `--copy` y
`--open`. Si solo se proporciona el ID de un stream oculto, el modo interactivo
pregunta el canal y busca su fecha en SullyGnome.

---

## Arquitectura

```
                 ┌──────────────────────┐
                 │  auto_pipeline.py     │   proceso "pipeline"
                 │  ──────────────────   │
  Twitch API ──▶ │  monitor → cola DB    │
  Trackers   ──▶ │  download workers     │──▶ twitch-dlp + ffmpeg ──▶ MP4
                 │  upload workers       │──▶ YouTube Data API
                 └──────────┬───────────┘
                            │  SQLite (data/pipeline.db)
                            │  progreso (data/download_progress.json)
                            ▼
                 ┌──────────────────────┐
                 │  dashboard.py         │   proceso "dashboard" (FastAPI)
                 │  login + API + SSE    │◀── admin vía navegador (nginx + TLS)
                 └──────────────────────┘
```

El pipeline y el dashboard son **dos procesos** que comparten el mismo estado en
SQLite (WAL) y un archivo JSON de progreso. En producción corren como
contenedores separados detrás de nginx con TLS de Let's Encrypt.

## Stack

| Capa            | Tecnología                                    |
|-----------------|-----------------------------------------------|
| Lenguaje        | Python 3.12+                                   |
| Web / API       | FastAPI + Uvicorn                              |
| Persistencia    | SQLite (WAL)                                   |
| Descarga        | twitch-dlp (Node 22) + ffmpeg                  |
| Subida          | google-api-python-client (YouTube Data API v3) |
| Despliegue      | Docker Compose + nginx + certbot, GitHub Actions a VPS |

## Componentes

| Archivo                | Rol                                                          |
|------------------------|--------------------------------------------------------------|
| `auto_pipeline.py`     | Orquestador: monitoreo, workers de descarga y subida.        |
| `monitor.py`           | Detección de VODs (Twitch API + trackers).                   |
| `twitch_api.py`        | Cliente de la API Helix de Twitch.                           |
| `download_vod.py`      | Descarga vía twitch-dlp con reintentos y merge de fragmentos.|
| `youtube_uploader.py`  | Subida resumible a YouTube con backoff.                      |
| `credentials_store.py` | Carga/guarda credenciales OAuth en JSON (lee pickle heredado).|
| `dashboard.py`         | API FastAPI + páginas del panel (HTML en `templates/`).      |
| `db.py`                | Capa SQLite: VODs procesados, cola, estadísticas.            |
| `progress.py`          | Progreso de descarga/subida compartido entre procesos.       |
| `thumbnail.py`         | Genera miniatura con ffmpeg.                                 |
| `utils.py`             | Logging, parseo de URLs, helpers.                            |

## Requisitos

- Python 3.12+
- Node.js 22 + `twitch-dlp` (para descargas)
- ffmpeg / ffprobe
- Credenciales de la API de Twitch (Client ID + Secret)
- `client_secret.json` de OAuth de YouTube (Google Cloud Console)

## Puesta en marcha (local)

```bash
# 1. Dependencias
python -m pip install -e ".[dev]"

# 2. Configuración
cp .env.example .env          # completa TWITCH_*, ADMIN_PASSWORD, SECRET_KEY
cp config.json config.local.json   # ajusta canales y rutas

# 3. ffmpeg (Windows)
python install_ffmpeg.py

# 4. Autenticación de YouTube (abre navegador una vez)
python youtube_uploader.py

# 5. Ejecutar
python auto_pipeline.py            # pipeline (bucle continuo)
python auto_pipeline.py --once     # un solo ciclo de monitoreo
uvicorn dashboard:app --port 8080  # dashboard en http://localhost:8080
```

### Ver un VOD sin descargarlo

En el dashboard, abre **Ver VOD** y pega una de estas entradas:

- ID o URL de un VOD público de Twitch.
- URL de una emisión en TwitchTracker, StreamsCharts o SullyGnome.
- Target completo `video:canal_streamId_timestamp` para un VOD oculto.

La aplicación busca las calidades que Twitch todavía conserva y devuelve sus
enlaces M3U8. Puedes copiarlos y abrirlos en VLC desde **Medio → Abrir ubicación
de red**. Un ID de stream oculto aislado no contiene el canal ni la fecha de
inicio necesarios; en ese caso usa la URL del tracker o el target `video:...`.

## Configuración

- **`config.json`** — canales a monitorear, fuentes, opciones de descarga y
  YouTube (privacidad, tags, categoría por canal). Ver `config.prod.json` para
  el perfil de producción.
- **`.env`** — secretos y opciones de entorno. Ver `.env.example`. Claves
  relevantes: `TWITCH_CLIENT_ID/SECRET`, `ADMIN_USER/PASSWORD`, `SECRET_KEY`,
  `DASHBOARD_PUBLIC_URL`, `COOKIE_SECURE`, `GIT_BASH_PATH` (solo Windows).

Las credenciales de YouTube se guardan en formato JSON. Un token `pickle`
heredado se sigue leyendo y se migra a JSON de forma transparente al guardarse.

## Despliegue

Producción usa `docker-compose.prod.yml` (pipeline + dashboard + nginx +
certbot) y se despliega por SSH mediante GitHub Actions al hacer push a `main`.
Guías detalladas en [`docs/`](docs/):

- [`docs/DEPLOY_STEP_BY_STEP.md`](docs/DEPLOY_STEP_BY_STEP.md)
- [`docs/DEPLOY_DIGITALOCEAN.md`](docs/DEPLOY_DIGITALOCEAN.md)
- [`docs/DEPLOY_GITHUB_ACTIONS.md`](docs/DEPLOY_GITHUB_ACTIONS.md)
- [`docs/OAUTH_TROUBLESHOOTING.md`](docs/OAUTH_TROUBLESHOOTING.md)
- [`docs/AUTOMATION_GUIDE.md`](docs/AUTOMATION_GUIDE.md)

## Desarrollo

```bash
python -m pip install -e ".[dev]"
pre-commit install          # hooks de lint/format al commitear

ruff check .                # lint
ruff format .               # formato
mypy .                      # tipos (gradual)
python -m pytest            # tests
```

CI (`.github/workflows/ci.yml`) ejecuta lint, formato, tipos, tests y build de
Docker en cada PR y push.

## Notas de seguridad

- Los secretos (`.env`, `client_secret.json`, credenciales, cookies) están en
  `.gitignore` y nunca se versionan.
- El dashboard exige autenticación, valida origen/referer en mutaciones
  (anti-CSRF), limita intentos de login y fija cabeceras de seguridad (CSP,
  HSTS, X-Frame-Options).
- Define `SECRET_KEY` y `ADMIN_PASSWORD` fuertes en producción y `COOKIE_SECURE=true`.

## Licencia

MIT. Ver [`LICENSE`](LICENSE).
