FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY angular.json tsconfig.json tsconfig.app.json src public server ./
RUN npm run build

FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=3000 \
    VIDEO_ROOT=/data/videos \
    DATABASE_PATH=/data/catalog/bright-video.db

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && mkdir -p /data/videos /data/catalog
COPY --from=build /app/dist ./dist
COPY server ./server

EXPOSE 3000
VOLUME ["/data/videos", "/data/catalog"]
CMD ["node", "server/index.mjs"]