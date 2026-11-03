# 飲食店向け POS・オーダー管理システム

1店舗・オンプレミス（店内サーバー）で動く、レジ・キッチン・カスタマーモニター・ピックアップの Web システム。
要件は [docs/requirements.md](docs/requirements.md)、開発計画は [docs/development-plan.md](docs/development-plan.md) を参照。

> 現在の進捗: **フェーズ1（基盤）**。端末登録・従業員ログイン・リアルタイム通信まで。会計などはフェーズ3以降。

## 構成

| パス | 内容 |
| --- | --- |
| `apps/server` | API・リアルタイム配信（Fastify + Socket.IO + Drizzle + SQLite） |
| `apps/web` | 全端末共通の Web アプリ（React + Vite） |
| `packages/shared` | 型・入力検証・イベント定義（今後: 金額/税計算・状態遷移） |
| `docker/`, `compose.yaml` | 店内サーバー用の Docker 構成（アプリ + Caddy による HTTPS） |

## 端末ごとの URL

| 端末 | URL | 備考 |
| --- | --- | --- |
| 端末登録 | `/pairing` | 未登録の端末は自動でここに移る |
| レジ | `/register` | 従業員コード + PIN でログイン |
| キッチンモニター | `/kitchen` | 表示範囲（すべて／フード／ドリンク）を端末ごとに保存 |
| カスタマーモニター | `/customer` | 起動時に1回タップして音声を有効にする |
| ピックアップ端末 | `/pickup` | |
| 管理画面 | `/admin` | 端末登録不要。管理者ログイン必須 |

登録済みの端末は `/` を開くと自分の役割の画面に移動する。

## 開発環境での起動

Node.js 22 以上（開発は 24）と corepack が必要。pnpm は corepack 経由で使う。

```bash
corepack pnpm install
```

```bash
cp apps/server/.env.example apps/server/.env
```

```bash
corepack pnpm dev
```

- Web: http://localhost:5173 （`/api` と `/socket.io` はサーバー :3000 へプロキシ）
- 初回起動時、`apps/server/.env` の `INITIAL_ADMIN_CODE` / `INITIAL_ADMIN_PASSWORD` で管理者が作られる（従業員が0人のときだけ）。初期管理者の PIN は `0000`
- DB は `apps/server/data/pos.sqlite`

テストと型チェック:

```bash
corepack pnpm test
```

```bash
corepack pnpm typecheck
```

DB スキーマを変えたらマイグレーションを生成する:

```bash
corepack pnpm db:generate
```

## 店内サーバー（Ubuntu + Docker）での起動

詳しい手順書はフェーズ7で整備する。現時点の最小手順:

1. `cp .env.example .env` して管理者の初期パスワードを変える
2. `mkdir -p data && sudo chown 1000:1000 data`（コンテナ内の node ユーザーが DB を書けるように）
3. `scripts/create-certs.sh <サーバーのIP>` で HTTPS 証明書を作る（mkcert が必要）
4. `docker compose up -d --build`
5. iPad/iPhone は `http://<サーバーのIP>/rootCA.crt` を開いて CA 証明書をインストールし、「設定 > 一般 > 情報 > 証明書信頼設定」で信頼する
6. 各端末で `https://<サーバーのIP>/` を開く

## 端末の初期設定（フェーズ1時点）

1. PC で `/admin` を開き、管理者でログインする
2. 「端末の登録」で役割を選び、ペアリングコード（6桁・10分有効）を発行する
3. 登録する端末で `/pairing` を開き、コードと端末名を入力する
4. 管理画面の「登録済みの端末」に表示され、接続中なら「オンライン」になる
5. 「通信テスト」で送信すると、全端末の画面下部に通知が出る

## フェーズ1の動作確認手順

1. `corepack pnpm test` が通る（ペアリング・ログイン・権限・リアルタイム配信の自動テスト 20件）
2. `corepack pnpm dev` で起動し、上の「端末の初期設定」に沿ってキッチン端末を登録する
   - 同じブラウザで複数端末を試すときは、`http://localhost:5173` と `http://127.0.0.1:5173` のように別オリジンで開く（端末情報はオリジンごとに保存される）
3. 管理画面の端末一覧が即座に「オンライン」になり、「通信テスト」の通知がキッチン画面に届く
4. サーバーを止めるとキッチン画面に「切断・再接続中」が出て、再起動すると自動で「オンライン」に戻る
5. キッチンの表示範囲を「フード」にして再読み込みしても維持される
6. 管理画面で端末を「無効化」すると、その端末は即座に切断される
