/* 音源の配信と中継。
 *
 * Suno は 2026-08 に素の cdn1.suno.ai/{id}.mp3 を CloudFront の署名付き URL 必須に変え
 * （403 <Error><Code>MissingKey</Code>…）、audiopipe.suno.ai は「200 + audio/mp3 なのに
 * 本文 0 バイト」の死んだ応答になり、曲ページの audio_url も認証必須の /api/forbidden に
 * 差し替えられた。匿名で読める素の mp3 はもう存在しない。
 * （この時期、中継が動画ファイル cdn1.suno.ai/{id}.mp4 を拾って配信し、デコード波形が
 *   変わって譜面が mp3 時代と別物になっていた。）
 *
 * そこで収録曲・ツアー曲（作者自身の曲）の mp3 は R2 バケット juroku-audio に
 * {id}.mp3 として自前で持ち、それを最優先で返す。譜面はデコード後の PCM から
 * 決定的に生成されるため、音源のバイト列を固定すれば譜面も永久に固定される。
 * Suno 側の仕様変更に二度と影響されない。
 *
 * 取得順:
 *   0. R2（juroku-audio/{id}.mp3）           — 収録曲・ツアー曲はここで確定
 *   1. https://cdn1.suno.ai/{id}.mp3         — 署名が不要だった頃の URL（戻った時のため）
 *   2. https://cdn1.suno.ai/{id}.mp4         — 同じ曲の動画。署名不要で音声トラックを含む。
 *      プレイヤーが URL を貼った「リンク曲」は R2 に無いので、mp3 が塞がれている間は
 *      これで再生だけは保つ（譜面は mp3 とは変わるが、再生不能よりよい）
 *   3. https://suno.com/song/{id} のページに埋め込まれた audio_url（署名付き URL が入る）
 *
 * - 1〜3 は本文をバッファして空の応答を弾く（audiopipe が「200 なのに空」を返した実例
 *   への対策。content-length を欠く chunked の空応答もこれで確実に検出できる）。
 * - 秘密情報も KV も使わないため、同期が未構成（Secret 未設定）でも動く。
 * - id は Suno の曲 ID（UUID）に限定する。任意 URL は受けない
 *   （オープンプロキシにしない）。ページから拾った audio_url も
 *   Suno のドメイン（*.suno.ai / *.suno.com）以外なら捨てる。
 * - 成功した応答は Cache API に載せ、同じ曲の取得で毎回 R2 / Suno へ行かないようにする。
 *   キャッシュキーの v= は世代番号。mp4 を配信していた頃のキャッシュを無効化するため v=2。
 */

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUNO_HOST_RE = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.suno\.(ai|com)\//i;
const CACHE_VER = "2";

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
/* 200 でもエラーページ（HTML/XML）や中身の無い応答が返ることがある。音声として通すのは
   content-type が明らかに文書でなく、本文が空でないものだけ。本文はここでバッファする
   （曲は数 MB なので Worker のメモリに収まり、content-length の無い chunked の
   空応答も確実に弾ける）。 */
async function tryFetchAudio(fn){
  const res = await tryFetch(fn);
  if(!res) return null;
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  if(/html|xml|json/.test(ct)) return null;
  let buf;
  try{ buf = await res.arrayBuffer(); }catch(_){ return null; }
  if(!buf || buf.byteLength === 0) return null;
  return { buf, contentType: res.headers.get("content-type") || "audio/mpeg" };
}

export async function onRequestGet({ request, env, ctx }){
  const id = (new URL(request.url).searchParams.get("id") || "").toLowerCase();
  if(!ID_RE.test(id)) return jerr("bad_id", 400);

  /* エッジキャッシュ（成功時のみ put する） */
  const cache = (globalThis.caches && globalThis.caches.default) || null;
  const cacheKey = new Request(new URL("/api/audio?id=" + id + "&v=" + CACHE_VER, request.url), { method: "GET" });
  if(cache){
    const hit = await cache.match(cacheKey);
    if(hit) return hit;
  }

  const respond = (body, contentType, maxAge, extra) => {
    const h = new Headers({
      "content-type": contentType,
      "cache-control": "public, max-age=" + maxAge,
      ...extra,
    });
    const res = new Response(body, { status: 200, headers: h });
    if(cache){
      const put = cache.put(cacheKey, res.clone());
      if(ctx && ctx.waitUntil) ctx.waitUntil(put);
    }
    return res;
  };

  /* 0. R2（自前ホストの mp3）。バイト列が固定なので譜面も固定される。 */
  const bucket = env && env.JUROKU_AUDIO;
  if(bucket){
    let obj = null;
    try{ obj = await bucket.get(id + ".mp3"); }catch(_){ obj = null; }
    if(obj) return respond(obj.body, "audio/mpeg", 2592000,
      obj.httpEtag ? { etag: obj.httpEtag } : undefined);
  }

  /* 1〜3. Suno 側（リンク曲、または R2 に未収録の曲） */
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

  return respond(up.buf, up.contentType, 86400);
}
