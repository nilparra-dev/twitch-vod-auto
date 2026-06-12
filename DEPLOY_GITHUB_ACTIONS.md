# Deploy automatico con GitHub Actions

Este repo queda con dos entornos:

- Desarrollo: tu PC local, usando `docker-compose.yml` y `config.json`.
- Produccion: VPS, usando `docker-compose.prod.yml` y `config.prod.local.json`.

El deploy se ejecuta cuando haces `git push` a `main`. Un commit local sin `push` no dispara GitHub Actions.

## 1. Preparar el VPS una vez

En el VPS, entra al directorio del proyecto:

```bash
cd /opt/twitch-vod-auto
```

Guarda la config real de produccion fuera de Git:

```bash
cp config.json config.prod.local.json
nano config.prod.local.json
```

Comprueba que el repo esta en `main` y limpio:

```bash
git branch --show-current
git status --short
```

Si `git status --short` muestra `config.json` modificado, primero confirma que `config.prod.local.json` tiene tus canales reales y luego restaura el `config.json` versionado:

```bash
git restore config.json
```

Produccion tambien necesita estos archivos en el VPS. No se suben a Git:

```text
.env
client_secret.json
youtube_credentials.pkl
twitch_cookies.txt
```

Prueba manualmente que el deploy funciona:

```bash
docker compose -f docker-compose.prod.yml up --build -d
docker compose -f docker-compose.prod.yml ps
```

## 2. Crear una clave SSH para GitHub Actions

En tu PC local, crea una clave dedicada para despliegues:

```bash
ssh-keygen -t ed25519 -C "github-actions-twitch-vod-auto" -f ~/.ssh/twitch_vod_auto_deploy
```

Copia la clave publica al VPS:

```bash
ssh-copy-id -i ~/.ssh/twitch_vod_auto_deploy.pub root@TU_IP
```

Si usas Windows y no tienes `ssh-copy-id`, copia el contenido de `twitch_vod_auto_deploy.pub` al archivo del VPS:

```bash
~/.ssh/authorized_keys
```

## 3. Configurar secretos en GitHub

En el repo de GitHub, crea estos Repository secrets:

```text
VPS_HOST      IP o dominio del VPS
VPS_USER      root, o tu usuario deploy
VPS_SSH_KEY   contenido completo de ~/.ssh/twitch_vod_auto_deploy
```

Opcionales:

```text
VPS_PORT      puerto SSH si no es 22
DEPLOY_PATH   ruta del proyecto si no es /opt/twitch-vod-auto
```

## 4. Flujo de trabajo diario

Trabaja en local como siempre. Para desplegar a produccion:

```bash
git add .
git commit -m "mensaje"
git push origin main
```

GitHub Actions entrara por SSH al VPS, hara `git pull --ff-only origin main` y ejecutara:

```bash
docker compose -f docker-compose.prod.yml up --build -d --remove-orphans
```

Si el VPS tiene cambios manuales en archivos versionados, el deploy fallara en vez de pisarlos. En ese caso, revisa `git status --short` en el VPS y deja los cambios locales en archivos ignorados por Git, como `config.prod.local.json` o `.env`.
