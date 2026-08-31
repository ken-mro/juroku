#!/usr/bin/env node
"use strict";
/* tests/frozen-chart.js — 凍結譜面（charts/{曲ID}.json）の読み込みとフォールバック
 *
 * mp3 → mp4 切替で生成譜面が変わったため、mp3 時代の譜面を凍結して曲 ID で
 * 引く仕組みが入った（index.html の loadFrozenChart / prepare の凍結分岐）。
 * ここで検証すること:
 *   1. 音源 URL に UUID を含む曲は charts/{id}.json を読み、その譜面をそのまま使う
 *      （時刻・パネル・難易度の選択が凍結データと完全一致）
 *   2. ファイルが無い / fetch が失敗する環境（オフライン・file://）では
 *      従来どおり解析で譜面を生成し、ゲームを止めない
 *   3. 壊れた凍結データ（パネル範囲外など）は捨てて生成へ戻る
 *   4. URL の無い曲（ローカルファイル）は fetch すら試みない
 */

const fs = require("fs");
const path = require("path");
const { buildEnv } = require("./lib/env.js");
const { makeFixtureArrayBuffer } = require("./lib/fixture-audio.js");

const ID = "029ecb48-dd9c-4fd6-b4e3-f1738c592766";
const URL_MP3 = `https://cdn1.suno.ai/${ID}.mp3`;

function fail(msg){ console.error("[frozen-chart] FAIL: " + msg); process.exit(1); }

const FROZEN = {
  v: 1, offset: 0,
  charts: {
    easy:   [[1.0, 5, "L"], [2.0, 10, "R"], [3.0, 6, "L"], [4.0, 9, "R"], [5.0, 5, "L"], [6.0, 10, "R"]],
    normal: [[0.5, 0, "L"], [1.0, 15, "R"], [1.5, 3, "R"], [2.0, 12, "L"], [2.5, 0, "L"], [3.0, 15, "R"], [3.5, 6, "L"]],
    hard:   [[0.2, 1, "L"], [0.4, 2, "R"]],
    oni:    [[0.1, 1, "L"], [0.2, 2, "R"]],
  },
};

async function boot(fetchImpl){
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const built = buildEnv(html, {
    beforeParse(window){ if(fetchImpl) window.fetch = fetchImpl; },
  });
  await new Promise(r => setTimeout(r, 80));
  if(built.testErrors.length) fail("load errors:\n" + built.testErrors.join("\n---\n"));
  return built;
}

function chartOf(window){
  return JSON.parse(window.eval(`JSON.stringify(cur.chart.map(n => n.t + "|" + n.panel + "|" + n.hand))`));
}

async function main(){
  const buf = makeFixtureArrayBuffer("juroku-frozen-chart-test");

  /* ── 1. 凍結譜面が使われる（難易度別に正しい方を選ぶ） ── */
  {
    let requested = [];
    const fetchImpl = url => {
      requested.push(String(url));
      if(String(url) === `charts/${ID}.json`)
        return Promise.resolve({ ok: true, json: () => Promise.resolve(JSON.parse(JSON.stringify(FROZEN))) });
      return Promise.reject(new Error("offline"));
    };
    for(const diff of ["easy", "normal"]){
      const { window, testErrors } = await boot(fetchImpl);
      window.eval(`difficulty = ${JSON.stringify(diff)};`);
      await window.play("Hanabi Fever", buf, URL_MP3);
      if(testErrors.length) fail(`play() errors (${diff}):\n` + testErrors.join("\n---\n"));
      const got = chartOf(window);
      const want = FROZEN.charts[diff].map(r => r[0] + "|" + r[1] + "|" + r[2]);
      if(JSON.stringify(got) !== JSON.stringify(want))
        fail(`frozen chart not used for ${diff}:\n got ${JSON.stringify(got)}\nwant ${JSON.stringify(want)}`);
    }
    if(!requested.some(u => u === `charts/${ID}.json`)) fail("charts/{id}.json was never fetched");
    console.log("[frozen-chart] ok: frozen chart used, per difficulty");
  }

  /* ── 2. fetch 不能（既定の env は常に reject）→ 生成にフォールバック ── */
  {
    const { window, testErrors } = await boot(null);
    window.eval(`difficulty = "normal";`);
    await window.play("Hanabi Fever", buf, URL_MP3);
    if(testErrors.length) fail("offline fallback errors:\n" + testErrors.join("\n---\n"));
    const n = window.eval("(cur && cur.chart && cur.chart.length) || 0");
    if(n <= 5) fail("offline fallback did not generate a chart (length " + n + ")");
    console.log("[frozen-chart] ok: offline -> generated chart (" + n + " notes)");
  }

  /* ── 3. 壊れた凍結データは捨てて生成へ ── */
  {
    const broken = { v: 1, offset: 0, charts: { normal: [[1.0, 99, "L"]] } };  // panel 99 は盤外
    const fetchImpl = url => String(url) === `charts/${ID}.json`
      ? Promise.resolve({ ok: true, json: () => Promise.resolve(broken) })
      : Promise.reject(new Error("offline"));
    const { window, testErrors } = await boot(fetchImpl);
    window.eval(`difficulty = "normal";`);
    await window.play("Hanabi Fever", buf, URL_MP3);
    if(testErrors.length) fail("broken-data fallback errors:\n" + testErrors.join("\n---\n"));
    const n = window.eval("(cur && cur.chart && cur.chart.length) || 0");
    if(n <= 5) fail("broken frozen data did not fall back to generation (length " + n + ")");
    const first = chartOf(window)[0];
    if(first === "1|99|L") fail("broken frozen data was used as-is");
    console.log("[frozen-chart] ok: broken frozen data -> generated chart");
  }

  /* ── 4. URL の無い曲は fetch を試みない ── */
  {
    let fetched = 0;   // charts/ への fetch だけ数える（同期 API 等の別 fetch は無関係）
    const fetchImpl = url => {
      if(/^charts\//.test(String(url))) fetched++;
      return Promise.reject(new Error("offline"));
    };
    const { window, testErrors } = await boot(fetchImpl);
    window.eval(`difficulty = "normal";`);
    await window.play("Local File Song", buf, null);
    if(testErrors.length) fail("local-file errors:\n" + testErrors.join("\n---\n"));
    if(fetched !== 0) fail("fetch was attempted for a song without a URL (" + fetched + " calls)");
    const n = window.eval("(cur && cur.chart && cur.chart.length) || 0");
    if(n <= 5) fail("local file did not generate a chart");
    console.log("[frozen-chart] ok: no URL -> no fetch, generated chart");
  }

  console.log("[frozen-chart] PASS");
  process.exit(0);
}

main().catch(e => fail((e && e.stack) || String(e)));
