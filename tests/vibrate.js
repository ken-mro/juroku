#!/usr/bin/env node
"use strict";
/* tests/vibrate.js — ノーツ判定時のみバイブが鳴ることの回帰テスト
 *
 * 「タップの強さ」しきい値機能はWeb標準では実際の押下力を検知できない
 * （通常のタッチパネルは機種ごとに固定のPointerEvent.pressureしか返さない）
 * ことが分かったため廃止し、バイブ設定だけを残した。本編(press())・
 * 設定画面の練習パネル(syncTap())どちらも、ノーツに実際に反応した時だけ
 * navigator.vibrate() を呼ぶ。空打ちでは鳴らない。
 */

const fs = require("fs");
const path = require("path");
const { buildEnv } = require("./lib/env.js");
const { makeFixtureArrayBuffer } = require("./lib/fixture-audio.js");

function fail(msg){
  console.error("[vibrate] FAIL: " + msg);
  process.exit(1);
}

async function main(){
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
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
  window.eval("vibrateMs = 42;");

  const vibeCalls = [];
  window.navigator.vibrate = ms => { vibeCalls.push(ms); return true; };

  // ── 1. 本編: ノーツが無いパネルを叩いてもバイブしない ─────────────────
  const emptyPanel = (note0.panel + 1) % 16;
  window.press(emptyPanel);
  if(vibeCalls.length) fail(`expected no vibration for pressing a panel with no note, got calls=${JSON.stringify(vibeCalls)}`);

  console.log("[vibrate] gameplay empty press OK (no vibration)");

  // ── 2. 本編: ノーツに反応した時だけバイブが指定長で鳴る ────────────────
  window.press(note0.panel);

  const judged = window.eval("cur.chart[0].judged");
  if(judged !== 1) fail(`expected the note to be judged, got judged=${judged}`);
  if(vibeCalls.length !== 1 || vibeCalls[0] !== 42){
    fail(`expected exactly one navigator.vibrate(42) call for the note hit, got calls=${JSON.stringify(vibeCalls)}`);
  }

  if(testErrors.length){
    fail("script error(s) captured during press():\n" + testErrors.join("\n---\n"));
  }

  console.log("[vibrate] gameplay note hit OK (judged, vibrate(42) called once)");

  // ── 3. 設定画面: 練習パネルもノーツに反応した時だけバイブする ───────────
  await window.syncStart();
  window.eval("audioCtx.currentTime = 5; syncBeeps.push({ t: 5, judged: false }); vibrateMs = 33;");
  vibeCalls.length = 0;

  const sync = window.document.getElementById("sync");
  const scv  = window.document.getElementById("scv");
  // jsdom はレイアウトを持たないので、canvas の矩形を 190×190 @ (100,100) に見立てる
  scv.getBoundingClientRect = () => ({ left: 100, top: 100, width: 190, height: 190, right: 290, bottom: 290 });
  const tapAt = (el, x, y) => el.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: x, clientY: y }));

  // パネルの外は反応しない: 画面の余白、canvas 内でもパネルの外（角の余白）
  sync.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  tapAt(scv, 105, 105);                                   // canvas 左上の余白（パネル矩形の外）
  if(window.eval("syncBeeps[0].judged")) fail("a tap outside the practice panel must not judge the beep");
  if(vibeCalls.length) fail(`a tap outside the practice panel must not vibrate, got calls=${JSON.stringify(vibeCalls)}`);
  console.log("[vibrate] settings-panel outside tap OK (screen margin / canvas margin ignored)");

  // パネルの中を叩く（中央）
  tapAt(scv, 195, 195);
  let beepJudged = window.eval("syncBeeps[0].judged");
  if(!beepJudged) fail(`expected the practice beep to be judged after the first tap, got judged=${beepJudged}`);
  if(vibeCalls.length !== 1 || vibeCalls[0] !== 33){
    fail(`expected exactly one navigator.vibrate(33) call for the practice beep hit, got calls=${JSON.stringify(vibeCalls)}`);
  }

  console.log("[vibrate] settings-panel note hit OK (judged, vibrate(33) called once)");

  vibeCalls.length = 0;
  tapAt(scv, 195, 195);
  if(vibeCalls.length){
    fail(`expected no vibration on the settings panel for a tap with no note nearby, got calls=${JSON.stringify(vibeCalls)}`);
  }

  if(testErrors.length){
    fail("script error(s) captured during settings-panel tap handling:\n" + testErrors.join("\n---\n"));
  }

  console.log("[vibrate] settings-panel empty tap OK (no note nearby -> no vibration)");
  console.log("[vibrate] PASS — vibration fires only on an actual note hit, in gameplay and the settings panel");
  process.exit(0);
}

main().catch(e => fail((e && e.stack) || String(e)));
