# CLAUDE.md

飲食店向け POS・オーダー管理システム（1店舗・オンプレミス）。

## 参照ドキュメント
- `docs/requirements.md` — 要件定義（原本。編集しない）
- `docs/development-plan.md` — 承認済みの開発計画。技術選定・スキーマ・API・計算ルール・確認事項の決定がここにある
- 設計を変えたら `docs/development-plan.md`（または以後作る設計書）を更新し、決定事項をここにも要約する

## 技術スタック
pnpm モノレポ / TypeScript strict
- `apps/web`: React + Vite（`/register` `/kitchen` `/customer` `/pickup` `/admin`）
- `apps/server`: Fastify + Socket.IO + Drizzle + better-sqlite3（WAL）
- `packages/shared`: 型・Zod スキーマ・WSイベント定義・金額/税計算・状態遷移表
- テスト: Vitest / Playwright。実行: Docker Compose + Caddy（mkcert で HTTPS）

## 守るべきルール
- 外部CDN・Webフォント・クラウドサービスに依存しない（オフライン営業）
- 金額は整数（円）。浮動小数点数禁止。価格はすべて税込
- 税額はレシートごとに税率別の税込合計から1回だけ端数処理（既定: 切り捨て）
- 確定金額はサーバーで再計算する。端末から送られた金額を信用しない
- 販売・返金データは物理削除・上書きしない（返金はマイナス取引で元取引に紐付け）
- 状態変更は REST 経由のみ。WebSocket は通知専用。端末は再接続時に全状態を取り直す
- 採番は `BEGIN IMMEDIATE` トランザクション内で行う＋未完了注文番号の部分一意インデックス
- 金額・税計算、採番、状態遷移には必ず自動テストを書く
- UI は日本語。iPad 横向き、ボタン最低44pt、影響の大きい操作は確認ダイアログ

## 主な決定事項（詳細は development-plan.md 第5・6節）
- 支払は現金 or PayPay（併用なし）。店内/持ち帰り共通価格が既定
- 自動採番は営業日ごとに100へリセット（設定可）
- 営業日は管理画面の閉店操作で終了（バックアップ・採番リセット）。忘れたら切替時刻に自動
- 受け渡し済みの undo は5分以内（設定可）かつ番号未使用時のみ
- 受け渡し済み注文の返金では注文状態を変えない
- オプションにもステーションを持たせる（セット商品のドリンク等）
- 割引は明細・会計とも複数可。適用順に計算し0円で止める
- 会計割引の税率按分の端数は金額の大きい税率グループへ（同額なら10%側）
- 客数＝会計件数。現金返金は返金を行ったレジの在高から
- プリンター導入まで領収書は手書き。システムはレシートのプレビュー/PDFを保持

## コマンド（pnpm は corepack 経由）
- 依存導入: `corepack pnpm install`
- 開発起動: `corepack pnpm dev`（server :3000 / web :5173）。`.claude/launch.json` に server / web あり
- テスト: `corepack pnpm test` / 型チェック: `corepack pnpm typecheck`
- マイグレーション生成: `corepack pnpm db:generate`（スキーマは `apps/server/src/db/schema.ts`）

## 実装の約束事
- 共有パッケージ `@pos/shared` は TS ソースのまま参照する（server は tsup で同梱、web は Vite が処理）
- サーバーのモジュールは `apps/server/src/modules/<名前>/`（service.ts = ロジック, routes.ts = HTTP）
- 入力検証は `parse(zodSchema, value)`、エラーは `AppError`（メッセージは日本語で画面に出す前提）
- 読んでから書く処理（採番など）は `immediateTransaction()` を使う
- 設定変更・端末操作などは `writeAudit()` で操作ログに残す
- 新しいリアルタイムイベントは `packages/shared/src/events.ts` に型を足し、`hub.emit()` で送る。端末側は `useDeviceRealtime({ onSync, handlers })` で受け、`onSync` で全状態を取り直す
- better-sqlite3 は v12 系に固定（v13 は Windows + Node 24 のビルド済みバイナリが無い）

## 進め方
- `docs/development-plan.md` 第7節のフェーズ順に実装し、フェーズごとに動作確認手順を示してコミットする
- 現在: フェーズ1（基盤）完了。次はフェーズ2（マスタ管理）
