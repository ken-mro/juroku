"use strict";
/* ═══════════════════════════════════════════════════════════════════════
 * Shared jsdom test environment for index.html.
 *
 * index.html is a single inline <script> with no bundler and no ES modules.
 * Top-level `function` declarations become properties of `window`; top-level
 * `let`/`const` do NOT, but remain reachable through `window.eval("name")`
 * because jsdom's runScripts:"dangerously" executes the page script directly
 * in the window's global scope.
 *
 * This module builds that window with everything index.html expects from a
 * browser but jsdom doesn't provide: matchMedia, ResizeObserver, an
 * AudioContext, HTMLCanvasElement 2D contexts, and a manually-pumpable
 * requestAnimationFrame queue (so tests control time deterministically
 * instead of racing real timers). `fetch` always rejects — nothing in this
 * suite may reach a real network.
 * ═══════════════════════════════════════════════════════════════════════ */

const { JSDOM } = require("jsdom");

/* ─── deterministic PRNG helpers ───
 * Used only to turn a fixed byte buffer into synthetic PCM — no real audio
 * codec involved. Same bytes in -> same "decoded audio" out, every run. */
function fnv1a(bytes){
  let h = 0x811c9dc5;
  for(let i = 0; i < bytes.length; i++){
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed){
  let a = seed >>> 0;
  return function(){
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Stands in for the browser's AudioContext.decodeAudioData(). Real decoding
 * is never exercised in tests (no codec, no network) — instead we hash the
 * input ArrayBuffer's bytes and synthesize mono/stereo PCM: silence
 * punctuated by short sharp noise bursts. detectOnsets() picks up those
 * bursts as clear spectral-flux peaks, so buildChart() has real onsets to
 * place notes on, deterministically, from the ArrayBuffer's content alone. */
function synthesizeFakeAudioBuffer(arrayBuffer){
  const bytes = new Uint8Array(arrayBuffer);
  const seed = fnv1a(bytes.length ? bytes : new Uint8Array([1]));
  const rand = mulberry32(seed);

  const sampleRate = 44100;
  const duration = 14; // seconds — enough for a meaningful chart, fast to analyze
  const length = Math.floor(sampleRate * duration);
  const data = new Float32Array(length);

  let t = 0.30 + rand() * 0.20;
  while(t < duration - 0.30){
    const burstDur = 0.05 + rand() * 0.05;     // 50-100ms sharp burst
    const amp = 0.55 + rand() * 0.35;          // strong, well above noise floor
    const startIdx = Math.floor(t * sampleRate);
    const burstLen = Math.floor(burstDur * sampleRate);
    for(let i = 0; i < burstLen; i++){
      const idx = startIdx + i;
      if(idx >= length) break;
      const decay = 1 - i / burstLen;          // instant attack, quick decay
      data[idx] = (rand() * 2 - 1) * amp * decay;
    }
    t += 0.40 + rand() * 0.55;                 // next burst 0.40-0.95s later
  }

  return {
    sampleRate,
    length,
    numberOfChannels: 2,
    duration: length / sampleRate,
    getChannelData(){ return data; }, // same data on both channels; downmix() averages them
  };
}

class FakeAudioContext {
  constructor(){
    this.currentTime = 0;      // tests move this forward directly — no real wall-clock
    this.state = "running";
    this.destination = {};
    this.outputLatency = 0;
    this.baseLatency = 0;
  }
  resume(){ this.state = "running"; return Promise.resolve(); }
  suspend(){ this.state = "suspended"; return Promise.resolve(); }
  decodeAudioData(arrayBuffer){
    try{ return Promise.resolve(synthesizeFakeAudioBuffer(arrayBuffer)); }
    catch(e){ return Promise.reject(e); }
  }
  createBufferSource(){
    return {
      buffer: null,
      connect(){},
      start(t){ this._startAt = t; },
      stop(){},
      onended: null,
    };
  }
}

/* jsdom has no canvas backend by default: HTMLCanvasElement.getContext("2d")
 * returns null. index.html draws every frame unconditionally (draw() calls
 * g.clearRect(...) with no guard), so we hand it a no-op 2D context that
 * accepts every call the app makes (enumerated by grepping index.html for
 * canvas-context method/property usage under all its local var names: g, c, x). */
function makeFakeCanvasContext(){
  const ctx = {};
  const noop = [
    "arc", "arcTo", "beginPath", "bezierCurveTo", "clearRect", "clip",
    "closePath", "drawImage", "ellipse", "fill", "fillRect", "fillText",
    "lineTo", "moveTo", "quadraticCurveTo", "rect", "resetTransform",
    "restore", "rotate", "save", "scale", "setLineDash", "setTransform",
    "stroke", "strokeRect", "strokeText", "translate",
  ];
  for(const m of noop) ctx[m] = () => {};
  ctx.createLinearGradient = () => ({ addColorStop(){} });
  ctx.createRadialGradient = () => ({ addColorStop(){} });
  ctx.createPattern = () => null;
  ctx.measureText = () => ({ width: 0 });
  ctx.getImageData = () => ({ data: new Uint8ClampedArray(4) });
  ctx.putImageData = () => {};
  // plain settable style properties (values never inspected, just written)
  Object.assign(ctx, {
    fillStyle: "#000", strokeStyle: "#000", font: "10px sans-serif",
    globalAlpha: 1, lineWidth: 1, lineCap: "butt", lineJoin: "miter",
    shadowBlur: 0, shadowColor: "transparent",
    textAlign: "start", textBaseline: "alphabetic",
  });
  return ctx;
}

class FakeAudio {
  constructor(){ this.preload = ""; this._src = ""; this.onloadedmetadata = null; this.onerror = null; }
  get src(){ return this._src; }
  set src(v){ this._src = v; }
  play(){ return Promise.resolve(); }
  pause(){}
}

/**
 * Build a fresh jsdom environment with index.html loaded and running.
 * @param {string} html - index.html source
 * @returns {{dom, window, document, pumpFrame: () => void, testErrors: string[]}}
 */
function buildEnv(html){
  const testErrors = [];

  const dom = new JSDOM(html, {
    url: "http://localhost/",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window){
      window.addEventListener("error", e => {
        const err = e.error;
        testErrors.push((err && (err.stack || err.message)) || e.message || String(e));
      });
      window.addEventListener("unhandledrejection", e => {
        const r = e.reason;
        testErrors.push((r && (r.stack || r.message)) || String(r));
      });

      // Only query used in index.html: prefers-reduced-motion. Resolve false
      // (motion on) so the app's default animated code paths run in tests.
      window.matchMedia = () => ({
        matches: false,
        media: "",
        addListener(){}, removeListener(){},
        addEventListener(){}, removeEventListener(){},
        dispatchEvent(){ return false; },
      });

      window.ResizeObserver = class { observe(){} unobserve(){} disconnect(){} };

      window.fetch = () => Promise.reject(new Error("offline (test env — no real network access)"));

      window.AudioContext = FakeAudioContext;
      window.webkitAudioContext = FakeAudioContext;

      window.HTMLCanvasElement.prototype.getContext = function(type){
        return type === "2d" ? makeFakeCanvasContext() : null;
      };

      window.Audio = FakeAudio;

      // prepare()'s small decode/build pauses and togglePause()'s 3-2-1
      // resume countdown (630ms steps) both use real setTimeout. Clamp
      // delays so tests don't burn wall-clock time waiting on them — the
      // callback still fires asynchronously, in the same order, just sooner.
      const realSetTimeout = window.setTimeout.bind(window);
      window.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, Math.min(ms || 0, 5), ...args);

      // Manually-pumpable requestAnimationFrame queue instead of a real
      // timer loop, so tests can advance the game frame-by-frame on demand.
      const rafQueue = [];
      window.__rafQueue = rafQueue;
      window.requestAnimationFrame = cb => { rafQueue.push(cb); return rafQueue.length; };
      window.cancelAnimationFrame = () => {};
    },
  });

  const { window } = dom;

  function pumpFrame(){
    const queue = window.__rafQueue.splice(0, window.__rafQueue.length);
    for(const cb of queue){
      try{ cb(0); }
      catch(e){ testErrors.push((e && e.stack) || String(e)); }
    }
  }

  return { dom, window, document: window.document, pumpFrame, testErrors };
}

module.exports = { buildEnv, synthesizeFakeAudioBuffer, fnv1a, mulberry32 };
