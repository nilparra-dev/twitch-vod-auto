# Guia de Despliegue en DigitalOcean (Ubuntu + Docker + Cloudflare)

Guia paso a paso para desplegar Twitch VOD Auto en un servidor DigitalOcean con Ubuntu, Docker y tu dominio `privatevods.com` gestionado por Cloudflare.

---

## 0. Antes de empezar (checklist)

Necesitas tener esto listo en tu PC local:

- [ ] **Cuenta DigitalOcean** con droplet creado (Ubuntu 24.04, 2 CPU, 2GB RAM, 50GB SSD)
- [ ] **Dominio**: `privatevods.com` configurado en Cloudflare
- [ ] **Archivos generados en tu PC con navegador**:
  - `client_secret.json` (Google Cloud Console)
  - `youtube_credentials.pkl` (autenticacion OAuth, SOLO se genera con navegador)
  - `twitch_cookies.txt` (extension "Get cookies.txt LOCALLY", estando logueado en Twitch)

---

## 1. Crear el Droplet en DigitalOcean

1. Ve a [cloud.digitalocean.com](https://cloud.digitalocean.com)
2. Crea un Droplet:
   - **OS**: Ubuntu 24.04 (LTS)
   - **Plan**: Basic, $12/mes (2 vCPU / 2GB RAM / 50GB SSD)
   - **Region**: Elige el mas cercano a ti
   - **Auth**: SSH Key (recomendado) o Password
   - **Hostname**: `vod-privatevods` (o lo que quieras)
3. Crea y anota la **IP publica** del droplet
4. (Opcional pero recomendado) En DigitalOcean, ve a **Networking > Firewalls** y crea un firewall:
   - Type SSH, TCP 22, Sources: Tu IP
   - Type HTTP, TCP 80, Sources: All IPv4, All IPv6
   - Type HTTPS, TCP 443, Sources: All IPv4, All IPv6
   - Aplica el firewall al droplet

---

## 2. Configurar DNS en Cloudflare

1. Ve a [dash.cloudflare.com](https://dash.cloudflare.com) → tu dominio `privatevods.com`
2. Ve a **DNS > Records**
3. Crea un registro **A**:
   - **Name**: `vod` (o el subdominio que quieras, ej: `auto`, `panel`, etc.)
   - **IPv4 address**: IP de tu droplet
   - **TTL**: Auto
   - **Proxy status**: **DNS only** (nube GRIS, apagada temporalmente) ← MUY IMPORTANTE
4. Guarda

**Por que apagar el proxy temporalmente?**
Let's Encrypt necesita validar tu servidor directamente. El proxy naranja de Cloudflare interfiere en la primera generacion del certificado. Lo volveremos a encender al final.

---

## 3. Transferir archivos del proyecto al servidor

Desde tu **PC local** (PowerShell / Terminal), sube TODO el proyecto al droplet:

```bash
# 1. Ve a la carpeta del proyecto en tu PC
cd D:\Plugins\twitch-vod-auto   # o la ruta donde tengas los archivos

# 2. Comprime los archivos del proyecto en un ZIP
#    (excluyendo data, logs, downloads que se crearan en el servidor)
```

**Opcion A: Subir via SCP (recomendado)**

Desde tu PC local, abre PowerShell o Terminal:

```bash
# Crea el directorio en el servidor primero
ssh root@TU_IP "mkdir -p /opt/twitch-vod-auto"

# Subir todos los archivos del proyecto (recursivo)
# Windows (PowerShell):
scp -r *.py *.json *.md *.sh *.yml *.conf requirements.txt .env .env.example .gitignore .dockerignore root@TU_IP:/opt/twitch-vod-auto/

# Linux / Mac:
scp *.py *.json *.md *.sh *.yml *.conf requirements.txt .env .env.example .gitignore .dockerignore root@TU_IP:/opt/twitch-vod-auto/
```

**Opcion B: Subir via SFTP (FileZilla / WinSCP)**
- Conecta a `root@TU_IP` por SFTP
- Sube todos los archivos a `/opt/twitch-vod-auto/`

---

## 4. Subir los 3 archivos secretos OBLIGATORIOS

Estos archivos SOLO se pueden generar en una PC con navegador. Nunca en el servidor.

### 4.1 client_secret.json (Google/YouTube API)

Si ya lo tienes, subelo:
```bash
scp client_secret.json root@TU_IP:/opt/twitch-vod-auto/
```

Si NO lo tienes:
1. Ve a [Google Cloud Console](https://console.cloud.google.com/)
2. Crea un proyecto → Habilita **YouTube Data API v3**
3. **Credentials > Create Credentials > OAuth client ID**
4. Tipo: **Desktop app**
5. Descarga el JSON y renombralo a `client_secret.json`
6. Subelo con el comando de arriba

### 4.2 youtube_credentials.pkl (Token OAuth)

**IMPORTANTE**: Este archivo requiere un navegador para autenticarte con Google.

En tu **PC local** (no en el servidor):

```bash
# En la carpeta del proyecto de tu PC
pip install -r requirements.txt
python youtube_uploader.py
```

- Se abrira tu navegador
- Inicia sesion en tu cuenta de Google/YouTube
- Autoriza la aplicacion
- Se creara `youtube_credentials.pkl` en la carpeta

Ahora subelo al servidor:
```bash
scp youtube_credentials.pkl root@TU_IP:/opt/twitch-vod-auto/
```

**Nota**: Si el token expira (cada ~7 dias sin uso), tendras que regenerarlo en tu PC y volver a subirlo. El pipeline intenta refrescarlo automaticamente, pero si expira del todo necesita navegador.

**⚠️ Error 403: access_denied al seleccionar la cuenta?**

Si al iniciar sesion te sale `Error 403: access_denied`, significa que tu email no esta en la lista de **Test users** de Google Cloud.

Solucion rapida:
1. Ve a [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → OAuth consent screen
2. Ve a la pestaña **Audience**
3. En **Test users**, haz clic en **ADD USERS**
4. Introduce el **email exacto** de tu cuenta de YouTube
5. Guarda y vuelve a ejecutar `python youtube_uploader.py`

Para mas detalles, lee: [OAUTH_TROUBLESHOOTING.md](OAUTH_TROUBLESHOOTING.md)

### 4.3 twitch_cookies.txt (Sesion de Twitch para VODs capados)

En tu **PC local** (donde estes logueado en Twitch):

1. Instala la extension **"Get cookies.txt LOCALLY"** en Chrome o Firefox
2. Ve a [twitch.tv](https://www.twitch.tv) y asegurate de estar LOGUEADO
3. Clic en la extension → **Export** → Guarda como `twitch_cookies.txt`
4. Súbelo al servidor:
```bash
scp twitch_cookies.txt root@TU_IP:/opt/twitch-vod-auto/
```

**Seguridad**: Este archivo contiene tu sesion activa de Twitch. No lo subas a Git ni lo compartas.

---

## 5. Configurar config.prod.local.json en el servidor

Conectate al servidor:
```bash
ssh root@TU_IP
cd /opt/twitch-vod-auto
```

Copia la configuracion de produccion local, que no se sube a Git:
```bash
cp config.prod.json config.prod.local.json
```

Edita `config.prod.local.json` con tus canales:
```bash
nano config.prod.local.json   # o vim config.prod.local.json
```

Cambia esto:
```json
"channels": [
  {
    "name": "NOMBRE_DEL_CANAL_AQUI",
    "youtube_overrides": {
      "privacy_status": "private",
      "tags": ["twitch", "vod", "stream"],
      "category_id": "20"
    }
  }
]
```

**Verifica que estas lineas sean asi** (para servidor Linux sin navegador):
```json
"twitch": {
  "global": {
    "cookies_browser": null,
    "cookies_file": "twitch_cookies.txt",
    "check_interval_minutes": 30,
    "request_delay_seconds": 3.0,
    "max_retries": 3
  }
}
```

Guarda y sal (`Ctrl+O`, `Enter`, `Ctrl+X` en nano).

---

## 6. Instalar Docker y Docker Compose (automatico)

En el servidor, ejecuta:

```bash
cd /opt/twitch-vod-auto
chmod +x setup-server.sh
./setup-server.sh vod.privatevods.com
```

Esto instala automaticamente:
- Docker y Docker Compose
- Nginx
- Certbot
- Crea directorios y servicios systemd

**Si da error de dependencias**, ejecuta manualmente:
```bash
apt-get update && apt-get install -y docker.io docker-compose-plugin nginx certbot
systemctl enable docker
```

---

## 7. Generar certificado SSL con Let's Encrypt

En el servidor:

```bash
# Detener nginx del sistema (si esta corriendo) para liberar el puerto 80
systemctl stop nginx

# Generar certificado (modo standalone)
certbot certonly --standalone -d vod.privatevods.com --agree-tos --non-interactive --email tu-email@ejemplo.com
```

Verifica que se crearon los archivos:
```bash
ls /etc/letsencrypt/live/vod.privatevods.com/
```

Deberias ver:
- `fullchain.pem`
- `privkey.pem`

**Nota**: Certbot guarda los certificados en `/etc/letsencrypt/`. Docker los monta desde `./certbot-data`, asi que necesitamos copiarlos o crear un symlink. En el docker-compose ya se monta el volumen, pero debemos asegurar que los certs esten donde nginx los espera.

Copia los certs al volumen de Docker:
```bash
mkdir -p /opt/twitch-vod-auto/certbot-data/live/vod.privatevods.com
cp /etc/letsencrypt/live/vod.privatevods.com/* /opt/twitch-vod-auto/certbot-data/live/vod.privatevods.com/
```

---

## 8. Actualizar nginx.conf con tu dominio

Edita nginx.conf:
```bash
nano /opt/twitch-vod-auto/nginx.conf
```

Reemplaza **TODAS** las ocurrencias de `vod.privatevods.com` por tu subdominio real si usaste otro. Si usaste `vod.privatevods.com`, ya esta correcto.

Verifica que tenga:
```
server_name vod.privatevods.com;
ssl_certificate /etc/letsencrypt/live/vod.privatevods.com/fullchain.pem;
ssl_certificate_key /etc/letsencrypt/live/vod.privatevods.com/privkey.pem;
```

Guarda y sal.

---

## 9. Levantar todo con Docker Compose

```bash
cd /opt/twitch-vod-auto

# Iniciar todos los servicios en background
docker compose -f docker-compose.prod.yml up --build -d

# Verificar que estan corriendo
docker compose -f docker-compose.prod.yml ps
```

Deberias ver 4 contenedores `UP`:
- `twitch-vod-pipeline`
- `twitch-vod-dashboard`
- `twitch-vod-nginx`
- `twitch-vod-certbot`

---

## 10. Verificar que funciona

### 10.1 Health check
```bash
curl https://vod.privatevods.com/api/health
```
Deberia responder JSON con `"status": "ok"`.

### 10.2 Abrir en navegador
```
https://vod.privatevods.com
```

Deberias ver el Admin Panel con el sidebar, KPIs, etc.

### 10.3 Probar subida manual
1. Ve a **Subida Manual** en el dashboard
2. Pega una URL de Twitch VOD: `https://www.twitch.tv/videos/123456789`
3. Clic en **Encolar VOD**
4. Ve a la seccion **VODs** y deberia aparecer en estado `pending`
5. El pipeline lo procesara automaticamente en el proximo ciclo, o fuerza con:
```bash
docker compose -f docker-compose.prod.yml exec pipeline python auto_pipeline.py --once
```

---

## 11. Volver a encender el proxy naranja de Cloudflare (OPCIONAL)

Si quieres que Cloudflare proteja tu servidor (oculta la IP real, DDoS protection, cache):

1. Ve a Cloudflare → DNS → Registro `vod`
2. Cambia el proxy a **Proxied** (nube NARANJA)
3. Guarda
4. En **SSL/TLS > Overview**, selecciona **Full (strict)**
5. Espera 1-2 minutos

**Importante**: Si activas el proxy naranja, Certbot no podra renovar el certificado automaticamente porque Cloudflare intercepta las peticiones. Tienes dos opciones:

**Opcion A (Recomendada)**: Usar Cloudflare Origin CA certificate en vez de Let's Encrypt:
1. Cloudflare → SSL/TLS > Origin Server > Create Certificate
2. Guarda el cert y key en `certbot-data/live/vod.privatevods.com/`
3. Actualiza nginx.conf para usar esos nombres de archivo
4. Luego ya no necesitas Certbot en Docker

**Opcion B**: Cada ~60 dias, apagar temporalmente el proxy naranja, renovar cert, volver a encender.

Para un setup simple sin complicaciones, **manten el proxy en DNS only (gris)**. Asi Let's Encrypt funciona perfecto y todo es mas sencillo.

---

## 12. Ver logs y monitorear

```bash
# Logs del pipeline (monitoreo + descargas + subidas)
docker compose -f docker-compose.prod.yml logs -f pipeline

# Logs del dashboard web
docker compose -f docker-compose.prod.yml logs -f dashboard

# Logs de nginx
docker compose -f docker-compose.prod.yml logs -f nginx

# Ver todos los logs
docker compose -f docker-compose.prod.yml logs -f
```

---

## 13. Actualizar el sistema (cuando cambies codigo)

Si editas codigo en tu PC y quieres subirlo al servidor:

```bash
# Desde tu PC local
scp *.py *.json root@TU_IP:/opt/twitch-vod-auto/

# En el servidor, reconstruir y reiniciar
docker compose -f docker-compose.prod.yml down
docker compose -f docker-compose.prod.yml up --build -d
```

---

## 14. Renovar cookies de Twitch (cada 30-60 dias)

Las cookies de Twitch expiran. Cuando veas errores de autenticacion en los logs:

1. En tu **PC local**, exporta nuevamente `twitch_cookies.txt` estando logueado en Twitch
2. Sube el archivo al servidor:
```bash
scp twitch_cookies.txt root@TU_IP:/opt/twitch-vod-auto/
```
3. Reinicia el pipeline:
```bash
docker compose -f docker-compose.prod.yml restart pipeline
```

---

## Solucion de problemas rapidos

### "Connection refused" al abrir el dominio
- Verifica que los contenedores esten corriendo: `docker compose -f docker-compose.prod.yml ps`
- Verifica que nginx.conf tenga el dominio correcto
- Verifica los logs de nginx: `docker compose logs nginx`

### "SSL error / certificado no valido"
- Verifica que los certificados existan en `./certbot-data/live/vod.privatevods.com/`
- Si fallo la generacion, asegurate de que el proxy de Cloudflare este en modo DNS only (gris)

### "No puedo generar youtube_credentials.pkl en el servidor"
- Es normal. Generalo en tu PC con `python youtube_uploader.py` y subelo via `scp`.

### "El pipeline dice 'cookies_file no encontrado'"
- Asegurate de que `twitch_cookies.txt` este en `/opt/twitch-vod-auto/`
- Verifica que `config.prod.local.json` tenga: `"cookies_file": "twitch_cookies.txt"`

### "502 Bad Gateway"
- El dashboard no esta corriendo o no responde en el puerto 8080
- Verifica: `docker compose -f docker-compose.prod.yml logs dashboard`

---

## Estructura final en el servidor

```
/opt/twitch-vod-auto/
├── client_secret.json           # Google Cloud (obligatorio)
├── youtube_credentials.pkl      # Token OAuth YouTube (obligatorio)
├── twitch_cookies.txt           # Cookies Twitch (obligatorio para VODs capados)
├── config.prod.local.json       # Configuracion real de produccion (ignorada por Git)
├── config.json                  # Configuracion versionada para desarrollo/local
├── .env                         # Variables de entorno
├── docker-compose.prod.yml      # Orquestacion Docker
├── nginx.conf                   # Reverse proxy + SSL
├── setup-server.sh              # Script de instalacion
├── Dockerfile                   # Imagen Docker
│
├── data/
│   └── pipeline.db              # Base de datos SQLite (persistente)
├── logs/
│   └── pipeline.log             # Logs del sistema
├── downloads/                   # Descargas temporales (auto-limpia)
├── certbot-data/
│   └── live/
│       └── vod.privatevods.com/ # Certificados SSL
│           ├── fullchain.pem
│           └── privkey.pem
└── certbot-www/                 # Validacion ACME
```

---

**Listo. Si algo falla, revisa primero los logs del pipeline y de nginx.**
