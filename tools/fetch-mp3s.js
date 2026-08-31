#!/usr/bin/env node
"use strict";
/* tools/fetch-mp3s.js — suno.com に作者としてログインして全収録曲の mp3 を回収する
 *
 * 背景: cdn1.suno.ai の素の .mp3 は署名付き URL 必須化（403 MissingKey）で
 * 匿名では取得できなくなった。ただし作者としてログインしたブラウザなら
 * 自分の曲の署名付き mp3 URL が手に入る。凍結譜面（tools/freeze-chart.js）の
 * 材料集めに、これをローカルの実ブラウザで自動化する。
 *
 * 使い方（自分の PC で実行する。サーバーでは動かない）:
 *   npx playwright install chromium     # 初回のみ
 *   node tools/fetch-mp3s.js <保存先ディレクトリ>
 *
 * 1. ブラウザが開くので suno.com にログインする（ツールは資格情報に触れない）
 * 2. ターミナルで Enter を押すと、index.html の全曲 ID を順に処理し
 *    <保存先>/{曲ID}.mp3 として保存する
 * 3. 終わったら: node tools/freeze-chart.js --all <保存先ディレクトリ>
 *
 * 取得は 2 段構え:
 *   a. 曲ページ（suno.com/song/{id}）の HTML/埋め込み JSON から署名付き
 *      audio_url（.mp3）を抽出し、ログイン済みの文脈でダウンロード
 *   b. 見つからなければ再生ボタンを押し、流れる audio/mpeg 応答を横取り
 * どちらも content-type / 先頭バイトが mp3 であることを確認する
 * （AAC が来た場合は保存しない — AAC から凍結すると mp3 時代の譜面に
 * ならないため）。失敗した曲は最後に一覧で出すので、その曲だけ
 * suno.com の Download → MP3 Audio で手動保存し、{曲ID}.mp3 に改名する。
 *
 * 注意: suno.com の内部構造は予告なく変わる。このツールは自分の曲を
 * 自分のアカウントで取得するためのもの。
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");

const PUB = path.join(__dirname, "..", "public");
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

function fail(msg){ console.error("[fetch-mp3s] " + msg); process.exit(1); }

function looksLikeMp3(buf){
  if(buf.length < 4) return false;
  if(buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true;          // "ID3"
  return buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0;                             // MPEG frame sync
}

function trackList(){
  const html = fs.readFileSync(path.join(PUB, "index.html"), "utf8");
  const seen = new Set(), out = [];
  const re = /id:"([0-9a-f-]{36})",\s*title:"((?:[^"\\]|\\.)*)"/g;
  let m;
  while((m = re.exec(html))){
    if(seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ id: m[1], title: m[2] });
  }
  return out;
}

async function main(){
  const outDir = process.argv[2];
  if(!outDir) fail("usage: node tools/fetch-mp3s.js <保存先ディレクトリ>");
  fs.mkdirSync(outDir, { recursive: true });

  let chromium;
  try{ ({ chromium } = require("playwright")); }
  catch(e){ fail("playwright が必要です: npm i playwright && npx playwright install chromium"); }

  const tracks = trackList();
  const todo = tracks.filter(t => !fs.existsSync(path.join(outDir, t.id + ".mp3")));
  console.log(`[fetch-mp3s] 全 ${tracks.length} 曲、未取得 ${todo.length} 曲`);
  if(!todo.length){ console.log("[fetch-mp3s] すべて取得済み"); return; }

  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("https://suno.com/me", { waitUntil: "domcontentloaded" }).catch(()=>{});

  console.log("\nブラウザで suno.com にログインしてから、ここで Enter を押してください。");
  await new Promise(r => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("", () => { rl.close(); r(); });
  });

  const failed = [];
  for(const [i, tr] of todo.entries()){
    const dest = path.join(outDir, tr.id + ".mp3");
    process.stdout.write(`[${i+1}/${todo.length}] ${tr.title} … `);
    try{
      const p = await ctx.newPage();
      let sniffed = null;
      p.on("response", async res => {
        try{
          const ct = (res.headers()["content-type"] || "").toLowerCase();
          if(sniffed || !/audio\/mpeg|audio\/mp3/.test(ct)) return;
          const body = await res.body();
          if(body.length > 200000 && looksLikeMp3(body)) sniffed = body;
        }catch(e){}
      });
      await p.goto("https://suno.com/song/" + tr.id, { waitUntil: "domcontentloaded" });
      await p.waitForTimeout(2500);

      /* a. ページに埋め込まれた署名付き .mp3 URL を探す */
      let saved = false;
      const urls = await p.evaluate(() => {
        const text = document.documentElement.innerHTML;
        const found = new Set();
        for(const m of text.matchAll(/https:\\?\/\\?\/[^"'\\ ]+?\.mp3[^"'\\ ]*/g))
          found.add(m[0].replace(/\\\//g, "/").replace(/\\u0026/g, "&"));
        return [...found];
      });
      for(const u of urls){
        try{
          const res = await ctx.request.get(u);
          if(!res.ok()) continue;
          const body = await res.body();
          if(body.length > 200000 && looksLikeMp3(body)){
            fs.writeFileSync(dest, body);
            console.log(`OK 埋め込みURL (${(body.length/1e6).toFixed(1)}MB)`);
            saved = true; break;
          }
        }catch(e){}
      }

      /* b. 再生して audio/mpeg 応答を横取り */
      if(!saved){
        const play = p.locator('[aria-label*="Play" i], [data-testid*="play" i], button:has-text("Play")').first();
        await play.click({ timeout: 4000 }).catch(()=>{});
        for(let w = 0; w < 20 && !sniffed; w++) await p.waitForTimeout(500);
        if(sniffed){
          fs.writeFileSync(dest, sniffed);
          console.log(`OK 再生横取り (${(sniffed.length/1e6).toFixed(1)}MB)`);
          saved = true;
        }
      }

      if(!saved){ console.log("失敗"); failed.push(tr); }
      await p.close();
    }catch(e){
      console.log("失敗: " + (e.message || e));
      failed.push(tr);
    }
  }

  await browser.close();
  if(failed.length){
    console.log(`\n[fetch-mp3s] 取得できなかった曲 (${failed.length}):`);
    for(const tr of failed) console.log(`  ${tr.id}  ${tr.title}`);
    console.log("suno.com で該当曲を Download → MP3 Audio し、{曲ID}.mp3 に改名して保存先に置いてください。");
  }else{
    console.log("\n[fetch-mp3s] 全曲取得完了。次: node tools/freeze-chart.js --all " + outDir);
  }
}

main().catch(e => fail(e.stack || String(e)));
