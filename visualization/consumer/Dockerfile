# syntax=docker/dockerfile:1

FROM node:22-alpine AS base
WORKDIR /app

FROM base AS build
COPY package.json package-lock.json ./
COPY frontend/package.json ./frontend/package.json
RUN npm ci --include=dev --no-audit --no-fund
COPY frontend/ ./frontend/
RUN npm run build

FROM base AS production-dependencies
COPY package.json package-lock.json ./
COPY frontend/package.json ./frontend/package.json
RUN npm ci --omit=dev --workspaces=false --no-audit --no-fund \
    && npm cache clean --force

FROM base AS production
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8000
COPY --chown=node:node package.json ./
COPY --chown=node:node --from=production-dependencies /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist/client ./dist/client
COPY --chown=node:node server/ ./server/
USER node
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node --input-type=module -e "const r = await fetch('http://127.0.0.1:' + (process.env.PORT || 8000) + '/health'); if (!r.ok) process.exit(1)"
CMD ["node", "server/index.js"]
