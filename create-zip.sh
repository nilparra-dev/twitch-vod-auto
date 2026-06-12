#!/bin/bash
# Crear ZIP limpio excluyendo archivos pesados y temporales
# Ejecutar en Git Bash dentro de D:\Plugins\twitch-vod-auto

rm -f twitch-vod-auto.zip

zip -r twitch-vod-auto.zip \
  *.py \
  *.json \
  *.md \
  *.sh \
  *.yml \
  *.conf \
  *.txt \
  requirements.txt \
  .env \
  .env.example \
  .gitignore \
  .dockerignore \
  -x "downloads/*" \
  -x "data/*" \
  -x "logs/*" \
  -x "bin/*" \
  -x "ffmpeg_temp/*" \
  -x "__pycache__/*" \
  -x "*.pyc" \
  -x "*.mp4" \
  -x "*.zip" \
  -x "*.log"

echo ""
echo "Tamanio del ZIP:"
ls -lh twitch-vod-auto.zip
