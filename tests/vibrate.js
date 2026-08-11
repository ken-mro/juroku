#!/usr/bin/env node
"use strict";
/* tests/vibrate.js — ノーツ判定時のみバイブが鳴ることの回帰テスト
 *
 * 「タップの強さ」しきい値機能はWeb標準では実際の押下力を検知できない
 * （PointerEvent.pressure・Touch.force・Touch.radiusX/Yのいずれも実機では
 * 固定値しか返さないことを確認した）ため廃止し、バイブ設定だけを残した。
 * 本編(press())・設定画面の練習パネル(syncTap())どちらも、ノーツに実際に
 * 反応した時だけ navigator.vibrate() を呼ぶ。空打ちでは鳴らない。
 * 練習パネルは#scv(キャンバス)だけが判定対象で、#sync全体(スライダーや
 * 余白を含む設定画面すべて)へのタップは無視する。
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

  // ── 3. 設定画面: 練習パネル(#scv)以外へのタップは判定を消費しない ────────
  await window.syncStart();
  window.eval("audioCtx.currentTime = 5; syncBeeps.push({ t: 5, judged: false }); vibrateMs = 33;");
  vibeCalls.length = 0;

  const sync = window.document.getElementById("sync");
  const scv = window.document.getElementById("scv");

  // #sync全体(スライダーや余白を含む)へのタップは無反応であるべき
  sync.dispatchEvent(new window.Event("pointerdown", { bubbles: true, cancelable: true }));
  let beepJudged = window.eval("syncBeeps[0].judged");
  if(beepJudged) fail(`expected a tap outside #scv to leave the practice beep unjudged, got judged=${beepJudged}`);
  if(vibeCalls.length) fail(`expected no vibration for a tap outside #scv, got calls=${JSON.stringify(vibeCalls)}`);

  console.log("[vibrate] settings-panel tap outside #scv OK (ignored)");

  // ── 4. 設定画面: 練習パネル(#scv)はノーツに反応した時だけバイブする ────
  scv.dispatchEvent(new window.Event("pointerdown", { bubbles: true, cancelable: true }));
  beepJudged = window.eval("syncBeeps[0].judged");
  if(!beepJudged) fail(`expected the practice beep to be judged after tapping #scv, got judged=${beepJudged}`);
  if(vibeCalls.length !== 1 || vibeCalls[0] !== 33){
    fail(`expected exactly one navigator.vibrate(33) call for the practice beep hit, got calls=${JSON.stringify(vibeCalls)}`);
  }

  console.log("[vibrate] settings-panel note hit OK (judged, vibrate(33) called once)");

  vibeCalls.length = 0;
  scv.dispatchEvent(new window.Event("pointerdown", { bubbles: true, cancelable: true }));
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
