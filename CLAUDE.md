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
- テスト: `corepack pnpm test` / 型チェック: `corepack pnpm typecheck` / E2E: `corepack pnpm test:e2e`（`playwright.config.ts`。Web をビルドし一時 DB でサーバーを :3210 に起動する）
- ルートの scripts から pnpm を呼ぶときは `corepack pnpm` と書く（この環境では素の `pnpm` が PATH に無い）
- マイグレーション生成: `corepack pnpm db:generate`（スキーマは `apps/server/src/db/schema.ts`）

## 実装の約束事
- 共有パッケージ `@pos/shared` は TS ソースのまま参照する（server は tsup で同梱、web は Vite が処理）
- サーバーのモジュールは `apps/server/src/modules/<名前>/`（service.ts = ロジック, routes.ts = HTTP）
- 入力検証は `parse(zodSchema, value)`、エラーは `AppError`（メッセージは日本語で画面に出す前提）
- 読んでから書く処理（採番など）は `immediateTransaction()` を使う
- 設定変更・端末操作などは `writeAudit()` で操作ログに残す
- 新しいリアルタイムイベントは `packages/shared/src/events.ts` に型を足し、`hub.emit()` で送る。端末側は `useDeviceRealtime({ onSync, handlers })` で受け、`onSync` で全状態を取り直す
- better-sqlite3 は v12 系に固定（v13 は Windows + Node 24 のビルド済みバイナリが無い）
- マスタ（商品・カテゴリ・オプション・割引・従業員・レジ）は物理削除しない。削除 API は作らず「無効」で管理する。オプションの既存選択肢を更新で省くとエラー
- カテゴリ名・オプショングループ名は一意（商品 CSV で名前から引くため）
- マスタの入力スキーマは `packages/shared/src/masters.ts`。変更したら `catalog.updated` / `settings.updated` を全端末へ送る
- React Router 8 は `/admin/*` のようなスプラット配下で相対リンクが現在の URL 基準になるので、管理画面のリンクは絶対パスで書く

## 注文フローの実装（フェーズ3）
- 金額計算は `packages/shared/src/pricing.ts` の `priceOrder` だけを使う（レジ表示とサーバー確定で共通）。状態遷移は `packages/shared/src/orders.ts` の `ORDER_ACTIONS` / `nextStatus`
- 会計確定は `apps/server/src/modules/checkout/service.ts`。1つの `immediateTransaction` で採番・販売データ・注文を記録する。端末は `expectedTotal`（表示していた合計）を送り、サーバー計算と違えば 409 `total_mismatch`
- 冪等キーは支払画面を開いたときに端末で1つ作り（`lib/id.ts`）、再試行でも同じキーを送る
- 採番は `modules/orders/numbering.ts`。自動採番のカウンタは「営業日ごとに振り直す」なら `auto_order:<営業日>`、そうでなければ `auto_order`。レシート番号は `receipt:<営業日>:<レジ番号>`
- 営業日は `modules/business-day/service.ts` の `currentBusinessDay`（切替時刻より前は前日扱い・サーバーのローカル時刻）。閉店操作はフェーズ6/7で実装する
- 注文の通知は `order.updated`（`{ order: OrderView, change }`）1種類。端末は `realtime/orderBoard.ts` の `useOrderBoard` で一覧を持ち、`version` が古い通知は捨てる
- レジの流れ: レジ選択（ログイン前）→ ログイン → 開設 → 会計。店内／持ち帰りは会計ごとに必ず選ばせる（既定値なし）
- キッチンのカード表示は `kitchenItems()`。オプションのステーションが商品と違えば（セットのドリンク）そのステーション側に親商品名つきで出す

## 印刷（フェーズ4）
- レシートは `packages/shared/src/receipt.ts` の `ReceiptDocument` → `buildReceiptLayout()` で「行」（text / pair / rule / space）にし、画面プレビュー（`components/ReceiptPreview.tsx`）・PDF（`modules/printing/pdf.ts`）・等幅テキスト（`renderReceiptText`、80mm=48桁、large/xlarge は倍角）がすべて同じ行から描く。記載項目を変えるときは buildReceiptLayout だけを直す
- ドライバーは `modules/printing/driver.ts` の `PrinterDriver`（`print` / `openDrawer`）。今は `DummyPrinterDriver` のみで、`PrinterRegistry.driverFor(registers.printer_id)` で選ぶ。実機は ESC/POS ドライバーを追加する
- 会計確定後の印刷・ドロア開放は応答を待たせない（失敗してもログに出すだけで、会計は確定済み）
- 明細・金額は会計時のスナップショット、店舗情報（名称・登録番号など）は出力時点の設定を使う
- PDF のフォントは `@expo-google-fonts/noto-sans-jp` の TTF（Regular/Bold）。pdfkit がサブセットを埋め込む
- 再発行は `POST /api/transactions/:id/reprint`（操作ログ `receipt.reprinted`）。参照は `requireStaffOrAdmin`（レジのログインか管理者）

## 返金・変更（フェーズ5）
- `modules/refunds/service.ts`。返金・変更は販売（kind=sale）にだけ行い、元の販売に紐付く新しい取引（kind=refund / exchange, `original_transaction_id`）を作る。元の取引は変更しない
- 返品の明細は金額をマイナス・数量は正で記録し、`original_line_id` で元の明細を指す。商品変更で追加した明細は正の金額・`original_line_id` なしで変更の取引に入り、以後の返金対象にもなる
- 金額・税額は `packages/shared/src/refund.ts`（`proportionalShare` / `returnedLineAmount` / `refundTaxes`）。累積の按分なので分けて返金しても合計が一致し、全額返金では元の税額をそのまま戻す。端末は `refund-quote` で試算し、確定時に `expectedDifference` を送る
- 責任者 PIN は確定のたびに検証する（role が manager / admin）。失敗回数で一時拒否。理由は必須
- 返金の取引は返金したレジの開設中セッション・当日の営業日に入る（在高・売上はこれで自動的に反映される）
- 注文への反映: 未完了の注文は、全額返金なら cancelled、それ以外は `modified_at` を付けてステーションを決め直す（追加したステーションは未完了に戻す）。`loadOrderViews` は返品した数量を引き、追加した明細を足して返す。受け渡し済みは変えない
- 通知は `order.updated` の change = cancelled / modified。キッチンはトーストと通知音で知らせる
- 検索は `GET /api/transactions`。レシート番号・日時を指定しなければ当日の営業日に絞る

## デザイン
- 管理画面は **デジタル庁デザインシステム（DADS, https://design.digital.go.jp/dads/）** に準拠する。スタイルは `apps/web/src/routes/admin/admin.css` に集約し、`.dads` クラスの内側に閉じる（レジ・キッチン等は対象外）
- 色・文字サイズ・行間・角丸・影は公式トークン `@digital-go-jp/design-tokens`（MIT）の CSS 変数（`--color-key-900`, `--color-neutral-solid-gray-800`, `--font-size-16`, `--border-radius-8` など）を使い、色を直書きしない
- 部品の寸法・状態は DADS の HTML 実装例（github.com/digital-go-jp/design-system-example-components-html）に合わせる: ボタン中 48px（塗り=主要操作 / アウトライン=既定 / 小 36px）、入力・セレクト高さ 48px・枠 gray-600・角丸 8px、フォーカスは黒 4px アウトライン + 黄色の外周、表は見出し gray-100・行ホバー key-50、通知はカラーチップ型バナー、項目ラベルは太字 → サポートテキスト → 入力欄、必須は「※必須」（赤）
- フォントは Noto Sans JP を `@fontsource/noto-sans-jp`（400/700）で同梱する。外部 CDN は使わない

## 進め方
- `docs/development-plan.md` 第7節のフェーズ順に実装し、フェーズごとに動作確認手順を示してコミットする
- 現在: フェーズ5（返金・変更）完了。次はフェーズ6（売上・精算: 売上確認、レジ点検・精算、CSV出力、操作ログ）
