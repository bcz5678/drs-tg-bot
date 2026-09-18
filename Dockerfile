# ---- build stage: dev deps + TS compile ------------------------------------
FROM node:24-bookworm-slim AS build
WORKDIR /app

# Copy manifests first so npm ci is cached when only source changes
COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build          # tsc -> ./dist

# Reinstall prod-only deps into a clean node_modules for the runtime stage
RUN npm ci --omit=dev

# ---- runtime stage ----------------------------------------------------------
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    TZ=UTC \
    NODE_OPTIONS=--enable-source-maps

# dumb-init makes PID 1 forward SIGTERM so Coolify restarts/redeploys
# shut the Telegram connection down cleanly instead of killing it
RUN apt-get update && apt-get install -y --no-install-recommends dumb-init \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# node:* images ship a non-root "node" user (uid 1000) — use it
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

# Session/state volume (StoreSession, last-seen message ids if file-backed)
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

USER node

# Coolify polls this; see the health endpoint note below
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/listener.js"]