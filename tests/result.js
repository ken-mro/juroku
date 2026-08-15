#!/usr/bin/env node
"use strict";
/* tests/result.js — 結果画面の段階表示と結果画像（SNS 用）
 *   1. finish() 直後は #result.revealing で数字は 0 から始まり、演出終了で最終値・revealing 解除
 *   2. 演出中のタップで即座に最終状態になる
 *   3. 結果画面の記録（lastResult）とベスト記録モーダルの記録（bestShown）は同じ形・同じ値
 *   4. renderShareCanvas() は jsdom（描画スタブ）でも例外を出さず 1080×1080 の canvas を返す
 *   5. 「画像を保存」ボタンが両画面に存在し、saveShareImage に配線されている
 */
const fs = require("fs");
const path = require("path");
const { buildEnv } = require("./lib/env.js");
const { makeFixtureArrayBuffer } = require("./lib/fixture-audio.js");

const HTML = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const sleep = ms => new Promise(r => setTimeout(r, ms));
function fail(msg){ console.error("[result] FAIL: " + msg); process.exit(1); }
const assert = (c, m) => { if(!c) fail(m); };

async function playAndFinish(window, title, points){
  const ab = makeFixtureArrayBuffer("juroku-smoke-fixture-v1");
  await window.play(title, ab, null);
  window.eval(`cur.counts = [cur.chart.length, 0, 0, 0]; cur.points = ${points === "full" ? "cur.chart.length * 100" : points}; cur.score = cur.points; cur.maxCombo = cur.chart.length;`);
  window.finish();
}

async function main(){
  const { window, document, testErrors } = buildEnv(HTML);
  await sleep(80);
  if(testErrors.length) fail("script errors during load:\n" + testErrors.join("\n---\n"));
  window.eval('difficulty = "easy";');

  /* 1. reveal: starts at 0, ends final */
  await playAndFinish(window, "Reveal Song", "full");
  const R = document.getElementById("result");
  assert(R.classList.contains("on"), "#result should be shown");
  assert(R.classList.contains("revealing"), "#result should be revealing right after finish()");
  assert(document.getElementById("c0").textContent === "0" && document.getElementById("rscore").textContent === "0", "counts/score should start at 0 during the reveal");
  const notes = window.eval("cur.chart.length");
  await sleep(60);                                       // env clamps setTimeout → the fallback finalize fires
  assert(!R.classList.contains("revealing"), "revealing should end");
  assert(document.getElementById("c0").textContent === String(notes), `c0 should end at ${notes}, got ${document.getElementById("c0").textContent}`);
  assert(document.getElementById("rscore").textContent === (notes * 100).toLocaleString(), "score should end at the final value");
  assert(document.getElementById("rrank").textContent === "極", "rank text is set");
  console.log("[result] reveal OK (0 → final, revealing cleared)");

  /* 2. tap to skip */
  await playAndFinish(window, "Skip Song", "full");
  assert(R.classList.contains("revealing"), "revealing again");
  const Ev = window.PointerEvent || window.MouseEvent;
  R.dispatchEvent(new Ev("pointerdown", { bubbles: true }));
  assert(!R.classList.contains("revealing") && document.getElementById("c0").textContent === String(window.eval("cur.chart.length")), "pointerdown should finalize the reveal immediately");
  console.log("[result] tap-to-skip OK");

  /* 3. same record from result screen and best modal */
  const lr = JSON.parse(window.eval("JSON.stringify(lastResult)"));
  assert(lr && lr.title === "Skip Song" && lr.diff === "easy" && Array.isArray(lr.c) && lr.c.length === 4 && typeof lr.s === "number" && typeof lr.a === "number" && typeof lr.n === "number", "lastResult shape wrong: " + JSON.stringify(lr));
  window.eval('openBest("Skip Song", bests["Skip Song|easy"]);');
  const bs = JSON.parse(window.eval("JSON.stringify(bestShown)"));
  for(const k of ["title", "diff", "s", "a", "m", "n"]) assert(bs[k] === lr[k], `bestShown.${k} (${bs[k]}) should equal lastResult.${k} (${lr[k]})`);
  assert(JSON.stringify(bs.c) === JSON.stringify(lr.c), "counts should match");
  assert(document.getElementById("bmodal").dataset.on === "1" && document.getElementById("bmshare"), "best modal open with a 画像を保存 button");
  window.closeBest();
  console.log("[result] record parity OK (result screen == best modal)");

  /* 4. canvas rendering does not throw under the stub context */
  const w = await window.renderShareCanvas(lr).then(cv => cv.width + "x" + cv.height);
  assert(w === "1080x1080", "renderShareCanvas should return a 1080x1080 canvas, got " + w);
  const nm = window.shareFileName(lr);
  assert(/^JUROKU_Skip Song_EASY\.png$/.test(nm), "file name should include title and difficulty, got " + nm);
  const tourRec = { title: "Matsuri Overdrive", diff: "normal", s: 1, a: 100, c: [1,0,0,0], m: 1, n: 1, d: 0 };
  const w2 = await window.renderShareCanvas(tourRec).then(cv => cv.width);
  assert(w2 === 1080, "tour track record should render too");
  console.log("[result] renderShareCanvas OK (no throw, 1080x1080, tour + normal)");

  /* 5. buttons wired */
  const share = document.getElementById("share");
  assert(share && share.closest("#result .btns"), "#share should sit in the result buttons");
  share.click();
  await sleep(40);
  const msg = document.getElementById("rmsg");
  assert(!msg.hidden && msg.textContent.length > 0, "#share should report via #rmsg (jsdom has no toBlob → error message)");
  if(testErrors.length) fail("script errors:\n" + testErrors.join("\n---\n"));
  console.log("[result] buttons OK");

  console.log("[result] PASS — reveal animation, tap-to-skip, record parity, share canvas, buttons");
  process.exit(0);
}
main().catch(e => fail((e && e.stack) || String(e)));
