#!/usr/bin/env bash
# Agent Browser Bridge - 启动包装器
# native messaging host 由 Chrome 以最小 PATH 环境拉起，这里负责找到 node 再执行 host.js
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"

NODE_EXEC=""
for cand in \
  "${HOME}/.nvm/versions/node/"*/bin/node \
  /opt/homebrew/bin/node \
  /usr/local/bin/node \
  /opt/local/bin/node
; do
  if [ -n "$NODE_EXEC" ]; then break; fi
  if [ -x "$cand" ]; then NODE_EXEC="$cand"; fi
done
if [ -z "$NODE_EXEC" ] && command -v node >/dev/null 2>&1; then
  NODE_EXEC="$(command -v node)"
fi
if [ -z "$NODE_EXEC" ]; then
  echo "error: node not found" >&2
  exit 1
fi

exec "$NODE_EXEC" "$DIR/host.js" "$@"
