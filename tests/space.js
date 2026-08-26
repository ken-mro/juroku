#!/usr/bin/env node
"use strict";
/* tests/space.js — 隠しステージ「Pulse of the Earth: Planets」
 *   1. データ整合（TOUR_SPACE / SPACE_BODIES / タグ・曲名の非衝突）
 *   2. 解禁述語 tourSpaceUnlocked()（ベスト記録ベース。tourState では解禁されない）
 *   3. 世界地図の KSC ロケット（未解禁は出ない・解禁で出る・既存ノード数は不変）
 *   4. 宇宙の行程（prevBody 連鎖・複合ルート・tourSpaceNextSeq）
 *   5. 宇宙地図のレンダリング（星屑・太陽・ノード・レグ・チップ・EXTREME 固定 UI・↩ EARTH）
 *   6. EXTREME 強制（forceDiff が cur.diff に入り、グローバル難易度は復元される。RETRY も維持）
 *   7. finish() 連携（クリア記録・次の惑星へ・着陸で完走・収録曲タブ反映）
 *   8. 完走状態（COMPLETE 表示・ロケットは再入口として残る）
 */

const fs = require("fs");
const path = require("path");
const { buildEnv } = require("./lib/env.js");
const { makeFixtureArrayBuffer } = require("./lib/fixture-audio.js");

const HTML = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const sleep = ms => new Promise(r => setTimeout(r, ms));
function fail(msg){ console.error("[space] FAIL: " + msg); process.exit(1); }
function assert(c, msg){ if(!c) fail(msg); }

async function boot(opts){
  const env = buildEnv(HTML, opts);
  await sleep(80);
  if(env.testErrors.length) fail("script error(s) during load:\n" + env.testErrors.join("\n---\n"));
  return env;
}

/* 全ツアー曲の EXTREME ベストを seed して隠しステージを解禁する */
function unlockAll(window){
  window.eval('for(const v of TOUR_VOLS) for(const x of v.tracks) bests[x.title + "|oni"] = { s: 1, a: 50 };');
}
/* 宇宙の全曲 / 先頭 n 曲をクリア済みにする */
function clearSpace(window, n){
  window.eval(`TOUR_SPACE.tracks.slice(0, ${n == null ? "TOUR_SPACE.tracks.length" : n})
    .forEach(x => { tourState.cleared[x.id] = { d: 1, diff: "oni", acc: 90 }; });`);
}

async function main(){
  /* ── 1. data integrity ─────────────────────────────────────────────── */
  {
    const { window } = await boot();
    const sp = JSON.parse(window.eval("JSON.stringify(TOUR_SPACE)"));
    assert(sp.vol === "S" && sp.title === "Pulse of the Earth: Planets", "TOUR_SPACE header wrong");
    assert(sp.tracks.length === 10, `expected 10 hidden tracks, got ${sp.tracks.length}`);
    const order = ["earth","venus","mercury","earth","mars","jupiter","saturn","uranus","neptune","earth"];
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const others = new Set(JSON.parse(window.eval(
      "JSON.stringify(DEFAULT_TRACKS.map(t => t.title).concat(TOUR_VOLS.flatMap(v => v.tracks.map(t => t.title))))")));
    const ids = new Set();
    sp.tracks.forEach((x, i) => {
      assert(uuid.test(x.id), `#${i} id is not a UUID: ${x.id}`);
      assert(!ids.has(x.id), `duplicate id ${x.id}`); ids.add(x.id);
      assert(x.body === order[i], `#${i} body should be ${order[i]}, got ${x.body}`);
      assert(window.eval(`!!SPACE_BODIES[${JSON.stringify(x.body)}]`), `body ${x.body} missing from SPACE_BODIES`);
      assert(x.tour && x.tour.vol === "S" && x.tour.idx === i, `tour meta wrong on ${x.title}`);
      assert(x.url && x.art && x.ready && x.artist === "ken_mro", `track mapping incomplete on ${x.title}`);
      assert(x.tag && /^\S+ [A-Z]/.test(x.tag), `tag should be glyph + English name on ${x.title}, got ${x.tag}`);
      assert(!others.has(x.title), `hidden title collides with an existing title (bests are keyed by title): ${x.title}`);
    });
    assert(sp.tracks[0].kind === "launch" && sp.tracks[9].kind === "landing", "#0 must be launch, #9 landing");
    assert(JSON.stringify(sp.tracks[3].via) === '["venus"]', "水星→地球 must route via venus");
    assert(sp.tracks[9].arc === "long", "landing leg must use the long return arc");
    assert(window.eval("TOUR_SPACE.tracks[0].tag") === "🚀 LAUNCH", "launch tag");
    assert(window.eval("TOUR_SPACE.tracks[6].tag") === "♄ SATURN", "saturn tag");
    console.log("[space] data OK (10 tracks, launch→venus→mercury→earth(via venus)→…→neptune→landing)");
  }

  /* ── 2. unlock predicate ───────────────────────────────────────────── */
  {
    const { window } = await boot();
    assert(window.eval("tourSpaceUnlocked()") === false, "fresh state must be locked");
    // ツアーの初回クリア記録（別難易度）だけでは解禁されない
    window.eval('for(const v of TOUR_VOLS) for(const x of v.tracks) tourState.cleared[x.id] = { d: 1, diff: "easy", acc: 90 };');
    assert(window.eval("tourSpaceUnlocked()") === false, "tourState clears alone must not unlock");
    unlockAll(window);
    assert(window.eval("tourSpaceUnlocked()") === true, "EXTREME bests (acc 50) on every track must unlock");
    window.eval('bests[TOUR_VOLS[0].tracks[0].title + "|oni"].a = 49.99;');
    assert(window.eval("tourSpaceUnlocked()") === false, "one track below 50% must lock again");
    window.eval('bests[TOUR_VOLS[0].tracks[0].title + "|oni"].a = 50;');
    assert(window.eval("tourSpaceUnlocked()") === true, "restoring 50% must unlock again");
    console.log("[space] unlock predicate OK (bests-based, not tourState)");
  }

  /* ── 3. rocket at Kennedy Space Center ─────────────────────────────── */
  {
    const { window, document, testErrors } = await boot();
    window.openTour();
    assert(!document.querySelector("#tmap #tlaunchpad"), "locked: no rocket on the map");
    assert(document.querySelectorAll("#tmap g[data-seq]").length === 8, "earth map keeps its 8 nodes");
    unlockAll(window);
    window.openTour();
    const pad = document.querySelector("#tmap #tlaunchpad");
    assert(pad, "unlocked: rocket appears at KSC");
    assert(pad.querySelector(".tnext-ring"), "rocket has the gold pulse before completion");
    assert(pad.textContent.includes("🚀"), "pad shows the rocket emoji");
    assert(document.querySelectorAll("#tmap g[data-seq]").length === 8, "launchpad must not add data-seq nodes");
    // 出発カードは解禁だけでは出ない（完走まで入口は地図の 🚀 のみ）
    assert(!document.querySelector('#tourvols .vcard[data-vol="S"]'), "unlocked but not done: no hidden-stage depart card");
    if(testErrors.length) fail("script errors:\n" + testErrors.join("\n---\n"));
    console.log("[space] KSC rocket OK (hidden when locked, pulsing when unlocked)");
  }

  /* ── 4. space journey ──────────────────────────────────────────────── */
  {
    const { window } = await boot();
    const j = JSON.parse(window.eval("JSON.stringify(tourSpaceJourney())"));
    assert(j.length === 10, "journey length 10");
    const prevs = [null,"earth","venus","mercury","earth","mars","jupiter","saturn","uranus","neptune"];
    j.forEach((e, i) => {
      assert(e.seq === i, `seq wrong at ${i}`);
      assert(e.prevBody === prevs[i], `prevBody at ${i} should be ${prevs[i]}, got ${e.prevBody}`);
    });
    assert(window.eval("tourSpaceNextSeq()") === 0, "fresh: next is launch");
    clearSpace(window, 3);
    assert(window.eval("tourSpaceNextSeq()") === 3, "after 3 clears, next is 3");
    assert(window.eval("tourSpaceDone()") === false, "not done yet");
    clearSpace(window);
    assert(window.eval("tourSpaceNextSeq()") === 10 && window.eval("tourSpaceDone()") === true, "all cleared → done");
    // 複合ルートは 2 本、着陸は帰還アーク
    assert(window.eval("spaceLegArcs(tourSpaceJourney()[3]).length") === 2, "mercury→earth leg = 2 arcs (via venus)");
    assert(window.eval("spaceLegArcs(tourSpaceJourney()[9])[0].cy") > 200, "landing arc must bow below the system");
    console.log("[space] journey OK (prevBody chain, via venus, long return arc)");
  }

  /* ── 5. space map render + chips + UI lock ─────────────────────────── */
  {
    const { window, document, testErrors } = await boot();
    unlockAll(window);
    window.eval('difficulty = "easy"; openTour({ space: true });');
    assert(window.eval("tourMode") === "space", "openTour({space:true}) sets space mode");
    assert(document.querySelectorAll("#tmap g[data-seq]").length === 10, "10 nodes on the star map");
    assert(document.querySelectorAll("#tmap path[data-leg]").length === 10, "9 legs + 1 extra arc for the compound route");
    assert(Array.from(document.querySelectorAll("#tmap text")).some(t => t.textContent === "SUN"), "sun label");
    assert(document.querySelector("#tmap #trocket"), "rocket sprite exists (hidden)");
    assert(document.querySelector('#tmap g[data-seq="0"]').dataset.st === "next", "launch is the next node");
    // チップ: 1 ページ・10 個・ページ送りなし
    const pages = document.querySelectorAll("#tchips .tpage");
    assert(pages.length === 1 && pages[0].dataset.vol === "S", "one chip page, vol S");
    const chips = document.querySelectorAll("#tchips .chip");
    assert(chips.length === 10, "10 chips");
    assert(document.getElementById("tnav").hidden === true, "no page nav for a single page");
    assert(chips[0].querySelector(".f").textContent.includes("🚀"), "launch chip = 🚀");
    assert(chips[9].querySelector(".f .rkt-land"), "landing chip = rotated 🚀");
    assert(chips[1].querySelector(".f svg"), "planet chips use inline SVG icons");
    assert(chips[1].querySelector(".n").textContent === "VENUS", "chip #1 is VENUS");
    assert(chips[0].dataset.st === "next" && chips[1].disabled, "launch next, venus locked");
    // ヘッダー・カード・難易度固定
    assert(document.getElementById("ttitle").textContent === "Pulse of the Earth: Planets", "header title");
    assert(document.getElementById("teyebrow").textContent.includes("Hidden Stage"), "header eyebrow");
    assert(document.getElementById("tcen").textContent === "LAUNCH", "card shows LAUNCH");
    assert(document.getElementById("tdiffv").textContent === "EXTREME", "card difficulty is EXTREME regardless of global");
    for(const b of document.querySelectorAll("#tdiffsel button[data-d]")){
      assert(b.disabled, "difficulty buttons must be disabled in space mode");
      assert(b.getAttribute("aria-pressed") === String(b.dataset.d === "oni"), "only EXTREME reads pressed");
    }
    // ↩ EARTH で世界地図へ戻る（難易度 UI も復元）
    assert(document.getElementById("tearthmap").hidden === false, "↩ EARTH visible in space mode");
    document.getElementById("tearthmap").click();
    assert(window.eval("tourMode") === "earth", "↩ EARTH returns to the earth map");
    assert(document.getElementById("tearthmap").hidden === true, "↩ EARTH hides on earth");
    assert(document.querySelector("#tmap #tlaunchpad"), "earth map shows the rocket again");
    for(const b of document.querySelectorAll("#tdiffsel button[data-d]")){
      assert(!b.disabled, "difficulty buttons re-enable on earth");
      assert(b.getAttribute("aria-pressed") === String(b.dataset.d === "easy"), "pressed state restored to the global difficulty");
    }
    // 宇宙で難易度クリックは無視される
    window.eval("openTour({ space: true });");
    document.querySelector('#tdiffsel button[data-d="easy"]').click();
    assert(window.eval("difficulty") === "easy" && window.eval('localStorage.getItem("juroku:difficulty")') === null,
      "difficulty clicks in space mode must not change or save anything");
    if(testErrors.length) fail("script errors during space render:\n" + testErrors.join("\n---\n"));
    console.log("[space] star map OK (nodes, legs, chips, EXTREME lock, ↩ EARTH)");
  }

  /* ── 6+7. forced EXTREME through play()/finish(), landing completes ── */
  {
    const { window, document, testErrors } = await boot();
    const ab = makeFixtureArrayBuffer("juroku-tour-fixture-v1");
    unlockAll(window);
    window.eval('difficulty = "easy";');
    const first = JSON.parse(window.eval("JSON.stringify(TOUR_SPACE.tracks[0])"));
    window.eval(`pendingTour = { space: true, idx: 0, seq: 0, id: ${JSON.stringify(first.id)}, forceDiff: "oni" };`);
    await window.play(first.title, ab, first.url);
    assert(window.eval("cur && cur.diff") === "oni", "forceDiff must set cur.diff to oni");
    assert(window.eval("cur.tour && cur.tour.space === true && cur.tour.forceDiff") === "oni", "tour context carries space + forceDiff");
    assert(window.eval("difficulty") === "easy", "global difficulty must be restored after play()");
    // (a) 不可 → クリアされない
    window.eval("cur.points = 0;");
    window.finish();
    assert(window.eval("tourSpaceNextSeq()") === 0, "不可 must not clear the launch");
    // (b) RETRY は forceDiff ごと引き継ぐ
    document.getElementById("retry").click();
    await sleep(120);
    assert(window.eval("cur && cur.diff") === "oni" && window.eval("difficulty") === "easy", "RETRY keeps forced EXTREME");
    // (c) クリア → oni のベストと記録、ボタンは「次の惑星へ」
    window.eval("cur.points = cur.chart.length * 100;");
    window.finish();
    assert(window.eval("tourSpaceNextSeq()") === 1, "clear unlocks venus");
    assert(window.eval(`!!bests[${JSON.stringify(first.title)} + "|oni"]`), "best must be recorded under |oni");
    const saved = JSON.parse(window.localStorage.getItem("juroku:tour") || "null");
    assert(saved && saved.cleared[first.id] && saved.cleared[first.id].diff === "oni", "juroku:tour records the oni clear");
    assert(document.getElementById("tnext").hidden === false && document.getElementById("tnext").textContent === "次の惑星へ",
      "#tnext should read 次の惑星へ, got " + document.getElementById("tnext").textContent);
    // (d) 次の惑星へ → 宇宙地図に戻り、発射に朱印
    document.getElementById("tnext").click();
    assert(document.getElementById("tour").classList.contains("on") && window.eval("tourMode") === "space",
      "次の惑星へ must return to the star map");
    assert(document.querySelector('#tmap g[data-seq="0"]').dataset.st === "done", "launch node stamped");
    assert(document.querySelector('#tmap g[data-seq="0"] .tstamp-in'), "just-cleared stamp animates");
    // (e) 着陸（最後の曲）で完走 → 地図へ（完走）
    clearSpace(window, 9);
    const last = JSON.parse(window.eval("JSON.stringify(TOUR_SPACE.tracks[9])"));
    window.eval(`pendingTour = { space: true, idx: 9, seq: 9, id: ${JSON.stringify(last.id)}, forceDiff: "oni" };`);
    await window.play(last.title, ab, last.url);
    window.eval("cur.points = cur.chart.length * 100;");
    window.finish();
    assert(window.eval("tourSpaceDone()") === true, "landing completes the stage");
    assert(document.getElementById("tnext").textContent === "地図へ（完走）", "landing shows to_map_done");
    // (f) 収録曲タブ: クリア済みの宇宙曲が惑星タグ付きで出る
    const groups = Array.from(document.querySelectorAll("#ttracks .tgroup"));
    const hg = groups.find(g => /HIDDEN STAGE/.test(g.textContent));
    assert(hg && /PULSE OF THE EARTH: PLANETS/.test(hg.textContent), "hidden-stage group heading in 収録曲");
    const tags = Array.from(document.querySelectorAll("#ttracks .a")).map(x => x.textContent);
    assert(tags.some(a => a.startsWith("🚀 LAUNCH")), "launch card tagged 🚀 LAUNCH");
    assert(tags.some(a => a.startsWith("♄ SATURN")), "saturn card tagged ♄ SATURN");
    // (g) 通常プレーには漏れない
    await window.play("Plain Song", ab, null);
    assert(window.eval("cur.tour") === null && window.eval("cur.diff") === "easy", "normal play must not inherit space/forceDiff");
    if(testErrors.length) fail("script errors during finish integration:\n" + testErrors.join("\n---\n"));
    console.log("[space] forced EXTREME + finish OK (cur.diff=oni, global restored, 次の惑星へ, landing completes, library tags)");
  }

  /* ── 8. completion state ───────────────────────────────────────────── */
  {
    const { window, document, testErrors } = await boot();
    unlockAll(window);
    clearSpace(window);
    window.eval("openTour({ space: true });");
    assert(document.getElementById("tprog").textContent.includes("10 / 10") &&
           document.getElementById("tprog").textContent.includes("COMPLETE"), "header reads 10 / 10 · COMPLETE");
    assert(document.getElementById("tdone").hidden === false, "完走 badge shows");
    assert(Array.from(document.querySelectorAll("#tmap text")).some(t => t.textContent === "SYSTEM COMPLETE"),
      "SYSTEM COMPLETE caption under the sun");
    assert(document.querySelectorAll("#tmap .tstamp-in, #tmap g[data-st='done']").length >= 10, "all nodes stamped");
    document.getElementById("tearthmap").click();
    const pad = document.querySelector("#tmap #tlaunchpad");
    assert(pad && !pad.querySelector(".tnext-ring"), "after completion the rocket stays as a calm re-entry point");
    // 出発カードは完走後にだけ現れ、名称は World Tour · Universe
    window.eval("renderTourVols()");        // 実プレーでは tourOnFinish() が再描画する
    const card = document.querySelector('#tourvols .vcard[data-vol="S"]');
    assert(card, "done: hidden-stage depart card appears");
    assert(card.querySelector(".eyebrow").textContent === "World Tour · Universe", "card eyebrow reads World Tour · Universe");
    assert(card.textContent.includes("10 / 10"), "card shows full progress");
    if(testErrors.length) fail("script errors during completion:\n" + testErrors.join("\n---\n"));
    console.log("[space] completion OK (COMPLETE header, gold stars, rocket remains)");
  }

  console.log("[space] PASS — data, unlock, KSC rocket, journey, star map, forced EXTREME, finish, completion");
  process.exit(0);
}

main().catch(e => fail((e && e.stack) || String(e)));
