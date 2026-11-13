# syntax=docker/dockerfile:1

# 固定 Node 主版本，避免构建时悄然跨大版本。
# 多阶段构建：builder 内安装全部 workspace、编译服务端与网页，runtime 只运行产物。
FROM node:24-bookworm-slim AS build

WORKDIR /app
ENV npm_config_update_notifier=false

# 复制所有 workspace 源码。这里不逐个列举 packages/*，因为后续会新增
# provider 插件与客户端插件包；漏掉任一 package.json 都会让 npm ci 报
# missing workspace。构建缓存的代价换来的是不会因新增包而构建失败。
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY tests ./tests

# 防止 .env 被误带入构建上下文；一旦带入直接失败，而不是把密钥烘进镜像层。
RUN if [ -f .env ]; then echo "构建上下文包含 .env，请检查 deploy/Dockerfile.dockerignore" >&2; exit 1; fi

# 必须使用 lockfile 安装，禁止 npm install 改写依赖。
RUN npm ci

# 主模型会把 admin 构建与 client 构建并入 root build；
# 本文件不另跑一套构建，避免两处产物不一致。
RUN npm run build

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    MORIS_HOST=0.0.0.0 \
    MORIS_PORT=8787 \
    MORIS_DATA_DIR=/app/data \
    MORIS_ADMIN_DIST=/app/apps/admin/dist

WORKDIR /app

# 整体复制构建结果，确保 workspace 中的插件产物、dist 与 node_modules
# 都不会因路径假设而缺失。镜像体积可在产物布局稳定后再收窄。
COPY --from=build /app ./

# 非 root 运行；data 与 backups 使用卷，首次创建时沿用这里的属主。
RUN mkdir -p /app/data /app/backups \
    && chown -R node:node /app/data /app/backups

USER node

EXPOSE 8787

# 直接以 node 为 PID 1（compose 再启用 init），保证 SIGTERM 能到达应用，
# 由应用完成 Fastify 与 SQLite 的优雅关闭。
CMD ["node", "dist/apps/gateway/src/main.js"]
