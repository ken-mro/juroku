#!/usr/bin/env node
"use strict";
/* tests/preview.js — 試聴の停止で「読み込みに失敗しました」が誤表示されないことを確認
 *
 * 実ブラウザでは <audio> の src に "" を設定すると error イベントが（非同期に）
 * 発火する。stopPreview() はこれを使って再生を止めているため、onerror が
 * 外されていないと「停止しただけ」で showPreviewError() が呼ばれてしまう。
 * lib/env.js の FakeAudio は error イベントを模倣しないため、ここでは
 * src="" で非同期に error を発火する専用の Audio スタブに差し替えて再現する。
 */

const fs = require("fs");
const path = require("path");
const { buildEnv } = require("./lib/env.js");

function fail(msg){
  console.error("[preview] FAIL: " + msg);
  process.exit(1);
}

class ErrorOnEmptySrcAudio {
  constructor(){
    this.preload = ""; this._src = "";
    this.onerror = null; this.onloadedmetadata = null; this.onended = null;
    this.onwaiting = null; this.onstalled = null; this.onplaying = null;
    this.oncanplay = null; this.onseeking = null; this.onseeked = null;
    this.ontimeupdate = null;
    this.currentTime = 0; this.duration = NaN;
  }
  get src(){ return this._src; }
  set src(v){
    this._src = v;
    if(v === ""){
      // real <audio> elements fire `error` asynchronously when src is cleared
      setTimeout(() => { if(this.onerror) this.onerror(new Event("error")); }, 0);
    }
  }
  play(){ if(this.onplaying) setTimeout(() => this.onplaying(), 0); return Promise.resolve(); }
  pause(){}
}

async function main(){
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const { window, document, testErrors } = buildEnv(html);

  await new Promise(r => setTimeout(r, 80));
  if(testErrors.length){
    fail("script error(s) captured during load:\n" + testErrors.join("\n---\n"));
  }

  window.Audio = ErrorOnEmptySrcAudio;

  const btn = document.querySelector(".card .prev");
  if(!btn) fail("no .card .prev button found");
  const card = btn.closest(".card");

  // 1回目のクリック: 試聴を開始
  btn.onclick({ stopPropagation(){} });
  await new Promise(r => setTimeout(r, 20));

  if(card.querySelector(".perr")){
    fail("unexpected error overlay right after starting preview");
  }

  // 2回目のクリック: 試聴を停止(togglePreview -> stopPreview -> src="")
  btn.onclick({ stopPropagation(){} });
  await new Promise(r => setTimeout(r, 20));

  if(card.querySelector(".perr")){
    fail('停止しただけで "読み込みに失敗しました" が表示された（stopPreview の onerror 解除漏れ）');
  }

  if(testErrors.length){
    fail("script error(s) captured during preview stop:\n" + testErrors.join("\n---\n"));
  }

  /* 表示時間の丸め: 59.6 秒は 1:00 であって 0:00 ではない（Market Bells At Dawn = 59.56 秒 で顕在化） */
  for(const [sec, want] of [[59.56, "1:00"], [59.4, "0:59"], [60, "1:00"], [119.7, "2:00"], [118.2, "1:58"], [1, "0:01"]]){
    const got = window.fmtDur ? window.fmtDur(sec) : window.eval(`fmtDur(${sec})`);
    if(got !== want) fail(`fmtDur(${sec}) should be "${want}", got "${got}"`);
  }
  console.log("[preview] fmtDur boundaries OK (59.56s → 1:00)");

  console.log("[preview] PASS — stopping a preview does not show the load-failure overlay");
  process.exit(0);
}

main().catch(e => fail((e && e.stack) || String(e)));
