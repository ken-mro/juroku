#!/usr/bin/env node
"use strict";
/* tests/tabs.js — タイトル画面のタブ（収録曲 / リンク・ファイル）
 * The link/file panel is only reachable by tapping its tab, so a missing
 * click handler silently hides Suno-link loading and local-file loading
 * altogether. Asserts:
 *   - 収録曲 is active on load, with aria-pressed set on both buttons
 *   - tapping リンク・ファイル shows #tab-own and hides #tab-lib
 *   - tapping 収録曲 switches back
 *   - the same holds after rebuildTabs() replaces the buttons (the
 *     collapsed-tab-bar repair path), i.e. the handler is delegated
 */

const fs = require("fs");
const path = require("path");
const { buildEnv } = require("./lib/env.js");

function fail(msg){
  console.error("[tabs] FAIL: " + msg);
  process.exit(1);
}

async function main(){
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const { window, document, testErrors } = buildEnv(html);
  await new Promise(r => setTimeout(r, 80));

  if(testErrors.length){
    fail("script error(s) captured during load:\n" + testErrors.join("\n---\n"));
  }

  const tabBtn = t => document.querySelector(`#hometabs button[data-t="${t}"]`);
  const tap = t => {
    const b = tabBtn(t);
    if(!b) fail(`no tab button for "${t}"`);
    b.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  };
  const check = (t, label) => {
    const lib = document.getElementById("tab-lib");
    const own = document.getElementById("tab-own");
    if(lib.hidden !== (t !== "lib") || own.hidden !== (t !== "own")){
      fail(`${label}: expected "${t}" visible — tab-lib.hidden=${lib.hidden}, tab-own.hidden=${own.hidden}`);
    }
    for(const x of ["lib", "own"]){
      const want = String(x === t);
      if(tabBtn(x).getAttribute("aria-pressed") !== want){
        fail(`${label}: expected ${x} aria-pressed="${want}", got "${tabBtn(x).getAttribute("aria-pressed")}"`);
      }
    }
  };

  check("lib", "on load");
  console.log("[tabs] initial state OK (収録曲 active, aria-pressed set)");

  tap("own");
  check("own", "after tapping リンク・ファイル");
  const own = document.getElementById("tab-own");
  for(const id of ["slink", "slinkgo", "drop"]){
    if(!own.querySelector("#" + id)) fail(`#${id} missing from the link/file panel`);
  }
  console.log("[tabs] リンク・ファイル opens OK (link input, 読込, file drop area reachable)");

  tap("lib");
  check("lib", "after tapping 収録曲");
  console.log("[tabs] switching back to 収録曲 OK");

  /* The collapsed-tab-bar repair rebuilds the buttons from scratch; the
     handler must survive that, which it only does if it is delegated. */
  window.eval("rebuildTabs();");
  check("lib", "after rebuildTabs()");
  tap("own");
  check("own", "after rebuildTabs() + tapping リンク・ファイル");
  console.log("[tabs] rebuildTabs() keeps the tabs clickable OK");

  if(testErrors.length){
    fail("script error(s) captured while switching tabs:\n" + testErrors.join("\n---\n"));
  }

  console.log("[tabs] PASS — both tabs switch, and survive a rebuild");
  process.exit(0);
}

main().catch(e => fail((e && e.stack) || String(e)));
