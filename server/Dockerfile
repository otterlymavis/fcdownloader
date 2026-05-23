FROM python:3.12-slim

# ffmpeg isn't strictly required (the app does the muxing) but a few yt-dlp
# extractors call out to ffprobe to read manifest metadata. Tiny image hit.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

ENV PORT=8080
EXPOSE 8080

# 1 worker is enough — yt-dlp calls are I/O-bound; uvicorn handles concurrency.
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT} --workers 1"]
