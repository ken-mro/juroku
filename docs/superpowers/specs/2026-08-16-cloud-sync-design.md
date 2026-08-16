# クラウド同期（Google ログイン + Cloudflare Workers KV）設計

## 背景と目的

JŪROKU はこれまで完全な静的サイトで、ベスト記録・ワールドツアーの進行・設定はすべて端末の
`localStorage` に保存していた。そのため端末を変える・ブラウザのデータを消すと記録が失われ、
複数端末で同じ進行を続けることもできない。

Google アカウントでログインすると、**ベスト記録・ワールドツアーの進行・追加した Suno リンク曲**が
クラウド（Cloudflare KV）に保存され、どの端末でも続きから遊べるようにする。

**ログインは任意**。未ログイン・オフライン・通信失敗のいずれの場合も、これまでどおり
`localStorage` だけで全機能が動く。同期はあくまで上乗せの機能とする。

## 決定事項（ユーザー確認済み）

| 項目 | 決定 |
|---|---|
| 同期対象 | `juroku:bests` / `juroku:tour` / `juroku:usertracks` |
| 同期しない | OFFSET（端末の音声遅延に依存）、曲の長さキャッシュ（再取得可能）、マーカー等の好み（端末ごと） |
| 同期方式 | 自動（起動時に取得、保存時に 5 秒デバウンスで送信） |
| 認証方式 | サーバー側 OAuth（認可コード）＋ HttpOnly セッション Cookie |
| 同意画面 | 一般公開（プライバシーポリシーのページを用意し、Google の審査を通す） |

## 全体構成

```
ブラウザ (index.html)                     Cloudflare Pages Functions          外部
  localStorage（従来どおり常に使う）
        │                                  functions/api/auth/login ────→ Google 認可画面
        │  savePrefs/loadPrefs             functions/api/auth/callback ←── コード
        ├── GET  /api/me      ────────────→ セッション Cookie を検証
        ├── GET  /api/sync    ────────────→ KV から取得
        ├── PUT  /api/sync    ────────────→ 併合して KV に保存 → 併合結果を返す
        └── DELETE /api/sync  ────────────→ KV から削除
                                                    │
                                              KV (JUROKU_KV)
                                              キー u:<sub>
```

Cloudflare Pages Functions は `functions/` ディレクトリを置くだけで自動デプロイされ、
**ビルド工程は増えない**（CLAUDE.md の「ビルド工程もパッケージマネージャも無い」を維持する）。

## 認証

### なぜサーバー側 OAuth か

- 外部 JS（Google Identity Services）を読み込まない → 「外部依存は Google Fonts のみ」を維持
- トークンが JavaScript から触れない（HttpOnly Cookie）ため XSS でセッションを盗まれない
- 暗黙フローの ID トークンは 1 時間で失効するが、自前セッションなら 90 日保持できる

### 流れ

1. `GET /api/auth/login`
   - `state`（乱数）を HMAC 署名して短命 Cookie に保存し、Google の認可 URL へ 302
   - scope は `openid email` のみ（最小限）
2. Google → `GET /api/auth/callback?code=...&state=...`
   - `state` を Cookie と照合（CSRF 対策）
   - `code` を `client_id` + `client_secret` でトークンに交換
   - 返ってきた ID トークン（JWT）を検証：署名（Google JWKS + RS256、WebCrypto）、`iss`、`aud`、`exp`
   - `sub`（不変の Google ユーザー ID）と `email` を取り出す
   - 自前のセッショントークンを HMAC-SHA256 で署名し Cookie に載せてトップへ 302
3. 以降の API は Cookie のセッションを検証する（KV 参照不要のステートレス検証）
4. `POST /api/auth/logout` → Cookie を失効させる

### Cookie

| 名前 | 内容 | 属性 |
|---|---|---|
| `juroku_session` | `<base64url(payload)>.<base64url(HMAC)>`、payload は `{sub, email, iat, exp}` | HttpOnly, Secure, SameSite=Lax, Path=/, Max-Age=90日 |
| `juroku_oauth_state` | OAuth の state（署名付き） | HttpOnly, Secure, SameSite=Lax, Path=/, Max-Age=600 |

### 秘密情報

`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `SESSION_SECRET` は Cloudflare の環境変数（Secret）。
**リポジトリには絶対に置かない。** 未設定時は `/api/*` が 503 を返し、クライアントは
「同期は利用できません」として静かに従来動作にフォールバックする。

## データ

### KV

- キー：`u:<sub>`（Google の `sub`。メールアドレスは変わりうるのでキーにしない）
- 値：
  ```json
  { "v": 1, "updatedAt": 1755300000000,
    "bests": { "曲名|難易度": {"s":0,"a":0,"c":[0,0,0,0],"m":0,"n":0,"d":0} },
    "tour": { "cleared": { "<trackId>": {"d":0,"diff":"normal","acc":0} } },
    "usertracks": [ {"kind":"link","title":"","artist":"","url":"","art":"","id":""} ] }
  ```
- 上限：1 ユーザーあたり 256KB を超えないよう、`usertracks` は 200 件・`bests` は 2000 件で打ち切る

### 併合規則（サーバー側 `PUT /api/sync` で実行）

| 種類 | 規則 |
|---|---|
| `bests` | キーごとに **スコア `s` が高い方**を採用（同点なら既存を保持） |
| `tour.cleared` | **和集合**。両方にあれば `d`（クリア日時）が古い方を残す |
| `usertracks` | `url` で重複排除した**和集合**（先に登録された方を残す） |

順序に依存しない（可換・冪等）ため、複数端末が任意の順で同期しても同じ結果になる。
バージョン番号や競合解決 UI は不要。

## クライアント側の変更

保存経路が `savePrefs()` / `loadPrefs()` に集約されているため、変更はその周辺に限定する。

- `SYNC_KEYS = ["juroku:bests","juroku:tour","juroku:usertracks"]`
- `savePrefs(key,val)`：localStorage 書き込み後、`SYNC_KEYS` に含まれログイン中なら
  **5 秒デバウンス**で `PUT /api/sync`（連続保存を 1 回にまとめる）
- `loadPrefs()`：ローカル読み込み後、ログイン中なら `GET /api/sync` → 併合 → localStorage に反映
  → `renderTracks()` / `renderTourVols()` を呼び直す
- 失敗時は握りつぶして従来動作（ゲームプレイを絶対に止めない）
- ページ離脱時に未送信の変更があれば `navigator.sendBeacon` で送る

### UI（設定画面 `#sync` に「アカウント」欄）

- 未ログイン：「Google でログイン」ボタン（`/api/auth/login` へ遷移）
- ログイン中：メールアドレス、最終同期時刻、「ログアウト」、「クラウドのデータを削除」
- 同期は利用不可（Secret 未設定・オフライン）：欄自体を出さない

## プライバシーポリシー

同意画面の一般公開に必要なため `privacy.html` を追加する（`index.html` と同じ配色・書体の静的ページ）。
記載内容：取得するもの（Google アカウントの識別子とメールアドレス、ゲームの記録）、保存先
（Cloudflare KV）、利用目的（端末間の同期のみ）、第三者提供なし、削除方法（アプリ内の削除ボタン）、
問い合わせ先（GitHub リポジトリの Issues）。フッターから辿れるようにする。

## テスト

| ファイル | 内容 |
|---|---|
| `tests/merge.js` | 併合規則（高いスコア優先・和集合・重複排除・可換性・冪等性・上限打ち切り） |
| `tests/session.js` | セッションの署名／検証（改ざん・期限切れ・別の鍵を拒否）、Cookie 文字列 |
| `tests/api.js` | 各ハンドラを KV スタブと偽 `fetch` で直接呼ぶ（未認証は 401、Secret 未設定は 503、state 不一致は 400、`PUT` が併合して保存、`DELETE` が消す） |
| `tests/sync.js` | jsdom でクライアント側（未ログインでは通信しない、ログイン時に起動取得と併合、保存のデバウンス送信、API 失敗でもゲームが動く） |

既存 10 本と合わせて `npm test` で通す。譜面回帰（chart.js）も従来どおり必ず確認する。

## やらないこと

- 端末固有の設定（OFFSET・マーカー・打点音・バイブ）の同期
- ローカル音源ファイルそのもののアップロード（端末内に留める方針を維持）
- ランキング・他ユーザーとの比較（今回の目的外）
- ログインの強制（未ログインでも全機能が使える状態を維持する）
