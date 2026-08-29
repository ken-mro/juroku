/* 音源の中継（フォールバック）。
 *
 * Suno は cdn1.suno.ai を CloudFront の署名付き URL 必須に変更した
 * （素の /{id}.mp3 は 403 <Error><Code>MissingKey</Code>…）。ブラウザからの
 * 直接取得はもう当てにできないため、クライアントが同一オリジンの
 * /api/audio?id=<曲ID> へやり直し、この Worker がサーバー側で
 * 「いま有効な音源 URL」を見つけて取得し、返す。
 *
 * 取得順:
 *   1. https://cdn1.suno.ai/{id}.mp3       — 署名が不要だった頃の URL（戻った時のため）
 *   2. https://cdn1.suno.ai/{id}.mp4       — 同じ曲の動画。署名不要で音声トラックを含む（本命）
 *   3. https://suno.com/song/{id} のページに埋め込まれた audio_url（署名付き URL が入る）
 *
 * かつて使っていた audiopipe.suno.ai は、いまは 200 を返しつつ本文が空
 * （content-length も無い chunked）になり、「デコードできない音声」として
 * 素通りしてしまうため外した。動画 URL(.mp4)がその役目を確実に果たす。
 *
 * - 秘密情報も KV も使わないため、同期が未構成（Secret 未設定）でも動く。
 * - id は Suno の曲 ID（UUID）に限定する。任意 URL は受けない
 *   （オープンプロキシにしない）。ページから拾った audio_url も
 *   Suno のドメイン（*.suno.ai / *.suno.com）以外なら捨てる。
 * - 成功した応答は Cache API で 1 日キャッシュし、同じ曲の取得で
 *   毎回 Suno へ行かないようにする（署名付き URL は短命なので、
 *   URL ではなく音声データの方をキャッシュする）。
 */

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUNO_HOST_RE = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.suno\.(ai|com)\//i;

const jerr = (error, status) => new Response(JSON.stringify({ error }),
  { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

/* ページの HTML から audio_url の値を取り出す。埋め込み JSON は素の
   `"audio_url":"https://…"` の形でも、文字列内にさらにエスケープされた
   `\"audio_url\":\"https:\/\/…\"` の形でも現れるため、`audio_url` の直後から
   https: を見つけて「エスケープを解きながら引用符まで」を読む。 */
export function extractAudioUrl(html){
  const re = /audio_url/g;
  let m;
  while((m = re.exec(html))){
    const start = html.indexOf("https:", m.index);
    if(start < 0) break;
    if(start - m.index > 16) continue;          // audio_url\":\" 程度の距離に無ければ別物
    let u = "", i = start;
    while(i < html.length){
      const c = html[i];
      if(c === '"' || c === "'" || c === "<" || c === " ") break;
      if(c === "\\"){
        const n = html[i + 1];
        if(n === "/"){ u += "/"; i += 2; continue; }
        if(n === "u"){ const h = html.slice(i + 2, i + 6);
          if(/^[0-9a-f]{4}$/i.test(h)){ u += String.fromCharCode(parseInt(h, 16)); i += 6; continue; } }
        break;                                   // \" ＝文字列の終端
      }
      u += c; i++;
    }
    if(SUNO_HOST_RE.test(u)) return u;
  }
  return "";
}

async function tryFetch(fn){
  try{ const res = await fn(); return res && res.ok ? res : null; }
  catch(_){ return null; }
}
/* 200 でもエラーページ（HTML/XML）や中身の無い応答が返ることがある。音声として
   通すのは content-type が明らかに文書でなく、かつ空でない（content-length が 0 でない）
   ものだけ。 */
async function tryFetchAudio(fn){
  const res = await tryFetch(fn);
  if(!res) return null;
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  if(/html|xml|json/.test(ct)) return null;
  if(res.headers.get("content-length") === "0") return null;
  return res;
}

export async function onRequestGet({ request, ctx }){
  const id = (new URL(request.url).searchParams.get("id") || "").toLowerCase();
  if(!ID_RE.test(id)) return jerr("bad_id", 400);

  /* エッジキャッシュ（成功時のみ put する） */
  const cache = (globalThis.caches && globalThis.caches.default) || null;
  const cacheKey = new Request(new URL("/api/audio?id=" + id, request.url), { method: "GET" });
  if(cache){
    const hit = await cache.match(cacheKey);
    if(hit) return hit;
  }

  let up =
    await tryFetchAudio(() => fetch(`https://cdn1.suno.ai/${id}.mp3`)) ||
    await tryFetchAudio(() => fetch(`https://cdn1.suno.ai/${id}.mp4`));
  if(!up){
    const page = await tryFetch(() => fetch(`https://suno.com/song/${id}`,
      { headers: { accept: "text/html" } }));
    if(page){
      const u = extractAudioUrl(await page.text());
      if(u) up = await tryFetchAudio(() => fetch(u));
    }
  }
  if(!up) return jerr("upstream_failed", 502);

  const h = new Headers({
    "content-type": up.headers.get("content-type") || "audio/mpeg",
    "cache-control": "public, max-age=86400",
  });
  const len = up.headers.get("content-length");
  if(len) h.set("content-length", len);
  const res = new Response(up.body, { status: 200, headers: h });
  if(cache){
    const put = cache.put(cacheKey, res.clone());
    if(ctx && ctx.waitUntil) ctx.waitUntil(put);
  }
  return res;
}
