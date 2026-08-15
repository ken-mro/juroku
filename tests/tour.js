#!/usr/bin/env node
"use strict";
/* tests/tour.js — ワールドツアー「地球の鼓動」
 *   1. データ整合（TOUR_VOLS / TOUR_COUNTRIES / TOUR_LAND）
 *   2. 3 つ目のタブ（ワールドツアー）と Vol カード、rebuildTabs() 後も生きる
 *   3. 進行ロジック（tourJourney / tourNextSeq / tourVisibleVols、Vol 境界の prevCC 引き継ぎ）
 *   4. openTour() で地図・チップ・出発カードが組み上がる
 *   5. finish() 連携: 可以上でクリア記録・juroku:tour 保存・結果ボタン切替・pendingTour が漏れない
 *   6. 収録曲タブにクリア済み曲だけが国旗タグ付きで出る
 *   7. tourFly() は pumpFrame で進み resolve する（180° またぎは航路が 2 本）
 *   8. tourDepart() は fetch 失敗でツアー画面に留まりエラーを出す
 *   9. juroku:tour を seed して起動すると進捗が復元される
 */

const fs = require("fs");
const path = require("path");
const { buildEnv } = require("./lib/env.js");
const { makeFixtureArrayBuffer } = require("./lib/fixture-audio.js");

const HTML = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const sleep = ms => new Promise(r => setTimeout(r, ms));
function fail(msg){ console.error("[tour] FAIL: " + msg); process.exit(1); }
function assert(c, msg){ if(!c) fail(msg); }

async function boot(opts){
  const env = buildEnv(HTML, opts);
  await sleep(80);
  if(env.testErrors.length) fail("script error(s) during load:\n" + env.testErrors.join("\n---\n"));
  return env;
}

async function main(){
  /* ── 1. data integrity ─────────────────────────────────────────────── */
  {
    const { window } = await boot();
    const vols = JSON.parse(window.eval("JSON.stringify(TOUR_VOLS)"));
    assert(vols.length >= 1 && vols[0].vol === 1, "TOUR_VOLS[0] must be Vol.1");
    const ids = new Set();
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const titles = new Set(JSON.parse(window.eval("JSON.stringify(DEFAULT_TRACKS.map(t => t.title))")));
    for(const v of vols){
      assert(v.tracks.length > 0, `Vol.${v.vol} has no tracks`);
      v.tracks.forEach((t, i) => {
        assert(uuid.test(t.id), `Vol.${v.vol} #${i+1} id is not a UUID: ${t.id}`);
        assert(!ids.has(t.id), `duplicate track id ${t.id}`); ids.add(t.id);
        assert(window.eval(`!!TOUR_COUNTRIES[${JSON.stringify(t.cc)}]`), `country ${t.cc} missing from TOUR_COUNTRIES`);
        assert(t.tour && t.tour.vol === v.vol && t.tour.idx === i, `tour meta wrong on ${t.title}`);
        assert(t.url && t.art && t.ready && t.artist === "ken_mro", `track mapping incomplete on ${t.title}`);
        assert(t.tag && /^\S+ [A-Z]/.test(t.tag), `tag should be flag + English name on ${t.title}, got ${t.tag}`);
        assert(t.ja === undefined && t.genre === undefined && t.bpm === undefined, `no ja/genre/bpm fields expected on ${t.title}`);
        assert(!titles.has(t.title), `tour title collides with an existing title (DEFAULT_TRACKS or an earlier Vol — bests are keyed by title): ${t.title}`); titles.add(t.title);
      });
    }
    assert(vols[0].tracks.length === 8, `Vol.1 should have 8 tracks, got ${vols[0].tracks.length}`);
    assert(vols[0].tracks[0].cc === "JP" && vols[0].tracks[7].cc === "US", "Vol.1 must run 日本 → … → アメリカ");
    const land = JSON.parse(window.eval("JSON.stringify(TOUR_LAND)"));
    for(const k in land) assert(land[k].length >= 3, `TOUR_LAND.${k} has < 3 points`);
    assert(window.eval('flagOf("JP")') === "🇯🇵", "flagOf(JP) should be 🇯🇵");
    console.log(`[tour] data OK (${vols.length} vol(s), ${ids.size} tracks, ${Object.keys(land).length} land polygons)`);
  }

  /* ── 2. tab + vol cards ────────────────────────────────────────────── */
  {
    const { window, document } = await boot();
    const tabBtn = t => document.querySelector(`#hometabs button[data-t="${t}"]`);
    const tap = t => tabBtn(t).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    assert(tabBtn("tour"), "no ワールドツアー tab button");
    tap("tour");
    assert(!document.getElementById("tab-tour").hidden, "#tab-tour should be visible after tapping the tab");
    assert(document.getElementById("tab-lib").hidden && document.getElementById("tab-own").hidden, "other panels should hide");
    for(const x of ["lib","own","tour"])
      assert(tabBtn(x).getAttribute("aria-pressed") === String(x === "tour"), `aria-pressed wrong on ${x}`);
    const cards = document.querySelectorAll("#tourvols .vcard");
    assert(cards.length === 1, `expected 1 vol card initially, got ${cards.length}`);
    assert(!cards[0].classList.contains("soon"), "Vol.1 card must not be 準備中");
    assert(cards[0].textContent.includes("0 / 8"), `Vol.1 card should read 0 / 8, got "${cards[0].textContent}"`);
    window.eval("rebuildTabs();");
    tap("tour");
    assert(!document.getElementById("tab-tour").hidden, "#tab-tour should survive rebuildTabs()");
    assert(document.querySelectorAll("#hometabs button").length === 3, "rebuildTabs() must rebuild 3 tabs");
    console.log("[tour] tab + vol card OK");
  }

  /* ── 3. progression logic ──────────────────────────────────────────── */
  {
    const { window } = await boot();
    const J = () => JSON.parse(window.eval("JSON.stringify(tourJourney())"));
    assert(window.tourNextSeq() === 0, "fresh state: tourNextSeq() should be 0");
    let j = J();
    assert(j.length === 8 && j[0].prevCC === null && j[1].prevCC === "JP" && j[7].prevCC === "BR", "journey shape wrong");
    window.eval(`tourState.cleared[TOUR_VOLS[0].tracks[0].id] = {d:1, diff:"normal", acc:80};`);
    assert(window.tourNextSeq() === 1, "after clearing #1, tourNextSeq() should be 1");
    window.eval(`for(const t of TOUR_VOLS[0].tracks) tourState.cleared[t.id] = {d:1, diff:"easy", acc:60};`);
    assert(window.tourNextSeq() === 8, "after clearing all, tourNextSeq() should be 8");
    assert(window.eval("tourVolDone(TOUR_VOLS[0])") === true, "Vol.1 should be done");
    // 収録済みの全 Vol を完走 → 次の番号の「準備中」プレースホルダーが現れる（Vol の数に依存しない）
    const nVols = window.eval("TOUR_VOLS.length");
    const total = window.eval("TOUR_VOLS.reduce((a, v) => a + v.tracks.length, 0)");
    const nextVol = nVols + 1;
    window.eval(`for(const v of TOUR_VOLS) for(const t of v.tracks) tourState.cleared[t.id] = {d:1, diff:"easy", acc:60};`);
    assert(window.tourNextSeq() === total, `after clearing every Vol, tourNextSeq() should be ${total}`);
    let vis = JSON.parse(window.eval("JSON.stringify(tourVisibleVols())"));
    assert(vis.length === nextVol && vis[nVols].placeholder && vis[nVols].vol === nextVol, `placeholder Vol.${nextVol} should appear after Vol.${nVols} is done`);
    // add a synthetic next Vol → journey continues from the last country of the last real Vol
    const lastCC = window.eval("TOUR_VOLS[TOUR_VOLS.length - 1].tracks.slice(-1)[0].cc");
    // 最初の国は前 Vol の最終国と経度180°をまたぐ側（西半球なら日本、東半球ならアメリカ）にして、またぎ描画を必ず通す
    const firstCC = window.eval(`TOUR_COUNTRIES[${JSON.stringify(lastCC)}].lon < 0 ? "JP" : "US"`);
    window.eval(`TOUR_VOLS.push({ vol:${nextVol}, title:"test vol", en:"tv", tracks:[
      { id:"00000000-0000-4000-8000-000000000001", title:"T2A", cc:${JSON.stringify(firstCC)}, ready:true, artist:"ken_mro", url:"x", art:"", tour:{vol:${nextVol}, idx:0, cc:${JSON.stringify(firstCC)}}, tag:"x" },
      { id:"00000000-0000-4000-8000-000000000002", title:"T2B", cc:"FR", ready:true, artist:"ken_mro", url:"y", art:"", tour:{vol:${nextVol}, idx:1, cc:"FR"}, tag:"🇫🇷 フランス" } ] });`);
    j = J();
    assert(j.length === total + 2 && j[total].prevCC === lastCC && j[total].vol === undefined && j[total].tour.vol === nextVol, `Vol.${nextVol} must continue from ${lastCC}`);
    vis = JSON.parse(window.eval("JSON.stringify(tourVisibleVols())"));
    assert(vis.length === nextVol && !vis[nVols].placeholder, `Vol.${nextVol} data should replace the placeholder`);
    assert(window.tourNextSeq() === total, `next should be Vol.${nextVol} #1 (seq ${total})`);
    // map: a leg that crosses the antimeridian (e.g. US→JP) gets a shifted second copy
    const crosses = Math.abs(window.eval(`TOUR_COUNTRIES[${JSON.stringify(lastCC)}].lon - TOUR_COUNTRIES[${JSON.stringify(firstCC)}].lon`)) > 180;
    assert(crosses, `synthetic first leg ${lastCC}→${firstCC} should cross the antimeridian`);
    window.openTour();
    const legs = window.document.querySelectorAll(`#tmap path[data-leg="${total}"]`);
    const shifted = window.document.querySelectorAll('#tmap path[transform]');
    assert(legs.length === 1 && shifted.length >= 1, `${lastCC}→${firstCC} leg should have a shifted copy (legs=${legs.length}, shifted=${shifted.length})`);
    console.log(`[tour] progression OK (sequential unlock, placeholder Vol.${nextVol}, Vol boundary prevCC=${lastCC}, antimeridian leg ${lastCC}→${firstCC})`);
  }

  /* ── 4. openTour renders map / chips / card ────────────────────────── */
  {
    const { window, document, testErrors } = await boot();
    window.openTour();
    assert(document.getElementById("tour").classList.contains("on"), "#tour should be the active screen");
    const paths = document.querySelectorAll("#tmap path");
    const dots = Array.from(paths).find(p => (p.getAttribute("d") || "").length > 5000);
    assert(dots, "expected a long dot-matrix path in #tmap");
    assert(document.querySelectorAll("#tmap g[data-seq]").length === 8, "expected 8 country nodes");
    assert(document.querySelectorAll("#tmap path[data-leg]").length === 7, "expected 7 route legs");
    assert(document.querySelector("#tmap .tnext-ring"), "next node should pulse");
    const chips = document.querySelectorAll("#tchips .chip");
    assert(chips.length === 8, `expected 8 chips, got ${chips.length}`);
    assert(!chips[0].disabled && chips[1].disabled, "only the first chip should be enabled");
    assert(chips[0].dataset.st === "next" && chips[1].dataset.st === "lock", "chip states wrong");
    assert(document.getElementById("tflag").textContent === "🇯🇵", "card flag should be 🇯🇵");
    assert(document.getElementById("tcen").textContent === "JAPAN", "card country should be JAPAN");
    assert(document.getElementById("ttrack").textContent === "Matsuri Overdrive", "card title wrong");
    assert(document.getElementById("tprog").textContent.includes("0 / 8"), "header progress wrong");
    assert(document.getElementById("ttitle").textContent === "Pulse of the Earth", "header title should be English only");
    // 国チップは中央揃えの内箱（.tinner）に入る
    assert(document.querySelector("#tchips > .tinner .chip"), "chips should live inside the centered .tinner box");
    window.eval("for(const t of TOUR_VOLS[0].tracks) tourState.cleared[t.id] = {d:1};");
    window.tourSelect(3);
    assert(document.querySelector('#tchips .chip[data-seq="3"]').getAttribute("aria-selected") === "true" && document.getElementById("tcen").textContent === "EGYPT", "tourSelect should select the chip and update the card");
    window.eval("tourState.cleared = {};"); window.openTour();
    assert(document.getElementById("tgo").textContent === "出発する", "depart button label wrong");
    // difficulty seg on the card syncs with the title one
    document.querySelector('#tdiff button[data-d="hard"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    assert(window.eval("difficulty") === "hard", "tdiff should set difficulty");
    assert(document.querySelector('#diff button[data-d="hard"]').getAttribute("aria-pressed") === "true", "#diff should follow");
    document.querySelector('#diff button[data-d="normal"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    assert(document.querySelector('#tdiff button[data-d="normal"]').getAttribute("aria-pressed") === "true", "#tdiff should follow #diff");
    document.getElementById("tback").click();
    assert(document.getElementById("title").classList.contains("on"), "戻る should return to title");
    if(testErrors.length) fail("script errors during openTour:\n" + testErrors.join("\n---\n"));
    console.log("[tour] openTour OK (map, 8 nodes, 7 legs, chips, card, difficulty sync)");
  }

  /* ── 5. finish() integration ───────────────────────────────────────── */
  {
    const { window, document, testErrors } = await boot();
    const ab = makeFixtureArrayBuffer("juroku-tour-fixture-v1");
    window.eval('difficulty = "easy";');
    const first = JSON.parse(window.eval("JSON.stringify(TOUR_VOLS[0].tracks[0])"));
    // (a) fail: 0 points → not cleared, no record
    window.eval(`pendingTour = { vol:1, idx:0, seq:0, id:${JSON.stringify(first.id)} };`);
    await window.play(first.title, ab, first.url);
    assert(window.eval("pendingTour") === null, "pendingTour must be consumed by play()");
    assert(window.eval("cur && cur.tour && cur.tour.seq") === 0, "cur.tour should carry the tour context");
    window.eval("cur.points = 0;");
    window.finish();
    assert(window.tourNextSeq() === 0, "a 不可 result must not clear the track");
    assert(document.getElementById("tnext").hidden === true, "#tnext must stay hidden on 不可");
    assert(document.getElementById("back").textContent === "MAP", "#back should read MAP in tour mode");
    // (b) retry keeps tour context
    document.getElementById("retry").click();
    await sleep(120);
    assert(window.eval("cur && cur.tour && cur.tour.seq") === 0, "RETRY should keep the tour context");
    // (c) clear: all points → recorded, saved, next unlocked
    window.eval("cur.points = cur.chart.length * 100;");
    window.finish();
    assert(window.tourNextSeq() === 1, "a 極 result must clear track #1");
    assert(document.getElementById("tnext").hidden === false && document.getElementById("tnext").textContent === "次の国へ", "#tnext should show 次の国へ");
    const saved = JSON.parse(window.localStorage.getItem("juroku:tour") || "null");
    assert(saved && saved.cleared && saved.cleared[first.id] && saved.cleared[first.id].diff === "easy", "juroku:tour must be saved with the clear");
    // (d) 次の国へ → map with CHINA as next
    document.getElementById("tnext").click();
    assert(document.getElementById("tour").classList.contains("on"), "次の国へ should open the tour screen");
    assert(document.getElementById("tcen").textContent === "CHINA", "card should now show CHINA");
    assert(document.querySelector('#tmap g[data-seq="0"]').dataset.st === "done", "日本 node should be stamped");
    assert(document.querySelector('#tmap g[data-seq="0"] .tstamp-in'), "just-cleared stamp should animate in");
    assert(document.querySelectorAll("#tchips .chip")[0].dataset.st === "done", "chip 1 should be done");
    assert(document.querySelectorAll("#tourvols .vcard").length >= 1 && document.querySelector("#tourvols .vcard").textContent.includes("1 / 8"), "vol card should read 1 / 8");
    // (e) a normal play afterwards carries no tour context; result buttons revert
    await window.play("Plain Song", ab, null);
    assert(window.eval("cur.tour") === null, "normal play must not be tagged as tour");
    window.eval("cur.points = 0;"); window.finish();
    assert(document.getElementById("back").textContent === "SELECT" && document.getElementById("tnext").hidden, "result buttons must revert for normal play");
    // (f) MAP / quit from a tour play returns to the map
    window.eval(`pendingTour = { vol:1, idx:1, seq:1, id:TOUR_VOLS[0].tracks[1].id };`);
    await window.play("Jade Dragon Parade", ab, null);
    window.quit();
    assert(document.getElementById("tour").classList.contains("on"), "quit() during a tour play should return to the map");
    if(testErrors.length) fail("script errors during finish integration:\n" + testErrors.join("\n---\n"));
    console.log("[tour] finish() integration OK (不可 keeps lock, 極 clears + saves, RETRY keeps context, 次の国へ, no leak, quit→map)");
  }

  /* ── 6. library reflection ─────────────────────────────────────────── */
  {
    const { window, document } = await boot();
    assert(document.querySelectorAll("#ttracks > *").length === 0, "#ttracks should be empty with nothing cleared");
    window.eval(`tourState.cleared[TOUR_VOLS[0].tracks[0].id] = {d:1, diff:"normal", acc:90}; renderTracks();`);
    const kids = document.querySelectorAll("#ttracks > *");
    assert(kids.length === 2, `expected heading + 1 card in #ttracks, got ${kids.length}`);
    assert(kids[0].classList.contains("tgroup") && /VOL\.1/i.test(kids[0].textContent), "heading should name Vol.1");
    const a = kids[1].querySelector(".a").textContent;
    assert(a.startsWith("🇯🇵 JAPAN") && a.includes("ken_mro"), `card .a should start with the country tag, got "${a}"`);
    assert(document.querySelectorAll("#tracks > *").length === 17, "#tracks must remain 17 cards");
    console.log("[tour] library reflection OK (cleared track appears with 🇯🇵 JAPAN tag under a Vol.1 heading)");
  }

  /* ── 7. tourFly resolves under pumpFrame ───────────────────────────── */
  {
    const { window, pumpFrame, document } = await boot();
    window.openTour();
    let done = false;
    window.tourFly("JP", "CN", 1).then(() => { done = true; });
    pumpFrame(); await sleep(8); pumpFrame(); await sleep(8); pumpFrame();
    assert(done, "tourFly(JP,CN,1) should resolve after a few pumped frames");
    const plane = document.getElementById("tplane");
    assert(plane && plane.getAttribute("visibility") === "visible" && /translate\(/.test(plane.getAttribute("transform")), "plane should be positioned");
    let done2 = false;
    window.tourFly(null, "JP", 1).then(() => { done2 = true; });
    pumpFrame(); await sleep(8); pumpFrame(); await sleep(8); pumpFrame();
    assert(done2, "takeoff-only tourFly(null,JP,1) should resolve too");
    console.log("[tour] tourFly OK");
  }

  /* ── 8. tourDepart with a rejecting fetch stays on the map ─────────── */
  {
    const { window, document, pumpFrame, testErrors } = await boot();
    window.openTour();
    const p = window.tourDepart(0);
    for(let i = 0; i < 6; i++){ pumpFrame(); await sleep(6); }
    await p;
    assert(document.getElementById("tour").classList.contains("on"), "should remain on the tour screen");
    assert(document.getElementById("terr").hidden === false, "#terr should show the download error");
    assert(window.eval("pendingTour") === null && window.eval("tourBusy") === false, "state must be reset after failure");
    assert(document.getElementById("tgo").disabled === false, "出発 must be re-enabled");
    if(testErrors.length) fail("script errors during failed depart:\n" + testErrors.join("\n---\n"));
    console.log("[tour] failed depart OK (stays on map, error shown, state reset)");
  }

  /* ── 9. persistence ────────────────────────────────────────────────── */
  {
    const seed = { cleared: {} };
    const idsHtml = HTML.match(/id:"([0-9a-f-]{36})", title:"Matsuri Overdrive"/);
    assert(idsHtml, "could not find Matsuri Overdrive id in index.html");
    seed.cleared[idsHtml[1]] = { d: 1, diff: "normal", acc: 77 };
    const { window, document } = await boot({ beforeParse(w){ w.localStorage.setItem("juroku:tour", JSON.stringify(seed)); } });
    assert(window.tourNextSeq() === 1, "seeded juroku:tour should restore progress");
    assert(document.querySelectorAll("#ttracks > *").length === 2, "restored clear should show in 収録曲");
    console.log("[tour] persistence OK");
  }

  console.log("[tour] PASS — data, tab, progression, map, finish() hook, library, flight, failure path, persistence");
  process.exit(0);
}

main().catch(e => fail((e && e.stack) || String(e)));
