# Guia de Despliegue - Paso a Paso Completo

## Requisitos previos (ya deberias tener esto)

- [ ] Cuenta DigitalOcean
- [ ] Dominio `privatevods.com` en Cloudflare
- [ ] `client_secret.json` generado en Google Cloud Console
- [ ] `youtube_credentials.pkl` generado en tu PC local con `python youtube_uploader.py`
- [ ] Este proyecto descargado/clonado en tu PC: `D:\Plugins\twitch-vod-auto`

---

## PASO 1: Crear el Droplet en DigitalOcean

1. Ve a [cloud.digitalocean.com](https://cloud.digitalocean.com)
2. Crea un Droplet:
   - **Choose Region**: Amsterdam, Frankfurt o Londres (elige el mas cercano)
   - **Choose an image**: Ubuntu 24.04 (LTS) x64
   - **Choose Size**: Basic
     - **$12/mes** (2 vCPU / 2GB RAM / 50GB SSD) ← este esta bien
   - **Choose Authentication**: SSH Key (recomendado)
     - Si no tienes clave SSH, crea una en tu PC:
       ```bash
       ssh-keygen -t ed25519 -C "tu-email@gmail.com"
       # Presiona Enter varias veces (sin passphrase)
       # En Windows, la clave publica esta en: C:\Users\TU_USUARIO\.ssh\id_ed25519.pub
       ```
     - Copia el contenido de `id_ed25519.pub` y pegalo en DigitalOcean
   - **Quantity**: 1
   - **Hostname**: `vod-auto`
3. Crea el droplet y anota la **IP publica** (ej: `206.189.123.45`)

---

## PASO 2: Configurar DNS en Cloudflare

1. Ve a [dash.cloudflare.com](https://dash.cloudflare.com) → tu dominio `privatevods.com`
2. Ve a la pestaña **DNS > Records**
3. Crea un registro **A**:
   - **Type**: A
   - **Name**: `vod`  (esto crea vod.privatevods.com)
   - **IPv4 address**: `206.189.123.45` (la IP de tu droplet)
   - **TTL**: Auto
   - **Proxy status**: **DNS only** (nube GRIS, NO naranja) ← MUY IMPORTANTE para SSL
4. Guarda

---

## PASO 3: Subir archivos del proyecto al servidor

### 3.1 Abre PowerShell en tu PC (como administrador)

Navega a la carpeta del proyecto:
```powershell
cd D:\Plugins\twitch-vod-auto
```

### 3.2 Crear la carpeta en el servidor

Reemplaza `TU_IP` por la IP real de tu droplet:
```powershell
ssh root@TU_IP "mkdir -p /opt/twitch-vod-auto && mkdir -p /opt/twitch-vod-auto/data && mkdir -p /opt/twitch-vod-auto/logs"
```

**Nota**: La primera vez te preguntara `Are you sure you want to continue connecting?` Escribe `yes` y presiona Enter.

### 3.3 Subir todos los archivos del proyecto

```powershell
# Archivos del proyecto
scp *.py *.json *.md *.sh *.yml *.conf requirements.txt .env .env.example .gitignore .dockerignore "root@TU_IP:/opt/twitch-vod-auto/"
```

**Si scp falla en Windows**, usa WinSCP o FileZilla:
- Protocolo: SFTP
- Host: `TU_IP`
- User: `root`
- Key file: selecciona tu clave SSH (o usa password si elegiste password)
- Sube todos los archivos a `/opt/twitch-vod-auto/`

### 3.4 Subir los archivos secretos

```powershell
# Los 2 archivos que generaste en tu PC (ajusta las rutas si estan en otra carpeta)
scp client_secret.json "root@TU_IP:/opt/twitch-vod-auto/"
scp youtube_credentials.pkl "root@TU_IP:/opt/twitch-vod-auto/"
```

---

## PASO 4: Configurar config.json

Conectate al servidor:
```bash
ssh root@TU_IP
cd /opt/twitch-vod-auto
```

Copia la config de produccion:
```bash
cp config.prod.json config.json
```

Edita el archivo:
```bash
nano config.json
```

**Cambia la seccion de canales**. Ejemplo con un canal real:
```json
"channels": [
  {
    "name": "trk511__",
    "youtube_overrides": {
      "privacy_status": "private",
      "tags": ["twitch", "vod", "stream"],
      "category_id": "20"
    }
  }
]
```

**Si solo vas a usar subida manual** (sin monitoreo automatico), deja:
```json
"channels": []
```

Guarda: `Ctrl+O`, `Enter`, `Ctrl+X`

---

## PASO 5: Ejecutar setup en el servidor

```bash
cd /opt/twitch-vod-auto
chmod +x setup-server.sh
./setup-server.sh
```

Esto instala Docker, Docker Compose, Nginx y crea la estructura.

---

## PASO 6: Generar certificado SSL (Let's Encrypt)

### 6.1 Parar nginx del sistema (liberar puerto 80)
```bash
systemctl stop nginx
```

### 6.2 Generar el certificado

Reemplaza `tu-email@gmail.com` por tu email real:
```bash
certbot certonly --standalone -d vod.privatevods.com --agree-tos --non-interactive --email tu-email@gmail.com
```

Si todo va bien, veras:
```
Successfully received certificate.
Certificate is saved at: /etc/letsencrypt/live/vod.privatevods.com/fullchain.pem
```

### 6.3 Copiar certificados al volumen de Docker

```bash
mkdir -p /opt/twitch-vod-auto/certbot-data/live/vod.privatevods.com
cp /etc/letsencrypt/live/vod.privatevods.com/* /opt/twitch-vod-auto/certbot-data/live/vod.privatevods.com/
```

Verifica:
```bash
ls /opt/twitch-vod-auto/certbot-data/live/vod.privatevods.com/
```

Deberia mostrar:
- `fullchain.pem`
- `privkey.pem`

---

## PASO 7: Actualizar nginx.conf con tu dominio

```bash
nano /opt/twitch-vod-auto/nginx.conf
```

Reemplaza **TODAS** las lineas que digan `server_name _;` por tu dominio:
```nginx
server_name vod.privatevods.com;
```

Y las rutas de los certificados:
```nginx
ssl_certificate /etc/letsencrypt/live/vod.privatevods.com/fullchain.pem;
ssl_certificate_key /etc/letsencrypt/live/vod.privatevods.com/privkey.pem;
```

Guarda: `Ctrl+O`, `Enter`, `Ctrl+X`

---

## PASO 8: Levantar Docker Compose

```bash
cd /opt/twitch-vod-auto

# Construir e iniciar todos los servicios
docker compose -f docker-compose.prod.yml up --build -d
```

Espera 1-2 minutos mientras construye la imagen.

Verifica que todo este corriendo:
```bash
docker compose -f docker-compose.prod.yml ps
```

Deberias ver algo como:
```
NAME                     STATUS
pipeline                 Up
nginx                    Up
dashboard                Up
certbot                  Up
```

---

## PASO 9: Probar

### 9.1 Health check
```bash
curl https://vod.privatevods.com/api/health
```

Respuesta esperada:
```json
{"status":"ok","timestamp":"2025-..."}
```

### 9.2 Abrir en navegador
```
https://vod.privatevods.com
```

Deberias ver el Admin Panel con sidebar, KPIs, etc.

### 9.3 Probar subida manual

1. En el dashboard, ve a **"Subida Manual"**
2. Pega una URL de Twitch VOD: `https://www.twitch.tv/videos/123456789`
3. Clic en **"Encolar VOD"**
4. Ve a la seccion **"VODs"**, deberia aparecer en estado `pending`
5. Para forzar el procesamiento inmediato:
   ```bash
   docker compose -f docker-compose.prod.yml exec pipeline python auto_pipeline.py --once
   ```
6. Espera y refresca el dashboard. El estado deberia cambiar a `uploaded` con el link de YouTube.

---

## Comandos utiles despues del despliegue

```bash
# Ver logs del pipeline (monitoreo + descargas + subidas)
docker compose -f docker-compose.prod.yml logs -f pipeline

# Ver logs del dashboard web
docker compose -f docker-compose.prod.yml logs -f dashboard

# Ver logs de nginx
docker compose -f docker-compose.prod.yml logs -f nginx

# Reiniciar todo
docker compose -f docker-compose.prod.yml restart

# Detener todo
docker compose -f docker-compose.prod.yml down

# Volver a levantar
docker compose -f docker-compose.prod.yml up -d
```

---

## Si algo falla

### "Cannot connect to the Docker daemon"
```bash
systemctl start docker
```

### "Port already in use" (puerto 80 o 443 ocupado)
```bash
systemctl stop nginx
# O si hay otro contenedor:
docker stop $(docker ps -q)
```

### "certbot: No valid IP addresses found"
Espera 5-10 minutos a que el DNS propague. Verifica:
```bash
dig vod.privatevods.com
```
Debe mostrar la IP de tu droplet.

### Error 502 Bad Gateway al abrir el dominio
```bash
docker compose -f docker-compose.prod.yml logs dashboard
```
Probablemente el dashboard no levanto. Revisa los logs.

---

## Proximos pasos opcionales

- **Renovar cookies**: Si quieres descargar VODs capados, exporta `twitch_cookies.txt` desde tu PC y subelo al servidor, luego edita `config.json` para poner `"cookies_file": "twitch_cookies.txt"`.
- **Activar proxy naranja de Cloudflare**: Si quieres proteccion DDoS y ocultar la IP, en Cloudflare cambia el registro `vod` a **Proxied** (nube naranja). Nota: si activas esto, Let's Encrypt no podra renovar certificados automaticamente. Configura Cloudflare Origin CA o renueva manualmente cada 90 dias.
- **Backup de la base de datos**: La DB esta en `data/pipeline.db`. Copiala periodicamente.

---

**Listo. Si te atoras en algun paso, dime cual y te ayudo.**
