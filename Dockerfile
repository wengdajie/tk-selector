# ---------- 依赖构建阶段 ----------
FROM node:22-bookworm-slim AS deps
WORKDIR /app

# 国内网络：apt 走阿里云镜像（默认），可用 --build-arg APT_MIRROR=deb.debian.org 还原官方源
ARG APT_MIRROR=mirrors.aliyun.com
RUN if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
      sed -i "s|deb.debian.org|${APT_MIRROR}|g; s|security.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources; \
    else \
      sed -i "s|deb.debian.org|${APT_MIRROR}|g; s|security.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list; \
    fi \
 && apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
# npm 走 npmmirror，可用 --build-arg NPM_REGISTRY=https://registry.npmjs.org 还原
ARG NPM_REGISTRY=https://registry.npmmirror.com
RUN npm config set registry "$NPM_REGISTRY" \
 && npm ci --omit=dev --no-audit --no-fund \
 && npm config delete registry

# ---------- 运行阶段 ----------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ARG APT_MIRROR=mirrors.aliyun.com
RUN if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
      sed -i "s|deb.debian.org|${APT_MIRROR}|g; s|security.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources; \
    else \
      sed -i "s|deb.debian.org|${APT_MIRROR}|g; s|security.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list; \
    fi \
 && apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg gosu tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# 基础镜像已内置 node 用户占用了 1000，这里用 1001 避免冲突；
# 容器启动时 docker-entrypoint.sh 会用 groupmod/usermod 把 app 调整成 PUID/PGID。
RUN (getent group app >/dev/null || groupadd -g 1001 app || groupadd app) \
 && (id -u app >/dev/null 2>&1 || useradd -m -u 1001 -g app app || useradd -m -g app app)

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY public ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
 && chmod +x /usr/local/bin/docker-entrypoint.sh \
 && mkdir -p /data /watch \
 && chown -R app:app /app /data

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    MEDIA_DIR=/data/media \
    SCAN_DIR=/watch \
    SCAN_MODE=copy \
    SCAN_INTERVAL=300 \
    TZ=Asia/Shanghai

EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server/index.js"]
