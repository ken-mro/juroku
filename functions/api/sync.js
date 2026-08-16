import { config, notConfigured, unauthorized, json, KV_PREFIX } from "../_lib/config.js";
import { readSession, clearCookie, SESSION_COOKIE } from "../_lib/session.js";
import { mergeState, sanitize, SCHEMA_VERSION } from "../_lib/merge.js";

/* 同期の本体。
   クライアントは「自分の全体を PUT し、返ってきた併合結果を採用する」だけでよい。
   併合は可換・冪等なので（_lib/merge.js）、どの端末がどの順で同期しても同じ結果になる。 */

const keyFor = sub => KV_PREFIX + sub;

async function load(kv, sub){
  try{
    const raw = await kv.get(keyFor(sub));
    return raw ? JSON.parse(raw) : null;
  }catch(e){ return null; }                       // 壊れた値は「無い」として扱い、次の PUT で上書きされる
}

export async function onRequestGet({ request, env, now }){
  const c = config(env);
  if(!c.ready) return notConfigured();
  const s = await readSession(request, c.sessionSecret, now);
  if(!s) return unauthorized();

  const stored = await load(c.kv, s.sub);
  if(!stored) return json({ v: SCHEMA_VERSION, updatedAt: 0, ...sanitize(null) });
  return json(stored);
}

/* 端末の内容を受け取り、保存済みと併合して保存し、併合結果を返す。 */
export async function onRequestPut({ request, env, now }){
  const c = config(env);
  if(!c.ready) return notConfigured();
  const s = await readSession(request, c.sessionSecret, now);
  if(!s) return unauthorized();

  let incoming;
  try{ incoming = await request.json(); }
  catch(e){ return json({ error: "invalid_json" }, { status: 400 }); }

  const stored = await load(c.kv, s.sub);
  const merged = mergeState(stored, incoming, typeof now === "number" ? now : Date.now());

  /* 中身が変わっていなければ書かない（KV の書き込み回数を無駄に使わない）。
     merge.js がキー順を確定させているので、単純な文字列比較で判定できる。 */
  const before = stored ? JSON.stringify({ ...stored, updatedAt: 0 }) : null;
  const after = JSON.stringify({ ...merged, updatedAt: 0 });
  if(before !== after) await c.kv.put(keyFor(s.sub), JSON.stringify(merged));

  return json(merged);
}

/* sendBeacon は POST しか送れないので、離脱時の保存用に PUT と同じ扱いにする。 */
export const onRequestPost = onRequestPut;

/* クラウドのデータを削除する。消した直後に同じ端末が再アップロードしないよう、
   同時にログアウトさせる（端末内の記録はそのまま残る）。 */
export async function onRequestDelete({ request, env, now }){
  const c = config(env);
  if(!c.ready) return notConfigured();
  const s = await readSession(request, c.sessionSecret, now);
  if(!s) return unauthorized();

  try{ await c.kv.delete(keyFor(s.sub)); }catch(e){}
  return json({ deleted: true, signedIn: false }, { headers: { "set-cookie": clearCookie(SESSION_COOKIE) } });
}
