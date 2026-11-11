# The app server and the web app it serves (docs/deploy.md). One replica: its SQLite database is a file on the volume
# at /data, with one writer.
FROM oven/bun:1.4.2-slim
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY tsconfig.json ./
COPY src ./src
# Root, as Railway mounts the volume owned by root.
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["bun", "src/server/index.ts"]
