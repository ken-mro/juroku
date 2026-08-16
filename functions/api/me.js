import { config, notConfigured, json } from "../_lib/config.js";
import { readSession } from "../_lib/session.js";

/* ログイン状態の照会。クライアントは起動時にこれを見て同期するかどうかを決める。 */
export async function onRequestGet({ request, env, now }){
  const c = config(env);
  if(!c.ready) return notConfigured();
  const s = await readSession(request, c.sessionSecret, now);
  return json(s ? { signedIn: true, email: s.email || "" } : { signedIn: false });
}
