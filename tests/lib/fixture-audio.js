"use strict";
/* Deterministic synthetic "song file" bytes for tests.
 *
 * These are NOT real audio — they're an opaque ArrayBuffer whose only job is
 * to be a stable, distinct input per fixture label. The env.js AudioContext
 * stub is what turns bytes into synthetic PCM (see synthesizeFakeAudioBuffer
 * in tests/lib/env.js); this module just needs to produce the same bytes for
 * the same label, every run, forever — that's what makes tests/chart.js a
 * real regression check instead of a tautology.
 */
function makeFixtureArrayBuffer(label){
  const enc = Buffer.from(String(label), "utf8");
  const bytes = new Uint8Array(256);
  for(let i = 0; i < bytes.length; i++){
    bytes[i] = (enc[i % enc.length] ^ ((i * 37 + 11) & 0xff)) & 0xff;
  }
  return bytes.buffer;
}

module.exports = { makeFixtureArrayBuffer };
