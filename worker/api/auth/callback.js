import { config, notConfigured, redirect, origin, callbackUrl, json } from "../../lib/config.js";
import { exchangeCode, verifyIdToken } from "../../lib/google.js";
import { signToken, verifyToken, getCookie, setCookie, clearCookie,
         SESSION_COOKIE, STATE_COOKIE, SESSION_MAX_AGE } from "../../lib/session.js";

/* Google からの戻り。state を照合し、コードをトークンに交換し、ID トークンを検証してから
   自前のセッション Cookie を発行する。Google のトークンは保存しない（用が済んだら捨てる）。 */
export async function onRequestGet({ request, env, now }){
  const c = config(env);
  if(!c.ready) return notConfigured();

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if(url.searchParams.get("error")) return redirect(origin(request) + "/?login=cancelled", [clearCookie(STATE_COOKIE)]);
  if(!code || !state) return json({ error: "missing_code_or_state" }, { status: 400 });

  /* state は「Cookie と一致」かつ「自分の署名として有効」の両方を満たす必要がある */
  const cookieState = getCookie(request, STATE_COOKIE);
  if(!cookieState || cookieState !== state) return json({ error: "state_mismatch" }, { status: 400 });
  if(!await verifyToken(state, c.sessionSecret, now)) return json({ error: "state_invalid" }, { status: 400 });

  let claims;
  try{
    const tokens = await exchangeCode({ code, clientId: c.clientId, clientSecret: c.clientSecret,
                                        redirectUri: callbackUrl(request) });
    claims = await verifyIdToken(tokens.id_token, { clientId: c.clientId, now });
  }catch(e){
    return json({ error: "token_exchange_failed" }, { status: 502 });
  }
  if(!claims) return json({ error: "invalid_id_token" }, { status: 401 });

  const session = await signToken({ sub: claims.sub, email: claims.email || "" }, c.sessionSecret, now, SESSION_MAX_AGE);
  return redirect(origin(request) + "/?login=ok",
                  [setCookie(SESSION_COOKIE, session, { maxAge: SESSION_MAX_AGE }), clearCookie(STATE_COOKIE)]);
}
