#!/bin/bash
# setup-server.sh - Script de preparacion del servidor Ubuntu
# Ejecutar en el droplet de DigitalOcean como root

set -e

DOMAIN="${1:-vod.privatevods.com}"
EMAIL="${2:-admin@privatevods.com}"
PROJECT_DIR="/opt/twitch-vod-auto"

echo "=========================================="
echo " Twitch VOD Auto - Server Setup"
echo " Dominio: $DOMAIN"
echo "=========================================="

# 1. Actualizar sistema
echo "[1/7] Actualizando sistema..."
apt-get update -qq
apt-get install -y -qq \
    apt-transport-https \
    ca-certificates \
    curl \
    gnupg \
    lsb-release \
    software-properties-common \
    git \
    nginx \
    certbot

# 2. Instalar Docker
echo "[2/7] Instalando Docker..."
if ! command -v docker &> /dev/null; then
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" > /etc/apt/sources.list.d/docker.list
    apt-get update -qq
    apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
    systemctl enable docker --now
fi

# 3. Verificar Docker Compose
echo "[3/7] Verificando Docker Compose..."
if ! command -v docker compose &> /dev/null; then
    curl -L "https://github.com/docker/compose/releases/download/v2.27.1/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
    chmod +x /usr/local/bin/docker-compose
    ln -sf /usr/local/bin/docker-compose /usr/bin/docker-compose
fi

# 4. Crear estructura de directorios
echo "[4/7] Creando directorios..."
mkdir -p $PROJECT_DIR
mkdir -p $PROJECT_DIR/data
mkdir -p $PROJECT_DIR/logs
mkdir -p $PROJECT_DIR/downloads
mkdir -p $PROJECT_DIR/certbot-data
mkdir -p $PROJECT_DIR/certbot-www
cd $PROJECT_DIR

# 5. Crear .env si no existe
echo "[5/7] Creando .env de ejemplo..."
if [ ! -f "$PROJECT_DIR/.env" ]; then
cat > $PROJECT_DIR/.env << EOF
# Twitch API (opcional pero recomendado para monitoreo)
TWITCH_CLIENT_ID=
TWITCH_CLIENT_SECRET=

# Dashboard
DASHBOARD_HOST=0.0.0.0
DASHBOARD_PORT=8080
EOF
fi

# 6. Crear nginx.conf base si no existe
echo "[6/7] Preparando nginx..."
if [ ! -f "$PROJECT_DIR/nginx.conf" ]; then
cat > $PROJECT_DIR/nginx.conf << 'EOF'
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://dashboard:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }

    location /api/ {
        proxy_pass http://dashboard:8080/api/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }
}
EOF
fi

# 7. Crear config.json base si no existe
if [ ! -f "$PROJECT_DIR/config.json" ]; then
    if [ -f "$PROJECT_DIR/config.prod.json" ]; then
        cp $PROJECT_DIR/config.prod.json $PROJECT_DIR/config.json
    fi
fi

# 8. Crear servicio systemd
echo "[7/7] Creando servicio systemd..."
cat > /etc/systemd/system/twitch-vod-auto.service << EOF
[Unit]
Description=Twitch VOD Auto Pipeline
After=docker.service network.target
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$PROJECT_DIR
ExecStart=/usr/bin/docker compose -f docker-compose.prod.yml up -d
ExecStop=/usr/bin/docker compose -f docker-compose.prod.yml down
TimeoutStartSec=300

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable twitch-vod-auto.service

echo ""
echo "=========================================="
echo " SETUP COMPLETADO"
echo "=========================================="
echo ""
echo "Directorio del proyecto: $PROJECT_DIR"
echo ""
echo "ARCHIVOS QUE DEBES SUBIR AHORA:"
echo "  1. client_secret.json"
echo "  2. youtube_credentials.pkl"
echo "  3. config.json (editado con tus canales)"
echo "  4. .env (opcional, con TWITCH_CLIENT_ID/SECRET)"
echo ""
echo "Despues de subir los archivos:"
echo "  cd $PROJECT_DIR"
echo "  docker compose -f docker-compose.prod.yml up --build -d"
echo ""
