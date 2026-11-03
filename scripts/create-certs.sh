#!/usr/bin/env bash
# 店内LAN用の HTTPS 証明書を mkcert で作る。
# 使い方: scripts/create-certs.sh <サーバーのIPアドレス> [追加のホスト名...]
# 例:     scripts/create-certs.sh 192.168.1.10 pos.local
set -euo pipefail

if ! command -v mkcert >/dev/null 2>&1; then
  echo "mkcert が見つかりません。sudo apt install mkcert libnss3-tools でインストールしてください" >&2
  exit 1
fi
if [ $# -lt 1 ]; then
  echo "使い方: $0 <サーバーのIPアドレス> [追加のホスト名...]" >&2
  exit 1
fi

cd "$(dirname "$0")/.."
mkdir -p certs
mkcert -install
mkcert -cert-file certs/server.pem -key-file certs/server-key.pem "$@" localhost 127.0.0.1
# iPad/iPhone に配るローカルCAの証明書（http://<IP>/rootCA.crt で配布される）
cp "$(mkcert -CAROOT)/rootCA.pem" certs/rootCA.crt
chmod 644 certs/server.pem certs/server-key.pem certs/rootCA.crt
echo "certs/ に証明書を作成しました。docker compose restart caddy で反映されます"
