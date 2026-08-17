#!/usr/bin/env node
"use strict";
/* tests/domtest.js — jsdom でのDOM構造・スクリプトエラーチェック
 * Loads index.html in the stub environment (no play() driven) and asserts:
 *   - no script errors / unhandled rejections during load
 *   - #tracks has exactly 17 cards (one per DEFAULT_TRACKS entry)
 *   - exactly 5 .screen elements (title, sync, load, game, result), only
 *     #title carrying class "on"
 *   - <title> mentions the game's name
 */

const fs = require("fs");
const path = require("path");
const { buildEnv } = require("./lib/env.js");

function fail(msg){
  console.error("[domtest] FAIL: " + msg);
  process.exit(1);
}

async function main(){
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const { window, document, testErrors } = buildEnv(html);

  // Let synchronous top-level script execution finish and give loadPrefs()'s
  // async storage reads (backed by jsdom localStorage, resolves as
  // microtasks/near-immediate) a tick to settle before asserting anything.
  await new Promise(r => setTimeout(r, 80));

  if(testErrors.length){
    fail("script error(s) captured during load:\n" + testErrors.join("\n---\n"));
  }

  /* 収録曲の枚数はデータ（DEFAULT_TRACKS）と一致すること。数を決め打ちしない（曲を足すたびに直さない） */
  const tracks = document.querySelectorAll("#tracks > *");
  const nTracks = window.eval("DEFAULT_TRACKS.length");
  if(tracks.length !== nTracks){
    fail(`expected ${nTracks} track cards in #tracks (= DEFAULT_TRACKS.length), got ${tracks.length}`);
  }

  const screens = Array.from(document.querySelectorAll(".screen"));
  const ids = screens.map(s => s.id).slice().sort();
  const expectedIds = ["game", "load", "result", "sync", "title", "tour"];
  if(ids.length !== expectedIds.length || ids.some((id, i) => id !== expectedIds[i])){
    fail(`expected .screen ids [${expectedIds.join(",")}], got [${ids.join(",")}]`);
  }

  const onScreens = screens.filter(s => s.classList.contains("on"));
  if(onScreens.length !== 1 || onScreens[0].id !== "title"){
    fail(`expected only #title to have class "on" by default, got: [${onScreens.map(s => s.id).join(",")}]`);
  }

  if(!document.querySelector('a[href="privacy.html"]')){
    fail("expected a link to the privacy policy (required for the published Google OAuth consent screen)");
  }

  for(const sel of ['link[rel="icon"][href="icons/icon.svg"]', 'link[rel="apple-touch-icon"]', 'link[rel="manifest"]']){
    if(!document.querySelector(sel)) fail(`expected <head> to contain ${sel}`);
  }

  const title = document.title;
  if(!title.includes("十六") && !title.includes("JŪROKU")){
    fail(`expected <title> to mention 十六 or JŪROKU, got "${title}"`);
  }

  console.log(`[domtest] PASS — no script errors, ${nTracks} tracks, 6 screens (only #title active), title="${title}"`);
  process.exit(0);
}

main().catch(e => fail((e && e.stack) || String(e)));
