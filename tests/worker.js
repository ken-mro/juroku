#!/usr/bin/env node
"use strict";
/* tests/worker.js — Worker の入口とルーティング（worker/index.js）
 *
 * Pages Functions のような「ファイル名＝ルート」の規約が無いぶん、対応表の取り違えを
 * ここで検出する。静的アセットへの委譲（ゲーム本体が配信されること）も確認する。
 */
const path = require("path");
const { pathToFileURL } = require("url");
function fail(msg){ console.error("[worker] FAIL: " + msg); process.exit(1); }
const assert = (c, m) => { if(!c) fail(m); };

async function main(){
  const mod = await import(pathToFileURL(path.join(__dirname, "..", "worker", "index.js")).href);
  const worker = mod.default;
  assert(worker && typeof worker.fetch === "function", "worker must export a default object with fetch()");

  /* 静的アセットは ASSETS に委ねる */
  const assetCalls = [];
  const env = { ASSETS: { fetch: async r => { assetCalls.push(new URL(r.url).pathname); return new Response("<html>game</html>", { status: 200 }); } } };
  for(const p of ["/", "/index.html", "/privacy", "/icons/icon.svg", "/site.webmanifest"]){
    const res = await worker.fetch(new Request("https://ju-roku.com" + p), env);
    assert(res.status === 200, `${p} は静的アセットとして 200 であるべき（got ${res.status}）`);
  }
  assert(assetCalls.length === 5, "静的パスはすべて ASSETS に渡す: " + JSON.stringify(assetCalls));
  console.log("[worker] 静的アセットへの委譲 OK");

  /* /api/* は ASSETS に渡さない（Secret 未設定なので 503 が返る） */
  const before = assetCalls.length;
  for(const p of ["/api/me", "/api/sync", "/api/auth/login"]){
    const res = await worker.fetch(new Request("https://ju-roku.com" + p), env);
    assert(res.status === 503, `${p}: 設定前は 503（got ${res.status}）`);
  }
  assert(assetCalls.length === before, "/api/* を静的アセットに渡してはいけない");

  /* 末尾スラッシュでも同じルートに届く */
  assert((await worker.fetch(new Request("https://ju-roku.com/api/me/"), env)).status === 503, "末尾スラッシュも同じルートに解決する");

  /* 知らない API は 404、対応していないメソッドは 405 */
  const nf = await worker.fetch(new Request("https://ju-roku.com/api/nope"), env);
  assert(nf.status === 404, "未定義の API は 404（got " + nf.status + "）");
  assert((await nf.json()).error === "not_found", "404 は JSON で返す");
  const bad = await worker.fetch(new Request("https://ju-roku.com/api/me", { method: "DELETE" }), env);
  assert(bad.status === 405, "対応していないメソッドは 405（got " + bad.status + "）");
  assert(bad.headers.get("allow").includes("GET"), "405 は Allow を返す: " + bad.headers.get("allow"));
  console.log("[worker] ルーティング OK (503 / 404 / 405 / 末尾スラッシュ)");

  /* ハンドラが例外を投げてもサイト全体を落とさない */
  const boom = { ...env, get GOOGLE_CLIENT_ID(){ throw new Error("boom"); } };
  const realError = console.error; console.error = () => {};     // 意図した例外なのでログは伏せる
  const res = await worker.fetch(new Request("https://ju-roku.com/api/me"), boom);
  console.error = realError;
  assert(res.status === 500 && (await res.json()).error === "internal_error", "ハンドラの例外は 500 に包む（got " + res.status + "）");
  const still = await worker.fetch(new Request("https://ju-roku.com/"), env);
  assert(still.status === 200, "API が落ちてもゲーム本体は配信され続ける");
  console.log("[worker] 例外の封じ込め OK");

  /* ASSETS が無い環境でも落ちない */
  const noAssets = await worker.fetch(new Request("https://ju-roku.com/"), {});
  assert(noAssets.status === 500, "ASSETS 未設定は 500 を返す（デプロイ設定の誤りに気づけるように）");

  console.log("[worker] PASS — 静的委譲・API ルーティング・例外の封じ込め");
  process.exit(0);
}
main().catch(e => fail((e && e.stack) || String(e)));
