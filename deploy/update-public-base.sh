#!/bin/sh
# 选片台 · 公网地址一键自愈（Cloudflare 快速隧道）
# 快速隧道的 trycloudflare.com 域名在容器重启后会变；本脚本会：
#   1) 隧道停了就先拉起；2) 从日志读取新域名；3) 验证域名可达；4) 写进系统设置。
# 用法：sudo sh update-public-base.sh
# 建议：在 NAS 的计划任务里每 10 分钟跑一次（或隧道重启后手动跑一次）。
set -e
# 群晖 SSH / 任务计划这类非交互 shell 的 PATH 里没有 /usr/local/bin，docker 会找不到
PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
export PATH
C=tk-selector
T=tk-tunnel

if ! docker inspect "$T" >/dev/null 2>&1; then
  echo "[x] 找不到容器 $T"
  exit 1
fi

STATUS=$(docker inspect -f '{{.State.Status}}' "$T")
if [ "$STATUS" != "running" ]; then
  echo "[..] $T 当前状态 $STATUS，正在启动"
  docker start "$T" >/dev/null
fi

URL=""
i=0
while [ "$i" -lt 20 ]; do
  URL=$(docker logs --tail 200 "$T" 2>&1 | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | tail -1)
  [ -n "$URL" ] && break
  i=$((i + 1))
  sleep 2
done
if [ -z "$URL" ]; then
  echo "[x] 没在 $T 日志里找到公网地址，请检查隧道容器日志"
  exit 1
fi

if ! curl -fsS -m 10 "$URL/healthz" >/dev/null 2>&1; then
  echo "[x] $URL 暂时不可达，稍后重试"
  exit 1
fi

UID_=$(docker exec "$C" node -e "const D=require('/app/node_modules/better-sqlite3');const db=new D('/data/app.db',{readonly:true});console.log(db.prepare(\"SELECT id FROM users WHERE role='admin' AND active=1 LIMIT 1\").get().id)" | tr -d '\r')
if [ -z "$UID_" ]; then echo "[x] 取管理员 id 失败"; exit 1; fi

CUR=$(curl -s -m 10 http://127.0.0.1:8899/api/settings/notify -H "x-user-id: $UID_" | grep -o '"publicBase":"[^"]*"' | cut -d'"' -f4)
if [ "$CUR" = "$URL" ]; then
  echo "[ok] 公网地址未变化：$URL"
  exit 0
fi

CODE=$(curl -s -m 10 -o /tmp/pb.out -w '%{http_code}' -X PUT http://127.0.0.1:8899/api/settings/notify \
  -H "x-user-id: $UID_" -H 'content-type: application/json' \
  -d "{\"notify_public_base\":\"$URL\"}")
if [ "$CODE" = "200" ]; then
  echo "[ok] 公网地址已同步：$URL"
else
  echo "[x] 更新失败 HTTP $CODE：$(head -c 200 /tmp/pb.out)"
  exit 1
fi
