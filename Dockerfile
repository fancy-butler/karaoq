# KARAO-Q server for a NAS / home server / always-on box.
# The TV just opens http://<this-box>:8080/stage in any browser (smart TV browser, Fire TV Silk, Chromecast w/ Google TV…).
#   docker run -d --name karaoq -p 8080:8080 -v karaoq-data:/data -v /path/to/karaoke:/library:ro ghcr.io/fancy-butler/karaoq
FROM node:22-bookworm-slim

ARG TARGETARCH
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl unzip tini \
 && rm -rf /var/lib/apt/lists/*

# yt-dlp (keeps itself up to date at runtime), deno (yt-dlp needs a JS runtime for YouTube), cloudflared (the "Can't connect?" internet link)
RUN set -eux; \
    case "$TARGETARCH" in arm64) YT=yt-dlp_linux_aarch64; DENO=aarch64-unknown-linux-gnu; CF=arm64 ;; *) YT=yt-dlp_linux; DENO=x86_64-unknown-linux-gnu; CF=amd64 ;; esac; \
    curl -fsSL -o /usr/local/bin/yt-dlp "https://github.com/yt-dlp/yt-dlp/releases/latest/download/$YT"; \
    curl -fsSL -o /tmp/deno.zip "https://github.com/denoland/deno/releases/latest/download/deno-$DENO.zip"; \
    unzip -q /tmp/deno.zip -d /usr/local/bin; rm /tmp/deno.zip; \
    curl -fsSL -o /usr/local/bin/cloudflared "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$CF"; \
    chmod +x /usr/local/bin/yt-dlp /usr/local/bin/deno /usr/local/bin/cloudflared

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY server.js ./
COPY lib ./lib
COPY public ./public

ENV PORT=8080 DATA_DIR=/data KQ_LIBRARY=/library YTDLP=/usr/local/bin/yt-dlp NODE_ENV=production
VOLUME ["/data"]
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
