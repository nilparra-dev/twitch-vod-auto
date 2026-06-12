# Build stage
FROM python:3.12-slim as builder

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    libffi-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --user --no-cache-dir -r requirements.txt

# Runtime stage
FROM python:3.12-slim

WORKDIR /app

# Instalar ffmpeg, git, nodejs, npm
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    git \
    nodejs \
    npm \
    && rm -rf /var/lib/apt/lists/*

# Instalar twitch-dlp globalmente
RUN npm install -g twitch-dlp

# Copiar dependencias Python del builder
COPY --from=builder /root/.local /root/.local
ENV PATH=/root/.local/bin:$PATH

# Copiar codigo fuente
COPY . .

# Crear directorios necesarios
RUN mkdir -p data logs downloads

# Puerto del dashboard
EXPOSE 8080

CMD ["python", "auto_pipeline.py"]
