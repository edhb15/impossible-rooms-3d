/* =====================================================================
   IMPOSSIBLE ROOMS
   A first-person puzzle game of impossible architecture.
   Rendering: three.js (WebGL 2). Audio: Web Audio API (procedural).
   ===================================================================== */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

window.__IR_MODULE_LOADED = true;

/* ---------------------------------------------------------------------
   Small math helpers
   --------------------------------------------------------------------- */
const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const AXES = [V3(1, 0, 0), V3(-1, 0, 0), V3(0, 1, 0), V3(0, -1, 0), V3(0, 0, 1), V3(0, 0, -1)];
const Y_UP = V3(0, 1, 0);
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();

function snapAxis(v) {
  let best = AXES[2], bd = -Infinity;
  for (const a of AXES) {
    const d = a.dot(v);
    if (d > bd) { bd = d; best = a; }
  }
  return best.clone();
}
function axisIndexOf(v) {
  const ax = Math.abs(v.x), ay = Math.abs(v.y), az = Math.abs(v.z);
  return ax > ay && ax > az ? 0 : ay > az ? 1 : 2;
}
function comp(v, i) { return i === 0 ? v.x : i === 1 ? v.y : v.z; }
function setComp(v, i, val) { if (i === 0) v.x = val; else if (i === 1) v.y = val; else v.z = val; }
function formatTime(s) {
  if (s == null || !isFinite(s)) return '--:--.-';
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${String(m).padStart(2, '0')}:${sec.toFixed(1).padStart(4, '0')}`;
}
function rand(a, b) { return a + Math.random() * (b - a); }
// Deterministic PRNG so procedural layouts are identical every time a level loads.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const GRAVITY_NAMES = { '0,1,0': 'FLOOR', '0,-1,0': 'CEILING', '1,0,0': 'WEST WALL', '-1,0,0': 'EAST WALL', '0,0,1': 'NORTH WALL', '0,0,-1': 'SOUTH WALL' };
// True while touch controls are active; lets text name the right control.
let TOUCH = false;
const ctl = (desktop, touch) => (TOUCH ? touch : desktop);
function gravityName(up) { return GRAVITY_NAMES[`${Math.round(up.x)},${Math.round(up.y)},${Math.round(up.z)}`] || 'UNKNOWN'; }

/* ---------------------------------------------------------------------
   Persistent save data (localStorage)
   --------------------------------------------------------------------- */
const SAVE_KEY = 'impossibleRooms.save.v1';
const LEVEL_COUNT = 5;
const DEFAULT_SETTINGS = {
  master: 0.8, music: 0.55, sfx: 0.85, muted: false,
  sensitivity: 1.0, invertY: false, fov: 75,
  quality: 'high', hints: false, headBob: true, touch: 'auto',
};

class SaveData {
  constructor() {
    this.data = this.fresh();
    this.isNew = true;
    this.load();
  }
  fresh() {
    return {
      unlocked: 1,
      completed: new Array(LEVEL_COUNT).fill(false),
      bestTimes: new Array(LEVEL_COUNT).fill(null),
      lastTimes: new Array(LEVEL_COUNT).fill(null),
      settings: { ...DEFAULT_SETTINGS },
    };
  }
  load() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      this.isNew = !raw;
      if (!raw) return;
      const d = JSON.parse(raw);
      const f = this.fresh();
      this.data = {
        unlocked: clamp(Number(d.unlocked) || 1, 1, LEVEL_COUNT),
        completed: f.completed.map((_, i) => !!(d.completed && d.completed[i])),
        bestTimes: f.bestTimes.map((_, i) => (d.bestTimes && typeof d.bestTimes[i] === 'number' ? d.bestTimes[i] : null)),
        lastTimes: f.lastTimes.map((_, i) => (d.lastTimes && typeof d.lastTimes[i] === 'number' ? d.lastTimes[i] : null)),
        settings: { ...DEFAULT_SETTINGS, ...(d.settings || {}) },
      };
    } catch (e) {
      console.warn('Save data could not be read; starting fresh.', e);
    }
  }
  save() {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(this.data)); } catch (e) { /* storage unavailable (private mode) */ }
  }
  get settings() { return this.data.settings; }
  completeLevel(i, time) {
    const d = this.data;
    d.completed[i] = true;
    d.lastTimes[i] = time;
    if (d.bestTimes[i] == null || time < d.bestTimes[i]) d.bestTimes[i] = time;
    d.unlocked = clamp(Math.max(d.unlocked, i + 2), 1, LEVEL_COUNT);
    this.save();
  }
  resetProgress() {
    const s = this.data.settings;
    this.data = this.fresh();
    this.data.settings = s;
    this.save();
  }
  get completedCount() { return this.data.completed.filter(Boolean).length; }
}

/* ---------------------------------------------------------------------
   Procedural audio (Web Audio API). Every sound is synthesised.
   --------------------------------------------------------------------- */
class AudioEngine {
  constructor(settings) {
    this.settings = settings;
    this.ctx = null;
    this.ambientNodes = [];
    this.padTimer = 0;
    this.profile = null;
  }
  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try { this.ctx = new AC(); } catch (e) { this.ctx = null; return; }
    const c = this.ctx;
    this.out = c.createDynamicsCompressor();
    this.out.threshold.value = -16;
    this.out.ratio.value = 4;
    this.out.connect(c.destination);
    this.master = c.createGain();
    this.master.connect(this.out);
    this.music = c.createGain();
    this.sfx = c.createGain();
    this.music.connect(this.master);
    this.sfx.connect(this.master);
    // Shared reverb send gives the facility its cavernous feel.
    this.reverb = c.createConvolver();
    this.reverb.buffer = this.makeImpulse(3.2, 2.6);
    this.reverbGain = c.createGain();
    this.reverbGain.gain.value = 0.32;
    this.reverb.connect(this.reverbGain);
    this.reverbGain.connect(this.master);
    this.noiseBuf = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
    const ch = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
    this.applyVolumes();
    if (this.profile) this.startAmbient(this.profile);
  }
  get ready() { return !!this.ctx && this.ctx.state !== 'closed'; }
  makeImpulse(seconds, decay) {
    const c = this.ctx, len = Math.floor(c.sampleRate * seconds);
    const buf = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }
  applyVolumes() {
    if (!this.ctx) return;
    const s = this.settings, t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(s.muted ? 0 : s.master, t, 0.05);
    this.music.gain.setTargetAtTime(s.music, t, 0.05);
    this.sfx.gain.setTargetAtTime(s.sfx, t, 0.05);
  }
  // ---- primitives -------------------------------------------------
  tone({ type = 'sine', f = 440, f2 = null, dur = 0.2, vol = 0.2, attack = 0.005, delay = 0, dest = null, rev = 0.2, curve = 'exp', detune = 0, lp = null }) {
    if (!this.ready) return;
    const c = this.ctx, t0 = c.currentTime + delay;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f, t0);
    o.detune.value = detune;
    if (f2 != null) {
      if (curve === 'exp') o.frequency.exponentialRampToValueAtTime(Math.max(1, f2), t0 + dur);
      else o.frequency.linearRampToValueAtTime(f2, t0 + dur);
    }
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    let node = o;
    if (lp) {
      const fl = c.createBiquadFilter();
      fl.type = 'lowpass'; fl.frequency.value = lp;
      o.connect(fl); node = fl;
    }
    node.connect(g);
    g.connect(dest || this.sfx);
    if (rev > 0) { const s = c.createGain(); s.gain.value = rev; g.connect(s); s.connect(this.reverb); }
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }
  noise({ dur = 0.2, vol = 0.2, type = 'bandpass', f = 1000, f2 = null, q = 1, attack = 0.005, delay = 0, dest = null, rev = 0.2 }) {
    if (!this.ready) return;
    const c = this.ctx, t0 = c.currentTime + delay;
    const src = c.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const fl = c.createBiquadFilter();
    fl.type = type; fl.Q.value = q;
    fl.frequency.setValueAtTime(f, t0);
    if (f2 != null) fl.frequency.exponentialRampToValueAtTime(Math.max(20, f2), t0 + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(fl); fl.connect(g); g.connect(dest || this.sfx);
    if (rev > 0) { const s = c.createGain(); s.gain.value = rev; g.connect(s); s.connect(this.reverb); }
    src.start(t0, Math.random() * 1.5);
    src.stop(t0 + dur + 0.05);
  }
  // ---- sound effects ----------------------------------------------
  footstep(sprint) {
    const v = sprint ? 0.16 : 0.12;
    this.noise({ dur: 0.09, vol: v, type: 'lowpass', f: rand(500, 900), q: 0.7, rev: 0.08 });
    this.tone({ type: 'sine', f: rand(70, 95), f2: 45, dur: 0.08, vol: v * 0.9, rev: 0.05 });
  }
  jump() { this.noise({ dur: 0.18, vol: 0.06, type: 'bandpass', f: 600, f2: 1400, q: 0.8, rev: 0.05 }); }
  land(strength = 1) {
    const v = clamp(0.12 * strength, 0.08, 0.32);
    this.tone({ type: 'sine', f: 90, f2: 38, dur: 0.22, vol: v, rev: 0.1 });
    this.noise({ dur: 0.14, vol: v * 0.7, type: 'lowpass', f: 700, rev: 0.1 });
  }
  click() {
    this.tone({ type: 'square', f: 1400, f2: 700, dur: 0.05, vol: 0.06, lp: 3000, rev: 0.05 });
    this.noise({ dur: 0.03, vol: 0.08, type: 'highpass', f: 3000, rev: 0.05 });
  }
  switchOn() {
    this.click();
    this.tone({ type: 'triangle', f: 520, f2: 880, dur: 0.22, vol: 0.12, delay: 0.04, rev: 0.25 });
    this.tone({ type: 'sine', f: 1320, dur: 0.35, vol: 0.06, delay: 0.12, rev: 0.4 });
  }
  deny() {
    this.tone({ type: 'sawtooth', f: 150, dur: 0.14, vol: 0.08, lp: 900 });
    this.tone({ type: 'sawtooth', f: 120, dur: 0.18, vol: 0.08, lp: 900, delay: 0.15 });
  }
  pickup() { this.tone({ type: 'triangle', f: 380, f2: 760, dur: 0.14, vol: 0.1, rev: 0.15 }); }
  drop() { this.tone({ type: 'triangle', f: 600, f2: 260, dur: 0.16, vol: 0.09, rev: 0.15 }); }
  thud(strength = 1) { this.tone({ type: 'sine', f: 110, f2: 45, dur: 0.2, vol: clamp(0.06 * strength, 0.03, 0.2), rev: 0.15 }); }
  plate(on) {
    this.tone({ type: 'sine', f: on ? 180 : 240, f2: on ? 120 : 300, dur: 0.18, vol: 0.12, rev: 0.2 });
    this.noise({ dur: 0.08, vol: 0.06, type: 'lowpass', f: 900 });
    if (on) this.tone({ type: 'sine', f: 880, dur: 0.3, vol: 0.05, delay: 0.08, rev: 0.4 });
  }
  door(open) {
    this.noise({ dur: 1.0, vol: 0.12, type: 'bandpass', f: open ? 180 : 500, f2: open ? 520 : 160, q: 1.2, attack: 0.08, rev: 0.25 });
    this.tone({ type: 'sawtooth', f: open ? 55 : 80, f2: open ? 82 : 50, dur: 0.95, vol: 0.06, lp: 400, attack: 0.08, rev: 0.2 });
    this.tone({ type: 'sine', f: 70, f2: 40, dur: 0.25, vol: 0.18, delay: 0.9, rev: 0.3 });
  }
  portal() {
    this.tone({ type: 'sine', f: 220, f2: 1400, dur: 0.45, vol: 0.12, rev: 0.5 });
    this.noise({ dur: 0.5, vol: 0.1, type: 'bandpass', f: 400, f2: 4000, q: 2, rev: 0.5 });
    this.tone({ type: 'triangle', f: 1760, dur: 0.5, vol: 0.04, delay: 0.25, rev: 0.6 });
  }
  teleport() {
    this.noise({ dur: 0.7, vol: 0.14, type: 'bandpass', f: 3000, f2: 200, q: 3, rev: 0.6 });
    this.tone({ type: 'sine', f: 900, f2: 120, dur: 0.6, vol: 0.12, rev: 0.6 });
  }
  glitch() {
    for (let i = 0; i < 7; i++) this.tone({ type: 'square', f: rand(80, 900), dur: 0.05, vol: 0.06, delay: i * 0.045, lp: 2500, rev: 0.1 });
    this.noise({ dur: 0.4, vol: 0.1, type: 'highpass', f: 1500, rev: 0.3 });
  }
  gravity() {
    this.tone({ type: 'sine', f: 240, f2: 38, dur: 0.9, vol: 0.22, rev: 0.4 });
    this.noise({ dur: 0.9, vol: 0.12, type: 'lowpass', f: 1600, f2: 120, q: 3, rev: 0.4 });
    this.tone({ type: 'triangle', f: 660, f2: 990, dur: 0.4, vol: 0.05, delay: 0.05, rev: 0.6 });
  }
  rumble(dur = 2) {
    this.noise({ dur, vol: 0.2, type: 'lowpass', f: 140, q: 1, attack: 0.3, rev: 0.4 });
    this.tone({ type: 'sawtooth', f: 38, f2: 46, dur, vol: 0.1, lp: 200, attack: 0.3, curve: 'lin', rev: 0.3 });
    this.tone({ type: 'sine', f: 60, f2: 30, dur: 0.4, vol: 0.2, delay: dur - 0.1, rev: 0.4 });
  }
  core() {
    this.tone({ type: 'sine', f: 220, f2: 880, dur: 0.6, vol: 0.12, rev: 0.4 });
    [659, 880, 1318].forEach((f, i) => this.tone({ type: 'triangle', f, dur: 0.7, vol: 0.06, delay: 0.25 + i * 0.09, rev: 0.6 }));
  }
  chime() {
    [523.25, 659.25, 783.99].forEach((f, i) => this.tone({ type: 'sine', f, dur: 0.9, vol: 0.08, delay: i * 0.1, rev: 0.6, dest: this.music }));
  }
  perspective() {
    this.noise({ dur: 1.6, vol: 0.1, type: 'bandpass', f: 200, f2: 3000, q: 4, attack: 1.2, rev: 0.7 });
    [392, 493.88, 587.33, 783.99].forEach((f, i) => this.tone({ type: 'sine', f, dur: 1.8, vol: 0.06, attack: 0.3, delay: 0.6 + i * 0.12, rev: 0.7, dest: this.music }));
  }
  levelComplete() {
    const notes = [523.25, 659.25, 783.99, 987.77, 1046.5];
    notes.forEach((f, i) => this.tone({ type: 'triangle', f, dur: 1.4, vol: 0.08, delay: i * 0.11, rev: 0.7, dest: this.music }));
    [261.63, 329.63, 392].forEach((f) => this.tone({ type: 'sine', f, dur: 2.5, vol: 0.06, attack: 0.4, rev: 0.6, dest: this.music }));
  }
  finale() {
    if (!this.ready) return;
    const chords = [[220, 277.18, 329.63], [196, 246.94, 293.66], [174.61, 220, 261.63], [261.63, 329.63, 392, 523.25]];
    chords.forEach((ch, ci) => ch.forEach((f) => {
      this.tone({ type: 'sawtooth', f, dur: 2.6, vol: 0.035, attack: 1.0, delay: ci * 1.8, lp: 1200, rev: 0.8, dest: this.music, detune: rand(-8, 8) });
      this.tone({ type: 'sine', f: f * 2, dur: 2.4, vol: 0.03, attack: 0.8, delay: ci * 1.8, rev: 0.8, dest: this.music });
    }));
    for (let i = 0; i < 14; i++) this.tone({ type: 'sine', f: [1046.5, 1318.5, 1568, 2093][i % 4], dur: 1.2, vol: 0.025, delay: 2 + i * 0.35, rev: 0.9, dest: this.music });
    this.noise({ dur: 7, vol: 0.06, type: 'bandpass', f: 300, f2: 6000, q: 1.5, attack: 5, rev: 0.8 });
  }
  // ---- ambience -----------------------------------------------------
  stopAmbient() {
    if (!this.ctx) { this.ambientNodes = []; return; }
    const t = this.ctx.currentTime;
    for (const n of this.ambientNodes) {
      try {
        if (n.gain) n.gain.gain.setTargetAtTime(0, t, 0.4);
        if (n.src) n.src.stop(t + 2);
      } catch (e) { /* already stopped */ }
    }
    this.ambientNodes = [];
  }
  startAmbient(profile) {
    if (profile === this.profile && this.ambientNodes.length) return;
    this.profile = profile;
    if (!this.ready) return;
    this.stopAmbient();
    const c = this.ctx, t = c.currentTime;
    const p = profile;
    const bus = c.createGain();
    bus.gain.setValueAtTime(0, t);
    bus.gain.linearRampToValueAtTime(1, t + 2.5);
    bus.connect(this.sfx);
    this.ambientNodes.push({ gain: bus });
    // Electrical hum: two detuned saws through a low-pass filter.
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = p.humCutoff; lp.Q.value = 2;
    const hg = c.createGain(); hg.gain.value = p.humVol;
    lp.connect(hg); hg.connect(bus);
    for (const det of [0, 0.7, -0.4]) {
      const o = c.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = p.hum + det;
      o.connect(lp); o.start();
      this.ambientNodes.push({ src: o });
    }
    // Air / ventilation noise with a slow breathing LFO.
    const ns = c.createBufferSource();
    ns.buffer = this.noiseBuf; ns.loop = true;
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = p.airFreq; bp.Q.value = 0.6;
    const ng = c.createGain(); ng.gain.value = p.airVol;
    const lfo = c.createOscillator(); lfo.frequency.value = 0.07;
    const lfoG = c.createGain(); lfoG.gain.value = p.airVol * 0.6;
    lfo.connect(lfoG); lfoG.connect(ng.gain);
    ns.connect(bp); bp.connect(ng); ng.connect(bus);
    ns.start(); lfo.start();
    this.ambientNodes.push({ src: ns }, { src: lfo });
    this.padTimer = 1.5;
  }
  // Generative ambient music: sparse, soft notes from the level's scale.
  update(dt) {
    if (!this.ready || !this.profile) return;
    this.padTimer -= dt;
    if (this.padTimer <= 0) {
      const p = this.profile;
      this.padTimer = rand(p.padGap[0], p.padGap[1]);
      const f = p.scale[Math.floor(Math.random() * p.scale.length)];
      this.tone({ type: 'sine', f, dur: rand(3.5, 6), vol: 0.035, attack: 1.4, rev: 0.9, dest: this.music });
      if (Math.random() < 0.5) this.tone({ type: 'triangle', f: f * 1.5, dur: 4, vol: 0.015, attack: 1.8, delay: 0.4, rev: 0.9, dest: this.music });
    }
  }
}

const AMBIENT_PROFILES = {
  lab: { hum: 55, humCutoff: 160, humVol: 0.05, airFreq: 500, airVol: 0.02, scale: [220, 261.63, 329.63, 392, 440, 523.25], padGap: [4, 8] },
  hall: { hum: 49, humCutoff: 130, humVol: 0.06, airFreq: 300, airVol: 0.03, scale: [196, 233.08, 277.18, 311.13, 369.99, 415.3], padGap: [5, 9] },
  gravity: { hum: 41, humCutoff: 120, humVol: 0.07, airFreq: 220, airVol: 0.03, scale: [164.81, 196, 246.94, 293.66, 329.63], padGap: [4, 7] },
  portal: { hum: 60, humCutoff: 200, humVol: 0.045, airFreq: 900, airVol: 0.018, scale: [293.66, 349.23, 440, 523.25, 587.33, 698.46], padGap: [3, 6] },
  void: { hum: 36, humCutoff: 110, humVol: 0.06, airFreq: 180, airVol: 0.04, scale: [146.83, 174.61, 220, 261.63, 329.63, 392], padGap: [3, 6] },
  menu: { hum: 45, humCutoff: 120, humVol: 0.035, airFreq: 260, airVol: 0.02, scale: [220, 261.63, 329.63, 392, 493.88], padGap: [3, 6] },
};

/* ---------------------------------------------------------------------
   Procedural textures (canvas generated, cached for the whole session)
   --------------------------------------------------------------------- */
const FONT_DISPLAY = "'Orbitron', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif";
const FONT_BODY = "'Rajdhani', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif";

class TextureFactory {
  constructor(renderer) {
    this.aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    this.cache = new Map();
  }
  canvas(w, h = w) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  finish(c, { srgb = true, repeat = true } = {}) {
    const t = new THREE.CanvasTexture(c);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = this.aniso;
    t.needsUpdate = true;
    return t;
  }
  cached(key, fn) {
    if (!this.cache.has(key)) this.cache.set(key, fn());
    return this.cache.get(key);
  }
  // Multi-octave value noise painted by up-scaling small random grids.
  paintNoise(ctx, size, octaves, alpha, seed, tint = 255) {
    const rnd = mulberry32(seed);
    for (const cells of octaves) {
      const sc = this.canvas(cells);
      const sctx = sc.getContext('2d');
      const img = sctx.createImageData(cells, cells);
      for (let i = 0; i < cells * cells; i++) {
        const v = rnd() * tint;
        img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
        img.data[i * 4 + 3] = 255;
      }
      sctx.putImageData(img, 0, 0);
      ctx.globalAlpha = alpha;
      ctx.imageSmoothingEnabled = true;
      // Draw 3x3 so the up-scaled noise tiles seamlessly.
      for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) ctx.drawImage(sc, ox * size, oy * size, size, size);
    }
    ctx.globalAlpha = 1;
  }
  concrete() {
    return this.cached('concrete', () => {
      const S = 512, c = this.canvas(S), x = c.getContext('2d');
      x.fillStyle = '#8c8c8c'; x.fillRect(0, 0, S, S);
      this.paintNoise(x, S, [4, 8, 16, 64, 128], 0.16, 11);
      const rnd = mulberry32(5);
      for (let i = 0; i < 2600; i++) {
        x.fillStyle = rnd() < 0.5 ? 'rgba(40,40,40,0.25)' : 'rgba(220,220,220,0.2)';
        x.fillRect(rnd() * S, rnd() * S, 1 + rnd() * 2, 1 + rnd() * 2);
      }
      // Form-work panel seams and tie holes (2 x 2 panels per tile).
      x.strokeStyle = 'rgba(30,30,30,0.55)'; x.lineWidth = 3;
      for (const p of [0, 256]) {
        x.beginPath(); x.moveTo(p + 1, 0); x.lineTo(p + 1, S); x.stroke();
        x.beginPath(); x.moveTo(0, p + 1); x.lineTo(S, p + 1); x.stroke();
      }
      x.fillStyle = 'rgba(25,25,25,0.6)';
      for (const px of [64, 192, 320, 448]) for (const py of [64, 192, 320, 448]) { x.beginPath(); x.arc(px, py, 4, 0, TAU); x.fill(); }
      return this.finish(c);
    });
  }
  concreteBump() {
    return this.cached('concreteBump', () => {
      const S = 256, c = this.canvas(S), x = c.getContext('2d');
      x.fillStyle = '#808080'; x.fillRect(0, 0, S, S);
      this.paintNoise(x, S, [16, 32, 128], 0.25, 77);
      x.strokeStyle = '#000'; x.lineWidth = 2;
      for (const p of [0, 128]) {
        x.beginPath(); x.moveTo(p + 1, 0); x.lineTo(p + 1, S); x.stroke();
        x.beginPath(); x.moveTo(0, p + 1); x.lineTo(S, p + 1); x.stroke();
      }
      return this.finish(c, { srgb: false });
    });
  }
  // Clean white test-chamber panels with ambient-occlusion style grooves.
  panel(key = 'panel', base = [236, 240, 244], groove = '#7d8590', tiles = 4) {
    return this.cached(key, () => {
      const S = 512, c = this.canvas(S), x = c.getContext('2d');
      const T = S / tiles;
      const rnd = mulberry32(21);
      for (let i = 0; i < tiles; i++) for (let j = 0; j < tiles; j++) {
        const k = (rnd() - 0.5) * 10;
        x.fillStyle = `rgb(${base[0] + k},${base[1] + k},${base[2] + k})`;
        x.fillRect(i * T, j * T, T, T);
        // soft inner darkening toward the groove (fake AO)
        const g = x.createLinearGradient(i * T, 0, i * T + T, 0);
        g.addColorStop(0, 'rgba(0,0,0,0.10)'); g.addColorStop(0.08, 'rgba(0,0,0,0)');
        g.addColorStop(0.92, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.10)');
        x.fillStyle = g; x.fillRect(i * T, j * T, T, T);
        const g2 = x.createLinearGradient(0, j * T, 0, j * T + T);
        g2.addColorStop(0, 'rgba(0,0,0,0.10)'); g2.addColorStop(0.08, 'rgba(0,0,0,0)');
        g2.addColorStop(0.92, 'rgba(0,0,0,0)'); g2.addColorStop(1, 'rgba(0,0,0,0.12)');
        x.fillStyle = g2; x.fillRect(i * T, j * T, T, T);
      }
      this.paintNoise(x, S, [32, 128], 0.05, 3);
      x.strokeStyle = groove; x.lineWidth = 4;
      for (let i = 0; i <= tiles; i++) {
        x.beginPath(); x.moveTo(i * T, 0); x.lineTo(i * T, S); x.stroke();
        x.beginPath(); x.moveTo(0, i * T); x.lineTo(S, i * T); x.stroke();
      }
      return this.finish(c);
    });
  }
  panelBump(tiles = 4) {
    return this.cached('panelBump' + tiles, () => {
      const S = 256, c = this.canvas(S), x = c.getContext('2d');
      const T = S / tiles;
      x.fillStyle = '#fff'; x.fillRect(0, 0, S, S);
      x.strokeStyle = '#000'; x.lineWidth = 3;
      for (let i = 0; i <= tiles; i++) {
        x.beginPath(); x.moveTo(i * T, 0); x.lineTo(i * T, S); x.stroke();
        x.beginPath(); x.moveTo(0, i * T); x.lineTo(S, i * T); x.stroke();
      }
      return this.finish(c, { srgb: false });
    });
  }
  metal() {
    return this.cached('metal', () => {
      const S = 256, c = this.canvas(S), x = c.getContext('2d');
      x.fillStyle = '#777'; x.fillRect(0, 0, S, S);
      const rnd = mulberry32(9);
      for (let i = 0; i < 500; i++) {
        const v = 90 + rnd() * 90;
        x.strokeStyle = `rgba(${v},${v},${v},0.35)`;
        x.lineWidth = 1;
        const y = rnd() * S;
        x.beginPath(); x.moveTo(0, y); x.lineTo(S, y + (rnd() - 0.5) * 2); x.stroke();
      }
      x.strokeStyle = 'rgba(20,20,20,0.6)'; x.lineWidth = 2;
      x.strokeRect(1, 1, S - 2, S - 2);
      return this.finish(c);
    });
  }
  grid(color = '#4fd8ff', key = 'grid') {
    return this.cached(key, () => {
      const S = 512, c = this.canvas(S), x = c.getContext('2d');
      x.fillStyle = '#000'; x.fillRect(0, 0, S, S);
      x.strokeStyle = color;
      x.globalAlpha = 0.25; x.lineWidth = 1;
      for (let i = 0; i <= 8; i++) {
        x.beginPath(); x.moveTo(i * 64, 0); x.lineTo(i * 64, S); x.stroke();
        x.beginPath(); x.moveTo(0, i * 64); x.lineTo(S, i * 64); x.stroke();
      }
      x.globalAlpha = 1; x.lineWidth = 4;
      x.beginPath(); x.moveTo(2, 0); x.lineTo(2, S); x.stroke();
      x.beginPath(); x.moveTo(0, 2); x.lineTo(S, 2); x.stroke();
      x.fillStyle = color;
      for (const p of [0, 256]) for (const q of [0, 256]) x.fillRect(p - 5, q - 5, 10, 10);
      return this.finish(c);
    });
  }
  hazard() {
    return this.cached('hazard', () => {
      const S = 128, c = this.canvas(S), x = c.getContext('2d');
      x.fillStyle = '#16181c'; x.fillRect(0, 0, S, S);
      x.fillStyle = '#e8b830';
      for (let i = -2; i < 4; i++) {
        x.beginPath();
        x.moveTo(i * 64, 0); x.lineTo(i * 64 + 32, 0); x.lineTo(i * 64 + 32 + S, S); x.lineTo(i * 64 + S, S);
        x.closePath(); x.fill();
      }
      return this.finish(c);
    });
  }
  glowSprite() {
    return this.cached('glowSprite', () => {
      const S = 64, c = this.canvas(S), x = c.getContext('2d');
      const g = x.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.25, 'rgba(255,255,255,0.6)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      x.fillStyle = g; x.fillRect(0, 0, S, S);
      return this.finish(c, { repeat: false });
    });
  }
  // Symbol textures ---------------------------------------------------
  symbol(kind, color = '#4fd8ff') {
    return this.cached(`sym:${kind}:${color}`, () => {
      const S = 256, c = this.canvas(S), x = c.getContext('2d');
      x.clearRect(0, 0, S, S);
      x.strokeStyle = color; x.fillStyle = color;
      x.lineCap = 'round'; x.lineJoin = 'round';
      x.shadowColor = color; x.shadowBlur = 16;
      const m = S / 2;
      if (kind === 'gravity') {
        x.lineWidth = 8;
        x.beginPath(); x.arc(m, m, 100, 0, TAU); x.stroke();
        x.lineWidth = 3;
        x.beginPath(); x.arc(m, m, 82, 0, TAU); x.stroke();
        x.lineWidth = 12;
        for (const r of [-34, 6, 46]) { x.beginPath(); x.moveTo(m - 42, m + r - 30); x.lineTo(m, m + r); x.lineTo(m + 42, m + r - 30); x.stroke(); }
      } else if (kind === 'circle') {
        x.lineWidth = 16; x.beginPath(); x.arc(m, m, 80, 0, TAU); x.stroke();
      } else if (kind === 'triangle') {
        x.lineWidth = 16; x.beginPath(); x.moveTo(m, m - 88); x.lineTo(m + 92, m + 70); x.lineTo(m - 92, m + 70); x.closePath(); x.stroke();
      } else if (kind === 'square') {
        x.lineWidth = 16; x.strokeRect(m - 76, m - 76, 152, 152);
      } else if (kind === 'eye') {
        x.lineWidth = 10;
        x.beginPath(); x.moveTo(m - 110, m); x.quadraticCurveTo(m, m - 100, m + 110, m); x.quadraticCurveTo(m, m + 100, m - 110, m); x.closePath(); x.stroke();
        x.beginPath(); x.arc(m, m, 34, 0, TAU); x.fill();
        x.lineWidth = 4; x.beginPath(); x.arc(m, m, 118, 0, TAU); x.stroke();
      } else if (kind === 'arrow') {
        x.lineWidth = 18;
        x.beginPath(); x.moveTo(m, m + 90); x.lineTo(m, m - 70); x.stroke();
        x.beginPath(); x.moveTo(m - 60, m - 10); x.lineTo(m, m - 80); x.lineTo(m + 60, m - 10); x.stroke();
      } else if (kind === 'ring') {
        x.lineWidth = 10; x.beginPath(); x.arc(m, m, 96, 0, TAU); x.stroke();
        x.lineWidth = 4; x.beginPath(); x.arc(m, m, 70, 0, TAU); x.stroke();
      } else if (kind === 'cube') {
        x.lineWidth = 10;
        x.beginPath(); x.moveTo(m, m - 90); x.lineTo(m + 80, m - 45); x.lineTo(m + 80, m + 45); x.lineTo(m, m + 90); x.lineTo(m - 80, m + 45); x.lineTo(m - 80, m - 45); x.closePath(); x.stroke();
        x.beginPath(); x.moveTo(m - 80, m - 45); x.lineTo(m, m); x.lineTo(m + 80, m - 45); x.moveTo(m, m); x.lineTo(m, m + 90); x.stroke();
      }
      return this.finish(c, { repeat: false });
    });
  }
  cubeFace(kind) {
    return this.cached('cubeFace:' + kind, () => {
      const S = 256, c = this.canvas(S), x = c.getContext('2d');
      x.fillStyle = kind === 'core' ? '#1a1d24' : '#c9ced6'; x.fillRect(0, 0, S, S);
      this.paintNoise(x, S, [16, 64], 0.06, 4);
      x.fillStyle = kind === 'core' ? '#0d0f14' : '#3a3f48';
      x.fillRect(0, 0, S, 26); x.fillRect(0, S - 26, S, 26); x.fillRect(0, 0, 26, S); x.fillRect(S - 26, 0, 26, S);
      x.fillStyle = kind === 'core' ? '#2a2e38' : '#e4e8ee';
      x.fillRect(48, 48, S - 96, S - 96);
      x.strokeStyle = '#555c66'; x.lineWidth = 3; x.strokeRect(48, 48, S - 96, S - 96);
      return this.finish(c, { repeat: false });
    });
  }
  cubeGlow(color) {
    return this.cached('cubeGlow:' + color, () => {
      const S = 256, c = this.canvas(S), x = c.getContext('2d');
      x.fillStyle = '#000'; x.fillRect(0, 0, S, S);
      x.strokeStyle = color; x.lineWidth = 6;
      x.shadowColor = color; x.shadowBlur = 10;
      x.strokeRect(34, 34, S - 68, S - 68);
      x.beginPath(); x.arc(S / 2, S / 2, 38, 0, TAU); x.stroke();
      x.fillStyle = color; x.beginPath(); x.arc(S / 2, S / 2, 14, 0, TAU); x.fill();
      return this.finish(c, { repeat: false, srgb: true });
    });
  }
  // One-off text texture for signs and screens (not cached).
  text(lines, { w = 512, h = 256, bg = 'rgba(6,10,18,0.92)', color = '#4fd8ff', font = FONT_DISPLAY, size = 48, weight = 700, border = true, align = 'center', glow = true } = {}) {
    const c = this.canvas(w, h), x = c.getContext('2d');
    this.drawText(x, c, lines, { w, h, bg, color, font, size, weight, border, align, glow });
    const t = this.finish(c, { repeat: false });
    t.userData.redraw = (newLines, opts = {}) => {
      this.drawText(x, c, newLines, { w, h, bg, color, font, size, weight, border, align, glow, ...opts });
      t.needsUpdate = true;
    };
    return t;
  }
  drawText(x, c, lines, o) {
    x.clearRect(0, 0, o.w, o.h);
    if (o.bg) { x.fillStyle = o.bg; x.fillRect(0, 0, o.w, o.h); }
    if (o.border) {
      x.strokeStyle = o.color; x.globalAlpha = 0.6; x.lineWidth = 4;
      x.strokeRect(8, 8, o.w - 16, o.h - 16);
      x.globalAlpha = 1;
    }
    const arr = Array.isArray(lines) ? lines : [lines];
    x.fillStyle = o.color;
    x.textAlign = o.align;
    x.textBaseline = 'middle';
    if (o.glow) { x.shadowColor = o.color; x.shadowBlur = 12; }
    const lh = o.size * 1.25;
    const startY = o.h / 2 - ((arr.length - 1) * lh) / 2;
    arr.forEach((ln, i) => {
      const sz = i === 0 ? o.size : o.size * 0.62;
      x.font = `${i === 0 ? o.weight : 500} ${sz}px ${i === 0 ? o.font : FONT_BODY}`;
      const tx = o.align === 'center' ? o.w / 2 : 30;
      x.fillText(ln, tx, startY + i * lh);
    });
    x.shadowBlur = 0;
  }
}

/* ---------------------------------------------------------------------
   Shared material palette
   --------------------------------------------------------------------- */
function buildMaterials(tex) {
  const M = {};
  M.concrete = new THREE.MeshStandardMaterial({ color: 0x8e949c, map: tex.concrete(), bumpMap: tex.concreteBump(), bumpScale: 1.4, roughness: 0.92, metalness: 0.02 });
  M.concreteDark = new THREE.MeshStandardMaterial({ color: 0x4c515a, map: tex.concrete(), bumpMap: tex.concreteBump(), bumpScale: 1.4, roughness: 0.9, metalness: 0.05 });
  M.white = new THREE.MeshStandardMaterial({ color: 0xf4f6f9, map: tex.panel(), bumpMap: tex.panelBump(4), bumpScale: 1.6, roughness: 0.55, metalness: 0.0 });
  M.whiteFloor = new THREE.MeshStandardMaterial({ color: 0xd8dde4, map: tex.panel('floorPanel', [220, 225, 232], '#5b636e', 4), bumpMap: tex.panelBump(4), bumpScale: 1.2, roughness: 0.24, metalness: 0.12 });
  M.darkFloor = new THREE.MeshStandardMaterial({ color: 0x4a505a, map: tex.panel('darkPanel', [120, 126, 136], '#202328', 4), bumpMap: tex.panelBump(4), bumpScale: 1.2, roughness: 0.32, metalness: 0.45 });
  M.metal = new THREE.MeshStandardMaterial({ color: 0x5a616c, map: tex.metal(), roughness: 0.38, metalness: 0.85 });
  M.trim = new THREE.MeshStandardMaterial({ color: 0x1c2027, roughness: 0.42, metalness: 0.75 });
  M.glass = new THREE.MeshStandardMaterial({ color: 0x9fdcff, transparent: true, opacity: 0.16, roughness: 0.04, metalness: 0.1, depthWrite: false, side: THREE.DoubleSide });
  M.black = new THREE.MeshBasicMaterial({ color: 0x000000 });
  M.hazard = new THREE.MeshStandardMaterial({ map: tex.hazard(), roughness: 0.6, metalness: 0.2 });
  M.gridDark = new THREE.MeshStandardMaterial({ color: 0x2c3038, map: tex.concrete(), bumpMap: tex.concreteBump(), bumpScale: 1.2, roughness: 0.85, metalness: 0.1, emissive: 0x4fd8ff, emissiveMap: tex.grid('#4fd8ff', 'gridCyan'), emissiveIntensity: 0.55 });
  M.gridViolet = new THREE.MeshStandardMaterial({ color: 0x26222f, map: tex.concrete(), bumpMap: tex.concreteBump(), bumpScale: 1.2, roughness: 0.8, metalness: 0.15, emissive: 0xb47cff, emissiveMap: tex.grid('#b47cff', 'gridViolet'), emissiveIntensity: 0.6 });
  M.voidStone = new THREE.MeshStandardMaterial({ color: 0x3a3546, map: tex.concrete(), bumpMap: tex.concreteBump(), bumpScale: 1.5, roughness: 0.75, metalness: 0.2 });
  M.cube = new THREE.MeshStandardMaterial({ map: tex.cubeFace('cube'), emissive: 0x4fd8ff, emissiveMap: tex.cubeGlow('#4fd8ff'), emissiveIntensity: 1.6, roughness: 0.4, metalness: 0.3 });
  M.cubeLit = M.cube.clone(); M.cubeLit.emissive = new THREE.Color(0x5dffb0); M.cubeLit.emissiveMap = tex.cubeGlow('#5dffb0');
  M.perception = new THREE.MeshStandardMaterial({ map: tex.cubeFace('core'), emissive: 0xb47cff, emissiveMap: tex.cubeGlow('#d6b0ff'), emissiveIntensity: 2.2, roughness: 0.3, metalness: 0.4 });
  return M;
}

const _neonCache = new Map();
function neon(hex, intensity = 2.5, opts = {}) {
  const key = `${hex}:${intensity}:${opts.transparent ? 1 : 0}:${opts.opacity || 1}:${opts.side || 0}`;
  if (!_neonCache.has(key)) {
    const m = new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(intensity), ...opts });
    _neonCache.set(key, m);
  }
  return _neonCache.get(key);
}

// Box geometry whose UVs are derived from world position, so textures keep
// a constant real-world scale and line up across neighbouring boxes.
function worldBoxGeo(x0, y0, z0, x1, y1, z1, scale = 4) {
  const w = x1 - x0, h = y1 - y0, d = z1 - z0;
  const g = new THREE.BoxGeometry(w, h, d);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
  const pos = g.attributes.position, nor = g.attributes.normal, uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const wx = pos.getX(i) + cx, wy = pos.getY(i) + cy, wz = pos.getZ(i) + cz;
    const nx = Math.abs(nor.getX(i)), ny = Math.abs(nor.getY(i));
    if (nx > 0.5) uv.setXY(i, wz / scale, wy / scale);
    else if (ny > 0.5) uv.setXY(i, wx / scale, wz / scale);
    else uv.setXY(i, wx / scale, wy / scale);
  }
  return g;
}

// Environment map for reflections: a dim facility with bright light panels.
function buildEnvironment(renderer) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = new THREE.Scene();
  const room = new THREE.Mesh(new THREE.BoxGeometry(20, 10, 20), new THREE.MeshBasicMaterial({ color: 0x15181f, side: THREE.BackSide }));
  env.add(room);
  const panel = (x, y, z, w, h, d, c, k) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(k) }));
    m.position.set(x, y, z); env.add(m);
  };
  panel(0, 4.9, 0, 8, 0.1, 2, 0xffffff, 4);
  panel(-6, 4.9, -5, 2, 0.1, 6, 0xdde8ff, 3);
  panel(6, 4.9, 5, 2, 0.1, 6, 0xdde8ff, 3);
  panel(-9.9, 1, 0, 0.1, 0.4, 14, 0x4fd8ff, 3);
  panel(9.9, 1, 0, 0.1, 0.4, 14, 0xb47cff, 3);
  panel(0, 2, -9.9, 6, 3, 0.1, 0x8899aa, 1.2);
  const rt = pmrem.fromScene(env, 0.035);
  pmrem.dispose();
  return rt.texture;
}

/* ---------------------------------------------------------------------
   Physics: axis-aligned boxes. Gravity is always one of the six axis
   directions, so every collider (including rotated room pieces, which
   only rotate in 90° steps) stays axis-aligned.
   --------------------------------------------------------------------- */
const SKIN = 0.001;

class Solid {
  constructor(min, max, owner = null, tag = null) {
    this.min = min.clone();
    this.max = max.clone();
    this.owner = owner;
    this.tag = tag;
    this.enabled = true;
    this.kinematic = false;
    this.delta = new THREE.Vector3();
  }
  set(min, max) { this.min.copy(min); this.max.copy(max); }
}

function boxOverlap(aMin, aMax, bMin, bMax, eps = 1e-4) {
  return aMin.x < bMax.x - eps && aMax.x > bMin.x + eps &&
    aMin.y < bMax.y - eps && aMax.y > bMin.y + eps &&
    aMin.z < bMax.z - eps && aMax.z > bMin.z + eps;
}
function boxFrom(pos, half, outMin, outMax) {
  outMin.copy(pos).sub(half);
  outMax.copy(pos).add(half);
}
// Slab-method ray/box intersection. Returns entry distance or Infinity.
function rayBox(o, d, min, max) {
  let tmin = -Infinity, tmax = Infinity;
  for (let a = 0; a < 3; a++) {
    const oa = comp(o, a), da = comp(d, a), mn = comp(min, a), mx = comp(max, a);
    if (Math.abs(da) < 1e-9) {
      if (oa < mn || oa > mx) return Infinity;
    } else {
      let t1 = (mn - oa) / da, t2 = (mx - oa) / da;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return Infinity;
    }
  }
  if (tmax < 0) return Infinity;
  return tmin >= 0 ? tmin : 0;
}

class PhysicsWorld {
  constructor() { this.solids = []; }
  add(min, max, owner = null, tag = null) {
    const s = new Solid(min, max, owner, tag);
    this.solids.push(s);
    return s;
  }
  addBox(x0, y0, z0, x1, y1, z1, owner = null, tag = null) {
    return this.add(V3(Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1)), V3(Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1)), owner, tag);
  }
  remove(s) {
    const i = this.solids.indexOf(s);
    if (i >= 0) this.solids.splice(i, 1);
  }
  firstOverlap(min, max, ignore) {
    for (const s of this.solids) {
      if (!s.enabled || (ignore && ignore(s))) continue;
      if (boxOverlap(min, max, s.min, s.max)) return s;
    }
    return null;
  }
  raycast(o, d, maxDist, ignore) {
    let best = maxDist, hit = null;
    for (const s of this.solids) {
      if (!s.enabled || (ignore && ignore(s))) continue;
      const t = rayBox(o, d, s.min, s.max);
      if (t < best) { best = t; hit = s; }
    }
    return { dist: best, solid: hit };
  }
}

const _mvMin = new THREE.Vector3(), _mvMax = new THREE.Vector3(), _mvTry = new THREE.Vector3();
const _overl = [];

// Moves a box through the world one axis at a time (with sub-stepping),
// resolving collisions. `up` defines what counts as "ground".
function moveBody(pos, vel, half, dt, world, opts) {
  const res = { grounded: false, ground: null, impact: 0, hitAxes: [false, false, false] };
  const up = opts.up || Y_UP;
  const ua = axisIndexOf(up);
  const us = Math.sign(comp(up, ua));
  const ignore = opts.ignore;
  const stepUp = opts.stepUp || 0;
  const speed = vel.length();
  const steps = clamp(Math.ceil((speed * dt) / 0.12), 1, 20);
  const h = dt / steps;
  for (let s = 0; s < steps; s++) {
    for (let a = 0; a < 3; a++) {
      const v = comp(vel, a);
      if (v === 0) continue;
      const d = v * h;
      setComp(pos, a, comp(pos, a) + d);
      boxFrom(pos, half, _mvMin, _mvMax);
      _overl.length = 0;
      for (const so of world.solids) {
        if (!so.enabled || (ignore && ignore(so))) continue;
        if (boxOverlap(_mvMin, _mvMax, so.min, so.max)) _overl.push(so);
      }
      if (_overl.length === 0) continue;
      // Try to step up onto low obstacles when moving sideways.
      if (a !== ua && stepUp > 0) {
        const feet = us * comp(pos, ua) - comp(half, ua);
        let need = 0, ok = true;
        for (const so of _overl) {
          const top = us > 0 ? comp(so.max, ua) : -comp(so.min, ua);
          const n = top - feet;
          if (n > 0 && n <= stepUp) need = Math.max(need, n); else { ok = false; break; }
        }
        if (ok && need > 0) {
          _mvTry.copy(pos);
          setComp(_mvTry, ua, comp(pos, ua) + us * (need + 0.01));
          boxFrom(_mvTry, half, _mvMin, _mvMax);
          if (!world.firstOverlap(_mvMin, _mvMax, ignore)) { pos.copy(_mvTry); continue; }
        }
      }
      let limit = d > 0 ? Infinity : -Infinity, limiter = null;
      const ha = comp(half, a);
      for (const so of _overl) {
        if (d > 0) { const l = comp(so.min, a) - ha - SKIN; if (l < limit) { limit = l; limiter = so; } }
        else { const l = comp(so.max, a) + ha + SKIN; if (l > limit) { limit = l; limiter = so; } }
      }
      setComp(pos, a, limit);
      res.hitAxes[a] = true;
      res.impact = Math.max(res.impact, Math.abs(v));
      if (a === ua && Math.sign(d) === -us) { res.grounded = true; res.ground = limiter; }
      setComp(vel, a, 0);
    }
  }
  return res;
}

// Pushes a box out of any solids it overlaps along the shallowest axis.
function depenetrate(pos, half, world, ignore, iterations = 8) {
  for (let it = 0; it < iterations; it++) {
    boxFrom(pos, half, _mvMin, _mvMax);
    const s = world.firstOverlap(_mvMin, _mvMax, ignore);
    if (!s) return true;
    let best = Infinity, ba = 0, bs = 1;
    for (let a = 0; a < 3; a++) {
      const pNeg = comp(_mvMax, a) - comp(s.min, a);
      const pPos = comp(s.max, a) - comp(_mvMin, a);
      if (pNeg < best) { best = pNeg; ba = a; bs = -1; }
      if (pPos < best) { best = pPos; ba = a; bs = 1; }
    }
    setComp(pos, ba, comp(pos, ba) + bs * (best + SKIN * 2));
  }
  boxFrom(pos, half, _mvMin, _mvMax);
  return !world.firstOverlap(_mvMin, _mvMax, ignore);
}

/* ---------------------------------------------------------------------
   First-person player with arbitrary (axis-aligned) gravity.
   The camera orientation is   frame * yaw * pitch   where `frame` maps
   the world Y axis onto the player's current "up". Movement is computed
   in that frame, so walking on walls and ceilings uses the same controls.
   --------------------------------------------------------------------- */
const PLAYER_HALF_UP = 0.85;
const PLAYER_HALF_SIDE = 0.3;
const EYE_OFFSET = 0.65;
const GRAVITY = 22;
const JUMP_SPEED = 7.4;
const WALK_SPEED = 4.4;
const SPRINT_SPEED = 7.4;

class Player {
  constructor(game) {
    this.game = game;
    this.pos = V3();
    this.vel = V3();
    this.up = V3(0, 1, 0);
    this.half = V3(PLAYER_HALF_SIDE, PLAYER_HALF_UP, PLAYER_HALF_SIDE);
    this.frame = new THREE.Quaternion();
    this.frameFrom = new THREE.Quaternion();
    this.frameTo = new THREE.Quaternion();
    this.frameT = 1;
    this.yaw = 0;
    this.pitch = 0;
    this.grounded = false;
    this.ground = null;
    this.coyote = 0;
    this.jumpBuffer = 0;
    this.stepDist = 0;
    this.bobPhase = 0;
    this.bobAmt = 0;
    this.landDip = 0;
    this.shake = 0;
    this.frozen = false;
    this.solid = null;
    this.airTime = 0;
    this.qYaw = new THREE.Quaternion();
    this.qPitch = new THREE.Quaternion();
    this.animUp = V3(0, 1, 0);
    this.eye = V3();
    this.fwd = V3();
    this.right = V3();
    this.avatar = this.buildAvatar();
  }
  buildAvatar() {
    // A dark silhouette only rendered by portal cameras (layer 1), so the
    // player can see themselves through portals.
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0x1a1d24, roughness: 0.5, metalness: 0.4, emissive: 0x112233, emissiveIntensity: 0.4 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.26, 0.9, 4, 12), mat);
    body.position.y = -0.1;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 12), mat);
    head.position.y = 0.62;
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.07, 0.12), neon(0x4fd8ff, 3));
    visor.position.set(0, 0.64, -0.15);
    g.add(body, head, visor);
    g.traverse((o) => o.layers.set(1));
    return g;
  }
  attach(level) {
    this.solid = level.world.add(V3(), V3(), this, 'player');
    level.scene.add(this.avatar);
    this.syncSolid();
  }
  updateHalf() {
    this.half.setScalar(PLAYER_HALF_SIDE);
    setComp(this.half, axisIndexOf(this.up), PLAYER_HALF_UP);
  }
  syncSolid() {
    if (this.solid) boxFrom(this.pos, this.half, this.solid.min, this.solid.max);
  }
  spawn(feet, up, look) {
    this.up.copy(snapAxis(up));
    this.updateHalf();
    this.pos.copy(feet).addScaledVector(this.up, PLAYER_HALF_UP + 0.02);
    this.vel.set(0, 0, 0);
    this.frame.setFromUnitVectors(Y_UP, this.up);
    this.frameFrom.copy(this.frame);
    this.frameTo.copy(this.frame);
    this.frameT = 1;
    this.grounded = false;
    this.ground = null;
    this.frozen = false;
    this.landDip = 0;
    this.shake = 0;
    this.lookAlong(look);
    this.syncSolid();
  }
  lookAlong(dir) {
    const l = _v1.copy(dir).normalize().applyQuaternion(_q1.copy(this.frameTo).invert());
    this.yaw = Math.atan2(-l.x, -l.z);
    this.pitch = Math.asin(clamp(l.y, -1, 1));
  }
  // Rotate gravity so `newUp` becomes the player's up. The view rotates
  // smoothly with the body; yaw/pitch relative to the body are preserved.
  setGravity(newUp, world) {
    const nu = snapAxis(newUp);
    if (nu.equals(this.up)) return false;
    let q;
    if (this.up.dot(nu) < -0.5) {
      // 180° flip: roll over the current facing direction.
      const fwd = V3(0, 0, -1).applyQuaternion(this.frameTo.clone().multiply(this.qYaw.setFromAxisAngle(Y_UP, this.yaw)));
      fwd.addScaledVector(this.up, -fwd.dot(this.up)).normalize();
      q = new THREE.Quaternion().setFromAxisAngle(fwd, Math.PI);
    } else {
      q = new THREE.Quaternion().setFromUnitVectors(this.up, nu);
    }
    this.frameFrom.copy(this.frame);
    this.frameTo.premultiply(q).normalize();
    this.frameT = 0;
    this.up.copy(nu);
    this.updateHalf();
    this.grounded = false;
    this.ground = null;
    depenetrate(this.pos, this.half, world, (s) => s.owner === this || s.owner === this.game.held);
    this.syncSolid();
    return true;
  }
  // Apply a rigid transform (used by portals). Gravity follows the body.
  applyTransform(m, q, world) {
    this.pos.applyMatrix4(m);
    this.vel.applyQuaternion(q);
    this.frame.premultiply(q).normalize();
    this.frameFrom.premultiply(q).normalize();
    this.frameTo.premultiply(q).normalize();
    const nu = snapAxis(this.up.clone().applyQuaternion(q));
    const changed = !nu.equals(this.up);
    this.up.copy(nu);
    this.updateHalf();
    if (changed) depenetrate(this.pos, this.half, world, (s) => s.owner === this || s.owner === this.game.held);
    this.syncSolid();
    return changed;
  }
  update(dt, input, world) {
    const s = this.game.settings;
    // ---- look ----
    if (!this.frozen) {
      const sens = 0.0021 * s.sensitivity;
      this.yaw -= input.mouseDX * sens;
      this.pitch -= input.mouseDY * sens * (s.invertY ? -1 : 1);
      this.pitch = clamp(this.pitch, -1.55, 1.55);
    }
    if (this.frameT < 1) {
      this.frameT = Math.min(1, this.frameT + dt / 0.6);
      this.frame.slerpQuaternions(this.frameFrom, this.frameTo, easeInOut(this.frameT));
    } else {
      this.frame.copy(this.frameTo);
    }
    this.qYaw.setFromAxisAngle(Y_UP, this.yaw);
    const up = this.up;
    // ---- movement ----
    const body = _q1.copy(this.frame).multiply(this.qYaw);
    this.fwd.set(0, 0, -1).applyQuaternion(body);
    this.right.set(1, 0, 0).applyQuaternion(body);
    this.fwd.addScaledVector(up, -this.fwd.dot(up));
    this.right.addScaledVector(up, -this.right.dot(up));
    if (this.fwd.lengthSq() < 1e-6) this.fwd.crossVectors(up, this.right);
    this.fwd.normalize(); this.right.normalize();
    const f = this.frozen ? 0 : input.forward, r = this.frozen ? 0 : input.strafe;
    const wish = _v2.set(0, 0, 0).addScaledVector(this.fwd, f).addScaledVector(this.right, r);
    if (wish.lengthSq() > 1) wish.normalize();
    const sprint = input.sprint && f > 0;
    const speed = sprint ? SPRINT_SPEED : WALK_SPEED;
    let vUp = this.vel.dot(up);
    const lat = _v3.copy(this.vel).addScaledVector(up, -vUp);
    const accel = this.grounded ? 14 : 2.2;
    const target = wish.multiplyScalar(speed);
    // In the air, only add control; don't brake existing momentum hard.
    if (this.grounded || target.lengthSq() > 0) lat.lerp(target, 1 - Math.exp(-accel * dt));
    // Jump with buffering and coyote time for forgiving platforming.
    if (input.jumpPressed && !this.frozen) this.jumpBuffer = 0.14;
    this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);
    this.coyote = this.grounded ? 0.1 : Math.max(0, this.coyote - dt);
    if (this.jumpBuffer > 0 && this.coyote > 0) {
      vUp = JUMP_SPEED;
      this.jumpBuffer = 0;
      this.coyote = 0;
      this.grounded = false;
      this.game.audio.jump();
    }
    vUp = Math.max(vUp - GRAVITY * dt, -42);
    this.vel.copy(lat).addScaledVector(up, vUp);
    // Ride kinematic platforms.
    if (this.grounded && this.ground && this.ground.kinematic && this.ground.enabled) this.pos.add(this.ground.delta);
    const wasGrounded = this.grounded;
    const ignore = (so) => so.owner === this || (this.game.held && so.owner === this.game.held);
    const res = moveBody(this.pos, this.vel, this.half, dt, world, { up, ignore, stepUp: wasGrounded ? 0.45 : 0.12 });
    this.grounded = res.grounded;
    this.ground = res.ground;
    this.airTime = this.grounded ? 0 : this.airTime + dt;
    if (!wasGrounded && this.grounded && res.impact > 4) {
      this.game.audio.land(res.impact / 8);
      this.landDip = Math.min(0.22, res.impact * 0.018);
    }
    this.syncSolid();
    // ---- footsteps & head bob ----
    const latSpeed = lat.length();
    if (this.grounded && latSpeed > 0.8) {
      this.stepDist += latSpeed * dt;
      if (this.stepDist > (sprint ? 2.4 : 1.9)) { this.stepDist = 0; this.game.audio.footstep(sprint); }
      this.bobPhase += latSpeed * dt * 1.65;
    }
    this.bobAmt = damp(this.bobAmt, this.grounded && latSpeed > 0.8 && s.headBob ? Math.min(1, latSpeed / 5) : 0, 8, dt);
    this.landDip = damp(this.landDip, 0, 7, dt);
    this.shake = Math.max(0, this.shake - dt);
    this.updateCamera();
  }
  updateCamera() {
    const cam = this.game.camera;
    this.qYaw.setFromAxisAngle(Y_UP, this.yaw);
    this.qPitch.setFromAxisAngle(_v3.set(1, 0, 0), this.pitch);
    this.animUp.copy(Y_UP).applyQuaternion(this.frame);
    const bob = Math.sin(this.bobPhase * 2) * 0.035 * this.bobAmt;
    this.eye.copy(this.pos).addScaledVector(this.animUp, EYE_OFFSET + bob - this.landDip);
    cam.position.copy(this.eye);
    if (this.shake > 0) {
      const k = Math.min(1, this.shake) * 0.05;
      cam.position.x += rand(-k, k); cam.position.y += rand(-k, k); cam.position.z += rand(-k, k);
    }
    cam.quaternion.copy(this.frame).multiply(this.qYaw).multiply(this.qPitch);
    cam.updateMatrixWorld();
    this.avatar.position.copy(this.pos).addScaledVector(this.animUp, 0.1);
    this.avatar.quaternion.copy(this.frame).multiply(this.qYaw);
  }
  getEyeRay(origin, dir) {
    origin.copy(this.game.camera.position);
    dir.set(0, 0, -1).applyQuaternion(this.game.camera.quaternion);
  }
}

/* ---------------------------------------------------------------------
   Entities
   --------------------------------------------------------------------- */
class Entity {
  constructor(level) {
    this.level = level;
    this.game = level.game;
    this.range = 3.2;
    level.entities.push(this);
  }
  update() {}
  // Interactables implement prompt(game) -> {text, far} | null and interact(game).
}

// Orient an Object3D so its local +Y points along `normal`.
function orientUp(obj, normal, twist = 0) {
  obj.quaternion.setFromUnitVectors(Y_UP, normal.clone().normalize());
  if (twist) obj.quaternion.multiply(_q1.setFromAxisAngle(Y_UP, twist));
}

/* Button on a pedestal or mounted on a wall ------------------------------ */
class Switch extends Entity {
  constructor(level, { pos, normal = Y_UP, mount = 'pedestal', label = 'Press button', onPress = null, once = false, color = 0x4fd8ff }) {
    super(level);
    this.label = label;
    this.onPress = onPress;
    this.once = once;
    this.used = false;
    this.disabled = false;
    this.disabledText = 'Inactive';
    this.anim = 0;
    this.cooldown = 0;
    this.color = color;
    const M = this.game.M;
    this.group = new THREE.Group();
    this.group.position.copy(pos);
    orientUp(this.group, normal);
    let capY = 0.05;
    if (mount === 'pedestal') {
      const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.36, 1.0, 20), M.metal);
      ped.position.y = 0.5;
      ped.castShadow = true; ped.receiveShadow = true;
      const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.04, 20), neon(color, 2));
      ring.position.y = 0.82;
      this.group.add(ped, ring);
      capY = 1.02;
      level.world.addBox(pos.x - 0.3, pos.y, pos.z - 0.3, pos.x + 0.3, pos.y + 1.0, pos.z + 0.3, this, 'pedestal');
    } else {
      const plate = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.06, 0.6), M.trim);
      plate.position.y = 0.03;
      this.group.add(plate);
      capY = 0.08;
    }
    this.capMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(2.2) });
    level.own(this.capMat);
    this.cap = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.19, 0.09, 24), this.capMat);
    this.cap.position.y = capY;
    this.capBase = capY;
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.23, 0.23, 0.05, 24), M.trim);
    rim.position.y = capY - 0.04;
    this.group.add(rim, this.cap);
    level.scene.add(this.group);
    level.addPick(this.cap, this);
    level.addPick(rim, this);
  }
  setColor(hex) { this.capMat.color.set(hex).multiplyScalar(2.2); }
  prompt() {
    if (this.disabled || (this.once && this.used)) return { text: this.disabledText, far: true };
    return { text: this.label };
  }
  interact() {
    if (this.cooldown > 0) return;
    if (this.disabled || (this.once && this.used)) { this.game.audio.deny(); return; }
    this.used = true;
    this.anim = 1;
    this.cooldown = 0.6;
    this.game.audio.switchOn();
    if (this.onPress) this.onPress(this);
  }
  update(dt) {
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.anim = Math.max(0, this.anim - dt * 3);
    this.cap.position.y = this.capBase - 0.05 * Math.sin(this.anim * Math.PI);
  }
}

/* Sliding door ------------------------------------------------------------ */
class Door extends Entity {
  constructor(level, { min, max, slide, mat = null, label = null, interactive = false, onOpen = null, glyph = null, speed = 0.9, lightColor = 0xff5470, openColor = 0x5dffb0 }) {
    super(level);
    this.closedColor = lightColor;
    this.openColor = openColor;
    this.closedMin = min.clone();
    this.closedMax = max.clone();
    this.slide = slide.clone();
    this.t = 0;
    this.target = 0;
    this.speed = speed;
    this.interactive = interactive;
    this.onOpen = onOpen;
    this.label = label || 'Open door';
    this.locked = !interactive;
    const size = V3().subVectors(max, min);
    this.center = V3().addVectors(min, max).multiplyScalar(0.5);
    const M = this.game.M;
    this.mesh = new THREE.Group();
    const panel = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), mat || M.metal);
    panel.castShadow = true; panel.receiveShadow = true;
    this.mesh.add(panel);
    // A glowing status strip on both faces of the panel.
    this.lightMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(lightColor).multiplyScalar(2.5) });
    level.own(this.lightMat);
    const thinAxis = size.x < size.z ? 0 : 2;
    const sx = thinAxis === 0 ? size.x + 0.02 : size.x * 0.7;
    const sz = thinAxis === 2 ? size.z + 0.02 : size.z * 0.7;
    const strip = new THREE.Mesh(new THREE.BoxGeometry(sx, 0.08, sz), this.lightMat);
    strip.position.y = size.y * 0.12;
    this.mesh.add(strip);
    if (glyph) {
      for (const side of [1, -1]) {
        const g = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.7), new THREE.MeshBasicMaterial({ map: this.game.tex.symbol(glyph, '#ffc457'), transparent: true, color: new THREE.Color(2, 2, 2) }));
        level.own(g.material);
        if (thinAxis === 0) { g.position.x = side * (size.x / 2 + 0.01); g.rotation.y = side * Math.PI / 2; }
        else { g.position.z = side * (size.z / 2 + 0.01); g.rotation.y = side > 0 ? 0 : Math.PI; }
        g.position.y = size.y * 0.25;
        this.mesh.add(g);
      }
    }
    this.mesh.position.copy(this.center);
    level.scene.add(this.mesh);
    this.solid = level.world.add(min, max, this, 'door');
    this.solid.kinematic = true;
    if (interactive) level.addPick(panel, this);
    this._min = V3(); this._max = V3();
  }
  get isOpen() { return this.t > 0.98; }
  setLight(hex) { this.lightMat.color.set(hex).multiplyScalar(2.5); }
  open(silent = false) {
    if (this.target === 1) return;
    this.target = 1;
    this.setLight(this.openColor);
    if (!silent) this.game.audio.door(true);
  }
  close(silent = false) {
    if (this.target === 0) return;
    this.target = 0;
    this.setLight(this.closedColor);
    if (!silent) this.game.audio.door(false);
  }
  snap(open) {
    this.target = this.t = open ? 1 : 0;
    this.setLight(open ? this.openColor : this.closedColor);
    this.apply(V3());
  }
  prompt() {
    if (!this.interactive || this.target === 1) return null;
    return { text: this.label };
  }
  interact() {
    if (!this.interactive || this.target === 1) return;
    this.open();
    if (this.onOpen) this.onOpen(this);
  }
  apply(delta) {
    const e = easeInOut(this.t);
    this.mesh.position.copy(this.center).addScaledVector(this.slide, e);
    this.solid.min.copy(this.closedMin).addScaledVector(this.slide, e);
    this.solid.max.copy(this.closedMax).addScaledVector(this.slide, e);
    this.solid.delta.copy(delta);
    this.solid.enabled = this.t < 0.97;
  }
  update(dt) {
    if (this.t === this.target) { this.solid.delta.set(0, 0, 0); return; }
    const prevE = easeInOut(this.t);
    let nt = this.target > this.t ? Math.min(1, this.t + dt / this.speed) : Math.max(0, this.t - dt / this.speed);
    if (nt < this.t) {
      // Never crush the player or a cube: hold the door while blocked.
      const e = easeInOut(nt);
      this._min.copy(this.closedMin).addScaledVector(this.slide, e);
      this._max.copy(this.closedMax).addScaledVector(this.slide, e);
      const blocked = this.level.world.solids.some((s) => s.enabled && (s.tag === 'player' || s.tag === 'object') && boxOverlap(this._min, this._max, s.min, s.max));
      if (blocked) nt = this.t;
    }
    this.t = nt;
    const delta = this.slide.clone().multiplyScalar(easeInOut(this.t) - prevE);
    this.apply(delta);
  }
}

/* Pressure plate ---------------------------------------------------------- */
class PressurePlate extends Entity {
  constructor(level, { pos, size = 1.6, minSize = 0, acceptsPlayer = false, onChange = null, color = 0x4fd8ff, label = null }) {
    super(level);
    this.pos = pos.clone();
    this.size = size;
    this.minSize = minSize;
    this.acceptsPlayer = acceptsPlayer;
    this.onChange = onChange;
    this.pressed = false;
    this.anim = 0;
    const M = this.game.M;
    const base = new THREE.Mesh(new THREE.BoxGeometry(size, 0.05, size), M.trim);
    base.position.set(pos.x, pos.y + 0.025, pos.z);
    base.receiveShadow = true;
    const ring = new THREE.Mesh(new THREE.BoxGeometry(size + 0.12, 0.03, size + 0.12), neon(color, 1.6));
    ring.position.set(pos.x, pos.y + 0.012, pos.z);
    this.topMat = new THREE.MeshStandardMaterial({ color: 0x2a2f38, emissive: color, emissiveIntensity: 0.3, roughness: 0.4, metalness: 0.6 });
    level.own(this.topMat);
    this.top = new THREE.Mesh(new THREE.BoxGeometry(size - 0.24, 0.06, size - 0.24), this.topMat);
    this.top.position.set(pos.x, pos.y + 0.08, pos.z);
    this.top.receiveShadow = true;
    level.scene.add(base, ring, this.top);
    if (label) level.decal(label, V3(pos.x, pos.y + 0.112, pos.z), Y_UP, size * 0.55, size * 0.55, { color: '#ffffff', bg: null, border: false, size: 60, h: 512, w: 512, rotate: 0 });
    const hs = size / 2 - 0.05;
    this.regionMin = V3(pos.x - hs, pos.y - 0.05, pos.z - hs);
    this.regionMax = V3(pos.x + hs, pos.y + 0.4, pos.z + hs);
    this._min = V3(); this._max = V3();
  }
  update(dt) {
    let p = false;
    for (const o of this.level.objects) {
      if (o.held || o.locked || o.size < this.minSize - 1e-3) continue;
      boxFrom(o.pos, o.half, this._min, this._max);
      if (boxOverlap(this._min, this._max, this.regionMin, this.regionMax)) { p = true; break; }
    }
    if (!p && this.acceptsPlayer) {
      const pl = this.game.player;
      boxFrom(pl.pos, pl.half, this._min, this._max);
      if (boxOverlap(this._min, this._max, this.regionMin, this.regionMax)) p = true;
    }
    if (p !== this.pressed) {
      this.pressed = p;
      this.game.audio.plate(p);
      if (this.onChange) this.onChange(p, this);
    }
    this.anim = damp(this.anim, p ? 1 : 0, 10, dt);
    this.top.position.y = this.pos.y + 0.08 - 0.045 * this.anim;
    this.topMat.emissiveIntensity = 0.3 + this.anim * 2.4;
  }
}

/* Physics props: cubes, energy cores, keycards and perception blocks ------- */
const PROP_NAMES = { cube: 'cube', core: 'energy core', key: 'keycard', perception: 'perception block' };
class PhysObject extends Entity {
  constructor(level, { kind = 'cube', pos, size = 0.7, cradle = false }) {
    super(level);
    this.kind = kind;
    this.pos = pos.clone();
    this.vel = V3();
    this.size = size;
    this.baseSize = size;
    this.half = V3(size / 2, size / 2, size / 2);
    this.held = false;
    this.locked = false; // permanently socketed
    this.cradle = cradle; // floating in a holder until picked up
    this.grounded = false;
    this.spin = 0;
    this.home = pos.clone();
    const M = this.game.M;
    this.mesh = new THREE.Group();
    if (kind === 'core') {
      const shell = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), new THREE.MeshStandardMaterial({ color: 0x9fdcff, transparent: true, opacity: 0.22, roughness: 0.05, metalness: 0.2, depthWrite: false }));
      level.own(shell.material);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(size, size, size)), new THREE.LineBasicMaterial({ color: new THREE.Color(0x4fd8ff).multiplyScalar(2) }));
      level.own(edges.material);
      this.inner = new THREE.Mesh(new THREE.IcosahedronGeometry(size * 0.3, 0), neon(0xffc457, 2.2));
      this.mesh.add(shell, edges, this.inner);
      this.pickMesh = shell;
    } else if (kind === 'key') {
      // A keycard hovering inside a faint glass shell (the shell is its collider).
      const shell = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), new THREE.MeshBasicMaterial({ color: 0x4fd8ff, transparent: true, opacity: 0.06, depthWrite: false }));
      level.own(shell.material);
      const cardMat = new THREE.MeshStandardMaterial({ color: 0xffc457, metalness: 0.7, roughness: 0.3, emissive: 0xffa020, emissiveIntensity: 0.6 });
      level.own(cardMat);
      this.inner = new THREE.Mesh(new THREE.BoxGeometry(size * 0.85, size * 0.12, size * 0.6), cardMat);
      this.inner.castShadow = true;
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(size * 0.86, size * 0.125, size * 0.1), neon(0x4fd8ff, 2.5));
      stripe.position.z = size * 0.15;
      this.inner.add(stripe);
      this.mesh.add(shell, this.inner);
      this.pickMesh = shell;
    } else {
      const mat = kind === 'perception' ? M.perception : M.cube;
      const box = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), mat);
      box.castShadow = true; box.receiveShadow = true;
      this.box = box;
      this.mesh.add(box);
      this.pickMesh = box;
      if (kind === 'perception') {
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(size * 1.02, size * 1.02, size * 1.02)), new THREE.LineBasicMaterial({ color: new THREE.Color(0xd6b0ff).multiplyScalar(2.5) }));
        level.own(edges.material);
        this.mesh.add(edges);
      }
    }
    this.mesh.position.copy(this.pos);
    level.scene.add(this.mesh);
    this.solid = level.world.add(V3(), V3(), this, 'object');
    this.solid.enabled = !cradle;
    this.syncSolid();
    level.objects.push(this);
    level.addPick(this.pickMesh, this);
    this.range = kind === 'perception' ? 60 : 3.4;
  }
  syncSolid() { boxFrom(this.pos, this.half, this.solid.min, this.solid.max); }
  setSize(s) {
    this.size = s;
    this.half.setScalar(s / 2);
    this.mesh.scale.setScalar(s / this.baseSize);
    this.syncSolid();
  }
  get label() {
    return this.kind === 'perception' ? 'Grab perception block' : `Pick up ${PROP_NAMES[this.kind]}`;
  }
  prompt(game) {
    if (this.held || this.locked) return null;
    if (game.player.ground && game.player.ground.owner === this && game.player.grounded) return { text: "Can't lift — you're standing on it", far: true };
    return { text: this.label };
  }
  interact(game) {
    if (this.held || this.locked) return;
    if (game.player.ground && game.player.ground.owner === this && game.player.grounded) { game.audio.deny(); return; }
    game.pickUp(this);
  }
  lockInto(pos) {
    this.locked = true;
    this.held = false;
    this.cradle = false;
    this.pos.copy(pos);
    this.vel.set(0, 0, 0);
    this.solid.enabled = false;
    this.mesh.position.copy(pos);
  }
  update(dt) {
    this.spin += dt;
    if (this.inner && this.kind === 'core') { this.inner.rotation.x += dt * 1.3; this.inner.rotation.y += dt * 1.9; }
    if (this.inner && this.kind === 'key') this.inner.rotation.y += dt * 1.6;
    if (this.held || this.locked) { this.mesh.position.copy(this.pos); return; }
    if (this.cradle) {
      this.mesh.position.copy(this.pos);
      this.mesh.position.y += Math.sin(this.spin * 2) * 0.04;
      this.mesh.rotation.y += dt * 0.8;
      return;
    }
    const g = this.game.player.up;
    this.vel.addScaledVector(g, -GRAVITY * dt);
    const vg = this.vel.dot(g);
    if (vg < -40) this.vel.addScaledVector(g, -40 - vg);
    const ignore = (s) => s.owner === this;
    const res = moveBody(this.pos, this.vel, this.half, dt, this.level.world, { up: g, ignore });
    if (res.grounded) {
      if (!this.grounded && res.impact > 3) this.game.audio.thud(res.impact / 6);
      // ground friction
      const vUp = this.vel.dot(g);
      const lat = _v1.copy(this.vel).addScaledVector(g, -vUp);
      lat.multiplyScalar(Math.exp(-8 * dt));
      this.vel.copy(lat).addScaledVector(g, vUp);
      if (res.ground && res.ground.kinematic) this.pos.add(res.ground.delta);
    }
    this.grounded = res.grounded;
    this.syncSolid();
    this.mesh.position.copy(this.pos);
  }
}

/* Energy core socket ----------------------------------------------------- */
class Socket extends Entity {
  constructor(level, { pos, normal, onInsert = null, accepts = 'core', upHint = null }) {
    super(level);
    this.filled = false;
    this.onInsert = onInsert;
    this.accepts = accepts;
    this.normal = normal.clone();
    this.group = new THREE.Group();
    this.group.position.copy(pos);
    orientUp(this.group, normal);
    const M = this.game.M;
    const k = accepts === 'key' ? 0.6 : 1;
    const base = new THREE.Mesh(new THREE.BoxGeometry(1.0 * k, 0.16, 1.0 * k), M.trim);
    base.position.y = 0.08;
    const frame = new THREE.Mesh(new THREE.TorusGeometry(0.42 * k, 0.05, 8, 32), neon(accepts === 'key' ? 0x4fd8ff : 0xffc457, 2.2));
    frame.rotation.x = Math.PI / 2;
    frame.position.y = 0.2;
    this.lightMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff5470).multiplyScalar(2) });
    level.own(this.lightMat);
    const light = new THREE.Mesh(new THREE.BoxGeometry(0.7 * k, 0.04, 0.08), this.lightMat);
    light.position.set(0, 0.18, 0.46 * k);
    this.group.add(base, frame, light);
    level.scene.add(this.group);
    level.addPick(base, this);
    this.anchor = pos.clone().addScaledVector(normal, accepts === 'key' ? 0.32 : 0.55);
    this.range = 3.4;
  }
  acceptsHeld(h) { return !this.filled && h && h.kind === this.accepts; }
  prompt(game) {
    if (this.filled) return null;
    const name = PROP_NAMES[this.accepts];
    if (this.acceptsHeld(game.held)) return { text: `Insert ${name}` };
    return { text: `${this.accepts === 'key' ? 'Keycard reader' : 'Socket'} — requires ${this.accepts === 'key' ? 'a' : 'an'} ${name}`, far: true };
  }
  interact(game) {
    if (!this.acceptsHeld(game.held)) { game.audio.deny(); return; }
    const item = game.held;
    game.releaseHeld({ silent: true });
    item.lockInto(this.anchor);
    this.filled = true;
    this.lightMat.color.set(0x5dffb0).multiplyScalar(2);
    game.audio.core();
    game.flash(this.accepts === 'key' ? 0x4fd8ff : 0xffc457, 0.25);
    if (this.onInsert) this.onInsert(this);
  }
}

/* Gravity panel ------------------------------------------------------------ */
class GravityPanel extends Entity {
  constructor(level, { pos, normal, size = 1.6, range = 32 }) {
    super(level);
    this.normal = snapAxis(normal);
    this.range = range;
    this.size = size;
    const g = new THREE.Group();
    g.position.copy(pos).addScaledVector(this.normal, 0.02);
    orientUp(g, this.normal);
    const back = new THREE.Mesh(new THREE.BoxGeometry(size + 0.2, 0.03, size + 0.2), this.game.M.trim);
    this.mat = new THREE.MeshBasicMaterial({ map: this.game.tex.symbol('gravity', '#ffc457'), transparent: true, depthWrite: false, color: new THREE.Color(1.6, 1.6, 1.6) });
    level.own(this.mat);
    const face = new THREE.Mesh(new THREE.PlaneGeometry(size, size), this.mat);
    face.rotation.x = -Math.PI / 2;
    face.position.y = 0.025;
    const ring = new THREE.Mesh(new THREE.RingGeometry(size * 0.62, size * 0.68, 40), neon(0xffc457, 1.5, { side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.03;
    this.ring = ring;
    g.add(back, face, ring);
    level.scene.add(g);
    level.addPick(back, this);
    level.addPick(face, this);
    this.group = g;
    this.t = Math.random() * 10;
  }
  prompt(game) {
    if (game.player.up.equals(this.normal)) return { text: 'Gravity already points here', far: true };
    return { text: `Shift gravity → ${gravityName(this.normal)}` };
  }
  interact(game) {
    if (game.player.up.equals(this.normal)) { game.audio.deny(); return; }
    game.shiftGravity(this.normal);
  }
  update(dt) {
    this.t += dt;
    const active = this.game.player.up.equals(this.normal);
    const k = active ? 0.5 : 1.3 + Math.sin(this.t * 3) * 0.35;
    this.mat.color.setRGB(k, k, k);
    this.ring.scale.setScalar(1 + Math.sin(this.t * 2) * 0.04);
  }
}

/* Simple region trigger ----------------------------------------------------- */
class Trigger extends Entity {
  constructor(level, { min, max, onEnter, once = true }) {
    super(level);
    this.min = min.clone();
    this.max = max.clone();
    this.onEnter = onEnter;
    this.once = once;
    this.inside = false;
    this.done = false;
  }
  update() {
    if (this.done) return;
    const p = this.game.player.pos;
    const inside = p.x > this.min.x && p.x < this.max.x && p.y > this.min.y && p.y < this.max.y && p.z > this.min.z && p.z < this.max.z;
    if (inside && !this.inside) {
      if (this.once) this.done = true;
      this.onEnter(this);
    }
    this.inside = inside;
  }
}

/* Moving platform ---------------------------------------------------------- */
class MovingPlatform extends Entity {
  constructor(level, { min, max, offset, travel = 6, wait = 2.5, mat = null }) {
    super(level);
    this.offset = offset.clone();
    this.travel = travel;
    this.wait = wait;
    this.time = 0;
    this.s = 0;
    const size = V3().subVectors(max, min);
    this.startCenter = V3().addVectors(min, max).multiplyScalar(0.5);
    this.mesh = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), mat || this.game.M.metal);
    body.castShadow = true; body.receiveShadow = true;
    const glow = new THREE.Mesh(new THREE.BoxGeometry(size.x + 0.06, 0.06, size.z + 0.06), neon(0x4fd8ff, 2.5));
    glow.position.y = -size.y / 2 + 0.05;
    const under = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.2, 0.5, 12), neon(0xb47cff, 2.5));
    under.position.y = -size.y / 2 - 0.25;
    this.mesh.add(body, glow, under);
    this.mesh.position.copy(this.startCenter);
    level.scene.add(this.mesh);
    this.halfSize = size.multiplyScalar(0.5);
    this.solid = level.world.add(min, max, this, 'platform');
    this.solid.kinematic = true;
  }
  update(dt) {
    this.time += dt;
    const cycle = 2 * (this.travel + this.wait);
    const t = this.time % cycle;
    let s;
    if (t < this.wait) s = 0;
    else if (t < this.wait + this.travel) s = easeInOut((t - this.wait) / this.travel);
    else if (t < 2 * this.wait + this.travel) s = 1;
    else s = 1 - easeInOut((t - 2 * this.wait - this.travel) / this.travel);
    const prev = this.s;
    this.s = s;
    const c = _v1.copy(this.startCenter).addScaledVector(this.offset, s);
    this.mesh.position.copy(c);
    this.solid.delta.copy(this.offset).multiplyScalar(s - prev);
    this.solid.min.copy(c).sub(this.halfSize);
    this.solid.max.copy(c).add(this.halfSize);
  }
}

/* Room / structure that rotates in 90° steps --------------------------------- */
class RotatingGroup extends Entity {
  constructor(level, { pivot, axis = 'z', duration = 1.8, initialSteps = 0, onRotated = null }) {
    super(level);
    this.group = new THREE.Group();
    this.group.position.copy(pivot);
    this.axis = axis;
    this.duration = duration;
    this.steps = initialSteps;
    this.angle = (initialSteps * Math.PI) / 2;
    this.group.rotation[axis] = this.angle;
    this.parts = [];
    this.blockers = [];
    this.anim = null;
    this.onRotated = onRotated;
    level.scene.add(this.group);
  }
  addBox(x0, y0, z0, x1, y1, z1, mat, { solid = true, shadow = true } = {}) {
    const m = new THREE.Mesh(worldBoxGeo(x0, y0, z0, x1, y1, z1), mat);
    m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    m.castShadow = shadow; m.receiveShadow = true;
    this.group.add(m);
    if (solid) {
      const s = this.level.world.add(V3(), V3(), this, 'rotor');
      this.parts.push({ min: V3(x0, y0, z0), max: V3(x1, y1, z1), solid: s });
    }
    return m;
  }
  addBlocker(min, max) {
    const s = this.level.world.add(min, max, this, 'blocker');
    s.enabled = false;
    this.blockers.push(s);
  }
  refreshSolids() {
    this.group.updateMatrixWorld(true);
    const m = this.group.matrixWorld;
    for (const p of this.parts) {
      const mn = V3(Infinity, Infinity, Infinity), mx = V3(-Infinity, -Infinity, -Infinity);
      for (let i = 0; i < 8; i++) {
        _v1.set(i & 1 ? p.max.x : p.min.x, i & 2 ? p.max.y : p.min.y, i & 4 ? p.max.z : p.min.z).applyMatrix4(m);
        mn.min(_v1); mx.max(_v1);
      }
      const r = (v) => Math.round(v * 1000) / 1000;
      p.solid.min.set(r(mn.x), r(mn.y), r(mn.z));
      p.solid.max.set(r(mx.x), r(mx.y), r(mx.z));
      p.solid.enabled = !this.anim;
    }
  }
  rotate() {
    if (this.anim) return false;
    this.anim = { from: this.angle, to: this.angle + Math.PI / 2, t: 0 };
    for (const p of this.parts) p.solid.enabled = false;
    for (const b of this.blockers) b.enabled = true;
    this.game.audio.rumble(this.duration);
    this.game.player.shake = this.duration;
    return true;
  }
  get busy() { return !!this.anim; }
  update(dt) {
    if (!this.anim) return;
    this.anim.t = Math.min(1, this.anim.t + dt / this.duration);
    this.angle = lerp(this.anim.from, this.anim.to, easeInOut(this.anim.t));
    this.group.rotation[this.axis] = this.angle;
    if (this.anim.t >= 1) {
      this.anim = null;
      this.steps = (this.steps + 1) % 4;
      this.angle = (this.steps * Math.PI) / 2;
      this.group.rotation[this.axis] = this.angle;
      this.refreshSolids();
      for (const b of this.blockers) b.enabled = false;
      if (this.onRotated) this.onRotated(this.steps);
    }
  }
}

/* Portal ------------------------------------------------------------------- */
const PORTAL_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const PORTAL_FRAG = /* glsl */`
uniform sampler2D tView;
uniform vec2 uRes;
uniform float uTime;
uniform vec3 uColor;
uniform float uReady;
uniform vec2 uSize;
varying vec2 vUv;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  vec2 suv = gl_FragCoord.xy / uRes;
  vec3 view = texture2D(tView, suv).rgb;
  vec2 d = min(vUv, 1.0 - vUv) * uSize;
  float e = min(d.x, d.y);
  float rim = smoothstep(0.12, 0.0, e);
  float inner = smoothstep(0.45, 0.0, e);
  float sw = sin((vUv.x * uSize.x + vUv.y * uSize.y) * 6.0 - uTime * 4.0) * 0.5 + 0.5;
  float sparkle = step(0.993, hash(floor(vUv * uSize * 40.0) + floor(uTime * 8.0))) * inner;
  vec3 col = mix(uColor * 0.08, view, uReady);
  col += uColor * (rim * (0.9 + sw * 0.5) + inner * 0.04 + sparkle * 1.2);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

class Portal extends Entity {
  constructor(level, { pos, normal, up = Y_UP, w = 1.8, h = 2.6, color = 0x4fd8ff }) {
    super(level);
    this.w = w; this.h = h;
    this.color = new THREE.Color(color);
    const z = normal.clone().normalize();
    const y = up.clone().normalize();
    const x = V3().crossVectors(y, z);
    this.normal = z;
    this.upv = y;
    this.center = pos.clone();
    this.matrix = new THREE.Matrix4().makeBasis(x, y, z).setPosition(pos);
    this.inv = this.matrix.clone().invert();
    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = false;
    this.group.matrix.copy(this.matrix);
    level.scene.add(this.group);
    this.rt = new THREE.WebGLRenderTarget(4, 4, { type: this.game.rtType });
    level.own(this.rt);
    this.uniforms = {
      tView: { value: this.rt.texture },
      uRes: { value: new THREE.Vector2(1, 1) },
      uTime: { value: 0 },
      uColor: { value: this.color.clone() },
      uReady: { value: 0 },
      uSize: { value: new THREE.Vector2(w, h) },
    };
    const mat = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: PORTAL_VERT, fragmentShader: PORTAL_FRAG });
    level.own(mat);
    this.surface = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    this.surface.position.z = 0.0;
    this.group.add(this.surface);
    // Glowing frame
    const fm = neon(color, 1.3);
    const t = 0.08, dz = 0.04;
    const bars = [
      [-w / 2 - t / 2, 0, t, h + 2 * t],
      [w / 2 + t / 2, 0, t, h + 2 * t],
      [0, h / 2 + t / 2, w, t],
      [0, -h / 2 - t / 2, w, t],
    ];
    for (const [bx, by, bw, bh] of bars) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, 0.08), fm);
      b.position.set(bx, by, dz);
      this.group.add(b);
    }
    this.light = new THREE.PointLight(color, 2.5, 5, 2);
    this.light.position.set(0, 0, 0.8);
    this.group.add(this.light);
    this.group.updateMatrixWorld(true);
    this.link = null;
    this.sphere = new THREE.Sphere(pos.clone(), Math.hypot(w, h) / 2 + 0.2);
    level.portals.push(this);
  }
  static pair(a, b) {
    a.link = b; b.link = a;
    a.computeTransform(); b.computeTransform();
  }
  computeTransform() {
    const R = new THREE.Matrix4().makeRotationY(Math.PI);
    this.toLink = new THREE.Matrix4().multiplyMatrices(this.link.matrix, R).multiply(this.inv);
    this.toLinkQ = new THREE.Quaternion().setFromRotationMatrix(this.toLink);
  }
  localOf(p, out) { return out.copy(p).applyMatrix4(this.inv); }
  // Is a point inside the portal opening region just behind its surface?
  captures(local, depth = 1.6) {
    return local.z < 0.1 && local.z > -depth && Math.abs(local.x) < this.w / 2 && Math.abs(local.y) < this.h / 2;
  }
  update(dt) { this.uniforms.uTime.value += dt; }
}

/* Forced-perspective cluster ---------------------------------------------------
   Pieces are displaced along the rays from a single viewpoint and scaled
   proportionally, so from that viewpoint the cluster looks whole while
   from anywhere else it is scattered fragments. */
function perspectiveTransform(V, truePos, trueScale, k, outPos, outScale) {
  outPos.copy(truePos).sub(V).multiplyScalar(k).add(V);
  outScale.copy(trueScale).multiplyScalar(k);
}

class PerspectiveBridge extends Entity {
  constructor(level, { viewpoint, target, segments, mat, locked = false, onLock = null }) {
    super(level);
    this.V = viewpoint.clone();
    this.target = target.clone();
    this.onLock = onLock;
    this.state = locked ? 'locked' : 'scattered';
    this.t = 0;
    this.glow = 0;
    this.segs = [];
    const rnd = mulberry32(1337);
    const ks = [1.6, 2.2, 0.7, 1.9, 0.6, 1.4, 0.55, 1.25];
    this.edgeMat = level.own(new THREE.LineBasicMaterial({ color: new THREE.Color(0xb47cff).multiplyScalar(2.2) }));
    const edgeGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
    segments.forEach((s, i) => {
      const center = V3().addVectors(s.min, s.max).multiplyScalar(0.5);
      const size = V3().subVectors(s.max, s.min);
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
      mesh.castShadow = true; mesh.receiveShadow = true;
      mesh.add(new THREE.LineSegments(edgeGeo, this.edgeMat));
      level.scene.add(mesh);
      const k = locked ? 1 : ks[i % ks.length] * (0.95 + rnd() * 0.1);
      const seg = { center, size, mesh, k0: k, k, spin: (rnd() - 0.5) * 0.6, solid: null, min: s.min.clone(), max: s.max.clone() };
      this.segs.push(seg);
      this.place(seg);
      if (locked) seg.solid = level.world.add(s.min, s.max, this, 'bridge');
    });
  }
  place(seg) {
    perspectiveTransform(this.V, seg.center, seg.size, seg.k, seg.mesh.position, seg.mesh.scale);
  }
  isAligned() {
    const cam = this.game.camera;
    const d = cam.position.distanceTo(this.V);
    if (d > 0.55) return false;
    const look = _v1.set(0, 0, -1).applyQuaternion(cam.quaternion);
    const want = _v2.subVectors(this.target, cam.position).normalize();
    return look.dot(want) > Math.cos(THREE.MathUtils.degToRad(14));
  }
  get pickable() { return this.state === 'scattered' && this.isAligned(); }
  lock() {
    if (this.state !== 'scattered') return;
    this.state = 'locking';
    this.t = 0;
    this.game.audio.perspective();
    if (this.onLock) this.onLock(this);
  }
  update(dt) {
    if (this.state === 'locking') {
      this.t = Math.min(1, this.t + dt / 2.6);
      const e = easeInOut(this.t);
      for (const s of this.segs) { s.k = lerp(s.k0, 1, e); this.place(s); }
      if (this.t >= 1) {
        this.state = 'locked';
        for (const s of this.segs) s.solid = this.level.world.add(s.min, s.max, this, 'bridge');
        this.game.flash(0xb47cff, 0.3);
      }
    }
  }
}

/* Floating glyph assembled from fragments (forced perspective, decorative clue). */
class PerspectiveGlyph extends Entity {
  constructor(level, { viewpoint, planeCenter, planeRight, planeUp, glyph, size = 2.4, bounds, seed = 1, color = 0xffc457 }) {
    super(level);
    this.V = viewpoint.clone();
    this.center = planeCenter.clone();
    const pieces = [];
    const R = planeRight.clone().normalize(), U = planeUp.clone().normalize();
    const N = V3().crossVectors(R, U);
    const strokes = [];
    const s = size / 2;
    if (glyph === 'circle') {
      const n = 22;
      for (let i = 0; i < n; i++) {
        const a0 = (i / n) * TAU, a1 = ((i + 1) / n) * TAU;
        strokes.push([[Math.cos(a0) * s * 0.85, Math.sin(a0) * s * 0.85], [Math.cos(a1) * s * 0.85, Math.sin(a1) * s * 0.85]]);
      }
    } else {
      const pts = glyph === 'triangle'
        ? [[0, s], [s * 0.95, -s * 0.75], [-s * 0.95, -s * 0.75]]
        : [[-s * 0.8, s * 0.8], [s * 0.8, s * 0.8], [s * 0.8, -s * 0.8], [-s * 0.8, -s * 0.8]];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const n = Math.max(1, Math.round(len / 0.32));
        for (let j = 0; j < n; j++) {
          const t0 = j / n, t1 = (j + 1) / n;
          strokes.push([[lerp(a[0], b[0], t0), lerp(a[1], b[1], t0)], [lerp(a[0], b[0], t1), lerp(a[1], b[1], t1)]]);
        }
      }
    }
    const rnd = mulberry32(seed);
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(2.2) });
    level.own(mat);
    this.mat = mat;
    this.baseColor = new THREE.Color(color);
    this.mesh = new THREE.InstancedMesh(geo, mat, strokes.length);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = V3(), p = V3(), outP = V3(), outS = V3();
    const basis = new THREE.Matrix4().makeBasis(R, U, N);
    strokes.forEach(([a, b], i) => {
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) + 0.06;
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      p.copy(this.center).addScaledVector(R, mx).addScaledVector(U, my);
      q.setFromRotationMatrix(basis).multiply(_q1.setFromAxisAngle(V3(0, 0, 1), ang));
      sc.set(len, 0.16, 0.03);
      // Choose a depth factor that keeps the fragment inside the room bounds.
      let k = 1;
      for (let tries = 0; tries < 30; tries++) {
        k = lerp(0.35, 3.0, rnd());
        outP.copy(p).sub(this.V).multiplyScalar(k).add(this.V);
        if (outP.x > bounds.min.x && outP.x < bounds.max.x && outP.y > bounds.min.y && outP.y < bounds.max.y && outP.z > bounds.min.z && outP.z < bounds.max.z) break;
        k = 1;
      }
      perspectiveTransform(this.V, p, sc, k, outP, outS);
      m4.compose(outP, q, outS);
      this.mesh.setMatrixAt(i, m4);
      pieces.push(k);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
    level.scene.add(this.mesh);
    this.glow = 0;
  }
  isAligned() {
    const cam = this.game.camera;
    if (cam.position.distanceTo(this.V) > 0.6) return false;
    const look = _v1.set(0, 0, -1).applyQuaternion(cam.quaternion);
    const want = _v2.subVectors(this.center, cam.position).normalize();
    return look.dot(want) > Math.cos(THREE.MathUtils.degToRad(12));
  }
  update(dt) {
    this.glow = damp(this.glow, this.isAligned() ? 1 : 0, 5, dt);
    this.mat.color.copy(this.baseColor).multiplyScalar(1.15 + this.glow * 1.5);
  }
  dispose() {
    this.level.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    const i = this.level.entities.indexOf(this);
    if (i >= 0) this.level.entities.splice(i, 1);
  }
}

/* Drifting particles (dust, sparks, stars) ------------------------------------ */
class ParticleField extends Entity {
  constructor(level, { count = 300, min, max, color = 0x9fdcff, size = 0.06, drift = V3(0, 0.05, 0), jitter = 0.05, intensity = 1.6, opacity = 0.8 }) {
    super(level);
    this.min = min.clone(); this.max = max.clone();
    this.drift = drift.clone();
    this.jitter = jitter;
    const pos = new Float32Array(count * 3);
    this.phase = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = rand(min.x, max.x);
      pos[i * 3 + 1] = rand(min.y, max.y);
      pos[i * 3 + 2] = rand(min.z, max.z);
      this.phase[i] = Math.random() * TAU;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      size, map: this.game.tex.glowSprite(), color: new THREE.Color(color).multiplyScalar(intensity),
      transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
    });
    level.own(mat);
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    level.scene.add(this.points);
    this.time = 0;
    this.speedMul = 1;
  }
  update(dt) {
    this.time += dt;
    const a = this.points.geometry.attributes.position;
    const arr = a.array;
    const n = arr.length / 3;
    const d = this.drift, j = this.jitter * this.speedMul;
    const mn = this.min, mx = this.max;
    for (let i = 0; i < n; i++) {
      const ph = this.phase[i];
      let x = arr[i * 3] + (d.x * this.speedMul + Math.sin(this.time * 0.7 + ph) * j) * dt;
      let y = arr[i * 3 + 1] + (d.y * this.speedMul + Math.cos(this.time * 0.5 + ph * 1.3) * j) * dt;
      let z = arr[i * 3 + 2] + (d.z * this.speedMul + Math.sin(this.time * 0.6 + ph * 0.7) * j) * dt;
      if (x < mn.x) x = mx.x; else if (x > mx.x) x = mn.x;
      if (y < mn.y) y = mx.y; else if (y > mx.y) y = mn.y;
      if (z < mn.z) z = mx.z; else if (z > mx.z) z = mn.z;
      arr[i * 3] = x; arr[i * 3 + 1] = y; arr[i * 3 + 2] = z;
    }
    a.needsUpdate = true;
  }
}

/* ---------------------------------------------------------------------
   Level base class: owns a scene, a physics world, entities, and a set
   of builder helpers used by the concrete levels below.
   --------------------------------------------------------------------- */
class Level {
  constructor(game, cp = 0) {
    this.game = game;
    this.M = game.M;
    this.cp = cp;
    this.checkpoint = cp;
    this.scene = new THREE.Scene();
    this.world = new PhysicsWorld();
    this.entities = [];
    this.pickMeshes = [];
    this.objects = [];
    this.portals = [];
    this.spinners = [];
    this.disposables = [];
    this.deferred = [];
    this.spawn = { pos: V3(0, 0, 0), up: V3(0, 1, 0), look: V3(0, 0, -1) };
    this.bounds = { min: V3(-150, -60, -150), max: V3(150, 150, 150) };
    this.hints = [];
    this.showGravity = false;
    this.objectiveText = '';
    this.time = 0;
  }
  get meta() { return this.constructor.meta; }
  build() {}
  update() {}
  contextPrompt() { return null; }
  onGravityChanged() {}
  own(x) { this.disposables.push(x); return x; }
  defer(fn) { this.deferred.push(fn); }
  runDeferred() {
    while (this.deferred.length) this.deferred.shift()();
  }
  addPick(mesh, ent) {
    mesh.userData.ent = ent;
    this.pickMeshes.push(mesh);
  }
  objective(text) {
    if (text === this.objectiveText) return;
    this.objectiveText = text;
    this.game.ui.setObjective(text);
  }
  setCheckpoint(n) {
    if (n <= this.checkpoint) return;
    this.checkpoint = n;
    this.game.ui.toast('CHECKPOINT REACHED', 'good');
  }
  isOutOfBounds(p) {
    const b = this.bounds;
    return p.x < b.min.x || p.y < b.min.y || p.z < b.min.z || p.x > b.max.x || p.y > b.max.y || p.z > b.max.z;
  }
  // ---- atmosphere ------------------------------------------------------
  setAtmosphere({ bg = 0x0a0c12, fog = null, density = 0.02, env = 0.5, hemi = [0xdfe8ff, 0x22262e, 0.5] } = {}) {
    this.scene.background = new THREE.Color(bg);
    this.scene.fog = new THREE.FogExp2(fog == null ? bg : fog, density);
    this.scene.environment = this.game.envMap;
    this.scene.environmentIntensity = env;
    if (hemi) this.scene.add(new THREE.HemisphereLight(hemi[0], hemi[1], hemi[2]));
  }
  // ---- geometry --------------------------------------------------------
  box(x0, y0, z0, x1, y1, z1, mat, { solid = true, shadow = true, receive = true, scale = 4, tag = 'static', owner = null } = {}) {
    if (x0 > x1) [x0, x1] = [x1, x0];
    if (y0 > y1) [y0, y1] = [y1, y0];
    if (z0 > z1) [z0, z1] = [z1, z0];
    const mesh = new THREE.Mesh(worldBoxGeo(x0, y0, z0, x1, y1, z1, scale), mat);
    mesh.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    mesh.castShadow = shadow;
    mesh.receiveShadow = receive;
    this.scene.add(mesh);
    if (solid) mesh.userData.solid = this.world.addBox(x0, y0, z0, x1, y1, z1, owner, tag);
    return mesh;
  }
  // A wall slab perpendicular to `axis` with rectangular holes cut out.
  // axis 'x': spans z (a) and y (b); 'z': spans x (a) and y (b); 'y': spans x (a) and z (b).
  wall(axis, c0, c1, a0, a1, b0, b1, mat, holes = [], opts = {}) {
    const as = new Set([a0, a1]), bs = new Set([b0, b1]);
    for (const h of holes) {
      as.add(clamp(h.a0, a0, a1)); as.add(clamp(h.a1, a0, a1));
      bs.add(clamp(h.b0, b0, b1)); bs.add(clamp(h.b1, b0, b1));
    }
    const A = [...as].sort((p, q) => p - q), B = [...bs].sort((p, q) => p - q);
    const inHole = (a, b) => holes.some((h) => a > h.a0 && a < h.a1 && b > h.b0 && b < h.b1);
    const meshes = [];
    for (let j = 0; j < B.length - 1; j++) {
      let start = null;
      for (let i = 0; i <= A.length - 1; i++) {
        const filled = i < A.length - 1 && !inHole((A[i] + A[i + 1]) / 2, (B[j] + B[j + 1]) / 2);
        if (filled && start === null) start = A[i];
        if (!filled && start !== null) {
          const ra0 = start, ra1 = A[i], rb0 = B[j], rb1 = B[j + 1];
          if (axis === 'x') meshes.push(this.box(c0, rb0, ra0, c1, rb1, ra1, mat, opts));
          else if (axis === 'z') meshes.push(this.box(ra0, rb0, c0, ra1, rb1, c1, mat, opts));
          else meshes.push(this.box(ra0, c0, rb0, ra1, c1, rb1, mat, opts));
          start = null;
        }
      }
    }
    return meshes;
  }
  strip(x0, y0, z0, x1, y1, z1, color = 0x4fd8ff, intensity = 2.5) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0)), neon(color, intensity));
    m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    this.scene.add(m);
    return m;
  }
  // Thin glowing outline of a horizontal rectangle.
  rim(x0, y, z0, x1, z1, color = 0x4fd8ff, intensity = 2.5, w = 0.04) {
    this.strip(x0, y, z0, x1, y + w, z0 + w, color, intensity);
    this.strip(x0, y, z1 - w, x1, y + w, z1, color, intensity);
    this.strip(x0, y, z0, x0 + w, y + w, z1, color, intensity);
    this.strip(x1 - w, y, z0, x1, y + w, z1, color, intensity);
  }
  // Orient a plane (facing +Z by default) to face `normal`, with `upHint` as its up.
  orientPlane(obj, normal, upHint = null) {
    const z = normal.clone().normalize();
    let y = upHint ? upHint.clone() : Math.abs(z.y) > 0.9 ? V3(0, 0, -1) : V3(0, 1, 0);
    y.addScaledVector(z, -y.dot(z)).normalize();
    const x = V3().crossVectors(y, z);
    obj.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
  }
  plane(map, pos, normal, w, h, { upHint = null, color = 1, transparent = true, blending = THREE.NormalBlending, fog = true } = {}) {
    const mat = new THREE.MeshBasicMaterial({ map, transparent, depthWrite: !transparent, color: new THREE.Color(color, color, color), blending, fog });
    this.own(mat);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    m.position.copy(pos);
    this.orientPlane(m, normal, upHint);
    this.scene.add(m);
    return m;
  }
  sign(lines, pos, normal, w, h, opts = {}) {
    const tex = this.own(this.game.tex.text(lines, { w: Math.round(256 * (w / h)) * 2, h: 512, size: opts.size || 120, ...opts }));
    const m = this.plane(tex, pos, normal, w, h, { upHint: opts.upHint || null, color: opts.brightness || 1.5, transparent: !!opts.transparentBg });
    m.userData.tex = tex;
    return m;
  }
  decal(text, pos, normal, w, h, opts = {}) {
    const tex = this.own(this.game.tex.text(text, { ...opts }));
    return this.plane(tex, pos, normal, w, h, { upHint: opts.upHint || null, color: opts.brightness || 1.6 });
  }
  symbolDecal(kind, color, pos, normal, size, opts = {}) {
    return this.plane(this.game.tex.symbol(kind, color), pos, normal, size, size, { upHint: opts.upHint || null, color: opts.brightness || 2, blending: THREE.AdditiveBlending });
  }
  // ---- lights ------------------------------------------------------------
  point(x, y, z, color = 0xffffff, intensity = 20, distance = 16) {
    const l = new THREE.PointLight(color, intensity, distance, 2);
    l.position.set(x, y, z);
    this.scene.add(l);
    return l;
  }
  spot(pos, target, { color = 0xffffff, intensity = 120, angle = 0.8, penumbra = 0.6, distance = 40, shadow = true } = {}) {
    const l = new THREE.SpotLight(color, intensity, distance, angle, penumbra, 2);
    l.position.copy(pos);
    l.target.position.copy(target);
    const q = this.game.quality;
    if (shadow && q.shadows) {
      l.castShadow = true;
      l.shadow.mapSize.set(q.shadowSize, q.shadowSize);
      l.shadow.bias = -0.0004;
      l.shadow.normalBias = 0.03;
      l.shadow.camera.near = 0.5;
      l.shadow.camera.far = distance;
    }
    this.scene.add(l, l.target);
    return l;
  }
  // Ceiling light panel (emissive) with optional real light.
  lamp(x, y, z, w = 2.4, d = 0.5, { color = 0xf4f8ff, intensity = 3, light = 0, distance = 14, dir = -1 } = {}) {
    const frame = new THREE.Mesh(new THREE.BoxGeometry(w + 0.12, 0.06, d + 0.12), this.M.trim);
    frame.position.set(x, y, z);
    const panel = new THREE.Mesh(new THREE.BoxGeometry(w, 0.04, d), neon(color, intensity));
    panel.position.set(x, y + dir * 0.03, z);
    this.scene.add(frame, panel);
    if (light > 0) this.point(x, y + dir * 0.4, z, color, light, distance);
    return panel;
  }
  spinner(obj, axis, speed) {
    this.spinners.push({ obj, axis: axis.clone().normalize(), speed });
    return obj;
  }
  // Floating decorative impossible sculpture.
  sculpture(pos, scale = 1, color = 0x4fd8ff) {
    const g = new THREE.Group();
    g.position.copy(pos);
    const ring1 = new THREE.Mesh(new THREE.TorusGeometry(1.0 * scale, 0.05 * scale, 10, 64), neon(color, 2.6));
    const ring2 = new THREE.Mesh(new THREE.TorusGeometry(0.75 * scale, 0.04 * scale, 10, 64), neon(0xb47cff, 2.6));
    const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.35 * scale, 0), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.15, metalness: 0.9, envMapIntensity: 1.5 }));
    this.own(core.material);
    core.castShadow = true;
    g.add(ring1, ring2, core);
    this.scene.add(g);
    this.spinner(ring1, V3(1, 0.3, 0), 0.7);
    this.spinner(ring2, V3(0, 1, 0.4), -1.1);
    this.spinner(core, V3(0, 1, 0), 0.9);
    return g;
  }
  exitZone(min, max) {
    new Trigger(this, { min, max, onEnter: () => this.game.completeLevel() });
  }
  // Green "EXIT" marker at the end of an exit corridor.
  exitMarker(pos, normal, upHint = null) {
    this.sign(['EXIT', 'proceed to next chamber'], pos, normal, 2.2, 1.0, { color: '#5dffb0', upHint, size: 150 });
    this.point(pos.x + normal.x * 1.5, pos.y + normal.y * 1.5, pos.z + normal.z * 1.5, 0x5dffb0, 18, 10);
  }
  updateCommon(dt) {
    this.time += dt;
    for (const s of this.spinners) s.obj.rotateOnAxis(s.axis, s.speed * dt);
  }
  dispose() {
    for (const e of this.entities) if (e.surface && e.rt) e.rt.dispose();
    this.scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
    });
    for (const d of this.disposables) if (d && d.dispose) d.dispose();
    this.disposables.length = 0;
    this.entities.length = 0;
    this.world.solids.length = 0;
  }
}

/* =====================================================================
   LEVEL 1 — THE BEGINNING
   A white test chamber that teaches movement, jumping, buttons, carrying
   cubes and pressure plates.
   ===================================================================== */
class Level1 extends Level {
  static meta = { name: 'THE BEGINNING', ambient: 'lab' };
  build() {
    const M = this.M;
    this.setAtmosphere({ bg: 0x0d1016, density: 0.018, env: 0.45, hemi: [0xe4ecff, 0x2a2f38, 0.35] });
    this.spawn = { pos: V3(0, 0, 6.2), up: Y_UP, look: V3(0, 0, -1) };
    this.bounds = { min: V3(-20, -20, -25), max: V3(20, 30, 20) };
    this.hints = [
      ctl('Use W A S D to walk and the mouse to look. Hold SHIFT to sprint.', 'Drag on the left half of the screen to walk and on the right half to look. Push the stick all the way to sprint.'),
      `The metal barrier is low enough to clear — run at it and ${ctl('press SPACE', 'tap JUMP')}.`,
      `Aim the crosshair at the glowing button on the pedestal and ${ctl('press E', 'tap USE')}.`,
      `The button opened a hidden alcove in the west wall. Pick up the cube with ${ctl('E', 'USE')}, carry it, and ${ctl('press E', 'tap USE')} again to drop it on the glowing plate.`,
    ];

    // ---- Main chamber shell ----
    this.box(-6.5, -0.5, -6.5, 6.5, 0, 8.5, M.whiteFloor);
    this.box(-6.5, 6, -6.5, 6.5, 6.5, 8.5, M.white);
    this.box(-6.5, 0, 8, 6.5, 6, 8.5, M.white);
    this.box(6, 0, -6, 6.5, 6, 8, M.white);
    this.wall('x', -6.5, -6, -6, 8, 0, 6, M.white, [{ a0: -3, a1: 1, b0: 0, b1: 3 }]);
    this.wall('z', -6.5, -6, -6.5, 6.5, 0, 6, M.white, [{ a0: -1.25, a1: 1.25, b0: 0, b1: 3 }]);
    // Skirting light strips
    this.strip(-5.98, 0.05, -6, -5.94, 0.12, 8, 0x4fd8ff, 1.8);
    this.strip(5.94, 0.05, -6, 5.98, 0.12, 8, 0x4fd8ff, 1.8);

    // ---- Storage alcove (behind the gate) ----
    this.box(-9.5, -0.5, -3.5, -6.5, 0, 1.5, M.whiteFloor);
    this.box(-9.5, 0, -3.5, -9, 3.5, 1.5, M.white);
    this.box(-9, 0, -3.5, -6.5, 3.5, -3, M.white);
    this.box(-9, 0, 1, -6.5, 3.5, 1.5, M.white);
    this.box(-9.5, 3, -3.5, -6.5, 3.5, 1.5, M.white);
    this.lamp(-7.8, 2.97, -1, 1.4, 0.4, { color: 0xb47cff, intensity: 3, light: 8, distance: 6 });
    this.gate = new Door(this, { min: V3(-6.45, 0, -3), max: V3(-6.1, 3, 1), slide: V3(0, 3.1, 0), mat: M.metal });
    this.sign(['STORAGE'], V3(-5.98, 3.5, -1), V3(1, 0, 0), 1.6, 0.45, { size: 150 });

    // ---- Jump barrier ----
    this.box(-6, 0, 1.8, 6, 0.8, 2.2, M.metal);
    this.strip(-6, 0.8, 1.98, 6, 0.83, 2.02, 0xffc457, 2.2);
    this.box(-6, 0.0, 2.2, 6, 0.02, 2.6, M.hazard, { solid: false, shadow: false });

    // ---- Button, plate and cube ----
    this.button = new Switch(this, {
      pos: V3(0, 0, -0.6), label: 'Press button', once: true,
      onPress: () => {
        this.gate.open();
        this.button.disabledText = 'Already activated';
        this.button.setColor(0x5dffb0);
        this.stage = Math.max(this.stage, 3);
        this.game.ui.toast('STORAGE UNLOCKED', 'good');
      },
    });
    this.plate = new PressurePlate(this, {
      pos: V3(3.5, 0, -3.6), size: 1.7,
      onChange: (on) => {
        if (on) { this.exit.open(); this.game.audio.chime(); this.stage = Math.max(this.stage, 4); }
        else this.exit.close();
      },
    });
    this.symbolDecal('cube', '#4fd8ff', V3(3.5, 0.02, -2.2), Y_UP, 0.6, { upHint: V3(0, 0, -1) });
    new PhysObject(this, { kind: 'cube', pos: V3(-7.7, 0.36, -1), size: 0.7 });

    // ---- Exit ----
    this.exit = new Door(this, { min: V3(-1.25, 0, -6.4), max: V3(1.25, 3, -6.1), slide: V3(0, 3.1, 0), mat: M.metal });
    this.box(-2.1, -0.5, -13.5, 2.1, 0, -6.5, M.whiteFloor);
    this.box(-2.1, 3.2, -13.5, 2.1, 3.7, -6.5, M.white);
    this.box(-2.1, 0, -13.5, -1.6, 3.2, -6.5, M.white);
    this.box(1.6, 0, -13.5, 2.1, 3.2, -6.5, M.white);
    this.box(-2.1, 0, -13.5, 2.1, 3.2, -13, M.white);
    this.strip(-1.58, 0.05, -13, -1.55, 0.1, -6.5, 0x5dffb0, 2);
    this.strip(1.55, 0.05, -13, 1.58, 0.1, -6.5, 0x5dffb0, 2);
    this.exitMarker(V3(0, 1.8, -12.98), V3(0, 0, 1));
    this.exitZone(V3(-1.6, 0, -12.5), V3(1.6, 3.2, -9.5));
    this.sign(['TEST CHAMBER 01', 'orientation & motor calibration'], V3(0, 4.3, -5.98), V3(0, 0, 1), 4.2, 1.2, { size: 120 });

    // ---- Lighting & decoration ----
    this.spot(V3(1, 5.8, 2), V3(0, 0, -1), { intensity: 110, angle: 1.0, penumbra: 0.7 });
    for (const [x, z] of [[-3, 4], [3, 4], [-3, -2], [3, -2]]) this.lamp(x, 5.97, z, 2.6, 0.5, { intensity: 2.4 });
    this.point(0, 4.5, 3, 0xe8f0ff, 14, 16);
    this.point(0, 4.5, -3, 0xe8f0ff, 12, 16);
    // Observation window with a watching red eye
    this.box(5.9, 3.2, -2.5, 5.99, 5.2, 2.5, new THREE.MeshStandardMaterial({ color: 0x05070a, roughness: 0.05, metalness: 0.9 }), { solid: false });
    this.watcher = this.strip(5.86, 4.62, 1.82, 5.9, 4.68, 1.88, 0xff3355, 2.5);
    this.sculpture(V3(0, 4.3, -0.6), 0.9);
    new ParticleField(this, { count: 220, min: V3(-6, 0.2, -6), max: V3(6, 5.8, 8), color: 0xcfe6ff, size: 0.035, intensity: 1.2, opacity: 0.6 });

    this.stage = 0;
  }
  update(dt) {
    const p = this.game.player.pos;
    if (this.stage === 0 && p.z < 4.6) this.stage = 1;
    if (this.stage === 1 && p.z < 1.7) this.stage = 2;
    if (this.stage === 4 && !this.plate.pressed) this.stage = 3;
    const objectives = [
      ctl('Walk forward (W A S D) and look around with the mouse.', 'Walk forward with your left thumb and look around with your right.'),
      `Jump over the barrier — ${ctl('press SPACE', 'tap JUMP')} while moving.`,
      `Press the button on the pedestal — aim and ${ctl('press E', 'tap USE')}.`,
      'Carry the cube from the storage alcove onto the pressure plate.',
      'The exit is open. Walk through the door.',
    ];
    this.objective(objectives[this.stage]);
    if (this.watcher) this.watcher.visible = Math.sin(this.time * 2.2) > -0.3;
  }
}

/* =====================================================================
   LEVEL 2 — THE IMPOSSIBLE HALLWAY
   The corridor loops forever. Doors teleport. A symbol only visible from
   a marked spot tells you which door is real. Three correct doors lead
   to the Scale Room, where objects are exactly as large as they appear.
   ===================================================================== */
class Level2 extends Level {
  static meta = { name: 'THE IMPOSSIBLE HALLWAY', ambient: 'hall' };
  build() {
    this.L = 20;
    this.answers = [1, 0, 2];
    this.glyphs = ['circle', 'triangle', 'square'];
    this.stageColors = [0x4fd8ff, 0xb47cff, 0xffc457, 0x5dffb0];
    this.stage = this.cp >= 1 ? 3 : 0;
    this.loops = 0;
    this.setAtmosphere({ bg: 0x05060a, density: 0.06, env: 0.3, hemi: [0x8090b0, 0x101218, 0.35] });
    this.bounds = { min: V3(-30, -20, -100), max: V3(70, 30, 30) };
    this.hints = [
      'The hallway repeats forever. Walking forward will never get you out — the doors are the way.',
      'Stand on the glowing eye painted on the floor and look straight down the corridor. The scattered fragments form a symbol.',
      'Open the door marked with that symbol and step through. A wrong door sends you back to the start.',
      'In the Scale Room, grab the block from close range, look toward the far plate and release — it keeps its apparent size.',
      'The heavy plate needs a block at least 2 metres wide. Grab the block from close up so it grows more when you look far away.',
    ];
    this.buildCorridor();
    this.buildScaleRoom();
    if (this.stage < 3) {
      this.spawn = { pos: V3(0, 0, 2), up: Y_UP, look: V3(0, 0, -1) };
      this.buildGlyphs();
    } else {
      this.spawn = { pos: V3(38, 0, -1.3), up: Y_UP, look: V3(0, 0, -1) };
    }
    this.applyStageColor();
    this.updateObjective();
  }
  buildCorridor() {
    const M = this.M, L = this.L, N = 4;
    const end = -N * L;
    this.box(-2.5, -0.5, end - 0.5, 2.5, 0, 4.5, M.darkFloor);
    this.box(-2.5, 4, end - 0.5, 2.5, 4.5, 4.5, M.concreteDark);
    this.box(-2.5, 0, 4, 2.5, 4, 4.5, M.concrete);
    this.box(-2.5, 0, end - 0.5, 2.5, 4, end, M.concreteDark);
    this.doorDefs = [
      { dz: -5, side: -1, glyph: 'circle' },
      { dz: -10, side: 1, glyph: 'triangle' },
      { dz: -15, side: -1, glyph: 'square' },
    ];
    const leftHoles = [], rightHoles = [];
    this.doors = [];
    this.stripMats = [];
    this.voidMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(0xb47cff) } },
      vertexShader: PORTAL_VERT,
      fragmentShader: /* glsl */`
        uniform float uTime; uniform vec3 uColor; varying vec2 vUv;
        void main() {
          vec2 p = vUv - 0.5;
          float r = length(p);
          float a = atan(p.y, p.x);
          float s = sin(a * 5.0 + r * 30.0 - uTime * 3.0) * 0.5 + 0.5;
          float v = smoothstep(0.55, 0.0, r) * (0.35 + 0.65 * s);
          gl_FragColor = vec4(uColor * v * 2.2 + vec3(0.02), 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.own(this.voidMat);
    for (let k = 0; k < N; k++) {
      const segZ = -k * L;
      this.doorDefs.forEach((def, i) => {
        const c = segZ + def.dz, s = def.side;
        (s < 0 ? leftHoles : rightHoles).push({ a0: c - 0.7, a1: c + 0.7, b0: 0, b1: 2.6 });
        const xa0 = s < 0 ? -3.6 : 2, xa1 = s < 0 ? -2 : 3.6;
        this.box(xa0, -0.5, c - 1.3, xa1, 0, c + 1.3, M.black, { shadow: false });
        this.box(xa0, 2.8, c - 1.3, xa1, 3.3, c + 1.3, M.black, { shadow: false });
        this.box(xa0, 0, c - 1.3, xa1, 2.8, c - 0.8, M.black, { shadow: false });
        this.box(xa0, 0, c + 0.8, xa1, 2.8, c + 1.3, M.black, { shadow: false });
        this.box(s < 0 ? -4.1 : 3.6, 0, c - 1.3, s < 0 ? -3.6 : 4.1, 3.3, c + 1.3, M.black, { shadow: false });
        const vp = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 2.8), this.voidMat);
        vp.position.set(s < 0 ? -3.58 : 3.58, 1.4, c);
        vp.rotation.y = s < 0 ? Math.PI / 2 : -Math.PI / 2;
        this.scene.add(vp);
        const door = new Door(this, {
          min: V3(s < 0 ? -2.42 : 2.3, 0, c - 0.7), max: V3(s < 0 ? -2.3 : 2.42, 2.6, c + 0.7),
          slide: V3(0, 0, 1.45), interactive: true, glyph: def.glyph, mat: M.metal, label: 'Open door', speed: 0.7,
          lightColor: 0xffc457, openColor: 0xb47cff,
        });
        door.setLight(0xffc457);
        this.doors.push(door);
        // glyph sign above the door and the door frame
        this.symbolDecal(def.glyph, '#ffc457', V3(s * 1.99, 3.25, c), V3(-s, 0, 0), 0.6);
        this.strip(s * 1.97, 0, c - 0.82, s * 2.0, 2.72, c - 0.74, 0xffc457, 1.4);
        this.strip(s * 1.97, 0, c + 0.74, s * 2.0, 2.72, c + 0.82, 0xffc457, 1.4);
        this.strip(s * 1.97, 2.64, c - 0.82, s * 2.0, 2.72, c + 0.82, 0xffc457, 1.4);
        new Trigger(this, {
          min: V3(s < 0 ? -3.7 : 2.56, 0, c - 0.8), max: V3(s < 0 ? -2.56 : 3.7, 3, c + 0.8), once: false,
          onEnter: () => this.defer(() => this.enterDoor(i)),
        });
      });
      // ceiling light strips (recoloured per stage), lamps, pipes
      for (const sx of [-1.6, 1.6]) {
        const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
        this.own(mat);
        this.stripMats.push(mat);
        const m = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.05, L - 1), mat);
        m.position.set(sx, 3.96, segZ - L / 2);
        this.scene.add(m);
      }
      this.box(-0.15, 3.55, segZ - L, 0.15, 3.85, segZ, M.metal, { solid: false, shadow: false });
      this.box(1.2, 3.65, segZ - L, 1.4, 3.85, segZ, M.trim, { solid: false, shadow: false });
      this.point(0, 3.3, segZ - 10, 0xffe2b8, 12, 16);
      // eye marker, loop plaque and misleading arrows
      this.symbolDecal('eye', '#ffc457', V3(0, 0.015, segZ - 2), Y_UP, 0.9, { upHint: V3(0, 0, -1), brightness: 2.4 });
      if (!this.plaqueTex) this.plaqueTex = this.own(this.game.tex.text(['LOOP 00', 'corridor 7-B'], { w: 512, h: 256, size: 64, color: '#ff8b5c' }));
      this.plane(this.plaqueTex, V3(1.99, 1.7, segZ - 3), V3(-1, 0, 0), 1.2, 0.6, { color: 1.5, transparent: false });
      for (const z of [segZ - 8, segZ - 18]) this.decal(['EXIT ▼'], V3(0, 0.012, z), Y_UP, 1.1, 0.55, { size: 140, color: '#4fd8ff', bg: null, border: false, upHint: V3(0, 0, -1) });
    }
    this.wall('x', -2.5, -2, end, 4, 0, 4, M.concrete, leftHoles);
    this.wall('x', 2, 2.5, end, 4, 0, 4, M.concrete, rightHoles);
    // Vestibule: the door you came from (sealed) and a terminal.
    this.box(-1.0, 0, 3.85, 1.0, 2.8, 4.0, M.metal, { solid: false });
    this.strip(-1.0, 2.8, 3.84, 1.0, 2.86, 3.9, 0xff5470, 2.5);
    this.sign(['THE HALLWAY IS PATIENT', 'every door leads somewhere · only one leads on'], V3(-1.99, 2.0, 1.6), V3(1, 0, 0), 3.0, 0.9, { size: 90, color: '#ffc457' });
    this.stageSign = this.sign(['SEQUENCE 0 / 3'], V3(1.99, 2.4, 1.6), V3(-1, 0, 0), 2.0, 0.6, { size: 120, color: '#4fd8ff' });
    new ParticleField(this, { count: 260, min: V3(-2, 0.2, -60), max: V3(2, 3.9, 4), color: 0xffd9a0, size: 0.03, intensity: 1.2, opacity: 0.5 });
  }
  buildGlyphs() {
    if (this.glyphEnts) for (const g of this.glyphEnts) g.dispose();
    this.glyphEnts = [];
    if (this.stage >= 3) return;
    const glyph = this.glyphs[this.answers[this.stage]];
    for (let k = 0; k < 4; k++) {
      const segZ = -k * this.L;
      const V = V3(0, 1.5 + 0.02, segZ - 2);
      this.glyphEnts.push(new PerspectiveGlyph(this, {
        viewpoint: V, planeCenter: V3(0, 1.75, segZ - 6.5), planeRight: V3(1, 0, 0), planeUp: V3(0, 1, 0),
        glyph, size: 2.2, seed: 100 + this.stage * 10 + k,
        bounds: { min: V3(-1.8, 0.2, segZ - 19), max: V3(1.8, 3.8, segZ - 3) },
      }));
    }
  }
  applyStageColor() {
    const c = new THREE.Color(this.stageColors[Math.min(this.stage, 3)]).multiplyScalar(1.3);
    for (const m of this.stripMats) m.color.copy(c);
    if (this.stageSign) this.stageSign.userData.tex.userData.redraw([`SEQUENCE ${Math.min(this.stage, 3)} / 3`], { color: '#' + new THREE.Color(this.stageColors[Math.min(this.stage, 3)]).getHexString() });
  }
  updateObjective() {
    if (this.stage < 3) this.objective(`Find the real door (${this.stage} / 3). The hallway lies — look for the sign.`);
    else if (this.scalePlate && this.scalePlate.pressed) this.objective('The exit is open. Leave the Scale Room.');
    else this.objective('Weigh down the heavy plate. Objects here are as large as they look.');
  }
  enterDoor(i) {
    if (this.stage >= 3) return;
    const g = this.game;
    const correct = i === this.answers[this.stage];
    for (const d of this.doors) d.snap(false);
    if (correct) {
      this.stage++;
      g.audio.teleport();
      g.flash(0xb47cff, 0.5);
      if (this.stage >= 3) {
        g.audio.chime();
        g.ui.toast('THE HALLWAY LETS YOU GO', 'good');
        this.buildGlyphs();
        this.applyStageColor();
        g.teleportPlayer(V3(38, 0, -1.3), V3(0, 0, -1));
        this.setCheckpoint(1);
      } else {
        g.ui.toast(`SEQUENCE ${this.stage} / 3 — THE HALLWAY SHIFTS`, 'good');
        this.buildGlyphs();
        this.applyStageColor();
        g.teleportPlayer(V3(0, 0, 2), V3(0, 0, -1));
      }
    } else {
      this.stage = 0;
      g.audio.glitch();
      g.flash(0xff3355, 0.6);
      g.ui.toast('WRONG DOOR — THE HALLWAY RESETS', 'warn');
      this.buildGlyphs();
      this.applyStageColor();
      g.teleportPlayer(V3(0, 0, 2), V3(0, 0, -1));
    }
    this.updateObjective();
  }
  buildScaleRoom() {
    const M = this.M;
    const X0 = 30, X1 = 46, Z0 = -16, Z1 = 0, H = 8;
    this.box(X0 - 0.5, -0.5, Z0 - 0.5, X1 + 0.5, 0, Z1 + 0.5, M.whiteFloor);
    this.box(X0 - 0.5, H, Z0 - 0.5, X1 + 0.5, H + 0.5, Z1 + 0.5, M.white);
    this.box(X0 - 0.5, 0, Z0, X0, H, Z1, M.white);
    this.box(X1, 0, Z0, X1 + 0.5, H, Z1, M.white);
    this.box(X0 - 0.5, 0, Z1, X1 + 0.5, H, Z1 + 0.5, M.white);
    this.wall('z', Z0 - 0.5, Z0, X0 - 0.5, X1 + 0.5, 0, H, M.white, [{ a0: 36.75, a1: 39.25, b0: 0, b1: 3 }]);
    // The door you "arrived" through — sealed.
    this.box(37, 0, -0.15, 39, 2.8, 0, M.metal, { solid: false });
    this.strip(37, 2.8, -0.16, 39, 2.86, -0.1, 0xb47cff, 2.5);
    // Columns that shrink toward the back: a false-perspective size illusion.
    const cols = [[-1.5, 7.6, 0.9], [-4, 6.6, 0.8], [-6.3, 5.7, 0.7], [-8.3, 4.9, 0.6], [-10, 4.2, 0.5], [-11.5, 3.6, 0.42], [-12.8, 3.1, 0.36], [-14, 2.7, 0.3]];
    for (const [z, h, w] of cols) {
      for (const x of [X0 + 0.6, X1 - 0.6]) {
        this.box(x - w / 2, 0, z - w / 2, x + w / 2, h, z + w / 2, M.white);
        this.strip(x - w / 2 - 0.01, h - 0.08, z - w / 2 - 0.01, x + w / 2 + 0.01, h, z + w / 2 + 0.01, 0xb47cff, 2);
      }
    }
    // Pedestal with the perception block
    this.box(34.55, 0, -4.45, 35.45, 1.0, -3.55, M.metal);
    this.rim(34.53, 1.0, -4.47, 35.47, -3.53, 0xb47cff, 2.5);
    this.block = new PhysObject(this, { kind: 'perception', pos: V3(35, 1.0 + 0.3 + 0.01, -4), size: 0.6 });
    // Heavy plate and exit
    this.scalePlate = new PressurePlate(this, {
      pos: V3(38, 0, -10), size: 4.4, minSize: 1.9, color: 0xb47cff,
      label: ['2.0 m', 'MINIMUM'],
      onChange: (on) => {
        if (on) { this.scaleExit.open(); this.game.audio.chime(); this.game.ui.toast('MASS ACCEPTED', 'good'); }
        else this.scaleExit.close();
        this.updateObjective();
      },
    });
    this.scaleExit = new Door(this, { min: V3(36.75, 0, -16.4), max: V3(39.25, 3, -16.1), slide: V3(0, 3.1, 0), mat: M.metal });
    this.box(36, -0.5, -21.5, 40, 0, -16, M.whiteFloor);
    this.box(36, 3.2, -21.5, 40, 3.7, -16.5, M.white);
    this.box(35.5, 0, -21.5, 36.4, 3.2, -16.5, M.white);
    this.box(39.6, 0, -21.5, 40.5, 3.2, -16.5, M.white);
    this.box(36, 0, -22, 40, 3.2, -21.5, M.white);
    this.exitMarker(V3(38, 1.8, -21.48), V3(0, 0, 1));
    this.exitZone(V3(36.4, 0, -21), V3(39.6, 3.2, -18));
    this.sign(['PERCEPTION IS MASS', 'an object is exactly as large as it appears'], V3(38, 5.2, -15.98), V3(0, 0, 1), 6, 1.5, { size: 120, color: '#d6b0ff' });
    this.sign(['SCALE ROOM'], V3(30.01, 3.0, -4), V3(1, 0, 0), 2.4, 0.6, { size: 130, color: '#d6b0ff' });
    this.spot(V3(38, 7.8, -6), V3(38, 0, -10), { intensity: 140, angle: 0.75, penumbra: 0.6 });
    for (const z of [-3, -8, -13]) this.lamp(38, 7.97, z, 3, 0.5, { intensity: 3 });
    this.point(38, 6, -4, 0xf0f4ff, 18, 18);
    this.point(38, 6, -12, 0xe6dcff, 15, 18);
    new ParticleField(this, { count: 160, min: V3(X0, 0.2, Z0), max: V3(X1, H - 0.2, Z1), color: 0xe0ccff, size: 0.035, intensity: 1.2, opacity: 0.5 });
  }
  update(dt) {
    this.voidMat.uniforms.uTime.value += dt;
    const pl = this.game.player;
    // Seamless loop: past the second segment, quietly move back by one segment.
    if (Math.abs(pl.pos.x) < 2.2 && pl.pos.z < -2 * this.L) {
      pl.pos.z += this.L;
      pl.syncSolid();
      pl.updateCamera();
      this.loops++;
      const txt = `LOOP ${String(this.loops).padStart(2, '0')}`;
      this.plaqueTex.userData.redraw([txt, this.loops > 3 ? 'it does not end' : 'corridor 7-B'], { color: '#ff8b5c' });
      if (this.loops === 2) this.game.ui.toast('…HAVEN\'T YOU BEEN HERE BEFORE?');
    }
    if (this.stage >= 3) this.updateObjective();
  }
}

/* =====================================================================
   LEVEL 3 — THE GRAVITY CHAMBER
   Gravity panels make any surface the floor. The core is high on the east
   wall; the ceiling panel can only be seen from the west wall above the
   great slab; the exit hangs upside-down beside the ceiling.
   ===================================================================== */
class Level3 extends Level {
  static meta = { name: 'THE GRAVITY CHAMBER', ambient: 'gravity' };
  build() {
    const M = this.M;
    const S = 9, H = 18, T = 0.6, gm = M.gridDark;
    this.showGravity = true;
    this.setAtmosphere({ bg: 0x05070c, density: 0.012, env: 0.45, hemi: [0x9fb8d8, 0x1a1c22, 0.5] });
    this.spawn = { pos: V3(0, 0, 6.5), up: Y_UP, look: V3(0, 0, -1) };
    this.bounds = { min: V3(-30, -30, -30), max: V3(30, 40, 30) };
    this.hints = [
      `Amber panels redirect gravity toward the surface they are mounted on. Aim at one and ${ctl('press E', 'tap USE')} — they work from a distance.`,
      'The energy core floats high on the east wall. Make the east wall your floor, then walk to it.',
      'The ceiling panel is hidden above the great slab. Only the west wall, above the slab, has a view of it.',
      'The exit hangs upside-down beside the ceiling. Walk on the ceiling and insert the core into the socket next to it.',
      `If the core falls somewhere unreachable it is recalled to its cradle. ${ctl('Press R', 'Tap ↺')} to reset the room at any time.`,
    ];
    // ---- Chamber shell ----
    this.box(-S - T, -T, -S - T, S + T, 0, S + T, gm);
    this.box(-S - T, H, -S - T, S + T, H + T, S + T, gm);
    this.box(-S - T, 0, -S - T, -S, H, S + T, gm);
    this.box(S, 0, -S - T, S + T, H, S + T, gm);
    this.box(-S, 0, S, S, H, S + T, gm);
    this.wall('z', -S - T, -S, -S, S, 0, H, gm, [{ a0: -1.25, a1: 1.25, b0: 15, b1: 18 }]);
    // Edge lights along every corner of the cube room.
    const e = 0.06;
    for (const [x, z] of [[-S, -S], [S, -S], [-S, S], [S, S]]) this.strip(x - e, 0, z - e, x + e, H, z + e, 0x4fd8ff, 2.2);
    for (const y of [0, H]) {
      this.strip(-S, y - e, -S - e, S, y + e, -S + e, 0x4fd8ff, 2.2);
      this.strip(-S, y - e, S - e, S, y + e, S + e, 0x4fd8ff, 2.2);
      this.strip(-S - e, y - e, -S, -S + e, y + e, S, 0x4fd8ff, 2.2);
      this.strip(S - e, y - e, -S, S + e, y + e, S, 0x4fd8ff, 2.2);
    }
    // ---- The great slab ----
    this.box(-6, 11.5, -S, S, 12.5, S, M.concreteDark);
    this.strip(-6.03, 11.95, -S, -5.98, 12.05, S, 0xffc457, 2.4);
    this.strip(-6.03, 11.47, -S, -5.98, 11.53, S, 0xffc457, 1.6);
    this.strip(-6.03, 12.47, -S, -5.98, 12.53, S, 0xffc457, 1.6);

    // ---- Upside-down exit corridor beside the ceiling ----
    this.box(-2, H, -14.5, 2, H + T, -S - T, gm);
    this.box(-2, 14.4, -14.5, 2, 15, -S - T, gm);
    this.box(-2, 15, -14.5, -1.5, H, -S - T, gm);
    this.box(1.5, 15, -14.5, 2, H, -S - T, gm);
    this.box(-2, 14.4, -15, 2, H + T, -14.5, gm);
    this.exitDoor = new Door(this, { min: V3(-1.25, 15, -9.5), max: V3(1.25, 18, -9.15), slide: V3(0, -3.1, 0), mat: M.metal });
    this.exitMarker(V3(0, 16.2, -14.48), V3(0, 0, 1), V3(0, -1, 0));
    this.exitZone(V3(-1.5, 15, -14), V3(1.5, 18, -11.6));
    this.sign(['EXIT', 'this way up'], V3(0, 14.2, -8.98), V3(0, 0, 1), 2.6, 0.9, { upHint: V3(0, -1, 0), color: '#5dffb0', size: 140 });
    this.socket = new Socket(this, {
      pos: V3(3.2, 16.4, -S), normal: V3(0, 0, 1),
      onInsert: () => { this.exitDoor.open(); this.game.audio.chime(); this.game.ui.toast('EXIT POWERED', 'good'); },
    });

    // ---- Gravity panels ----
    new GravityPanel(this, { pos: V3(0, 0, 3), normal: V3(0, 1, 0) });
    new GravityPanel(this, { pos: V3(-7.5, 0, -5), normal: V3(0, 1, 0) });
    new GravityPanel(this, { pos: V3(S, 2.6, 5), normal: V3(-1, 0, 0) });
    new GravityPanel(this, { pos: V3(-S, 3.5, -4), normal: V3(1, 0, 0) });
    new GravityPanel(this, { pos: V3(-S, 15, 5), normal: V3(1, 0, 0) });
    new GravityPanel(this, { pos: V3(4.5, H, -2), normal: V3(0, -1, 0) });

    // ---- Energy core in its cradle on the east wall ----
    const cradle = new THREE.Group();
    cradle.position.set(S, 7, -2);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.06, 8, 32), neon(0xffc457, 2.6));
    ring.rotation.y = Math.PI / 2;
    ring.position.x = -0.55;
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.1, 0.1), M.trim);
    arm.position.x = -0.25;
    cradle.add(ring, arm);
    this.scene.add(cradle);
    this.spinner(ring, V3(1, 0, 0), 1.2);
    this.corePos = V3(S - 0.55, 7, -2);
    this.core = new PhysObject(this, { kind: 'core', pos: this.corePos, size: 0.5, cradle: true });
    this.point(S - 1.2, 7, -2, 0xffc457, 10, 6);

    // ---- Atmosphere ----
    this.sign(['GRAVITY IS LOCAL'], V3(0, 6, S - 0.02), V3(0, 0, -1), 6, 1.2, { size: 140, color: '#ffc457' });
    this.sign(['SURFACE = FLOOR', 'any surface, if you insist'], V3(S - 0.02, 4.8, 0), V3(-1, 0, 0), 3.6, 1.0, { size: 110 });
    this.sculpture(V3(2, 5.5, -1), 1.6, 0x4fd8ff);
    this.spot(V3(8, 17.5, 8), V3(-2, 0, -2), { intensity: 260, angle: 0.9, penumbra: 0.8, distance: 50 });
    this.point(-5, 6, 5, 0xbfe0ff, 30, 20);
    this.point(5, 6, -5, 0xbfe0ff, 30, 20);
    this.point(-6, 15.5, 0, 0xd8c8ff, 30, 20);
    this.point(4, 15.5, -5, 0xd8c8ff, 25, 20);
    new ParticleField(this, { count: 300, min: V3(-S, 0.2, -S), max: V3(S, H - 0.2, S), color: 0xa8d8ff, size: 0.04, intensity: 1.3, opacity: 0.55, drift: V3(0, 0, 0), jitter: 0.12 });
  }
  update() {
    const core = this.core;
    // Recall the core if it lands on top of the slab (unreachable).
    if (!core.held && !core.locked && !core.cradle && core.grounded && core.pos.y > 12.4 && core.pos.y < 13.4 && core.pos.x > -6) {
      core.cradle = true;
      core.solid.enabled = false;
      core.pos.copy(this.corePos);
      core.vel.set(0, 0, 0);
      this.game.audio.teleport();
      this.game.ui.toast('CORE RECALLED TO ITS CRADLE');
    }
    if (this.socket.filled) this.objective('The exit is open. Walk through it — on the ceiling.');
    else if (core.cradle) this.objective('Retrieve the energy core floating high on the east wall.');
    else this.objective('Bring the core to the socket beside the upside-down exit near the ceiling.');
  }
}

/* =====================================================================
   LEVEL 4 — THE PORTAL LAB
   Two portal pairs. Both pressure plates need cubes; one plate is sealed
   behind glass and one cube waits on an unreachable balcony.
   ===================================================================== */
class Level4 extends Level {
  static meta = { name: 'THE PORTAL LAB', ambient: 'portal' };
  build() {
    const M = this.M;
    this.setAtmosphere({ bg: 0x0a0d13, density: 0.014, env: 0.45, hemi: [0xe0ebff, 0x2a2e36, 0.35] });
    this.spawn = { pos: V3(0, 0, 6), up: Y_UP, look: V3(0, 0, -1) };
    this.bounds = { min: V3(-40, -30, -40), max: V3(40, 40, 40) };
    this.hints = [
      'Portals join distant walls. Walk straight into the blue portal on the west wall and see where you come out.',
      'The plates only respond to cubes. The sealed cell behind the glass can only be reached through the blue portal.',
      'A second cube waits on the balcony. The orange portal in the south wall leads up there.',
      `Hold a cube (${ctl('E', 'USE')}) while walking through a portal — it travels with you. Put one cube on each plate.`,
      'A keycard lies on the table inside the containment cell. Carry it back through the portal and insert it into the reader beside the exit.',
    ];
    // ---- Lab shell ----
    this.box(-10.5, -0.5, -8.5, 10.5, 0, 8.5, M.whiteFloor);
    this.box(-10.5, 7, -8.5, 10.5, 7.5, 8.5, M.white);
    this.wall('z', -8.5, -8, -10.5, 10.5, 0, 7, M.white, [{ a0: -1.25, a1: 1.25, b0: 0, b1: 3 }]);
    this.wall('z', 8, 8.5, -10.5, 10.5, 0, 7, M.white, [{ a0: 5.1, a1: 6.9, b0: 0, b1: 2.6 }]);
    this.wall('x', -10.5, -10, -8, 8, 0, 7, M.white, [{ a0: 1.1, a1: 2.9, b0: 0, b1: 2.6 }, { a0: 5.3, a1: 7.1, b0: 4, b1: 6.6 }]);
    this.wall('x', 10, 10.5, -8, 8, 0, 7, M.white, [{ a0: -3, a1: 3, b0: 0, b1: 5 }]);
    this.box(10.05, 0, -3, 10.45, 5, 3, M.glass, { shadow: false });
    this.strip(10.0, 5.0, -3, 10.5, 5.06, 3, 0x4fd8ff, 2);
    // ---- Containment cell ----
    this.box(10.5, -0.5, -3.5, 16.5, 0, 3.5, M.darkFloor);
    this.box(10.5, 5, -3.5, 16.5, 5.5, 3.5, M.concrete);
    this.box(10.5, 0, -3.5, 16, 5, -3, M.concrete);
    this.box(10.5, 0, 3, 16, 5, 3.5, M.concrete);
    this.wall('x', 16, 16.5, -3.5, 3.5, 0, 5, M.concrete, [{ a0: -0.9, a1: 0.9, b0: 0, b1: 2.6 }]);
    this.lamp(13.2, 4.97, 0, 2, 0.4, { intensity: 3, light: 14, distance: 9 });
    this.sign(['CONTAINMENT', 'no physical entry'], V3(13.2, 3.8, -2.98), V3(0, 0, 1), 2.6, 0.9, { size: 110, color: '#ff8b5c' });
    // ---- Balcony ----
    this.box(-10, 3.6, 3.5, -4, 4, 8, M.metal);
    this.box(-4.05, 4, 3.5, -3.95, 5.1, 8, M.glass, { shadow: false });
    this.box(-10, 4, 3.45, -4, 5.1, 3.55, M.glass, { shadow: false });
    this.strip(-4.07, 5.1, 3.45, -3.93, 5.15, 8, 0xff9a3c, 2.2);
    this.strip(-10, 5.1, 3.43, -4, 5.15, 3.57, 0xff9a3c, 2.2);
    this.box(-4.35, 0, 3.55, -4.0, 3.6, 3.9, M.trim);
    this.box(-4.35, 0, 7.6, -4.0, 3.6, 7.95, M.trim);
    this.lamp(-7, 6.97, 5.8, 2, 0.4, { intensity: 3, light: 10, distance: 8, color: 0xffe0c0 });
    // ---- Portals ----
    const A1 = new Portal(this, { pos: V3(-9.99, 1.3, 2), normal: V3(1, 0, 0), color: 0x4fd8ff });
    const B1 = new Portal(this, { pos: V3(15.99, 1.3, 0), normal: V3(-1, 0, 0), color: 0x4fd8ff });
    const A2 = new Portal(this, { pos: V3(6, 1.3, 7.99), normal: V3(0, 0, -1), color: 0xff9a3c });
    const B2 = new Portal(this, { pos: V3(-9.99, 5.3, 6.2), normal: V3(1, 0, 0), color: 0xff9a3c });
    Portal.pair(A1, B1);
    Portal.pair(A2, B2);
    // ---- Plates, cubes, exit ----
    const onPlate = () => this.refreshDoor();
    this.p1 = new PressurePlate(this, { pos: V3(-5, 0, -4), size: 1.7, onChange: onPlate, label: ['CUBE', 'only'] });
    this.p2 = new PressurePlate(this, { pos: V3(13, 0, 0), size: 1.7, onChange: onPlate, label: ['CUBE', 'only'] });
    new PhysObject(this, { kind: 'cube', pos: V3(4, 0.36, 1.5), size: 0.7 });
    new PhysObject(this, { kind: 'cube', pos: V3(-7.2, 4.36, 6), size: 0.7 });
    // Keycard on a table inside the sealed cell; its reader is beside the exit.
    this.box(14.2, 0, -2.85, 15.6, 0.8, -2.0, M.metal);
    this.strip(14.2, 0.8, -2.85, 15.6, 0.83, -2.0, 0x4fd8ff, 1.2);
    new PhysObject(this, { kind: 'key', pos: V3(14.9, 0.8 + 0.16, -2.42), size: 0.3 });
    this.reader = new Socket(this, { pos: V3(2.4, 1.3, -8), normal: V3(0, 0, 1), accepts: 'key', onInsert: () => { this.game.ui.toast('KEYCARD ACCEPTED', 'good'); this.refreshDoor(); } });
    this.exitDoor = new Door(this, { min: V3(-1.25, 0, -8.4), max: V3(1.25, 3, -8.1), slide: V3(0, 3.1, 0), mat: M.metal });
    this.lightA = new THREE.MeshBasicMaterial({ color: 0xff5470 });
    this.lightB = new THREE.MeshBasicMaterial({ color: 0xff5470 });
    this.own(this.lightA); this.own(this.lightB);
    this.lightK = this.own(new THREE.MeshBasicMaterial({ color: 0xff5470 }));
    for (const [mat, x] of [[this.lightA, -0.7], [this.lightK, 0], [this.lightB, 0.7]]) {
      const m = new THREE.Mesh(new THREE.CircleGeometry(0.22, 24), mat);
      m.position.set(x, 3.5, -7.98);
      this.scene.add(m);
    }
    this.box(-2.1, -0.5, -13.5, 2.1, 0, -8.5, M.whiteFloor);
    this.box(-2.1, 3.2, -13.5, 2.1, 3.7, -8.5, M.white);
    this.box(-2.1, 0, -13.5, -1.6, 3.2, -8.5, M.white);
    this.box(1.6, 0, -13.5, 2.1, 3.2, -8.5, M.white);
    this.box(-2.1, 0, -14, 2.1, 3.2, -13.5, M.white);
    this.exitMarker(V3(0, 1.8, -13.48), V3(0, 0, 1));
    this.exitZone(V3(-1.6, 0, -13), V3(1.6, 3.2, -10.5));
    // ---- Lab dressing ----
    this.sign(['PORTAL LAB', 'momentum is conserved · orientation is negotiable'], V3(0, 5.0, -7.98), V3(0, 0, 1), 6, 1.4, { size: 120 });
    this.sign(['▲ BALCONY ACCESS'], V3(6, 3.3, 7.98), V3(0, 0, -1), 2.2, 0.55, { size: 120, color: '#ff9a3c' });
    for (const [x0, z0, x1, z1] of [[5, -7.6, 9.4, -6.4], [-9.6, -7.6, -7.4, -5.2]]) {
      this.box(x0, 0, z0, x1, 0.9, z1, M.metal);
      this.strip(x0, 0.9, z0, x1, 0.93, z1, 0x4fd8ff, 1.2);
    }
    const holo = this.sculpture(V3(7.2, 1.9, -7.0), 0.45, 0x4fd8ff);
    holo.scale.setScalar(1);
    this.spot(V3(0, 6.8, 2), V3(0, 0, -1), { intensity: 150, angle: 1.05, penumbra: 0.7 });
    for (const [x, z] of [[-5, -4], [5, -4], [-5, 2], [5, 2]]) this.lamp(x, 6.97, z, 3, 0.5, { intensity: 2.4 });
    this.point(0, 5, 0, 0xeef4ff, 22, 20);
    this.point(0, 5, -6, 0xeef4ff, 14, 14);
    new ParticleField(this, { count: 200, min: V3(-10, 0.2, -8), max: V3(16, 6.8, 8), color: 0xcfe6ff, size: 0.035, intensity: 1.2, opacity: 0.5 });
    this.refreshDoor();
  }
  refreshDoor() {
    const key = this.reader.filled;
    const on = this.p1.pressed && this.p2.pressed && key;
    this.lightA.color.set(this.p1.pressed ? 0x5dffb0 : 0xff5470).multiplyScalar(2.5);
    this.lightB.color.set(this.p2.pressed ? 0x5dffb0 : 0xff5470).multiplyScalar(2.5);
    this.lightK.color.set(key ? 0x5dffb0 : 0xff5470).multiplyScalar(2.5);
    if (on && !this.exitDoor.target) { this.exitDoor.open(); this.game.audio.chime(); this.game.ui.toast('EXIT UNLOCKED', 'good'); }
    else if (!on) this.exitDoor.close(this.exitDoor.target === 0);
  }
  update() {
    const n = (this.p1.pressed ? 1 : 0) + (this.p2.pressed ? 1 : 0);
    const k = this.reader.filled ? 1 : 0;
    if (n === 2 && k) this.objective('The exit is open. Walk through the north door.');
    else this.objective(`Cubes on plates ${n} / 2 · keycard ${k} / 1. Both the second plate and the keycard are sealed in the containment cell.`);
  }
}

/* =====================================================================
   LEVEL 5 — THE BROKEN DIMENSION
   1. A bridge that only exists from the right point of view.
   2. A conduit that must be rotated until its walkway is beneath you.
   3. A moving platform and a monolith whose face becomes the floor.
   4. A portal at the top of the monolith into the exit chamber.
   ===================================================================== */
class Level5 extends Level {
  static meta = { name: 'THE BROKEN DIMENSION', ambient: 'void' };
  build() {
    const M = this.M;
    const cp = this.cp;
    this.showGravity = true;
    this.setAtmosphere({ bg: 0x07040e, density: 0.0105, env: 0.45, hemi: [0x9a8cd8, 0x120a1c, 0.6] });
    this.bounds = { min: V3(-60, -45, -130), max: V3(60, 70, 30) };
    this.hints = [
      `Stand on the glowing eye at the edge of the first platform and look down the gap. When the fragments line up, ${ctl('press E', 'tap USE')}.`,
      'The switch rotates the conduit a quarter turn each time. Turn it until the solid walkway is at the bottom.',
      `The monolith panel is too far to reach from the platform. Ride the moving platform closer, then aim at the panel and ${ctl('press E', 'tap USE')}.`,
      'Walk up the face of the monolith. The portal at the top leads out.',
      `Falling into the void returns you to the last checkpoint. ${ctl('R', '↺')} also resets to the checkpoint.`,
    ];
    this.finale = null;
    const sp = [
      { pos: V3(0, 0, 3.5), up: Y_UP, look: V3(0, 0, -1) },
      { pos: V3(0, 0, -21.5), up: Y_UP, look: V3(0, 0, -1) },
      { pos: V3(0, 0, -50), up: Y_UP, look: V3(0, 0, -1) },
      { pos: V3(0, 3, -80), up: V3(0, 0, 1), look: V3(0, 1, 0) },
    ];
    this.spawn = sp[Math.min(cp, 3)];

    // ---- Platform 1 and the forced-perspective bridge ----
    this.island(-4, -3, 4, 5);
    this.symbolDecal('eye', '#d6b0ff', V3(0, 0.015, 1), Y_UP, 0.95, { upHint: V3(0, 0, -1), brightness: 2.6 });
    const segs = [];
    for (let i = 0; i < 8; i++) {
      const z0 = -3 - 2 * i;
      segs.push({ min: V3(-1.5, -0.4, z0 - 2), max: V3(1.5, 0, z0) });
    }
    this.bridge = new PerspectiveBridge(this, {
      viewpoint: V3(0, 1.5, 1), target: V3(0, -0.2, -11), segments: segs, mat: M.voidStone, locked: cp >= 1,
      onLock: () => this.game.ui.toast('PERSPECTIVE LOCKED', 'good'),
    });
    this.sign(['SEE IT WHOLE'], V3(-3.2, 1.6, -2.9), V3(0, 0, 1), 1.8, 0.5, { size: 120, color: '#d6b0ff' });

    // ---- Platform 2 with the conduit switch ----
    this.island(-4, -27, 4, -19);
    new Trigger(this, { min: V3(-4, 0, -27), max: V3(4, 4, -19.3), onEnter: () => this.setCheckpoint(1) });
    this.rotSwitch = new Switch(this, {
      pos: V3(3, 0, -21), label: 'Rotate the conduit', color: 0xb47cff,
      onPress: () => {
        if (!this.tube.rotate()) this.game.audio.deny();
      },
    });

    // ---- Rotating conduit (room rotation) ----
    this.tube = new RotatingGroup(this, {
      pivot: V3(0, 2.25, 0), axis: 'z', duration: 1.8, initialSteps: cp >= 2 ? 0 : 2,
      onRotated: (s) => {
        if (s === 0) { this.game.audio.chime(); this.game.ui.toast('CONDUIT ALIGNED', 'good'); }
      },
    });
    const t = this.tube;
    t.addBox(-2.4, -2.55, -47, 2.4, -2.25, -27, M.gridViolet);
    for (const x of [-2.32, 2.32]) t.addBox(x - 0.06, -2.25, -47, x + 0.06, -2.2, -27, neon(0xb47cff, 2.6), { solid: false, shadow: false });
    t.addBox(-2.25, 2.18, -47, 2.25, 2.22, -27, this.own(new THREE.MeshStandardMaterial({ color: 0x1a0006, emissive: 0xff3355, emissiveMap: this.game.tex.grid('#ff3355', 'gridRed'), emissiveIntensity: 1.4, transparent: true, opacity: 0.75, side: THREE.DoubleSide })), { solid: false, shadow: false });
    for (const z of [-27.15, -32, -37, -42, -46.85]) {
      t.addBox(-2.55, -2.55, z - 0.15, 2.55, -2.25, z + 0.15, M.metal);
      t.addBox(-2.55, 2.25, z - 0.15, 2.55, 2.55, z + 0.15, M.metal);
      t.addBox(-2.55, -2.25, z - 0.15, -2.25, 2.25, z + 0.15, M.metal);
      t.addBox(2.25, -2.25, z - 0.15, 2.55, 2.25, z + 0.15, M.metal);
    }
    for (const [x, y] of [[-2.4, -2.4], [2.4, -2.4], [-2.4, 2.4], [2.4, 2.4]]) t.addBox(x - 0.15, y - 0.15, -47, x + 0.15, y + 0.15, -27, M.trim);
    t.addBlocker(V3(-2.7, -0.6, -27.6), V3(2.7, 5, -27.0));
    t.addBlocker(V3(-2.7, -0.6, -47.0), V3(2.7, 5, -46.4));
    t.refreshSolids();
    this.sign(['CONDUIT', 'walkway down · then walk'], V3(-3.4, 1.4, -26.98), V3(0, 0, 1), 1.6, 0.6, { size: 110, color: '#d6b0ff' });

    // ---- Platform 3, moving platform, monolith ----
    this.island(-4, -55, 4, -47);
    new Trigger(this, { min: V3(-4, 0, -55), max: V3(4, 4, -47.4), onEnter: () => this.setCheckpoint(2) });
    this.platform = new MovingPlatform(this, { min: V3(-2, -0.5, -59), max: V3(2, 0, -55), offset: V3(0, 0, -19), travel: 6, wait: 2.5, mat: M.metal });
    this.box(-5, -14, -81, 5, 25, -80, M.gridDark);
    this.box(-5.4, -14, -80, -5, 25, -79.1, M.trim);
    this.box(5, -14, -80, 5.4, 25, -79.1, M.trim);
    this.strip(-5.02, -14, -79.12, -4.98, 25, -79.08, 0xb47cff, 2.4);
    this.strip(4.98, -14, -79.12, 5.02, 25, -79.08, 0xb47cff, 2.4);
    this.panel = new GravityPanel(this, { pos: V3(0, 1.5, -80), normal: V3(0, 0, 1), range: 20 });
    for (let y = 6; y <= 20; y += 4.5) this.symbolDecal('arrow', '#ffc457', V3(0, y, -79.98), V3(0, 0, 1), 1.4, { upHint: V3(0, 1, 0), brightness: 1.8 });
    this.sign(['THE MONOLITH', 'its face is a floor'], V3(0, -3.5, -79.98), V3(0, 0, 1), 4, 1.2, { size: 120, color: '#ffc457' });
    new Trigger(this, { min: V3(-5, -14, -80), max: V3(5, 25, -78.9), once: false, onEnter: () => { if (this.game.player.up.z > 0.5) this.setCheckpoint(3); } });

    // ---- Final portal at the top of the monolith ----
    this.box(-1.4, 23.75, -80, -1.05, 24.25, -77.2, M.trim);
    this.box(1.05, 23.75, -80, 1.4, 24.25, -77.2, M.trim);
    this.box(-1.4, 23.75, -77.4, 1.4, 24.25, -77.05, M.trim);
    const FP = new Portal(this, { pos: V3(0, 24, -78.7), normal: V3(0, -1, 0), up: V3(0, 0, 1), w: 2, h: 2.6, color: 0xb8c8ff });
    this.buildFinalChamber(FP);

    // ---- The void: debris, stars, distant impossible structures ----
    const rnd = mulberry32(55);
    for (let i = 0; i < 26; i++) {
      const r = 45 + rnd() * 50, a = rnd() * TAU, y = -30 + rnd() * 70;
      const s = 1 + rnd() * 5;
      const m = new THREE.Mesh(new THREE.BoxGeometry(s, s * (0.3 + rnd() * 2), s), M.voidStone);
      m.position.set(Math.cos(a) * r, y, -40 + Math.sin(a) * r);
      m.rotation.set(rnd() * 3, rnd() * 3, rnd() * 3);
      const edge = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry), new THREE.LineBasicMaterial({ color: new THREE.Color(rnd() < 0.5 ? 0xb47cff : 0x4fd8ff).multiplyScalar(2) }));
      this.own(edge.material);
      m.add(edge);
      this.scene.add(m);
      this.spinner(m, V3(rnd(), rnd(), rnd()), 0.05 + rnd() * 0.15);
    }
    // A distant upside-down staircase and arch: architecture that ignores gravity.
    for (let i = 0; i < 10; i++) this.box(18 + i * 1.2, 30 - i * 0.6, -40 - i * 0.3, 19.2 + i * 1.2, 30.6 - i * 0.6, -36 - i * 0.3, M.voidStone, { solid: false });
    for (let i = 0; i < 10; i++) this.box(-30 + i * 0.6, -12 + i * 1.2, -70, -29.4 + i * 0.6, -10.8 + i * 1.2, -66, M.voidStone, { solid: false });
    new ParticleField(this, { count: 700, min: V3(-80, -40, -130), max: V3(80, 60, 30), color: 0xd6c8ff, size: 0.22, intensity: 1.5, opacity: 0.8, drift: V3(0, 0.15, 0), jitter: 0.1 });
    this.point(0, 6, -10, 0xb47cff, 40, 30);
    this.point(0, 6, -37, 0xb47cff, 40, 30);
    this.point(0, 6, -62, 0x8fb8ff, 50, 40);
    this.point(0, 8, -74, 0xffc457, 40, 30);
    this.point(0, 21, -77, 0xc8d4ff, 10, 14);
    this.spot(V3(10, 25, -20), V3(0, 0, -30), { color: 0xd8ccff, intensity: 700, angle: 0.75, penumbra: 0.8, distance: 70 });
  }
  island(x0, z0, x1, z1) {
    const M = this.M;
    this.box(x0, -1, z0, x1, 0, z1, M.gridViolet);
    this.box(x0 + 0.6, -3.5, z0 + 0.6, x1 - 0.6, -1, z1 - 0.6, M.voidStone, { solid: false });
    this.strip(x0 - 0.03, -0.08, z0 - 0.03, x1 + 0.03, -0.02, z0 + 0.03, 0xb47cff, 2.4);
    this.strip(x0 - 0.03, -0.08, z1 - 0.03, x1 + 0.03, -0.02, z1 + 0.03, 0xb47cff, 2.4);
    this.strip(x0 - 0.03, -0.08, z0, x0 + 0.03, -0.02, z1, 0xb47cff, 2.4);
    this.strip(x1 - 0.03, -0.08, z0, x1 + 0.03, -0.02, z1, 0xb47cff, 2.4);
  }
  buildFinalChamber(FP) {
    const M = this.M;
    const X = 18, Z0 = 150, Z1 = 210, H = 28;
    this.box(-X - 0.5, -0.5, Z0 - 0.5, X + 0.5, 0, Z1 + 0.5, M.darkFloor);
    this.box(-X - 0.5, H, Z0 - 0.5, X + 0.5, H + 0.5, Z1 + 0.5, M.concreteDark);
    this.box(-X - 0.5, 0, Z0 - 0.5, -X, H, Z1 + 0.5, M.concreteDark);
    this.box(X, 0, Z0 - 0.5, X + 0.5, H, Z1 + 0.5, M.concreteDark);
    this.box(-X, 0, Z0 - 0.5, X, H, Z0, M.concreteDark);
    this.wall('z', Z1, Z1 + 0.5, -X, X, 0, H, M.concreteDark, [{ a0: -1, a1: 1, b0: 0, b1: 2.6 }]);
    const FB = new Portal(this, { pos: V3(0, 1.3, Z1 - 0.01), normal: V3(0, 0, -1), up: Y_UP, w: 2, h: 2.6, color: 0xb8c8ff });
    Portal.pair(FP, FB);
    // Walkway and dais
    this.strip(-2.2, 0.01, 168, -2.1, 0.04, 208, 0x4fd8ff, 2.6);
    this.strip(2.1, 0.01, 168, 2.2, 0.04, 208, 0x4fd8ff, 2.6);
    this.box(-7, 0, 158, 7, 0.3, 171, M.metal);
    this.box(-6, 0.3, 158, 6, 0.6, 169, M.metal);
    this.box(-5, 0.6, 158, 5, 0.9, 167, M.metal);
    this.strip(-7, 0.3, 170.98, 7, 0.33, 171.02, 0xffffff, 2);
    this.strip(-6, 0.6, 168.98, 6, 0.63, 169.02, 0xffffff, 2);
    this.strip(-5, 0.9, 166.98, 5, 0.93, 167.02, 0xffffff, 2);
    // The exit ring
    const ring = new THREE.Mesh(new THREE.TorusGeometry(6, 0.45, 16, 96), neon(0xd6e8ff, 3.5));
    ring.position.set(0, 7.5, 157);
    this.scene.add(ring);
    const ring2 = new THREE.Mesh(new THREE.TorusGeometry(6.8, 0.12, 8, 96), neon(0xb47cff, 3));
    ring2.position.copy(ring.position);
    this.scene.add(ring2);
    this.spinner(ring2, V3(0, 0, 1), 0.3);
    this.discUniforms = { uTime: { value: 0 }, uPower: { value: 1 } };
    const discMat = new THREE.ShaderMaterial({
      uniforms: this.discUniforms, vertexShader: PORTAL_VERT, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      fragmentShader: /* glsl */`
        uniform float uTime; uniform float uPower; varying vec2 vUv;
        void main() {
          vec2 p = vUv - 0.5; float r = length(p) * 2.0; float a = atan(p.y, p.x);
          float sw = sin(a * 7.0 - uTime * 2.0 + r * 12.0) * 0.5 + 0.5;
          float core = smoothstep(1.0, 0.0, r);
          vec3 col = mix(vec3(0.55, 0.45, 1.0), vec3(0.8, 0.95, 1.0), sw) * core * (0.8 + sw * 0.6) * uPower;
          col += vec3(1.0) * smoothstep(0.35, 0.0, r) * uPower * 0.8;
          gl_FragColor = vec4(col, core);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.own(discMat);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(5.6, 64), discMat);
    disc.position.set(0, 7.5, 157.1);
    this.scene.add(disc);
    this.ringLight = this.point(0, 7.5, 161, 0xd6e8ff, 120, 45);
    // Pillars and floating monoliths
    for (let z = 168; z <= 204; z += 9) {
      for (const x of [-11, 11]) {
        this.box(x - 0.8, 0, z - 0.8, x + 0.8, H, z + 0.8, M.concreteDark);
        for (const y of [2, 9, 16, 23]) this.strip(x - 0.82, y, z - 0.82, x + 0.82, y + 0.12, z + 0.82, 0x4fd8ff, 2.2);
      }
    }
    for (let i = 0; i < 6; i++) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(1.4, 7, 0.5), M.voidStone);
      const a = (i / 6) * TAU;
      m.position.set(Math.cos(a) * 12, 17 + Math.sin(i) * 3, 185 + Math.sin(a) * 14);
      this.scene.add(m);
      this.spinner(m, V3(0.2, 1, 0.1), 0.2 + i * 0.03);
    }
    this.sign(['BEYOND', 'the last room is the one you leave'], V3(0, 15.5, 150.02), V3(0, 0, 1), 8, 2, { size: 130, color: '#d6e8ff' });
    this.point(0, 10, 200, 0xb47cff, 60, 40);
    this.point(0, 10, 182, 0x8fb8ff, 60, 40);
    this.finalParticles = new ParticleField(this, { count: 450, min: V3(-X, 0, Z0), max: V3(X, H, Z1), color: 0xe6f0ff, size: 0.09, intensity: 1.8, opacity: 0.8, drift: V3(0, 0.6, 0), jitter: 0.2 });
    new Trigger(this, { min: V3(-5, 0.5, 158), max: V3(5, 5, 166.6), onEnter: () => this.defer(() => this.game.startFinale()) });
  }
  isOutOfBounds(p) {
    if (p.z > 140 && p.z < 220 && Math.abs(p.x) < 20 && p.y > -5 && p.y < 30) return false;
    return super.isOutOfBounds(p);
  }
  contextPrompt() {
    if (this.bridge.pickable) return { text: 'Lock perspective', action: () => this.bridge.lock() };
    return null;
  }
  update(dt) {
    if (this.discUniforms) this.discUniforms.uTime.value += dt;
    const b = this.bridge;
    const pl = this.game.player;
    if (b.state === 'scattered') {
      b.glow = damp(b.glow, b.isAligned() ? 1 : 0, 6, dt);
      b.edgeMat.color.set(0xb47cff).multiplyScalar(1.6 + b.glow * 2.4);
    } else {
      b.edgeMat.color.set(0xb47cff).multiplyScalar(1.4);
    }
    if (pl.pos.z > 140) this.objective('Step into the light.');
    else if (pl.up.z > 0.5) this.objective('Climb the face of the monolith to the portal at its top.');
    else if (b.state !== 'locked') this.objective('The bridge is broken — unless you see it whole. Stand on the eye and look.');
    else if (pl.pos.z > -47.5 && this.tube.steps !== 0) this.objective('Rotate the conduit until its solid walkway is beneath it, then cross.');
    else if (pl.pos.z > -47.5) this.objective('Cross the conduit.');
    else this.objective('Ride the platform toward the monolith and turn its face into your floor.');
  }
  // Scripted escape sequence: the camera is drawn into the ring of light.
  updateFinale(dt) {
    const f = this.finale;
    f.t += dt;
    const cam = this.game.camera;
    const target = V3(0, 7.5, 157);
    const k = easeInOut(Math.min(1, f.t / 6.5));
    cam.position.lerpVectors(f.start, V3(0, 7.5, 159.5), k);
    const look = new THREE.Matrix4().lookAt(cam.position, target, Y_UP);
    const q = new THREE.Quaternion().setFromRotationMatrix(look);
    cam.quaternion.slerpQuaternions(f.startQ, q, Math.min(1, f.t / 2.2));
    cam.updateMatrixWorld();
    this.discUniforms.uPower.value = 1 + f.t * 0.9;
    this.ringLight.intensity = 120 + f.t * 120;
    this.finalParticles.speedMul = 1 + f.t * 2.5;
    this.game.ui.setWhite(clamp((f.t - 4.2) / 2.6, 0, 1));
    return f.t >= 7.2;
  }
}

/* ---------------------------------------------------------------------
   Main-menu backdrop: a Penrose triangle that is only "possible" from
   exactly one viewpoint. The camera drifts slightly, so the illusion
   breaks and heals while you browse the menu.
   --------------------------------------------------------------------- */
class MenuScene {
  constructor(game) {
    this.game = game;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x04050a);
    this.scene.fog = new THREE.FogExp2(0x04050a, 0.008);
    const L = 6, t = 1.15;
    const faceMat = (c) => new THREE.MeshBasicMaterial({ color: c });
    const mats = [faceMat(0xe9eef6), faceMat(0x1a1e28), faceMat(0x8796b4), faceMat(0x1a1e28), faceMat(0x3c4868), faceMat(0x1a1e28)];
    const group = new THREE.Group();
    const beam = (x0, y0, z0, x1, y1, z1) => {
      const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
      const m = new THREE.Mesh(g, mats);
      m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
      const e = new THREE.LineSegments(new THREE.EdgesGeometry(g), new THREE.LineBasicMaterial({ color: new THREE.Color(0x4fd8ff).multiplyScalar(1.6) }));
      m.add(e);
      group.add(m);
    };
    beam(-t / 2, -t / 2, -t / 2, L + t / 2, t / 2, t / 2);
    beam(L - t / 2, t / 2, -t / 2, L + t / 2, L + t / 2, t / 2);
    beam(L - t / 2, L - t / 2, t / 2, L + t / 2, L + t / 2, L + t / 2);
    this.scene.add(group);
    this.center = V3((2 * L) / 3, L / 3, 0);
    this.tri = group;
    // Orbiting rings and floating cubes for depth.
    this.rings = [];
    for (let i = 0; i < 3; i++) {
      const r = new THREE.Mesh(new THREE.TorusGeometry(9 + i * 2.5, 0.04, 6, 128), neon(i === 1 ? 0xb47cff : 0x4fd8ff, 1.8));
      r.rotation.set(Math.random() * 3, Math.random() * 3, 0);
      this.scene.add(r);
      this.rings.push(r);
    }
    this.cubes = [];
    const rnd = mulberry32(3);
    for (let i = 0; i < 24; i++) {
      const s = 0.2 + rnd() * 0.6;
      const c = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), mats);
      const a = rnd() * TAU, rr = 10 + rnd() * 18;
      c.position.set(Math.cos(a) * rr, (rnd() - 0.5) * 18, Math.sin(a) * rr - 10);
      c.userData.spin = V3(rnd(), rnd(), rnd()).multiplyScalar(0.6);
      this.scene.add(c);
      this.cubes.push(c);
    }
    const pos = new Float32Array(900 * 3);
    for (let i = 0; i < 900; i++) {
      const v = V3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize().multiplyScalar(40 + rnd() * 80);
      pos.set([v.x, v.y, v.z], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.stars = new THREE.Points(g, new THREE.PointsMaterial({ size: 0.5, map: game.tex.glowSprite(), color: new THREE.Color(0xc8d8ff).multiplyScalar(1.4), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.scene.add(this.stars);
    this.time = 0;
    this.viewDir = V3(1, 1, 1).normalize();
  }
  update(dt, camera) {
    this.time += dt;
    const t = this.time;
    // Mostly hold the "impossible" viewpoint, occasionally drift away and back.
    const drift = Math.pow(Math.max(0, Math.sin(t * 0.21)), 6) * 0.22;
    const yaw = Math.sin(t * 0.13) * 0.01 + drift;
    const pitch = Math.cos(t * 0.17) * 0.008;
    const d = this.viewDir.clone().applyAxisAngle(Y_UP, yaw);
    d.y += pitch;
    d.normalize();
    // The camera sits on the line through both "ends" of the triangle, so they
    // appear joined. A view offset moves the image right without moving the eye.
    camera.position.copy(d).multiplyScalar(80);
    camera.up.set(0, 1, 0);
    camera.lookAt(this.center);
    const w = window.innerWidth, h = window.innerHeight;
    camera.setViewOffset(w, h, w > 900 ? -w * 0.2 : 0, w > 900 ? 0 : -h * 0.12, w, h);
    camera.updateMatrixWorld();
    this.rings.forEach((r, i) => { r.rotation.x += dt * 0.05 * (i + 1); r.rotation.y += dt * 0.03; });
    for (const c of this.cubes) { c.rotation.x += c.userData.spin.x * dt; c.rotation.y += c.userData.spin.y * dt; }
    this.stars.rotation.y += dt * 0.004;
  }
}

/* ---------------------------------------------------------------------
   DOM user interface
   --------------------------------------------------------------------- */
const LEVEL_INFO = [
  { name: 'THE BEGINNING', blurb: 'Movement, buttons, cubes and plates.' },
  { name: 'THE IMPOSSIBLE HALLWAY', blurb: 'A corridor that never ends.' },
  { name: 'THE GRAVITY CHAMBER', blurb: 'Every surface is a floor.' },
  { name: 'THE PORTAL LAB', blurb: 'Here is there.' },
  { name: 'THE BROKEN DIMENSION', blurb: 'Everything at once.' },
];

class UI {
  constructor(game) {
    this.game = game;
    this.$ = (id) => document.getElementById(id);
    this.screens = ['menu-main', 'menu-levels', 'menu-settings', 'menu-credits', 'menu-pause', 'controls-overlay', 'click-resume', 'level-complete', 'victory'];
    this.hud = this.$('hud');
    this.promptEl = this.$('prompt');
    this.promptText = this.$('prompt-text');
    this.crosshair = this.$('crosshair');
    this.toastEl = this.$('toast');
    this.toastTimer = 0;
    this.hintIndex = -1;
    this.hints = [];
    this.lastPrompt = null;
    this.backTo = 'menu-main';
    document.addEventListener('click', (e) => {
      const b = e.target.closest('[data-action]');
      if (!b) return;
      e.preventDefault();
      this.game.audio.init();
      this.game.audio.click();
      this.game.onAction(b.dataset.action, b.dataset);
    });
    this.$('click-resume').addEventListener('click', () => this.game.resume());
    this.bindSettings();
  }
  showScreen(id) {
    for (const s of this.screens) this.$(s).classList.toggle('hidden', s !== id);
    const first = id && this.$(id).querySelector('.btn.primary, .btn, .level-card:not(.locked)');
    if (first && id !== 'click-resume') setTimeout(() => first.focus({ preventScroll: true }), 30);
  }
  hideScreens() { this.showScreen(null); }
  showHUD(on) { this.hud.classList.toggle('hidden', !on); }
  // ---- menu ----
  refreshMainMenu() {
    const save = this.game.save;
    const done = save.completedCount;
    const playBtn = this.$('btn-play');
    playBtn.textContent = done > 0 && done < LEVEL_COUNT ? `CONTINUE · LEVEL ${Math.min(save.data.unlocked, LEVEL_COUNT)}` : done >= LEVEL_COUNT ? 'PLAY AGAIN' : 'PLAY';
    const pips = Array.from({ length: LEVEL_COUNT }, (_, i) => `<span class="pip ${save.data.completed[i] ? 'done' : ''}" style="display:inline-block;margin-right:6px"></span>`).join('');
    this.$('menu-progress').innerHTML = `${pips}<span style="margin-left:8px">${done} / ${LEVEL_COUNT} CHAMBERS CLEARED</span>`;
  }
  buildLevelGrid() {
    const save = this.game.save.data;
    const grid = this.$('level-grid');
    grid.innerHTML = '';
    LEVEL_INFO.forEach((info, i) => {
      const locked = i + 1 > save.unlocked;
      const b = document.createElement('button');
      b.className = `level-card ${locked ? 'locked' : ''} ${save.completed[i] ? 'done' : ''}`;
      b.dataset.action = locked ? 'locked-level' : 'start-level';
      b.dataset.level = String(i);
      const best = save.bestTimes[i];
      b.innerHTML = `<div class="lv-num">0${i + 1}</div><div class="lv-name">${info.name}</div>
        <div class="lv-meta">${locked ? '🔒 LOCKED' : save.completed[i] ? `✔ BEST ${formatTime(best)}` : info.blurb}</div>`;
      grid.appendChild(b);
    });
  }
  bindSettings() {
    const s = this.game.settings;
    document.querySelectorAll('[data-setting]').forEach((el) => {
      const key = el.dataset.setting;
      const out = el.parentElement.querySelector('output');
      const show = () => {
        if (!out) return;
        const v = s[key];
        out.textContent = key === 'fov' ? `${v}°` : key === 'sensitivity' ? `${Number(v).toFixed(2)}` : `${Math.round(v * 100)}%`;
      };
      if (el.type === 'checkbox') el.checked = !!s[key]; else el.value = s[key];
      show();
      el.addEventListener('input', () => {
        s[key] = el.type === 'checkbox' ? el.checked : el.type === 'range' ? Number(el.value) : el.value;
        show();
        this.game.applySettings();
      });
    });
  }
  // ---- HUD ----
  setLevel(index, name) {
    this.$('level-label').textContent = `LEVEL ${index + 1} / ${LEVEL_COUNT}`;
    this.$('level-name').textContent = name;
    const pips = this.$('progress-pips');
    const save = this.game.save.data;
    pips.innerHTML = Array.from({ length: LEVEL_COUNT }, (_, i) => `<span class="pip ${save.completed[i] ? 'done' : ''} ${i === index ? 'current' : ''}"></span>`).join('');
  }
  setObjective(text) {
    const el = this.$('objective');
    this.$('objective-text').textContent = text;
    el.classList.remove('updated');
    void el.offsetWidth;
    el.classList.add('updated');
  }
  setTimer(t) { this.$('timer').textContent = formatTime(t); }
  setPrompt(p) {
    const key = p ? `${p.text}|${p.far ? 1 : 0}|${p.key || 'E'}|${TOUCH}` : null;
    if (key === this.lastPrompt) return;
    this.lastPrompt = key;
    if (!p) { this.promptEl.classList.add('hidden'); return; }
    this.promptEl.classList.remove('hidden');
    this.promptEl.classList.toggle('far', !!p.far);
    this.promptEl.querySelector('kbd').textContent = p.key || (TOUCH ? 'USE' : 'E');
    this.promptText.textContent = ' ' + p.text;
  }
  setCrosshair(state) {
    this.crosshair.className = state || '';
  }
  setHeld(text) {
    const el = this.$('held-indicator');
    el.classList.toggle('hidden', !text);
    if (text) el.innerHTML = TOUCH ? `HOLDING ${text} · tap <kbd>USE</kbd> to drop` : `HOLDING ${text} · <kbd>E</kbd> or <kbd>CLICK</kbd> to drop`;
  }
  setGravity(show, up) {
    const el = this.$('gravity-indicator');
    el.classList.toggle('hidden', !show);
    if (!show) return;
    this.$('gravity-text').textContent = `GRAVITY ▸ ${gravityName(up)}`;
  }
  toast(msg, type = '', dur = 2.6) {
    const el = this.toastEl;
    el.textContent = msg;
    el.className = type;
    void el.offsetWidth;
    this.toastTimer = dur;
  }
  update(dt) {
    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.toastEl.classList.add('hidden');
    }
  }
  // ---- hints ----
  setHints(list) {
    this.hints = list || [];
    this.hintIndex = -1;
    this.$('hint-text').classList.add('hidden');
    this.$('hint-count').textContent = `(0/${this.hints.length})`;
    if (this.game.settings.hints && this.hints.length) this.nextHint();
  }
  nextHint() {
    if (!this.hints.length) return;
    this.hintIndex = (this.hintIndex + 1) % (this.hints.length + 1);
    const el = this.$('hint-text');
    if (this.hintIndex === this.hints.length) {
      el.classList.add('hidden');
      this.hintIndex = -1;
      this.$('hint-count').textContent = `(0/${this.hints.length})`;
      return;
    }
    el.textContent = this.hints[this.hintIndex];
    el.classList.remove('hidden');
    this.$('hint-count').textContent = `(${this.hintIndex + 1}/${this.hints.length})`;
  }
  // ---- overlays ----
  fade(opacity, seconds = 0.35, color = null) {
    const el = this.$('fade');
    el.style.transition = `opacity ${seconds}s ease`;
    if (color) el.style.background = color;
    else if (opacity > 0) el.style.background = '#000';
    el.style.opacity = String(opacity);
  }
  setWhite(a) {
    const el = this.$('fade');
    el.style.transition = 'none';
    el.style.background = '#f4f8ff';
    el.style.opacity = String(a);
  }
  flash(color = 0xffffff, strength = 0.5) {
    const el = this.$('flash');
    el.style.transition = 'none';
    el.style.background = '#' + new THREE.Color(color).getHexString();
    el.style.opacity = String(strength);
    void el.offsetWidth;
    el.style.transition = 'opacity 0.6s ease';
    el.style.opacity = '0';
  }
}

/* ---------------------------------------------------------------------
   Touch controls: a floating joystick on the left half of the screen,
   drag-to-look on the right half, and on-screen action buttons.
   --------------------------------------------------------------------- */
class TouchControls {
  constructor(game) {
    this.game = game;
    this.el = document.getElementById('touch-controls');
    this.base = document.getElementById('joy-base');
    this.knob = document.getElementById('joy-knob');
    this.ghost = document.getElementById('joy-ghost');
    this.useBtn = document.getElementById('tbtn-use');
    this.R = 56;
    this.useState = '';
    this.reset();
    const el = this.el;
    el.addEventListener('pointerdown', (e) => this.down(e));
    el.addEventListener('pointermove', (e) => this.move(e));
    el.addEventListener('pointerup', (e) => this.up(e));
    el.addEventListener('pointercancel', (e) => this.up(e));
    el.addEventListener('lostpointercapture', (e) => this.up(e));
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  reset() {
    this.moveId = null;
    this.lookId = null;
    this.moveX = 0; this.moveY = 0; this.sprint = false;
    this.lookDX = 0; this.lookDY = 0;
    if (this.base) {
      this.base.classList.remove('active', 'sprint');
      this.ghost.classList.remove('hidden-ghost');
      this.knob.style.transform = '';
    }
  }
  down(e) {
    e.preventDefault();
    this.game.audio.init();
    const b = e.target.closest('[data-touch]');
    if (b) {
      b.classList.add('down');
      setTimeout(() => b.classList.remove('down'), 140);
      this.press(b.dataset.touch);
      return;
    }
    try { this.el.setPointerCapture(e.pointerId); } catch (err) { /* not capturable */ }
    if (e.clientX < window.innerWidth * 0.45 && this.moveId === null) {
      this.moveId = e.pointerId;
      this.ox = e.clientX; this.oy = e.clientY;
      this.base.style.left = `${this.ox}px`;
      this.base.style.top = `${this.oy}px`;
      this.base.classList.add('active');
      this.ghost.classList.add('hidden-ghost');
      this.knob.style.transform = '';
    } else if (this.lookId === null) {
      this.lookId = e.pointerId;
      this.lx = e.clientX; this.ly = e.clientY;
    }
  }
  move(e) {
    if (e.pointerId === this.moveId) {
      let dx = e.clientX - this.ox, dy = e.clientY - this.oy;
      const d = Math.hypot(dx, dy);
      this.sprint = d > this.R * 1.3;
      if (d > this.R) { dx *= this.R / d; dy *= this.R / d; }
      this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
      const dead = 0.14;
      const mag = Math.min(1, d / this.R);
      const k = mag < dead ? 0 : (mag - dead) / (1 - dead) / (mag || 1);
      this.moveX = (dx / this.R) * k;
      this.moveY = (dy / this.R) * k;
      this.base.classList.toggle('sprint', this.sprint);
    } else if (e.pointerId === this.lookId) {
      this.lookDX += e.clientX - this.lx;
      this.lookDY += e.clientY - this.ly;
      this.lx = e.clientX; this.ly = e.clientY;
    }
  }
  up(e) {
    if (e.pointerId === this.moveId) {
      this.moveId = null;
      this.moveX = 0; this.moveY = 0; this.sprint = false;
      this.base.classList.remove('active', 'sprint');
      this.ghost.classList.remove('hidden-ghost');
    } else if (e.pointerId === this.lookId) {
      this.lookId = null;
    }
  }
  press(action) {
    const g = this.game;
    if (navigator.vibrate) { try { navigator.vibrate(10); } catch (err) { /* unsupported */ } }
    if (action === 'pause') { g.pause(); return; }
    const code = { jump: 'Space', use: 'KeyE', reset: 'KeyR', hint: 'KeyH' }[action];
    if (code) g.pressed.add(code);
  }
  consumeLook() {
    const d = [this.lookDX, this.lookDY];
    this.lookDX = 0; this.lookDY = 0;
    return d;
  }
  setUse(state) {
    if (state === this.useState) return;
    this.useState = state;
    this.useBtn.classList.toggle('ready', state === 'ready');
    this.useBtn.classList.toggle('holding', state === 'holding');
    this.useBtn.textContent = state === 'holding' ? 'DROP' : 'USE';
  }
}

/* ---------------------------------------------------------------------
   Game: renderer, main loop, state machine, input and level flow
   --------------------------------------------------------------------- */
const QUALITY = {
  low: { pixelRatio: 1, shadows: false, shadowSize: 512, bloom: false, portalScale: 0.35 },
  medium: { pixelRatio: 1.25, shadows: true, shadowSize: 1024, bloom: true, portalScale: 0.5 },
  high: { pixelRatio: 1.5, shadows: true, shadowSize: 2048, bloom: true, portalScale: 0.75 },
};
const LEVELS = [Level1, Level2, Level3, Level4, Level5];

const _plane = new THREE.Plane();
const _clip = new THREE.Vector4();
const _qv = new THREE.Vector4();
const _frustum = new THREE.Frustum();
const _pv = new THREE.Matrix4();
const _vm = new THREE.Matrix4();
const _size = new THREE.Vector2();

// Replace the near plane of a projection with an arbitrary clip plane
// (Lengyel's oblique near-plane), so a portal camera never renders
// what lies behind the destination portal.
function setObliqueNearPlane(camera, worldPlane) {
  _plane.copy(worldPlane).applyMatrix4(camera.matrixWorldInverse);
  _clip.set(_plane.normal.x, _plane.normal.y, _plane.normal.z, _plane.constant);
  const e = camera.projectionMatrix.elements;
  _qv.set((Math.sign(_clip.x) + e[8]) / e[0], (Math.sign(_clip.y) + e[9]) / e[5], -1.0, (1.0 + e[10]) / e[14]);
  _clip.multiplyScalar(2.0 / _clip.dot(_qv));
  e[2] = _clip.x;
  e[6] = _clip.y;
  e[10] = _clip.z + 1.0;
  e[14] = _clip.w;
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
}

class Game {
  constructor() {
    this.save = new SaveData();
    this.settings = this.save.settings;
    this.state = 'loading';
    this.level = null;
    this.levelIndex = 0;
    this.levelTime = 0;
    this.held = null;
    this.holdRatio = 0.3;
    this.holdVel = V3();
    this.snapHeld = false;
    this.keys = {};
    this.pressed = new Set();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.locked = false;
    this.pointerFallback = false;
    this.lockFailures = 0;
    this.mouseButtons = 0;
    this.portalCooldown = 0;
    this.target = null;
    this.respawning = false;
    this.raycaster = new THREE.Raycaster();
    this.clock = new THREE.Clock();
  }
  get quality() { return QUALITY[this.settings.quality] || QUALITY.high; }
  get state() { return this._state; }
  set state(v) {
    this._state = v;
    document.body.dataset.state = v;
  }
  detectTouch() {
    const pref = this.settings.touch;
    if (pref === 'on') return true;
    if (pref === 'off') return false;
    const mq = (q) => window.matchMedia && window.matchMedia(q).matches;
    return mq('(pointer: coarse)') || (navigator.maxTouchPoints > 0 && !mq('(hover: hover)')) || !!this.sawTouch;
  }
  applyTouchMode() {
    this.touchMode = this.detectTouch();
    TOUCH = this.touchMode;
    document.body.classList.toggle('touch', this.touchMode);
    if (this.touchCtl) this.touchCtl.reset();
    if (this.touchMode && document.pointerLockElement) document.exitPointerLock();
    if (this.ui) { this.ui.lastPrompt = null; if (this.held) this.ui.setHeld(PROP_NAMES[this.held.kind].toUpperCase()); }
  }
  // Fullscreen + landscape lock where the browser allows it (Android); iOS
  // gets the same effect from "Add to Home Screen".
  enterFullscreen() {
    if (!this.touchMode) return;
    const d = document.documentElement;
    if (document.fullscreenElement || !d.requestFullscreen) return;
    try {
      d.requestFullscreen({ navigationUI: 'hide' })
        .then(() => { if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {}); })
        .catch(() => {});
    } catch (e) { /* not allowed */ }
  }

  start() {
    this.applyTouchMode();
    // First run on a phone or tablet: start with lighter graphics.
    if (this.save.isNew && this.touchMode) this.settings.quality = (navigator.hardwareConcurrency || 4) <= 4 ? 'low' : 'medium';
    const probe = document.createElement('canvas');
    let gl2 = null;
    try { gl2 = probe.getContext('webgl2'); } catch (e) { gl2 = null; }
    if (!gl2) {
      this.fatal('WEBGL 2 UNAVAILABLE', '<p>IMPOSSIBLE ROOMS needs WebGL 2, which your browser or graphics driver does not provide.</p><p>Try an up-to-date Chrome, Edge, Firefox or Safari, enable hardware acceleration in the browser settings, or update your graphics drivers.</p>');
      return;
    }
    try {
      this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    } catch (e) {
      this.fatal('GRAPHICS ERROR', `<p>The 3D renderer could not be created.</p><p class="dim">${String(e && e.message || e)}</p>`);
      return;
    }
    const r = this.renderer;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 0.95;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.shadowMap.enabled = this.quality.shadows;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.shadowMap.autoUpdate = false;
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.quality.pixelRatio));
    r.setSize(window.innerWidth, window.innerHeight);
    document.getElementById('app').appendChild(r.domElement);
    r.domElement.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.fatal('GRAPHICS CONTEXT LOST', '<p>The browser reset the graphics context (often due to a driver hiccup or memory pressure).</p><p>Reload the page to continue — your progress is saved.</p>');
    });

    this.tex = new TextureFactory(r);
    this.M = buildMaterials(this.tex);
    this.envMap = buildEnvironment(r);
    this.camera = new THREE.PerspectiveCamera(this.settings.fov, window.innerWidth / window.innerHeight, 0.03, 600);
    this.portalCam = new THREE.PerspectiveCamera();
    this.portalCam.layers.enable(1);

    // Many mobile GPUs can't render to half-float targets: fall back to 8-bit.
    const halfOK = r.extensions.has('EXT_color_buffer_float') || r.extensions.has('EXT_color_buffer_half_float');
    this.rtType = halfOK ? THREE.HalfFloatType : THREE.UnsignedByteType;
    this.bloomSupported = halfOK;
    const pr0 = r.getPixelRatio();
    this.composer = halfOK ? new EffectComposer(r)
      : new EffectComposer(r, new THREE.WebGLRenderTarget(window.innerWidth * pr0, window.innerHeight * pr0, { type: THREE.UnsignedByteType }));
    this.renderPass = new RenderPass(new THREE.Scene(), this.camera);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.55, 0.4, 1.0);
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.bloom.enabled = this.quality.bloom && this.bloomSupported;

    this.audio = new AudioEngine(this.settings);
    this.touchCtl = new TouchControls(this);
    this.player = new Player(this);
    this.ui = new UI(this);
    this.menu = new MenuScene(this);
    this.bindInput();
    window.addEventListener('resize', () => this.onResize());
    this.onResize();
    window.IR = this; // handy for the console
    document.getElementById('loading').classList.add('hidden');
    this.goToMenu();
    this.renderer.setAnimationLoop(() => this.frame());
  }
  fatal(title, html) {
    if (window.__irShowError) window.__irShowError(title, html);
    this.state = 'dead';
    if (this.renderer) this.renderer.setAnimationLoop(null);
  }

  /* ---------------- input ---------------- */
  bindInput() {
    const canvas = this.renderer.domElement;
    window.addEventListener('keydown', (e) => {
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code) && this.state !== 'menu') e.preventDefault();
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') && e.code !== 'Escape') return;
      if (!e.repeat) this.pressed.add(e.code);
      this.keys[e.code] = true;
      if (e.code === 'Escape') this.onEscape();
      if (e.code === 'KeyP' && this.state === 'playing') this.pause();
    });
    window.addEventListener('keyup', (e) => { this.keys[e.code] = false; });
    window.addEventListener('touchstart', () => {
      if (!this.sawTouch) { this.sawTouch = true; if (!this.touchMode) this.applyTouchMode(); }
    }, { passive: true });
    window.addEventListener('touchend', () => this.audio.init(), { passive: true });
    window.addEventListener('blur', () => { this.keys = {}; if (this.state === 'playing') this.pause(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden && this.state === 'playing') this.pause(); });
    document.addEventListener('mousemove', (e) => {
      if (this.locked || (this.pointerFallback && this.mouseButtons)) {
        this.mouseDX += e.movementX || 0;
        this.mouseDY += e.movementY || 0;
      }
    });
    canvas.addEventListener('mousedown', (e) => {
      this.mouseButtons |= 1 << e.button;
      this.audio.init();
      if (this.state === 'playing') {
        if (!this.locked && !this.pointerFallback) this.lockPointer();
        else if (e.button === 0) this.pressed.add('Mouse0');
      }
    });
    window.addEventListener('mouseup', (e) => { this.mouseButtons &= ~(1 << e.button); });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (this.locked) {
        this.lockFailures = 0;
        if (this.state === 'playing') this.ui.hideScreens();
      } else if (this.state === 'playing' && !this.pointerFallback && !this.touchMode) {
        this.pause();
      }
    });
    document.addEventListener('pointerlockerror', () => this.onLockFailed());
  }
  lockPointer() {
    const c = this.renderer.domElement;
    if (this.pointerFallback || this.touchMode) return;
    if (!c.requestPointerLock) { this.enableFallback(); return; }
    try {
      const p = c.requestPointerLock();
      if (p && p.catch) p.catch(() => this.onLockFailed());
    } catch (e) {
      this.onLockFailed();
    }
  }
  onLockFailed() {
    if (this.state !== 'playing' || this.locked) return;
    this.lockFailures++;
    if (this.lockFailures >= 3) { this.enableFallback(); return; }
    this.ui.showScreen('click-resume');
  }
  enableFallback() {
    this.pointerFallback = true;
    this.ui.hideScreens();
    this.ui.toast('POINTER LOCK UNAVAILABLE — HOLD A MOUSE BUTTON & DRAG TO LOOK', 'warn', 5);
  }
  onEscape() {
    const vis = (id) => !document.getElementById(id).classList.contains('hidden');
    if (vis('menu-settings') || vis('menu-levels') || vis('menu-credits')) { this.onAction('back'); return; }
    if (this.state === 'paused' && vis('controls-overlay')) { this.ui.showScreen('menu-pause'); return; }
    if (this.state === 'playing') this.pause();
  }
  input() {
    const k = this.keys, t = this.touchCtl;
    const [lx, ly] = t.consumeLook();
    const TOUCH_LOOK = 1.6; // touch drags cover fewer pixels than mouse motion
    return {
      forward: clamp((k.KeyW || k.ArrowUp ? 1 : 0) - (k.KeyS || k.ArrowDown ? 1 : 0) - t.moveY, -1, 1),
      strafe: clamp((k.KeyD || k.ArrowRight ? 1 : 0) - (k.KeyA || k.ArrowLeft ? 1 : 0) + t.moveX, -1, 1),
      sprint: !!(k.ShiftLeft || k.ShiftRight) || t.sprint,
      jumpPressed: this.pressed.has('Space'),
      mouseDX: this.mouseDX + lx * TOUCH_LOOK,
      mouseDY: this.mouseDY + ly * TOUCH_LOOK,
    };
  }

  /* ---------------- menu / flow actions ---------------- */
  onAction(action, data = {}) {
    const ui = this.ui;
    switch (action) {
      case 'play': {
        const d = this.save.data;
        const next = this.save.completedCount >= LEVEL_COUNT ? 0 : clamp(d.unlocked - 1, 0, LEVEL_COUNT - 1);
        this.startLevel(next);
        break;
      }
      case 'levels': ui.buildLevelGrid(); ui.showScreen('menu-levels'); this.backTo = 'menu-main'; break;
      case 'settings': this.backTo = this.state === 'paused' ? 'menu-pause' : 'menu-main'; ui.showScreen('menu-settings'); break;
      case 'credits': this.backTo = 'menu-main'; ui.showScreen('menu-credits'); break;
      case 'back':
        if (this.state === 'paused') ui.showScreen('menu-pause');
        else { ui.refreshMainMenu(); ui.showScreen('menu-main'); }
        break;
      case 'start-level': this.startLevel(Number(data.level) || 0); break;
      case 'locked-level': this.audio.deny(); break;
      case 'resume': this.resume(); break;
      case 'restart': this.restartLevel(); break;
      case 'controls': ui.showScreen('controls-overlay'); break;
      case 'controls-ok':
        if (this.state === 'intro') { this.state = 'playing'; ui.hideScreens(); this.enterFullscreen(); this.lockPointer(); }
        else ui.showScreen('menu-pause');
        break;
      case 'main-menu': this.goToMenu(); break;
      case 'next-level': this.startLevel(Math.min(this.levelIndex + 1, LEVEL_COUNT - 1)); break;
      case 'replay': this.startLevel(0); break;
      case 'reset-progress':
        if (window.confirm('Erase all level progress and best times?')) { this.save.resetProgress(); ui.refreshMainMenu(); ui.buildLevelGrid(); ui.toast('PROGRESS RESET'); }
        break;
      default: break;
    }
  }
  applySettings() {
    const q = this.quality;
    this.audio.applyVolumes();
    const pr = Math.min(window.devicePixelRatio || 1, q.pixelRatio);
    this.renderer.setPixelRatio(pr);
    this.composer.setPixelRatio(pr);
    this.bloom.enabled = q.bloom && this.bloomSupported;
    this.applyTouchMode();
    if (this.renderer.shadowMap.enabled !== q.shadows) {
      this.renderer.shadowMap.enabled = q.shadows;
      if (this.level) this.level.scene.traverse((o) => { if (o.material) [].concat(o.material).forEach((m) => { m.needsUpdate = true; }); });
    }
    if (this.state !== 'menu' && this.state !== 'victory') { this.camera.fov = this.settings.fov; this.camera.updateProjectionMatrix(); }
    this.onResize();
    this.save.save();
  }
  startLevel(i) {
    this.audio.init();
    this.enterFullscreen();
    this.ui.fade(1, 0);
    this.loadLevel(i, 0, true);
    this.ui.showHUD(true);
    if (i === 0) {
      this.state = 'intro';
      this.ui.showScreen('controls-overlay');
    } else {
      this.state = 'playing';
      this.ui.hideScreens();
      this.lockPointer();
    }
    requestAnimationFrame(() => this.ui.fade(0, 0.8));
  }
  restartLevel() {
    this.state = 'playing';
    this.ui.hideScreens();
    this.lockPointer();
    this.ui.fade(1, 0);
    this.loadLevel(this.levelIndex, 0, true);
    requestAnimationFrame(() => this.ui.fade(0, 0.6));
  }
  loadLevel(i, cp = 0, fresh = true) {
    if (this.level) {
      this.level.scene.remove(this.player.avatar);
      this.level.dispose();
    }
    this.held = null;
    this.ui.setHeld(null);
    const L = new LEVELS[i](this, cp);
    this.level = L;
    this.levelIndex = i;
    L.build();
    this.player.attach(L);
    this.player.spawn(L.spawn.pos, L.spawn.up, L.spawn.look);
    this.camera.clearViewOffset();
    this.camera.fov = this.settings.fov;
    this.camera.near = 0.03;
    this.camera.updateProjectionMatrix();
    this.player.updateCamera();
    this.resizePortals();
    if (fresh) this.levelTime = 0;
    this.ui.setLevel(i, L.meta.name);
    if (fresh) this.ui.setHints(L.hints);
    this.ui.setGravity(L.showGravity, this.player.up);
    this.ui.setPrompt(null);
    L.update(0);
    this.audio.startAmbient(AMBIENT_PROFILES[L.meta.ambient] || AMBIENT_PROFILES.lab);
    this.renderPass.scene = L.scene;
    L.scene.updateMatrixWorld(true);
    this.portalCooldown = 0.3;
    try { this.renderer.compile(L.scene, this.camera); } catch (e) { /* compile lazily */ }
  }
  pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    const L = this.level;
    document.getElementById('pause-info').innerHTML = `LEVEL ${this.levelIndex + 1} — ${L.meta.name}<br>Time ${formatTime(this.levelTime)}`;
    this.ui.showScreen('menu-pause');
    this.ui.setPrompt(null);
    if (document.pointerLockElement) document.exitPointerLock();
    this.touchCtl.reset();
  }
  resume() {
    if (this.state !== 'paused' && this.state !== 'playing') return;
    this.state = 'playing';
    this.ui.hideScreens();
    this.enterFullscreen();
    this.lockPointer();
  }
  goToMenu() {
    if (this.level) {
      this.level.scene.remove(this.player.avatar);
      this.level.dispose();
      this.level = null;
    }
    this.held = null;
    this.state = 'menu';
    if (document.pointerLockElement) document.exitPointerLock();
    this.ui.showHUD(false);
    this.ui.refreshMainMenu();
    this.ui.showScreen('menu-main');
    this.ui.fade(0, 0.5);
    this.camera.fov = 16;
    this.camera.near = 0.5;
    this.camera.updateProjectionMatrix();
    this.renderPass.scene = this.menu.scene;
    this.audio.startAmbient(AMBIENT_PROFILES.menu);
  }
  completeLevel() {
    if (this.state !== 'playing') return;
    const i = this.levelIndex;
    const t = this.levelTime;
    const prevBest = this.save.data.bestTimes[i];
    this.save.completeLevel(i, t);
    this.audio.levelComplete();
    this.releaseHeld({ silent: true });
    this.state = 'levelComplete';
    this.ui.setPrompt(null);
    if (document.pointerLockElement) document.exitPointerLock();
    document.getElementById('lc-title').textContent = `LEVEL ${i + 1} — ${this.level.meta.name}`;
    document.getElementById('lc-time').textContent = formatTime(t);
    document.getElementById('lc-best').textContent = prevBest == null || t < prevBest ? 'NEW BEST TIME' : `BEST ${formatTime(prevBest)}`;
    this.ui.setLevel(i, this.level.meta.name);
    this.ui.flash(0x5dffb0, 0.35);
    this.ui.showScreen('level-complete');
  }
  startFinale() {
    if (this.state !== 'playing') return;
    this.releaseHeld({ silent: true });
    this.state = 'finale';
    this.player.frozen = true;
    this.level.finale = { t: 0, start: this.camera.position.clone(), startQ: this.camera.quaternion.clone() };
    this.audio.finale();
    this.ui.setPrompt(null);
    this.ui.showHUD(false);
    if (document.pointerLockElement) document.exitPointerLock();
  }
  finishGame() {
    this.save.completeLevel(LEVEL_COUNT - 1, this.levelTime);
    const times = this.save.data.lastTimes;
    const total = times.reduce((a, b) => a + (b || 0), 0);
    document.getElementById('victory-time').textContent = formatTime(total);
    document.getElementById('victory-breakdown').innerHTML = LEVEL_INFO.map((l, i) => `<span>${i + 1}. ${l.name}</span><span>${formatTime(times[i])}</span>`).join('');
    if (this.level) { this.level.scene.remove(this.player.avatar); this.level.dispose(); this.level = null; }
    this.state = 'victory';
    this.camera.fov = 16; this.camera.near = 0.5; this.camera.updateProjectionMatrix();
    this.renderPass.scene = this.menu.scene;
    this.audio.startAmbient(AMBIENT_PROFILES.menu);
    this.ui.setWhite(1);
    requestAnimationFrame(() => requestAnimationFrame(() => this.ui.fade(0, 2.5, '#f4f8ff')));
    this.ui.showScreen('victory');
  }
  respawn(msg, type = 'warn') {
    if (this.respawning || !this.level) return;
    this.respawning = true;
    this.player.frozen = true;
    this.ui.fade(1, 0.25);
    setTimeout(() => {
      if (this.level) {
        this.loadLevel(this.levelIndex, this.level.checkpoint, false);
        this.ui.toast(msg, type);
      }
      this.ui.fade(0, 0.5);
      this.respawning = false;
    }, 280);
  }

  /* ---------------- gameplay services used by entities ---------------- */
  flash(color, strength) { this.ui.flash(color, strength); }
  shiftGravity(normal) {
    const L = this.level;
    if (!this.player.setGravity(normal, L.world)) return;
    this.audio.gravity();
    this.ui.flash(0xffc457, 0.18);
    this.ui.toast(`GRAVITY ▸ ${gravityName(this.player.up)}`);
    this.ui.setGravity(true, this.player.up);
    for (const o of L.objects) o.grounded = false;
    L.onGravityChanged(this.player.up);
  }
  teleportPlayer(feet, look) {
    this.player.spawn(feet, this.player.up, look);
    this.player.updateCamera();
    this.snapHeld = true;
  }
  pickUp(obj) {
    if (this.held) this.releaseHeld();
    this.held = obj;
    obj.held = true;
    obj.cradle = false;
    obj.solid.enabled = false;
    obj.vel.set(0, 0, 0);
    if (obj.kind === 'perception') {
      const d = this.camera.position.distanceTo(obj.pos);
      this.holdRatio = clamp(obj.size / Math.max(0.3, d), 0.05, 0.9);
    }
    this.snapHeld = false;
    this.holdVel.set(0, 0, 0);
    this.audio.pickup();
    this.ui.setHeld(PROP_NAMES[obj.kind].toUpperCase());
  }
  releaseHeld({ silent = false } = {}) {
    const o = this.held;
    if (!o) return;
    this.held = null;
    o.held = false;
    this.ui.setHeld(null);
    if (o.locked) return;
    o.vel.copy(this.holdVel).clampLength(0, 5);
    depenetrate(o.pos, o.half, this.level.world, (s) => s.owner === o);
    o.solid.enabled = true;
    o.syncSolid();
    o.grounded = false;
    if (!silent) this.audio.drop();
  }
  updateHeld(dt) {
    const o = this.held;
    if (!o) return;
    const cam = this.camera;
    const origin = cam.position;
    const dir = _v1.set(0, 0, -1).applyQuaternion(cam.quaternion);
    const world = this.level.world;
    const prev = _v2.copy(o.pos);
    if (o.kind === 'perception') {
      // Keep the block's apparent (angular) size constant and push it as far
      // along the view ray as it fits: look far away and it becomes huge.
      const r = this.holdRatio;
      const ray = world.raycast(origin, dir, 90, (s) => s.owner === o || s.owner === this.player);
      const dFar = Math.min(ray.dist, 4.6 / r);
      const dMin = Math.max(0.55, 0.22 / r);
      const half = V3(), c = V3(), mn = V3(), mx = V3();
      let found = -1;
      for (let d = dFar; d >= dMin; d -= Math.max(0.035, d * 0.02)) {
        half.setScalar((r * d) / 2);
        c.copy(origin).addScaledVector(dir, d);
        boxFrom(c, half, mn, mx);
        if (!world.firstOverlap(mn, mx, (s) => s.owner === o)) { found = d; break; }
      }
      if (found > 0) {
        o.setSize(clamp(r * found, 0.18, 4.6));
        o.pos.copy(origin).addScaledVector(dir, found);
      }
    } else {
      const want = 1.2 + o.size * 0.6;
      const ray = world.raycast(origin, dir, want + o.size, (s) => s.owner === o || s.owner === this.player);
      const d = Math.max(0.45, Math.min(want, ray.dist - o.size * 0.75));
      const target = _v3.copy(origin).addScaledVector(dir, d);
      target.addScaledVector(V3(0, 1, 0).applyQuaternion(cam.quaternion), -0.18 - o.size * 0.25);
      if (this.snapHeld) o.pos.copy(target);
      else o.pos.lerp(target, 1 - Math.exp(-28 * dt));
    }
    this.snapHeld = false;
    if (dt > 0) this.holdVel.subVectors(o.pos, prev).divideScalar(dt);
    o.syncSolid();
    o.mesh.position.copy(o.pos);
  }
  updateTarget() {
    const L = this.level;
    const cam = this.camera;
    const origin = cam.position;
    const dir = _v1.set(0, 0, -1).applyQuaternion(cam.quaternion).clone();
    this.raycaster.set(origin, dir);
    this.raycaster.far = 70;
    const hits = this.raycaster.intersectObjects(L.pickMeshes, false);
    let target = null;
    for (const h of hits) {
      const ent = h.object.userData.ent;
      if (!ent || ent === this.held) continue;
      const occ = L.world.raycast(origin, dir, h.distance, (s) => s.owner === ent || s.owner === this.player || (this.held && s.owner === this.held));
      if (occ.solid && occ.dist < h.distance - 0.05) break;
      const p = ent.prompt(this);
      if (!p) continue;
      if (h.distance > ent.range) target = { ent, prompt: { text: 'Out of reach — move closer', far: true }, out: true };
      else target = { ent, prompt: p, out: !!p.far };
      break;
    }
    if (!target) {
      const c = L.contextPrompt();
      if (c) target = { ctx: c, prompt: { text: c.text } };
    }
    this.target = target;
    let prompt = target ? target.prompt : null;
    if (this.held && (!target || target.ent instanceof PhysObject || target.out)) prompt = { text: 'Drop' };
    this.ui.setPrompt(prompt);
    this.ui.setCrosshair(this.held ? 'holding' : target ? (target.out ? 'active far' : 'active') : '');
  }
  handleInteract() {
    const t = this.target;
    if (this.pressed.has('Mouse0') && this.held) { this.releaseHeld(); return; }
    if (!this.pressed.has('KeyE')) return;
    if (this.held) {
      if (t && t.ent && !(t.ent instanceof PhysObject) && !t.out) t.ent.interact(this);
      else if (t && t.ctx) t.ctx.action();
      else this.releaseHeld();
      return;
    }
    if (!t) return;
    if (t.ctx) t.ctx.action();
    else if (t.out && t.prompt.text.startsWith('Out of reach')) this.audio.deny();
    else t.ent.interact(this);
  }
  checkPortals(dt) {
    const L = this.level;
    if (!L.portals.length) return;
    this.portalCooldown = Math.max(0, this.portalCooldown - dt);
    const pl = this.player;
    const local = V3();
    if (this.portalCooldown <= 0) {
      for (const p of L.portals) {
        if (!p.link) continue;
        p.localOf(pl.pos, local);
        if (p.captures(local) && pl.vel.dot(p.normal) < 0.5) { this.teleportThrough(p); break; }
      }
    }
    for (const o of L.objects) {
      if (o.held || o.locked || o.cradle) continue;
      for (const p of L.portals) {
        if (!p.link) continue;
        p.localOf(o.pos, local);
        if (p.captures(local)) {
          o.pos.applyMatrix4(p.toLink);
          o.vel.applyQuaternion(p.toLinkQ);
          p.link.localOf(o.pos, local);
          const need = o.size / 2 + 0.08;
          if (local.z < need) o.pos.addScaledVector(p.link.normal, need - local.z);
          o.syncSolid();
          this.audio.tone({ type: 'sine', f: 600, f2: 1200, dur: 0.25, vol: 0.06, rev: 0.4 });
          break;
        }
      }
    }
  }
  teleportThrough(p) {
    const pl = this.player, dst = p.link, L = this.level;
    const changed = pl.applyTransform(p.toLink, p.toLinkQ, L.world);
    const local = dst.localOf(pl.pos, V3());
    if (local.z < 0.2) pl.pos.addScaledVector(dst.normal, 0.2 - local.z);
    pl.syncSolid();
    pl.updateCamera();
    this.snapHeld = true;
    this.portalCooldown = 0.25;
    this.audio.portal();
    this.ui.flash(dst.color.getHex(), 0.12);
    if (changed) {
      this.ui.setGravity(L.showGravity, pl.up);
      this.ui.toast('GRAVITY REALIGNED');
      for (const o of L.objects) o.grounded = false;
    }
  }

  /* ---------------- per-frame ---------------- */
  frame() {
    const dt = Math.min(0.05, this.clock.getDelta());
    this.ui.update(dt);
    this.audio.update(dt);
    switch (this.state) {
      case 'menu':
      case 'victory':
        this.menu.update(dt, this.camera);
        break;
      case 'playing':
        this.updatePlaying(dt);
        break;
      case 'finale':
        this.updateFinale(dt);
        break;
      default:
        break;
    }
    this.render();
    this.pressed.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
  }
  updatePlaying(dt) {
    const L = this.level;
    const pl = this.player;
    if (!L) return;
    // Phones held upright show a "rotate" overlay; hold the simulation still.
    if (this.touchMode && window.innerHeight > window.innerWidth) { this.ui.setPrompt(null); return; }
    this.levelTime += dt;
    this.ui.setTimer(this.levelTime);
    if (this.pressed.has('KeyR') && !this.respawning) { this.respawn('PUZZLE RESET — BACK TO CHECKPOINT', ''); return; }
    if (this.pressed.has('KeyH')) this.ui.nextHint();
    const ents = L.entities.slice();
    for (const e of ents) if (!(e instanceof PhysObject) && !(e instanceof PressurePlate) && !(e instanceof Trigger)) e.update(dt);
    pl.update(dt, this.input(), L.world);
    this.updateHeld(dt);
    for (const o of L.objects) {
      o.update(dt);
      if (!o.held && !o.locked && L.isOutOfBounds(o.pos)) {
        o.pos.copy(o.home); o.vel.set(0, 0, 0); o.syncSolid();
        this.ui.toast(`${PROP_NAMES[o.kind].toUpperCase()} RETURNED`);
      }
    }
    this.checkPortals(dt);
    for (const e of ents) if (e instanceof PressurePlate || e instanceof Trigger) e.update(dt);
    L.updateCommon(dt);
    L.update(dt);
    L.runDeferred();
    if (this.state !== 'playing' || this.level !== L) return;
    if (L.isOutOfBounds(pl.pos) && !this.respawning) { this.respawn('SIGNAL LOST — RETURNING TO CHECKPOINT'); return; }
    this.updateTarget();
    this.handleInteract();
    if (this.touchMode) this.touchCtl.setUse(this.held ? 'holding' : this.target && !this.target.out ? 'ready' : '');
    this.ui.setGravity(L.showGravity, pl.up);
  }
  updateFinale(dt) {
    const L = this.level;
    for (const e of L.entities.slice()) if (!(e instanceof Trigger) && !(e instanceof PhysObject) && !(e instanceof PressurePlate)) e.update(dt);
    L.updateCommon(dt);
    if (L.updateFinale(dt)) this.finishGame();
  }
  renderPortals() {
    const L = this.level;
    if (!L || !L.portals.length) return;
    const cam = this.camera;
    const r = this.renderer;
    cam.updateMatrixWorld();
    _pv.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_pv);
    const local = V3();
    const pc = this.portalCam;
    for (const p of L.portals) {
      if (!p.link) continue;
      p.localOf(cam.position, local);
      if (local.z < -0.05 || cam.position.distanceTo(p.center) > 75 || !_frustum.intersectsSphere(p.sphere)) continue;
      _vm.multiplyMatrices(p.toLink, cam.matrixWorld);
      _vm.decompose(pc.position, pc.quaternion, pc.scale);
      pc.fov = cam.fov; pc.aspect = cam.aspect; pc.near = cam.near; pc.far = cam.far;
      pc.updateProjectionMatrix();
      pc.updateMatrixWorld(true);
      _plane.setFromNormalAndCoplanarPoint(p.link.normal, p.link.center);
      setObliqueNearPlane(pc, _plane);
      p.surface.visible = false;
      p.link.surface.visible = false;
      r.setRenderTarget(p.rt);
      r.clear();
      r.render(L.scene, pc);
      p.surface.visible = true;
      p.link.surface.visible = true;
      p.uniforms.uReady.value = 1;
    }
    r.setRenderTarget(null);
  }
  render() {
    if (this.state === 'dead') return;
    this.renderer.shadowMap.needsUpdate = true;
    if (this.level && this.renderPass.scene === this.level.scene) this.renderPortals();
    this.composer.render();
  }
  resizePortals() {
    if (!this.level) return;
    this.renderer.getDrawingBufferSize(_size);
    const s = this.quality.portalScale;
    for (const p of this.level.portals) {
      p.rt.setSize(Math.max(2, Math.floor(_size.x * s)), Math.max(2, Math.floor(_size.y * s)));
      p.uniforms.uRes.value.copy(_size);
    }
  }
  onResize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.resizePortals();
  }
}

/* ---------------------------------------------------------------------
   Boot
   --------------------------------------------------------------------- */
async function boot() {
  window.__IR_STARTED = true;
  try {
    await Promise.race([
      Promise.all([document.fonts.load("700 48px 'Orbitron'"), document.fonts.load("600 32px 'Rajdhani'"), document.fonts.load("500 32px 'Rajdhani'")]),
      new Promise((r) => setTimeout(r, 2000)),
    ]);
  } catch (e) { /* fonts are optional */ }
  try {
    new Game().start();
  } catch (e) {
    console.error(e);
    if (window.__irShowError) window.__irShowError('FAILED TO START', `<p>An unexpected error stopped the game from starting.</p><p class="dim">${String(e && e.message || e)}</p>`);
  }
}
boot();
