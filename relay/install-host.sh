#!/usr/bin/env bash
# 注册 Agent Browser Bridge 的 Native Messaging Host
# 用法：
#   ./install-host.sh                      # Chrome：自动根据 ../extension 路径计算扩展 ID
#   ./install-host.sh <extension-id>       # Chrome：显式指定扩展 ID
#   ./install-host.sh --browser firefox    # Firefox：扩展 ID 固定为 build-firefox.js 里的 gecko id
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="$(cd "$DIR/../extension" && pwd -P)"
HOST_NAME="com.agentbrowser.bridge"

BROWSER="chrome"
EXT_ID=""
while [ $# -gt 0 ]; do
  case "$1" in
    --browser) BROWSER="${2:-}"; shift 2 ;;
    *) EXT_ID="$1"; shift ;;
  esac
done

HOST_PATH="$DIR/host.sh"
chmod +x "$DIR/host.sh" "$DIR/host.js" 2>/dev/null

if [ "$BROWSER" = "firefox" ]; then
  GECKO_ID="$(node -p 'require(process.argv[1]).GECKO_ID' "$DIR/build-firefox.js")"
  MANIFEST_DIR="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"
  mkdir -p "$MANIFEST_DIR"
  TMP="$MANIFEST_DIR/${HOST_NAME}.json.tmp"
  cat > "$TMP" <<EOF
{
  "name": "${HOST_NAME}",
  "description": "Agent Browser Bridge Native Messaging Host",
  "path": "${HOST_PATH}",
  "type": "stdio",
  "allowed_extensions": [
    "${GECKO_ID}"
  ]
}
EOF
  mv "$TMP" "$MANIFEST_DIR/${HOST_NAME}.json"
  echo ""
  echo " ✓ 已注册 Firefox native messaging host:"
  echo "   $MANIFEST_DIR/${HOST_NAME}.json"
  echo "   扩展 ID:  ${GECKO_ID}"
  echo "   host:     ${HOST_PATH}"
  echo ""
  echo " 下一步: 退出 Firefox（Cmd+Q），然后运行 node $DIR/firefox-launch.js 启动 Firefox 并加载扩展。"
  exit 0
fi

if [ "$BROWSER" != "chrome" ]; then
  echo "错误: --browser 仅支持 chrome / firefox，收到 ${BROWSER}" >&2
  exit 1
fi

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
