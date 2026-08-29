/* Worker の入口。
 *
 * Cloudflare Workers（静的アセット付き）構成:
 *   public/ … 配信する静的ファイル（wrangler.toml の [assets] で指定）
 *   worker/ … このスクリプト。/api/* だけを処理し、それ以外はアセットに委ねる
 *
 * Pages Functions のようなファイル名＝ルートの規約は無いので、対応表をここに置く。
 * API を増やす時はモジュールを作って ROUTES に 1 行足す。 */

import * as login from "./api/auth/login.js";
import * as callback from "./api/auth/callback.js";
import * as logout from "./api/auth/logout.js";
import * as me from "./api/me.js";
import * as sync from "./api/sync.js";
import * as audio from "./api/audio.js";

const ROUTES = {
  "/api/auth/login": login,
  "/api/auth/callback": callback,
  "/api/auth/logout": logout,
  "/api/me": me,
  "/api/sync": sync,
  "/api/audio": audio,
};

/* GET → onRequestGet のように、メソッドごとの関数名に直す。
   HEAD は GET と同じ扱い（本文はランタイムが落とす）。 */
const handlerName = method => {
  const m = method === "HEAD" ? "GET" : method;
  return "onRequest" + m.charAt(0) + m.slice(1).toLowerCase();
};

export default {
  async fetch(request, env, ctx){
    const url = new URL(request.url);
    const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;

    if(pathname === "/api" || pathname.startsWith("/api/")){
      const mod = ROUTES[pathname];
      if(!mod) return new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "content-type": "application/json" } });

      const fn = mod[handlerName(request.method)];
      if(!fn){
        const allow = Object.keys(mod).filter(k => k.startsWith("onRequest")).map(k => k.slice("onRequest".length).toUpperCase());
        return new Response(JSON.stringify({ error: "method_not_allowed" }),
          { status: 405, headers: { "content-type": "application/json", allow: allow.join(", ") } });
      }
      try{
        return await fn({ request, env, ctx });
      }catch(e){
        /* 同期の不具合でサイト全体を落とさない。詳細は返さずログに残す。 */
        console.error("api error", pathname, e && e.stack);
        return new Response(JSON.stringify({ error: "internal_error" }), { status: 500, headers: { "content-type": "application/json" } });
      }
    }

    /* それ以外は静的アセット（public/）。 */
    if(env && env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("assets binding is missing", { status: 500 });
  },
};
