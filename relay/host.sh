#!/usr/bin/env bash
# Agent Browser Bridge - 启动包装器
# native messaging host 由 Chrome 以最小 PATH 环境拉起，这里负责找到 node 再执行 host.js
#
# Chrome 拉起时的环境有两个坑，这里都必须处理：
#   1. HOME 可能未设置 —— `set -u` 下直接引用 ${HOME} 会让脚本崩溃（现象：host 静默起不来）。
#   2. PATH 是最小集，不含版本管理器的 shim —— 必须自己拼绝对路径。
# 历史故障：本机 node 是 fnm 装的（路径含空格，且不在 .nvm 下），候选列表漏了它，
# Chrome 拉起 host 时拿到 "error: node not found"，扩展永远连不上，整个桥对外表现为不可用。
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
HOME="${HOME:-$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f6)}"
HOME="${HOME:-/Users/$(id -un)}"

NODE_EXEC=""

# 第一优先：版本管理器的 default alias —— 与用户在 shell 里用的是同一个版本，行为最一致
for cand in \
  "${HOME}/Library/Application Support/fnm/aliases/default/bin/node" \
  "${HOME}/.nvm/alias/default/bin/node" \
  "${HOME}/.volta/bin/node"
 do
  if [ -x "$cand" ]; then NODE_EXEC="$cand"; break; fi
done

# 第二优先：版本目录。glob 升序展开，最后一个匹配即最高版本（不 break，持续覆盖）
if [ -z "$NODE_EXEC" ]; then
  for pat in \
    "${HOME}/Library/Application Support/fnm/node-versions/"*/installation/bin/node \
    "${HOME}/.nvm/versions/node/"*/bin/node \
    "${HOME}/.local/share/nvm/versions/node/"*/bin/node \
    "${HOME}/.volta/tools/image/node/"*/bin/node
   do
    if [ -x "$pat" ]; then NODE_EXEC="$pat"; fi
  done
fi

# 第三优先：系统级固定路径
if [ -z "$NODE_EXEC" ]; then
  for cand in \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    /opt/local/bin/node
   do
    if [ -x "$cand" ]; then NODE_EXEC="$cand"; break; fi
  done
fi

# 末位兜底：万一上面都没中，但 PATH 里确实有 node
if [ -z "$NODE_EXEC" ] && command -v node >/dev/null 2>&1; then
  NODE_EXEC="$(command -v node)"
fi
if [ -z "$NODE_EXEC" ]; then
  echo "error: node not found" >&2
  exit 1
fi

exec "$NODE_EXEC" "$DIR/host.js" "$@"
