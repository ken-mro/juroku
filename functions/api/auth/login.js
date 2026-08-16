import { config, notConfigured, redirect, callbackUrl } from "../../_lib/config.js";
import { authUrl } from "../../_lib/google.js";
import { signToken, setCookie, STATE_COOKIE } from "../../_lib/session.js";

/* Google の認可画面へ送る。CSRF 対策の state は署名して Cookie にも入れ、
   戻ってきた時に一致を確認する（Cookie を読めない第三者は state を偽造できない）。 */
export async function onRequestGet({ request, env }){
  const c = config(env);
  if(!c.ready) return notConfigured();

  const nonce = crypto.randomUUID();
  const state = await signToken({ n: nonce }, c.sessionSecret, Date.now(), 600);
  return redirect(authUrl({ clientId: c.clientId, redirectUri: callbackUrl(request), state }),
                  [setCookie(STATE_COOKIE, state, { maxAge: 600 })]);
}
