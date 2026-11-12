#!/bin/sh
# TK 选片工作台 —— 一键更新到最新镜像
# 用法：把本文件和 docker-compose.yml 放在同一个目录，执行 sh update.sh
set -e

cd "$(dirname "$0")"

COMPOSE_FILE="docker-compose.yml"
[ -f "docker-compose.ghcr.yml" ] && COMPOSE_FILE="docker-compose.ghcr.yml"

echo "==> 拉取最新镜像"
if command -v docker >/dev/null 2>&1; then
  if docker compose version >/dev/null 2>&1; then
    docker compose -f "$COMPOSE_FILE" pull
    echo "==> 重建容器"
    docker compose -f "$COMPOSE_FILE" up -d
  else
    docker-compose -f "$COMPOSE_FILE" pull
    echo "==> 重建容器"
    docker-compose -f "$COMPOSE_FILE" up -d
  fi
else
  echo "[FATAL] 找不到 docker 命令" >&2
  exit 1
fi

echo "==> 清理旧镜像（不影响正在运行的容器）"
docker image prune -f >/dev/null 2>&1 || true

echo "==> 当前版本"
docker inspect --format '{{.Config.Image}}  {{.Created}}' tk-selector 2>/dev/null || true
echo "完成。浏览器打开 http://<NAS地址>:8899 即可。"
