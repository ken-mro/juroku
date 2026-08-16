#!/usr/bin/env node
"use strict";
/* tests/merge.js — クラウド同期の併合規則（functions/_lib/merge.js）
 *
 * 併合は「順序に依存しない（可換）」「何度やっても同じ（冪等）」ことが要。
 * 複数端末が任意の順で同期しても同じ結果になり、競合解決 UI が要らなくなる。
 * 入力はクライアントから来る任意の JSON なので、検証と上限打ち切りも必須。
 */
const path = require("path");
const { pathToFileURL } = require("url");

function fail(msg){ console.error("[merge] FAIL: " + msg); process.exit(1); }
const assert = (c, m) => { if(!c) fail(m); };
const eq = (a, b, m) => assert(JSON.stringify(a) === JSON.stringify(b), `${m}\n  got:      ${JSON.stringify(a)}\n  expected: ${JSON.stringify(b)}`);

async function main(){
  const M = await import(pathToFileURL(path.join(__dirname, "..", "worker", "lib", "merge.js")).href);

  /* ── ベスト記録: スコアが高い方が残る ── */
  {
    const a = { bests: { "X|normal": { s: 100, a: 50, c: [1,2,3,4], m: 5, n: 10, d: 1 },
                         "Y|hard":   { s: 900, a: 90, c: [9,0,0,0], m: 9, n: 9,  d: 2 } } };
    const b = { bests: { "X|normal": { s: 500, a: 70, c: [5,0,0,0], m: 7, n: 10, d: 3 },
                         "Z|easy":   { s: 10,  a: 10, c: [1,0,0,0], m: 1, n: 1,  d: 4 } } };
    const m1 = M.mergeState(a, b), m2 = M.mergeState(b, a);
    assert(m1.bests["X|normal"].s === 500, "higher score must win (got " + m1.bests["X|normal"].s + ")");
    assert(m1.bests["X|normal"].a === 70, "the whole record of the winner must be kept, not a mix");
    assert(m1.bests["Y|hard"].s === 900 && m1.bests["Z|easy"].s === 10, "records present on only one side must survive");
    eq(m1.bests, m2.bests, "bests merge must be commutative");
    eq(M.mergeState(m1, b).bests, m1.bests, "bests merge must be idempotent");
    const tie = M.mergeState({ bests: { "T|normal": { s: 5, a: 1, n: 1, d: 1 } } },
                             { bests: { "T|normal": { s: 5, a: 2, n: 1, d: 2 } } });
    assert(tie.bests["T|normal"].a === 1, "on a tie the stored record is kept");
  }

  /* ── ツアー進行: 和集合、クリア日時は古い方 ── */
  {
    const a = { tour: { cleared: { "id-1": { d: 100, diff: "normal", acc: 90 } } } };
    const b = { tour: { cleared: { "id-1": { d: 50,  diff: "easy",   acc: 60 },
                                   "id-2": { d: 70,  diff: "hard",   acc: 80 } } } };
    const m1 = M.mergeState(a, b), m2 = M.mergeState(b, a);
    assert(m1.tour.cleared["id-1"].d === 50, "the earliest clear date wins (got " + m1.tour.cleared["id-1"].d + ")");
    assert(m1.tour.cleared["id-2"], "clears present on only one side must survive");
    eq(m1.tour, m2.tour, "tour merge must be commutative");
    eq(M.mergeState(m1, b).tour, m1.tour, "tour merge must be idempotent");
  }

  /* ── リンク曲: url で重複排除した和集合 ── */
  {
    const t = (id, url) => ({ kind: "link", title: "T" + id, artist: "a", url, art: "", id: String(id) });
    const a = { usertracks: [t(1, "https://x/1"), t(2, "https://x/2")] };
    const b = { usertracks: [t(9, "https://x/2"), t(3, "https://x/3")] };
    const m1 = M.mergeState(a, b), m2 = M.mergeState(b, a);
    assert(m1.usertracks.length === 3, "duplicate urls must collapse (got " + m1.usertracks.length + ")");
    assert(m1.usertracks.find(x => x.url === "https://x/2").title === "T2", "the first registration is kept on a url clash");
    assert(m2.usertracks.length === 3, "usertracks merge must be commutative in size");
    eq(M.mergeState(m1, b).usertracks, m1.usertracks, "usertracks merge must be idempotent");
  }

  /* ── 壊れた入力は捨てる（クライアントからの任意の JSON を信用しない） ── */
  {
    const s = M.sanitize(null);
    eq([s.bests, s.tour, s.usertracks], [{}, { cleared: {} }, []], "null input must sanitize to an empty state");
    eq(M.sanitize(42).bests, {}, "a number must sanitize to an empty state");
    eq(M.sanitize({ bests: "nope", tour: 7, usertracks: {} }).usertracks, [], "wrong types must be dropped");
    const bad = M.sanitize({ bests: { "ok|normal": { s: 5, a: 1, c: [1,0,0,0], m: 1, n: 1, d: 1 },
                                      "bad|normal": { s: "not a number" },
                                      "worse|normal": null } });
    assert(bad.bests["ok|normal"] && !bad.bests["bad|normal"] && !bad.bests["worse|normal"],
      "records without a numeric score must be dropped: " + JSON.stringify(bad.bests));
    const evil = M.sanitize({ tour: { cleared: { "id": { d: "x" } } },
                              usertracks: [{ kind: "link" }, { kind: "link", url: "https://ok" }, "junk"] });
    /* クリアの事実は進行そのものなので残す。ただし不正な値は持ち越さない */
    assert(evil.tour.cleared["id"], "the clear itself must survive even if its metadata was garbage");
    assert(!("d" in evil.tour.cleared["id"]), "a non-numeric clear date must not survive: " + JSON.stringify(evil.tour.cleared["id"]));
    assert(evil.usertracks.length === 1 && evil.usertracks[0].url === "https://ok", "tracks without a url must be dropped");
    assert(!("__proto__" in M.sanitize({ bests: JSON.parse('{"__proto__":{"x":1}}') }).bests), "prototype keys must not survive");
  }

  /* ── 上限（KV の 1 値 25MB / 実用上は小さく保つ） ── */
  {
    const many = {}; for(let i = 0; i < M.LIMITS.bests + 50; i++) many["k" + i + "|normal"] = { s: i, a: 1, n: 1, d: i };
    const tracks = []; for(let i = 0; i < M.LIMITS.usertracks + 50; i++) tracks.push({ kind: "link", url: "https://x/" + i, title: "t" });
    const s = M.sanitize({ bests: many, usertracks: tracks });
    assert(Object.keys(s.bests).length === M.LIMITS.bests, `bests must cap at ${M.LIMITS.bests}, got ${Object.keys(s.bests).length}`);
    assert(s.usertracks.length === M.LIMITS.usertracks, `usertracks must cap at ${M.LIMITS.usertracks}`);
    const capped = M.mergeState({ bests: many }, { bests: many });
    assert(Object.keys(capped.bests).length <= M.LIMITS.bests, "merge must not exceed the cap either");
  }

  /* ── 出力の形 ── */
  {
    const m = M.mergeState(null, null);
    assert(m.v === 1 && typeof m.updatedAt === "number", "merged state must carry a version and a timestamp");
    eq(Object.keys(m).sort(), ["bests","tour","updatedAt","usertracks","v"], "merged state must have exactly the expected keys");
  }

  console.log("[merge] PASS — 高スコア優先・和集合・重複排除・可換・冪等・検証・上限");
  process.exit(0);
}
main().catch(e => fail((e && e.stack) || String(e)));
