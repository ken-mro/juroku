/* 音源の中継（フォールバック）。
 *
 * ブラウザが cdn1.suno.ai を直接読めないことがある（CORS ヘッダの欠落・
 * ホットリンク遮断・一時的な 403 など、Suno 側の配信設定に依存する）。
 * その場合にクライアントが同一オリジンの /api/audio?id=<曲ID> へやり直し、
 * この Worker がサーバー側で取得して返す。サーバー間の取得には CORS が無い。
 *
 * - 秘密情報も KV も使わないため、同期が未構成（Secret 未設定）でも動く。
 * - id は Suno の曲 ID（UUID）に限定する。任意 URL は受けない
 *   （オープンプロキシにしない）。
 * - Cloudflare のエッジキャッシュに 1 日載せ、同じ曲の取得で
 *   毎回 Suno へ行かないようにする。
 */

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const jerr = (error, status) => new Response(JSON.stringify({ error }),
  { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

export async function onRequestGet({ request }){
  const id = (new URL(request.url).searchParams.get("id") || "").toLowerCase();
  if(!ID_RE.test(id)) return jerr("bad_id", 400);

  let up;
  try{
    up = await fetch(`https://cdn1.suno.ai/${id}.mp3`,
      { cf: { cacheEverything: true, cacheTtl: 86400 } });
  }catch(_){
    return jerr("upstream_unreachable", 502);
  }
  if(!up.ok) return jerr("upstream_" + up.status, up.status === 404 ? 404 : 502);

  const h = new Headers({
    "content-type": up.headers.get("content-type") || "audio/mpeg",
    "cache-control": "public, max-age=86400",
  });
  const len = up.headers.get("content-length");
  if(len) h.set("content-length", len);
  return new Response(up.body, { status: 200, headers: h });
}
