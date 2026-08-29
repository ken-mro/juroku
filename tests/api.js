#!/usr/bin/env node
"use strict";
/* tests/api.js — Google OAuth ヘルパ（functions/_lib/google.js）と API ハンドラ（functions/api/**）
 *
 * ID トークンの検証は「他人が作った JWT を受け入れない」ことが全て。
 * テスト内で RSA 鍵ペアを作り、本物と同じ RS256 の JWT を組み立てて検証する
 * （aud 不一致・期限切れ・改ざん・別の鍵、を確実に弾けるか）。
 * ハンドラは KV スタブと差し替えた fetch で直接呼ぶ。
 */
const path = require("path");
const { pathToFileURL } = require("url");
const F = p => pathToFileURL(path.join(__dirname, "..", "worker", p)).href;

function fail(msg){ console.error("[api] FAIL: " + msg); process.exit(1); }
const assert = (c, m) => { if(!c) fail(m); };

const CLIENT_ID = "test-client-id.apps.googleusercontent.com";
const SECRET = "test-session-secret";
const NOW = 1_700_000_000_000;

/* ── テスト用の Google 相当（鍵ペア・JWT 発行・JWKS） ── */
async function makeGoogle(){
  const kp = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  const kid = "test-kid-1";
  const b64u = o => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
  async function idToken(claims, opts){
    const o = opts || {};
    const header = { alg: "RS256", kid: o.kid || kid, typ: "JWT" };
    const body = { iss: "https://accounts.google.com", aud: CLIENT_ID, sub: "google-sub-123",
                   email: "player@example.com", email_verified: true,
                   iat: Math.floor(NOW / 1000), exp: Math.floor(NOW / 1000) + 3600, ...claims };
    const data = b64u(header) + "." + b64u(body);
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", o.key || kp.privateKey, new TextEncoder().encode(data));
    return data + "." + Buffer.from(new Uint8Array(sig)).toString("base64url");
  }
  const jwks = { keys: [{ ...jwk, kid, use: "sig", alg: "RS256" }] };
  return { kp, jwks, idToken, kid };
}
/* fetch のスタブ。JWKS とトークン交換だけ答え、それ以外は失敗にする。 */
function stubFetch(google, tokenResponse){
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, init });
    if(u.includes("/oauth2/v3/certs")) return new Response(JSON.stringify(google.jwks), { status: 200, headers: { "content-type": "application/json" } });
    if(u.includes("oauth2.googleapis.com/token")){
      const r = tokenResponse || { status: 200, body: { id_token: "SET-BY-TEST" } };
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
    }
    return new Response("unexpected", { status: 500 });
  };
  return calls;
}
/* KV スタブ */
function kvStub(initial){
  const store = new Map(Object.entries(initial || {}));
  return { store,
    get: async k => (store.has(k) ? store.get(k) : null),
    put: async (k, v) => { store.set(k, v); },
    delete: async k => { store.delete(k); } };
}
const envOK = kv => ({ JUROKU_KV: kv, GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: "test-google-secret", SESSION_SECRET: SECRET });
const req = (url, opts) => new Request(url, opts);

async function main(){
  const G = await import(F("lib/google.js"));
  const S = await import(F("lib/session.js"));
  const google = await makeGoogle();

  /* ══ google.js ══ */
  {
    const u = new URL(G.authUrl({ clientId: CLIENT_ID, redirectUri: "https://ju-roku.com/api/auth/callback", state: "st-1" }));
    assert(u.origin + u.pathname === "https://accounts.google.com/o/oauth2/v2/auth", "authUrl must point at Google's auth endpoint: " + u.href);
    assert(u.searchParams.get("response_type") === "code", "must use the authorization code flow");
    assert(u.searchParams.get("client_id") === CLIENT_ID, "client_id must be set");
    assert(u.searchParams.get("state") === "st-1", "state must be forwarded");
    assert(u.searchParams.get("scope") === "openid email", "scope must stay minimal (openid email), got " + u.searchParams.get("scope"));
    assert(u.searchParams.get("redirect_uri") === "https://ju-roku.com/api/auth/callback", "redirect_uri must be set");
    console.log("[api] authUrl OK");
  }
  {
    stubFetch(google);
    const jwt = await google.idToken({});
    /* 正しい ID トークンは通る */
    const claims = await G.verifyIdToken(jwt, { clientId: CLIENT_ID, now: NOW });
    assert(claims && claims.sub === "google-sub-123" && claims.email === "player@example.com", "a valid Google ID token must verify: " + JSON.stringify(claims));

    /* 他人向け・期限切れ・発行者違い・改ざん・別の鍵は弾く */
    const others = {
      "aud が別のアプリ":    await google.idToken({ aud: "someone-else.apps.googleusercontent.com" }),
      "期限切れ":            await google.idToken({ exp: Math.floor(NOW / 1000) - 10 }),
      "発行者が別":          await google.idToken({ iss: "https://evil.example.com" }),
    };
    for(const [name, bad] of Object.entries(others)){
      let out = null; try{ out = await G.verifyIdToken(bad, { clientId: CLIENT_ID, now: NOW }); }catch(e){ out = null; }
      assert(out === null, `${name} の ID トークンを受け入れてはいけない`);
    }
    const tampered = jwt.slice(0, jwt.lastIndexOf(".")) + "." + Buffer.from("nope").toString("base64url");
    let t = null; try{ t = await G.verifyIdToken(tampered, { clientId: CLIENT_ID, now: NOW }); }catch(e){ t = null; }
    assert(t === null, "署名を差し替えた ID トークンを受け入れてはいけない");

    const evil = await makeGoogle();                                   // 別の鍵で署名（kid は本物と同じ）
    const evilJwt = await evil.idToken({}, { kid: google.kid, key: evil.kp.privateKey });
    let e2 = null; try{ e2 = await G.verifyIdToken(evilJwt, { clientId: CLIENT_ID, now: NOW }); }catch(e){ e2 = null; }
    assert(e2 === null, "Google の JWKS に無い鍵で署名された ID トークンを受け入れてはいけない");
    console.log("[api] verifyIdToken OK (正当なものだけ通る)");
  }
  {
    stubFetch(google, { status: 400, body: { error: "invalid_grant" } });
    let threw = false;
    try{ await G.exchangeCode({ code: "bad", clientId: CLIENT_ID, clientSecret: "s", redirectUri: "https://ju-roku.com/api/auth/callback" }); }
    catch(e){ threw = true; }
    assert(threw, "トークン交換の失敗は例外にする");
    console.log("[api] exchangeCode OK");
  }

  /* ══ ハンドラ ══ */
  const login = await import(F("api/auth/login.js"));
  const callback = await import(F("api/auth/callback.js"));
  const logout = await import(F("api/auth/logout.js"));
  const me = await import(F("api/me.js"));
  const sync = await import(F("api/sync.js"));

  /* Secret 未設定なら 503（同期は使えないがゲームは動く、という状態を作る） */
  {
    const bare = { JUROKU_KV: kvStub() };
    for(const [name, res] of [["me", await me.onRequestGet({ request: req("https://ju-roku.com/api/me"), env: bare })],
                              ["sync", await sync.onRequestGet({ request: req("https://ju-roku.com/api/sync"), env: bare })],
                              ["login", await login.onRequestGet({ request: req("https://ju-roku.com/api/auth/login"), env: bare })]]){
      assert(res.status === 503, `${name}: Secret 未設定なら 503 であるべき（got ${res.status}）`);
    }
    console.log("[api] 未設定時は 503 OK");
  }

  /* /api/me は未ログインで signedIn:false */
  {
    const res = await me.onRequestGet({ request: req("https://ju-roku.com/api/me"), env: envOK(kvStub()) });
    assert(res.status === 200, "/api/me は未ログインでも 200");
    const body = await res.json();
    assert(body.signedIn === false, "未ログインは signedIn:false: " + JSON.stringify(body));
  }

  /* /api/sync は未ログインで 401（データを勝手に読み書きさせない） */
  {
    const env = envOK(kvStub());
    for(const m of ["onRequestGet", "onRequestPut", "onRequestDelete"]){
      const res = await sync[m]({ request: req("https://ju-roku.com/api/sync", { method: "PUT", body: "{}" }), env });
      assert(res.status === 401, `${m}: 未ログインは 401（got ${res.status}）`);
    }
    console.log("[api] 認証ガード OK");
  }

  /* login → state Cookie を立てて Google へ 302 */
  let stateCookie = null;
  {
    const res = await login.onRequestGet({ request: req("https://ju-roku.com/api/auth/login"), env: envOK(kvStub()) });
    assert(res.status === 302, "login は 302（got " + res.status + "）");
    const loc = res.headers.get("location");
    assert(loc.startsWith("https://accounts.google.com/o/oauth2/v2/auth"), "login は Google へ送る: " + loc);
    stateCookie = res.headers.get("set-cookie");
    assert(stateCookie && stateCookie.includes(S.STATE_COOKIE + "="), "state Cookie を立てる: " + stateCookie);
    assert(stateCookie.includes("HttpOnly") && stateCookie.includes("Secure"), "state Cookie も HttpOnly/Secure");
    const state = new URL(loc).searchParams.get("state");
    assert(state && stateCookie.includes(state.split(".")[0]), "URL の state と Cookie の state が対応する");
    console.log("[api] login OK");
  }

  /* callback: state 不一致 → 400 / 正常 → セッション Cookie を立ててトップへ */
  {
    const env = envOK(kvStub());
    const start = await login.onRequestGet({ request: req("https://ju-roku.com/api/auth/login"), env });
    const cookieHeader = start.headers.get("set-cookie").split(";")[0];
    const goodState = new URL(start.headers.get("location")).searchParams.get("state");

    const bad = await callback.onRequestGet({
      request: req("https://ju-roku.com/api/auth/callback?code=c&state=tampered", { headers: { cookie: cookieHeader } }), env });
    assert(bad.status === 400, "state 不一致は 400（CSRF 対策）got " + bad.status);

    const noCookie = await callback.onRequestGet({
      request: req("https://ju-roku.com/api/auth/callback?code=c&state=" + goodState), env });
    assert(noCookie.status === 400, "state Cookie が無ければ 400");

    stubFetch(google, { status: 200, body: { id_token: await google.idToken({}) } });
    const good = await callback.onRequestGet({
      request: req("https://ju-roku.com/api/auth/callback?code=good&state=" + goodState, { headers: { cookie: cookieHeader } }),
      env, now: NOW });
    assert(good.status === 302, "正常な callback は 302（got " + good.status + "）");
    const setCookies = good.headers.getSetCookie ? good.headers.getSetCookie() : [good.headers.get("set-cookie")];
    const session = setCookies.find(c => c && c.startsWith(S.SESSION_COOKIE + "="));
    assert(session, "セッション Cookie を立てる: " + JSON.stringify(setCookies));
    const token = session.split(";")[0].slice((S.SESSION_COOKIE + "=").length);
    const payload = await S.verifyToken(token, SECRET, NOW);
    assert(payload && payload.sub === "google-sub-123" && payload.email === "player@example.com",
      "セッションに Google の sub と email が入る: " + JSON.stringify(payload));
    console.log("[api] callback OK (state 照合・ID 検証・セッション発行)");

    /* ログイン後の /api/me */
    const meRes = await me.onRequestGet({ request: req("https://ju-roku.com/api/me", { headers: { cookie: `${S.SESSION_COOKIE}=${token}` } }), env, now: NOW });
    const meBody = await meRes.json();
    assert(meBody.signedIn === true && meBody.email === "player@example.com", "ログイン後の /api/me: " + JSON.stringify(meBody));

    /* ══ /api/sync ══ */
    const kv = kvStub({ "u:google-sub-123": JSON.stringify({ v: 1, updatedAt: 1,
      bests: { "A|normal": { s: 100, a: 50, n: 10, d: 1 } },
      tour: { cleared: { "t1": { d: 5 } } }, usertracks: [] }) });
    const env2 = envOK(kv);
    const cookie = { cookie: `${S.SESSION_COOKIE}=${token}` };

    const put = await sync.onRequestPut({ request: req("https://ju-roku.com/api/sync", { method: "PUT", headers: cookie,
      body: JSON.stringify({ bests: { "A|normal": { s: 500, a: 70, n: 10, d: 2 }, "B|hard": { s: 20, a: 20, n: 5, d: 3 } },
                             tour: { cleared: { "t2": { d: 9 } } },
                             usertracks: [{ kind: "link", url: "https://suno.com/song/x", title: "X" }] }) }), env: env2, now: NOW });
    assert(put.status === 200, "PUT /api/sync は 200（got " + put.status + "）");
    const merged = await put.json();
    assert(merged.bests["A|normal"].s === 500, "PUT は高いスコアを採用して返す");
    assert(merged.bests["B|hard"] && merged.tour.cleared["t1"] && merged.tour.cleared["t2"], "PUT は両者を併合して返す");
    assert(merged.usertracks.length === 1, "リンク曲も併合される");
    const saved = JSON.parse(kv.store.get("u:google-sub-123"));
    assert(saved.bests["A|normal"].s === 500 && saved.tour.cleared["t2"], "併合結果が KV に保存される");
    assert(saved.updatedAt === NOW, "updatedAt が更新される");

    const get = await sync.onRequestGet({ request: req("https://ju-roku.com/api/sync", { headers: cookie }), env: env2, now: NOW });
    assert((await get.json()).bests["A|normal"].s === 500, "GET は保存済みの内容を返す");

    /* 壊れた本文でも 400 で止まり、保存済みデータを壊さない */
    const bad2 = await sync.onRequestPut({ request: req("https://ju-roku.com/api/sync", { method: "PUT", headers: cookie, body: "not json" }), env: env2, now: NOW });
    assert(bad2.status === 400, "壊れた JSON は 400（got " + bad2.status + "）");
    assert(JSON.parse(kv.store.get("u:google-sub-123")).bests["A|normal"].s === 500, "壊れた本文で既存データを壊さない");

    /* DELETE は消してログアウトさせる（消した直後に再アップロードされないように） */
    const del = await sync.onRequestDelete({ request: req("https://ju-roku.com/api/sync", { method: "DELETE", headers: cookie }), env: env2, now: NOW });
    assert(del.status === 200, "DELETE は 200");
    assert(kv.store.get("u:google-sub-123") === undefined, "DELETE は KV から消す");
    const delCookies = del.headers.getSetCookie ? del.headers.getSetCookie() : [del.headers.get("set-cookie")];
    assert(delCookies.some(c => c && c.startsWith(S.SESSION_COOKIE + "=") && /Max-Age=0/.test(c)), "DELETE はセッションも失効させる: " + JSON.stringify(delCookies));
    console.log("[api] sync OK (401 / 併合保存 / 取得 / 壊れた本文 / 削除)");
  }

  /* logout は Cookie を失効させる */
  {
    const res = await logout.onRequestPost({ request: req("https://ju-roku.com/api/auth/logout", { method: "POST" }), env: envOK(kvStub()) });
    assert(res.status === 200, "logout は 200");
    assert(/Max-Age=0/.test(res.headers.get("set-cookie") || ""), "logout はセッション Cookie を失効させる");
    console.log("[api] logout OK");
  }

  /* ══ audio.js（音源の中継 — CDN を直接読めないブラウザ向けフォールバック） ══ */
  {
    const A = await import(F("api/audio.js"));
    const ID = "029ecb48-dd9c-4fd6-b4e3-f1738c592766";
    const aReq = q => ({ request: req("https://ju-roku.com/api/audio" + q) });

    /* 正常系: cdn1.suno.ai から取得して返す。Secret も KV も要らない（env 無しで動く）。 */
    let calls = [];
    globalThis.fetch = async url => { calls.push(String(url));
      return new Response("MP3BYTES", { status: 200, headers: { "content-type": "audio/mpeg" } }); };
    const ok = await A.onRequestGet(aReq("?id=" + ID));
    assert(ok.status === 200, "audio: 正常系は 200（got " + ok.status + "）");
    assert(calls.length === 1 && calls[0] === `https://cdn1.suno.ai/${ID}.mp3`, "audio: 取得先は cdn1.suno.ai の曲 URL: " + JSON.stringify(calls));
    assert(ok.headers.get("content-type") === "audio/mpeg", "audio: content-type を引き継ぐ");
    assert(/public/.test(ok.headers.get("cache-control") || ""), "audio: キャッシュ可で返す");
    assert(await ok.text() === "MP3BYTES", "audio: 本文をそのまま返す");

    /* 大文字の ID も受け、小文字にして取りに行く */
    calls = [];
    await A.onRequestGet(aReq("?id=" + ID.toUpperCase()));
    assert(calls[0] === `https://cdn1.suno.ai/${ID}.mp3`, "audio: ID は小文字化して取得する: " + calls[0]);

    /* UUID 以外は 400 で、外へは一切取りに行かない（オープンプロキシにしない） */
    calls = [];
    for(const q of ["", "?id=", "?id=abc", "?id=" + ID + "x",
                    "?id=..%2F..%2Fetc", "?id=https%3A%2F%2Fevil.example%2Fa.mp3"]){
      const bad = await A.onRequestGet(aReq(q));
      assert(bad.status === 400, `audio: 不正な id（${q}）は 400（got ${bad.status}）`);
    }
    assert(calls.length === 0, "audio: 不正な id で外部へ取りに行ってはいけない");

    /* 上流の失敗は包んで返す（404 はそのまま、他は 502。到達不能も 502） */
    globalThis.fetch = async () => new Response("denied", { status: 403 });
    assert((await A.onRequestGet(aReq("?id=" + ID))).status === 502, "audio: 上流 403 は 502");
    globalThis.fetch = async () => new Response("", { status: 404 });
    assert((await A.onRequestGet(aReq("?id=" + ID))).status === 404, "audio: 上流 404 は 404");
    globalThis.fetch = async () => { throw new Error("net down"); };
    assert((await A.onRequestGet(aReq("?id=" + ID))).status === 502, "audio: 上流到達不能は 502");
    console.log("[api] audio OK (中継 / ID 検証 / 上流エラー)");
  }

  console.log("[api] PASS — OAuth 検証・認証ガード・併合保存・削除・音源中継");
  process.exit(0);
}
main().catch(e => fail((e && e.stack) || String(e)));
