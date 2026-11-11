#!/bin/sh
# 选片台 · 在线升级（从 GitHub 拉最新源码 → 覆盖 → 重启容器）
# 群晖用法（任务计划，用户选 root）：
#   curl -fsSL https://raw.githubusercontent.com/wengadajie/tk-selector/main/scripts/nas-upgrade.sh -o /tmp/up.sh && sh /tmp/up.sh
# 可用环境变量覆盖：TK_DIR / TK_REPO / TK_BRANCH / TK_PORT
set -e

DIR=${TK_DIR:-/volume1/docker/tk/tk-selector}
REPO=${TK_REPO:-wengadajie/tk-selector}
BRANCH=${TK_BRANCH:-main}
PORT=${TK_PORT:-8899}
NAME=${TK_NAME:-tk-selector}

echo "================ 选片台 · 在线升级 ================"
echo "仓库      $REPO@$BRANCH"
echo "目标目录  $DIR"

[ -d "$DIR" ] || { echo "✗ 目录不存在：$DIR"; exit 1; }

# 0. 检查容器是否挂载了源码目录（决定改完要不要构建）
MOUNTS=$(docker inspect -f '{{range .Mounts}}{{.Source}} {{end}}' "$NAME" 2>/dev/null || true)
CODE_MOUNTED=0
case "$MOUNTS" in
  *"/server"*) CODE_MOUNTED=1 ;;
esac
echo "源码挂载  $([ "$CODE_MOUNTED" = "1" ] && echo '已挂载（改完重启即可）' || echo '未挂载（改完需要重新构建镜像）')"

# 1. 备份
TS=$(date +%Y%m%d-%H%M%S)
cp -R "$DIR/public" "/tmp/public.$TS.bak" 2>/dev/null || true
cp -R "$DIR/server" "/tmp/server.$TS.bak" 2>/dev/null || true
echo "① 已备份到 /tmp/public.$TS.bak、/tmp/server.$TS.bak"

# 2. 下载
URL="https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH"
echo "② 下载 $URL"
curl -fsSL --retry 3 --connect-timeout 15 "$URL" -o /tmp/tk-src.tgz
echo "   已下载 $(wc -c < /tmp/tk-src.tgz) 字节"

# 3. 解压（不碰 data）
rm -rf /tmp/tk-src && mkdir -p /tmp/tk-src
tar -xzf /tmp/tk-src.tgz -C /tmp/tk-src
SRC=$(find /tmp/tk-src -maxdepth 1 -mindepth 1 -type d | head -1)
[ -n "$SRC" ] || { echo "✗ 解压结构异常"; exit 1; }
cp -R "$SRC/." "$DIR/"
echo "③ 已覆盖源码（data 目录未动）"

# 4. 版本
VER=$(grep -o '"version": *"[^"]*"' "$DIR/package.json" | head -1 | tr -d ' ')
echo "④ 当前文件版本 $VER"

# 5. 生效
if [ "$CODE_MOUNTED" = "1" ]; then
  echo "⑤ 重启容器…"
  docker restart "$NAME" >/dev/null
  sleep 6
  echo "   健康检查：$(curl -s "http://127.0.0.1:$PORT/api/version" || echo '未响应')"
else
  echo "⑤ 容器未挂载源码，需要重新构建镜像才会生效："
  echo "   Container Manager → 项目 → 停止 → 构建"
fi
echo "=================================================="
