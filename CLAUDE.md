# 十六 (JŪROKU)

音声を解析して 4×4 のパネルに譜面を自動生成するリズムゲーム。単一 HTML ファイルで完結し、
Cloudflare Pages で静的ホストする。

---

## 1. まず知っておくこと

### ディレクトリ構成

```
public/        配信される静的ファイル（index.html / privacy(-en).html / terms(-en).html / fonts / icons / site.webmanifest / _headers）
worker/        Cloudflare Worker（サーバー側。index.js が入口で /api/* を処理。§6）
wrangler.toml  Worker の設定（main / assets / KV）
tests/         ヘッドレステスト
```

配信は **Cloudflare Workers（静的アセット付き）**。Pages ではないので、
`functions/` にファイルを置けばルートになる Pages Functions の規約は**使えない**
（実際に一度それで API が 404 になった）。API を増やす時は `worker/api/` にモジュールを作り、
`worker/index.js` の `ROUTES` に 1 行足す。

### 単一ファイル構成
`public/index.html` に HTML / CSS / JS がすべて入っている。**ファイル分割はしない。**
（この規則はゲーム本体＝クライアントの話。サーバー側は `worker/` に分ける — §6 参照）
配布と改変の容易さを優先した意図的な設計で、ビルド工程もパッケージマネージャも無い。

外部のライブラリ・サービスへの依存は**無し**。フォント（Shippori Mincho / Zen Kaku Gothic New /
JetBrains Mono、いずれも SIL OFL）は `public/fonts/` に自前で置き `fonts/fonts.css` から読む
（Google Fonts のサーバーから読み込む形には**戻さない**。利用者の IP を第三者に送らないため —
プライバシーポリシー第 8 項がそう約束している）。`fonts/fonts.css` は Google Fonts が配信する
unicode-range 分割そのままの写しなので、読み込み量は以前と同じ。フォントを増やす時も同じ方式で
`public/fonts/` に置く。ライブラリの追加を検討する前に、素の JS で書けないかを先に考える。

### 変更してはいけないもの
譜面生成アルゴリズム（`detectOnsets` / `analyzeSections` / `buildChart` とその定数）は
長い実測と調整の結果として現在の値に落ち着いている。**依頼が無い限り触らない。**
触る場合は §5 の回帰手順を必ず通すこと。

---

## 2. UI/UX Design Principles（重要）

JŪROKU は独自の視覚言語・タイミング提示・判定表現を持つ。以下は思いつきの装飾ではなく
**設計の基準**なので、勝手に変えないこと。

### 打点（Hit Point）

プレイヤー向けの中心概念は「打点 / Hit Point」。マーカーが打点に達した瞬間が押し時。

> マーカーが打点に達したタイミングで押す
> Press when the marker reaches the Hit Point.

「リング」はゲーム概念としては前面に出さない。SVG / Canvas 上で実際に円を描く変数名や
内部コメント（`ring` 等）は技術名称として維持してよいが、UI テキストや説明文では使わない。

### マーカー

マーカーは 5 種。それぞれ**異なる空間的・時間的アニメーション**を採用し、単一の
拡大・縮小表現だけに依存しない（水位 / 回転 / 掃引 / 移動 / 発火を使い分ける）。

- 満 = 下から満ちる水位。上端の打点線に届いた瞬間（**既定**）
- 環 = 外周アークの回転充填。一周した瞬間
- 火 = 渦の導火線を火花が中心へ走り、燃え尽きて「ドン」
- 簾 = 左から右への掃引。右端に届いた瞬間
- 蚊 = 蚊が飛来し、大きさの変わらない中央の丸（打点）に入った瞬間

- **打点を過ぎた後は、どのマーカーも同じ向きへそのまま進み続けて「遅れた量」が見える**
  （`paintMarker(..., late)` の `late` = 打点からの遅れ / W_AMA、0→1。45ms で冴の外、140ms で逃の境）。
  満 = 水面が打点線を越えて上端へ、水の底も上がり抜けていく／環 = 一周した後もそのまま回り続ける
  （胡粉の弧、140ms で半周）／火 = 火花が中心を抜けて下へまっすぐ飛び「ドン」は薄れる／
  簾 = 後端が右へ追いつき抜けていく／蚊 = 反対側へ飛び抜ける。鮮色（押し時の色）は遅れに応じて引く。
  パネルの外へは出さない。

- 火・蚊は中心へ向かうが、**閉じた図形の拡大・縮小は使わない**（線幅・丸の径は不変）。
  手がかりは「固定された軌道上を進む一点が打点に達する」構造に絞る。
- どのマーカーも**時間の経過方向が明確に読める**こと。残り時間が水位の隙間・弧の残り・
  導火線の長さ・掃引の残り幅といった「量」として見えている状態を保つ。
- プレイヤーがタイミングを直感的に認識できることを最優先する。過度な発光や派手すぎる
  エフェクトは足さない。ゲームプレイ中にノーツ位置が認識しづらくなる変更は入れない。
- 新しいマーカーを足す場合も同じ基準に従う。

### 難易度の選択

難易度は**ひとつの値**（`setDifficulty()`）。タイトル画面の `#diff` とワールドツアー画面の `#tdiffsel` は
**同じ部品（`.seg`）を同じ位置関係で置いた同じセレクタ**で、どちらで選んでも両方が揃う。出発カードは現在値の
表示だけでセレクタを持たない（出発カードの中に別のセレクタがあると「別の設定」に見えて迷ったため）。
選んだ値は `juroku:difficulty` に保存し、次回起動時も維持する（同期対象ではない＝端末ごと）。

設定画面（`#sync`）はタイトルからもツアー画面からも開ける。`syncStart()` が開いた元の画面を覚え、
`syncStop()` はそこへ戻す（ツアーの途中で設定を変えるためにタイトルへ戻らなくてよい）。

### ワールドツアーの地図と演出

- 世界地図は **点描**（胡粉の点の集合、手書きの簡略ポリゴン `TOUR_LAND` から point-in-polygon で生成）。
  外部の地図データ・ライブラリは使わない。粗い輪郭は点描で吸収する設計なので、精密化しない。
- クリア済み＝**朱印**（朱の丸に金縁と「印」）、次の目的地＝金の脈動リング、未訪問＝薄い輪。
  **選択中の国は囲みの角（照準）**で示す（`tourMarkSelected`）。朱印・脈動と重ならない形にして、
  「クリア済み」「次」「いま見ている」を同時に読み分けられるようにしてある。
  飛行済みの航路は金の実線、これからの航路は点線。訪問済みの国の周囲の点だけ金に灯る。
- 飛行機は二次ベジェの弧を JS で補間して動かす（`prefers-reduced-motion` では即完了）。
  過度な発光やパーティクルは足さない。地図は全 Vol で 1 枚（累積）。

### ブランド

- UI・配色・判定名（冴 / 良 / 甘 / 逃）・段位（極 / 秀 / 優 / 良 / 可 / 不可）・マーカー名は
  すべて JŪROKU 独自の世界観で統一する。
- 漆・朱・金を中心とした和風モダンのビジュアルアイデンティティを維持する。
  マーカーごとの固有色（金 / 藍 / 朱 / 若竹 / 藤紫）はこの下地の上に置くアクセント。
- 設計基準は他作品との比較ではなく、JŪROKU 自身の操作性・視認性・独自性に置く。

### 言語（日本語 / English）

- UI 文言は辞書 `I18N.ja` / `I18N.en` に持ち、`t(key)` で引く。HTML 側は `data-i18n="key"`
  （textContent）/ `data-i18n-html`（innerHTML）/ `data-i18n-attr="attr:key,attr:key"`（属性）を付け、
  `applyLang()` が一括で差し替える。JS が組み立てる文言も必ず `t()` を通す（生の日本語を書かない）。
- 初回はブラウザの言語（`navigator.language` が `ja*` なら日本語、それ以外は英語）。設定画面の
  `#langsel` で切り替え、`juroku:lang` に保存する（保存済みなら自動判定より優先）。
- **判定名・段位・マーカー名は英語表示でも漢字を残す**（JŪROKU の世界観）。英語ではローマ字読みを添える:
  `kj(k)` が `ROMAJI` 表から `冴 SAE` / `満 MITSU` のように組み立てる。HTML 側は `data-kj="漢字"`。
  結果画面の大きな段位（`#rrank`）は漢字のまま、副題行にローマ字を出す。
- 結果画像は元から英字ベース（PLAY RESULT / 判定のローマ字入り）で言語に依存しない。
- プライバシーポリシーは `privacy.html`（日本語）と `privacy-en.html`（英語）、利用規約は `terms.html` と
  `terms-en.html`。設定画面・フッター・ログイン欄のリンクは言語に合わせて切り替わる。**片方だけ更新しない**。
  外部サービスへの通信（Cloudflare / Suno CDN / リンク解決の中継 / Google）を増減した時は
  ポリシー第 8 項も必ず直す。
- 辞書のキーは ja / en で完全一致させる（`tests/i18n.js` が検証）。テスト環境（`tests/lib/env.js`）は
  `navigator.language` を `ja-JP` に固定しているので、既存テストの日本語文言はそのまま通る。

### 既定マーカー

初期値は **満**（`let marker = "fill"` / `#markersel` の `満` ボタンが `aria-pressed="true"`）。
`localStorage` の `juroku:marker` に保存済みの設定がある場合は**上書きしない**
（`loadPrefs()` は値がある時だけ `marker` を差し替える）。既存プレイヤーの選択は必ず残す。

---

## 3. 仕様

### 判定とスコア

| 判定 | 読み | 許容 | 素点 |
|---|---|---|---|
| 冴 | SAE | ±45ms | 100 |
| 良 | RYŌ | ±90ms | 70 |
| 甘 | AMA | ±140ms | 30 |
| 逃 | NOGASHI | それ以上 / 未押下 | 0 |

```
スコア = Σ(素点 × (1 + min(その瞬間のコンボ, 120) / 240))    // 120コンボで×1.5上限
精度   = 素点の合計 ÷ (総ノーツ数 × 100)                      // コンボ倍率を含まない
```

段位は**精度**で決まる（スコアではない）: 極97 / 秀92 / 優84 / 良70 / 可50 / それ未満は不可。
コンボは逃でのみ切れる（甘では継続）。

### 譜面生成パイプライン

```
22050Hz モノラル化 → FFT 1024 / hop 256 → 4帯域スペクトル差分
→ 適応正規化ピーク検出 → ONSET_COMP=0.036s 補正（実測校正、誤差±7ms）
→ 30ms クラスタ化 → 各種ゲート → セクション別予算で選別 → 両手到達モデルで配置
```

- BPM 推定・グリッド量子化は**行わない**。ノーツは生のオンセット位置に置く。
- シードは音声内容の FNV ハッシュ。**同じ音源からは常に同じ譜面**が出る（決定的）。
  ただし「同じ音源」はデコード後の PCM の意味なので、コーデック（mp3→mp4/AAC）や
  端末のサンプルレートが変わると譜面も変わる。実際に音源の mp3→mp4 切替で
  全収録曲の譜面が変わった。
- **凍結譜面**: mp3 時代の譜面を `tools/freeze-chart.js`（実 Chromium で mp3 を解析）で
  全難易度ぶん事前計算して `public/charts/{曲ID}.json` に置く。`prepare()` は音源 URL の
  UUID からファイルを引き、あれば解析をスキップしてそれを使う（全端末で同一譜面になる）。
  無い・読めない・壊れている場合は従来どおり生成する。mp3 と mp4 のデコード波形は
  同一タイムライン（実測オフセット 0ms）なので mp3 由来の時刻は mp4 再生にそのまま合う。
  凍結を増やすには各曲の mp3 が必要（CDN からはもう取得できない。作者の手元の
  ダウンロード品を使う）。`node tools/freeze-chart.js <曲ID> <mp3>` で 1 曲ずつ追加。
- 難易度別パラメータは `DIFF`。`riseFrac`（最小アタック床）と `salFloor`（セクション内
  相対床）が「曲と合っていないノーツ」の抑制を担う。
- 配置は両手モデル（左手 = 列0-2 / 右手 = 列1-3）。`validate()` が押下可能性を検証する。

### 結果画面と結果画像

- `finish()` は最終値を DOM に入れてから `revealResult()` を呼ぶ。演出は 冴→良→甘→逃 のカウントアップ →
  最大コンボ → 段位（判定）→ 点数 → 精度 → バッジ → ボタン。`#result` のタップで即完了、
  `reduceMotion` なら即完了。rAF が止まっても `setTimeout` で必ず最終状態にする。
- 結果画像は `renderShareCanvas(rec)`（1080×1080）。`rec` は bests と同じ形 `{title, diff, s, a, c, m, n, d}` で、
  結果画面は `lastResult`、ベスト記録モーダルは `bestShown` を渡す（**同じ関数・同じ見た目**）。
  ジャケットは CORS 可なら描く（cdn2.suno.ai は許可済み）。保存は `saveShareImage()`：
  モバイル（pointer: coarse）で `navigator.share` が使えれば共有シート、それ以外はダウンロード。

### ワールドツアー「地球の鼓動 / Pulse of the Earth」

```
TOUR_COUNTRIES  ISO2 → {en, lon, lat}              /* TOUR_COUNTRIES_END */ の前に追記
TOUR_VOLS       [{vol, title, tracks:[{id, title, cc}]}]   /* TOUR_VOLS_END */ の前に追記
tourState       {cleared:{[trackId]:{d, diff, acc}}}   localStorage juroku:tour
```

- 進行は **行程 `tourJourney()`**（表示できる Vol の曲を順に連結した 1 本の列）で管理する。
  曲 k は「k-1 までクリア済み」で解放（`tourNextSeq()`）。クリア＝精度 50%（可）以上、難易度は問わない。
- Vol.N は Vol.N-1 完走で現れる（`tourVisibleVols()`）。次の Vol のデータが無い間は何も出さない。
  Vol の境界でも前 Vol の最終国から航路が続く（`prevCC`）。
- 「国」は ISO2 だけでなく、タグ列の旗（SCT 等）や **国に紐づかない文化**（KLZ クレズマー・HAW ハワイ 等、
  `flag:` に絵文字を持つ）も置ける。地図の座標は代表地（クレズマーは発祥地の東欧、ハワイはホノルル）。
- ツアー経由のプレーは `pendingTour` → `play()` 冒頭で `cur.tour` に移す。`finish()` が `tourOnFinish()` を呼ぶ。
  `quit()` / 結果画面の MAP はツアー画面に戻る。
- クリア済みのツアー曲だけが収録曲タブ（`#ttracks`）に `tag`（国旗＋国名）付きで出る。未クリアは出さない。
- 地図の下の国チップは **Vol ごとに 1 ページ**（CSS のスクロールスナップで横スワイプ）。
  `‹ ›` のボタンも置く（スワイプできない環境のため）。別 Vol の国を選ぶとその Vol のページへ送る。
- **表示は英語のみ**（アルバム名 "Pulse of the Earth"、国名 JAPAN/CHINA…、曲名）。和名・ジャンル・BPM は
  データにも持たない。地図は選択中の国の経度を中央にして描く（`tourLon0` / `tourRot`）。
- **Vol の追加は `.claude/skills/add-tour-vol`（`node tests/tour-import.js <md> --apply`）で行う。**
  番兵コメント `/* TOUR_VOLS_END */` `/* TOUR_COUNTRIES_END */` は消さない。手で `TOUR_VOLS` を書かない。

### 曲データ

```js
{ id:"...", title:"..." }
  .map(x => ({ ...x, ready:true, artist:"ken_mro",
               url:SUNO_CDN(x.id), art:SUNO_ART(x.id) }))
```

- **ハードコード**: 曲ID / 曲名 / アーティスト名（全曲 `ken_mro` 固定）
- **IDから生成**: 音源URL `cdn1.suno.ai/{id}.mp3` / 画像URL `cdn2.suno.ai/image_large_{id}.jpeg`
- **実行時取得**: 画像の実体、曲の長さ（Audio のメタデータから実測）

曲名を実行時に Suno から取得する方式は一度試して**失敗した**。ブラウザから suno.com は
CORS で読めず、無料の CORS 中継は 429 や停止が常態で、16 曲ぶんの取得に最悪 1 時間かかった。
同じ轍を踏まないこと。曲名は事前に取得した値を持たせる。

画像は URL が曲IDから決まるため差し替えてもURLが変わらない。日付クエリ `?v=YYYYMMDD` で
1日1回だけ取り直す。クエリを弾かれた場合は素のURLで再試行し、それも失敗したら ♪ を出す。

---

## 4. 作業上の注意

### 文字列置換は必ず検証する
過去に Python の `str.replace` が無言で空振りし、「実装したつもり」が複数回発生した。
置換前に対象文字列の存在を assert し、置換後に結果を確認すること。

### 置換範囲を広く取りすぎない
一度、関数末尾の探索範囲を誤って `renderUserTracks` など 4 つの関数を巻き添えで削除した。
大きな塊を差し替えたら、変更前後で**トップレベル関数の一覧を比較**して欠落を確認する。

### バージョン
`<title>` タグにのみ記載する（画面には出さない）。どのファイルを開いているかの切り分け用。

### アイコン
`icons/icon.svg` が原本（漆の下地に 4×4 の盤、金→朱の「十六」。Shippori Mincho ExtraBold の字形を
パス化してあるのでフォント無しで描ける）。`icons/*.png`（192 / 512 / maskable 512 / apple-touch-icon 180 /
favicon-32）は原本から書き出した生成物で、`site.webmanifest` と `<head>` の `<link>` が参照する。
apple-touch-icon と maskable は角丸なしの全面塗り（OS 側でマスクされる）。デザインを変える時は SVG を
直して PNG を作り直す。

### やらないこと
- フッターにバージョンや説明文を出す（削除済み。戻さない）
- 曲名・機能の追加時に、既存のベストスコアのキーを壊す
  （曲名がキーなので、改名時は旧キーからの移行処理を入れる）

---

## 5. テスト

`tests/` にヘッドレスの検証スクリプトを置く方針（未整備なら作ってよい）。
譜面生成に触れた場合は**必ず**以下を確認する。

```bash
node tests/smoke.js      # 起動→カウントイン→判定→ポーズ→再開
node tests/domtest.js    # jsdom でのDOM構造・スクリプトエラー
node tests/chart.js      # 既知の音源で譜面が変化していないか（時刻+パネルの完全一致）
node tests/frozen-chart.js  # 凍結譜面（charts/{曲ID}.json の使用・難易度選択・破損/オフライン時の生成フォールバック）
node tests/tour.js       # ワールドツアー（データ整合・解放ロジック・地図・finish 連携・失敗経路）
node tests/tour-import.test.js  # Vol 追加スクリプト（fixture の md == index.html の Vol.1、合成 Vol.2 の挿入）
node tests/result.js     # 結果画面の段階表示・結果画像（記録の同一性、canvas が例外を出さない、ボタン配線）
node tests/merge.js      # 併合規則（高スコア優先・和集合・可換・冪等・検証・上限）
node tests/session.js    # セッション署名（改ざん・期限切れ・別鍵の拒否）
node tests/api.js        # OAuth 検証となりすまし拒否、API の認証ガード・併合保存・削除
node tests/cloud.js      # クライアント同期（未設定/通信断/未ログインで無害、反映、デバウンス）
node tests/i18n.js       # 言語（辞書 ja/en の整合、ブラウザ言語の自動判定、切替と保存、漢字＋ローマ字）
```
（`cd tests && npm test` で全部通る）

譜面の回帰は「全ノーツの時刻とパネル番号を文字列化して比較」する。ノーツ数の一致だけでは
不十分。基準となる音源と期待値は `tests/fixtures/` に置く。

jsdom で動かす際は `matchMedia` / `ResizeObserver` / `AudioContext` / `Audio` / `fetch` の
スタブが必要。`fetch` はオフラインを返すようにして、実ネットワークを叩かせない。

---

## 6. クラウド同期（Google ログイン + Cloudflare KV）

ログインは**任意**。未ログイン・未設定・通信断のいずれでも `localStorage` だけで全機能が動く。
同期は上乗せの機能で、**ゲームの流れを止めないこと**が最優先（通信は必ず握りつぶす）。

```
worker/index.js       入口。/api/* を ROUTES で振り分け、それ以外は env.ASSETS へ委ねる
worker/lib/merge.js   併合規則（純関数。可換・冪等・キー順も確定）
worker/lib/session.js HMAC セッションと HttpOnly Cookie
worker/lib/google.js  認可URL・コード交換・IDトークン検証（JWKS/RS256、iss/aud/exp）
worker/lib/config.js  環境変数の取り出しと共通レスポンス
worker/api/...        auth/{login,callback,logout}, me, sync(GET/PUT/POST/DELETE)
```

- Cloudflare Workers（**ビルド不要**、`npx wrangler deploy`）。KV は `wrangler.toml` の
  `[[kv_namespaces]]` で `JUROKU_KV` としてバインドする（ダッシュボードで足したバインディングは
  deploy で消えるため、必ず `wrangler.toml` に書く）
- 秘密情報 `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `SESSION_SECRET` は Cloudflare の Secret。
  **リポジトリに置かない。** 未設定なら全 API が 503 を返し、クライアントは同期 UI ごと出さない
- 同期対象は `juroku:bests` / `juroku:tour` / `juroku:usertracks` の 3 つだけ。
  OFFSET・マーカー等の端末固有の設定と、曲の長さキャッシュ、音源そのものは同期しない
- 経路は 1 つ：**端末の全体を PUT → サーバーが併合して保存 → 併合結果を採用**。
  併合は「失われない方」を選ぶ（ベストは高スコア・クリアは古い日時・リンク曲は url で重複排除）。
  可換かつ冪等なので競合解決が要らない。**この性質を壊す変更をしない**（`tests/merge.js` が検証）
- クライアント側の識別子は `cloud*`（`#sync` 画面＝ズレ調整の `sync*` と紛らわしいため区別する）
- 同意画面の公開に `privacy.html` が必要。取り扱いを変えたらこのページも必ず更新する

## 7. デプロイ

**Cloudflare Workers**（Git 連携、ビルドコマンド無し、デプロイコマンド `npx wrangler deploy`、
本番ブランチ `main`）で配信する。設定は `wrangler.toml`。ビルド不要。`main` へのマージで自動デプロイ。

- `public/_headers` でキャッシュ方針（HTML は no-cache、`icons/` は長期）を指定
- `.html` を落とした URL が正（`/privacy.html` は `/privacy` へ 307）
- ローカルで API ごと動かす: `npx wrangler dev`（`http://127.0.0.1:8787`）。
  静的ファイルだけでよければ `python3 -m http.server -d public`
- HTTPS 必須（Web Audio API と、Suno CDN からの取得のため）
- `file://` で開くと CORS で音源が読めない。ローカル確認は `python3 -m http.server -d public` を使う
  （API も動かすなら `npx wrangler dev`。静的配信だけなら同期 UI は出ない＝未設定と同じ状態）
