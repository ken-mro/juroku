#!/usr/bin/env node
"use strict";
/* tests/chart-v2.js — 譜面アルゴリズム v2 と v1/v2 の切り替え
 *
 *   1. v2 の譜面が期待値と完全一致する（時刻+パネル。fixtures/chart-v2-known-source.txt）
 *   2. v2 は全難易度で押下不能な配置を出さない（validate().impossible === 0）
 *   3. v2 を使った後でも v1 の譜面は fixtures/chart-known-source.txt のまま（v1 は凍結）
 *   4. 打点の精度: 既知の時刻を持つ合成音で、打楽器は平均誤差 ±3ms・ばらつき 4ms 以内、
 *      ハットがキックの 15〜28ms 前に鳴るフラムでも 20ms 超のずれは 2 個以内（v1 は約半数）
 *   5. 法則性: 同じ 2 小節を 8 回繰り返す曲で、v2 は繰り返しの打点を同じ形（鏡像含む）で置く
 *   6. セレクタ: #algo と #talgo が連動し juroku:algo に保存される。既定は v1。
 *      ベスト記録は v1 = 「曲名|難易度」（従来どおり）、v2 = 「曲名|難易度|v2」に分かれる
 *
 * 期待値ファイルが無ければ作って終了する（tests/chart.js と同じ方式）。
 */
const fs = require("fs");
const path = require("path");
const { buildEnv } = require("./lib/env.js");
const { makeFixtureArrayBuffer } = require("./lib/fixture-audio.js");

const HTML = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const V2_FIXTURE = path.join(__dirname, "fixtures", "chart-v2-known-source.txt");
const V1_FIXTURE = path.join(__dirname, "fixtures", "chart-known-source.txt");
const sleep = ms => new Promise(r => setTimeout(r, ms));
function fail(msg){ console.error("[chart-v2] FAIL: " + msg); process.exit(1); }
const assert = (c, m) => { if(!c) fail(m); };

const SR = 22050;
const rng = s => () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
const kick  = t => { const f = 55 + 120 * Math.exp(-t * 40); return Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 8) * Math.min(1, t / 0.002); };
const snare = (t, r) => ((r() * 2 - 1) * 0.7 + 0.3 * Math.sin(2 * Math.PI * 190 * t)) * Math.exp(-t * 18) * Math.min(1, t / 0.001);
const hat   = (t, r) => (r() * 2 - 1) * Math.exp(-t * 60) * Math.min(1, t / 0.0005) * 0.6;
const add = (pcm, t, fn, r, len = 0.5) => { const s0 = Math.round(t * SR); for(let i = 0; i < SR * len && s0 + i < pcm.length; i++) pcm[s0 + i] += fn(i / SR, r); };

async function chartOf(window, algo, diff, label){
  window.eval(`chartAlgo = ${JSON.stringify(algo)}; difficulty = ${JSON.stringify(diff)};`);
  await window.play("Test Fixture Song", makeFixtureArrayBuffer(label), null);
  return JSON.parse(window.eval(`JSON.stringify(cur.chart.map(n => n.t.toFixed(6) + "|" + n.panel))`));
}

async function main(){
  const { window, document, testErrors } = buildEnv(HTML);
  await sleep(80);
  if(testErrors.length) fail("script errors during load:\n" + testErrors.join("\n---\n"));

  /* 6a. 既定は v1 */
  assert(window.eval("chartAlgo") === "v1", "既定のアルゴリズムは v1");
  assert(document.querySelector('#algo button[data-a="v1"]').getAttribute("aria-pressed") === "true", "#algo の v1 が押下状態");

  /* 1. v2 の期待値 */
  const v2 = await chartOf(window, "v2", "normal", "juroku-chart-fixture-v1");
  assert(v2.length > 5, "v2 の譜面が空に近い: " + v2.length);
  assert(window.eval("cur.algo") === "v2", "cur.algo が v2");
  const actual = v2.join("\n");
  if(!fs.existsSync(V2_FIXTURE)){
    fs.writeFileSync(V2_FIXTURE, actual + "\n");
    console.log(`[chart-v2] NEW FIXTURE created: ${V2_FIXTURE} (${v2.length} notes). Run again to check it.`);
    process.exit(0);
  }
  const expected = fs.readFileSync(V2_FIXTURE, "utf8").replace(/\n$/, "");
  if(actual !== expected){
    const e = expected.split("\n"), a = actual.split("\n"), diffs = [];
    for(let i = 0; i < Math.max(e.length, a.length) && diffs.length < 8; i++)
      if(e[i] !== a[i]) diffs.push(`  line ${i + 1}: expected "${e[i] ?? "<missing>"}" got "${a[i] ?? "<missing>"}"`);
    fail(`v2 の譜面が期待値と違う（${a.length} vs ${e.length} notes）\n${diffs.join("\n")}\n` +
         "意図した変更なら fixtures/chart-v2-known-source.txt を消して再生成すること。");
  }
  console.log(`[chart-v2] fixture OK (${v2.length} notes)`);

  /* 2. 全難易度で押下可能 */
  for(const d of ["easy", "normal", "hard", "oni"]){
    await chartOf(window, "v2", d, "juroku-chart-fixture-v1");
    const v = window.eval(`validate(cur.chart, DIFF[${JSON.stringify(d)}])`);
    assert(v.impossible === 0, `v2/${d}: 押下不能な配置 ${v.impossible}`);
  }
  console.log("[chart-v2] validate OK (easy/normal/hard/oni すべて押下可能)");

  /* 3. v1 は変わらない */
  const v1 = await chartOf(window, "v1", "normal", "juroku-chart-fixture-v1");
  assert(v1.join("\n") === fs.readFileSync(V1_FIXTURE, "utf8").replace(/\n$/, ""), "v2 を使った後の v1 の譜面が期待値と違う");
  assert(v1.join("\n") !== actual, "v1 と v2 が同じ譜面になっている");
  console.log("[chart-v2] v1 unchanged OK");

  /* 4. 打点の精度（合成音・既知の時刻） */
  const cfgHard = window.eval("DIFF.hard");
  const errorsOf = async (build) => {
    const pcm = new Float32Array(SR * 20), r = rng(7), truth = [];
    build(pcm, r, truth);
    const o = await window.detectOnsets(pcm, () => {});
    const secs = window.analyzeSections(o.loud, o.frames);
    const ev = window.selectEventsV2(o.peaks, secs, o.energy, o.loud, cfgHard, pcm);
    const errs = [];
    for(const e of ev){
      let b = 1e9;
      for(const x of truth) if(Math.abs(e.t - x) < Math.abs(b)) b = e.t - x;
      if(Math.abs(b) < 0.15) errs.push(b * 1000);
    }
    const m = errs.reduce((a, b) => a + b, 0) / errs.length;
    const sd = Math.sqrt(errs.reduce((a, b) => a + (b - m) ** 2, 0) / errs.length);
    return { n: errs.length, m, sd, over: errs.filter(x => Math.abs(x) > 20).length };
  };
  for(const [name, fn] of [["kick", kick], ["snare", snare], ["hat", hat]]){
    const s = await errorsOf((pcm, r, T) => { for(let t = 0.7; t < 19; t += 0.42 + r() * 0.25){ T.push(t); add(pcm, t, fn, r); } });
    assert(s.n >= 20, `${name}: 検出数が少ない ${s.n}`);
    assert(Math.abs(s.m) <= 3 && s.sd <= 4, `${name}: 誤差 平均 ${s.m.toFixed(1)}ms / ばらつき ${s.sd.toFixed(1)}ms（基準 ±3 / 4）`);
  }
  const flam = await errorsOf((pcm, r, T) => {
    for(let t = 0.7; t < 19; t += 0.5 + r() * 0.2){ add(pcm, t - (0.015 + r() * 0.013), hat, r, 0.2); add(pcm, t, kick, r); T.push(t); }
  });
  /* フラムは本当に先に鳴る音があるので正解が曖昧。v1 は 20ms 超が約半数（15/31）だった */
  assert(flam.n >= 20 && flam.over <= 2 && Math.abs(flam.m) <= 10,
         `フラム: 20ms 超のずれ ${flam.over}/${flam.n}・平均 ${flam.m.toFixed(1)}ms（基準 2 個以内・±10ms）`);
  console.log(`[chart-v2] timing OK (打楽器 ±3ms 以内・フラム 20ms 超 ${flam.over}/${flam.n})`);

  /* 5. 法則性（同じ 2 小節 × 8） */
  {
    const beat = 0.5, loop = 8 * beat, reps = 8;
    const pcm = new Float32Array(SR * (loop * reps + 2)), r = rng(5);
    const pat = ["K","h","h","h","S","h","h","K","K","h","K","h","S","h","h","S"];
    for(let k = 0; k < reps; k++) pat.forEach((c, i) => {
      const t = 0.5 + k * loop + i * beat / 2;
      add(pcm, t, c === "K" ? kick : c === "S" ? snare : (x, rr) => hat(x, rr) * 0.6, r, 0.4);
    });
    const o = await window.detectOnsets(pcm, () => {});
    const secs = window.analyzeSections(o.loud, o.frames);
    const same = ch => {
      /* 各ループの [拍位置:パネル] 列が、前のループと（4 つの変換のどれかで）一致した拍の割合 */
      const tr = (p, k) => ((k & 2 ? 3 - (p >> 2) : p >> 2) * 4) + (k & 1 ? 3 - (p & 3) : p & 3);
      const per = [];
      for(let k = 0; k < reps; k++){
        const a = 0.5 + k * loop - 0.03, m = new Map();
        for(const n of ch) if(n.t >= a && n.t < a + loop && !m.has(Math.round((n.t - a - 0.03) / (beat / 2)))) m.set(Math.round((n.t - a - 0.03) / (beat / 2)), n.panel);
        per.push(m);
      }
      let hit = 0, tot = 0;
      for(let k = 1; k < reps; k++){
        let best = 0;
        for(let q = 0; q < 4; q++){ let c = 0; for(const [i, p] of per[k]) if(per[k - 1].has(i) && per[k - 1].get(i) === tr(p, q)) c++; best = Math.max(best, c); }
        hit += best; tot += per[k].size;
      }
      return tot ? hit / tot : 0;
    };
    for(const d of ["normal", "hard", "oni"]){
      const cfg = window.eval(`DIFF.${d}`);
      const c1 = same(window.buildChart(o.peaks, secs, o.energy, o.loud, cfg, 1));
      const c2 = same(window.buildChartV2(pcm, o.peaks, secs, o.energy, o.loud, cfg, 1, d));
      assert(c2 >= 0.5 && c2 > c1 + 0.15, `${d}: 繰り返しの同形率 v2 ${(c2 * 100).toFixed(0)}%（v1 ${(c1 * 100).toFixed(0)}%）`);
      console.log(`[chart-v2] 法則性 ${d}: 繰り返しの同形率 v1 ${(c1 * 100).toFixed(0)}% → v2 ${(c2 * 100).toFixed(0)}%`);
    }
  }

  /* 6b. セレクタの連動と保存 */
  document.querySelector('#talgo button[data-a="v2"]').click();
  assert(window.eval("chartAlgo") === "v2", "#talgo で v2 にできる");
  assert(document.querySelector('#algo button[data-a="v2"]').getAttribute("aria-pressed") === "true", "#algo も v2 に揃う");
  assert(window.localStorage.getItem("juroku:algo") === "v2", "juroku:algo に保存される");
  document.querySelector('#algo button[data-a="v1"]').click();
  assert(document.querySelector('#talgo button[data-a="v1"]').getAttribute("aria-pressed") === "true", "#talgo も v1 に戻る");
  {
    const again = buildEnv(HTML, { beforeParse(w){ w.localStorage.setItem("juroku:algo", "v2"); } });
    await sleep(120);
    assert(again.window.eval("chartAlgo") === "v2", "保存済みの v2 が起動時に復元される");
  }

  /* 6c. ベスト記録のキーが分かれる */
  for(const algo of ["v1", "v2"]){
    await chartOf(window, algo, "normal", "juroku-smoke-fixture-v1");
    window.eval("cur.counts = [cur.chart.length, 0, 0, 0]; cur.points = cur.chart.length * 100; cur.score = cur.points; cur.maxCombo = cur.chart.length;");
    window.finish();
    assert(window.eval("lastResult.algo") === algo, `lastResult.algo が ${algo}`);
  }
  const keys = Object.keys(window.eval("bests"));
  assert(keys.includes("Test Fixture Song|normal"), "v1 の記録は従来のキー（曲名|難易度）: " + keys.join(", "));
  assert(keys.includes("Test Fixture Song|normal|v2"), "v2 の記録は 曲名|難易度|v2: " + keys.join(", "));
  console.log("[chart-v2] selector + best keys OK");

  assert(testErrors.length === 0, "スクリプトエラー: " + testErrors.join("\n"));
  console.log("[chart-v2] PASS — fixture, validate, v1 unchanged, timing, repetition, selector, best keys");
  process.exit(0);
}
main().catch(e => fail((e && e.stack) || String(e)));
