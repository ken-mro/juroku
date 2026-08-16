# クラウド同期 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Google アカウントでログインすると、ベスト記録・ワールドツアーの進行・リンク曲が
Cloudflare KV に保存され、どの端末でも続きから遊べるようにする。

**Architecture:** Cloudflare Pages Functions（`functions/`、ビルド不要）でサーバー側 OAuth を行い、
HttpOnly セッション Cookie を発行する。同期は「クライアントがローカル全体を PUT →
サーバーが併合して保存 → 併合結果を返し、クライアントがそれを採用」の 1 経路のみ。
併合規則は可換・冪等なので競合解決が不要で、クライアント側に併合ロジックを持たなくてよい。

**Tech Stack:** Cloudflare Pages Functions（ESM）、Workers KV、WebCrypto（HMAC-SHA256 / RSASSA-PKCS1-v1_5）、
素の JS（外部ライブラリなし）、jsdom テスト（既存の `tests/lib/env.js`）

**Spec:** `docs/superpowers/specs/2026-08-16-cloud-sync-design.md`

## Global Constraints

- クライアントは `index.html` 単一ファイルを維持する。サーバーコードのみ `functions/` に置く
- 外部 JS ライブラリを追加しない（Google Identity Services も使わない）
- ビルド工程を増やさない（Pages Functions はディレクトリを置くだけで動く）
- 秘密情報（`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `SESSION_SECRET`）はリポジトリに置かない
- 未ログイン・オフライン・API 失敗のいずれでも全機能が従来どおり動く（同期は上乗せ）
- 同期対象は `juroku:bests` / `juroku:tour` / `juroku:usertracks` のみ
- 譜面生成（`detectOnsets` / `analyzeSections` / `buildChart`）には触れない
- 各タスクの最後に `cd tests && npm test` を通す

## File Structure

| ファイル | 責務 |
|---|---|
| `functions/_lib/merge.js` | 併合規則と入力の検証・上限打ち切り（純関数のみ） |
| `functions/_lib/session.js` | セッションの HMAC 署名／検証、Cookie の組み立てと読み取り |
| `functions/_lib/google.js` | 認可 URL の組み立て、コードのトークン交換、ID トークン検証 |
| `functions/api/auth/login.js` | Google へのリダイレクトと state Cookie の発行 |
| `functions/api/auth/callback.js` | state 照合・トークン交換・ID 検証・セッション発行 |
| `functions/api/auth/logout.js` | セッション Cookie の失効 |
| `functions/api/me.js` | ログイン状態の照会 |
| `functions/api/sync.js` | GET 取得 / PUT・POST 併合保存 / DELETE 削除 |
| `privacy.html` | プライバシーポリシー（同意画面の公開に必要） |
| `index.html` | 同期クライアント（`savePrefs`/`loadPrefs` 周辺）と設定画面のアカウント欄 |

---

### Task 1: 併合規則（`functions/_lib/merge.js`）

**Files:**
- Create: `functions/_lib/merge.js`
- Test: `tests/merge.js`

**Interfaces:**
- Produces: `sanitize(input) -> {bests, tour, usertracks}`、`mergeState(stored, incoming) -> {v,updatedAt,bests,tour,usertracks}`、`LIMITS`

- [ ] **Step 1: 失敗するテストを書く** — `tests/merge.js`
  併合の性質を検証する：ベストは高いスコアが残る／ツアーは和集合で `d` は古い方／リンク曲は
  `url` で重複排除／可換（a→b と b→a で同じ）／冪等（2 回併合しても同じ）／上限で打ち切る／
  壊れた入力（null・数値・巨大配列・想定外の型）を捨てる
- [ ] **Step 2: 失敗を確認** — `node tests/merge.js` → モジュールが無く FAIL
- [ ] **Step 3: `merge.js` を実装**（ESM。`export function` のみ、副作用なし）
- [ ] **Step 4: `node tests/merge.js` が PASS**
- [ ] **Step 5: `tests/package.json` の `test` に追加してコミット**

### Task 2: セッション（`functions/_lib/session.js`）

**Files:**
- Create: `functions/_lib/session.js`
- Test: `tests/session.js`

**Interfaces:**
- Produces: `signToken(payload, secret)`、`verifyToken(token, secret, now)`、
  `setCookie(name, value, opts)`、`clearCookie(name)`、`getCookie(request, name)`、
  `SESSION_COOKIE = "juroku_session"`、`STATE_COOKIE = "juroku_oauth_state"`

- [ ] **Step 1: 失敗するテストを書く** — 署名したトークンが検証を通る／改ざん（payload・署名）を拒否／
  期限切れを拒否／別の鍵で拒否／`getCookie` が複数 Cookie から正しく取り出す／
  `setCookie` に HttpOnly・Secure・SameSite=Lax・Path=/ が入る
- [ ] **Step 2: 失敗を確認**
- [ ] **Step 3: 実装**（WebCrypto の HMAC-SHA256、base64url、検証は `crypto.subtle.verify`）
- [ ] **Step 4: PASS を確認**
- [ ] **Step 5: コミット**

### Task 3: Google OAuth（`functions/_lib/google.js`）

**Files:**
- Create: `functions/_lib/google.js`
- Test: `tests/api.js`（前半）

**Interfaces:**
- Produces: `authUrl({clientId, redirectUri, state})`、`exchangeCode({code, clientId, clientSecret, redirectUri})`、
  `verifyIdToken(jwt, {clientId, now})`

- [ ] **Step 1: 失敗するテストを書く** — `authUrl` に必須パラメータ（`response_type=code`・`scope=openid email`・
  `state`）が入る／`exchangeCode` が失敗レスポンスで例外／`verifyIdToken` が
  RS256 署名（テスト内で鍵ペアを生成して JWT を作る）を検証し、`aud` 不一致・期限切れ・改ざんを拒否
- [ ] **Step 2: 失敗を確認**
- [ ] **Step 3: 実装**（JWKS を `fetch` して `kid` で選び、`crypto.subtle.importKey("jwk")` → `verify`）
- [ ] **Step 4: PASS を確認**
- [ ] **Step 5: コミット**

### Task 4: API ハンドラ（`functions/api/**`）

**Files:**
- Create: `functions/api/auth/login.js`, `functions/api/auth/callback.js`, `functions/api/auth/logout.js`,
  `functions/api/me.js`, `functions/api/sync.js`
- Test: `tests/api.js`（後半）

**Interfaces:**
- Consumes: Task 1〜3 の全関数
- Produces: 各ファイルの `onRequestGet` / `onRequestPut` / `onRequestPost` / `onRequestDelete`

- [ ] **Step 1: 失敗するテストを書く** — Secret 未設定は全 API が 503／未ログインの `/api/sync` は 401／
  `/api/me` は未ログインで `{signedIn:false}`／`login` が Google へ 302 し state Cookie を立てる／
  `callback` が state 不一致で 400、成功でセッション Cookie を立てて `/` へ 302／
  `PUT /api/sync` が KV の内容と併合して保存し併合結果を返す／`DELETE` が KV から消して Cookie を失効
- [ ] **Step 2: 失敗を確認**
- [ ] **Step 3: 実装**（KV スタブと `globalThis.fetch` の差し替えでテストする）
- [ ] **Step 4: PASS を確認**
- [ ] **Step 5: コミット**

### Task 5: クライアント同期（`index.html`）

**Files:**
- Modify: `index.html`（`savePrefs`/`loadPrefs` 周辺、設定画面 `#sync`）
- Test: `tests/sync.js`

**Interfaces:**
- Consumes: `/api/me`, `/api/sync`
- Produces: `syncState`、`syncRefresh()`、`syncNow()`、`syncPushSoon()`

- [ ] **Step 1: 失敗するテストを書く** — 未ログインなら `/api/sync` を呼ばない／`/api/me` が
  `signedIn:true` を返すと起動時に PUT して結果を反映（ベストとツアーが増える）／`savePrefs` が
  デバウンスで 1 回だけ PUT する／API が 503 や例外でもゲームが動き `savePrefs` が失敗しない／
  設定画面にアカウント欄が出る
- [ ] **Step 2: 失敗を確認**
- [ ] **Step 3: 実装**（`fetch` は常に `catch` して握りつぶす。`pagehide` で `sendBeacon`）
- [ ] **Step 4: PASS を確認**
- [ ] **Step 5: コミット**

### Task 6: プライバシーポリシーと文書

**Files:**
- Create: `privacy.html`
- Modify: `index.html`（フッターからのリンク、`<title>` のバージョン）, `README.md`, `CLAUDE.md`

- [ ] **Step 1: `privacy.html` を作成**（`index.html` と同じ配色・書体。取得する情報・保存先・
  利用目的・第三者提供なし・削除方法・問い合わせ先）
- [ ] **Step 2: `domtest.js` にリンクの存在確認を追加し、失敗を確認**
- [ ] **Step 3: `index.html` にリンクを追加**
- [ ] **Step 4: `npm test` 全体が PASS**
- [ ] **Step 5: CLAUDE.md（§6 デプロイに同期の節）と README を更新してコミット**

### Task 7: 実機確認と PR

- [ ] **Step 1: `functions/` を含めたローカル確認**（`npx wrangler pages dev . --kv JUROKU_KV` が
  使えない場合は、テストで担保した範囲を明記する）
- [ ] **Step 2: headless Chrome で未ログイン時の動作（同期欄が出ない・ゲームが従来どおり）を確認**
- [ ] **Step 3: `npm test` 全体 PASS を確認**
- [ ] **Step 4: PR を作成して main にマージ**
- [ ] **Step 5: ユーザーに Cloud Console / Cloudflare 側の設定手順を伝える**

## Self-Review

- **Spec coverage:** 認証（Task 3,4）／KV データ（Task 1,4）／併合規則（Task 1）／クライアント同期（Task 5）／
  UI（Task 5）／プライバシーポリシー（Task 6）／テスト 4 種（Task 1,2,3-4,5）— 仕様の全節に対応するタスクがある
- **Placeholder scan:** TBD・TODO なし。各タスクに具体的な検証項目を書いた
- **Type consistency:** `sanitize`/`mergeState`/`signToken`/`verifyToken`/`getCookie`/`authUrl`/
  `exchangeCode`/`verifyIdToken` の名前は Task 1〜4 で一貫している
