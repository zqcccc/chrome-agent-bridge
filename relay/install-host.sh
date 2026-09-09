#!/usr/bin/env bash
# 注册 Agent Browser Bridge 的 Native Messaging Host 到本机 Chrome
# 用法：
#   ./install-host.sh                    # 交互式提示输入扩展 ID
#   ./install-host.sh <extension-id>     # 直接传入扩展 ID（chrome://extensions 里可看到）
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_NAME="com.agentbrowser.bridge"

EXT_ID="${1:-}"
if [ -z "$EXT_ID" ]; then
  echo ""
  echo " 1) 打开 chrome://extensions，开启右上角「开发者模式」"
  echo " 2) 点击「加载已解压的扩展程序」，选择: $DIR/../extension"
  echo " 3) 在扩展卡片上复制它的 ID（形如 abcdefghijklmnopqrstuvwxyzabcdef）"
  echo ""
  read -rp " 粘贴扩展 ID 后回车: " EXT_ID
fi
EXT_ID="$(echo "$EXT_ID" | tr -d '[:space:]' | sed 's/^chrome-extension:\/\///; s|/$||')"
if [ -z "$EXT_ID" ]; then
  echo "错误: 未提供扩展 ID" >&2
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
echo "   扩展 ID: ${EXT_ID}"
echo "   host:    ${HOST_PATH}"
echo ""
echo " 下一步: 打开扩展设置页（chrome-extension://${EXT_ID}/options.html）"
echo "  确认通道为 auto/native，然后重新打开 Chrome 让 host 注册生效。"
