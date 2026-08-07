#!/usr/bin/env node
"use strict";
/* tests/tapforce.js — タップの強さしきい値とバイブ発火の回帰テスト
 *
 * jsdom には実レイアウトが無く cv.getBoundingClientRect() は常に幅0を返すため、
 * resize() は早期returnして PAD/GAP が0のままになる（既存の全テスト共通の制約）。
 * ここでは PAD/GAP をテスト用の値に直接差し替えてパネル座標を計算し、
 * navigator.vibrate をスタブして handlePointerTap() を直接駆動する。
 */

const fs = require("fs");
const path = require("path");
const { buildEnv } = require("./lib/env.js");
const { makeFixtureArrayBuffer } = require("./lib/fixture-audio.js");

function fail(msg){
  console.error("[tapforce] FAIL: " + msg);
  process.exit(1);
}

async function main(){
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const { window, testErrors } = buildEnv(html);

  await new Promise(r => setTimeout(r, 80));
  if(testErrors.length){
    fail("script error(s) captured during load:\n" + testErrors.join("\n---\n"));
  }

  const arrayBuffer = makeFixtureArrayBuffer("juroku-smoke-fixture-v1");
  window.eval('difficulty = "easy";');
  await window.play("Test Smoke Song", arrayBuffer, null);

  if(testErrors.length){
    fail("script error(s) captured during play():\n" + testErrors.join("\n---\n"));
  }

  const countLead = window.eval("COUNT_LEAD");
  const startAt = window.eval("cur.startAt");
  window.eval(`audioCtx.currentTime = ${countLead + 0.01};`);
  window.__rafQueue.splice(0, window.__rafQueue.length).forEach(cb => cb(0));

  const note0 = JSON.parse(window.eval("JSON.stringify(cur.chart[0])"));
  const offsetMs = window.eval("offsetMs");
  const targetCurrentTime = note0.t + startAt - offsetMs / 1000;
  window.eval(`audioCtx.currentTime = ${targetCurrentTime};`);

  // パネル座標が計算できるよう PAD/GAP を固定し、しきい値とバイブ長も既知の値にする
  window.eval("PAD = 100; GAP = 10; tapForce = 0.5; vibrateMs = 42;");
  const col = note0.panel % 4, row = (note0.panel / 4) | 0;
  const clientX = col * 110 + 50, clientY = row * 110 + 50;

  const vibeCalls = [];
  window.navigator.vibrate = ms => { vibeCalls.push(ms); return true; };

  // ── 1. 弱いタップ(pressure未満)は無視される ──────────────────────────
  window.handlePointerTap({ preventDefault(){}, clientX, clientY, pressure: 0.1 });

  let judged = window.eval("cur.chart[0].judged");
  if(judged) fail(`expected the note to stay unjudged after a weak tap (pressure 0.1 < tapForce 0.5), got judged=${judged}`);
  if(vibeCalls.length) fail(`expected no vibration for a weak tap, got calls=${JSON.stringify(vibeCalls)}`);

  console.log("[tapforce] weak tap OK (ignored, no vibration)");

  // ── 2. 十分な強さのタップは判定され、バイブが指定長で鳴る ──────────────
  window.handlePointerTap({ preventDefault(){}, clientX, clientY, pressure: 0.9 });

  judged = window.eval("cur.chart[0].judged");
  if(judged !== 1) fail(`expected the note to be judged after a strong tap (pressure 0.9 >= tapForce 0.5), got judged=${judged}`);
  if(vibeCalls.length !== 1 || vibeCalls[0] !== 42){
    fail(`expected exactly one navigator.vibrate(42) call for the recognized tap, got calls=${JSON.stringify(vibeCalls)}`);
  }

  if(testErrors.length){
    fail("script error(s) captured during tap handling:\n" + testErrors.join("\n---\n"));
  }

  console.log("[tapforce] strong tap OK (judged, vibrate(42) called once)");

  // ── 3. 設定画面の練習パネルも同じしきい値・バイブを適用する ─────────────
  // syncTap()は本編のhandlePointerTap()とは別配線のため、以前は#syncの
  // pointerdownがしきい値もバイブも素通りしていた。回帰させないための確認。
  await window.syncStart();
  window.eval("audioCtx.currentTime = 5; syncBeeps.push({ t: 5, judged: false }); tapForce = 0.5; vibrateMs = 33;");
  vibeCalls.length = 0;

  const sync = window.document.getElementById("sync");
  const weakEv = new window.Event("pointerdown", { bubbles: true, cancelable: true });
  weakEv.pressure = 0.1;
  sync.dispatchEvent(weakEv);

  let beepJudged = window.eval("syncBeeps[0].judged");
  if(beepJudged) fail(`expected the practice beep to stay unjudged after a weak tap on #sync, got judged=${beepJudged}`);
  if(vibeCalls.length) fail(`expected no vibration for a weak tap on the settings panel, got calls=${JSON.stringify(vibeCalls)}`);

  const strongEv = new window.Event("pointerdown", { bubbles: true, cancelable: true });
  strongEv.pressure = 0.9;
  sync.dispatchEvent(strongEv);

  beepJudged = window.eval("syncBeeps[0].judged");
  if(!beepJudged) fail(`expected the practice beep to be judged after a strong tap on #sync, got judged=${beepJudged}`);
  if(vibeCalls.length !== 1 || vibeCalls[0] !== 33){
    fail(`expected exactly one navigator.vibrate(33) call from the settings panel tap, got calls=${JSON.stringify(vibeCalls)}`);
  }

  if(testErrors.length){
    fail("script error(s) captured during settings-panel tap handling:\n" + testErrors.join("\n---\n"));
  }

  console.log("[tapforce] settings-panel tap OK (same threshold + vibration as gameplay)");
  console.log("[tapforce] PASS — tap-force threshold gates press(), recognized taps trigger vibration");
  process.exit(0);
}

main().catch(e => fail((e && e.stack) || String(e)));
