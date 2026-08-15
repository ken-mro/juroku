#!/usr/bin/env node
"use strict";
/* tests/tour-import.js — ワールドツアーの Vol を markdown から index.html に取り込む
 *
 *   node tests/tour-import.js <album.md>            … 解析結果と挿入する JS を表示（dry-run）
 *   node tests/tour-import.js <album.md> --apply    … index.html の番兵コメントの位置に挿入
 *   node tests/tour-import.js <album.md> --apply --html <path>   … 別の HTML を対象にする
 *
 * markdown の前提（tests/fixtures/tour-vol1.md 参照）:
 *   - タイトル/見出しに "Vol.N"
 *   - "アルバム名(日): …" / "アルバム名(英): …" の行
 *   - 「収録国一覧」の表: | # | 曲名 | 国 | … | 採用 |（国は国旗絵文字。国旗→ISO2 で判定する）
 *   - "## Track NN: Title / …" の各節に "- vN URL: https://suno.com/song/<uuid> ★採用"
 * 取り込むのは 曲名（英語）・song ID・国（ISO2）だけ。ゲーム内表示は英語のみなので
 * 和名・ジャンル・BPM は index.html に入れない。曲名は markdown から取る。Suno から実行時に取ることはしない（CLAUDE.md §3）。
 * 国の英語名・座標は tests/lib/tour-countries.json から補う。
 * 文字列置換は番兵の存在と回数を assert してから行う（CLAUDE.md §4）。
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const COUNTRIES_JSON = path.join(__dirname, "lib", "tour-countries.json");

/* 国旗絵文字（regional indicator ×2）→ ISO2 */
function flagToCC(str){
  const cps = Array.from(str || "").map(c => c.codePointAt(0)).filter(c => c >= 0x1F1E6 && c <= 0x1F1FF);
  if(cps.length < 2) return null;
  return String.fromCharCode(65 + cps[0] - 0x1F1E6, 65 + cps[1] - 0x1F1E6);
}
const stripFlags = s => (s || "").replace(/[\u{1F1E6}-\u{1F1FF}]/gu, "").trim();

function splitRow(line){
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim());
}

function parseTourMarkdown(md){
  const lines = md.split(/\r?\n/);
  const text = md;

  const volM = text.match(/Vol\.?\s*(\d+)/i);
  if(!volM) throw new Error("Vol.N が見つかりません");
  const vol = +volM[1];

  const enM = text.match(/^アルバム名\(英\)\s*[:：]\s*(.+?)(?:\s*←.*)?$/m);
  const title = (enM ? enM[1] : `Pulse of the Earth: World Tour Vol.${vol}`).trim();   // 表示は英語名のみ

  /* 収録国一覧の表 */
  let head = -1;
  for(let i = 0; i < lines.length; i++){
    if(/^\|\s*#\s*\|/.test(lines[i])){ head = i; break; }
  }
  if(head < 0) throw new Error("収録国一覧の表（| # | 曲名 | 国 | … |）が見つかりません");
  const cols = splitRow(lines[head]);
  const ci = name => { const k = cols.findIndex(c => c.replace(/\s/g, "") === name); if(k < 0) throw new Error(`表に「${name}」列がありません`); return k; };
  const iNo = ci("#"), iTitle = ci("曲名"), iCountry = ci("国");
  const iPick = cols.findIndex(c => c.replace(/\s/g, "") === "採用");
  const rows = [];
  for(let i = head + 2; i < lines.length; i++){
    const l = lines[i];
    if(!/^\|/.test(l)) break;
    const c = splitRow(l);
    if(!/^\d+$/.test(c[iNo] || "")) continue;
    rows.push({
      no: +c[iNo], title: c[iTitle], cc: flagToCC(c[iCountry]), countryJa: stripFlags(c[iCountry]),
      pick: iPick >= 0 ? (c[iPick] || "").trim() : "",
    });
  }
  if(!rows.length) throw new Error("表に曲の行がありません");

  /* Track 節: 和名と ★採用 の URL */
  const sections = {};
  const secRe = /^##\s*Track\s*(\d+)\s*[:：]\s*(.+?)\s*(?:\/\s*(.+?))?\s*(?:【[^】]*】)?\s*(?:\([^)]*\))?\s*$/;
  let curNo = null;
  for(const l of lines){
    const m = l.match(secRe);
    if(m){
      curNo = +m[1];
      sections[curNo] = { title: m[2].trim(), ja: (m[3] || "").trim(), urls: {}, adopted: null };
      continue;
    }
    if(curNo == null) continue;
    const u = l.match(/^\s*-\s*(v\d+)\s*URL\s*[:：]\s*(https?:\/\/\S+)(.*)$/);
    if(u){
      const id = (u[2].match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i) || [])[1];
      sections[curNo].urls[u[1]] = id ? id.toLowerCase() : null;
      if(/★/.test(u[3]) || /採用/.test(u[3])) sections[curNo].adopted = u[1];
    }
  }

  const tracks = rows.map(r => {
    const sec = sections[r.no];
    if(!sec) throw new Error(`Track ${String(r.no).padStart(2, "0")} の節が見つかりません（${r.title}）`);
    const ver = sec.adopted || r.pick;
    const id = sec.urls[ver];
    if(!id) throw new Error(`Track ${r.no} ${r.title}: 採用版（${ver || "不明"}）の song ID が取れません`);
    if(!r.cc) throw new Error(`Track ${r.no} ${r.title}: 国の国旗絵文字が読めません`);
    return { id, title: r.title, cc: r.cc, countryJa: r.countryJa, version: ver };
  });
  return { vol, title, tracks };
}

/* index.html の TOUR_COUNTRIES にある ISO2 の集合 */
function knownCountries(html){
  const m = html.match(/const TOUR_COUNTRIES = \{([\s\S]*?)\/\* TOUR_COUNTRIES_END \*\//);
  if(!m) throw new Error("index.html に TOUR_COUNTRIES / TOUR_COUNTRIES_END が見つかりません");
  const out = new Set();
  for(const x of m[1].matchAll(/^\s*([A-Z]{2}):\{/gm)) out.add(x[1]);
  return out;
}
/* index.html にある曲名（DEFAULT_TRACKS と TOUR_VOLS）。ベストスコアのキーが曲名なので重複は不可。 */
function existingTitles(html){
  const out = new Set();
  const dt = html.match(/const DEFAULT_TRACKS = \[([\s\S]*?)\]\.map\(/);
  const tv = html.match(/const TOUR_VOLS = \[([\s\S]*?)\/\* TOUR_VOLS_END \*\//);
  for(const m of [dt, tv]) if(m) for(const x of m[1].matchAll(/\btitle:"((?:[^"\\]|\\.)*)"/g)) out.add(JSON.parse('"' + x[1] + '"'));
  /* Vol のアルバム名も title: で書かれているが、曲名と衝突しないので混ざっていても害はない */
  return out;
}
function existingVols(html){
  const m = html.match(/const TOUR_VOLS = \[([\s\S]*?)\/\* TOUR_VOLS_END \*\//);
  if(!m) throw new Error("index.html に TOUR_VOLS / TOUR_VOLS_END が見つかりません");
  return Array.from(m[1].matchAll(/\{\s*vol:\s*(\d+)\s*,/g)).map(x => +x[1]);
}
const q = s => JSON.stringify(String(s == null ? "" : s));

function renderVolLiteral(v){
  const w = (s, n) => (s + ",").padEnd(n);
  const lines = v.tracks.map(t =>
    `      { id:${q(t.id)}, title:${w(q(t.title), 22)} cc:${q(t.cc)} },`);
  return [
    `  { vol:${v.vol}, title:${q(v.title)},`,
    `    tracks:[`,
    ...lines,
    `    ] },`,
  ].join("\n");
}
function renderCountryLiteral(cc, c){
  return `  ${cc}:{ en:${q(c.en)}, lon:${c.lon}, lat:${c.lat} },`;
}

/* 挿入。番兵がちょうど 1 回ずつあること、同じ Vol が無いことを assert する。 */
function applyToHtml(html, v, countriesToAdd){
  const V = "  /* TOUR_VOLS_END */";
  const C = "  /* TOUR_COUNTRIES_END */";
  const cnt = (h, s) => h.split(s).length - 1;
  if(cnt(html, V) !== 1) throw new Error(`番兵 ${V.trim()} が ${cnt(html, V)} 回あります（1 回であるべき）`);
  if(cnt(html, C) !== 1) throw new Error(`番兵 ${C.trim()} が ${cnt(html, C)} 回あります（1 回であるべき）`);
  if(existingVols(html).includes(v.vol)) throw new Error(`Vol.${v.vol} は既に index.html にあります`);
  const dup = duplicateTitles(v, html);
  if(dup.length) throw new Error(`曲名が既存の曲と重複しています（ベストスコアのキーが曲名のため不可）: ${dup.join(", ")}`);
  let out = html;
  if(countriesToAdd.length){
    out = out.replace(C, countriesToAdd.map(([cc, c]) => renderCountryLiteral(cc, c)).join("\n") + "\n" + C);
  }
  out = out.replace(V, renderVolLiteral(v) + "\n" + V);
  /* 置換後の確認 */
  if(!existingVols(out).includes(v.vol)) throw new Error("挿入後の確認に失敗しました（Vol が見つからない）");
  for(const [cc] of countriesToAdd) if(!knownCountries(out).has(cc)) throw new Error(`挿入後の確認に失敗しました（${cc}）`);
  return out;
}

/* 既存曲（DEFAULT_TRACKS・他の Vol）や Vol 内で重複する曲名 */
function duplicateTitles(v, html){
  const seen = existingTitles(html), dup = [];
  for(const t of v.tracks){
    if(seen.has(t.title)) dup.push(t.title); else seen.add(t.title);
  }
  return dup;
}
/* 足りない国を tour-countries.json から補う。表に無ければ座標の追記を求めて停止。 */
function resolveCountries(v, html){
  const known = knownCountries(html);
  const table = JSON.parse(fs.readFileSync(COUNTRIES_JSON, "utf8"));
  const add = [], missing = [];
  for(const t of v.tracks){
    if(known.has(t.cc) || add.some(([cc]) => cc === t.cc)) continue;
    if(table[t.cc] && table[t.cc].en) add.push([t.cc, table[t.cc]]);
    else missing.push(t);
  }
  return { add, missing };
}

function main(argv){
  const args = argv.slice(2);
  const file = args.find(a => !a.startsWith("--"));
  if(!file){ console.error("usage: node tests/tour-import.js <album.md> [--apply] [--html index.html]"); process.exit(2); }
  const apply = args.includes("--apply");
  const hi = args.indexOf("--html");
  const htmlPath = hi >= 0 ? path.resolve(args[hi + 1]) : path.join(ROOT, "index.html");

  const md = fs.readFileSync(file, "utf8");
  const v = parseTourMarkdown(md);
  const html = fs.readFileSync(htmlPath, "utf8");
  const { add, missing } = resolveCountries(v, html);

  console.log(`Vol.${v.vol}  ${v.title}`);
  for(const t of v.tracks) console.log(`  ${String(v.tracks.indexOf(t) + 1).padStart(2, "0")}  ${t.cc}  ${t.title.padEnd(22)} ${t.version.padEnd(3)} ${t.id}`);
  if(add.length){
    console.log("\nTOUR_COUNTRIES に追加:");
    for(const [cc, c] of add) console.log(renderCountryLiteral(cc, c));
  }
  if(missing.length){
    console.error("\n座標が分かりません。tests/lib/tour-countries.json に追記してから再実行してください:");
    for(const t of missing) console.error(`  ${t.cc}: { "en":"…", "lon":…, "lat":… }   （markdown 上の表記: ${t.countryJa}）`);
    process.exit(1);
  }
  const dup = duplicateTitles(v, html);
  if(dup.length){
    console.error("\n曲名が既存の曲（収録曲または他の Vol）と重複しています。ベストスコアのキーが曲名なので取り込めません。" +
                  "\nmarkdown 側で曲名を直してから再実行してください: " + dup.join(", "));
    process.exit(1);
  }
  console.log("\nTOUR_VOLS に追加:\n" + renderVolLiteral(v));
  if(existingVols(html).includes(v.vol)){
    console.error(`\nVol.${v.vol} は既に ${path.relative(ROOT, htmlPath)} にあります。--apply しません。`);
    process.exit(1);
  }
  if(!apply){ console.log("\n（dry-run。--apply で挿入します）"); return; }
  const out = applyToHtml(html, v, add);
  fs.writeFileSync(htmlPath, out);
  console.log(`\n${path.relative(ROOT, htmlPath)} に Vol.${v.vol}（${v.tracks.length} 曲${add.length ? "・国 " + add.length : ""}）を挿入しました。` +
              `\n次に: cd tests && npm test / <title> のバージョン更新 / README 更新`);
}

module.exports = { parseTourMarkdown, renderVolLiteral, renderCountryLiteral, applyToHtml, resolveCountries, knownCountries, existingVols, existingTitles, duplicateTitles, flagToCC };
if(require.main === module) main(process.argv);
