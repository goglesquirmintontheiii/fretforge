# Self-hosted Fretforge server (no desktop shell): open http://host:7700 in any browser.
FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/desktop/package.json packages/desktop/
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
# Python lets Settings → AI tools install Demucs and friends into /data/ai-venv (kept in the volume)
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /src/packages/server/dist/main.js /app/server/main.js
COPY --from=build /src/packages/web/dist /app/web
COPY ai /app/ai
ENV NODE_ENV=production \
    FRETFORGE_MODE=server \
    FRETFORGE_DATA=/data \
    FRETFORGE_LIBRARY=/library \
    FRETFORGE_STATIC=/app/web \
    FRETFORGE_POLL=1 \
    FRETFORGE_AI_DIR=/app/ai \
    FRETFORGE_PORT=7700
VOLUME ["/data", "/library"]
EXPOSE 7700
CMD ["node", "/app/server/main.js"]
