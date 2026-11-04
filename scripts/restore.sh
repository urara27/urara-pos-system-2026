#!/usr/bin/env bash
# バックアップから DB を復元する（店内サーバーで実行）。
# 使い方: scripts/restore.sh backups/pos-STORE01-2026-11-04-20261104-223015.sqlite
#
# 1. バックアップが壊れていないかを、アプリのイメージの中で確かめる
# 2. アプリを止める（Caddy は動かしたまま）
# 3. 今の DB を data/pre-restore-<日時>/ に退避する（元に戻したいときはここから戻せる）
# 4. バックアップを data/pos.sqlite として置き、アプリを起動する
set -euo pipefail

cd "$(dirname "$0")/.."

if [ $# -ne 1 ]; then
  echo "使い方: $0 <バックアップファイル>（例: backups/pos-STORE01-2026-11-04-20261104-223015.sqlite）" >&2
  exit 1
fi
SRC="$1"
if [ ! -f "$SRC" ]; then
  echo "ファイルがありません: $SRC" >&2
  exit 1
fi
SRC_ABS="$(cd "$(dirname "$SRC")" && pwd)/$(basename "$SRC")"

echo "▶ バックアップを確認しています: $SRC"
docker compose run --rm --no-deps -T -v "$SRC_ABS:/restore.sqlite:ro" app node -e "
  const Database = require('better-sqlite3');
  const db = new Database('/restore.sqlite', { readonly: true, fileMustExist: true });
  const ok = db.pragma('integrity_check', { simple: true });
  const n = db.prepare('select count(*) as n from transactions').get().n;
  const last = db.prepare('select max(created_at) as t from transactions').get().t;
  db.close();
  if (ok !== 'ok') { console.error('整合性チェックに失敗しました: ' + ok); process.exit(1); }
  console.log('  整合性: ok / 取引 ' + n + ' 件 / 最後の取引 ' + (last ? new Date(last).toLocaleString('ja-JP') : 'なし'));
"

read -r -p "この内容で復元します。今の DB は退避します。よろしいですか？ [y/N] " answer
if [ "${answer:-}" != "y" ] && [ "${answer:-}" != "Y" ]; then
  echo "中止しました"
  exit 0
fi

echo "▶ アプリを停止しています"
docker compose stop app

STAMP="$(date +%Y%m%d-%H%M%S)"
SAVE="data/pre-restore-$STAMP"
mkdir -p "$SAVE"
for f in data/pos.sqlite data/pos.sqlite-wal data/pos.sqlite-shm; do
  if [ -f "$f" ]; then mv "$f" "$SAVE/"; fi
done
echo "  今の DB を $SAVE/ に退避しました"

cp "$SRC" data/pos.sqlite
# コンテナ内の node ユーザー（uid 1000）が書き込めるように
chown 1000:1000 data/pos.sqlite 2>/dev/null || sudo chown 1000:1000 data/pos.sqlite

echo "▶ アプリを起動しています"
docker compose start app
for _ in $(seq 1 30); do
  if docker compose exec -T app node -e "fetch('http://127.0.0.1:3000/api/system/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    echo "✓ 復元しました。各端末は自動で再接続し、最新の状態を取り直します"
    exit 0
  fi
  sleep 2
done
echo "アプリが起動しません。docker compose logs app を確認してください（退避した DB: $SAVE/）" >&2
exit 1
