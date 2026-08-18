#!/usr/bin/env node
"use strict";
/* tests/i18n.js — 言語（日本語 / English）
 *   1. 英語ブラウザ（navigator.language=en-US）で開くと英語で表示され、<html lang> も en になる
 *   2. 日本語ブラウザでは日本語のまま
 *   3. 設定画面の切替で表示が変わり、juroku:lang に保存される。保存値は次回起動時に優先される
 *   4. 判定名・段位・マーカー名は漢字を残し、英語表示ではローマ字を添える（kj）
 *   5. 辞書の ja / en でキーが揃っている（片方だけにあるキーが無い）
 */
const fs = require("fs");
const path = require("path");
const { buildEnv } = require("./lib/env.js");
const { makeFixtureArrayBuffer } = require("./lib/fixture-audio.js");
const HTML = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const sleep = ms => new Promise(r => setTimeout(r, ms));
function fail(msg){ console.error("[i18n] FAIL: " + msg); process.exit(1); }
const assert = (c, m) => { if(!c) fail(m); };
const setLangOf = (w, l) => {
  Object.defineProperty(w.navigator, "language", { value: l, configurable: true });
  Object.defineProperty(w.navigator, "languages", { value: [l], configurable: true });
};

async function main(){
  /* 5. 辞書のキーが揃っている */
  {
    const { window } = buildEnv(HTML); await sleep(60);
    const ja = window.eval("Object.keys(I18N.ja)"), en = window.eval("Object.keys(I18N.en)");
    const onlyJa = ja.filter(k => !en.includes(k)), onlyEn = en.filter(k => !ja.includes(k));
    assert(!onlyJa.length && !onlyEn.length, `辞書のキーが揃っていない: ja のみ ${JSON.stringify(onlyJa)} / en のみ ${JSON.stringify(onlyEn)}`);
    for(const k of ja) assert(typeof window.eval(`I18N.en[${JSON.stringify(k)}]`) === "string" && window.eval(`I18N.en[${JSON.stringify(k)}]`).length, `en の "${k}" が空`);
    console.log(`[i18n] 辞書 OK (${ja.length} keys, ja/en 一致)`);
  }

  /* 1. 英語ブラウザ → 英語表示 */
  {
    const { window, document, testErrors } = buildEnv(HTML, { beforeParse(w){ setLangOf(w, "en-US"); } });
    await sleep(120);
    if(testErrors.length) fail("script errors in en:\n" + testErrors.join("\n"));
    assert(window.eval("lang") === "en", "英語ブラウザでは lang が en");
    assert(document.documentElement.lang === "en", "<html lang> が en になる");
    assert(document.getElementById("syncbtn").textContent === "Settings", "設定ボタンが Settings");
    assert(document.querySelector('#hometabs button[data-t="lib"]').textContent === "Library", "収録曲タブが Library");
    assert(document.querySelector('#hometabs button[data-t="tour"]').textContent === "World Tour", "ワールドツアータブが World Tour");
    assert(document.getElementById("slink").placeholder === "Paste a Suno song link", "placeholder も英語");
    assert(document.getElementById("plink").getAttribute("href") === "privacy-en.html", "プライバシーポリシーは英語版へ");
    assert(document.getElementById("tlink").getAttribute("href") === "terms-en.html" && document.getElementById("tlink").textContent === "Terms of Use", "利用規約も英語版へ");
    assert(/right to use the linked track/.test(document.querySelector(".linknote").textContent), "リンク欄の注意書きも英語");
    /* 判定名・段位・マーカー名は漢字＋ローマ字 */
    assert(document.querySelector('#markersel button[data-m="fill"]').textContent === "満 MITSU", "マーカー名は漢字にローマ字を添える: " + document.querySelector('#markersel button[data-m="fill"]').textContent);
    assert(window.eval('kj("極")') === "極 KIWAMI" && window.eval('kj("不可")') === "不可 FUKA", "段位も漢字＋ローマ字");
    /* 収録曲カードの試聴ボタン・プレイ表示 */
    const prev = document.querySelector("#tracks .card .prev");
    assert(prev && prev.textContent.includes("Preview"), "試聴ボタンが Preview: " + (prev && prev.textContent));
    assert(document.querySelector("#tracks .card .go").textContent === "PLAY ▸", "プレイ表示が PLAY ▸");
    /* ツアー画面 */
    window.openTour();
    assert(document.getElementById("tgo").textContent === "Depart", "出発ボタンが Depart");
    assert(document.getElementById("tback").textContent === "Back", "戻るが Back");
    /* 結果画面: 段位の漢字はそのまま、読みが添えられる */
    window.eval('difficulty = "easy";');
    await window.play("English Song", makeFixtureArrayBuffer("juroku-smoke-fixture-v1"), null);
    window.eval("cur.points = cur.chart.length * 100; cur.score = cur.points;");
    window.finish();
    assert(document.getElementById("rrank").textContent === "極", "結果の段位は漢字のまま");
    assert(document.getElementById("rdiff").textContent.startsWith("KIWAMI · "), "英語では段位の読みを添える: " + document.getElementById("rdiff").textContent);
    console.log("[i18n] 英語ブラウザで英語表示 OK");
  }

  /* 2. 日本語ブラウザ → 日本語 */
  {
    const { window, document } = buildEnv(HTML); await sleep(120);   // env.js が ja-JP に固定
    assert(window.eval("lang") === "ja" && document.documentElement.lang === "ja", "日本語ブラウザでは ja");
    assert(document.getElementById("syncbtn").textContent === "設定", "設定ボタンは 設定 のまま");
    assert(document.querySelector('#markersel button[data-m="fill"]').textContent === "満", "日本語ではローマ字を添えない");
    console.log("[i18n] 日本語ブラウザで日本語 OK");
  }

  /* 3. 切替と保存 */
  {
    const { window, document } = buildEnv(HTML); await sleep(120);
    document.querySelector('#langsel button[data-l="en"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await sleep(30);
    assert(window.eval("lang") === "en", "設定画面の切替で en になる");
    assert(document.getElementById("syncbtn").textContent === "Settings", "切替直後に静的文言が英語になる");
    assert(document.querySelector('#langsel button[data-l="en"]').getAttribute("aria-pressed") === "true", "言語セレクタの選択状態");
    assert(window.localStorage.getItem("juroku:lang") === "en", "juroku:lang に保存される");
    /* 動的に組み立てる画面も英語に */
    assert(document.querySelector("#tracks .card .go").textContent === "PLAY ▸", "収録曲カードも描き直される");
    /* 保存値は次回起動でブラウザ言語より優先される（日本語ブラウザでも en） */
    const again = buildEnv(HTML, { beforeParse(w){ w.localStorage.setItem("juroku:lang", "en"); } }); await sleep(120);
    assert(again.window.eval("lang") === "en" && again.document.getElementById("syncbtn").textContent === "Settings", "保存した言語で起動する");
    const back = buildEnv(HTML, { beforeParse(w){ setLangOf(w, "en-US"); w.localStorage.setItem("juroku:lang", "ja"); } }); await sleep(120);
    assert(back.window.eval("lang") === "ja", "英語ブラウザでも保存が ja なら日本語");
    console.log("[i18n] 切替と保存 OK");
  }

  console.log("[i18n] PASS — 辞書の整合・自動判定・切替と保存・漢字＋ローマ字");
  process.exit(0);
}
main().catch(e => fail((e && e.stack) || String(e)));
