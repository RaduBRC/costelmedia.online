# Multi-stage build for the backend API + cron scheduler (src/server,
# src/cron, and everything they import). The frontend is a static Vite
# build deployed separately (see vercel.json) — it has no place in this
# image.
#
# NOTE: this repo currently keeps frontend deps (react, react-dom,
# lucide-react) and backend deps in one package.json, so `npm ci` below
# installs a few packages the runtime image never uses. Splitting into
# real npm workspaces would trim that, but is a bigger restructuring than
# this Dockerfile should take on by itself.

# ---- deps: install once, reused by both the build and runtime stages ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- build: compile TypeScript -> dist/, and the embeddable widget -> public/widget.js ----
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build:server
RUN npm run build:widget

# ---- runtime: production deps only + compiled output ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
# src/api/routes/widget.ts serves public/widget.js directly from disk at
# runtime — only the compiled bundle is needed here, not the rest of
# public/ (icons/, manifest.webmanifest, sw-advanced.js are PWA assets for
# the separately-deployed frontend, see vercel.json).
COPY --from=build /app/public/widget.js ./public/widget.js

USER app
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server/index.js"]
