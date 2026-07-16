#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
node "$SCRIPT_DIR/install-server-plugin.js" "$@"

echo
echo "完成后请重启 SillyTavern，再刷新浏览器页面。"
