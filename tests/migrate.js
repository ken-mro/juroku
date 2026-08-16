#!/usr/bin/env node
"use strict";
/* tests/migrate.js — 配信元の移行（GitHub Pages → Cloudflare Pages）
 *   1. packMigration() が localStorage の juroku:* をフラグメント文字列に詰め、importMigration() で戻る
 *   2. 取り込みは既存を消さない: bests は高い方、tour は和集合、設定は無い時だけ
 *   3. redirectFromLegacyHost() は localhost では何もしない（GitHub Pages のホストでだけ働く）
 *   4. 起動時に #migrate= があれば取り込んで #note に案内が出る
 */
const fs = require("fs");
const path = require("path");
const { buildEnv } = require("./lib/env.js");
const HTML = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const sleep = ms => new Promise(r => setTimeout(r, ms));
function fail(msg){ console.error("[migrate] FAIL: " + msg); process.exit(1); }
const assert = (c, m) => { if(!c) fail(m); };

async function main(){
  /* 1 + 2: pack on an "old" device, import on a "new" one with some data */
  const old = buildEnv(HTML, { beforeParse(w){
    w.localStorage.setItem("juroku:bests", JSON.stringify({ "A|normal": { s: 100, a: 50 }, "B|normal": { s: 900, a: 90 } }));
    w.localStorage.setItem("juroku:tour", JSON.stringify({ cleared: { "id-1": { d: 1 } } }));
    w.localStorage.setItem("juroku:marker", "ka");
    w.localStorage.setItem("juroku:offset", "-15");
  }});
  await sleep(60);
  const frag = old.window.packMigration();
  assert(/^migrate=[A-Za-z0-9_-]+$/.test(frag), "packMigration should produce a URL-safe fragment, got " + frag.slice(0, 30));
  assert(old.window.redirectFromLegacyHost() === false, "redirectFromLegacyHost() must be a no-op on localhost");

  const neu = buildEnv(HTML, { beforeParse(w){
    w.localStorage.setItem("juroku:bests", JSON.stringify({ "A|normal": { s: 500, a: 70 }, "C|hard": { s: 10, a: 10 } }));
    w.localStorage.setItem("juroku:tour", JSON.stringify({ cleared: { "id-2": { d: 2 } } }));
    w.localStorage.setItem("juroku:marker", "fill");
  }});
  await sleep(60);
  const done = neu.window.importMigration("#" + frag);
  assert(done.length === 4, "expected 4 keys imported, got " + JSON.stringify(done));
  const bests = JSON.parse(neu.window.localStorage.getItem("juroku:bests"));
  assert(bests["A|normal"].s === 500 && bests["B|normal"].s === 900 && bests["C|hard"].s === 10, "bests should merge keeping the higher score: " + JSON.stringify(bests));
  const tour = JSON.parse(neu.window.localStorage.getItem("juroku:tour"));
  assert(tour.cleared["id-1"] && tour.cleared["id-2"], "tour cleared should be the union");
  assert(neu.window.localStorage.getItem("juroku:marker") === "fill", "existing settings must not be overwritten");
  assert(neu.window.localStorage.getItem("juroku:offset") === "-15", "missing settings should be imported");
  assert(neu.window.importMigration("#nothing=1").length === 0 && neu.window.importMigration("#migrate=!!!").length === 0, "garbage must be ignored");
  console.log("[migrate] pack/import OK (merge rules, garbage ignored, no redirect on localhost)");

  /* 4: boot with #migrate= → note shown, hash cleared, prefs loaded from the imported data */
  const boot = buildEnv(HTML, { beforeParse(w){
    // jsdom's URL is fixed to http://localhost/, so simulate the fragment by setting it before scripts run
    w.location.hash = frag;
  }});
  await sleep(120);
  if(boot.testErrors.length) fail("script errors on boot with #migrate:\n" + boot.testErrors.join("\n"));
  const note = boot.document.getElementById("note");
  assert(note && !note.hidden && /引き継ぎ/.test(note.textContent), "boot import should show the note");
  assert(boot.window.eval("marker") === "ka", "imported marker should be applied by loadPrefs (got " + boot.window.eval("marker") + ")");
  assert(!/migrate=/.test(boot.window.location.hash), "the fragment should be cleared after import");
  console.log("[migrate] boot import OK (note shown, hash cleared, prefs applied)");

  /* siteDisplayUrl */
  const u = boot.window.siteDisplayUrl();
  assert(u === "localhost", "siteDisplayUrl on http://localhost/ should be 'localhost', got " + u);
  console.log("[migrate] PASS");
  process.exit(0);
}
main().catch(e => fail((e && e.stack) || String(e)));
