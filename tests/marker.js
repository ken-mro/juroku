#!/usr/bin/env node
"use strict";
/* tests/marker.js — マーカー選択の既定値と永続化
 * Asserts, in the jsdom stub environment:
 *   - a first-time player (empty localStorage) gets 満 (fill) as the marker,
 *     with #markersel reflecting it via aria-pressed
 *   - a returning player's stored juroku:marker is honoured, not overwritten
 *   - the legacy "bloom" value still migrates to 火 (fuse)
 *   - all five markers (環 満 火 簾 蚊) are selectable from the settings panel,
 *     each one persisting the choice back to localStorage
 *   - paintMarker() draws every marker without throwing, across the whole
 *     approach (p = 0 .. 1)
 */

const fs = require("fs");
const path = require("path");
const { buildEnv } = require("./lib/env.js");

function fail(msg){
  console.error("[marker] FAIL: " + msg);
  process.exit(1);
}

const HTML = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

/* Boot index.html with localStorage pre-seeded the way a real browser would
 * hand it to the page, then wait for loadPrefs()'s async reads to settle. */
async function boot(seed){
  const env = buildEnv(HTML, {
    beforeParse(window){
      if(!seed) return;
      for(const [k, v] of Object.entries(seed)) window.localStorage.setItem(k, v);
    },
  });
  await new Promise(r => setTimeout(r, 80));
  if(env.testErrors.length){
    fail("script error(s) captured during load:\n" + env.testErrors.join("\n---\n"));
  }
  return env;
}

const markerOf  = w => w.eval("marker");
const pressedOf = w => Array.from(w.document.querySelectorAll("#markersel button"))
  .filter(b => b.getAttribute("aria-pressed") === "true")
  .map(b => b.dataset.m);

async function main(){
  /* ── 1. first run: no stored preference ── */
  {
    const { window } = await boot(null);
    if(markerOf(window) !== "fill"){
      fail(`expected the first-run default marker to be "fill" (満), got "${markerOf(window)}"`);
    }
    const pressed = pressedOf(window);
    if(pressed.length !== 1 || pressed[0] !== "fill"){
      fail(`expected only the 満 button to be aria-pressed on first run, got [${pressed.join(",")}]`);
    }
    if(window.localStorage.getItem("juroku:marker") !== null){
      fail("first run must not write juroku:marker before the player picks one");
    }
    console.log("[marker] first-run default OK (満 / fill, single aria-pressed, nothing written)");
  }

  /* ── 2. returning player: stored preference wins ── */
  for(const stored of ["ring", "fuse", "sweep", "ka"]){
    const { window } = await boot({ "juroku:marker": stored });
    if(markerOf(window) !== stored){
      fail(`stored marker "${stored}" was overwritten — got "${markerOf(window)}"`);
    }
    const pressed = pressedOf(window);
    if(pressed.length !== 1 || pressed[0] !== stored){
      fail(`expected only "${stored}" aria-pressed for a returning player, got [${pressed.join(",")}]`);
    }
    if(window.localStorage.getItem("juroku:marker") !== stored){
      fail(`stored juroku:marker changed on load: "${window.localStorage.getItem("juroku:marker")}"`);
    }
  }
  console.log("[marker] stored preference preserved OK (ring / fuse / sweep / ka)");

  /* ── 3. legacy value migration ── */
  {
    const { window } = await boot({ "juroku:marker": "bloom" });
    if(markerOf(window) !== "fuse"){
      fail(`expected legacy "bloom" to migrate to "fuse", got "${markerOf(window)}"`);
    }
    console.log("[marker] legacy 蕾 -> 火 migration OK");
  }

  /* ── 4. every marker selectable, and persisted ── */
  {
    const { window, document } = await boot(null);
    const buttons = Array.from(document.querySelectorAll("#markersel button"));
    const labels = buttons.map(b => b.textContent.trim()).join("");
    const keys   = buttons.map(b => b.dataset.m);
    if(labels !== "環満火簾蚊"){
      fail(`expected the five markers 環満火簾蚊 in the settings panel, got "${labels}"`);
    }
    if(keys.join(",") !== "ring,fill,fuse,sweep,ka"){
      fail(`expected marker keys ring,fill,fuse,sweep,ka — got ${keys.join(",")}`);
    }
    for(const b of buttons){
      b.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await new Promise(r => setTimeout(r, 5));
      if(markerOf(window) !== b.dataset.m){
        fail(`clicking ${b.textContent.trim()} did not select "${b.dataset.m}" (marker="${markerOf(window)}")`);
      }
      const pressed = pressedOf(window);
      if(pressed.length !== 1 || pressed[0] !== b.dataset.m){
        fail(`expected only "${b.dataset.m}" aria-pressed after click, got [${pressed.join(",")}]`);
      }
      if(window.localStorage.getItem("juroku:marker") !== b.dataset.m){
        fail(`clicking ${b.textContent.trim()} did not persist juroku:marker`);
      }
    }
    console.log("[marker] all five markers selectable and persisted OK");

    /* ── 5. every marker paints across the full approach without throwing ── */
    for(const key of keys){
      window.eval(`marker = ${JSON.stringify(key)};`);
      window.eval(`(function(){
        var c = document.createElement("canvas").getContext("2d");
        for(var i = 0; i <= 40; i++){
          paintMarker(c, 10, 10, 100, 100, i/40, function(){ c.beginPath(); });
        }
      })();`);
    }
    if(window.eval("marker") !== "ka"){
      fail("paint loop left the marker variable in an unexpected state");
    }
    console.log("[marker] paintMarker OK for all five markers over p = 0..1");
  }

  console.log("[marker] PASS — 満 is the first-run default, saved settings survive, all five markers work");
  process.exit(0);
}

main().catch(e => fail((e && e.stack) || String(e)));
