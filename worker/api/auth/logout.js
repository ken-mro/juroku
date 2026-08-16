import { config, notConfigured, json } from "../../lib/config.js";
import { clearCookie, SESSION_COOKIE } from "../../lib/session.js";

/* ログアウト。クラウドのデータは消さない（別の端末や再ログインで使うため）。 */
export async function onRequestPost({ env }){
  const c = config(env);
  if(!c.ready) return notConfigured();
  return json({ signedIn: false }, { headers: { "set-cookie": clearCookie(SESSION_COOKIE) } });
}
