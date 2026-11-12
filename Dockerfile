# The app server and the web app it serves (docs/deploy.md). One replica: its SQLite database is a file on the volume
# at /data, with one writer.
FROM oven/bun:1.4.2-slim
WORKDIR /app
COPY package.json bun.lock ./
COPY vendor/multiagency-sdk/multiagency-sdk-0.5.9-252cba1.tgz ./vendor/multiagency-sdk/
RUN bun install --frozen-lockfile --production
COPY tsconfig.json ./
COPY src ./src
COPY scripts/build-web.ts ./scripts/build-web.ts
RUN bun --no-env-file scripts/build-web.ts /app/web-dist
# Root, as Railway mounts the volume owned by root.
ENV NODE_ENV=production PORT=8080 PAPERWORK_WEB_DIST=/app/web-dist
EXPOSE 8080
CMD ["bun", "src/server/index.ts"]
