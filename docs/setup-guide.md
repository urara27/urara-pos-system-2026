# セットアップ・運用手順書

店内サーバー（Ubuntu）に POS・オーダー管理システムを構築し、各端末をつないで運用するための手順です。この手順書だけで、新しいサーバーに一から構築できるように書いています。

- 対象: Ubuntu Server 24.04 LTS（22.04 LTS でも同じ手順で動きます）
- 構築するときだけインターネットが必要です（Docker とアプリの部品を取得するため）。構築後はインターネットにつながらなくても営業できます
- 例では、サーバーの IP アドレスを `192.168.1.10`、設置場所を `/opt/pos` とします。読み替えてください

---

## 1. 全体の構成

```
                   店内 LAN（Wi-Fi ルーター）
                              │
   ┌──────────────────────────┼─────────────────────────────┐
   │                          │                             │
 店内サーバー（Ubuntu）    レジ iPad ×1〜2        キッチン PC ×1〜3
  ├ Caddy（HTTPS 443）     ピックアップ iPad/iPhone   カスタマーモニター PC
  └ アプリ（API・画面・DB）
       data/     … DB（SQLite）
       backups/  … バックアップ
       certs/    … HTTPS の証明書
```

すべての端末はブラウザで `https://192.168.1.10/` を開いて使います。データはサーバーだけが持ちます。

---

## 2. 用意するもの

| もの | 内容 |
| --- | --- |
| サーバー用 PC | 64bit の PC。メモリ 4GB 以上・ストレージ 32GB 以上を推奨。常時電源を入れておく |
| LAN | 店内の Wi-Fi ルーター。サーバーは有線接続を推奨 |
| レジ | iPad（最大2台）。横向きで使う |
| キッチンモニター | PC（最大3台）＋ディスプレイ。Chrome を使う |
| カスタマーモニター | PC ＋ 大型ディスプレイ。スピーカー（チャイム用） |
| ピックアップ端末 | iPad または iPhone |
| バックアップの持ち出し先（推奨） | USB メモリ・外付け HDD・NAS など |

---

## 3. Ubuntu の準備

Ubuntu Server をインストールしたあと、サーバーで次を行います。

### 3.1 更新と時刻

時刻はサーバーの時刻が正しい時刻として使われます（営業日・レシートの日時）。タイムゾーンを日本にし、時刻の自動合わせを有効にします。

```bash
sudo apt-get update && sudo apt-get upgrade -y
```

```bash
sudo timedatectl set-timezone Asia/Tokyo
```

```bash
sudo timedatectl set-ntp true
```

`timedatectl` を実行して `Time zone: Asia/Tokyo` と `System clock synchronized: yes` を確認します。インターネットにつながらない期間が長いと時計が少しずつずれるので、ときどき（月に1回程度）インターネットにつなぐか、時刻を確認してください。

### 3.2 IP アドレスの固定

端末はサーバーの IP アドレスで接続するので、IP アドレスを固定します。ルーターの DHCP 設定でサーバーの MAC アドレスに固定 IP を割り当てる方法が簡単です。サーバー側で固定する場合は netplan を使います（例。インターフェース名 `enp1s0` やアドレスは環境に合わせる）。

```yaml
# /etc/netplan/50-pos.yaml
network:
  version: 2
  ethernets:
    enp1s0:
      dhcp4: false
      addresses: [192.168.1.10/24]
      routes:
        - to: default
          via: 192.168.1.1
      nameservers:
        addresses: [192.168.1.1]
```

```bash
sudo chmod 600 /etc/netplan/50-pos.yaml && sudo netplan apply
```

### 3.3 スリープしないようにする

```bash
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
```

---

## 4. Docker のインストール

Docker の公式リポジトリから Docker Engine と Compose をインストールします。

```bash
sudo apt-get install -y ca-certificates curl git
```

```bash
sudo install -m 0755 -d /etc/apt/keyrings && sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc && sudo chmod a+r /etc/apt/keyrings/docker.asc
```

```bash
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
```

```bash
sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

**サーバーを再起動したときに Docker が自動で起動する**ようにします（アプリの自動起動はこれが前提です）。

```bash
sudo systemctl enable --now docker containerd
```

いつものユーザーで `docker` コマンドを使えるようにします。実行後、**一度ログアウトしてログインし直します**。

```bash
sudo usermod -aG docker "$USER"
```

`docker compose version` が表示されれば完了です。

---

## 5. アプリの配置と設定

### 5.1 アプリを置く

```bash
sudo mkdir -p /opt/pos && sudo chown "$USER":"$USER" /opt/pos
```

Git リポジトリから取得する場合:

```bash
git clone <リポジトリのURL> /opt/pos
```

ZIP などで受け取った場合は、展開した中身（`compose.yaml` がある階層）を `/opt/pos` に置きます。以降は `/opt/pos` で作業します。

```bash
cd /opt/pos
```

### 5.2 設定ファイル（.env）

```bash
cp .env.example .env && nano .env
```

| 項目 | 内容 |
| --- | --- |
| `TZ` | `Asia/Tokyo` のまま |
| `INITIAL_ADMIN_CODE` | 最初の管理者の従業員コード（数字） |
| `INITIAL_ADMIN_PASSWORD` | 最初の管理者の管理画面パスワード（8文字以上）。**必ず変更する** |
| `BACKUP_KEEP` | 残すバックアップの世代数（既定 30） |

初期管理者は、従業員が1人もいない最初の起動のときだけ作られます。

### 5.3 データ用のフォルダ

DB とバックアップを置くフォルダを作り、コンテナ内のアプリ（ユーザー ID 1000）が書き込めるようにします。

```bash
mkdir -p data backups && sudo chown 1000:1000 data backups
```

### 5.4 HTTPS の証明書

iPad の Safari は画面のスリープ防止などに HTTPS が必要です。店内専用の認証局（mkcert）で証明書を作ります。

```bash
sudo apt-get install -y mkcert libnss3-tools
```

```bash
scripts/create-certs.sh 192.168.1.10
```

`certs/` に `server.pem`・`server-key.pem`・`rootCA.crt` ができます。`rootCA.crt` は各端末に入れる「店内の認証局の証明書」です（7章）。**`certs/` と mkcert の認証局（`~/.local/share/mkcert`）は他人に渡さないでください。** サーバーの IP アドレスを変えたときは、このコマンドをもう一度実行します。

---

## 6. 起動と確認

```bash
docker compose up -d --build
```

初回はイメージの作成に数分かかります。終わったら状態を確認します。

```bash
docker compose ps
```

`app` が `healthy`、`caddy` が `running` になれば起動しています。サーバー上で次を実行し、`{"ok":true,...}` が返れば正常です。

```bash
curl -sk https://localhost/api/system/health
```

うまくいかないときは `docker compose logs app` でログを見ます（12章）。

### 6.1 自動起動の確認

サーバーを再起動し、ログインし直してから `docker compose ps` でアプリが動いていることを確認します。

```bash
sudo reboot
```

Docker の自動起動（4章）と、各サービスの `restart: unless-stopped` により、電源を入れ直しても自動で立ち上がります。各端末も自動で再接続し、最新の状態を取り直します。

---

## 7. 端末の準備

### 7.1 店内の認証局を各端末に入れる（最初に1回）

**iPad / iPhone**

1. Safari で `http://192.168.1.10/rootCA.crt` を開く（`http` です）→「許可」
2. 設定 → 一般 → VPN とデバイス管理 → ダウンロード済みのプロファイル →「インストール」
3. 設定 → 一般 → 情報 → 証明書信頼設定 → 入れた証明書をオンにする

**Windows PC（キッチン・カスタマーモニター）**

1. ブラウザで `http://192.168.1.10/rootCA.crt` を保存する
2. 管理者のコマンドプロンプトで次を実行する

```bat
certutil -addstore -f "ROOT" rootCA.crt
```

3. Chrome を再起動し、`https://192.168.1.10/` が警告なしで開けることを確認する

### 7.2 端末の登録（ペアリング）

1. 管理用の PC で `https://192.168.1.10/admin` を開き、管理者でログインする
2. 「端末」で役割（レジ／キッチンモニター／カスタマーモニター／ピックアップ端末）を選び、「ペアリングコードを発行」（6桁・10分有効）
3. 登録する端末で `https://192.168.1.10/` を開くとペアリング画面になるので、コードと端末名を入れて「登録する」
4. 端末は役割の画面に切り替わり、管理画面の一覧で「オンライン」になる

登録した端末は、`https://192.168.1.10/` を開けば自分の画面になります。端末を交換・紛失したときは、管理画面で「無効化」してから新しい端末を登録します。

### 7.3 端末ごとの設定

| 端末 | 設定 |
| --- | --- |
| レジ iPad | 画面を横向きに固定。設定 → 画面表示と明るさ → 自動ロック →「なし」。Safari の共有メニューから「ホーム画面に追加」。必要ならアクセスガイド（設定 → アクセシビリティ）で他のアプリに切り替わらないようにする |
| ピックアップ iPad / iPhone | 自動ロック「なし」。ホーム画面に追加 |
| キッチン PC | Chrome をキオスク表示で起動する（下記）。Windows の電源設定で画面オフ・スリープを「なし」。表示範囲（すべて／フード／ドリンク）は画面上部で選ぶと端末に保存される。画面上部に「通知音を有効にする」が出ていたら1回押す |
| カスタマーモニター PC | Chrome をキオスク表示で起動する（下記）。スリープ「なし」。「タップして開始」が出ていたら1回タップ（クリック）してチャイムを有効にする |

**Chrome のキオスク表示（Windows）**: デスクトップにショートカットを作り、リンク先を次のようにします（パスは環境に合わせる）。`shell:startup` フォルダに入れておくと PC の起動時に自動で開きます。

```
"C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk --autoplay-policy=no-user-gesture-required https://192.168.1.10/kitchen
```

カスタマーモニターは末尾を `/customer` にします。`--autoplay-policy=no-user-gesture-required` を付けておくと、PC を再起動しても「タップして開始」を押さずに表示とチャイムが始まり、キッチンも通知音が最初から鳴ります（付けない場合は、起動のたびに1回タップします）。キオスク表示は `Alt + F4` で閉じられます。

---

## 8. 最初の設定（管理画面）

1. **管理者のパスワードと PIN を変える**: 「従業員」→ 管理者を「編集」。初期 PIN は `0000` なので必ず変える。管理者はもう1人登録しておくと、パスワードを忘れたときに困らない
2. **店舗・運用設定**: 店舗名・住所・電話番号・登録番号（T + 13桁）・レシートのヘッダー/フッター・税の端数処理・注文番号の範囲・営業日の切替時刻（既定 4:00）・キッチンの経過時間の色・カスタマーモニターのメッセージ
3. **レジ**: レジ名と注文番号の発行モード（番号札／自動採番）
4. **カテゴリ → オプション → 商品** の順に登録（商品は CSV でまとめて取り込める）
5. **割引・クーポン**、**従業員**（スタッフ・責任者。返金の承認には責任者以上が必要）

---

## 9. 毎日の運用

| いつ | どこで | すること |
| --- | --- | --- |
| 開店時 | レジ | レジを選び、ログイン → 釣銭準備金を入れて開設 |
| 営業中 | 各端末 | 会計 → キッチンで調理完了 → ピックアップで呼び出し・受け渡し |
| 担当の交代 | レジ | 「担当交代」→ 次の人がログイン（レジは開設したまま） |
| 閉店時 | レジ | 「レジ閉設」→ ドロアの現金を数えて入力 → 過不足を確認 |
| 閉店時 | 管理画面 | 「閉店・バックアップ」→「閉店する」（全レジの閉設後に押せる）。閉店時にバックアップを取る |
| 閉店後 | 管理画面 | 「売上」「レジ点検・精算」を確認。PayPay 売上を PayPay の管理画面と照合 |

- 閉店操作を忘れても、営業日の切替時刻を過ぎると前の営業日を自動で閉じ、バックアップを取ります
- 閉店後、同じ営業日には会計できません（間違えて閉店したときは「営業を再開」）
- 自動採番の注文番号は、営業日が変わると開始番号から振り直されます（設定で振り直さないこともできる）
- プリンター導入までは、レシートは画面のプレビューか PDF で確認し、領収書は手書きで発行します

---

## 10. バックアップと復元

### 10.1 バックアップ

- 閉店時（手動・自動）に `backups/` へ自動で作られます。管理画面の「閉店・バックアップ」→「今すぐバックアップ」でいつでも作れます
- ファイル名は `pos-<店舗コード>-<営業日>-<日時>.sqlite`。新しい順に `BACKUP_KEEP` 個（既定 30）を残し、古いものは消します
- 営業中に取っても、その時点の一貫した内容で保存されます

**サーバーの故障に備えて、バックアップを別の場所にもコピーしてください。** 例: USB ドライブを `/mnt/usb` にマウントし、毎朝 5 時にコピーする（`crontab -e` に1行追加）。

```
0 5 * * * rsync -a /opt/pos/backups/ /mnt/usb/pos-backups/
```

### 10.2 復元

```bash
cd /opt/pos && ls -lt backups | head
```

戻したいファイルを選んで実行します。

```bash
scripts/restore.sh backups/pos-STORE01-2026-11-04-20261104-223015.sqlite
```

スクリプトは次を行います。

1. バックアップが壊れていないか確かめ、取引の件数と最後の取引の日時を表示する
2. 確認のあと、アプリを止める
3. 今の DB を `data/pre-restore-<日時>/` に退避する（復元をやめたいときはここから戻せる）
4. バックアップを `data/pos.sqlite` として置き、アプリを起動する

各端末は自動で再接続し、復元した状態を表示します。**復元すると、バックアップを取った後の取引は消えます**（退避した DB には残っています）。

---

## 11. 更新・移設

### 11.1 アプリの更新

1. 管理画面で「今すぐバックアップ」
2. 新しいアプリに入れ替える（Git なら `git pull`、ZIP なら `data/`・`backups/`・`certs/`・`.env` 以外を上書き）
3. 作り直して起動する（DB の項目の追加などは起動時に自動で適用される）

```bash
docker compose up -d --build
```

### 11.2 別のサーバーへの移設

1. 新しいサーバーで 3〜4章を行う
2. 古いサーバーで閉店し、`docker compose down`
3. `/opt/pos` を丸ごと（`data/`・`backups/`・`certs/`・`.env` を含む）新しいサーバーへコピーし、`sudo chown 1000:1000 data backups`
4. IP アドレスが変わる場合は `scripts/create-certs.sh <新しいIP>` を実行し、各端末に新しい `rootCA.crt` を入れ直す（同じサーバーで mkcert を再インストールした場合も同様）
5. `docker compose up -d --build`。端末はアドレスが同じなら登録し直す必要はありません

---

## 12. 困ったとき

| 症状 | 確認すること |
| --- | --- |
| 端末に「切断・再接続中」と出る | サーバーの電源・LAN。サーバーで `docker compose ps`。復旧すると端末は自動で再接続する。切断中の会計は確定しない（画面にエラーが出る） |
| 「この端末は登録されていません」 | 管理画面で端末が無効化されていないか。ブラウザのデータを消した場合は登録し直す |
| 証明書の警告が出る | 7.1 の手順で認証局を入れたか（iPad は「証明書信頼設定」をオンにしたか）。IP を変えたなら証明書を作り直したか |
| チャイム・通知音が鳴らない | カスタマーモニター・キッチンで最初に1回タップしたか。音量。キオスクの起動オプション |
| 会計時に「合計金額が変わりました」 | 表示中に管理画面で価格・割引が変わった。明細を確認して会計し直す |
| 「営業は終了（閉店）しています」 | 閉店後に会計しようとした。必要なら管理画面で「営業を再開」 |
| 閉店できない | 開設中のレジがある。画面に出るレジで「レジ閉設」をする |
| 日付・時刻がずれている | サーバーで `timedatectl`（3.1）。時刻がずれると営業日やレシートの日時がずれる |
| ディスクの空き | `df -h`。バックアップの世代数（`BACKUP_KEEP`）を減らす。コンテナのログは自動で上限を設けている |
| ログを見たい | `docker compose logs -f app`（Ctrl + C で終了） |

### 12.1 管理者パスワードを忘れたとき

別の管理者がいればその人がログインして「従業員」から変更します。誰もログインできない場合は、サーバーで次を行います。

1. `.env` の `INITIAL_ADMIN_CODE` を管理者の従業員コード、`INITIAL_ADMIN_PASSWORD` を新しいパスワードにし、`ADMIN_PASSWORD_RESET=1` を追加する
2. `docker compose up -d` でアプリを作り直す（`.env` の変更を反映するため）
3. 新しいパスワードで管理画面にログインできたら、`.env` から `ADMIN_PASSWORD_RESET=1` を消し、もう一度 `docker compose up -d`

この操作は操作ログ（「管理者パスワードの復旧」）に残ります。

---

## 13. 構築後の確認チェックリスト

- [ ] `docker compose ps` で `app` が healthy、`caddy` が running
- [ ] サーバーを再起動しても自動で起動する（6.1）
- [ ] 各端末で `https://192.168.1.10/` が証明書の警告なしで開く
- [ ] 管理者のパスワードと PIN を変更した
- [ ] 店舗情報・登録番号を設定し、テストの会計でレシートのプレビューに正しく出る
- [ ] レジ → キッチン → カスタマーモニター → ピックアップ → 受け渡し済み まで1件流れる
- [ ] 閉店操作で `backups/` にバックアップができる
- [ ] バックアップの持ち出し（10.1）を設定した
- [ ] テストの取引を返金で取り消すか、復元（10.2）で営業前の状態に戻した
