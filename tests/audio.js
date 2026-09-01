#!/usr/bin/env node
"use strict";
/* tests/audio.js — クライアントの音源取得（fetchAudio）の経路
 *
 * Suno の曲は同一オリジンの中継 /api/audio?id=… を最優先で使うこと
 * （worker/api/audio.js が R2 の自前 mp3 を返す。全員が同じバイト列を受け取る
 * ことが譜面固定の前提）、中継が使えない環境（静的配信のみ＝API 404 等）では
 * 元 URL の直接取得で 1 度だけやり直すこと、Suno 以外の URL では中継を
 * 使わないことを確認する。
 */
const fs = require("fs");
const path = require("path");
const { buildEnv } = require("./lib/env.js");

function fail(msg){ console.error("[audio] FAIL: " + msg); process.exit(1); }
const assert = (c, m) => { if(!c) fail(m); };

const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const { window, testErrors } = buildEnv(html);

/* 起動直後の同期（/api/me など）が同じ fetch スタブを共有するため、
   このテストが見るのは音源系の URL だけに絞る。 */
const MINE = u => u === CDN || u === PROXY || /example\.com/.test(u);

const ID = "029ecb48-dd9c-4fd6-b4e3-f1738c592766";
const CDN = `https://cdn1.suno.ai/${ID}.mp3`;
const PROXY = "/api/audio?id=" + ID;

/* fetchAudioStream が読める最小のレスポンス（ストリーム非対応の経路を通す） */
const mkRes = buf => ({ ok: true, headers: { get: () => null }, body: null, arrayBuffer: async () => buf });
const clearCache = () => window.eval("audioCache").clear();

async function main(){
  assert(typeof window.fetchAudio === "function", "fetchAudio が window に居ること");
  assert(testErrors.length === 0, "起動時のスクリプトエラー: " + testErrors.join("\n"));

  /* Suno の曲は中継を最優先にする（直接取得しない＝配信が変わっても譜面が揺れない） */
  {
    clearCache();
    const buf = new ArrayBuffer(8);
    const calls = [];
    window.fetch = async u => { if(MINE(String(u))) calls.push(String(u)); return mkRes(buf); };
    const ab = await window.fetchAudio(CDN);
    assert(ab === buf, "中継の結果を返す");
    assert(calls.length === 1 && calls[0] === PROXY, "中継のみ（CDN へ直接行かない）: " + JSON.stringify(calls));
    /* 2 回目はキャッシュから（fetch されない） */
    await window.fetchAudio(CDN);
    assert(calls.length === 1, "2 回目はキャッシュから返す");
    console.log("[audio] 中継優先 OK（直接取得なし・キャッシュ）");
  }

  /* 中継が使えない（静的配信のみ＝404、通信断など）→ 元 URL でやり直す */
  {
    clearCache();
    const buf = new ArrayBuffer(4);
    const calls = [];
    window.fetch = async u => {
      if(MINE(String(u))) calls.push(String(u));
      if(String(u) === CDN) return mkRes(buf);
      return { ok: false, status: 404, headers: { get: () => null } };
    };
    const ab = await window.fetchAudio(CDN);
    assert(ab === buf, "直接取得の結果を返す");
    assert(calls.length === 2 && calls.join("→") === PROXY + "→" + CDN,
      "中継 404 の後に元 URL を 1 度だけ試す: " + JSON.stringify(calls));
    console.log("[audio] 中継 404 → 直接取得 OK");
  }

  /* 中継が例外（通信断）でも同じく元 URL でやり直す */
  {
    clearCache();
    const buf = new ArrayBuffer(4);
    const calls = [];
    window.fetch = async u => {
      if(MINE(String(u))) calls.push(String(u));
      if(String(u) === CDN) return mkRes(buf);
      throw new TypeError("Failed to fetch");
    };
    const ab = await window.fetchAudio(CDN);
    assert(ab === buf, "通信断でも直接取得の結果を返す");
    assert(calls[1] === CDN, "例外の後に元 URL を試す: " + JSON.stringify(calls));
    console.log("[audio] 中継の通信断 → 直接取得 OK");
  }

  /* 両方失敗 → 中継側の失敗として投げる（やり直しは 1 度だけ） */
  {
    clearCache();
    const calls = [];
    window.fetch = async u => { if(MINE(String(u))) calls.push(String(u)); throw new TypeError("Failed to fetch"); };
    let threw = null;
    try{ await window.fetchAudio(CDN); }catch(e){ threw = e; }
    assert(threw, "両方失敗したら例外");
    assert(calls.length === 2, "やり直しは 1 度だけ: " + JSON.stringify(calls));
    console.log("[audio] 両方失敗 → 例外 OK");
  }

  /* Suno CDN 以外の URL では中継を使わない */
  {
    clearCache();
    const calls = [];
    window.fetch = async u => { if(MINE(String(u))) calls.push(String(u)); throw new TypeError("Failed to fetch"); };
    let threw = null;
    try{ await window.fetchAudio("https://example.com/song.mp3"); }catch(e){ threw = e; }
    assert(threw && calls.length === 1 && /example\.com/.test(calls[0]),
      "対象外 URL は直接取得のみ: " + JSON.stringify(calls));
    console.log("[audio] 対象外 URL は中継しない OK");
  }

  /* sunoAudioId の判定（大文字 ID・別ホスト・mp3 以外） */
  {
    const f = window.eval("sunoAudioId");
    assert(f(CDN) === ID, "曲 URL から ID を取る");
    assert(f(`https://cdn1.suno.ai/${ID.toUpperCase()}.mp3`) === ID, "大文字 ID は小文字化する");
    assert(f(`https://cdn2.suno.ai/${ID}.mp3`) === "" && f(`https://cdn1.suno.ai/${ID}.wav`) === "" && f("") === "",
           "対象外は空文字");
    console.log("[audio] sunoAudioId OK");
  }

  assert(testErrors.length === 0, "スクリプトエラー: " + testErrors.join("\n"));
  console.log("[audio] PASS — 中継優先・直接取得フォールバック・ID 判定");
  process.exit(0);
}
main().catch(e => fail((e && e.stack) || String(e)));
