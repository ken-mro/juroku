#!/usr/bin/env node
"use strict";
/* tools/freeze-chart.js — mp3 から凍結譜面 public/charts/{曲ID}.json を作る
 *
 * 背景: Suno CDN の .mp3 が取得不能になり、音源を同曲の .mp4（AAC）に切り替えた
 * （コミット e38dc81）。譜面はデコード後の PCM から決定的に生成されるため、
 * コーデックが変わると波形の微差でシードもオンセットも変わり、譜面が別物になる
 * （Hanabi Fever の実測: 229 ノーツ中、時刻・パネルとも一致は 2 個だけ）。
 *
 * 対策: mp3 時代の譜面を全難易度ぶん事前計算して JSON に凍結し、クライアントは
 * 曲 ID で引いて解析をスキップする（public/index.html の loadFrozenChart）。
 * mp3 と mp4 のデコード波形は同一タイムライン（実測オフセット 0ms）なので、
 * mp3 由来の譜面は mp4 再生にそのまま合う。
 *
 * 生成はプレイヤーと同じ経路で行う: 実際の Chromium で index.html を開き、
 * 本物の decodeAudioData → prepare() を難易度ごとに呼ぶ。Node 側に解析コードを
 * 複製しない（複製はいずれ乖離する）。
 *
 * 使い方:
 *   node tools/freeze-chart.js <曲ID> <mp3ファイル> [出力.json]   # 1 曲
 *   node tools/freeze-chart.js --all <ディレクトリ>               # 一括
 * 例:
 *   node tools/freeze-chart.js 029ecb48-dd9c-4fd6-b4e3-f1738c592766 ~/Music/hanabi.mp3
 *   node tools/freeze-chart.js --all ~/Music/juroku-mp3s
 *
 * --all は <ディレクトリ>/{曲ID}.mp3 という名前のファイルを全部処理する
 * （tools/fetch-mp3s.js の保存形式そのまま）。既に public/charts/ に
 * ある曲は跳ばす（作り直したいときは JSON を消してから実行）。
 *
 * 必要: playwright（npx playwright install chromium 済みの環境）。
 * 全収録曲を凍結するには各曲の mp3 が必要（CDN からはもう取得できない。
 * 回収は tools/fetch-mp3s.js）。
 */

const fs = require("fs");
const path = require("path");
const http = require("http");

const DIFFS = ["easy", "normal", "hard", "oni"];
const PUB = path.join(__dirname, "..", "public");

function fail(msg){ console.error("[freeze-chart] " + msg); process.exit(1); }

const MIME = { ".html":"text/html", ".css":"text/css", ".js":"text/javascript",
               ".json":"application/json", ".woff2":"font/woff2", ".svg":"image/svg+xml",
               ".png":"image/png", ".webmanifest":"application/manifest+json", ".mp3":"audio/mpeg" };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function main(){
  const args = process.argv.slice(2);
  const jobs = [];   // {id, mp3Path, outPath}

  if(args[0] === "--all"){
    const dir = args[1];
    if(!dir || !fs.existsSync(dir)) fail("usage: node tools/freeze-chart.js --all <mp3のディレクトリ>");
    for(const f of fs.readdirSync(dir).sort()){
      const m = /^([0-9a-f-]{36})\.mp3$/.exec(f);
      if(!m || !UUID_RE.test(m[1])) continue;
      const outPath = path.join(PUB, "charts", m[1] + ".json");
      if(fs.existsSync(outPath)){ console.log(`[freeze-chart] skip ${m[1]}（既に凍結済み）`); continue; }
      jobs.push({ id: m[1], mp3Path: path.join(dir, f), outPath });
    }
    if(!jobs.length){ console.log("[freeze-chart] 処理対象なし（{曲ID}.mp3 が見つからないか、全曲凍結済み）"); return; }
    console.log(`[freeze-chart] ${jobs.length} 曲を凍結します`);
  }else{
    const [id, mp3Path, outArg] = args;
    if(!id || !mp3Path) fail("usage: node tools/freeze-chart.js <曲ID(UUID)> <mp3> [出力.json] | --all <dir>");
    if(!UUID_RE.test(id)) fail("曲IDが UUID ではありません: " + id);
    if(!fs.existsSync(mp3Path)) fail("mp3 が見つかりません: " + mp3Path);
    jobs.push({ id, mp3Path, outPath: outArg || path.join(PUB, "charts", id + ".json") });
  }

  let chromium;
  try{ ({ chromium } = require("playwright")); }
  catch(e){ fail("playwright が必要です（npm i -g playwright / npx playwright install chromium）"); }

  /* public/ と mp3 をローカル HTTP で配る（file:// は fetch/CORS で詰まるため）。
     /api/* は 404 でよい — クライアントは同期を出さないだけ。 */
  let currentMp3 = null;
  const server = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split("?")[0]);
    if(u === "/___song.mp3" && currentMp3){
      res.writeHead(200, {"content-type":"audio/mpeg"});
      fs.createReadStream(currentMp3).pipe(res);
      return;
    }
    const f = path.join(PUB, u === "/" ? "index.html" : u.slice(1));
    if(!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()){
      res.writeHead(404); res.end(); return;
    }
    res.writeHead(200, {"content-type": MIME[path.extname(f)] || "application/octet-stream"});
    fs.createReadStream(f).pipe(res);
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port;

  const browser = await chromium.launch({
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
  const page = await browser.newPage();
  page.on("pageerror", e => console.error("[page error]", e.message));
  await page.goto(base + "/", { waitUntil: "load" });

  const failed = [];
  for(const job of jobs){
    currentMp3 = job.mp3Path;
    const result = await page.evaluate(async (diffs) => {
      const buf = await (await fetch("/___song.mp3?" + Date.now())).arrayBuffer();
      const out = {};
      for(const d of diffs){
        /* difficulty はトップレベル let（window のプロパティではない）ので
           グローバル間接 eval で書き換える。 */
        window.eval("difficulty = " + JSON.stringify(d));
        /* 凍結対象の生成は必ず解析経路で行う: trackId を渡さないので
           凍結譜面の読み込みは走らない。 */
        const prep = await window.prepare("freeze", buf);
        if(!prep || !prep.chart || !prep.chart.length) return { error: "no chart for " + d };
        out[d] = prep.chart.map(n => [ +n.t.toFixed(6), n.panel, n.hand ]);
      }
      return { charts: out };
    }, DIFFS);

    if(result.error || DIFFS.some(d => !result.charts[d])){
      console.error(`[freeze-chart] ${job.id}: ${result.error || "難易度が欠けています"}`);
      failed.push(job.id);
      continue;
    }

    /* offset: 凍結譜面（mp3 由来）の時刻を再生バッファ（mp4）に合わせる補正秒。
       mp3/mp4 は同一タイムライン（実測 0ms）なので通常 0。もしズレる曲が
       見つかったら、その曲だけここに秒数を入れる。 */
    const data = { v: 1, offset: 0, charts: result.charts };
    fs.mkdirSync(path.dirname(job.outPath), { recursive: true });
    fs.writeFileSync(job.outPath, JSON.stringify(data));
    const counts = DIFFS.map(d => d + ":" + result.charts[d].length).join(" ");
    console.log(`[freeze-chart] wrote ${job.outPath} (${counts})`);
  }

  await browser.close();
  server.close();
  if(failed.length){
    console.error(`[freeze-chart] 失敗 ${failed.length} 曲: ${failed.join(", ")}`);
    process.exit(1);
  }
}

main().catch(e => fail(e.stack || String(e)));
