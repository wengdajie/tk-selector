#!/bin/sh
# 选片台 · 公网地址自动同步（Cloudflare 快速隧道）
# 快速隧道的 trycloudflare.com 域名在容器重启后会变，本脚本把最新地址写进系统设置。
# 用法：sudo sh update-public-base.sh
set -e
C=tk-selector
T=tk-tunnel

URL=$(docker logs --tail 200 "$T" 2>&1 | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | tail -1)
if [ -z "$URL" ]; then
  echo "[x] 没在 $T 日志里找到公网地址，确认容器在运行：docker ps | grep $T"
  exit 1
fi

UID_=$(docker exec "$C" node -e "const D=require('/app/node_modules/better-sqlite3');const db=new D('/data/app.db',{readonly:true});console.log(db.prepare(\"SELECT id FROM users WHERE role='admin' AND active=1 LIMIT 1\").get().id)" | tr -d '\r')
if [ -z "$UID_" ]; then echo "[x] 取管理员 id 失败"; exit 1; fi

CODE=$(curl -s -m 10 -o /tmp/pb.out -w '%{http_code}' -X PUT http://127.0.0.1:8899/api/settings/notify \
  -H "x-user-id: $UID_" -H 'content-type: application/json' \
  -d "{\"notify_public_base\":\"$URL\"}")
if [ "$CODE" = "200" ]; then
  echo "[ok] 公网地址已同步：$URL"
else
  echo "[x] 更新失败 HTTP $CODE：$(head -c 200 /tmp/pb.out)"
  exit 1
fi
