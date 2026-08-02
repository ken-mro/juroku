#!/usr/bin/env node
"use strict";
/* tests/smoke.js — 起動→カウントイン→判定→ポーズ→再開
 *
 * Drives the full play flow programmatically:
 *   1. play() a synthetic fixture song on "easy"
 *   2. fast-forward the fake audio clock past the count-in
 *   3. press() the first note's panel exactly on time -> assert a judged hit
 *   4. togglePause() -> assert paused
 *   5. togglePause() again (drives the 3-2-1 resume countdown) -> assert resumed
 *
 * Time is controlled deterministically via audioCtx.currentTime + a
 * manually-pumped requestAnimationFrame queue (see tests/lib/env.js) rather
 * than real wall-clock waits, except for the resume countdown's setTimeout
 * chain, which the env clamps to near-instant so it still completes async
 * without a real ~1.9s wait.
 */

const fs = require("fs");
const path = require("path");
const { buildEnv } = require("./lib/env.js");
const { makeFixtureArrayBuffer } = require("./lib/fixture-audio.js");

function fail(msg){
  console.error("[smoke] FAIL: " + msg);
  process.exit(1);
}

async function main(){
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const { window, document, pumpFrame, testErrors } = buildEnv(html);

  await new Promise(r => setTimeout(r, 80));
  if(testErrors.length){
    fail("script error(s) captured during load:\n" + testErrors.join("\n---\n"));
  }

  // ── 1. launch ──────────────────────────────────────────────────────────
  const arrayBuffer = makeFixtureArrayBuffer("juroku-smoke-fixture-v1");
  window.eval('difficulty = "easy";');
  await window.play("Test Smoke Song", arrayBuffer, null);

  if(testErrors.length){
    fail("script error(s) captured during play():\n" + testErrors.join("\n---\n"));
  }

  const gameOn = document.getElementById("game").classList.contains("on");
  if(!gameOn) fail("expected #game screen to have class \"on\" after play()");

  const chartLen = window.eval("(cur && cur.chart && cur.chart.length) || 0");
  if(!chartLen) fail("no notes generated for the smoke fixture (cur.chart.length is 0)");

  console.log(`[smoke] launch OK (#game active, ${chartLen} notes)`);

  // ── 2. count-in ────────────────────────────────────────────────────────
  const countLead = window.eval("COUNT_LEAD");
  const startAt = window.eval("cur.startAt"); // == COUNT_LEAD, audioCtx.currentTime was 0 at play()
  window.eval(`audioCtx.currentTime = ${countLead + 0.01};`);
  pumpFrame();
  pumpFrame();

  const counting = window.eval("cur.counting");
  if(counting !== false) fail(`expected cur.counting === false once songTime() >= 0, got ${counting}`);

  console.log("[smoke] count-in OK (cur.counting -> false)");

  // ── 3. judge a note ────────────────────────────────────────────────────
  const note0 = JSON.parse(window.eval("JSON.stringify(cur.chart[0])"));
  const offsetMs = window.eval("offsetMs");
  // songTime() = audioCtx.currentTime - outputLatency - cur.startAt + offsetMs/1000
  // outputLatency is 0 in the stub, so solve for currentTime such that songTime() == note0.t.
  const targetCurrentTime = note0.t + startAt - offsetMs / 1000;
  window.eval(`audioCtx.currentTime = ${targetCurrentTime};`);
  window.press(note0.panel);
  pumpFrame();

  const counts = JSON.parse(window.eval("JSON.stringify(cur.counts)"));
  const judgedNonMiss = counts[0] + counts[1] + counts[2];
  if(judgedNonMiss !== 1){
    fail(`expected exactly 1 non-逃(NOGASHI) judgment after pressing panel ${note0.panel} on time, ` +
         `got counts=${JSON.stringify(counts)}`);
  }
  const note0Judged = window.eval("cur.chart[0].judged");
  if(note0Judged !== 1) fail(`expected cur.chart[0].judged === 1, got ${note0Judged}`);
  const score = window.eval("cur.score");
  if(!(score > 0)) fail(`expected cur.score > 0 after a hit, got ${score}`);

  console.log(`[smoke] judge OK (panel ${note0.panel} hit, score=${score}, counts=${JSON.stringify(counts)})`);

  // ── 4. pause ───────────────────────────────────────────────────────────
  window.togglePause();
  const paused1 = window.eval("cur.paused");
  if(paused1 !== true) fail(`expected cur.paused === true after togglePause(), got ${paused1}`);

  console.log("[smoke] pause OK (cur.paused -> true)");

  // ── 5. resume ──────────────────────────────────────────────────────────
  // Not counting-in anymore, so togglePause() starts the 3-2-1 resume
  // countdown (setTimeout chain, clamped near-instant by the test env).
  window.togglePause();
  await new Promise(r => setTimeout(r, 150));

  const paused2 = window.eval("cur.paused");
  const over = window.eval("cur.over");
  if(paused2 !== false) fail(`expected cur.paused === false after the resume countdown, got ${paused2}`);
  if(over) fail("expected cur.over === false after resume, game ended unexpectedly");

  if(testErrors.length){
    fail("script error(s) captured during pause/resume:\n" + testErrors.join("\n---\n"));
  }

  console.log("[smoke] resume OK (cur.paused -> false, cur.over === false)");
  console.log("[smoke] PASS — launch, count-in, judge, pause, resume all OK");
  process.exit(0);
}

main().catch(e => fail((e && e.stack) || String(e)));
