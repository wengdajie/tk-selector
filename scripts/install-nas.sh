#!/bin/sh
# 选片台 · 群晖一键安装（在 DSM「任务计划」里以 root 运行）
# 一行命令：
#   curl -sfL http://192.168.1.19:8899/install-nas.sh -o /tmp/i.sh && sh /tmp/i.sh
# 注意：不要用 curl | sh —— 脚本里的 heredoc 会吃掉管道输入
set -e

SRC="${SRC:-http://192.168.1.19:8899}"
PORT="${PORT:-88}"
PKG="${PKG:-tk-selector-1.1.0.tar.gz}"
DIR="${DIR:-/volume1/docker/tk-selector}"
WATCH="${WATCH:-/volume1/拍摄投递}"
LOG=/tmp/tk-selector-install.log

export PATH="/usr/local/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

say() { echo "$@" | tee -a "$LOG"; }

say "=== 选片台安装 $(date '+%F %T') ==="

# 0. 探测群晖账号 UID/GID（容器用它落盘，否则 NAS 上会显示成奇怪的属主）
PUID=$(id -u admin 2>/dev/null || echo 1026)
PGID=$(id -g admin 2>/dev/null || echo 100)
say "[0/5] 使用 PUID=$PUID PGID=$PGID，端口 $PORT"

# 1. 下载
say "[1/5] 下载部署包 ..."
mkdir -p "$DIR" && cd /tmp
rm -f tk.tgz
if command -v wget >/dev/null 2>&1; then
  wget -q -O tk.tgz "$SRC/$PKG" || { say "下载失败：$SRC/$PKG"; exit 1; }
else
  curl -sfL -o tk.tgz "$SRC/$PKG" || { say "下载失败：$SRC/$PKG"; exit 1; }
fi
say "      $(ls -lh tk.tgz | awk '{print $5}')"

# 2. 解包
say "[2/5] 解包到 $DIR ..."
tar xzf tk.tgz -C "$DIR" --strip-components=1
[ -f "$DIR/Dockerfile" ] || { say "解包异常：没有 Dockerfile"; exit 1; }
say "      $(ls "$DIR" | tr '\n' ' ')"

# 3. 配置
say "[3/5] 写入 compose 配置 ..."
mkdir -p "$WATCH" "$DIR/data"
chmod 777 "$DIR/data"
cat > "$DIR/docker-compose.yml" <<EOF
services:
  tk-selector:
    build: .
    image: tk-selector:1.1
    container_name: tk-selector
    restart: unless-stopped
    ports:
      - "$PORT:8080"
    environment:
      TZ: Asia/Shanghai
      PUID: "$PUID"
      PGID: "$PGID"
      SCAN_DIR: /watch
      SCAN_MODE: copy
      SCAN_INTERVAL: "300"
      ADMIN_NAME: 管理员
      MAX_UPLOAD_MB: "8192"
    volumes:
      - ./data:/data
      - $WATCH:/watch:ro
EOF

# 4. 启动
say "[4/5] 构建并启动（首次 3-8 分钟，ffmpeg 层较大，请耐心等）..."
cd "$DIR"
if docker compose version >/dev/null 2>&1; then
  docker compose up -d --build 2>&1 | tee -a "$LOG"
else
  docker-compose up -d --build 2>&1 | tee -a "$LOG"
fi

# 5. 自检
say "[5/5] 等待服务就绪 ..."
ok=0; i=0
while [ $i -lt 40 ]; do
  code=$(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/healthz" 2>/dev/null || echo 000)
  [ "$code" = "200" ] && { ok=1; break; }
  i=$((i+1)); sleep 3
done

say ""
if [ "$ok" = "1" ]; then
  say "✅ 部署成功"
  say "   访问    http://192.168.1.4:$PORT"
  say "   数据    $DIR/data"
  say "   投递    $WATCH  （拍摄往这里丢视频，5 分钟自动入库）"
  say "   改端口  编辑器里改 PORT 后重跑本脚本"
else
  say "⚠️  健康检查未通过，最近日志："
  docker logs --tail 40 tk-selector 2>&1 | tee -a "$LOG"
  say ""
  say "完整日志：$LOG"
fi
