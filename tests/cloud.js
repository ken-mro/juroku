#!/usr/bin/env node
"use strict";
/* tests/cloud.js — クライアント側のクラウド同期（index.html）
 *
 * 最重要は「同期が使えなくてもゲームが完全に動く」こと。未ログイン・Secret 未設定・
 * 通信断のいずれでも、これまでどおり localStorage だけで遊べる状態を守る。
 */
const fs = require("fs");
const path = require("path");
const { buildEnv } = require("./lib/env.js");
const HTML = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const sleep = ms => new Promise(r => setTimeout(r, ms));
function fail(msg){ console.error("[cloud] FAIL: " + msg); process.exit(1); }
const assert = (c, m) => { if(!c) fail(m); };

/* fetch のスタブ。呼ばれた URL とメソッドを記録し、指定の応答を返す。 */
function fetchStub(routes){
  const calls = [];
  const fn = async (url, opts) => {
    const u = String(url), method = ((opts && opts.method) || "GET").toUpperCase();
    calls.push({ url: u, method, body: opts && opts.body });
    for(const r of routes){
      if(u.includes(r.path) && (!r.method || r.method === method)){
        if(r.reject) throw new Error("network down");
        return { ok: r.status ? r.status < 400 : true, status: r.status || 200,
                 json: async () => (typeof r.body === "function" ? r.body(opts) : r.body) };
      }
    }
    throw new Error("unexpected fetch: " + method + " " + u);
  };
  fn.calls = calls;
  return fn;
}
const boot = async (fetchFn, seed) => {
  const env = buildEnv(HTML, { beforeParse(w){
    if(seed) for(const [k, v] of Object.entries(seed)) w.localStorage.setItem(k, v);
    if(fetchFn) w.fetch = fetchFn;
  }});
  await sleep(120);
  return env;
};

async function main(){
  /* ── 1. 同期が使えない環境（Secret 未設定 = 503）でも普通に動く ── */
  {
    const f = fetchStub([{ path: "/api/me", status: 503, body: { error: "sync_not_configured" } }]);
    const { window, document, testErrors } = await boot(f);
    if(testErrors.length) fail("script errors with sync unavailable:\n" + testErrors.join("\n"));
    assert(f.calls.some(c => c.url.includes("/api/me")), "起動時に /api/me を 1 度だけ問い合わせる");
    assert(!f.calls.some(c => c.url.includes("/api/sync")), "同期が使えない時に /api/sync を呼んではいけない");
    assert(document.getElementById("account").hidden, "同期が使えない時はアカウント欄を出さない");
    window.savePrefs("juroku:bests", JSON.stringify({ "A|normal": { s: 1 } }));
    await sleep(30);
    assert(window.localStorage.getItem("juroku:bests"), "同期が使えなくても localStorage には保存される");
    assert(document.querySelectorAll("#tracks > *").length === window.eval("DEFAULT_TRACKS.length"), "収録曲はいつもどおり出る");
    console.log("[cloud] 同期なしでも動く OK");
  }

  /* ── 2. 通信が落ちていても壊れない ── */
  {
    const f = fetchStub([{ path: "/api/", reject: true }]);
    const { window, document, testErrors } = await boot(f);
    if(testErrors.length) fail("script errors with the network down:\n" + testErrors.join("\n"));
    assert(document.getElementById("account").hidden, "通信できない時もアカウント欄は出さない");
    window.savePrefs("juroku:bests", JSON.stringify({ "B|hard": { s: 2 } }));
    await sleep(30);
    assert(JSON.parse(window.localStorage.getItem("juroku:bests"))["B|hard"], "通信断でもローカル保存は成功する");
    console.log("[cloud] 通信断でも動く OK");
  }

  /* ── 3. 未ログインなら同期しない ── */
  {
    const f = fetchStub([{ path: "/api/me", body: { signedIn: false } }]);
    const { window, document } = await boot(f);
    assert(!f.calls.some(c => c.url.includes("/api/sync")), "未ログインで /api/sync を呼んではいけない");
    assert(!document.getElementById("account").hidden, "同期が使える環境ならアカウント欄は出す");
    assert(document.getElementById("signin"), "未ログインならログインボタンがある");
    assert(document.getElementById("signin").offsetParent !== null || !document.getElementById("signin").hidden,
      "ログインボタンが隠れていない");
    window.savePrefs("juroku:bests", JSON.stringify({ "C|easy": { s: 3 } }));
    await sleep(30);
    assert(!f.calls.some(c => c.url.includes("/api/sync")), "未ログインの保存で送信してはいけない");
    console.log("[cloud] 未ログインは送信しない OK");
  }

  /* ── 4. ログイン中は起動時に PUT し、併合結果を反映する ── */
  {
    let putBody = null;
    const merged = {
      v: 1, updatedAt: 123,
      bests: { "Local|normal": { s: 10, a: 10, n: 1, d: 1 }, "Cloud|hard": { s: 999, a: 99, n: 2, d: 2 } },
      tour: { cleared: { "cloud-track": { d: 5, diff: "normal", acc: 88 } } },
      usertracks: [{ kind: "link", url: "https://suno.com/song/cloud", title: "Cloud Song", artist: "ken_mro", art: "", id: "cloud" }],
    };
    const f = fetchStub([
      { path: "/api/me", body: { signedIn: true, email: "player@example.com" } },
      { path: "/api/sync", method: "PUT", body: opts => { putBody = JSON.parse(opts.body); return merged; } },
    ]);
    const { window, document, testErrors } = await boot(f, {
      "juroku:bests": JSON.stringify({ "Local|normal": { s: 10, a: 10, n: 1, d: 1 } }),
    });
    if(testErrors.length) fail("script errors while syncing:\n" + testErrors.join("\n"));

    assert(putBody, "ログイン中は起動時に PUT する");
    assert(putBody.bests["Local|normal"], "端末のベストを送る: " + JSON.stringify(putBody.bests));
    assert("tour" in putBody && "usertracks" in putBody, "3 種類すべてを送る: " + Object.keys(putBody).join(","));
    assert(!("juroku:offset" in putBody) && !JSON.stringify(putBody).includes("offset"), "端末固有の設定は送らない");

    /* 併合結果が端末に反映される */
    const localBests = JSON.parse(window.localStorage.getItem("juroku:bests"));
    assert(localBests["Cloud|hard"] && localBests["Local|normal"], "クラウド側の記録が端末に反映される: " + JSON.stringify(localBests));
    assert(window.eval('bests["Cloud|hard"] && bests["Cloud|hard"].s') === 999, "メモリ上の bests も更新される");
    assert(window.eval('tourIsCleared("cloud-track")') === true, "ツアーの進行も反映される");
    assert(window.eval("userTracks.length") === 1, "リンク曲も反映される");
    assert(document.getElementById("account").textContent.includes("player@example.com"), "アカウント欄にメールアドレスを出す");
    assert(document.getElementById("signout"), "ログイン中はログアウトボタンがある");
    console.log("[cloud] 起動時の同期と反映 OK");
  }

  /* ── 5. 保存はまとめて 1 回だけ送る（デバウンス） ── */
  {
    const f = fetchStub([
      { path: "/api/me", body: { signedIn: true, email: "p@example.com" } },
      { path: "/api/sync", method: "PUT", body: { v: 1, updatedAt: 1, bests: {}, tour: { cleared: {} }, usertracks: [] } },
    ]);
    const { window } = await boot(f);
    const before = f.calls.filter(c => c.url.includes("/api/sync")).length;
    window.eval("CLOUD_DEBOUNCE_MS = 5;");                     // テストでは待たない
    for(let i = 0; i < 5; i++) window.savePrefs("juroku:bests", JSON.stringify({ ["K" + i + "|normal"]: { s: i } }));
    window.savePrefs("juroku:marker", "ka");                  // 同期対象外
    await sleep(60);
    const puts = f.calls.filter(c => c.url.includes("/api/sync")).length - before;
    assert(puts === 1, `連続 5 回の保存は 1 回の送信にまとまるべき（got ${puts}）`);
    console.log("[cloud] デバウンス OK");
  }

  /* ── 6. 同期対象外のキーだけの保存では送らない ── */
  {
    const f = fetchStub([
      { path: "/api/me", body: { signedIn: true, email: "p@example.com" } },
      { path: "/api/sync", method: "PUT", body: { v: 1, updatedAt: 1, bests: {}, tour: { cleared: {} }, usertracks: [] } },
    ]);
    const { window } = await boot(f);
    const before = f.calls.filter(c => c.url.includes("/api/sync")).length;
    window.eval("CLOUD_DEBOUNCE_MS = 5;");
    window.savePrefs("juroku:marker", "ring");
    window.savePrefs("juroku:offset", "-20");
    window.savePrefs("juroku:durs", "{}");
    await sleep(60);
    assert(f.calls.filter(c => c.url.includes("/api/sync")).length === before, "端末固有の設定の保存では送信しない");
    console.log("[cloud] 対象外キーは送らない OK");
  }

  /* ── 7. 同期の失敗がゲームを止めない ── */
  {
    const f = fetchStub([
      { path: "/api/me", body: { signedIn: true, email: "p@example.com" } },
      { path: "/api/sync", method: "PUT", status: 500, body: { error: "boom" } },
    ]);
    const { window, document, testErrors } = await boot(f);
    if(testErrors.length) fail("a failing sync must not raise:\n" + testErrors.join("\n"));
    window.eval("CLOUD_DEBOUNCE_MS = 5;");
    window.savePrefs("juroku:bests", JSON.stringify({ "D|oni": { s: 4 } }));
    await sleep(60);
    assert(JSON.parse(window.localStorage.getItem("juroku:bests"))["D|oni"], "送信が 500 でもローカルには保存される");
    assert(document.querySelectorAll("#tracks > *").length === window.eval("DEFAULT_TRACKS.length"), "送信失敗後も画面は生きている");
    console.log("[cloud] 失敗してもゲームは動く OK");
  }

  console.log("[cloud] PASS — 未設定/通信断/未ログインで無害、ログイン時は併合反映、デバウンス、失敗耐性");
  process.exit(0);
}
main().catch(e => fail((e && e.stack) || String(e)));
