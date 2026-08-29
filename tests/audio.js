#!/usr/bin/env node
"use strict";
/* tests/audio.js — クライアントの音源取得（fetchAudio）のフォールバック
 *
 * Suno CDN（cdn1.suno.ai）が直接読めない場合（CORS ヘッダの欠落・ホットリンク遮断・
 * 一時的な 403）に、同一オリジンの中継 /api/audio?id=… で 1 度だけやり直すこと、
 * それ以外の URL では勝手に中継を使わないことを確認する。
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

  /* 直接取得できるなら中継は使わない */
  {
    clearCache();
    const buf = new ArrayBuffer(8);
    const calls = [];
    window.fetch = async u => { if(MINE(String(u))) calls.push(String(u)); return mkRes(buf); };
    const ab = await window.fetchAudio(CDN);
    assert(ab === buf, "直接取得の結果を返す");
    assert(calls.length === 1 && calls[0] === CDN, "直接取得のみ: " + JSON.stringify(calls));
    /* 2 回目はキャッシュから（fetch されない） */
    await window.fetchAudio(CDN);
    assert(calls.length === 1, "2 回目はキャッシュから返す");
    console.log("[audio] 直接取得 OK（中継なし・キャッシュ）");
  }

  /* 直接取得が例外（CORS 遮断はネットワークエラーになる）→ 中継でやり直す */
  {
    clearCache();
    const buf = new ArrayBuffer(4);
    const calls = [];
    window.fetch = async u => {
      if(MINE(String(u))) calls.push(String(u));
      if(String(u) === PROXY) return mkRes(buf);
      throw new TypeError("Failed to fetch");         // ブラウザの CORS 失敗はこの形
    };
    const ab = await window.fetchAudio(CDN);
    assert(ab === buf, "中継の結果を返す");
    assert(calls.length === 2 && calls[1] === PROXY, "CDN 失敗後に中継を 1 度だけ試す: " + JSON.stringify(calls));
    console.log("[audio] CORS/ネットワーク失敗 → 中継 OK");
  }

  /* 直接取得が 403（ホットリンク遮断）→ 中継でやり直す */
  {
    clearCache();
    const buf = new ArrayBuffer(4);
    const calls = [];
    window.fetch = async u => {
      if(MINE(String(u))) calls.push(String(u));
      if(String(u) === PROXY) return mkRes(buf);
      return { ok: false, status: 403, headers: { get: () => null } };
    };
    const ab = await window.fetchAudio(CDN);
    assert(ab === buf, "403 でも中継の結果を返す");
    assert(calls[1] === PROXY, "403 の後に中継を試す: " + JSON.stringify(calls));
    console.log("[audio] 403 → 中継 OK");
  }

  /* 中継も失敗（静的配信のみで API が無い等）→ 元の失敗として投げる */
  {
    clearCache();
    const calls = [];
    window.fetch = async u => { if(MINE(String(u))) calls.push(String(u)); throw new TypeError("Failed to fetch"); };
    let threw = null;
    try{ await window.fetchAudio(CDN); }catch(e){ threw = e; }
    assert(threw, "両方失敗したら例外");
    assert(calls.length === 2, "中継のやり直しは 1 度だけ: " + JSON.stringify(calls));
    console.log("[audio] 両方失敗 → 例外 OK");
  }

  /* Suno CDN 以外の URL では中継を使わない */
  {
    clearCache();
    const calls = [];
    window.fetch = async u => { if(MINE(String(u))) calls.push(String(u)); throw new TypeError("Failed to fetch"); };
    let threw = null;
    try{ await window.fetchAudio("https://example.com/song.mp3"); }catch(e){ threw = e; }
    assert(threw && calls.length === 1, "対象外 URL は直接取得のみ: " + JSON.stringify(calls));
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
  console.log("[audio] PASS — 直接取得・中継フォールバック・ID 判定");
  process.exit(0);
}
main().catch(e => fail((e && e.stack) || String(e)));
