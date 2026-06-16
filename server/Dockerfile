FROM python:3.12-slim

# ffmpeg isn't strictly required (the app does the muxing) but a few yt-dlp
# extractors call out to ffprobe to read manifest metadata. Tiny image hit.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates git \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
# Force yt-dlp upgrade on every build to avoid stale Docker-layer caches.
# requirements.txt pins to master but pip skips reinstall if the layer is cached.
RUN pip install --no-cache-dir --upgrade yt-dlp

# Copy all server modules (main.py + service layers)
COPY main.py config.py models.py registry.py classifier.py auth.py \
     telemetry.py extractors.py new_extractors.py strategies.py supervisor.py \
     source_audit.py utils.py languages.py universal.py ./

ENV PORT=8080 \
    PYTHONIOENCODING=utf-8 \
    LANG=en_US.UTF-8 \
    LC_ALL=en_US.UTF-8
EXPOSE 8080

# 1 worker is enough — yt-dlp calls are I/O-bound; uvicorn handles concurrency.
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT} --workers 1"]
