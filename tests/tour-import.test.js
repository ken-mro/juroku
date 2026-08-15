#!/usr/bin/env node
"use strict";
/* tests/tour-import.test.js — tests/tour-import.js（Vol 追加スクリプト）
 *   1. fixtures/tour-vol1.md の解析結果が index.html の TOUR_VOLS[0] と一致する
 *   2. 合成した次の Vol（最大+1）を index.html のコピーに --apply 相当で挿入でき、そのコピーが jsdom で
 *      エラー無く起動し、tourVisibleVols() / tourJourney() がその Vol を含む
 *   3. 同じ Vol の再挿入は拒否される／座標が無い国は missing として報告される
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const imp = require("./tour-import.js");
const { buildEnv } = require("./lib/env.js");

function fail(msg){ console.error("[tour-import] FAIL: " + msg); process.exit(1); }
const assert = (c, m) => { if(!c) fail(m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main(){
  const md = fs.readFileSync(path.join(__dirname, "fixtures", "tour-vol1.md"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

  /* 1. parse == index.html */
  const v = imp.parseTourMarkdown(md);
  assert(v.vol === 1 && v.tracks.length === 8, `expected Vol.1 with 8 tracks, got vol=${v.vol} n=${v.tracks.length}`);
  const env = buildEnv(html); await sleep(60);
  if(env.testErrors.length) fail("index.html script errors:\n" + env.testErrors.join("\n"));
  const inHtml = JSON.parse(env.window.eval("JSON.stringify(TOUR_VOLS[0])"));
  assert(inHtml.title === v.title, `album title differs: html="${inHtml.title}" md="${v.title}"`);
  assert(inHtml.en === undefined, "no separate ja/en album title expected");
  v.tracks.forEach((t, i) => {
    const h = inHtml.tracks[i];
    for(const k of ["id", "title", "cc"])
      assert(h[k] === t[k], `Vol.1 #${i+1} ${k} differs: html=${JSON.stringify(h[k])} md=${JSON.stringify(t[k])}`);
  });
  assert(imp.flagToCC("🇯🇵 日本") === "JP" && imp.flagToCC("🇧🇷") === "BR" && imp.flagToCC("日本") === null, "flagToCC");
  console.log("[tour-import] parse OK (fixture == index.html TOUR_VOLS[0], 8 tracks)");

  /* 2. synthetic next Vol applied to a copy boots and shows up
     （Vol 番号は index.html の最大+1、国は index.html にまだ無く tour-countries.json にはある国を選ぶ） */
  const have = imp.existingVols(html);
  const N = Math.max(...have) + 1;
  const known = imp.knownCountries(html);
  const table = JSON.parse(fs.readFileSync(path.join(__dirname, "lib", "tour-countries.json"), "utf8"));
  const newCC = Object.keys(table).find(k => /^[A-Z]{2}$/.test(k) && !known.has(k));
  assert(newCC, "tour-countries.json has no country that index.html lacks");
  const newFlag = String.fromCodePoint(...[...newCC].map(c => 0x1F1E6 + c.charCodeAt(0) - 65));
  const newJa = table[newCC].ja;
  let md2 = md.replace(/Vol\.1/g, `Vol.${N}`).replace(/Vol1/g, `Vol${N}`)
    .replace(/🇯🇵 日本/g, `${newFlag} ${newJa}`).replace(/【🇯🇵 日本】/g, `【${newFlag} ${newJa}】`);
  // give it distinct titles and song ids so they don't collide with the real Vols
  for(const t of v.tracks) md2 = md2.split(t.title).join(`T${N} ${t.title}`);
  md2 = md2.replace(/([0-9a-f]{8})-([0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g, (m, a, b) => "ffff" + a.slice(4) + "-" + b);
  const v2 = imp.parseTourMarkdown(md2);
  assert(v2.vol === N && v2.tracks[0].cc === newCC && v2.tracks[0].countryJa === newJa, `synthetic Vol.${N} parse`);
  const { add, missing } = imp.resolveCountries(v2, html);
  assert(missing.length === 0 && add.length === 1 && add[0][0] === newCC, `expected ${newCC} to be added from tour-countries.json, got add=${JSON.stringify(add.map(a=>a[0]))} missing=${missing.length}`);
  const out = imp.applyToHtml(html, v2, add);
  assert(imp.existingVols(out).join(",") === [...have, N].join(","), `applied html should list vols ${[...have, N].join(",")}`);
  assert(imp.knownCountries(out).has(newCC), `applied html should know ${newCC}`);
  const env2 = buildEnv(out); await sleep(60);
  if(env2.testErrors.length) fail("applied html script errors:\n" + env2.testErrors.join("\n"));
  const vols = JSON.parse(env2.window.eval("JSON.stringify(TOUR_VOLS.map(v => [v.vol, v.tracks.length]))"));
  assert(vols.length === N && vols[N-1][0] === N && vols[N-1][1] === 8, `applied TOUR_VOLS wrong: ${JSON.stringify(vols)}`);
  assert(env2.window.eval("tourVisibleVols().length") === 1, `Vol.${N} must stay hidden until the earlier Vols are done`);
  const before = env2.window.eval(`TOUR_VOLS.slice(0, ${N-1}).reduce((a, v) => a + v.tracks.length, 0)`);
  const lastCC = env2.window.eval(`TOUR_VOLS[${N-2}].tracks.slice(-1)[0].cc`);
  env2.window.eval(`for(const v of TOUR_VOLS.slice(0, ${N-1})) for(const t of v.tracks) tourState.cleared[t.id] = {d:1};`);
  assert(env2.window.eval("tourVisibleVols().length") === N && env2.window.eval("tourJourney().length") === before + 8, `Vol.${N} should join the journey once Vol.${N-1} is done`);
  assert(env2.window.eval(`tourJourney()[${before}].prevCC`) === lastCC && env2.window.eval(`tourJourney()[${before}].cc`) === newCC, `Vol.${N} #1 should depart from ${lastCC} to ${newCC}`);
  env2.window.openTour();
  assert(env2.document.querySelectorAll("#tmap g[data-seq]").length === before + 8, `map should show ${before + 8} nodes`);
  // CLI dry-run + apply on a temp copy
  const tmp = path.join(os.tmpdir(), "juroku-tour-import-" + process.pid + ".html");
  const tmpMd = path.join(os.tmpdir(), "juroku-tour-import-" + process.pid + ".md");
  fs.writeFileSync(tmp, html); fs.writeFileSync(tmpMd, md2);
  const { execFileSync } = require("child_process");
  const dry = execFileSync(process.execPath, [path.join(__dirname, "tour-import.js"), tmpMd, "--html", tmp], { encoding: "utf8" });
  assert(/dry-run/.test(dry) && fs.readFileSync(tmp, "utf8") === html, "dry-run must not modify the file");
  execFileSync(process.execPath, [path.join(__dirname, "tour-import.js"), tmpMd, "--apply", "--html", tmp], { encoding: "utf8" });
  assert(imp.existingVols(fs.readFileSync(tmp, "utf8")).join(",") === [...have, N].join(","), `--apply should insert Vol.${N}`);
  fs.unlinkSync(tmp); fs.unlinkSync(tmpMd);
  console.log(`[tour-import] apply OK (synthetic Vol.${N} inserted, boots, journey continues ${lastCC}→${newCC}, CLI dry-run/apply)`);

  /* 3. refusals */
  let threw = false;
  try{ imp.applyToHtml(html, v, []); }catch(e){ threw = /既に/.test(e.message); }
  assert(threw, "re-applying Vol.1 must throw");
  const md3 = md.replace(/🇯🇵 日本/g, "🇦🇶 南極").replace(/【🇯🇵 日本】/g, "【🇦🇶 南極】");
  const r3 = imp.resolveCountries(imp.parseTourMarkdown(md3), html);
  assert(r3.missing.length === 1 && r3.missing[0].cc === "AQ", "unknown country must be reported as missing");
  // a new Vol that reuses an existing title (ids differ) must be refused — bests are keyed by title
  const md4 = md2.split(`T${N} Matsuri Overdrive`).join("Matsuri Overdrive");
  const v4 = imp.parseTourMarkdown(md4);
  assert(imp.duplicateTitles(v4, html).join(",") === "Matsuri Overdrive", "duplicateTitles should flag the reused title");
  let threw4 = false;
  try{ imp.applyToHtml(html, v4, imp.resolveCountries(v4, html).add); }catch(e){ threw4 = /重複/.test(e.message); }
  assert(threw4, "applying a Vol with a duplicate title must throw");
  console.log("[tour-import] refusals OK (duplicate vol, unknown country, duplicate title)");

  console.log("[tour-import] PASS");
  process.exit(0);
}
main().catch(e => fail((e && e.stack) || String(e)));
