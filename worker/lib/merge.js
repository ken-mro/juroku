/* 併合規則。クラウド同期の中核で、ここだけは純関数に保つ（副作用・I/O なし）。
 *
 * 併合は可換（a→b と b→a が同じ）かつ冪等（何度やっても同じ）になるよう定義してある。
 * そのおかげで複数端末が任意の順で同期しても結果が一致し、バージョン管理や
 * 競合解決の UI が要らない。規則を変える時はこの性質を壊していないか tests/merge.js で確認すること。
 *
 * 入力はクライアントから来る任意の JSON なので、必ず sanitize() を通してから使う。 */

export const SCHEMA_VERSION = 1;
export const LIMITS = { bests: 2000, usertracks: 200 };

const num = v => (typeof v === "number" && isFinite(v)) ? v : null;
const str = v => (typeof v === "string" ? v : "");
/* プロトタイプ汚染を避けるため、素のオブジェクトを作って自前のキーだけ入れる */
const bare = () => Object.create(null);
const own = o => (o && typeof o === "object" && !Array.isArray(o)) ? o : null;
const skipKey = k => k === "__proto__" || k === "constructor" || k === "prototype";
/* Object.create(null) のままだと JSON 化以外で扱いにくいので、キー順を揃えた素のオブジェクトにする */
const sortedPlain = o => { const out = {}; for(const k of Object.keys(o).sort()) out[k] = o[k]; return out; };

/* ベスト 1 件。スコアが数値でないものは記録として意味がないので捨てる。 */
function cleanBest(v){
  const o = own(v); if(!o) return null;
  const s = num(o.s); if(s === null) return null;
  const out = { s };
  const a = num(o.a); if(a !== null) out.a = a;
  if(Array.isArray(o.c)) out.c = o.c.slice(0, 4).map(x => num(x) ?? 0);
  const m = num(o.m); if(m !== null) out.m = m;
  const n = num(o.n); if(n !== null) out.n = n;
  const d = num(o.d); if(d !== null) out.d = d;
  return out;
}
function cleanCleared(v){
  const o = own(v); if(!o) return null;
  const out = {};
  const d = num(o.d); if(d !== null) out.d = d;
  if(typeof o.diff === "string") out.diff = o.diff.slice(0, 16);
  const acc = num(o.acc); if(acc !== null) out.acc = acc;
  return out;
}
function cleanTrack(v){
  const o = own(v); if(!o) return null;
  const url = str(o.url); if(!url) return null;                 // url が無いものは復元できない
  return { kind: "link", title: str(o.title).slice(0, 200), artist: str(o.artist).slice(0, 200),
           url: url.slice(0, 500), art: str(o.art).slice(0, 500), id: str(o.id).slice(0, 100) };
}

/* 任意の入力 → 信用できる形。上限もここで打ち切る。 */
export function sanitize(input){
  const src = own(input) || {};
  const bests = bare();
  const sb = own(src.bests) || {};
  let n = 0;
  for(const k of Object.keys(sb)){
    if(skipKey(k) || n >= LIMITS.bests) continue;
    const b = cleanBest(sb[k]);
    if(b){ bests[k.slice(0, 300)] = b; n++; }
  }
  const cleared = bare();
  const sc = own(own(src.tour) && src.tour.cleared) || {};
  for(const k of Object.keys(sc)){
    if(skipKey(k)) continue;
    const c = cleanCleared(sc[k]);
    if(c) cleared[k.slice(0, 100)] = c;
  }
  const usertracks = [];
  if(Array.isArray(src.usertracks)){
    const seen = new Set();
    for(const t of src.usertracks){
      if(usertracks.length >= LIMITS.usertracks) break;
      const c = cleanTrack(t);
      if(c && !seen.has(c.url)){ seen.add(c.url); usertracks.push(c); }
    }
  }
  return { bests, tour: { cleared }, usertracks };
}

/* stored（KV の内容）と incoming（端末から届いた内容）を併合する。
   衝突時は「失われない方」を選ぶ: ベストは高いスコア、クリアは古い日時、リンク曲は先に登録された方。 */
export function mergeState(stored, incoming, now){
  const A = sanitize(stored), B = sanitize(incoming);

  const bests = bare();
  for(const k of Object.keys(A.bests)) bests[k] = A.bests[k];
  for(const k of Object.keys(B.bests)){
    const a = bests[k], b = B.bests[k];
    if(!a || b.s > a.s) bests[k] = b;                            // 同点なら既存を保持
  }
  /* 上限を超える時は、スコアの高い順に残す（打ち切りで良い記録が消えないように） */
  let keys = Object.keys(bests);
  if(keys.length > LIMITS.bests){
    keys.sort((x, y) => bests[y].s - bests[x].s);
    const capped = bare();
    for(const k of keys.slice(0, LIMITS.bests)) capped[k] = bests[k];
    for(const k of Object.keys(bests)) delete bests[k];
    Object.assign(bests, capped);
  }

  const cleared = bare();
  for(const k of Object.keys(A.tour.cleared)) cleared[k] = A.tour.cleared[k];
  for(const k of Object.keys(B.tour.cleared)){
    const a = cleared[k], b = B.tour.cleared[k];
    if(!a) cleared[k] = b;
    else if(num(b.d) !== null && (num(a.d) === null || b.d < a.d)) cleared[k] = b;   // 先にクリアした記録を残す
  }

  const usertracks = [];
  const seen = new Set();
  for(const t of A.usertracks.concat(B.usertracks)){
    if(usertracks.length >= LIMITS.usertracks) break;
    if(seen.has(t.url)) continue;
    seen.add(t.url); usertracks.push(t);
  }

  /* キー順を確定させる。併合の向きに関係なく同じバイト列になるので、
     KV の既存値と文字列比較するだけで「変化なし＝書き込み不要」を判定できる。 */
  return { v: SCHEMA_VERSION, updatedAt: num(now) ?? 0,
           bests: sortedPlain(bests), tour: { cleared: sortedPlain(cleared) }, usertracks };
}
