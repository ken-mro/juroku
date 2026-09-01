---
name: add-tour-vol
description: Use when adding a new ワールドツアー (Pulse of the Earth / 地球の鼓動) Vol to JŪROKU from an album markdown — e.g. "Vol.2 を追加して", a path to 地球の鼓動ワールドツアーVolN.md, or any request to add tour tracks/countries to index.html.
---

# ワールドツアーの Vol を追加する

## Overview

Vol の追加は **`tests/tour-import.js` に markdown を渡すだけ**。`index.html` の `TOUR_VOLS` /
`TOUR_COUNTRIES` を手で編集しない（番兵コメントの位置に、検証付きで挿入する専用スクリプトがある）。
曲名（英語）・song ID・国（国旗→ISO2）を markdown から取る。ゲーム内表示は英語のみなので
和名・ジャンル・BPM は取り込まない。国の英語名と座標は `tests/lib/tour-countries.json` から補う。
Suno を実行時に叩かない（CLAUDE.md §3）。

## 手順

1. **dry-run** で解析結果を確認する（表示された 8 行と採用版 v1/v2 を markdown と見比べる）
   ```bash
   node tests/tour-import.js "<album.md>"
   ```
   - 「座標が分かりません」と出たら `tests/lib/tour-countries.json` にその ISO2 の
     `{en, lon, lat}`（英語名は大文字、座標は代表都市）を追記して再実行。
   - 「曲名が既存の曲と重複」と出たら **markdown の曲名を直す**（ベストスコアのキーが曲名なので、
     収録曲や前 Vol と同じ曲名は入れられない。スクリプト側は緩めない）。
2. **挿入**
   ```bash
   node tests/tour-import.js "<album.md>" --apply
   ```
3. **検証**（譜面回帰も含めて全部）
   ```bash
   cd tests && npm test
   ```
   テストは Vol の数に依存しない（`tests/tour.js` / `tests/tour-import.test.js` は「今ある Vol の次」を
   合成して検証する）。**Vol を足すためにテストを書き換える必要は無い**。落ちたらデータの問題。
4. **mp3 を R2 に上げる**（音源は Suno CDN からは読めない。自前配信が唯一の経路 — CLAUDE.md §3）。
   Suno から各曲の mp3 をダウンロードし（自分の曲。Download → MP3 Audio）、曲 ID の名前で置く:
   ```bash
   npx wrangler r2 object put "juroku-audio/<曲ID>.mp3" --file="<mp3>" --content-type audio/mpeg --remote
   ```
   R2 に無い曲は動画 mp4 の音声で再生されるが、**譜面が mp3 と別物になる**ので必ず全曲上げる。
5. `public/index.html` の `<title>` のバージョンを上げる（`v<今日の日付 YYYY.MM.DD>-<その日の通し番号>`。
   同じ日なら末尾の番号を +1）。画面には出さない。
6. `README.md` の「ワールドツアー」節に Vol の行（Vol 番号・国の並び・曲数）を足す。
7. コミット（依頼があれば）。

## 前提となる markdown の形

`tests/fixtures/tour-vol1.md` が正例。必要なのは:
- タイトルに `Vol.N`、`アルバム名(英):` の行（英語名がゲーム内のアルバム名になる）
- 「収録国一覧」表 `| # | 曲名 | 国 | … | 採用 |`（列名は「国」で始まっていればよく、Vol.4 以降の「国/文化」も可。
  国は **絵文字** で判定：🇯🇵 のような ISO2 の旗、🏴󠁧󠁢󠁳󠁣󠁴󠁿 のようなタグ列の旗（コードは SCT / WLS / ENG）、
  🕎 🌺 のような**国に紐づかない文化の絵文字**（`tests/lib/tour-countries.json` の `emoji` 欄と照合して
  KLZ / HAW のようなコードにする。表に無ければ座標付きで追記してから再実行）。ジャンル/BPM 列はあっても読まない）
- 各 `## Track NN: Title / 和名 【🇯🇵 日本】` 節に `- vN URL: https://suno.com/song/<uuid> ★採用`

形が違えばスクリプトはエラーで止まる。**その場合は markdown 側を直す**（スクリプトに例外を足さない）。
国・曲名は **表** が正。本文の「物語アーク」などの散文は読まない。

## やってはいけないこと

| やりがちなこと | 代わりに |
|---|---|
| `TOUR_VOLS` に手でオブジェクトを書く | スクリプトの `--apply`（番兵の回数と重複 Vol を assert し、挿入後に再確認する） |
| 曲名や国旗を推測で埋める | markdown を直してから再実行 |
| テストを飛ばす | `npm test`。`tests/tour.js` と `tests/tour-import.test.js` が Vol データの整合を見る |
| 座標を `index.html` に直書き | `tests/lib/tour-countries.json` に足す（次の Vol でも使い回せる） |

## 仕組み（読む必要が出た時だけ）

- 挿入位置は `public/index.html` の `/* TOUR_COUNTRIES_END */` と `/* TOUR_VOLS_END */`。消さない。
- 追加した Vol は、前の Vol を完走したプレイヤーにだけ地図に現れ、前 Vol の最終国から航路が続く
  （`tourVisibleVols()` / `tourJourney()`）。コードの変更は不要。
