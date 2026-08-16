/* セッションの署名／検証と Cookie の組み立て。
 *
 * セッションは自前の短い署名付きトークン（`<payload>.<HMAC-SHA256>`）で、
 * KV を引かずに検証できる（読み取り課金も遅延も無い）。Google の ID トークンは
 * ログイン時に検証するだけで保存しない — 1 時間で失効し、再ログインを強いるため。
 *
 * トークンは HttpOnly Cookie に入れるので JavaScript からは触れない（XSS でも盗めない）。 */

export const SESSION_COOKIE = "juroku_session";
export const STATE_COOKIE = "juroku_oauth_state";
export const SESSION_MAX_AGE = 90 * 24 * 60 * 60;      // 90 日（秒）

const enc = new TextEncoder();
const dec = new TextDecoder();

const b64uFromBytes = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const bytesFromB64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));

async function hmacKey(secret){
  return crypto.subtle.importKey("raw", enc.encode(String(secret)), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/* payload に iat / exp を足して署名する。ttl は秒。 */
export async function signToken(payload, secret, now, ttlSeconds){
  const t = typeof now === "number" ? now : Date.now();
  const body = { ...payload, iat: Math.floor(t / 1000), exp: Math.floor(t / 1000) + (ttlSeconds || SESSION_MAX_AGE) };
  const p = b64uFromBytes(enc.encode(JSON.stringify(body)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(p));
  return p + "." + b64uFromBytes(new Uint8Array(sig));
}

/* 正しく署名され期限内なら payload を、そうでなければ null を返す。
   例外は投げない（壊れた Cookie が来ても 500 にせず「未ログイン」として扱う）。 */
export async function verifyToken(token, secret, now){
  try{
    if(typeof token !== "string") return null;
    const dot = token.indexOf(".");
    if(dot <= 0 || dot === token.length - 1) return null;
    const p = token.slice(0, dot), sig = token.slice(dot + 1);
    /* 署名の検証は crypto.subtle.verify に任せる（自前で文字列比較しない＝タイミング差を作らない） */
    const okSig = await crypto.subtle.verify("HMAC", await hmacKey(secret), bytesFromB64u(sig), enc.encode(p));
    if(!okSig) return null;
    const body = JSON.parse(dec.decode(bytesFromB64u(p)));
    const t = typeof now === "number" ? now : Date.now();
    if(typeof body.exp !== "number" || body.exp * 1000 <= t) return null;
    return body;
  }catch(e){ return null; }
}

export function setCookie(name, value, opts){
  const o = opts || {};
  const bits = [`${name}=${value}`, "Path=/", "HttpOnly", "Secure", "SameSite=Lax"];
  if(typeof o.maxAge === "number") bits.push(`Max-Age=${o.maxAge}`);
  return bits.join("; ");
}
export function clearCookie(name){
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function getCookie(request, name){
  try{
    const header = request.headers.get("cookie");
    if(!header) return null;
    for(const part of header.split(";")){
      const s = part.trim();
      const eq = s.indexOf("=");
      if(eq < 0) continue;
      if(s.slice(0, eq) === name) return s.slice(eq + 1);      // 前方一致で誤検出しないよう完全一致で比べる
    }
    return null;
  }catch(e){ return null; }
}

/* リクエストの Cookie からログイン中のユーザーを取り出す。未ログインなら null。 */
export async function readSession(request, secret, now){
  const raw = getCookie(request, SESSION_COOKIE);
  if(!raw) return null;
  return verifyToken(raw, secret, now);
}
