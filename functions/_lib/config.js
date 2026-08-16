/* 環境変数の取り出しと、よく使うレスポンス。
   秘密情報はここでしか読まない（Cloudflare の Secret に置く。リポジトリには絶対に入れない）。 */

export const KV_PREFIX = "u:";

/* 同期に必要な設定が揃っているか。1 つでも欠けたら同期機能そのものを止める
   （中途半端に動くより、クライアントに「使えない」と伝えて localStorage のみで動かす方が安全）。 */
export function config(env){
  const c = {
    clientId: env && env.GOOGLE_CLIENT_ID,
    clientSecret: env && env.GOOGLE_CLIENT_SECRET,
    sessionSecret: env && env.SESSION_SECRET,
    kv: env && env.JUROKU_KV,
  };
  c.ready = !!(c.clientId && c.clientSecret && c.sessionSecret && c.kv);
  return c;
}

export const json = (body, init) => new Response(JSON.stringify(body), {
  ...(init || {}),
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...((init || {}).headers || {}) },
});
/* 同期が構成されていない環境（Secret 未設定）。クライアントはこれを見て同期 UI を出さない。 */
export const notConfigured = () => json({ error: "sync_not_configured" }, { status: 503 });
export const unauthorized  = () => json({ error: "unauthorized" }, { status: 401 });
export const redirect = (location, cookies) => {
  const h = new Headers({ location, "cache-control": "no-store" });
  for(const c of (cookies || [])) h.append("set-cookie", c);
  return new Response(null, { status: 302, headers: h });
};
/* リダイレクト先は必ず自分のオリジンに閉じる（オープンリダイレクトを作らない） */
export const origin = request => new URL(request.url).origin;
export const callbackUrl = request => origin(request) + "/api/auth/callback";
