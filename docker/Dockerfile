# syntax=docker/dockerfile:1
# ビルドコンテキストはリポジトリ直下（compose.yaml から build される）

FROM node:24-bookworm-slim AS build
WORKDIR /app
# better-sqlite3 のビルド済みバイナリが無い環境でもビルドできるようにする
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @pos/web build \
  && pnpm --filter @pos/server build \
  && pnpm --filter @pos/server deploy --prod --legacy /out

FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    TZ=Asia/Tokyo \
    PORT=3000 \
    DATABASE_PATH=/data/pos.sqlite \
    MIGRATIONS_DIR=/app/drizzle \
    WEB_DIST_DIR=/app/web
WORKDIR /app
COPY --from=build /out/package.json ./
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /app/apps/server/dist ./dist
COPY --from=build /app/apps/server/drizzle ./drizzle
COPY --from=build /app/apps/web/dist ./web
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:3000/api/system/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
