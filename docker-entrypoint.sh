#!/bin/sh
set -e

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

if [ "$(id -u)" = "0" ]; then
  # 对齐群晖 NAS 上的用户/用户组，避免挂载目录写不进去
  if [ "$PGID" != "1000" ]; then
    groupmod -o -g "$PGID" app 2>/dev/null || echo "[entry] 组 ID 调整失败，保留 1000"
  fi
  if [ "$PUID" != "1000" ]; then
    usermod -o -u "$PUID" app 2>/dev/null || echo "[entry] 用户 ID 调整失败，保留 1000"
  fi

  mkdir -p "$DATA_DIR" "$MEDIA_DIR" 2>/dev/null || true
  chown -R app:app "$DATA_DIR" 2>/dev/null || echo "[entry] 数据目录授权失败，请检查挂载权限"

  echo "[entry] 以 app($(id -u app):$(id -g app)) 运行"
  exec gosu app "$@"
fi

exec "$@"
