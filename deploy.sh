#!/bin/bash
# 把编译产物装进 Obsidian 库：只新增/更新 pdfmark 这一个目录，不碰其他插件
set -e
SRC="$(cd "$(dirname "$0")" && pwd)"
PLUGINS="$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents/Jiaosen's Notes/Jiaosen/.obsidian/plugins"
DEST="$PLUGINS/pdfmark"
OLD="$PLUGINS/pdf-annotator"

mkdir -p "$DEST"

cp "$SRC/main.js" "$DEST/main.js"
cp "$SRC/manifest.json" "$DEST/manifest.json"
cp "$SRC/styles.css" "$DEST/styles.css"

# 从旧 id（pdf-annotator）迁移批注数据，避免改名后批注“消失”
if [ -f "$OLD/data.json" ] && [ ! -f "$DEST/data.json" ]; then
  cp "$OLD/data.json" "$DEST/data.json"
  echo "migrated annotations: $OLD/data.json -> $DEST/data.json"
fi

echo "installed -> $DEST"
du -sh "$DEST"
ls -1 "$DEST"
