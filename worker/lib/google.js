/* Google の OpenID Connect。認可コードを使うサーバー側フローで、
   外部 JS（Google Identity Services）を読み込まずに済ませている。

   ID トークンは「Google が発行し、このアプリ宛てで、まだ有効なもの」だけを受け入れる。
   ここを緩めると誰でも他人になりすませるので、検証は省略しないこと。 */

const AUTH_ENDPOINT  = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const JWKS_URL       = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
export const SCOPE = "openid email";

export function authUrl({ clientId, redirectUri, state }){
  const u = new URL(AUTH_ENDPOINT);
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", SCOPE);
  u.searchParams.set("state", state);
  u.searchParams.set("access_type", "online");     // 記録の同期に refresh token は要らない
  u.searchParams.set("prompt", "select_account");
  return u.toString();
}

export async function exchangeCode({ code, clientId, clientSecret, redirectUri }){
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret,
                                redirect_uri: redirectUri, grant_type: "authorization_code" }),
  });
  if(!res.ok) throw new Error("token exchange failed: " + res.status);
  const body = await res.json();
  if(!body || typeof body.id_token !== "string") throw new Error("no id_token in token response");
  return body;
}

const b64uToBytes = s => Uint8Array.from(atob(String(s).replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
const b64uToJson  = s => JSON.parse(new TextDecoder().decode(b64uToBytes(s)));

let jwksCache = null;                              // Worker のインスタンス内で使い回す（毎回取りに行かない）
async function jwks(){
  const t = Date.now();
  if(jwksCache && jwksCache.until > t) return jwksCache.keys;
  const res = await fetch(JWKS_URL);
  if(!res.ok) throw new Error("jwks fetch failed: " + res.status);
  const body = await res.json();
  jwksCache = { keys: body.keys || [], until: t + 60 * 60 * 1000 };
  return jwksCache.keys;
}

/* 正当なら claims を、そうでなければ null を返す（例外は投げない）。 */
export async function verifyIdToken(jwt, { clientId, now } = {}){
  try{
    const parts = String(jwt).split(".");
    if(parts.length !== 3) return null;
    const header = b64uToJson(parts[0]);
    if(header.alg !== "RS256") return null;                       // alg=none 等を拒否
    const key = (await jwks()).find(k => k.kid === header.kid && (!k.alg || k.alg === "RS256"));
    if(!key) return null;
    const pub = await crypto.subtle.importKey("jwk", { ...key, ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", pub,
      b64uToBytes(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
    if(!ok) return null;

    const c = b64uToJson(parts[1]);
    const t = typeof now === "number" ? now : Date.now();
    if(!ISSUERS.includes(c.iss)) return null;
    if(c.aud !== clientId) return null;                            // 他アプリ向けのトークンを流用させない
    if(typeof c.exp !== "number" || c.exp * 1000 <= t) return null;
    if(typeof c.sub !== "string" || !c.sub) return null;
    return c;
  }catch(e){ return null; }
}
