# Guia de Configuracion - Twitch VOD Auto → YouTube (Enterprise)

Sistema profesional de monitoreo, descarga y subida automatica de VODs de Twitch a YouTube.

## 1. Requisitos previos

- Python 3.10+ (o Docker)
- Node.js + npm (para `twitch-dlp`)
- Git for Windows (para `git-bash.exe`, solo Windows nativo)
- Cuenta de Google con acceso a YouTube Data API v3
- Cuenta de Twitch con Client ID / Client Secret (opcional pero recomendado)

## 2. Instalacion

### Opcion A: Nativa (Windows/Linux)

```bash
pip install -r requirements.txt
npm install -g twitch-dlp
python install_ffmpeg.py
```

### Opcion B: Docker local (Recomendado)

```bash
docker-compose up --build
```

El dashboard estara disponible en `http://localhost:8080`

### Opcion C: Servidor en la nube (DigitalOcean / VPS)

Para desplegar en un servidor remoto (Ubuntu + Docker + SSL + Nginx), sigue la guia completa:

**→ [DEPLOY_DIGITALOCEAN.md](DEPLOY_DIGITALOCEAN.md)**

Incluye paso a paso para:
- Droplet en DigitalOcean
- Dominio + SSL con Let's Encrypt
- Docker Compose de produccion
- Subida de credenciales y cookies
- Dashboard accesible desde internet

## 3. Configuracion de entorno

Copia el archivo de ejemplo:

```bash
cp .env.example .env
```

Edita `.env` con tus credenciales:

```env
# Twitch API (fuente primaria, mas fiable que los trackers)
TWITCH_CLIENT_ID=tu_client_id
TWITCH_CLIENT_SECRET=tu_client_secret

# Proxy (opcional, para escala grande)
# HTTP_PROXY=http://user:pass@proxy:8080
# HTTPS_PROXY=http://user:pass@proxy:8080
```

## 4. Configuracion de canales (`config.json`)

### Multi-canal con overrides

```json
"channels": [
  {
    "name": "canal1",
    "youtube_overrides": {
      "privacy_status": "private",
      "tags": ["twitch", "español"],
      "prefix_title": "[VOD]"
    }
  },
  {
    "name": "canal2",
    "youtube_overrides": {
      "privacy_status": "unlisted",
      "tags": ["twitch", "english"],
      "prefix_title": ""
    }
  }
]
```

Cada canal puede tener su propia configuracion de privacidad, tags y prefijo de titulo.

### Twitch API vs Trackers

El sistema usa **Twitch API oficial** como fuente primaria (mas fiable y rapida).
Los trackers (TwitchTracker, StreamsCharts) son **fallback** si la API falla.

Para habilitar la API oficial, configura `TWITCH_CLIENT_ID` y `TWITCH_CLIENT_SECRET` en `.env`.

### Autenticacion para VODs capados

Para descargar VODs no publicos, el sistema necesita tu sesion de Twitch:

**Opcion recomendada:**
```json
"global": {
  "cookies_browser": "chrome"
}
```
Asegurate de estar logueado en Twitch en Chrome.

**Opcion alternativa (headless/server):**
1. Usa la extension "Get cookies.txt LOCALLY"
2. Exporta cookies de `twitch.tv` a `twitch_cookies.txt`
3. Configura:
```json
"global": {
  "cookies_file": "twitch_cookies.txt",
  "cookies_browser": null
}
```

## 5. YouTube API

1. [Google Cloud Console](https://console.cloud.google.com/) → Nuevo proyecto
2. Habilita **YouTube Data API v3**
3. **Credentials > Create Credentials > OAuth client ID** (tipo **Desktop app**)
4. Descarga el JSON y guardalo como `client_secret.json`
5. La primera vez que ejecutes el pipeline, se abrira el navegador para autenticar OAuth. El token se guarda en `youtube_credentials.pkl`.

**Nota:** En Docker, genera `youtube_credentials.pkl` primero en tu maquina local y luego copialo al contenedor (ya esta montado como volumen en docker-compose.yml).

## 6. Uso

### Modo prueba (una vez):
```bash
python auto_pipeline.py --once
```

### Modo automatico:
```bash
python auto_pipeline.py
```

### Dashboard web:
```bash
python dashboard.py
```
O en Docker, ya esta expuesto en `http://localhost:8080`

## 7. Subida manual de VODs (Dashboard)

En el dashboard (`http://localhost:8080`) hay un apartado **"Subida Manual"**:

1. Pega el **VOD ID** (ej: `video:canal_123_456789`) o la **URL de Twitch** (ej: `https://www.twitch.tv/videos/123456789`)
2. Haz clic en **"Encolar VOD"**
3. El VOD se registra en la base de datos y se encola para descarga
4. Ejecuta el pipeline (`python auto_pipeline.py --once`) o espera a que el bucle automatico lo procese

Esto es util para:
- Subir VODs antiguos que no fueron detectados
- Subir VODs de canales no monitoreados automaticamente
- Probar el pipeline con un VOD especifico

## 8. Caracteristicas Enterprise

### Arquitectura
- **SQLite persistente** con tablas de VODs, cola, estadisticas
- **Colas de trabajo** (productor-consumidor) con workers dedicados
- **Retry con backoff exponencial** + jitter en descarga y subida
- **Paralelismo controlado**: monitoreo multi-hilo + descargas simultaneas

### Fuentes de datos
1. **Twitch API Helix** (oficial) - fuente primaria
2. **TwitchTracker** (scraper) - fallback
3. **StreamsCharts** (scraper) - fallback

### Thumbnails automaticas
El sistema extrae un frame a los 5 segundos del video con ffmpeg y lo sube como miniatura de YouTube.

### Limpieza automatica
Los archivos se eliminan inmediatamente despues de subir a YouTube. **No queda nada en local.**

### Dashboard web (FastAPI) - Admin Panel completo
- **Sidebar de navegacion** con secciones: Dashboard, VODs, Cola, Subida Manual, Logs
- **KPIs grandes** arriba: Total VODs, Subidos, Pendientes, Fallidos
- **Grafico de actividad** de los ultimos 7 dias (canvas nativo)
- **Tabla de VODs** con:
  - Filtros por estado, canal y busqueda libre
  - Paginacion
  - Acciones directas: **Reintentar** (↻) y **Eliminar** (🗑)
  - Link directo a YouTube
- **Cola de descargas** en tiempo real con opcion de quitar items
- **Subida manual mejorada** con campos: URL, canal, privacidad, titulo personalizado, tags
- **Logs en tiempo real** desde el pipeline (coloreados: INFO, WARN, ERROR)
- **Auto-refresh configurable**: 10s, 30s, 1m o manual
- **Responsive**: funciona en movil y desktop

### Docker + docker-compose
- Despliegue portable sin dependencias del host
- Volumenes persistentes para DB, logs y credenciales
- Servicio separado para el dashboard

## 9. Estructura de archivos

```
twitch-vod-auto/
├── config.json              # Configuracion central
├── .env                     # Variables de entorno (secrets)
├── requirements.txt
├── docker-compose.yml
├── Dockerfile
├── AUTOMATION_GUIDE.md
│
├── db.py                    # SQLite: processed, queue, stats
├── utils.py                 # Logging, helpers, .env loader, parse URL
├── retry.py                 # Decorador retry con backoff exponencial
├── twitch_api.py            # Cliente oficial Twitch API Helix
├── monitor.py               # Scraper multi-canal paralelo
├── download_vod.py          # Descarga con twitch-dlp + thumbnails
├── youtube_uploader.py      # Subida YouTube Data API v3 + thumbnails
├── thumbnail.py             # Generacion de thumbnails con ffmpeg
├── dashboard.py             # FastAPI + HTML dashboard (incluye subida manual)
└── auto_pipeline.py         # Orquestador principal con workers y colas
```

## 10. Directorios generados

- `data/pipeline.db` - Base de datos SQLite (persistente)
- `logs/pipeline.log` - Logs profesionales con timestamps
- `downloads/` - VODs temporales (se borran tras subir)
- `youtube_credentials.pkl` - Token OAuth de YouTube (secreto)

## 11. Rendimiento y escala

### Para muchos canales (10-50)
- Usa `parallel_monitor: true` (default)
- Aumenta `request_delay_seconds` a 5.0+ para evitar bans
- Considera usar un proxy rotativo (`proxy` en config.json)
- Usa Twitch API como fuente primaria (no consume trackers)

### Cuota de YouTube
- Cada subida consume ~1600 unidades de cuota
- Si tienes muchos canales activos, solicita aumento de cuota en Google Cloud Console
- Los VODs se suben como `private` por defecto: tu decides cuales publicar

### Disco local
- **No te preocupes**: los archivos se eliminan automaticamente tras subir
- Solo necesitas espacio para el VOD mas grande que descargues simultaneamente

## 12. Solucion de problemas

### "Rate limited / 429"
- Aumenta `request_delay_seconds`
- Activa Twitch API para reducir requests a trackers
- Usa proxy si monitoreas >20 canales

### "Error de autenticacion en Twitch"
- Verifica estar logueado en el navegador configurado
- Exporta cookies a archivo para entornos headless

### "Cuota excedida en YouTube"
- Cambia `privacy_status` a `private` para no desperdiciar subidas
- Solicita aumento de cuota en Google Cloud Console

### Dashboard no carga
- Verifica que `data/pipeline.db` exista (ejecuta el pipeline al menos una vez)
- Revisa `logs/pipeline.log` para errores

### Subida manual no procesa
- El dashboard solo **encola** el VOD. Necesitas ejecutar el pipeline para que lo descargue y suba.
- Ejecuta `python auto_pipeline.py --once` para procesar la cola inmediatamente.

## 13. Seguridad

- **NUNCA** subas `client_secret.json`, `youtube_credentials.pkl`, `.env` ni cookies a repositorios publicos
- Ya estan incluidos en `.gitignore` y `.dockerignore`
- Las cookies de Twitch son sesiones activas: tratalas como contraseñas
