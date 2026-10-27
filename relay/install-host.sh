#!/usr/bin/env bash
# 注册 Agent Browser Bridge 的 Native Messaging Host 到本机 Chrome
# 用法：
#   ./install-host.sh                    # 自动根据 ../extension 路径计算 Chrome 扩展 ID
#   ./install-host.sh <extension-id>     # 显式指定扩展 ID
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="$(cd "$DIR/../extension" && pwd -P)"
HOST_NAME="com.agentbrowser.bridge"

EXT_ID="${1:-}"
if [ -z "$EXT_ID" ]; then
  EXT_ID="$(node -e '
const crypto = require("crypto"), fs = require("fs");
const p = fs.realpathSync(process.argv[1]);
const h = crypto.createHash("sha256").update(p).digest("hex").slice(0, 32);
process.stdout.write(h.replace(/./g, c => String.fromCharCode(97 + parseInt(c, 16))));
' "$EXT_DIR")"
fi
EXT_ID="$(echo "$EXT_ID" | tr -d '[:space:]' | sed 's/^chrome-extension:\/\///; s|/$||')"
if [ -z "$EXT_ID" ]; then
  echo "错误: 未能确定扩展 ID" >&2
  exit 1
fi

MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
mkdir -p "$MANIFEST_DIR"
HOST_PATH="$DIR/host.sh"
chmod +x "$DIR/host.sh" "$DIR/host.js" 2>/dev/null

TMP="$MANIFEST_DIR/${HOST_NAME}.json.tmp"
cat > "$TMP" <<EOF
{
  "name": "${HOST_NAME}",
  "description": "Agent Browser Bridge Native Messaging Host",
  "path": "${HOST_PATH}",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://${EXT_ID}/"
  ]
}
EOF
mv "$TMP" "$MANIFEST_DIR/${HOST_NAME}.json"

echo ""
echo " ✓ 已注册 native messaging host:"
echo "   $MANIFEST_DIR/${HOST_NAME}.json"
echo "   扩展目录: ${EXT_DIR}"
echo "   扩展 ID:  ${EXT_ID}"
echo "   host:     ${HOST_PATH}"
echo ""
echo " 下一步: 在 chrome://extensions 开启「开发者模式」加载 ${EXT_DIR}，然后按 Cmd+Q 重启 Chrome。"
