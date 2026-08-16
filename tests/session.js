#!/usr/bin/env node
"use strict";
/* tests/session.js — セッションの署名／検証と Cookie（functions/_lib/session.js）
 *
 * セッション Cookie は「ログインしている本人であること」の唯一の根拠なので、
 * 改ざん・期限切れ・別の鍵で署名されたものを確実に弾けることを確認する。
 */
const path = require("path");
const { pathToFileURL } = require("url");
function fail(msg){ console.error("[session] FAIL: " + msg); process.exit(1); }
const assert = (c, m) => { if(!c) fail(m); };

async function main(){
  const S = await import(pathToFileURL(path.join(__dirname, "..", "functions", "_lib", "session.js")).href);
  const SECRET = "test-secret-do-not-use-in-production";
  const now = 1_700_000_000_000;

  /* ── 往復 ── */
  const token = await S.signToken({ sub: "1234567890", email: "a@example.com" }, SECRET, now, 90 * 86400);
  assert(typeof token === "string" && token.split(".").length === 2, "token must be '<payload>.<signature>', got " + token);
  const ok = await S.verifyToken(token, SECRET, now);
  assert(ok && ok.sub === "1234567890" && ok.email === "a@example.com", "a freshly signed token must verify: " + JSON.stringify(ok));

  /* ── 改ざんを拒否 ── */
  const [p, sig] = token.split(".");
  const forgedPayload = Buffer.from(JSON.stringify({ sub: "999", email: "evil@example.com", iat: now, exp: now + 1000 }))
    .toString("base64url");
  assert(await S.verifyToken(forgedPayload + "." + sig, SECRET, now) === null, "a swapped payload must be rejected");
  assert(await S.verifyToken(p + "." + sig.slice(0, -2) + "AA", SECRET, now) === null, "a tampered signature must be rejected");
  assert(await S.verifyToken(p, SECRET, now) === null, "a token without a signature must be rejected");
  assert(await S.verifyToken("", SECRET, now) === null, "an empty token must be rejected");
  assert(await S.verifyToken(null, SECRET, now) === null, "a null token must be rejected");

  /* ── 別の鍵・期限切れを拒否 ── */
  assert(await S.verifyToken(token, "another-secret", now) === null, "a token signed with another secret must be rejected");
  assert(await S.verifyToken(token, SECRET, now + 91 * 86400 * 1000) === null, "an expired token must be rejected");
  assert(await S.verifyToken(token, SECRET, now + 89 * 86400 * 1000) !== null, "a token inside its lifetime must still verify");

  /* ── Cookie の組み立て ── */
  const set = S.setCookie(S.SESSION_COOKIE, token, { maxAge: 100 });
  for(const bit of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=100"]){
    assert(set.includes(bit), `Set-Cookie must contain ${bit}: ${set}`);
  }
  assert(set.startsWith(S.SESSION_COOKIE + "="), "Set-Cookie must start with the cookie name");
  const cleared = S.clearCookie(S.SESSION_COOKIE);
  assert(/Max-Age=0/.test(cleared), "clearCookie must expire the cookie immediately: " + cleared);

  /* ── Cookie の読み取り（複数・空白・存在しない） ── */
  const req = h => ({ headers: { get: k => (k.toLowerCase() === "cookie" ? h : null) } });
  assert(S.getCookie(req(`a=1; ${S.SESSION_COOKIE}=${token}; b=2`), S.SESSION_COOKIE) === token, "must read a cookie among others");
  assert(S.getCookie(req(`${S.SESSION_COOKIE}=${token}`), S.SESSION_COOKIE) === token, "must read a lone cookie");
  assert(S.getCookie(req("a=1"), S.SESSION_COOKIE) === null, "a missing cookie must be null");
  assert(S.getCookie(req(null), S.SESSION_COOKIE) === null, "no Cookie header must be null");
  assert(S.getCookie(req(`${S.SESSION_COOKIE}x=nope`), S.SESSION_COOKIE) === null, "a cookie whose name only shares a prefix must not match");

  /* ── リクエストからセッションを取り出す ── */
  const sess = await S.readSession(req(`${S.SESSION_COOKIE}=${token}`), SECRET, now);
  assert(sess && sess.sub === "1234567890", "readSession must return the payload for a valid cookie");
  assert(await S.readSession(req("nothing=1"), SECRET, now) === null, "readSession must return null without a cookie");

  console.log("[session] PASS — 署名往復・改ざん/期限切れ/別鍵の拒否・Cookie 属性と読み取り");
  process.exit(0);
}
main().catch(e => fail((e && e.stack) || String(e)));
