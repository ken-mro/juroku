#!/usr/bin/env node
"use strict";
/* tests/chart.js — 既知の音源で譜面が変化していないかの回帰テスト
 *
 * Chart generation (detectOnsets / analyzeSections / buildChart / DIFF) is
 * frozen per CLAUDE.md: it's the result of long empirical tuning and must
 * not drift silently. This test feeds a fixed synthetic "song" through
 * play() -> prepare() -> buildChart() and compares every note's time+panel,
 * stringified, against a saved fixture — a full-equality check, not just a
 * note-count check (a count-only check would miss timing/placement drift).
 *
 * Difficulty is pinned to "normal" (DIFF.normal) for this fixture.
 */

const fs = require("fs");
const path = require("path");
const { buildEnv } = require("./lib/env.js");
const { makeFixtureArrayBuffer } = require("./lib/fixture-audio.js");

const DIFFICULTY = "normal";
const FIXTURE_PATH = path.join(__dirname, "fixtures", "chart-known-source.txt");

function fail(msg){
  console.error("[chart] FAIL: " + msg);
  process.exit(1);
}

async function main(){
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const { window, testErrors } = buildEnv(html);

  await new Promise(r => setTimeout(r, 80));
  if(testErrors.length){
    fail("script error(s) captured during load:\n" + testErrors.join("\n---\n"));
  }

  const arrayBuffer = makeFixtureArrayBuffer("juroku-chart-fixture-v1");
  window.eval(`difficulty = ${JSON.stringify(DIFFICULTY)};`);
  await window.play("Test Fixture Song", arrayBuffer, null);

  if(testErrors.length){
    fail("script error(s) captured during play():\n" + testErrors.join("\n---\n"));
  }

  const chartLen = window.eval("(cur && cur.chart && cur.chart.length) || 0");
  if(!chartLen){
    fail("play() did not produce a chart — cur.chart.length is 0/falsy. " +
         "The synthetic fixture audio may need stronger/more onsets (see tests/lib/env.js synthesizeFakeAudioBuffer).");
  }
  if(chartLen <= 5){
    fail(`chart has only ${chartLen} notes — too small to exercise real onset detection ` +
         "(a near-silent fixture could accidentally pass a self-comparison forever). Need > 5.");
  }

  const json = window.eval(
    `JSON.stringify(cur.chart.map(n => n.t.toFixed(6) + "|" + n.panel))`
  );
  const notes = JSON.parse(json);
  const actual = notes.join("\n");

  if(!fs.existsSync(FIXTURE_PATH)){
    fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
    fs.writeFileSync(FIXTURE_PATH, actual + "\n");
    console.log(`[chart] NEW FIXTURE created: ${FIXTURE_PATH} (${notes.length} notes). ` +
                "Run again to confirm this is now checked as a regression baseline.");
    process.exit(0);
    return;
  }

  const expected = fs.readFileSync(FIXTURE_PATH, "utf8").replace(/\n$/, "");
  if(actual !== expected){
    const expLines = expected.split("\n");
    const actLines = actual.split("\n");
    const max = Math.max(expLines.length, actLines.length);
    const diffs = [];
    for(let i = 0; i < max && diffs.length < 10; i++){
      if(expLines[i] !== actLines[i]){
        diffs.push(`  line ${i + 1}: expected "${expLines[i] ?? "<missing>"}" got "${actLines[i] ?? "<missing>"}"`);
      }
    }
    fail(
      `chart regression detected — ${actLines.length} notes generated vs ${expLines.length} in fixture.\n` +
      `First mismatch(es):\n${diffs.join("\n")}\n` +
      `Fixture: ${FIXTURE_PATH}\n` +
      "If this change to detectOnsets/analyzeSections/buildChart/DIFF is intentional, " +
      "delete the fixture file and rerun to re-bootstrap it — but per CLAUDE.md, that " +
      "algorithm should not change without an explicit request."
    );
  }

  console.log(`[chart] PASS — ${notes.length} notes match fixture exactly (${FIXTURE_PATH}, difficulty=${DIFFICULTY})`);
  process.exit(0);
}

main().catch(e => fail((e && e.stack) || String(e)));
