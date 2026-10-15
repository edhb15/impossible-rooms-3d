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
const LEVEL_COUNT = 10;
const PART_ONE_COUNT = 5; // levels 1–5: the facility · levels 6–10: the sunken temple
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
      // Saves from before Part II existed stopped unlocking at level 5.
      if (this.data.completed[PART_ONE_COUNT - 1]) this.data.unlocked = Math.max(this.data.unlocked, PART_ONE_COUNT + 1);
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
    this.fxTimers = {};
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
    // Electrical hum (or, in the temple, a deep earth drone): detuned
    // oscillators through a low-pass filter.
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = p.humCutoff; lp.Q.value = 2;
    const hg = c.createGain(); hg.gain.value = p.humVol;
    lp.connect(hg); hg.connect(bus);
    for (const det of p.humVol > 0 ? [0, 0.7, -0.4] : []) {
      const o = c.createOscillator();
      o.type = p.humType || 'sawtooth';
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
    this.fxTimers = {};
  }
  // Generative ambient music: sparse, soft notes from the level's scale.
  update(dt) {
    if (!this.ready || !this.profile) return;
    const p = this.profile;
    this.padTimer -= dt;
    if (this.padTimer <= 0) {
      this.padTimer = rand(p.padGap[0], p.padGap[1]);
      const f = p.scale[Math.floor(Math.random() * p.scale.length)];
      if (p.voice === 'flute') this.flute(f);
      else {
        this.tone({ type: 'sine', f, dur: rand(3.5, 6), vol: 0.035, attack: 1.4, rev: 0.9, dest: this.music });
        if (Math.random() < 0.5) this.tone({ type: 'triangle', f: f * 1.5, dur: 4, vol: 0.015, attack: 1.8, delay: 0.4, rev: 0.9, dest: this.music });
      }
    }
    // Environmental one-shots: insects, frogs, birds, water drips, distant drums.
    if (p.extras) {
      for (const k of p.extras) {
        this.fxTimers[k] = (this.fxTimers[k] ?? rand(0.5, 4)) - dt;
        if (this.fxTimers[k] <= 0) this.fxTimers[k] = this.ambientFx(k);
      }
    }
  }
  // A breathy clay-flute phrase for the temple levels.
  flute(f) {
    const d = rand(2.2, 3.6);
    this.tone({ type: 'triangle', f, dur: d, vol: 0.028, attack: 0.3, rev: 0.85, dest: this.music, detune: rand(-6, 6) });
    this.tone({ type: 'sine', f: f * 2, dur: d * 0.7, vol: 0.006, attack: 0.35, rev: 0.9, dest: this.music });
    this.noise({ dur: 0.4, vol: 0.006, type: 'bandpass', f: f * 3, q: 4, attack: 0.12, rev: 0.6, dest: this.music });
    if (Math.random() < 0.5) {
      const g = this.profile.scale;
      const f2 = g[Math.floor(Math.random() * g.length)];
      this.tone({ type: 'triangle', f: f2, dur: 2.4, vol: 0.02, attack: 0.25, delay: rand(0.6, 1.2), rev: 0.85, dest: this.music });
    }
  }
  // Plays one environmental sound and returns the seconds until the next.
  ambientFx(kind) {
    switch (kind) {
      case 'insects': {
        const n = 3 + Math.floor(Math.random() * 6), f = rand(3800, 5400), gap = rand(0.045, 0.08);
        for (let i = 0; i < n; i++) this.tone({ type: 'sine', f, f2: f * 0.97, dur: 0.035, vol: 0.009, delay: i * gap, rev: 0.25 });
        return rand(0.3, 2.2);
      }
      case 'frogs': {
        const f = rand(90, 170), n = 2 + Math.floor(Math.random() * 3);
        for (let i = 0; i < n; i++) this.tone({ type: 'sawtooth', f, f2: f * 0.8, dur: 0.09, vol: 0.022, lp: 700, delay: i * 0.17, rev: 0.3 });
        return rand(2.5, 7);
      }
      case 'birds': {
        const f = rand(1300, 2300);
        this.tone({ type: 'sine', f, f2: f * 0.6, dur: 0.35, vol: 0.016, rev: 0.6 });
        this.tone({ type: 'sine', f: f * 0.6, f2: f * 0.95, dur: 0.25, vol: 0.013, delay: 0.42, rev: 0.6 });
        return rand(7, 15);
      }
      case 'drips': {
        const f = rand(1100, 1900);
        this.tone({ type: 'sine', f, f2: f * 0.55, dur: 0.09, vol: 0.03, rev: 0.95 });
        return rand(1.2, 4.5);
      }
      case 'drums': {
        const n = 2 + (Math.random() < 0.5 ? 1 : 0);
        for (let i = 0; i < n; i++) {
          this.tone({ type: 'sine', f: 84, f2: 46, dur: 0.6, vol: 0.08, delay: i * 0.42, rev: 0.6, dest: this.music });
          this.noise({ dur: 0.08, vol: 0.03, type: 'lowpass', f: 400, delay: i * 0.42, rev: 0.4, dest: this.music });
        }
        return rand(9, 18);
      }
      case 'creaks': {
        this.noise({ dur: 1.4, vol: 0.03, type: 'bandpass', f: rand(120, 260), f2: rand(80, 140), q: 6, attack: 0.4, rev: 0.7 });
        return rand(10, 22);
      }
      default: return 999;
    }
  }
  // ---- temple sound effects -----------------------------------------
  stoneGrind(dur = 0.6, vol = 1) {
    this.noise({ dur, vol: 0.12 * vol, type: 'lowpass', f: 420, f2: 180, q: 1.4, attack: 0.05, rev: 0.3 });
    this.noise({ dur, vol: 0.05 * vol, type: 'bandpass', f: 900, f2: 500, q: 3, attack: 0.04, rev: 0.2 });
    this.tone({ type: 'sawtooth', f: 46, f2: 40, dur, vol: 0.05 * vol, lp: 220, attack: 0.05, curve: 'lin', rev: 0.2 });
  }
  stoneDoor(open, dur = 1.6) {
    this.stoneGrind(dur, 1.3);
    this.tone({ type: 'sine', f: 62, f2: 34, dur: 0.5, vol: 0.22, delay: dur - 0.1, rev: 0.5 });
    this.noise({ dur: 0.4, vol: 0.08, type: 'lowpass', f: 500, delay: dur - 0.1, rev: 0.4 });
  }
  thump(vol = 1) {
    this.tone({ type: 'sine', f: 80, f2: 38, dur: 0.35, vol: 0.18 * vol, rev: 0.4 });
    this.noise({ dur: 0.2, vol: 0.07 * vol, type: 'lowpass', f: 600, rev: 0.3 });
  }
  relic() {
    // A marimba-like arpeggio with a shimmering tail.
    [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f, i) => {
      this.tone({ type: 'sine', f, dur: 0.5, vol: 0.09, delay: i * 0.08, rev: 0.6 });
      this.tone({ type: 'triangle', f: f * 4, dur: 0.08, vol: 0.02, delay: i * 0.08, rev: 0.3 });
    });
    this.tone({ type: 'sine', f: 1568, dur: 1.6, vol: 0.03, attack: 0.3, delay: 0.4, rev: 0.9, dest: this.music });
  }
  offering() {
    this.thump(0.8);
    [392, 587.33, 783.99].forEach((f, i) => this.tone({ type: 'triangle', f, dur: 1.2, vol: 0.06, delay: 0.15 + i * 0.12, rev: 0.8, dest: this.music }));
  }
  trapClick(vol = 1) {
    this.tone({ type: 'square', f: 1900, f2: 900, dur: 0.03, vol: 0.05 * vol, lp: 3000, rev: 0.1 });
    this.noise({ dur: 0.05, vol: 0.06 * vol, type: 'highpass', f: 2500, rev: 0.1 });
  }
  dart(vol = 1) {
    this.noise({ dur: 0.18, vol: 0.12 * vol, type: 'bandpass', f: 2400, f2: 700, q: 2, rev: 0.15 });
    this.trapClick(vol);
  }
  spikes(vol = 1) {
    this.noise({ dur: 0.16, vol: 0.14 * vol, type: 'highpass', f: 1800, rev: 0.2 });
    this.tone({ type: 'square', f: 520, f2: 260, dur: 0.12, vol: 0.05 * vol, lp: 2200, rev: 0.2 });
    this.tone({ type: 'sine', f: 120, f2: 60, dur: 0.15, vol: 0.1 * vol, rev: 0.2 });
  }
  whoosh(vol = 1) {
    this.noise({ dur: 0.45, vol: 0.12 * vol, type: 'bandpass', f: 300, f2: 1400, q: 1.6, attack: 0.15, rev: 0.2 });
  }
  fire(vol = 1) {
    this.noise({ dur: 1.1, vol: 0.16 * vol, type: 'lowpass', f: 1200, f2: 380, q: 0.8, attack: 0.06, rev: 0.3 });
    this.noise({ dur: 0.6, vol: 0.05 * vol, type: 'highpass', f: 2600, attack: 0.05, rev: 0.2 });
  }
  crumble(vol = 1) {
    this.noise({ dur: 0.6, vol: 0.12 * vol, type: 'lowpass', f: 700, f2: 200, attack: 0.02, rev: 0.4 });
    for (let i = 0; i < 4; i++) this.tone({ type: 'sine', f: rand(90, 160), f2: 50, dur: 0.12, vol: 0.06 * vol, delay: 0.05 + i * rand(0.06, 0.12), rev: 0.3 });
  }
  death() {
    this.tone({ type: 'sine', f: 140, f2: 36, dur: 0.8, vol: 0.32, rev: 0.5 });
    this.tone({ type: 'sawtooth', f: 98, f2: 70, dur: 0.9, vol: 0.06, lp: 500, rev: 0.6 });
    this.noise({ dur: 0.45, vol: 0.16, type: 'lowpass', f: 900, rev: 0.4 });
  }
  awaken() {
    // The temple wakes: a rising chord with drums.
    [146.83, 220, 293.66, 369.99, 440].forEach((f, i) => this.tone({ type: 'triangle', f, dur: 4, vol: 0.035, attack: 1.2, delay: i * 0.25, rev: 0.9, dest: this.music }));
    for (let i = 0; i < 6; i++) this.tone({ type: 'sine', f: 82, f2: 44, dur: 0.6, vol: 0.12, delay: i * 0.36, rev: 0.6, dest: this.music });
  }
}

const AMBIENT_PROFILES = {
  lab: { hum: 55, humCutoff: 160, humVol: 0.05, airFreq: 500, airVol: 0.02, scale: [220, 261.63, 329.63, 392, 440, 523.25], padGap: [4, 8] },
  hall: { hum: 49, humCutoff: 130, humVol: 0.06, airFreq: 300, airVol: 0.03, scale: [196, 233.08, 277.18, 311.13, 369.99, 415.3], padGap: [5, 9] },
  gravity: { hum: 41, humCutoff: 120, humVol: 0.07, airFreq: 220, airVol: 0.03, scale: [164.81, 196, 246.94, 293.66, 329.63], padGap: [4, 7] },
  portal: { hum: 60, humCutoff: 200, humVol: 0.045, airFreq: 900, airVol: 0.018, scale: [293.66, 349.23, 440, 523.25, 587.33, 698.46], padGap: [3, 6] },
  void: { hum: 36, humCutoff: 110, humVol: 0.06, airFreq: 180, airVol: 0.04, scale: [146.83, 174.61, 220, 261.63, 329.63, 392], padGap: [3, 6] },
  menu: { hum: 45, humCutoff: 120, humVol: 0.035, airFreq: 260, airVol: 0.02, scale: [220, 261.63, 329.63, 392, 493.88], padGap: [3, 6] },
  // Part II: no machinery — wind, insects, dripping water, clay flutes and drums.
  jungle: { hum: 0, humCutoff: 100, humVol: 0, airFreq: 900, airVol: 0.03, scale: [293.66, 349.23, 392, 440, 523.25, 587.33], padGap: [4, 8], voice: 'flute', extras: ['insects', 'frogs', 'birds', 'drums'] },
  temple: { hum: 41, humType: 'sine', humCutoff: 90, humVol: 0.06, airFreq: 260, airVol: 0.03, scale: [220, 261.63, 293.66, 329.63, 392, 440], padGap: [4, 8], voice: 'flute', extras: ['drips', 'drums', 'creaks'] },
  sunlit: { hum: 49, humType: 'sine', humCutoff: 90, humVol: 0.04, airFreq: 600, airVol: 0.025, scale: [329.63, 392, 440, 493.88, 587.33, 659.25], padGap: [3, 7], voice: 'flute', extras: ['drips', 'birds'] },
  tomb: { hum: 33, humType: 'sine', humCutoff: 80, humVol: 0.08, airFreq: 180, airVol: 0.035, scale: [196, 233.08, 261.63, 293.66, 349.23], padGap: [5, 9], voice: 'flute', extras: ['drips', 'creaks', 'drums'] },
  sanctum: { hum: 36, humType: 'sine', humCutoff: 90, humVol: 0.06, airFreq: 300, airVol: 0.03, scale: [261.63, 293.66, 329.63, 392, 440, 523.25], padGap: [3, 6], voice: 'flute', extras: ['drips', 'drums'] },
};

/* ---------------------------------------------------------------------
   Procedural textures (canvas generated, cached for the whole session)
   --------------------------------------------------------------------- */
const FONT_DISPLAY = "'Orbitron', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif";
const FONT_BODY = "'Rajdhani', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif";

/* ---------------------------------------------------------------------
   Maya glyph painters (2D canvas), used by the temple textures, murals,
   dials and the offering icons in the HUD.
   --------------------------------------------------------------------- */
const FONT_TEMPLE = "'Cinzel', 'Trajan Pro', 'Palatino Linotype', Georgia, serif";

function pathRoundRect(x, x0, y0, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  x.beginPath();
  x.moveTo(x0 + r, y0);
  x.arcTo(x0 + w, y0, x0 + w, y0 + h, r);
  x.arcTo(x0 + w, y0 + h, x0, y0 + h, r);
  x.arcTo(x0, y0 + h, x0, y0, r);
  x.arcTo(x0, y0, x0 + w, y0, r);
  x.closePath();
}

// Paints one symbol centred on (cx, cy) in a box of size s, in a single colour.
// kind: 'num:N' (a bar-and-dot numeral, 0–19), a day-sign glyph
// (sun, moon, jaguar, serpent, ajaw, skull, tree, plus) or an offering
// silhouette (mask, disc, blade, feather, idol, gem, heart).
// Holes are punched with destination-out, so paint onto a transparent canvas.
function paintSymbol(x, kind, cx, cy, s, color) {
  x.save();
  x.fillStyle = color;
  x.strokeStyle = color;
  x.lineCap = 'round';
  x.lineJoin = 'round';
  const lw = (k) => { x.lineWidth = s * k; };
  const hole = (fn) => { x.save(); x.globalCompositeOperation = 'destination-out'; fn(); x.restore(); };
  const circle = (px, py, r, fill = true) => { x.beginPath(); x.arc(cx + px * s, cy + py * s, r * s, 0, TAU); if (fill) x.fill(); else x.stroke(); };
  const ellipse = (px, py, rx, ry, rot = 0, fill = true) => { x.beginPath(); x.ellipse(cx + px * s, cy + py * s, rx * s, ry * s, rot, 0, TAU); if (fill) x.fill(); else x.stroke(); };
  if (kind.startsWith('num:')) {
    const n = Number(kind.slice(4));
    if (n === 0) {
      // Zero is a shell.
      lw(0.055);
      ellipse(0, 0.02, 0.36, 0.22, 0, false);
      x.beginPath(); x.moveTo(cx - s * 0.3, cy + s * 0.02); x.quadraticCurveTo(cx, cy - s * 0.16, cx + s * 0.3, cy + s * 0.02); x.stroke();
      for (const k of [-0.15, 0, 0.15]) circle(k, 0.1, 0.035);
    } else {
      const bars = Math.floor(n / 5), dots = n % 5;
      const bw = s * 0.74, bh = s * 0.12, gap = s * 0.06, dr = s * 0.072;
      const total = bars * bh + (dots ? dr * 2 : 0) + Math.max(0, bars + (dots ? 1 : 0) - 1) * gap;
      let y = cy + total / 2;
      for (let i = 0; i < bars; i++) {
        pathRoundRect(x, cx - bw / 2, y - bh, bw, bh, bh * 0.4); x.fill();
        hole(() => { x.lineWidth = s * 0.012; x.beginPath(); x.moveTo(cx - bw * 0.36, y - bh / 2); x.lineTo(cx + bw * 0.36, y - bh / 2); x.stroke(); });
        y -= bh + gap;
      }
      if (dots) {
        const sp = s * 0.19;
        for (let i = 0; i < dots; i++) { x.beginPath(); x.arc(cx + (i - (dots - 1) / 2) * sp, y - dr, dr, 0, TAU); x.fill(); }
      }
    }
    x.restore();
    return;
  }
  switch (kind) {
    case 'sun': { // K'in: a four-petalled flower in a ring
      lw(0.05); circle(0, 0, 0.38, false);
      for (let k = 0; k < 4; k++) {
        const a = k * Math.PI / 2;
        ellipse(Math.sin(a) * 0.16, -Math.cos(a) * 0.16, 0.075, 0.13, a, true);
        circle(Math.sin(a + Math.PI / 4) * 0.29, -Math.cos(a + Math.PI / 4) * 0.29, 0.03);
      }
      circle(0, 0, 0.06);
      break;
    }
    case 'moon': {
      x.beginPath(); x.arc(cx, cy, s * 0.36, 0, TAU); x.fill();
      hole(() => { x.beginPath(); x.arc(cx + s * 0.16, cy - s * 0.08, s * 0.31, 0, TAU); x.fill(); });
      hole(() => { for (const [px, py] of [[-0.2, 0.05], [-0.12, 0.22], [-0.25, -0.13]]) { x.beginPath(); x.arc(cx + px * s, cy + py * s, s * 0.035, 0, TAU); x.fill(); } });
      break;
    }
    case 'jaguar': {
      lw(0.05);
      ellipse(0, 0.05, 0.31, 0.27, 0, false);
      circle(-0.22, -0.2, 0.08, false); circle(0.22, -0.2, 0.08, false);
      ellipse(-0.11, -0.01, 0.065, 0.045); ellipse(0.11, -0.01, 0.065, 0.045);
      x.beginPath(); x.moveTo(cx - s * 0.06, cy + s * 0.09); x.lineTo(cx + s * 0.06, cy + s * 0.09); x.lineTo(cx, cy + s * 0.15); x.closePath(); x.fill();
      x.beginPath(); x.arc(cx - s * 0.06, cy + s * 0.19, s * 0.06, 0, Math.PI); x.stroke();
      x.beginPath(); x.arc(cx + s * 0.06, cy + s * 0.19, s * 0.06, 0, Math.PI); x.stroke();
      lw(0.025);
      for (const [px, py] of [[-0.2, 0.17], [0.2, 0.17], [0, -0.14], [-0.24, 0.02], [0.24, 0.02]]) circle(px, py, 0.03, false);
      break;
    }
    case 'serpent': {
      lw(0.09);
      x.beginPath(); x.moveTo(cx - s * 0.32, cy + s * 0.32);
      x.bezierCurveTo(cx + s * 0.38, cy + s * 0.28, cx - s * 0.38, cy - s * 0.05, cx + s * 0.1, cy - s * 0.2);
      x.stroke();
      circle(0.18, -0.24, 0.12);
      hole(() => { x.beginPath(); x.arc(cx + s * 0.21, cy - s * 0.27, s * 0.035, 0, TAU); x.fill(); });
      lw(0.025);
      x.beginPath(); x.moveTo(cx + s * 0.28, cy - s * 0.2); x.lineTo(cx + s * 0.42, cy - s * 0.14); x.lineTo(cx + s * 0.45, cy - s * 0.2);
      x.moveTo(cx + s * 0.42, cy - s * 0.14); x.lineTo(cx + s * 0.44, cy - s * 0.07); x.stroke();
      for (let i = 0; i < 3; i++) { x.beginPath(); x.moveTo(cx - s * (0.36 + i * 0.03), cy + s * (0.24 + i * 0.05)); x.lineTo(cx - s * (0.26 + i * 0.03), cy + s * (0.36 + i * 0.05)); x.stroke(); }
      break;
    }
    case 'ajaw': { // a lord's face
      ellipse(0, 0, 0.3, 0.36);
      hole(() => {
        for (const px of [-0.12, 0.12]) { x.beginPath(); x.arc(cx + px * s, cy - s * 0.08, s * 0.06, 0, TAU); x.fill(); }
        x.beginPath(); x.arc(cx, cy + s * 0.16, s * 0.08, 0, TAU); x.fill();
      });
      break;
    }
    case 'skull': {
      ellipse(0, -0.06, 0.3, 0.27);
      x.fillRect(cx - s * 0.17, cy + s * 0.08, s * 0.34, s * 0.2);
      hole(() => {
        for (const px of [-0.12, 0.12]) { x.beginPath(); x.ellipse(cx + px * s, cy - s * 0.04, s * 0.08, s * 0.07, 0, 0, TAU); x.fill(); }
        x.beginPath(); x.moveTo(cx, cy + s * 0.04); x.lineTo(cx - s * 0.04, cy + s * 0.11); x.lineTo(cx + s * 0.04, cy + s * 0.11); x.fill();
        for (let i = -1; i <= 1; i++) x.fillRect(cx + i * s * 0.08 - s * 0.012, cy + s * 0.18, s * 0.024, s * 0.1);
      });
      break;
    }
    case 'tree': { // the world tree, a cross
      lw(0.09);
      x.beginPath(); x.moveTo(cx, cy + s * 0.4); x.lineTo(cx, cy - s * 0.38); x.moveTo(cx - s * 0.3, cy - s * 0.12); x.lineTo(cx + s * 0.3, cy - s * 0.12); x.stroke();
      circle(-0.32, -0.12, 0.07); circle(0.32, -0.12, 0.07); circle(0, -0.4, 0.07);
      lw(0.04);
      x.beginPath(); x.moveTo(cx - s * 0.2, cy + s * 0.4); x.quadraticCurveTo(cx, cy + s * 0.22, cx + s * 0.2, cy + s * 0.4); x.stroke();
      break;
    }
    case 'plus': {
      lw(0.1);
      x.beginPath(); x.moveTo(cx - s * 0.26, cy); x.lineTo(cx + s * 0.26, cy); x.moveTo(cx, cy - s * 0.26); x.lineTo(cx, cy + s * 0.26); x.stroke();
      break;
    }
    case 'mask': {
      ellipse(0, 0, 0.28, 0.36);
      lw(0.045); circle(-0.36, 0.02, 0.07, false); circle(0.36, 0.02, 0.07, false);
      hole(() => {
        for (const px of [-0.12, 0.12]) { x.beginPath(); x.ellipse(cx + px * s, cy - s * 0.06, s * 0.08, s * 0.03, 0, 0, TAU); x.fill(); }
        x.fillRect(cx - s * 0.1, cy + s * 0.16, s * 0.2, s * 0.05);
      });
      break;
    }
    case 'disc': {
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * TAU;
        x.beginPath();
        x.moveTo(cx + Math.cos(a - 0.17) * s * 0.28, cy + Math.sin(a - 0.17) * s * 0.28);
        x.lineTo(cx + Math.cos(a) * s * 0.45, cy + Math.sin(a) * s * 0.45);
        x.lineTo(cx + Math.cos(a + 0.17) * s * 0.28, cy + Math.sin(a + 0.17) * s * 0.28);
        x.fill();
      }
      circle(0, 0, 0.29);
      hole(() => { x.lineWidth = s * 0.035; x.beginPath(); x.arc(cx, cy, s * 0.18, 0, TAU); x.stroke(); });
      break;
    }
    case 'blade': {
      x.beginPath(); x.moveTo(cx, cy - s * 0.44);
      x.quadraticCurveTo(cx + s * 0.16, cy - s * 0.06, cx + s * 0.02, cy + s * 0.16);
      x.lineTo(cx - s * 0.02, cy + s * 0.16);
      x.quadraticCurveTo(cx - s * 0.16, cy - s * 0.06, cx, cy - s * 0.44); x.fill();
      x.fillRect(cx - s * 0.14, cy + s * 0.15, s * 0.28, s * 0.05);
      x.fillRect(cx - s * 0.04, cy + s * 0.2, s * 0.08, s * 0.22);
      hole(() => { x.lineWidth = s * 0.02; x.beginPath(); x.moveTo(cx, cy - s * 0.3); x.lineTo(cx, cy + s * 0.08); x.stroke(); });
      break;
    }
    case 'feather': {
      x.beginPath(); x.moveTo(cx - s * 0.1, cy + s * 0.44);
      x.quadraticCurveTo(cx + s * 0.32, cy + s * 0.05, cx + s * 0.12, cy - s * 0.44);
      x.quadraticCurveTo(cx - s * 0.28, cy - s * 0.05, cx - s * 0.1, cy + s * 0.44); x.fill();
      hole(() => {
        x.lineWidth = s * 0.025;
        x.beginPath(); x.moveTo(cx - s * 0.1, cy + s * 0.44); x.quadraticCurveTo(cx + s * 0.04, cy, cx + s * 0.1, cy - s * 0.38); x.stroke();
        x.lineWidth = s * 0.012;
        for (let i = 0; i < 6; i++) {
          const t = 0.15 + i * 0.12, px = cx + s * (-0.08 + t * 0.2), py = cy + s * (0.4 - t * 0.8);
          x.beginPath(); x.moveTo(px, py); x.lineTo(px - s * 0.13, py - s * 0.05); x.moveTo(px, py); x.lineTo(px + s * 0.13, py - s * 0.08); x.stroke();
        }
      });
      break;
    }
    case 'idol': {
      lw(0.08);
      for (let i = 0; i < 3; i++) ellipse(0, 0.26 - i * 0.15, 0.27 - i * 0.05, 0.08, 0, false);
      circle(0.04, -0.25, 0.12);
      hole(() => { x.beginPath(); x.arc(cx + s * 0.08, cy - s * 0.28, s * 0.03, 0, TAU); x.fill(); });
      break;
    }
    case 'gem': case 'heart': {
      x.beginPath();
      x.moveTo(cx, cy - s * 0.4); x.lineTo(cx + s * 0.3, cy - s * 0.12); x.lineTo(cx + s * 0.2, cy + s * 0.32);
      x.lineTo(cx - s * 0.2, cy + s * 0.32); x.lineTo(cx - s * 0.3, cy - s * 0.12); x.closePath(); x.fill();
      hole(() => {
        x.lineWidth = s * 0.025;
        x.beginPath(); x.moveTo(cx - s * 0.3, cy - s * 0.12); x.lineTo(cx + s * 0.3, cy - s * 0.12);
        x.moveTo(cx, cy - s * 0.4); x.lineTo(cx - s * 0.1, cy - s * 0.12); x.lineTo(cx, cy + s * 0.32);
        x.moveTo(cx, cy - s * 0.4); x.lineTo(cx + s * 0.1, cy - s * 0.12); x.lineTo(cx, cy + s * 0.32); x.stroke();
      });
      if (kind === 'heart') { lw(0.035); circle(0, -0.02, 0.44, false); }
      break;
    }
    default: break;
  }
  x.restore();
}

// A day-sign cartouche: a rounded frame on three little feet.
function paintCartouche(x, cx, cy, s, color) {
  x.save();
  x.strokeStyle = color; x.fillStyle = color;
  x.lineWidth = s * 0.045;
  pathRoundRect(x, cx - s * 0.44, cy - s * 0.44, s * 0.88, s * 0.8, s * 0.16);
  x.stroke();
  for (const k of [-0.24, 0, 0.24]) x.fillRect(cx + k * s - s * 0.07, cy + s * 0.37, s * 0.14, s * 0.08);
  x.restore();
}

// The Maya step-fret ("xicalcoliuhqui") band used to border murals.
function paintStepFret(x, x0, y0, w, h, color) {
  x.save();
  x.strokeStyle = color; x.lineWidth = h * 0.12; x.lineJoin = 'miter';
  const u = h;
  for (let px = x0; px < x0 + w; px += u * 1.6) {
    x.beginPath();
    x.moveTo(px, y0 + h * 0.9);
    x.lineTo(px, y0 + h * 0.5); x.lineTo(px + u * 0.4, y0 + h * 0.5); x.lineTo(px + u * 0.4, y0 + h * 0.15);
    x.lineTo(px + u * 0.9, y0 + h * 0.15); x.lineTo(px + u * 0.9, y0 + h * 0.62); x.lineTo(px + u * 0.62, y0 + h * 0.62);
    x.stroke();
  }
  x.restore();
}

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
  /* ---- Part II: temple textures -------------------------------------- */
  // Dressed limestone courses with weathering. Returns { map, bump, canvas }.
  stone(key = 'limestone', { base = [186, 172, 144], mortar = '#3e3628', rows = 8, moss = 0, seed = 31, streaks = 0.5 } = {}) {
    return this.cached('stone:' + key, () => {
      const S = 512, c = this.canvas(S), x = c.getContext('2d');
      const B = 256, b = this.canvas(B), bx = b.getContext('2d');
      const rnd = mulberry32(seed);
      x.fillStyle = mortar; x.fillRect(0, 0, S, S);
      bx.fillStyle = '#1e1e1e'; bx.fillRect(0, 0, B, B);
      const rh = S / rows;
      for (let r = 0; r < rows; r++) {
        const n = 2 + Math.floor(rnd() * 3);
        const ws = Array.from({ length: n }, () => 0.6 + rnd());
        const sum = ws.reduce((a, v) => a + v, 0);
        let px = rnd() * S;
        for (const wv of ws) {
          const w = (wv / sum) * S;
          const k = (rnd() - 0.5) * 30, warm = (rnd() - 0.5) * 12;
          const col = `rgb(${base[0] + k + warm | 0},${base[1] + k | 0},${base[2] + k - warm | 0})`;
          const hb = 200 + (rnd() - 0.5) * 50;
          for (const ox of [0, -S]) {
            const X0 = px + ox;
            if (X0 + w < 0 || X0 > S) continue;
            const y0 = r * rh;
            x.fillStyle = col;
            pathRoundRect(x, X0 + 2.5, y0 + 2.5, w - 5, rh - 5, 5); x.fill();
            const g = x.createLinearGradient(0, y0, 0, y0 + rh);
            g.addColorStop(0, 'rgba(255,240,210,0.14)'); g.addColorStop(0.18, 'rgba(0,0,0,0)');
            g.addColorStop(0.75, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.28)');
            x.fillStyle = g; x.fillRect(X0 + 2, y0 + 2, w - 4, rh - 4);
            const g2 = x.createLinearGradient(X0, 0, X0 + w, 0);
            g2.addColorStop(0, 'rgba(0,0,0,0.16)'); g2.addColorStop(0.06, 'rgba(0,0,0,0)');
            g2.addColorStop(0.94, 'rgba(0,0,0,0)'); g2.addColorStop(1, 'rgba(0,0,0,0.2)');
            x.fillStyle = g2; x.fillRect(X0 + 2, y0 + 2, w - 4, rh - 4);
            bx.fillStyle = `rgb(${hb | 0},${hb | 0},${hb | 0})`;
            pathRoundRect(bx, (X0 + 2.5) / 2, (y0 + 2.5) / 2, (w - 5) / 2, (rh - 5) / 2, 3); bx.fill();
          }
          px = (px + w) % S;
        }
      }
      this.paintNoise(x, S, [8, 32, 128], 0.1, seed + 1);
      this.paintNoise(bx, B, [16, 64, 128], 0.22, seed + 2);
      // Chips, pits and water streaks.
      for (let i = 0; i < 900; i++) {
        const px = rnd() * S, py = rnd() * S, r = 0.6 + rnd() * 2.2;
        x.fillStyle = rnd() < 0.6 ? 'rgba(30,24,16,0.35)' : 'rgba(255,245,225,0.18)';
        x.beginPath(); x.arc(px, py, r, 0, TAU); x.fill();
        bx.fillStyle = 'rgba(0,0,0,0.5)'; bx.beginPath(); bx.arc(px / 2, py / 2, r / 2, 0, TAU); bx.fill();
      }
      for (let i = 0; i < 40 * streaks; i++) {
        const px = rnd() * S, py = rnd() * S, len = 30 + rnd() * 120;
        const g = x.createLinearGradient(0, py, 0, py + len);
        g.addColorStop(0, 'rgba(40,34,24,0.22)'); g.addColorStop(1, 'rgba(40,34,24,0)');
        x.fillStyle = g; x.fillRect(px, py, 2 + rnd() * 5, len);
      }
      if (moss > 0) {
        for (let i = 0; i < 70 * moss; i++) {
          const px = rnd() * S, py = rnd() * S, r = 10 + rnd() * 46;
          const g = x.createRadialGradient(px, py, 0, px, py, r);
          g.addColorStop(0, `rgba(${60 + rnd() * 30 | 0},${96 + rnd() * 40 | 0},${40 + rnd() * 20 | 0},0.5)`);
          g.addColorStop(1, 'rgba(60,100,40,0)');
          x.fillStyle = g;
          for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) { x.beginPath(); x.arc(px + ox, py + oy, r, 0, TAU); x.fill(); }
        }
      }
      return { map: this.finish(c), bump: this.finish(b, { srgb: false }), canvas: c };
    });
  }
  // Floor flagstones.
  paving(key = 'paving', { base = [160, 150, 128], gap = '#2a241a', seed = 47, moss = 0 } = {}) {
    return this.cached('pave:' + key, () => {
      const S = 512, c = this.canvas(S), x = c.getContext('2d');
      const B = 256, b = this.canvas(B), bx = b.getContext('2d');
      const rnd = mulberry32(seed);
      x.fillStyle = gap; x.fillRect(0, 0, S, S);
      bx.fillStyle = '#101010'; bx.fillRect(0, 0, B, B);
      const rows = 4, rh = S / rows;
      for (let r = 0; r < rows; r++) {
        const n = 2 + Math.floor(rnd() * 2);
        const ws = Array.from({ length: n }, () => 0.7 + rnd() * 0.8);
        const sum = ws.reduce((a, v) => a + v, 0);
        let px = rnd() * S;
        for (const wv of ws) {
          const w = (wv / sum) * S;
          const k = (rnd() - 0.5) * 34;
          const col = `rgb(${base[0] + k | 0},${base[1] + k | 0},${base[2] + k * 0.8 | 0})`;
          for (const ox of [0, -S]) {
            const X0 = px + ox;
            if (X0 + w < 0 || X0 > S) continue;
            x.fillStyle = col;
            pathRoundRect(x, X0 + 4, r * rh + 4, w - 8, rh - 8, 10); x.fill();
            const g = x.createRadialGradient(X0 + w / 2, r * rh + rh / 2, 10, X0 + w / 2, r * rh + rh / 2, Math.max(w, rh) * 0.7);
            g.addColorStop(0, 'rgba(255,250,235,0.06)'); g.addColorStop(1, 'rgba(0,0,0,0.25)');
            x.fillStyle = g; x.fillRect(X0 + 4, r * rh + 4, w - 8, rh - 8);
            bx.fillStyle = `rgb(${210 + k | 0},${210 + k | 0},${210 + k | 0})`;
            pathRoundRect(bx, (X0 + 4) / 2, (r * rh + 4) / 2, (w - 8) / 2, (rh - 8) / 2, 5); bx.fill();
          }
          px = (px + w) % S;
        }
      }
      this.paintNoise(x, S, [16, 64, 256], 0.12, seed + 3);
      this.paintNoise(bx, B, [32, 128], 0.2, seed + 4);
      // Cracks.
      x.strokeStyle = 'rgba(25,20,12,0.55)'; x.lineWidth = 1.5;
      bx.strokeStyle = 'rgba(0,0,0,0.8)'; bx.lineWidth = 1;
      for (let i = 0; i < 14; i++) {
        let px = rnd() * S, py = rnd() * S;
        x.beginPath(); x.moveTo(px, py); bx.beginPath(); bx.moveTo(px / 2, py / 2);
        for (let j = 0; j < 5; j++) { px += (rnd() - 0.5) * 50; py += (rnd() - 0.5) * 50; x.lineTo(px, py); bx.lineTo(px / 2, py / 2); }
        x.stroke(); bx.stroke();
      }
      if (moss > 0) {
        for (let i = 0; i < 50 * moss; i++) {
          const px = rnd() * S, py = rnd() * S, r = 8 + rnd() * 30;
          const g = x.createRadialGradient(px, py, 0, px, py, r);
          g.addColorStop(0, 'rgba(58,92,38,0.55)'); g.addColorStop(1, 'rgba(58,92,38,0)');
          x.fillStyle = g; x.beginPath(); x.arc(px, py, r, 0, TAU); x.fill();
        }
      }
      return { map: this.finish(c), bump: this.finish(b, { srgb: false }) };
    });
  }
  // Glyph blocks: a wall of carved cartouches (4 × 4 per tile).
  carvedWall(key = 'carved', { base = [178, 162, 132], seed = 61 } = {}) {
    return this.cached('carvedWall:' + key, () => {
      const S = 512, c = this.canvas(S), x = c.getContext('2d');
      const B = 256, b = this.canvas(B), bx = b.getContext('2d');
      const stone = this.stone('limestone').canvas;
      x.drawImage(stone, 0, 0);
      x.fillStyle = `rgba(${base[0]},${base[1]},${base[2]},0.35)`; x.fillRect(0, 0, S, S);
      bx.fillStyle = '#c8c8c8'; bx.fillRect(0, 0, B, B);
      const rnd = mulberry32(seed);
      const kinds = ['sun', 'moon', 'jaguar', 'serpent', 'ajaw', 'num:7', 'num:13', 'tree', 'num:4', 'skull', 'num:9', 'feather'];
      const T = S / 4;
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
        const cx = i * T + T / 2, cy = j * T + T / 2;
        x.strokeStyle = 'rgba(40,30,18,0.7)'; x.lineWidth = 3;
        x.strokeRect(i * T + 2, j * T + 2, T - 4, T - 4);
        bx.strokeStyle = '#303030'; bx.lineWidth = 2; bx.strokeRect(i * T / 2 + 1, j * T / 2 + 1, T / 2 - 2, T / 2 - 2);
        const kind = kinds[Math.floor(rnd() * kinds.length)];
        this.carveInto(x, 'cart', cx, cy, T * 0.9);
        this.carveInto(x, kind, cx, cy - T * 0.03, T * 0.62);
        bx.drawImage(this.glyphCanvas(kind, '#000', 128), (cx - T * 0.31) / 2, (cy - T * 0.34) / 2, T * 0.31, T * 0.31);
        bx.globalAlpha = 0.8; bx.drawImage(this.glyphCanvas('cart', '#000', 128), (cx - T * 0.45) / 2, (cy - T * 0.45) / 2, T * 0.45, T * 0.45); bx.globalAlpha = 1;
      }
      return { map: this.finish(c), bump: this.finish(b, { srgb: false }) };
    });
  }
  // Painted stucco, flaking to the stone beneath.
  stucco(key, color = [138, 40, 28], seed = 71) {
    return this.cached('stucco:' + key, () => {
      const S = 512, c = this.canvas(S), x = c.getContext('2d');
      const stone = this.stone('limestone').canvas;
      x.drawImage(stone, 0, 0);
      const p = this.canvas(S), px = p.getContext('2d');
      px.fillStyle = `rgb(${color[0]},${color[1]},${color[2]})`; px.fillRect(0, 0, S, S);
      this.paintNoise(px, S, [8, 32, 128], 0.12, seed);
      const rnd = mulberry32(seed + 1);
      px.globalCompositeOperation = 'destination-out';
      for (let i = 0; i < 60; i++) {
        const cx = rnd() * S, cy = rnd() * S, r = 6 + rnd() * 30;
        px.beginPath();
        for (let k = 0; k < 9; k++) { const a = (k / 9) * TAU, rr = r * (0.5 + rnd() * 0.7); px.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); }
        px.fill();
      }
      x.drawImage(p, 0, 0);
      return this.finish(c);
    });
  }
  earth() {
    return this.cached('earth', () => {
      const S = 512, c = this.canvas(S), x = c.getContext('2d');
      x.fillStyle = '#3a3122'; x.fillRect(0, 0, S, S);
      this.paintNoise(x, S, [8, 32, 128, 256], 0.18, 81);
      const rnd = mulberry32(82);
      // Leaf litter, batched into a few colours to keep generation fast.
      const cols = ['rgba(118,84,28,0.6)', 'rgba(96,70,26,0.6)', 'rgba(54,92,34,0.55)', 'rgba(62,104,40,0.55)'];
      for (const col of cols) {
        x.fillStyle = col;
        x.beginPath();
        for (let i = 0; i < 175; i++) {
          const px = rnd() * S, py = rnd() * S, a = rnd() * TAU, l = 4 + rnd() * 9;
          x.moveTo(px + Math.cos(a) * l, py + Math.sin(a) * l);
          x.ellipse(px, py, l, l * 0.4, a, 0, TAU);
        }
        x.fill();
      }
      return this.finish(c);
    });
  }
  bark() {
    return this.cached('bark', () => {
      const S = 256, c = this.canvas(S), x = c.getContext('2d');
      x.fillStyle = '#6f6556'; x.fillRect(0, 0, S, S);
      const rnd = mulberry32(91);
      for (let i = 0; i < 160; i++) {
        const px = rnd() * S, w = 1 + rnd() * 4, v = 60 + rnd() * 80;
        x.fillStyle = `rgba(${v},${v * 0.9 | 0},${v * 0.75 | 0},0.45)`;
        x.fillRect(px, 0, w, S);
      }
      this.paintNoise(x, S, [16, 64], 0.12, 92);
      return this.finish(c);
    });
  }
  // Alpha-cut foliage cards: 'broad' (banana/monstera), 'fern', 'canopy', 'vine', 'grass'.
  leaf(kind) {
    return this.cached('leaf:' + kind, () => {
      const W = kind === 'vine' ? 128 : 256, H = kind === 'vine' ? 512 : 256;
      const c = this.canvas(W, H), x = c.getContext('2d');
      const rnd = mulberry32(kind.length * 97 + 5);
      const green = (k = 0) => `rgb(${40 + rnd() * 30 + k | 0},${78 + rnd() * 50 + k | 0},${30 + rnd() * 22 | 0})`;
      const leafShape = (bx, by, ang, len, wid, col, veins = true) => {
        x.save(); x.translate(bx, by); x.rotate(ang);
        const g = x.createLinearGradient(0, 0, 0, -len);
        g.addColorStop(0, col); g.addColorStop(1, 'rgb(96,150,70)');
        x.fillStyle = g;
        x.beginPath(); x.moveTo(0, 0);
        x.quadraticCurveTo(wid, -len * 0.35, 0, -len);
        x.quadraticCurveTo(-wid, -len * 0.35, 0, 0); x.fill();
        if (veins) {
          x.strokeStyle = 'rgba(190,230,150,0.55)'; x.lineWidth = 1.6;
          x.beginPath(); x.moveTo(0, 0); x.lineTo(0, -len * 0.96); x.stroke();
          x.strokeStyle = 'rgba(20,40,14,0.4)'; x.lineWidth = 1;
          for (let t = 0.15; t < 0.9; t += 0.09) {
            x.beginPath(); x.moveTo(0, -len * t); x.lineTo(wid * 0.55, -len * (t + 0.07)); x.moveTo(0, -len * t); x.lineTo(-wid * 0.55, -len * (t + 0.07)); x.stroke();
          }
        }
        x.restore();
      };
      if (kind === 'broad') {
        for (let i = 0; i < 6; i++) leafShape(W / 2, H - 4, -1.15 + (i / 5) * 2.3 + (rnd() - 0.5) * 0.2, 150 + rnd() * 80, 38 + rnd() * 22, green());
      } else if (kind === 'fern') {
        for (let i = 0; i < 7; i++) {
          const ang = -1.2 + (i / 6) * 2.4, len = 140 + rnd() * 90;
          x.save(); x.translate(W / 2, H - 4); x.rotate(ang);
          x.strokeStyle = 'rgb(60,96,40)'; x.lineWidth = 2;
          x.beginPath(); x.moveTo(0, 0); x.quadraticCurveTo(10, -len * 0.5, 0, -len); x.stroke();
          for (let t = 0.12; t < 0.98; t += 0.06) {
            const l = 26 * (1 - t) + 6;
            for (const sd of [-1, 1]) leafShape(0, -len * t, sd * 1.25, l, 5, green(), false);
          }
          x.restore();
        }
      } else if (kind === 'canopy') {
        for (let i = 0; i < 70; i++) {
          const a = rnd() * TAU, r = Math.sqrt(rnd()) * 110;
          leafShape(W / 2 + Math.cos(a) * r, H / 2 + Math.sin(a) * r, rnd() * TAU, 28 + rnd() * 28, 12 + rnd() * 8, green(-10), false);
        }
      } else if (kind === 'vine') {
        x.strokeStyle = 'rgb(70,84,44)'; x.lineWidth = 3;
        x.beginPath(); x.moveTo(W / 2, 0);
        for (let y = 0; y <= H; y += 16) x.lineTo(W / 2 + Math.sin(y * 0.03) * 18, y);
        x.stroke();
        for (let y = 10; y < H - 6; y += 13 + rnd() * 10) {
          const px = W / 2 + Math.sin(y * 0.03) * 18, sd = rnd() < 0.5 ? -1 : 1;
          leafShape(px, y, sd * (1.6 + rnd() * 0.6) + Math.PI, 22 + rnd() * 18, 11, green(), false);
        }
      } else if (kind === 'grass') {
        for (let i = 0; i < 40; i++) {
          const bx = W / 2 + (rnd() - 0.5) * 140, h = 80 + rnd() * 150, lean = (rnd() - 0.5) * 70;
          x.strokeStyle = green(); x.lineWidth = 3 + rnd() * 3;
          x.beginPath(); x.moveTo(bx, H); x.quadraticCurveTo(bx + lean * 0.3, H - h * 0.6, bx + lean, H - h); x.stroke();
        }
      }
      return this.finish(c, { repeat: false });
    });
  }
  flame() {
    return this.cached('flame', () => {
      const W = 64, H = 128, c = this.canvas(W, H), x = c.getContext('2d');
      x.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 26; i++) {
        const t = i / 25, cy = H - 18 - t * (H - 30), r = (1 - t) * 22 + 4;
        const g = x.createRadialGradient(W / 2, cy, 0, W / 2, cy, r);
        g.addColorStop(0, `rgba(255,${200 - t * 120 | 0},${120 - t * 100 | 0},${0.22 * (1 - t * 0.6)})`);
        g.addColorStop(1, 'rgba(255,80,0,0)');
        x.fillStyle = g; x.beginPath(); x.arc(W / 2, cy, r, 0, TAU); x.fill();
      }
      return this.finish(c, { repeat: false });
    });
  }
  // Vertical fade for light columns and sun shafts.
  beamFade() {
    return this.cached('beamFade', () => {
      const c = this.canvas(16, 256), x = c.getContext('2d');
      const g = x.createLinearGradient(0, 0, 0, 256);
      g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.3, 'rgba(255,255,255,0.55)');
      g.addColorStop(0.85, 'rgba(255,255,255,1)'); g.addColorStop(1, 'rgba(255,255,255,0.4)');
      x.fillStyle = g; x.fillRect(0, 0, 16, 256);
      return this.finish(c, { repeat: false });
    });
  }
  spikePlate() {
    return this.cached('spikePlate', () => {
      const S = 256, c = this.canvas(S), x = c.getContext('2d');
      const b = this.canvas(128), bx = b.getContext('2d');
      x.fillStyle = '#4a4236'; x.fillRect(0, 0, S, S);
      this.paintNoise(x, S, [16, 64], 0.15, 101);
      bx.fillStyle = '#c0c0c0'; bx.fillRect(0, 0, 128, 128);
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
        const cx = (i + 0.5) * 64, cy = (j + 0.5) * 64;
        const g = x.createRadialGradient(cx, cy, 2, cx, cy, 18);
        g.addColorStop(0, '#050403'); g.addColorStop(0.6, '#1a1610'); g.addColorStop(1, 'rgba(26,22,16,0)');
        x.fillStyle = g; x.beginPath(); x.arc(cx, cy, 18, 0, TAU); x.fill();
        bx.fillStyle = '#000'; bx.beginPath(); bx.arc(cx / 2, cy / 2, 6, 0, TAU); bx.fill();
      }
      return { map: this.finish(c), bump: this.finish(b, { srgb: false }) };
    });
  }
  featherCard() {
    return this.cached('featherCard', () => {
      const W = 128, H = 384, c = this.canvas(W, H), x = c.getContext('2d');
      const g = x.createLinearGradient(0, H, 0, 0);
      g.addColorStop(0, '#1d8a5a'); g.addColorStop(0.55, '#21c49a'); g.addColorStop(1, '#2a6cff');
      x.fillStyle = g;
      x.beginPath(); x.moveTo(W / 2, H - 6);
      x.quadraticCurveTo(W + 6, H * 0.45, W / 2, 6);
      x.quadraticCurveTo(-6, H * 0.45, W / 2, H - 6); x.fill();
      x.strokeStyle = 'rgba(255,240,180,0.9)'; x.lineWidth = 3;
      x.beginPath(); x.moveTo(W / 2, H - 6); x.lineTo(W / 2, 20); x.stroke();
      x.strokeStyle = 'rgba(0,30,20,0.35)'; x.lineWidth = 1.2;
      for (let y = 30; y < H - 20; y += 7) { x.beginPath(); x.moveTo(W / 2, y + 10); x.lineTo(8, y); x.moveTo(W / 2, y + 10); x.lineTo(W - 8, y); x.stroke(); }
      const e = x.createRadialGradient(W / 2, 70, 2, W / 2, 70, 26);
      e.addColorStop(0, '#ffe680'); e.addColorStop(0.5, '#1a3cff'); e.addColorStop(1, 'rgba(20,40,255,0)');
      x.fillStyle = e; x.beginPath(); x.arc(W / 2, 70, 26, 0, TAU); x.fill();
      return this.finish(c, { repeat: false });
    });
  }
  // A transparent canvas with one symbol, cached.
  glyphCanvas(kind, color = '#ffffff', size = 256) {
    const key = `gc:${kind}:${color}:${size}`;
    if (!this.cache.has(key)) {
      const c = this.canvas(size), x = c.getContext('2d');
      if (kind === 'cart') paintCartouche(x, size / 2, size / 2, size, color);
      else paintSymbol(x, kind, size / 2, size / 2, size, color);
      this.cache.set(key, c);
    }
    return this.cache.get(key);
  }
  glyphTex(kind, color = '#ffffff') {
    return this.cached(`gt:${kind}:${color}`, () => this.finish(this.glyphCanvas(kind, color), { repeat: false }));
  }
  // Draw a symbol so it looks cut into stone: shadow, highlight, then the recess.
  carveInto(x, kind, cx, cy, s, { deep = 'rgba(28,20,10,0.85)', light = 'rgba(255,244,220,0.5)', mid = 'rgba(70,54,34,0.9)' } = {}) {
    const d = Math.max(1, s * 0.014);
    x.drawImage(this.glyphCanvas(kind, light), cx - s / 2 + d, cy - s / 2 + d, s, s);
    x.drawImage(this.glyphCanvas(kind, deep), cx - s / 2 - d, cy - s / 2 - d, s, s);
    x.drawImage(this.glyphCanvas(kind, mid), cx - s / 2, cy - s / 2, s, s);
  }
  // Texture strip for a rotating glyph dial: one cell per face.
  dialStrip(faces) {
    return this.cached('dial:' + faces.join(','), () => {
      const N = faces.length, W = 256, H = 256;
      const c = this.canvas(W * N, H), x = c.getContext('2d');
      const e = this.canvas(W * N, H), ex = e.getContext('2d');
      const stone = this.stone('limestone').canvas;
      ex.fillStyle = '#000'; ex.fillRect(0, 0, W * N, H);
      faces.forEach((f, i) => {
        x.drawImage(stone, (i * 97) % 256, 0, 256, 256, i * W, 0, W, H);
        x.fillStyle = 'rgba(0,0,0,0.4)'; x.fillRect(i * W, 0, 7, H); x.fillRect(i * W + W - 7, 0, 7, H);
        x.fillStyle = 'rgba(255,240,210,0.12)'; x.fillRect(i * W + 7, 0, 4, H);
        const cx = i * W + W / 2;
        this.carveInto(x, 'cart', cx, H / 2, 230);
        this.carveInto(x, f, cx, H / 2 - 6, 168, { mid: 'rgba(60,40,22,0.95)' });
        ex.drawImage(this.glyphCanvas(f, '#ffffff'), cx - 84, H / 2 - 6 - 84, 168, 168);
      });
      return { map: this.finish(c, { repeat: false }), em: this.finish(e, { repeat: false }) };
    });
  }
  // Top face of a counting-floor tile: a flagstone with a carved numeral.
  tileFace(kind) {
    return this.cached('tile:' + kind, () => {
      const S = 256, c = this.canvas(S), x = c.getContext('2d');
      const e = this.canvas(S), ex = e.getContext('2d');
      const stone = this.stone('limestone').canvas;
      x.drawImage(stone, 40, 64, 256, 256, 0, 0, S, S);
      x.fillStyle = 'rgba(40,32,20,0.25)'; x.fillRect(0, 0, S, S);
      x.strokeStyle = 'rgba(20,14,8,0.7)'; x.lineWidth = 10; x.strokeRect(5, 5, S - 10, S - 10);
      x.strokeStyle = 'rgba(255,240,210,0.2)'; x.lineWidth = 3; x.strokeRect(13, 13, S - 26, S - 26);
      ex.fillStyle = '#000'; ex.fillRect(0, 0, S, S);
      ex.strokeStyle = '#555'; ex.lineWidth = 6; ex.strokeRect(14, 14, S - 28, S - 28);
      this.carveInto(x, kind, S / 2, S / 2, 190);
      ex.drawImage(this.glyphCanvas(kind, '#ffffff'), S / 2 - 95, S / 2 - 95, 190, 190);
      return { map: this.finish(c, { repeat: false }), em: this.finish(e, { repeat: false }) };
    });
  }
  // A painted mural (not cached): stucco ground, step-fret border, then draw(x, w, h).
  mural(w, h, draw, { bg = '#8a2a1c', ink = '#1d120a', border = '#e8c27a' } = {}) {
    const c = this.canvas(w, h), x = c.getContext('2d');
    x.fillStyle = bg; x.fillRect(0, 0, w, h);
    const rnd = mulberry32(w * 7 + h);
    for (let i = 0; i < 1800; i++) {
      x.fillStyle = rnd() < 0.5 ? 'rgba(0,0,0,0.06)' : 'rgba(255,240,210,0.05)';
      x.fillRect(rnd() * w, rnd() * h, 2 + rnd() * 6, 2 + rnd() * 6);
    }
    const bh = Math.min(w, h) * 0.07;
    x.fillStyle = 'rgba(0,0,0,0.25)'; x.fillRect(0, 0, w, bh * 1.2); x.fillRect(0, h - bh * 1.2, w, bh * 1.2);
    paintStepFret(x, bh * 0.2, bh * 0.1, w, bh, border);
    paintStepFret(x, bh * 0.2, h - bh * 1.1, w, bh, border);
    x.fillStyle = ink; x.strokeStyle = ink;
    draw(x, w, h, bh * 1.2);
    // Flaking.
    x.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 26; i++) {
      const cx = rnd() * w, cy = rnd() * h, r = 4 + rnd() * 16;
      x.globalAlpha = 0.35 + rnd() * 0.4;
      x.beginPath(); x.arc(cx, cy, r, 0, TAU); x.fill();
    }
    x.globalAlpha = 1; x.globalCompositeOperation = 'source-over';
    return this.finish(c, { repeat: false });
  }
  // Small offering icon for the HUD tray.
  relicIcon(kind, color) {
    return this.cached(`icon:${kind}:${color}`, () => {
      const c = this.canvas(96), x = c.getContext('2d');
      x.shadowColor = color; x.shadowBlur = 10;
      x.drawImage(this.glyphCanvas(RELIC_INFO[kind].glyph || kind, color, 96), 0, 0);
      return c.toDataURL();
    });
  }
  // One-off text texture for signs and screens (not cached).
  text(lines, { w = 512, h = 256, bg = 'rgba(6,10,18,0.92)', color = '#4fd8ff', font = FONT_DISPLAY, font2 = FONT_BODY, size = 48, weight = 700, border = true, align = 'center', glow = true } = {}) {
    const c = this.canvas(w, h), x = c.getContext('2d');
    this.drawText(x, c, lines, { w, h, bg, color, font, font2, size, weight, border, align, glow });
    const t = this.finish(c, { repeat: false });
    t.userData.redraw = (newLines, opts = {}) => {
      this.drawText(x, c, newLines, { w, h, bg, color, font, font2, size, weight, border, align, glow, ...opts });
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
      x.font = `${i === 0 ? o.weight : 500} ${sz}px ${i === 0 ? o.font : o.font2 || FONT_BODY}`;
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

// Part II material palette, built the first time a temple level loads and
// then shared by all temple levels.
function templeMaterials(game) {
  if (game.T) return game.T;
  const tex = game.tex;
  const std = (o) => new THREE.MeshStandardMaterial(o);
  const lime = tex.stone('limestone');
  const moss = tex.stone('mossy', { base: [150, 150, 118], moss: 1.2, seed: 33 });
  const dark = tex.stone('darkstone', { base: [104, 96, 84], mortar: '#1c1812', seed: 35, streaks: 1 });
  const pave = tex.paving('paving');
  const paveMoss = tex.paving('pavingMoss', { moss: 1, seed: 49 });
  const carved = tex.carvedWall('carved');
  const sp = tex.spikePlate();
  const T = {};
  T.stone = std({ color: 0xece0c8, map: lime.map, bumpMap: lime.bump, bumpScale: 2.2, roughness: 0.93, metalness: 0 });
  T.mossy = std({ color: 0xdfe2cc, map: moss.map, bumpMap: moss.bump, bumpScale: 2.2, roughness: 0.95, metalness: 0 });
  T.dark = std({ color: 0xc0b8a8, map: dark.map, bumpMap: dark.bump, bumpScale: 2.4, roughness: 0.9, metalness: 0 });
  T.floor = std({ color: 0xe6dcc6, map: pave.map, bumpMap: pave.bump, bumpScale: 2, roughness: 0.86, metalness: 0 });
  T.floorMoss = std({ color: 0xd8dcc8, map: paveMoss.map, bumpMap: paveMoss.bump, bumpScale: 2, roughness: 0.9, metalness: 0 });
  T.carved = std({ color: 0xf2e6ce, map: carved.map, bumpMap: carved.bump, bumpScale: 3.2, roughness: 0.9, metalness: 0 });
  T.red = std({ color: 0xffffff, map: tex.stucco('red'), bumpMap: lime.bump, bumpScale: 1.4, roughness: 0.82, metalness: 0 });
  T.teal = std({ color: 0xffffff, map: tex.stucco('teal', [36, 102, 96], 73), bumpMap: lime.bump, bumpScale: 1.4, roughness: 0.82, metalness: 0 });
  T.ochre = std({ color: 0xffffff, map: tex.stucco('ochre', [196, 148, 70], 75), bumpMap: lime.bump, bumpScale: 1.4, roughness: 0.85, metalness: 0 });
  T.earth = std({ color: 0xa09684, map: tex.earth(), roughness: 1, metalness: 0 });
  T.bark = std({ color: 0xa09482, map: tex.bark(), roughness: 0.95, metalness: 0 });
  T.wood = std({ color: 0x7a5636, map: tex.bark(), roughness: 0.8, metalness: 0 });
  T.jade = std({ color: 0x33b47a, roughness: 0.22, metalness: 0.1, emissive: 0x0e5232, emissiveIntensity: 0.7 });
  T.gold = std({ color: 0xffc860, roughness: 0.28, metalness: 1, emissive: 0x3a2400, emissiveIntensity: 0.6 });
  T.bronze = std({ color: 0xb8803c, roughness: 0.35, metalness: 0.9 });
  T.mirror = std({ color: 0xffdca8, roughness: 0.06, metalness: 1, emissive: 0x5a3410, emissiveIntensity: 0.7 });
  T.obsidian = std({ color: 0x100e16, roughness: 0.08, metalness: 0.5 });
  T.bone = std({ color: 0xe6dcc4, roughness: 0.7, metalness: 0 });
  T.jasper = std({ color: 0xc23a20, roughness: 0.32, metalness: 0.1, emissive: 0x420a00, emissiveIntensity: 0.5 });
  T.spikePlate = std({ color: 0xd0c8b8, map: sp.map, bumpMap: sp.bump, bumpScale: 3, roughness: 0.85, metalness: 0.1 });
  T.void = new THREE.MeshBasicMaterial({ color: 0x000000 });
  // Invisible pick volumes; double-sided so they work even from inside.
  T.pick = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  const leaf = (kind, color) => std({ map: tex.leaf(kind), color, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.78, metalness: 0 });
  T.leaf = {
    broad: leaf('broad', 0xd4ecc0), fern: leaf('fern', 0xd4ecc0), canopy: leaf('canopy', 0xc0dca8),
    vine: leaf('vine', 0xd4e8c0), grass: leaf('grass', 0xc8e0b0),
  };
  const add = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide };
  T.flameOuter = new THREE.MeshBasicMaterial({ map: tex.flame(), color: new THREE.Color(2.4, 1.15, 0.4), ...add });
  T.flameInner = new THREE.MeshBasicMaterial({ map: tex.flame(), color: new THREE.Color(2.6, 2.0, 1.1), ...add });
  // Fire columns are large, so they burn at a gentler brightness.
  T.jetOuter = new THREE.MeshBasicMaterial({ map: tex.flame(), color: new THREE.Color(1.15, 0.45, 0.12), ...add });
  T.jetInner = new THREE.MeshBasicMaterial({ map: tex.flame(), color: new THREE.Color(1.1, 0.75, 0.3), ...add });
  T.blade = std({ color: 0xf0dcb8, roughness: 0.3, metalness: 0.7, emissive: 0x8a5a2a, emissiveIntensity: 0.75 });
  T.coals = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 0.75, 0.2) });
  T.feather = std({ map: tex.featherCard(), alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.4, emissive: 0xffffff, emissiveMap: tex.featherCard(), emissiveIntensity: 0.28 });
  game.T = T;
  return T;
}

// Warm reflections for the temple: torchlight and sun instead of light panels.
function buildTempleEnvironment(renderer) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = new THREE.Scene();
  env.add(new THREE.Mesh(new THREE.BoxGeometry(20, 10, 20), new THREE.MeshBasicMaterial({ color: 0x1c1610, side: THREE.BackSide })));
  const panel = (x, y, z, w, h, d, c, k) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(k) }));
    m.position.set(x, y, z); env.add(m);
  };
  panel(0, 4.9, 0, 3, 0.1, 3, 0xfff0d0, 5);
  panel(-9.9, 1.5, -4, 0.1, 1.2, 1, 0xff9a40, 4);
  panel(9.9, 1.5, 4, 0.1, 1.2, 1, 0xff9a40, 4);
  panel(0, 1.5, -9.9, 1, 1.2, 0.1, 0xff8a30, 3);
  panel(0, -4.9, 0, 20, 0.1, 20, 0x3a3020, 1);
  const rt = pmrem.fromScene(env, 0.04);
  pmrem.dispose();
  return rt.texture;
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
  constructor(level, { min, max, slide, mat = null, label = null, interactive = false, onOpen = null, glyph = null, speed = 0.9, lightColor = 0xff5470, openColor = 0x5dffb0, strip = true, sound = 'metal' }) {
    super(level);
    this.sound = sound;
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
    this.panel = panel;
    const thinAxis = size.x < size.z ? 0 : 2;
    // A glowing status strip on both faces of the panel (stone temple doors have none).
    this.lightMat = null;
    if (strip) {
      this.lightMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(lightColor).multiplyScalar(2.5) });
      level.own(this.lightMat);
      const sx = thinAxis === 0 ? size.x + 0.02 : size.x * 0.7;
      const sz = thinAxis === 2 ? size.z + 0.02 : size.z * 0.7;
      const stripMesh = new THREE.Mesh(new THREE.BoxGeometry(sx, 0.08, sz), this.lightMat);
      stripMesh.position.y = size.y * 0.12;
      this.mesh.add(stripMesh);
    }
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
  setLight(hex) { if (this.lightMat) this.lightMat.color.set(hex).multiplyScalar(2.5); }
  playSound(open) {
    if (this.sound === 'stone') this.game.audio.stoneDoor(open, this.speed);
    else this.game.audio.door(open);
  }
  open(silent = false) {
    if (this.target === 1) return;
    this.target = 1;
    this.setLight(this.openColor);
    if (!silent) this.playSound(true);
  }
  close(silent = false) {
    if (this.target === 0) return;
    this.target = 0;
    this.setLight(this.closedColor);
    if (!silent) this.playSound(false);
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
  constructor(level, { pos, size = 1.6, minSize = 0, acceptsPlayer = false, onChange = null, color = 0x4fd8ff, label = null, glyph = null }) {
    super(level);
    this.pos = pos.clone();
    this.size = size;
    this.minSize = minSize;
    this.acceptsPlayer = acceptsPlayer;
    this.onChange = onChange;
    this.pressed = false;
    this.anim = 0;
    const M = this.game.M;
    // Temple plates are carved stone with a glyph instead of metal and neon.
    const T = level.T;
    const base = new THREE.Mesh(new THREE.BoxGeometry(size, 0.05, size), T ? T.dark : M.trim);
    base.position.set(pos.x, pos.y + 0.025, pos.z);
    base.receiveShadow = true;
    const ring = new THREE.Mesh(new THREE.BoxGeometry(size + 0.12, 0.03, size + 0.12), T ? T.gold : neon(color, 1.6));
    ring.position.set(pos.x, pos.y + 0.012, pos.z);
    this.topMat = T
      ? new THREE.MeshStandardMaterial({ map: this.game.tex.tileFace(glyph || 'sun').map, emissive: color, emissiveMap: this.game.tex.tileFace(glyph || 'sun').em, emissiveIntensity: 0.3, roughness: 0.85, metalness: 0 })
      : new THREE.MeshStandardMaterial({ color: 0x2a2f38, emissive: color, emissiveIntensity: 0.3, roughness: 0.4, metalness: 0.6 });
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
const PROP_NAMES = { cube: 'cube', core: 'energy core', key: 'keycard', perception: 'perception block', block: 'stone block' };
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
  constructor(game, cp = 0, carry = null) {
    this.game = game;
    // State that survives a respawn within the level (e.g. relics already found).
    this.carry = carry || {};
    // Entities with hits(min, max) that kill the player on contact.
    this.hazards = [];
    this.relicKinds = null;
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

/* =====================================================================
   PART II — THE SUNKEN TEMPLE
   Shared pieces for levels 6–10: offerings, glyph dials, push blocks,
   traps, sun mirrors and the TempleLevel builder.
   ===================================================================== */

// Offerings and sacred stones. `glyph` picks the HUD icon (defaults to the key).
const RELIC_INFO = {
  mask: { name: 'Jade Mask', color: '#5fe0a0', hex: 0x5fe0a0 },
  disc: { name: 'Sun Disc', color: '#ffc457', hex: 0xffc457 },
  blade: { name: 'Obsidian Blade', color: '#b49cff', hex: 0xb49cff },
  feather: { name: 'Quetzal Feather', color: '#42e8d0', hex: 0x42e8d0 },
  idol: { name: 'Serpent Idol', color: '#ff7a52', hex: 0xff7a52 },
  heart: { name: 'Heart of Jade', color: '#4dffa0', hex: 0x4dffa0 },
  east: { name: 'Red Stone of the East', color: '#ff5a46', hex: 0xff5a46, glyph: 'gem', stone: 0xd8322a },
  north: { name: 'White Stone of the North', color: '#f4f4ff', hex: 0xf0f0ff, glyph: 'gem', stone: 0xf2f0e8 },
  west: { name: 'Black Stone of the West', color: '#a58cff', hex: 0x7a5cff, glyph: 'gem', stone: 0x16121c },
  south: { name: 'Yellow Stone of the South', color: '#ffd84a', hex: 0xffd84a, glyph: 'gem', stone: 0xffc232 },
  center: { name: 'Green Heart of the World', color: '#4dff9a', hex: 0x4dff9a, glyph: 'gem', stone: 0x2fd07a },
};

// Concatenate geometries (positions, normals, uvs, indices) into one.
function mergeGeometries(geos) {
  let nv = 0, ni = 0;
  for (const g of geos) { nv += g.attributes.position.count; ni += g.index ? g.index.count : g.attributes.position.count; }
  const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
  const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  let vo = 0, io = 0;
  for (const g of geos) {
    const p = g.attributes.position, n = g.attributes.normal, u = g.attributes.uv;
    pos.set(p.array, vo * 3);
    nor.set(n.array, vo * 3);
    if (u) uv.set(u.array, vo * 2);
    if (g.index) {
      const a = g.index.array;
      for (let i = 0; i < a.length; i++) idx[io + i] = a[i] + vo;
      io += a.length;
    } else {
      for (let i = 0; i < p.count; i++) idx[io + i] = vo + i;
      io += p.count;
    }
    vo += p.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}

// Small hand-sized model of an offering, facing +Z.
function buildRelicMesh(level, kind) {
  const T = level.T;
  const g = new THREE.Group();
  const add = (geo, mat, x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    g.add(m);
    return m;
  };
  switch (kind) {
    case 'mask': {
      add(new THREE.SphereGeometry(0.2, 24, 18), T.jade).scale.set(1, 1.22, 0.5);
      for (const sx of [-1, 1]) {
        add(new THREE.BoxGeometry(0.08, 0.026, 0.05), T.obsidian, sx * 0.075, 0.05, 0.085);
        add(new THREE.TorusGeometry(0.045, 0.016, 8, 16), T.gold, sx * 0.215, 0, 0).rotation.y = Math.PI / 2;
      }
      add(new THREE.BoxGeometry(0.1, 0.024, 0.05), T.obsidian, 0, -0.11, 0.075);
      add(new THREE.BoxGeometry(0.035, 0.09, 0.06), T.jade, 0, -0.02, 0.095);
      add(new THREE.TorusGeometry(0.21, 0.022, 8, 24, Math.PI), T.gold, 0, 0.03, 0).scale.set(1, 1.15, 0.6);
      break;
    }
    case 'disc': {
      add(new THREE.CylinderGeometry(0.22, 0.22, 0.04, 32), T.gold).rotation.x = Math.PI / 2;
      add(new THREE.CylinderGeometry(0.09, 0.09, 0.06, 24), T.jade).rotation.x = Math.PI / 2;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * TAU;
        add(new THREE.ConeGeometry(0.045, 0.12, 4), T.gold, Math.cos(a) * 0.28, Math.sin(a) * 0.28, 0).rotation.z = a - Math.PI / 2;
      }
      break;
    }
    case 'blade': {
      add(new THREE.OctahedronGeometry(0.1, 0), T.obsidian, 0, 0.1, 0).scale.set(0.9, 3.0, 0.25);
      add(new THREE.CylinderGeometry(0.028, 0.032, 0.16, 10), T.wood, 0, -0.24, 0);
      add(new THREE.BoxGeometry(0.15, 0.03, 0.05), T.gold, 0, -0.16, 0);
      add(new THREE.SphereGeometry(0.04, 12, 8), T.gold, 0, -0.33, 0);
      break;
    }
    case 'feather': {
      add(new THREE.PlaneGeometry(0.22, 0.64), T.feather, 0, 0.02, 0).rotation.z = 0.22;
      add(new THREE.CylinderGeometry(0.025, 0.025, 0.08, 8), T.gold, 0.07, -0.27, 0).rotation.z = 0.22;
      break;
    }
    case 'idol': {
      add(new THREE.TorusKnotGeometry(0.1, 0.035, 80, 10, 2, 3), T.jasper);
      add(new THREE.BoxGeometry(0.1, 0.075, 0.14), T.jasper, 0, 0.2, 0.03);
      for (const sx of [-1, 1]) add(new THREE.SphereGeometry(0.018, 8, 6), T.jade, sx * 0.035, 0.225, 0.095);
      add(new THREE.CylinderGeometry(0.1, 0.12, 0.05, 16), T.gold, 0, -0.17, 0);
      break;
    }
    case 'heart': {
      add(new THREE.IcosahedronGeometry(0.17, 1), T.jade).scale.set(1, 1.18, 0.9);
      add(new THREE.TorusGeometry(0.2, 0.018, 8, 32), T.gold).rotation.x = Math.PI / 2;
      add(new THREE.TorusGeometry(0.2, 0.018, 8, 32), T.gold);
      break;
    }
    default: {
      const info = RELIC_INFO[kind];
      const mat = level.own(new THREE.MeshStandardMaterial({
        color: info.stone, roughness: 0.18, metalness: 0.25, flatShading: true,
        emissive: info.hex, emissiveIntensity: kind === 'west' ? 0.45 : 0.3,
      }));
      add(new THREE.IcosahedronGeometry(0.17, 0), mat).scale.set(1, 1.3, 1);
      add(new THREE.TorusGeometry(0.25, 0.016, 8, 32), T.gold).rotation.x = Math.PI / 2;
      break;
    }
  }
  return g;
}

/* A floating offering marked by a pillar of light. ---------------------- */
class Relic extends Entity {
  constructor(level, { kind, pos, beacon = true, onTake = null }) {
    super(level);
    this.kind = kind;
    this.info = RELIC_INFO[kind];
    this.onTake = onTake;
    this.base = pos.clone();
    this.state = 'idle';
    this.t = rand(0, 10);
    this.range = 3.4;
    this.group = new THREE.Group();
    this.group.position.copy(pos);
    this.model = buildRelicMesh(level, kind);
    this.haloMat = level.own(new THREE.MeshBasicMaterial({ map: this.game.tex.glowSprite(), color: new THREE.Color(this.info.hex).multiplyScalar(0.9), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.halo = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 1.3), this.haloMat);
    const pick = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.9, 0.8), level.T.pick);
    pick.visible = false;
    this.group.add(this.model, this.halo, pick);
    level.scene.add(this.group);
    level.addPick(pick, this);
    this.beacon = beacon ? level.lightColumn(pos, this.info.hex) : null;
    if (this.beacon) this.beacon.userData.op = 0.22;
  }
  prompt() { return this.state === 'idle' ? { text: `Take the ${this.info.name}` } : null; }
  interact() {
    if (this.state !== 'idle') return;
    this.state = 'taking';
    this.tk = 0;
    this.from = this.group.position.clone();
    this.level.collectRelic(this.kind);
    if (this.onTake) this.onTake(this);
  }
  update(dt) {
    this.t += dt;
    if (this.state === 'gone') return;
    this.model.rotation.y += dt * 1.1;
    this.halo.quaternion.copy(this.game.camera.quaternion);
    this.haloMat.opacity = 0.55 + Math.sin(this.t * 2.4) * 0.15;
    if (this.state === 'idle') {
      this.group.position.y = this.base.y + Math.sin(this.t * 1.6) * 0.06;
      // The pillar of light guides from afar and fades away up close.
      if (this.beacon) this.beacon.material.opacity = this.beacon.userData.op * clamp((this.game.camera.position.distanceTo(this.base) - 2.5) / 7, 0, 1);
      return;
    }
    // Fly into the player's hands.
    this.tk = Math.min(1, this.tk + dt / 0.45);
    const cam = this.game.camera;
    const target = _v1.set(0, -0.25, -0.6).applyQuaternion(cam.quaternion).add(cam.position);
    this.group.position.lerpVectors(this.from, target, easeInOut(this.tk));
    this.group.scale.setScalar(1 - this.tk * 0.85);
    if (this.beacon) this.beacon.material.opacity = (1 - this.tk) * this.beacon.userData.op;
    if (this.tk >= 1) {
      this.state = 'gone';
      this.group.visible = false;
      if (this.beacon) this.beacon.visible = false;
    }
  }
}

/* Niches that accept offerings. They sit on `parent` (a gate slab or the
   world tree); slot positions and normals are in the parent's frame. ---- */
class OfferingShrine extends Entity {
  constructor(level, { parent, slots, onPlace = null, onComplete = null, size = 0.66 }) {
    super(level);
    this.onPlace = onPlace;
    this.onComplete = onComplete;
    this.range = 3.6;
    this.queue = [];
    this.qt = 0;
    this.doneT = 0;
    const T = level.T, tex = this.game.tex;
    const backMat = level.own(new THREE.MeshStandardMaterial({ color: 0x120e08, roughness: 1 }));
    this.slots = slots.map((s) => {
      const info = RELIC_INFO[s.kind];
      const g = new THREE.Group();
      g.position.copy(s.pos);
      level.orientPlane(g, s.normal || V3(0, 0, 1), s.up || Y_UP);
      parent.add(g);
      const back = new THREE.Mesh(new THREE.PlaneGeometry(size, size), backMat);
      back.position.z = 0.012;
      const outline = new THREE.Mesh(new THREE.PlaneGeometry(size * 0.84, size * 0.84), level.own(new THREE.MeshBasicMaterial({
        map: tex.glyphTex(info.glyph || s.kind, '#ffffff'), transparent: true, depthWrite: false, color: new THREE.Color(info.hex).multiplyScalar(0.4),
      })));
      outline.position.z = 0.022;
      const fm = level.own(new THREE.MeshStandardMaterial({ color: 0x5a4a34, roughness: 0.6, metalness: 0.5, emissive: new THREE.Color(info.hex), emissiveIntensity: 0 }));
      const t = 0.07, h = size / 2 + t / 2;
      for (const [x, y, w, hh] of [[0, h, size + 2 * t, t], [0, -h, size + 2 * t, t], [-h, 0, t, size], [h, 0, t, size]]) {
        const b = new THREE.Mesh(new THREE.BoxGeometry(w, hh, 0.08), fm);
        b.position.set(x, y, 0.04);
        g.add(b);
      }
      const pick = new THREE.Mesh(new THREE.PlaneGeometry(size + 0.4, size + 0.4), T.void);
      pick.visible = false;
      pick.position.z = 0.06;
      g.add(back, outline, pick);
      level.addPick(pick, this);
      return { kind: s.kind, g, outline, fm, placed: false, model: null, t: rand(0, 5) };
    });
    const placed = level.carry.placed || [];
    for (const sl of this.slots) if (placed.includes(sl.kind)) this.fill(sl, true);
    this.complete = this.slots.every((s) => s.placed);
  }
  carried() {
    const found = this.level.carry.found || [];
    return this.slots.filter((s) => !s.placed && !this.queue.includes(s) && found.includes(s.kind));
  }
  get remaining() { return this.slots.filter((s) => !s.placed).length; }
  prompt() {
    if (this.complete || this.queue.length) return null;
    const list = this.carried();
    if (list.length) return { text: list.length === 1 ? `Place the ${RELIC_INFO[list[0].kind].name}` : `Place ${list.length} offerings` };
    const r = this.remaining;
    return { text: `${r} offering${r === 1 ? '' : 's'} still missing`, far: true };
  }
  interact(game) {
    const list = this.carried();
    if (!list.length) { game.audio.deny(); return; }
    this.queue.push(...list);
    this.qt = 0;
  }
  fill(sl, silent = false) {
    sl.placed = true;
    const c = this.level.carry;
    c.placed = c.placed || [];
    if (!c.placed.includes(sl.kind)) c.placed.push(sl.kind);
    sl.model = buildRelicMesh(this.level, sl.kind);
    sl.model.position.z = 0.22;
    sl.model.scale.setScalar(silent ? 1 : 0.01);
    sl.g.add(sl.model);
    sl.fm.color.set(0xffc860);
    sl.fm.metalness = 1;
    sl.fm.roughness = 0.3;
    sl.fm.emissiveIntensity = 0.22;
    sl.outline.visible = false;
    if (!silent) {
      this.game.audio.offering();
      this.game.flash(RELIC_INFO[sl.kind].hex, 0.2);
    }
    if (this.onPlace) this.onPlace(sl.kind, silent);
    this.level.refreshRelics();
  }
  update(dt) {
    if (this.queue.length) {
      this.qt -= dt;
      if (this.qt <= 0) {
        this.fill(this.queue.shift());
        this.qt = 0.4;
        if (!this.queue.length && !this.complete && this.slots.every((s) => s.placed)) { this.complete = true; this.doneT = 0.9; }
      }
    }
    if (this.doneT > 0) {
      this.doneT -= dt;
      if (this.doneT <= 0 && this.onComplete) this.onComplete(false);
    }
    for (const sl of this.slots) {
      if (!sl.model) continue;
      sl.t += dt;
      sl.model.rotation.y = Math.sin(sl.t * 0.8) * 0.5;
      sl.model.scale.setScalar(Math.min(1, sl.model.scale.x + dt * 3));
    }
  }
}

/* A carved stone drum that turns one face at a time. ------------------- */
class GlyphDial extends Entity {
  constructor(level, { pos, facing = V3(0, 0, 1), faces, value = 0, onChange = null, title = null, radius = 0.6, height = 0.9, label = 'Turn the dial' }) {
    super(level);
    this.faces = faces;
    this.N = faces.length;
    this.value = value;
    this.onChange = onChange;
    this.label = label;
    this.step = TAU / this.N;
    this.angle = this.target = -(value + 0.5) * this.step;
    this.cool = 0;
    this.range = 3.1;
    const T = level.T, tex = this.game.tex;
    const g = this.group = new THREE.Group();
    g.position.copy(pos);
    g.rotation.y = Math.atan2(facing.x, facing.z);
    const baseH = 0.6;
    const base = new THREE.Mesh(new THREE.BoxGeometry(1.4, baseH, 1.4), T.dark);
    base.position.y = baseH / 2;
    const plinth = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.08, 1.25), T.carved);
    plinth.position.y = baseH + 0.04;
    const strip = tex.dialStrip(faces);
    this.mat = level.own(new THREE.MeshStandardMaterial({ map: strip.map, emissive: 0xffa860, emissiveMap: strip.em, emissiveIntensity: 0.32, roughness: 0.85, metalness: 0 }));
    this.drum = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, this.N, 1), [this.mat, T.dark, T.dark]);
    const drumY = baseH + 0.09 + height / 2;
    this.drum.position.y = drumY;
    this.drum.rotation.y = this.angle;
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(radius * 1.08, radius * 1.08, 0.12, this.N), T.dark);
    cap.position.y = drumY + height / 2 + 0.07;
    const ptr = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.16, 4), T.gold);
    ptr.position.set(0, baseH + 0.16, 0.66);
    for (const m of [base, plinth, this.drum, cap, ptr]) { m.castShadow = true; m.receiveShadow = true; g.add(m); }
    let top = drumY + height / 2 + 0.13;
    if (title) {
      const tab = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.66, 0.16), T.stone);
      tab.position.set(0, top + 0.35, 0);
      const face = new THREE.Mesh(new THREE.PlaneGeometry(0.54, 0.54), level.own(new THREE.MeshStandardMaterial({
        map: tex.glyphTex(title, '#3a2614'), transparent: true, roughness: 0.9,
        emissive: 0xffb070, emissiveMap: tex.glyphTex(title, '#ffffff'), emissiveIntensity: 0.4,
      })));
      face.position.set(0, top + 0.35, 0.085);
      tab.castShadow = true;
      g.add(tab, face);
      top += 0.7;
    }
    level.scene.add(g);
    level.world.addBox(pos.x - 0.7, pos.y, pos.z - 0.7, pos.x + 0.7, pos.y + top, pos.z + 0.7, this, 'dial');
    level.addPick(this.drum, this);
  }
  get symbol() { return this.faces[this.value]; }
  prompt() { return { text: this.label }; }
  interact() {
    if (this.cool > 0) return;
    this.value = (this.value + 1) % this.N;
    this.target -= this.step;
    this.cool = 0.3;
    this.game.audio.stoneGrind(0.32, 0.7);
    this.game.audio.trapClick(0.5);
    if (this.onChange) this.onChange(this.value, this);
  }
  setValue(v) {
    this.value = v;
    this.angle = this.target = -(v + 0.5) * this.step;
    this.drum.rotation.y = this.angle;
  }
  update(dt) {
    this.cool = Math.max(0, this.cool - dt);
    this.angle = damp(this.angle, this.target, 12, dt);
    this.drum.rotation.y = this.angle;
  }
}

/* A heavy stone block that slides one step when pushed. It behaves like a
   physics prop for pressure plates and falls into pits. ---------------- */
class PushBlock extends Entity {
  constructor(level, { pos, size = V3(1.6, 1.1, 1.6), step = 2, mat = null }) {
    super(level);
    this.kind = 'block';
    this.pos = pos.clone();
    this.home = pos.clone();
    this.vel = V3();
    this.half = size.clone().multiplyScalar(0.5);
    this.size = Math.min(size.x, size.z);
    this.step = step;
    this.held = false;
    this.locked = false;
    this.cradle = false;
    this.grounded = true;
    this.slide = null;
    this.falling = false;
    this.range = 2.9;
    const T = level.T;
    this.mesh = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), mat || T.carved);
    body.castShadow = true;
    body.receiveShadow = true;
    const band = new THREE.Mesh(new THREE.BoxGeometry(size.x + 0.03, 0.14, size.z + 0.03), T.red);
    band.position.y = size.y / 2 - 0.2;
    this.mesh.add(body, band);
    this.mesh.position.copy(this.pos);
    level.scene.add(this.mesh);
    this.solid = level.world.add(V3(), V3(), this, 'object');
    this.solid.kinematic = true;
    this.syncSolid();
    level.objects.push(this);
    level.addPick(body, this);
    level.addPick(band, this);
    this._a = V3();
    this._b = V3();
  }
  syncSolid() { boxFrom(this.pos, this.half, this.solid.min, this.solid.max); }
  standingOn(game) { const p = game.player; return p.grounded && p.ground && p.ground.owner === this; }
  pushDir(game) {
    const d = _v1.subVectors(this.pos, game.player.pos);
    return Math.abs(d.x) > Math.abs(d.z) ? V3(Math.sign(d.x), 0, 0) : V3(0, 0, Math.sign(d.z));
  }
  canMove(dir) {
    const to = _v2.copy(this.pos).addScaledVector(dir, this.step);
    const mn = this._a.copy(this.pos).min(to).sub(this.half);
    const mx = this._b.copy(this.pos).max(to).add(this.half);
    mn.x += 0.03; mn.z += 0.03; mx.x -= 0.03; mx.z -= 0.03; mn.y += 0.06; mx.y -= 0.02;
    return !this.level.world.firstOverlap(mn, mx, (s) => s.owner === this);
  }
  supported() {
    this._a.set(this.pos.x - this.half.x + 0.2, this.pos.y - this.half.y - 0.08, this.pos.z - this.half.z + 0.2);
    this._b.set(this.pos.x + this.half.x - 0.2, this.pos.y - this.half.y - 0.01, this.pos.z + this.half.z - 0.2);
    return !!this.level.world.firstOverlap(this._a, this._b, (s) => s.owner === this || s.tag === 'player');
  }
  prompt(game) {
    if (this.slide || this.falling) return null;
    if (this.standingOn(game)) return { text: "Can't push — you're standing on it", far: true };
    return { text: 'Push the stone block' };
  }
  interact(game) {
    if (this.slide || this.falling) return;
    if (this.standingOn(game)) { game.audio.deny(); return; }
    const dir = this.pushDir(game);
    if (!this.canMove(dir)) { game.audio.deny(); game.ui.toast('IT WILL NOT BUDGE'); return; }
    this.slide = { from: this.pos.clone(), to: this.pos.clone().addScaledVector(dir, this.step), t: 0 };
    game.audio.stoneGrind(0.75, 1.1);
  }
  update(dt) {
    const prev = _v3.copy(this.pos);
    const px = prev.x, py = prev.y, pz = prev.z;
    if (this.slide) {
      const s = this.slide;
      const nt = Math.min(1, s.t + dt / 0.75);
      const np = V3().lerpVectors(s.from, s.to, easeInOut(nt));
      // Hold still if the player has stepped into the block's path.
      boxFrom(np, this.half, this._a, this._b);
      const pl = this.game.player.solid;
      if (!pl || !boxOverlap(this._a, this._b, pl.min, pl.max)) { s.t = nt; this.pos.copy(np); }
      if (s.t >= 1) {
        this.slide = null;
        this.game.audio.thump(0.6);
        if (!this.supported()) { this.falling = true; this.vel.set(0, 0, 0); }
      }
    } else if (this.falling) {
      this.vel.y = Math.max(this.vel.y - GRAVITY * dt, -30);
      const res = moveBody(this.pos, this.vel, this.half, dt, this.level.world, { up: Y_UP, ignore: (s) => s.owner === this || s.tag === 'player' });
      if (res.grounded) {
        this.falling = false;
        this.vel.set(0, 0, 0);
        this.game.audio.thump(1.3);
        this.game.player.shake = 0.3;
      }
    }
    this.solid.delta.set(this.pos.x - px, this.pos.y - py, this.pos.z - pz);
    this.syncSolid();
    this.mesh.position.copy(this.pos);
  }
}

/* Wall lever --------------------------------------------------------------- */
class StoneLever extends Entity {
  constructor(level, { pos, normal, label = 'Pull the lever', onPull = null }) {
    super(level);
    this.label = label;
    this.onPull = onPull;
    this.used = false;
    this.range = 3;
    const T = level.T;
    const g = this.group = new THREE.Group();
    g.position.copy(pos);
    level.orientPlane(g, normal, Y_UP);
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.0, 0.12), T.carved);
    plate.position.z = 0.06;
    const slot = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.62, 0.02), T.void);
    slot.position.z = 0.125;
    this.arm = new THREE.Group();
    this.arm.position.z = 0.13;
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.04, 0.5, 8), T.wood);
    rod.position.y = 0.25;
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.075, 12, 8), T.gold);
    knob.position.y = 0.52;
    this.arm.add(rod, knob);
    this.arm.rotation.x = 0.45;
    g.add(plate, slot, this.arm);
    level.scene.add(g);
    for (const m of [plate, rod, knob]) level.addPick(m, this);
  }
  prompt() { return this.used ? null : { text: this.label }; }
  interact(game) {
    if (this.used) return;
    this.used = true;
    game.audio.stoneGrind(0.4, 0.8);
    game.audio.trapClick();
    if (this.onPull) this.onPull(this);
  }
  update(dt) { this.arm.rotation.x = damp(this.arm.rotation.x, this.used ? Math.PI - 0.45 : 0.45, 9, dt); }
}

/* Floor tile that crumbles a moment after you step on it (unless safe). -- */
class CrumbleTile extends Entity {
  constructor(level, { min, max, mat, top = null, safe = false, delay = 0.3, regen = 0, onStep = null }) {
    super(level);
    this.safe = safe;
    this.delay = delay;
    this.regen = regen;
    this.onStep = onStep;
    this.state = 'idle';
    this.t = 0;
    this.glow = 0;
    this.lit = false;
    this.home = V3().addVectors(min, max).multiplyScalar(0.5);
    const size = V3().subVectors(max, min);
    this.mesh = new THREE.Group();
    this.mesh.position.copy(this.home);
    const body = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), mat);
    body.castShadow = true;
    body.receiveShadow = true;
    this.mesh.add(body);
    this.topMat = top;
    if (top) {
      const f = new THREE.Mesh(new THREE.PlaneGeometry(size.x * 0.97, size.z * 0.97), top);
      f.rotation.x = -Math.PI / 2;
      f.position.y = size.y / 2 + 0.006;
      f.receiveShadow = true;
      this.mesh.add(f);
    }
    level.scene.add(this.mesh);
    this.solid = level.world.add(min, max, this, 'tile');
    this.vel = 0;
    this.spin = V3(rand(-1.2, 1.2), 0, rand(-1.2, 1.2));
  }
  standing() { const p = this.game.player; return p.grounded && p.ground === this.solid; }
  update(dt) {
    this.t += dt;
    switch (this.state) {
      case 'idle':
        if (this.standing()) {
          if (!this.lit && this.onStep) this.onStep(this);
          if (this.safe) this.lit = true;
          else { this.state = 'shaking'; this.t = 0; this.game.audio.crumble(0.5); }
        }
        break;
      case 'shaking':
        this.mesh.position.set(this.home.x + rand(-0.035, 0.035), this.home.y - this.t * 0.06, this.home.z + rand(-0.035, 0.035));
        if (this.t >= this.delay) { this.state = 'falling'; this.t = 0; this.solid.enabled = false; this.vel = 0; this.game.audio.crumble(1); }
        break;
      case 'falling':
        this.vel += GRAVITY * 0.8 * dt;
        this.mesh.position.y -= this.vel * dt;
        this.mesh.rotation.x += this.spin.x * dt;
        this.mesh.rotation.z += this.spin.z * dt;
        if (this.t > 2) this.mesh.visible = false;
        if (this.regen > 0 && this.t > this.regen) { this.state = 'rising'; this.t = 0; this.mesh.visible = true; this.mesh.rotation.set(0, 0, 0); }
        break;
      case 'rising': {
        const k = Math.min(1, this.t / 0.6);
        this.mesh.position.copy(this.home);
        this.mesh.position.y -= (1 - easeInOut(k)) * 2.5;
        if (k >= 1) {
          const pl = this.game.player.solid;
          if (!boxOverlap(this.solid.min, this.solid.max, pl.min, pl.max)) { this.state = 'idle'; this.solid.enabled = true; }
        }
        break;
      }
      default: break;
    }
    if (this.topMat && this.topMat.emissive) {
      this.glow = damp(this.glow, this.lit ? 1 : 0, 6, dt);
      this.topMat.emissive.setRGB(lerp(1, 0.35, this.glow), lerp(0.62, 1, this.glow), lerp(0.3, 0.6, this.glow));
      this.topMat.emissiveIntensity = 0.16 + this.glow * 1.1;
    }
  }
}

/* Traps ------------------------------------------------------------------ */
// Loudness of a trap sound by distance from the player.
function nearVol(game, pos, range = 16) {
  const d = game.player.pos.distanceTo(pos);
  return d >= range ? 0 : 1 - d / range;
}

// Bronze spikes that rise through a grate in a rhythm.
class SpikeTrap extends Entity {
  constructor(level, { x0, z0, x1, z1, y = 0, period = 2.6, up = 1.0, offset = 0, warn = 0.5, height = 0.85, spacing = 0.4 }) {
    super(level);
    Object.assign(this, { x0, z0, x1, z1, y, period, upTime: up, offset, warnTime: warn, height });
    this.h = 0;
    this.time = 0;
    this.prev = 'down';
    this.center = V3((x0 + x1) / 2, y, (z0 + z1) / 2);
    this.message = 'IMPALED — THE TEMPLE CLAIMS YOU';
    const T = level.T;
    const plate = new THREE.Mesh(worldBoxGeo(x0, y - 0.04, z0, x1, y + 0.012, z1, spacing * 4), T.spikePlate);
    plate.position.set((x0 + x1) / 2, y - 0.014, (z0 + z1) / 2);
    plate.receiveShadow = true;
    level.scene.add(plate);
    const pts = [];
    for (let i = Math.ceil(x0 / spacing - 0.5); (i + 0.5) * spacing < x1; i++) {
      for (let j = Math.ceil(z0 / spacing - 0.5); (j + 0.5) * spacing < z1; j++) {
        const px = (i + 0.5) * spacing, pz = (j + 0.5) * spacing;
        if (px > x0 + 0.1 && px < x1 - 0.1 && pz > z0 + 0.1 && pz < z1 - 0.1) pts.push([px, pz]);
      }
    }
    const geo = new THREE.ConeGeometry(0.06, height, 6);
    geo.translate(0, height / 2, 0);
    this.spikes = new THREE.InstancedMesh(geo, T.bronze, Math.max(1, pts.length));
    const m = new THREE.Matrix4();
    pts.forEach(([px, pz], i) => { m.makeTranslation(px, 0, pz); this.spikes.setMatrixAt(i, m); });
    this.spikes.castShadow = true;
    this.spikes.frustumCulled = false;
    this.spikes.position.y = y - height - 0.03;
    level.scene.add(this.spikes);
    level.hazards.push(this);
  }
  update(dt) {
    this.time += dt;
    const P = this.period, c = (((this.time + this.offset) % P) + P) % P;
    const downEnd = P - this.upTime - this.warnTime;
    const target = c < downEnd ? 0 : c < downEnd + this.warnTime ? 0.13 : 1;
    const state = target === 1 ? 'up' : target > 0 ? 'warn' : 'down';
    if (state !== this.prev) {
      const v = nearVol(this.game, this.center);
      if (v > 0 && state === 'warn') this.game.audio.trapClick(v);
      if (v > 0 && state === 'up') this.game.audio.spikes(v);
      this.prev = state;
    }
    this.h = target > this.h ? Math.min(target, this.h + dt * 14) : Math.max(target, this.h - dt * 3);
    this.spikes.position.y = this.y - this.height - 0.03 + this.h * this.height;
  }
  hits(mn, mx) {
    if (this.h < 0.4) return false;
    const top = this.y + this.h * this.height - 0.05;
    return mx.x > this.x0 + 0.08 && mn.x < this.x1 - 0.08 && mx.z > this.z0 + 0.08 && mn.z < this.z1 - 0.08 && mn.y < top && mx.y > this.y;
  }
}

// A wall that fires a volley of darts across a corridor lane.
class DartTrap extends Entity {
  constructor(level, { origin, dir, length, heights = [0.45, 0.95, 1.45], spread = 0.3, period = 3, offset = 0, warn = 0.8, speed = 16 }) {
    super(level);
    this.dir = dir.clone().normalize();
    this.side = V3(this.dir.z, 0, -this.dir.x);
    this.length = length;
    this.period = period;
    this.offset = offset;
    this.warnTime = warn;
    this.speed = speed;
    this.time = 0;
    this.lastCycle = null;
    this.hit = false;
    this.message = 'STRUCK BY A POISON DART';
    this.center = origin.clone().addScaledVector(this.dir, length / 2).setY(1);
    const T = level.T;
    // Carved plaque with dart holes.
    const g = new THREE.Group();
    g.position.copy(origin);
    level.orientPlane(g, this.dir, Y_UP);
    const plaque = new THREE.Mesh(new THREE.BoxGeometry(spread * 2 + 0.7, 1.75, 0.1), T.carved);
    plaque.position.set(0, 0.95, 0.05);
    plaque.receiveShadow = true;
    const skull = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.5), level.own(new THREE.MeshStandardMaterial({ map: this.game.tex.glyphTex('skull', '#2a1a0c'), transparent: true, roughness: 0.9 })));
    skull.position.set(0, 1.92, 0.02);
    const skullBack = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 0.08), T.stone);
    skullBack.position.set(0, 1.92, -0.03);
    this.holeMat = level.own(new THREE.MeshBasicMaterial({ color: 0x050302 }));
    g.add(plaque, skullBack, skull);
    this.holes = [];
    for (const h of heights) {
      for (const s of [-spread, spread]) {
        const hole = new THREE.Mesh(new THREE.CircleGeometry(0.06, 12), this.holeMat);
        hole.position.set(s, h, 0.105);
        g.add(hole);
        this.holes.push(origin.clone().addScaledVector(this.side, -s).setY(origin.y + h).addScaledVector(this.dir, 0.12));
      }
    }
    level.scene.add(g);
    // Dart pool.
    const dg = new THREE.CylinderGeometry(0.012, 0.012, 0.32, 5);
    dg.rotateX(Math.PI / 2);
    this.darts = this.holes.map(() => {
      const m = new THREE.Mesh(dg, T.bronze);
      const fl = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.08, 4), T.red);
      fl.rotation.x = -Math.PI / 2;
      fl.position.z = -0.17;
      m.add(fl);
      m.visible = false;
      m.quaternion.setFromUnitVectors(V3(0, 0, 1), this.dir);
      level.scene.add(m);
      return { m, pos: V3(), live: false, dist: 0 };
    });
    level.hazards.push(this);
    this._p = V3();
  }
  update(dt) {
    this.time += dt;
    const P = this.period, tt = this.time + this.offset;
    const c = ((tt % P) + P) % P;
    const warm = c > P - this.warnTime ? (c - (P - this.warnTime)) / this.warnTime : 0;
    this.holeMat.color.setRGB(0.02 + warm * 2.4, 0.01 + warm * 0.25, 0.005);
    const cycle = Math.floor(tt / P);
    if (this.lastCycle !== null && cycle !== this.lastCycle) {
      this.darts.forEach((d, i) => { d.live = true; d.dist = 0; d.pos.copy(this.holes[i]); d.m.visible = true; });
      const v = nearVol(this.game, this.center, 14);
      if (v > 0) this.game.audio.dart(v);
    } else if (this.lastCycle !== null && warm > 0 && this.prevWarm === 0) {
      const v = nearVol(this.game, this.center, 12);
      if (v > 0) this.game.audio.trapClick(v * 0.8);
    }
    this.prevWarm = warm;
    this.lastCycle = cycle;
    const pl = this.game.player;
    boxFrom(pl.pos, pl.half, _hzMin, _hzMax);
    for (const d of this.darts) {
      if (!d.live) continue;
      const step = this.speed * dt;
      if (rayBox(d.pos, this.dir, _hzMin, _hzMax) <= step) this.hit = true;
      d.pos.addScaledVector(this.dir, step);
      d.dist += step;
      if (d.dist > this.length - 0.1) { d.live = false; d.m.visible = false; }
      d.m.position.copy(d.pos);
    }
  }
  hits() {
    const h = this.hit;
    this.hit = false;
    return h;
  }
}

// A crescent blade on a long arm, swinging from the ceiling.
// axis 'z': it sweeps across X; axis 'x': it sweeps along Z.
class Pendulum extends Entity {
  constructor(level, { pivot, axis = 'z', length = 5, amp = 1.0, period = 2.8, phase = 0 }) {
    super(level);
    this.axis = axis;
    this.amp = amp;
    this.period = period;
    this.phase = phase;
    this.time = 0;
    this.length = length;
    this.message = 'CUT DOWN BY A SWINGING BLADE';
    this.pivot = pivot.clone();
    const T = level.T;
    this.group = new THREE.Group();
    this.group.position.copy(pivot);
    this.arm = new THREE.Group();
    this.group.add(this.arm);
    const rodLen = length - 0.3;
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, rodLen, 8), T.bronze);
    rod.position.y = -rodLen / 2;
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.14, 12), T.bronze);
    hub.rotation.x = Math.PI / 2;
    hub.position.y = -rodLen;
    const R1 = 1.0, R2 = 0.78, a0 = -Math.PI / 2 - 0.95, a1 = -Math.PI / 2 + 0.95;
    const sh = new THREE.Shape();
    sh.moveTo(Math.cos(a0) * R1, Math.sin(a0) * R1);
    sh.absarc(0, 0, R1, a0, a1, false);
    sh.absarc(0, 0.28, R2, a1 + 0.12, a0 - 0.12, true);
    sh.closePath();
    const bg = new THREE.ExtrudeGeometry(sh, { depth: 0.05, bevelEnabled: true, bevelThickness: 0.015, bevelSize: 0.03, bevelSegments: 1, curveSegments: 24 });
    bg.translate(0, 0, -0.025);
    const blade = new THREE.Mesh(bg, T.blade);
    blade.position.y = -rodLen;
    if (axis === 'x') blade.rotation.y = Math.PI / 2;
    for (const m of [rod, hub, blade]) { m.castShadow = true; this.arm.add(m); }
    level.scene.add(this.group);
    // Sample points along the cutting edge (local to the arm).
    this.samples = [];
    for (let i = 0; i <= 8; i++) {
      const a = lerp(a0 + 0.1, a1 - 0.1, i / 8);
      for (const r of [R1 - 0.03, (R1 + R2) / 2 - 0.05]) {
        const lx = Math.cos(a) * r, ly = Math.sin(a) * r - rodLen;
        this.samples.push(axis === 'x' ? V3(0, ly, -lx) : V3(lx, ly, 0));
      }
    }
    this._w = V3();
    this.lastSign = 0;
    level.hazards.push(this);
    this.update(0);
  }
  update(dt) {
    this.time += dt;
    const th = this.amp * Math.sin((this.time / this.period) * TAU + this.phase);
    this.arm.rotation.set(0, 0, 0);
    this.arm.rotation[this.axis] = th;
    this.arm.updateMatrixWorld(true);
    const sg = Math.sign(th);
    if (sg !== this.lastSign && this.lastSign !== 0) {
      const v = nearVol(this.game, this.pivot.clone().setY(1), 12);
      if (v > 0) this.game.audio.whoosh(v);
    }
    this.lastSign = sg;
  }
  hits(mn, mx) {
    const m = this.arm.matrixWorld;
    for (const s of this.samples) {
      const p = this._w.copy(s).applyMatrix4(m);
      if (p.x > mn.x - 0.04 && p.x < mx.x + 0.04 && p.y > mn.y && p.y < mx.y + 0.04 && p.z > mn.z - 0.04 && p.z < mx.z + 0.04) return true;
    }
    return false;
  }
}

// A vent in the floor that roars into a column of fire.
class FlameJet extends Entity {
  constructor(level, { pos, period = 4, on = 1.3, offset = 0, warn = 0.6, height = 2.8, radius = 1.1 }) {
    super(level);
    Object.assign(this, { period, onTime: on, offset, warnTime: warn, height, radius });
    this.pos = pos.clone();
    this.time = 0;
    this.k = 0;
    this.prev = 'off';
    this.message = 'CONSUMED BY THE FIRE';
    const T = level.T;
    const grate = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.7, radius * 0.7, 0.03, 16), T.void);
    grate.position.set(pos.x, pos.y + 0.012, pos.z);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(radius * 0.72, 0.06, 6, 24), T.bronze);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(pos.x, pos.y + 0.03, pos.z);
    this.glowMat = level.own(new THREE.MeshBasicMaterial({ color: 0x000000 }));
    const glow = new THREE.Mesh(new THREE.CircleGeometry(radius * 0.5, 16), this.glowMat);
    glow.rotation.x = -Math.PI / 2;
    glow.position.set(pos.x, pos.y + 0.03, pos.z);
    level.scene.add(grate, ring, glow);
    this.fire = new THREE.Group();
    this.fire.position.copy(pos);
    this.planes = [];
    for (let i = 0; i < 3; i++) {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), i === 1 ? T.jetInner : T.jetOuter);
      p.geometry.translate(0, 0.5, 0);
      this.fire.add(p);
      this.planes.push({ p, ph: rand(0, 10), w: i === 1 ? 0.65 : 1.1, h: i < 2 ? 1 : 0.7 });
    }
    this.fire.visible = false;
    level.scene.add(this.fire);
    level.hazards.push(this);
  }
  update(dt) {
    this.time += dt;
    const P = this.period, c = (((this.time + this.offset) % P) + P) % P;
    const active = c < this.onTime, warm = c > P - this.warnTime;
    const target = active ? 1 : warm ? 0.12 : 0;
    const state = active ? 'on' : 'off';
    if (state !== this.prev) {
      if (state === 'on') { const v = nearVol(this.game, this.pos, 18); if (v > 0) this.game.audio.fire(v); }
      this.prev = state;
    }
    this.k = target > this.k ? Math.min(target, this.k + dt * 9) : Math.max(target, this.k - dt * 4);
    this.glowMat.color.setRGB(1.3 * (this.k + (warm ? 0.35 : 0)), 0.45 * (this.k + (warm ? 0.25 : 0)), 0.02 + 0.04 * this.k);
    this.fire.visible = this.k > 0.01;
    if (this.fire.visible) {
      const cam = this.game.camera.position;
      this.fire.rotation.y = Math.atan2(cam.x - this.pos.x, cam.z - this.pos.z);
      const t = this.time;
      this.planes.forEach((pl, i) => {
        const fl = 1 + Math.sin(t * 17 + pl.ph) * 0.08 + Math.sin(t * 9 + pl.ph * 2) * 0.06;
        pl.p.scale.set(this.radius * 2 * pl.w * (0.6 + this.k * 0.4), this.height * pl.h * this.k * fl, 1);
        pl.p.position.z = i * 0.01;
      });
    }
  }
  hits(mn, mx) {
    if (this.k < 0.6) return false;
    const r = this.radius * 0.92, p = this.pos;
    return mx.x > p.x - r && mn.x < p.x + r && mx.z > p.z - r && mn.z < p.z + r && mn.y < p.y + this.height * this.k && mx.y > p.y;
  }
}

// A static region that kills: pits, water, crushers.
class KillZone extends Entity {
  constructor(level, { min, max, message = 'THE TEMPLE CLAIMS YOU' }) {
    super(level);
    this.min = min.clone();
    this.max = max.clone();
    this.message = message;
    this.enabled = true;
    level.hazards.push(this);
  }
  hits(mn, mx) { return this.enabled && boxOverlap(mn, mx, this.min, this.max, 0); }
}

/* Sun mirrors, prisms and receivers --------------------------------------
   Light travels along the grid axes in the horizontal plane. A mirror's
   polished face points along a diagonal; light that strikes the face turns
   90°, light that strikes the stone back stops. A prism splits light both
   ways. Receivers are jade eyes that wake when light reaches them. */
const MIRROR_NORMALS = [V3(1, 0, 1), V3(1, 0, -1), V3(-1, 0, -1), V3(-1, 0, 1)].map((v) => v.normalize());

class BeamNetwork extends Entity {
  constructor(level, { color = 0xffdc9a } = {}) {
    super(level);
    this.sources = [];
    this.elements = [];
    this.pool = [];
    this.flares = [];
    this.nSeg = 0;
    this.nFlare = 0;
    this.coreMat = neon(color, 3.4);
    this.glowMat = level.own(new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(1.1), transparent: true, opacity: 0.3, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.flareMat = level.own(new THREE.MeshBasicMaterial({ map: this.game.tex.glowSprite(), color: new THREE.Color(color).multiplyScalar(1.6), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.coreGeo = new THREE.CylinderGeometry(0.035, 0.035, 1, 6, 1, true);
    this.glowGeo = new THREE.CylinderGeometry(0.13, 0.13, 1, 10, 1, true);
    this.flareGeo = new THREE.PlaneGeometry(1, 1);
    this.ignore = (s) => s.tag === 'player' || s.tag === 'object' || s.owner instanceof SunMirror || s.owner instanceof BeamPrism || s.owner instanceof BeamReceiver;
  }
  addSource(pos, dir) { this.sources.push({ pos: pos.clone(), dir: dir.clone().normalize() }); }
  add(e) { this.elements.push(e); return e; }
  segMesh(i) {
    while (this.pool.length <= i) {
      const core = new THREE.Mesh(this.coreGeo, this.coreMat);
      const glow = new THREE.Mesh(this.glowGeo, this.glowMat);
      core.frustumCulled = glow.frustumCulled = false;
      this.level.scene.add(core, glow);
      this.pool.push({ core, glow });
    }
    return this.pool[i];
  }
  flareMesh(i) {
    while (this.flares.length <= i) {
      const f = new THREE.Mesh(this.flareGeo, this.flareMat);
      this.level.scene.add(f);
      this.flares.push(f);
    }
    return this.flares[i];
  }
  draw(p, d, len, wall) {
    if (len < 0.01) return;
    const s = this.segMesh(this.nSeg++);
    for (const m of [s.core, s.glow]) {
      m.visible = true;
      m.position.copy(p).addScaledVector(d, len / 2);
      m.quaternion.setFromUnitVectors(Y_UP, d);
      m.scale.set(1, len, 1);
    }
    const f = this.flareMesh(this.nFlare++);
    f.visible = true;
    f.position.copy(p).addScaledVector(d, len - (wall ? 0.06 : 0));
    f.quaternion.copy(this.game.camera.quaternion);
    f.scale.setScalar(wall ? 0.55 : 0.95);
  }
  walk(p, d, depth) {
    if (depth > 14 || this.nSeg > 48) return;
    let best = Infinity, hit = null;
    for (const e of this.elements) {
      const c = e.center;
      const vx = c.x - p.x, vy = c.y - p.y, vz = c.z - p.z;
      const t = vx * d.x + vy * d.y + vz * d.z;
      if (t < 0.05 || t >= best) continue;
      const px = vx - d.x * t, py = vy - d.y * t, pz = vz - d.z * t;
      if (px * px + py * py + pz * pz < e.catchR * e.catchR) { best = t; hit = e; }
    }
    const ray = this.level.world.raycast(p, d, 140, this.ignore);
    if (ray.dist < best) { this.draw(p, d, ray.dist, true); return; }
    this.draw(p, d, best, false);
    const hp = V3().copy(p).addScaledVector(d, best);
    if (hit.kind === 'mirror') {
      if (hit.busy > 0) return;
      const n = hit.normal, dn = d.dot(n);
      if (dn > -0.01) return;
      this.walk(hp, snapAxis(V3().copy(d).addScaledVector(n, -2 * dn)), depth + 1);
    } else if (hit.kind === 'prism') {
      this.walk(hp, V3(d.z, 0, -d.x), depth + 1);
      this.walk(hp, V3(-d.z, 0, d.x), depth + 1);
    } else if (hit.kind === 'receiver') {
      hit.hitNow = true;
    }
  }
  update() {
    for (const e of this.elements) if (e.kind === 'receiver') e.hitNow = false;
    this.nSeg = 0;
    this.nFlare = 0;
    for (const s of this.sources) this.walk(s.pos, s.dir, 0);
    for (let i = this.nSeg; i < this.pool.length; i++) this.pool[i].core.visible = this.pool[i].glow.visible = false;
    for (let i = this.nFlare; i < this.flares.length; i++) this.flares[i].visible = false;
    for (const e of this.elements) if (e.kind === 'receiver') e.setLit(e.hitNow);
  }
}

class SunMirror extends Entity {
  constructor(level, net, { pos, state = 0, fixed = false, carrier = null, height = 1.35 }) {
    super(level);
    this.kind = 'mirror';
    this.catchR = 0.32;
    this.state = state;
    this.fixed = fixed;
    this.carrier = carrier;
    this.height = height;
    this.busy = 0;
    this.range = 3.3;
    this.rot = this.targetRot = (Math.PI / 4) * (1 + 2 * state);
    this._c = V3();
    const T = level.T;
    this.group = new THREE.Group();
    this.group.position.copy(pos);
    if (!carrier) {
      const ph = height - 0.42;
      const ped = new THREE.Mesh(new THREE.BoxGeometry(0.56, ph, 0.56), T.stone);
      ped.position.y = ph / 2;
      const band = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.18, 0.6), T.red);
      band.position.y = ph * 0.7;
      const cap = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.1, 0.72), T.carved);
      cap.position.y = ph + 0.05;
      for (const m of [ped, band, cap]) { m.castShadow = true; m.receiveShadow = true; this.group.add(m); }
      level.world.addBox(pos.x - 0.36, pos.y, pos.z - 0.36, pos.x + 0.36, pos.y + ph + 0.1, pos.z + 0.36, this, 'mirror');
    } else {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.09, height - 0.3, 8), T.bronze);
      post.position.y = (height - 0.3) / 2;
      this.group.add(post);
    }
    this.holder = new THREE.Group();
    this.holder.position.y = height;
    this.holder.rotation.y = this.rot;
    const yoke = new THREE.Mesh(new THREE.TorusGeometry(0.43, 0.035, 6, 24, Math.PI), T.bronze);
    yoke.rotation.z = Math.PI;
    const front = new THREE.Mesh(new THREE.CircleGeometry(0.36, 32), fixed ? T.gold : T.mirror);
    front.position.z = 0.03;
    const back = new THREE.Mesh(new THREE.CircleGeometry(0.36, 32), T.dark);
    back.rotation.y = Math.PI;
    back.position.z = -0.03;
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.37, 0.045, 8, 32), T.gold);
    const sun = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.5), level.own(new THREE.MeshBasicMaterial({ map: this.game.tex.glyphTex('sun', '#ffffff'), transparent: true, depthWrite: false, opacity: 0.35, blending: THREE.AdditiveBlending, color: 0xffd090 })));
    sun.position.z = 0.036;
    for (const m of [yoke, front, back, rim]) m.castShadow = true;
    this.holder.add(yoke, front, back, rim, sun);
    this.group.add(this.holder);
    level.scene.add(this.group);
    for (const m of [front, back, rim]) level.addPick(m, this);
    net.add(this);
  }
  get normal() { return MIRROR_NORMALS[this.state]; }
  get center() {
    if (this.carrier) this.group.position.set(this.carrier.pos.x, this.carrier.pos.y + this.carrier.half.y, this.carrier.pos.z);
    return this._c.copy(this.group.position).setY(this.group.position.y + this.height);
  }
  prompt() {
    if (this.fixed) return { text: 'Set in stone — it will not turn', far: true };
    if (this.busy > 0) return null;
    return { text: 'Turn the mirror' };
  }
  interact(game) {
    if (this.fixed || this.busy > 0) { game.audio.deny(); return; }
    this.state = (this.state + 1) % 4;
    this.targetRot += Math.PI / 2;
    this.busy = 0.45;
    game.audio.stoneGrind(0.35, 0.6);
    game.audio.trapClick(0.6);
  }
  update(dt) {
    this.busy = Math.max(0, this.busy - dt);
    this.rot = this.busy > 0 ? lerp(this.targetRot - Math.PI / 2, this.targetRot, easeInOut(1 - this.busy / 0.45)) : this.targetRot;
    this.holder.rotation.y = this.rot;
    if (this.carrier) void this.center;
  }
}

class BeamPrism extends Entity {
  constructor(level, net, { pos, height = 1.35 }) {
    super(level);
    this.kind = 'prism';
    this.catchR = 0.34;
    this.c = pos.clone().setY(pos.y + height);
    const T = level.T;
    const ph = height - 0.45;
    const ped = new THREE.Mesh(new THREE.BoxGeometry(0.6, ph, 0.6), T.carved);
    ped.position.set(pos.x, pos.y + ph / 2, pos.z);
    ped.castShadow = true;
    ped.receiveShadow = true;
    this.crystalMat = level.own(new THREE.MeshStandardMaterial({ color: 0x7affc8, roughness: 0.05, metalness: 0.2, emissive: 0x2affa0, emissiveIntensity: 0.6, transparent: true, opacity: 0.85, flatShading: true }));
    this.crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.3, 0), this.crystalMat);
    this.crystal.position.copy(this.c);
    this.crystal.scale.set(1, 1.4, 1);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.04, 8, 24), T.gold);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(pos.x, pos.y + ph + 0.02, pos.z);
    level.scene.add(ped, this.crystal, ring);
    level.world.addBox(pos.x - 0.3, pos.y, pos.z - 0.3, pos.x + 0.3, pos.y + ph, pos.z + 0.3, this, 'prism');
    net.add(this);
  }
  get center() { return this.c; }
  update(dt) { this.crystal.rotation.y += dt * 0.8; }
}

class BeamReceiver extends Entity {
  constructor(level, net, { pos, onChange = null, radius = 0.26 }) {
    super(level);
    this.kind = 'receiver';
    this.catchR = 0.45;
    this.c = pos.clone();
    this.lit = false;
    this.hitNow = false;
    this.glow = 0;
    this.onChange = onChange;
    this.mat = level.own(new THREE.MeshStandardMaterial({ color: 0x2fae74, roughness: 0.15, metalness: 0.1, emissive: 0x3dff9a, emissiveIntensity: 0.25 }));
    this.orb = new THREE.Mesh(new THREE.SphereGeometry(radius, 24, 16), this.mat);
    this.orb.position.copy(pos);
    this.haloMat = level.own(new THREE.MeshBasicMaterial({ map: this.game.tex.glowSprite(), color: new THREE.Color(0x5dffb0), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.halo = new THREE.Mesh(new THREE.PlaneGeometry(radius * 7, radius * 7), this.haloMat);
    this.halo.position.copy(pos);
    level.scene.add(this.orb, this.halo);
    net.add(this);
  }
  get center() { return this.c; }
  setLit(on) {
    if (on === this.lit) return;
    this.lit = on;
    if (on) { this.game.audio.chime(); this.game.flash(0x5dffb0, 0.15); }
    if (this.onChange) this.onChange(on, this);
  }
  update(dt) {
    this.glow = damp(this.glow, this.lit ? 1 : 0, 5, dt);
    this.mat.emissiveIntensity = 0.25 + this.glow * 3;
    this.haloMat.opacity = this.glow * 0.9;
    this.halo.quaternion.copy(this.game.camera.quaternion);
  }
}

/* A great stone ball that rolls down a corridor ------------------------- */
class Boulder extends Entity {
  constructor(level, { start, endZ, radius = 1.5, floorY, accel = 3, vmax = 7, onCrash = null }) {
    super(level);
    this.start = start.clone();
    this.endZ = endZ;
    this.radius = radius;
    this.floorY = floorY;
    this.accel = accel;
    this.vmax = vmax;
    this.onCrash = onCrash;
    this.state = 'idle';
    this.v = 0;
    this.t = 0;
    this.rumbleT = 0;
    this.message = 'CRUSHED BY THE ROLLING STONE';
    const geo = new THREE.IcosahedronGeometry(radius, 3);
    const p = geo.attributes.position;
    const rnd = mulberry32(17);
    for (let i = 0; i < p.count; i++) {
      _v1.fromBufferAttribute(p, i);
      const k = 1 + (Math.sin(_v1.x * 3.1) * Math.sin(_v1.y * 2.7) * Math.sin(_v1.z * 3.3)) * 0.05 + (rnd() - 0.5) * 0.015;
      _v1.multiplyScalar(k);
      p.setXYZ(i, _v1.x, _v1.y, _v1.z);
    }
    geo.computeVertexNormals();
    this.mesh = new THREE.Mesh(geo, level.T.carved);
    this.mesh.castShadow = true;
    this.mesh.position.copy(start);
    this.mesh.visible = false;
    level.scene.add(this.mesh);
    level.hazards.push(this);
  }
  release() {
    if (this.state !== 'idle') return;
    this.state = 'drop';
    this.t = 0;
    this.mesh.visible = true;
  }
  update(dt) {
    if (this.state === 'idle' || this.state === 'done') return;
    this.t += dt;
    const m = this.mesh;
    const ground = this.floorY(m.position.z) + this.radius;
    if (this.state === 'drop') {
      m.position.y = Math.max(ground, this.start.y - 0.5 * GRAVITY * this.t * this.t);
      if (m.position.y <= ground) {
        this.state = 'roll';
        this.game.audio.thump(1.6);
        this.game.player.shake = 0.6;
      }
      return;
    }
    this.v = Math.min(this.vmax, this.v + this.accel * dt);
    m.position.z -= this.v * dt;
    m.position.y = ground;
    m.rotation.x -= (this.v * dt) / this.radius;
    this.rumbleT -= dt;
    if (this.rumbleT <= 0) {
      this.rumbleT = 0.9;
      const v = nearVol(this.game, m.position, 30);
      if (v > 0) this.game.audio.rumble(1.0);
      this.game.player.shake = Math.max(this.game.player.shake, 0.25 * v);
    }
    if (m.position.z <= this.endZ) {
      m.position.z = this.endZ;
      this.state = 'done';
      this.game.audio.thump(2);
      this.game.audio.crumble(1.5);
      this.game.player.shake = 1;
      if (this.onCrash) this.onCrash();
    }
  }
  hits(mn, mx) {
    if (this.state !== 'roll' && this.state !== 'drop') return false;
    const c = this.mesh.position;
    const dx = Math.max(mn.x - c.x, 0, c.x - mx.x);
    const dy = Math.max(mn.y - c.y, 0, c.y - mx.y);
    const dz = Math.max(mn.z - c.z, 0, c.z - mx.z);
    return dx * dx + dy * dy + dz * dz < (this.radius * 0.92) ** 2;
  }
}

/* A stone step that rises out of the floor on cue ------------------------ */
class RisingBlock extends Entity {
  constructor(level, { min, max, mat, depth = 3 }) {
    super(level);
    this.min = min.clone();
    this.max = max.clone();
    this.depth = depth;
    this.state = 'down';
    this.t = 0;
    this.k = 0;
    const size = V3().subVectors(max, min);
    this.center = V3().addVectors(min, max).multiplyScalar(0.5);
    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), mat);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.visible = false;
    this.mesh.position.copy(this.center).setY(this.center.y - depth);
    level.scene.add(this.mesh);
    this.solid = level.world.add(V3(), V3(), this, 'rise');
    this.solid.kinematic = true;
    this.solid.enabled = false;
  }
  rise(delay = 0, snap = false) {
    if (snap) { this.state = 'up'; this.k = 1; this.apply(0); this.mesh.visible = true; this.solid.enabled = true; return; }
    this.state = 'rising';
    this.t = -delay;
  }
  apply(prevK) {
    const off = -this.depth * (1 - this.k);
    this.mesh.position.copy(this.center).setY(this.center.y + off);
    this.solid.min.copy(this.min).setY(this.min.y + off);
    this.solid.max.copy(this.max).setY(this.max.y + off);
    this.solid.delta.set(0, this.depth * (this.k - prevK), 0);
  }
  update(dt) {
    if (this.state !== 'rising') { this.solid.delta.set(0, 0, 0); return; }
    this.t += dt;
    if (this.t < 0) return;
    if (!this.mesh.visible) {
      this.mesh.visible = true;
      this.solid.enabled = true;
      if (nearVol(this.game, this.center, 30) > 0) this.game.audio.stoneGrind(1.0, 0.7);
    }
    const prev = this.k;
    this.k = easeInOut(Math.min(1, this.t / 1.1));
    this.apply(prev);
    // Never trap the player inside a rising step: lift or push them clear.
    const pl = this.game.player;
    if (boxOverlap(this.solid.min, this.solid.max, pl.solid.min, pl.solid.max)) {
      depenetrate(pl.pos, pl.half, this.level.world, (s) => s.owner === pl);
      pl.syncSolid();
    }
    if (this.t >= 1.1) { this.state = 'up'; this.solid.delta.set(0, 0, 0); }
  }
}

/* Sky dome and water shaders for the temple levels. */
const SKY_VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}`;
const SKY_FRAG = /* glsl */`
uniform vec3 uTop; uniform vec3 uHorizon; uniform vec3 uGlow; uniform vec3 uMoon; uniform vec3 uMoonCol;
uniform float uTime; uniform float uStars; uniform float uMoonSize;
varying vec3 vDir;
float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col = mix(uHorizon, uTop, pow(clamp(h, 0.0, 1.0), 0.5));
  col = mix(col, uHorizon * 0.5, smoothstep(0.0, -0.3, h));
  float m = max(dot(d, uMoon), 0.0);
  col += uGlow * (pow(m, 6.0) * 0.35 + pow(m, 60.0) * 0.8);
  col += uMoonCol * smoothstep(1.0 - uMoonSize, 1.0 - uMoonSize * 0.75, m);
  vec3 q = floor(d * 360.0);
  float s = hash(q);
  float star = step(0.9966, s) * smoothstep(0.03, 0.35, h) * uStars;
  star *= 0.55 + 0.45 * sin(uTime * (1.0 + s * 3.0) + s * 60.0);
  col += vec3(0.85, 0.9, 1.0) * star * (0.5 + 1.5 * fract(s * 91.0));
  // A faint band of the Milky Way.
  float band = exp(-pow(dot(d, normalize(vec3(0.5, 0.35, 0.8))) * 5.0, 2.0)) * smoothstep(0.0, 0.4, h);
  col += vec3(0.12, 0.13, 0.2) * band * uStars * (0.6 + 0.4 * hash(floor(d * 60.0)));
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
const WATER_VERT = /* glsl */`
varying vec3 vW;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const WATER_FRAG = /* glsl */`
uniform float uTime; uniform vec3 uDeep; uniform vec3 uShallow; uniform vec3 uGlint;
varying vec3 vW;
void main() {
  vec2 p = vW.xz;
  float w = sin(p.x * 1.3 + uTime * 0.9) * 0.5 + sin(p.y * 1.7 - uTime * 0.7) * 0.5 + sin((p.x + p.y) * 2.6 + uTime * 1.4) * 0.3;
  float c = sin(p.x * 6.0 + sin(p.y * 3.0 + uTime) * 2.0 + uTime * 1.2) * sin(p.y * 7.3 - uTime * 0.8 + sin(p.x * 2.1) * 2.0);
  float n = fract(sin(dot(floor(p * 3.0), vec2(12.9898, 78.233))) * 43758.5453);
  vec3 col = mix(uDeep, uShallow, 0.4 + 0.18 * w);
  col += uGlint * smoothstep(0.86, 1.0, c) * step(0.55, n) * 0.22;
  vec3 v = normalize(cameraPosition - vW);
  col += uShallow * pow(1.0 - max(v.y, 0.0), 3.0) * 0.6;
  gl_FragColor = vec4(col, 0.94);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/* ---------------------------------------------------------------------
   TempleLevel: builder helpers shared by levels 6–10. Static stone is
   batched into one mesh per material to keep draw calls low.
   --------------------------------------------------------------------- */
class TempleLevel extends Level {
  constructor(game, cp = 0, carry = null) {
    super(game, cp, carry);
    this.T = templeMaterials(game);
    this.batching = true;
    this.batches = new Map();
    this.flames = [];
    this.flickers = [];
    this.waterU = [];
    this.fol = {};
    this.rnd = mulberry32(this.constructor.meta.seed || 7);
  }
  setAtmosphere(o) {
    super.setAtmosphere(o);
    if (!this.game.templeEnv) this.game.templeEnv = buildTempleEnvironment(this.game.renderer);
    this.scene.environment = this.game.templeEnv;
  }
  // ---- batched static geometry --------------------------------------------
  box(x0, y0, z0, x1, y1, z1, mat, opts = {}) {
    if (!this.batching || opts.batch === false) return super.box(x0, y0, z0, x1, y1, z1, mat, opts);
    if (x0 > x1) [x0, x1] = [x1, x0];
    if (y0 > y1) [y0, y1] = [y1, y0];
    if (z0 > z1) [z0, z1] = [z1, z0];
    const g = worldBoxGeo(x0, y0, z0, x1, y1, z1, opts.scale || 4);
    g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    this.addStatic(g, mat, opts.shadow !== false);
    if (opts.solid !== false) this.world.addBox(x0, y0, z0, x1, y1, z1, opts.owner || null, opts.tag || 'static');
    return null;
  }
  addStatic(geo, mat, shadow = true) {
    const key = mat.uuid + (shadow ? 's' : 'n');
    let b = this.batches.get(key);
    if (!b) { b = { mat, shadow, geos: [] }; this.batches.set(key, b); }
    b.geos.push(geo);
  }
  flushStatic() {
    for (const b of this.batches.values()) {
      const mesh = new THREE.Mesh(mergeGeometries(b.geos), b.mat);
      mesh.castShadow = b.shadow;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
    }
    this.batches.clear();
  }
  // Invisible collider.
  block(x0, y0, z0, x1, y1, z1) { this.world.addBox(x0, y0, z0, x1, y1, z1, null, 'static'); }
  finish() {
    this.flushStatic();
    this.finishFoliage();
    this.refreshRelics();
  }
  // ---- offerings ------------------------------------------------------------
  found(kind) { return (this.carry.found || []).includes(kind); }
  placed(kind) { return (this.carry.placed || []).includes(kind); }
  collectRelic(kind) {
    const c = this.carry;
    c.found = c.found || [];
    if (!c.found.includes(kind)) c.found.push(kind);
    this.game.audio.relic();
    this.game.flash(RELIC_INFO[kind].hex, 0.3);
    const kinds = this.relicKinds || [];
    const n = kinds.filter((k) => c.found.includes(k)).length;
    this.game.ui.toast(kinds.length > 1 ? `${RELIC_INFO[kind].name.toUpperCase()} · ${n} / ${kinds.length}` : `${RELIC_INFO[kind].name.toUpperCase()} TAKEN`, 'good', 3);
    this.refreshRelics();
    this.onRelic(kind);
  }
  onRelic() {}
  refreshRelics() { this.game.ui.setRelics(this.relicKinds, this.carry.found || [], this.carry.placed || []); }
  // ---- fire -----------------------------------------------------------------
  flameGeo() {
    if (!this._flameGeo) {
      this._flameGeo = new THREE.PlaneGeometry(0.36, 0.66);
      this._flameGeo.translate(0, 0.28, 0);
    }
    return this._flameGeo;
  }
  flame(pos, scale = 1, { light = false, intensity = 10, distance = 9, color = 0xff9a48 } = {}) {
    const g = new THREE.Group();
    g.position.copy(pos);
    const outer = new THREE.Mesh(this.flameGeo(), this.T.flameOuter);
    const inner = new THREE.Mesh(this.flameGeo(), this.T.flameInner);
    inner.position.z = 0.01;
    const halo = new THREE.Mesh(this.flameGeo(), this.haloMat || (this.haloMat = this.own(new THREE.MeshBasicMaterial({ map: this.game.tex.glowSprite(), color: new THREE.Color(0.5, 0.22, 0.06), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }))));
    halo.scale.set(3.2, 1.7, 1);
    halo.position.set(0, -0.12, -0.01);
    g.add(halo, outer, inner);
    g.scale.setScalar(scale);
    this.scene.add(g);
    this.flames.push({ g, outer, inner, ph: rand(0, 10) });
    if (light) {
      const l = this.point(pos.x, pos.y + 0.35 * scale, pos.z, color, intensity, distance);
      this.flickers.push({ l, base: intensity, ph: rand(0, 10) });
    }
  }
  // Torch in a bronze cup on a bracket, mounted on a wall facing `normal`.
  torch(pos, normal, opts = {}) {
    const T = this.T;
    const n = normal.clone().normalize();
    const b = pos.clone().addScaledVector(n, 0.34);
    const lo = V3().copy(pos).min(b), hi = V3().copy(pos).max(b);
    const e = 0.05;
    this.box(lo.x - (n.x ? 0 : e), pos.y - 0.06, lo.z - (n.z ? 0 : e), hi.x + (n.x ? 0 : e), pos.y + 0.03, hi.z + (n.z ? 0 : e), T.bronze, { solid: false });
    const cup = new THREE.CylinderGeometry(0.13, 0.07, 0.18, 10);
    cup.translate(b.x, pos.y + 0.06, b.z);
    this.addStatic(cup, T.bronze);
    const coal = new THREE.CylinderGeometry(0.11, 0.11, 0.02, 10);
    coal.translate(b.x, pos.y + 0.15, b.z);
    this.addStatic(coal, T.coals, false);
    this.flame(V3(b.x, pos.y + 0.13, b.z), opts.scale || 0.95, { light: opts.light !== false, intensity: opts.intensity || 9, distance: opts.distance || 9, color: opts.color });
  }
  // Standing stone brazier.
  brazier(x, y, z, { light = true, scale = 1, intensity = 14, distance = 12, color } = {}) {
    const T = this.T, s = scale;
    this.box(x - 0.34 * s, y, z - 0.34 * s, x + 0.34 * s, y + 0.9 * s, z + 0.34 * s, T.carved);
    this.box(x - 0.44 * s, y, z - 0.44 * s, x + 0.44 * s, y + 0.12 * s, z + 0.44 * s, T.dark);
    const bowl = new THREE.CylinderGeometry(0.52 * s, 0.32 * s, 0.34 * s, 14);
    bowl.translate(x, y + 1.07 * s, z);
    this.addStatic(bowl, T.dark);
    const coal = new THREE.CylinderGeometry(0.45 * s, 0.45 * s, 0.03, 14);
    coal.translate(x, y + 1.22 * s, z);
    this.addStatic(coal, T.coals, false);
    this.block(x - 0.5 * s, y, z - 0.5 * s, x + 0.5 * s, y + 1.24 * s, z + 0.5 * s);
    this.flame(V3(x, y + 1.2 * s, z), 1.75 * s, { light, intensity, distance, color });
  }
  // ---- architecture -----------------------------------------------------------
  // A wall slab with Maya corbel-vaulted doorways cut through it.
  // axis 'z': spans x (a) and y (b) between z = c0..c1; axis 'x': spans z and y.
  // doors: [{ a, w = 2.4, h = 2.8, steps = 4 }]
  archWall(axis, c0, c1, a0, a1, b0, b1, mat, doors = [], { lintel = true } = {}) {
    const holes = doors.map((d) => {
      const w = d.w || 2.4, h = d.h || 2.8, n = d.steps ?? 4;
      return { a0: d.a - w / 2, a1: d.a + w / 2, b0: b0 - 1, b1: Math.min(b1, b0 + h + n * 0.3) };
    });
    this.wall(axis, c0, c1, a0, a1, b0, b1, mat, holes);
    const B = (pa0, pb0, pa1, pb1, m, e = 0) => {
      if (axis === 'z') this.box(pa0, pb0, c0 - e, pa1, pb1, c1 + e, m);
      else this.box(c0 - e, pb0, pa0, c1 + e, pb1, pa1, m);
    };
    for (const d of doors) {
      const w = d.w || 2.4, h = d.h || 2.8, n = d.steps ?? 4;
      const step = (w / 2 - 0.22) / n;
      for (let i = 0; i < n; i++) {
        const y0 = b0 + h + i * 0.3, inset = (i + 1) * step;
        if (y0 + 0.3 > b1 + 1e-6) break;
        B(d.a - w / 2, y0, d.a - w / 2 + inset, y0 + 0.3, mat);
        B(d.a + w / 2 - inset, y0, d.a + w / 2, y0 + 0.3, mat);
      }
      if (lintel && b0 + h + n * 0.3 + 0.45 <= b1) B(d.a - w / 2 - 0.3, b0 + h + n * 0.3, d.a + w / 2 + 0.3, b0 + h + n * 0.3 + 0.45, this.T.carved, 0.05);
    }
  }
  // A walled room with corbel-vaulted doorways and roof. Doors per side:
  // n (−z), s (+z), e (+x), w (−x), each [{ a, w, h }] with `a` the absolute
  // coordinate along that wall.
  chamber({ x0, z0, x1, z1, h, t = 0.6, y = 0, doors = {}, skip = [], floor = this.T.floor, wall = this.T.stone, roof = true, floorBox = true, roofSteps = 4, roofMat = null, skylight = null }) {
    if (floorBox) this.box(x0 - t, y - 0.5, z0 - t, x1 + t, y, z1 + t, floor);
    if (!skip.includes('s')) this.archWall('z', z1, z1 + t, x0 - t, x1 + t, y, y + h, wall, doors.s || []);
    if (!skip.includes('n')) this.archWall('z', z0 - t, z0, x0 - t, x1 + t, y, y + h, wall, doors.n || []);
    if (!skip.includes('e')) this.archWall('x', x1, x1 + t, z0, z1, y, y + h, wall, doors.e || []);
    if (!skip.includes('w')) this.archWall('x', x0 - t, x0, z0, z1, y, y + h, wall, doors.w || []);
    if (roof) this.corbelRoof(x0 - t, z0 - t, x1 + t, z1 + t, y + h, { axis: x1 - x0 > z1 - z0 ? 'x' : 'z', steps: roofSteps, mat: roofMat || wall, hole: skylight });
  }
  // Corbel-vaulted ceiling over a rectangular room (stepped inward along `axis`).
  // `hole` ({ x0, z0, x1, z1 }) leaves a skylight in the capstones.
  corbelRoof(x0, z0, x1, z1, y, { axis = 'x', steps = 4, rise = 0.35, mat = this.T.stone, cap = 0.5, hole = null } = {}) {
    const span = axis === 'x' ? z1 - z0 : x1 - x0;
    const inset = Math.min(0.5, (span / 2 - 0.5) / steps);
    for (let i = 0; i < steps; i++) {
      const ya = y + i * rise, yb = ya + rise, k = (i + 1) * inset;
      if (axis === 'x') { this.box(x0, ya, z0, x1, yb, z0 + k, mat); this.box(x0, ya, z1 - k, x1, yb, z1, mat); }
      else { this.box(x0, ya, z0, x0 + k, yb, z1, mat); this.box(x1 - k, ya, z0, x1, yb, z1, mat); }
    }
    const yc = y + steps * rise;
    this.wall('y', yc, yc + cap, x0, x1, z0, z1, mat, hole ? [{ a0: hole.x0, a1: hole.x1, b0: hole.z0, b1: hole.z1 }] : []);
  }
  // Steps climbing along z (dir ±1) from (zStart, y0).
  stairs(x0, x1, zStart, dir, y0, n, { rise = 0.3, run = 0.45, mat = this.T.stone, solid = true } = {}) {
    for (let i = 0; i < n; i++) {
      const za = zStart + dir * i * run, zb = za + dir * run;
      this.box(x0, y0, za, x1, y0 + (i + 1) * rise, zb, mat, { solid });
    }
  }
  stairsX(z0, z1, xStart, dir, y0, n, { rise = 0.3, run = 0.45, mat = this.T.stone, solid = true } = {}) {
    for (let i = 0; i < n; i++) {
      const xa = xStart + dir * i * run, xb = xa + dir * run;
      this.box(xa, y0, z0, xb, y0 + (i + 1) * rise, z1, mat, { solid });
    }
  }
  pillar(x, z, y0, h, w = 0.9, { mat = this.T.stone, band = true } = {}) {
    const T = this.T;
    this.box(x - w / 2 - 0.15, y0, z - w / 2 - 0.15, x + w / 2 + 0.15, y0 + 0.3, z + w / 2 + 0.15, T.dark);
    this.box(x - w / 2, y0 + 0.3, z - w / 2, x + w / 2, y0 + h - 0.35, z + w / 2, mat);
    if (band && h > 2.4) this.box(x - w / 2 - 0.03, y0 + h * 0.55, z - w / 2 - 0.03, x + w / 2 + 0.03, y0 + h * 0.55 + 0.5, z + w / 2 + 0.03, T.carved, { solid: false });
    this.box(x - w / 2 - 0.18, y0 + h - 0.35, z - w / 2 - 0.18, x + w / 2 + 0.18, y0 + h, z + w / 2 + 0.18, T.dark);
  }
  // Feathered-serpent head (Kukulkan) facing an axis direction. Returns eye positions.
  serpentHead(origin, facing, s = 1, { eyes = true, solid = true } = {}) {
    const T = this.T;
    const f = snapAxis(facing);
    const r = V3(f.z, 0, -f.x);
    const W = (lx, ly, lz) => V3(origin.x + (r.x * lx + f.x * lz) * s, origin.y + ly * s, origin.z + (r.z * lx + f.z * lz) * s);
    const B = (x0, y0, z0, x1, y1, z1, mat) => { const a = W(x0, y0, z0), b = W(x1, y1, z1); this.box(a.x, a.y, a.z, b.x, b.y, b.z, mat, { solid: false }); };
    B(-0.95, 0, -1.3, 0.95, 0.45, 0.95, T.stone);
    B(-0.72, 0.45, 0.25, 0.72, 0.6, 0.92, T.red);
    B(-1.0, 0.6, -1.4, 1.0, 1.55, 0.75, T.stone);
    B(-0.8, 0.68, 0.75, 0.8, 1.32, 1.45, T.stone);
    B(-0.45, 1.32, 1.05, 0.45, 1.85, 1.48, T.carved);
    B(-1.08, 1.55, -0.25, -0.4, 1.86, 0.62, T.stone);
    B(0.4, 1.55, -0.25, 1.08, 1.86, 0.62, T.stone);
    B(-1.03, 0.98, -1.2, 1.03, 1.14, 0.45, T.red);
    B(-0.82, 1.12, 1.44, 0.82, 1.2, 1.5, T.red);
    for (const sx of [-1, 1]) {
      const fang = new THREE.ConeGeometry(0.09 * s, 0.34 * s, 6);
      fang.rotateX(Math.PI);
      const p = W(sx * 0.52, 0.5, 1.32);
      fang.translate(p.x, p.y, p.z);
      this.addStatic(fang, T.bone);
    }
    // Feather crest fanned behind the head.
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(r, Y_UP, f));
    for (let i = 0; i < 7; i++) {
      const g = new THREE.BoxGeometry(0.34 * s, 1.7 * s, 0.1 * s);
      g.translate(0, 0.85 * s, 0);
      g.applyMatrix4(new THREE.Matrix4().makeRotationX(-0.55));
      g.applyMatrix4(new THREE.Matrix4().makeRotationZ((i - 3) * 0.32));
      g.applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(q));
      const p = W(0, 1.35, -1.25);
      g.translate(p.x, p.y, p.z);
      this.addStatic(g, i % 2 ? T.teal : T.jade);
    }
    if (solid) {
      const a = W(-1.0, 0, -1.4), b = W(1.0, 1.86, 1.5);
      this.block(Math.min(a.x, b.x), a.y, Math.min(a.z, b.z), Math.max(a.x, b.x), b.y, Math.max(a.z, b.z));
    }
    const eyeL = W(-0.86, 1.3, 0.66), eyeR = W(0.86, 1.3, 0.66);
    if (eyes) {
      for (const p of [eyeL, eyeR]) {
        const g = new THREE.SphereGeometry(0.17 * s, 16, 12);
        g.translate(p.x, p.y, p.z);
        this.addStatic(g, T.jade, false);
      }
    }
    return { eyeL, eyeR };
  }
  // ---- carvings, murals and plaques ------------------------------------------
  plaque(lines, pos, normal, w, h, { color = '#2a1a0c', size = 110, glow = 0.22, upHint = null, bg = 'rgb(188,170,134)' } = {}) {
    const tex = this.own(this.game.tex.text(lines, { w: Math.round(256 * (w / h)) * 2, h: 512, size, color, bg, font: FONT_TEMPLE, font2: FONT_TEMPLE, glow: false, border: true, weight: 700 }));
    const mat = this.own(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: glow }));
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    m.position.copy(pos);
    this.orientPlane(m, normal, upHint);
    this.scene.add(m);
    return m;
  }
  mural(pos, normal, w, h, draw, opts = {}) {
    const tex = this.own(this.game.tex.mural(Math.round(w * 220), Math.round(h * 220), draw, opts));
    const mat = this.own(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92, transparent: true, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: opts.glow ?? 0.2 }));
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    m.position.copy(pos);
    this.orientPlane(m, normal, opts.upHint || null);
    this.scene.add(m);
    return m;
  }
  // A single carved glyph on a stone tablet, optionally glowing.
  glyphStone(kind, pos, normal, size = 1, { glow = 0.35, color = 0xffb070, tablet = true } = {}) {
    const T = this.T, tex = this.game.tex;
    const n = snapAxis(normal);
    if (tablet) {
      const d = 0.14, hs = size * 0.55;
      const c = pos.clone().addScaledVector(n, -d / 2);
      const ex = V3(Math.abs(n.x) > 0.5 ? d / 2 : hs, hs, Math.abs(n.z) > 0.5 ? d / 2 : hs);
      if (Math.abs(n.y) > 0.5) ex.set(hs, d / 2, hs);
      this.box(c.x - ex.x, c.y - ex.y, c.z - ex.z, c.x + ex.x, c.y + ex.y, c.z + ex.z, T.stone, { solid: false });
    }
    const mat = this.own(new THREE.MeshStandardMaterial({ map: tex.glyphTex(kind, '#2e1e0e'), transparent: true, roughness: 0.9, emissive: color, emissiveMap: tex.glyphTex(kind, '#ffffff'), emissiveIntensity: glow, depthWrite: false }));
    const m = new THREE.Mesh(new THREE.PlaneGeometry(size * 0.92, size * 0.92), mat);
    m.position.copy(pos).addScaledVector(n, 0.012);
    this.orientPlane(m, n, Math.abs(n.y) > 0.5 ? V3(0, 0, -1) : Y_UP);
    this.scene.add(m);
    return m;
  }
  // ---- light effects -------------------------------------------------------------
  lightColumn(pos, hex, height = 16) {
    const mat = this.own(new THREE.MeshBasicMaterial({ map: this.game.tex.beamFade(), color: new THREE.Color(hex).multiplyScalar(1.1), transparent: true, opacity: 0.3, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, height, 16, 1, true), mat);
    m.position.set(pos.x, pos.y - 0.7 + height / 2, pos.z);
    m.userData.op = 0.3;
    this.scene.add(m);
    return m;
  }
  // A vertical shaft of sun- or moonlight with dust drifting inside.
  shaft(x, z, yTop, yBottom, r = 1.2, color = 0xfff0c8, opacity = 0.2) {
    const mat = this.own(new THREE.MeshBasicMaterial({ map: this.game.tex.beamFade(), color: new THREE.Color(color), transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
    const h = yTop - yBottom;
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.85, r, h, 24, 1, true), mat);
    m.position.set(x, yBottom + h / 2, z);
    this.scene.add(m);
    new ParticleField(this, { count: 70, min: V3(x - r * 0.8, yBottom, z - r * 0.8), max: V3(x + r * 0.8, yTop, z + r * 0.8), color: 0xfff2d0, size: 0.05, intensity: 1.5, opacity: 0.7, drift: V3(0, -0.05, 0), jitter: 0.08 });
    return m;
  }
  skyDome({ top = 0x050a18, horizon = 0x1a2a3a, glow = 0x6a7a9a, moon = V3(-0.35, 0.55, -0.75), moonCol = 0xfff6e0, moonSize = 0.0011, stars = 1 } = {}) {
    this.skyU = {
      uTop: { value: new THREE.Color(top) }, uHorizon: { value: new THREE.Color(horizon) }, uGlow: { value: new THREE.Color(glow) },
      uMoon: { value: moon.clone().normalize() }, uMoonCol: { value: new THREE.Color(moonCol).multiplyScalar(1.6) },
      uTime: { value: 0 }, uStars: { value: stars }, uMoonSize: { value: moonSize },
    };
    const mat = this.own(new THREE.ShaderMaterial({ uniforms: this.skyU, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false, fog: false }));
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(400, 32, 16), mat);
    this.sky.renderOrder = -10;
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);
  }
  moonLight(dir, { color = 0xaebfff, intensity = 1.1, extent = 32, target = V3() } = {}) {
    const l = new THREE.DirectionalLight(color, intensity);
    l.position.copy(target).addScaledVector(dir.clone().normalize(), 70);
    l.target.position.copy(target);
    const q = this.game.quality;
    if (q.shadows) {
      l.castShadow = true;
      l.shadow.mapSize.set(q.shadowSize, q.shadowSize);
      const c = l.shadow.camera;
      c.left = -extent; c.right = extent; c.top = extent; c.bottom = -extent; c.near = 1; c.far = 180;
      l.shadow.bias = -0.0006;
      l.shadow.normalBias = 0.05;
    }
    this.scene.add(l, l.target);
    return l;
  }
  water(x0, z0, x1, z1, y, { deep = 0x020a0a, shallow = 0x0c302c, glint = 0x9fd8ff } = {}) {
    const u = { uTime: { value: 0 }, uDeep: { value: new THREE.Color(deep) }, uShallow: { value: new THREE.Color(shallow) }, uGlint: { value: new THREE.Color(glint) } };
    const mat = this.own(new THREE.ShaderMaterial({ uniforms: u, vertexShader: WATER_VERT, fragmentShader: WATER_FRAG, transparent: true, depthWrite: false }));
    const m = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), mat);
    m.rotation.x = -Math.PI / 2;
    m.position.set((x0 + x1) / 2, y, (z0 + z1) / 2);
    this.scene.add(m);
    this.waterU.push(u);
    return m;
  }
  fireflies(min, max, count = 120) {
    return new ParticleField(this, { count, min, max, color: 0xd8ff7a, size: 0.08, intensity: 2.2, opacity: 0.9, drift: V3(0, 0, 0), jitter: 0.45 });
  }
  dust(min, max, count = 160, color = 0xffe8c0) {
    return new ParticleField(this, { count, min, max, color, size: 0.035, intensity: 1.2, opacity: 0.5 });
  }
  killZone(min, max, message) { return new KillZone(this, { min, max, message }); }
  // The remains of someone who came before.
  bones(x, z, y = 0) {
    const T = this.T, r = this.rnd;
    const skull = new THREE.SphereGeometry(0.13, 12, 9);
    skull.scale(1, 0.9, 1.15);
    skull.translate(x, y + 0.11, z);
    this.addStatic(skull, T.bone);
    for (let i = 0; i < 4; i++) {
      const g = new THREE.CylinderGeometry(0.03, 0.035, 0.42 + r() * 0.2, 6);
      g.rotateZ(Math.PI / 2);
      g.rotateY(r() * TAU);
      g.translate(x + (r() - 0.5) * 0.7, y + 0.04, z + (r() - 0.5) * 0.7);
      this.addStatic(g, T.bone);
    }
  }
  // Glowing exit for a temple level: a carved world tree over a passage.
  templeExit(pos, normal, lines = ['ONWARD', 'deeper into the temple']) {
    this.glyphStone('tree', pos.clone().add(V3(0, 1.05, 0)), normal, 0.9, { glow: 1.6, color: 0x5dffb0 });
    this.plaque(lines, pos, normal, 2.0, 0.75, { size: 140, glow: 0.5 });
    this.point(pos.x + normal.x * 1.4, pos.y + 0.3, pos.z + normal.z * 1.4, 0x7affc0, 10, 8);
  }
  // ---- foliage (instanced alpha cards) ---------------------------------------
  card(kind, x, y, z, yaw, tilt, w, h) {
    (this.fol[kind] || (this.fol[kind] = [])).push({ x, y, z, yaw, tilt, w, h });
  }
  plant(x, y, z, kind = 'broad', scale = 1, n = 0) {
    const r = this.rnd;
    const count = n || (kind === 'grass' ? 3 : kind === 'fern' ? 4 : 5);
    for (let i = 0; i < count; i++) this.card(kind, x, y, z, r() * TAU, 0.15 + r() * 0.45, scale * (0.85 + r() * 0.4), scale * (0.8 + r() * 0.5));
  }
  // Scatter plants inside a rectangle.
  scatter(x0, z0, x1, z1, count, y = 0, kinds = ['broad', 'fern', 'grass'], scale = [0.9, 1.8]) {
    const r = this.rnd;
    for (let i = 0; i < count; i++) this.plant(lerp(x0, x1, r()), y, lerp(z0, z1, r()), kinds[Math.floor(r() * kinds.length)], lerp(scale[0], scale[1], r()));
  }
  tree(x, z, h = 14, rad = 0.55, y = 0) {
    const T = this.T, r = this.rnd;
    const trunk = new THREE.CylinderGeometry(rad * 0.65, rad, h, 10, 3);
    trunk.translate(x, y + h / 2, z);
    this.addStatic(trunk, T.bark);
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * TAU + r();
      const g = new THREE.BoxGeometry(0.16, 1.7, 1.3);
      g.translate(0, 0.85, rad + 0.45);
      g.rotateY(a);
      g.translate(x, y, z);
      this.addStatic(g, T.bark);
    }
    for (let i = 0; i < 16; i++) {
      const a = r() * TAU, d = r() * 3.2;
      this.card('canopy', x + Math.cos(a) * d, y + h - 2.2 + r() * 2.6, z + Math.sin(a) * d, r() * TAU, 0.9 + r() * 0.6, 4 + r() * 3, 4 + r() * 3);
    }
    this.block(x - rad, y, z - rad, x + rad, y + h, z + rad);
  }
  vines(x0, z0, x1, z1, yTop, normal, count, len = [1.5, 4.5]) {
    const r = this.rnd, n = normal.clone().normalize();
    const yaw = Math.atan2(n.x, n.z);
    for (let i = 0; i < count; i++) {
      const t = (i + r() * 0.8) / count, L = lerp(len[0], len[1], r());
      this.card('vine', lerp(x0, x1, t) + n.x * 0.06, yTop - L, lerp(z0, z1, t) + n.z * 0.06, yaw, 0, 0.55 + r() * 0.3, L);
    }
  }
  finishFoliage() {
    const base = new THREE.PlaneGeometry(1, 1);
    base.translate(0, 0.5, 0);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = V3(), sc = V3(), col = new THREE.Color();
    for (const [kind, list] of Object.entries(this.fol)) {
      if (!list.length) continue;
      const mesh = new THREE.InstancedMesh(base.clone(), this.T.leaf[kind], list.length);
      list.forEach((c, i) => {
        e.set(-c.tilt, c.yaw, 0, 'YXZ');
        q.setFromEuler(e);
        p.set(c.x, c.y, c.z);
        sc.set(c.w, c.h, 1);
        m.compose(p, q, sc);
        mesh.setMatrixAt(i, m);
        const k = 0.7 + this.rnd() * 0.45;
        col.setRGB(k * (0.92 + this.rnd() * 0.1), k, k * 0.9);
        mesh.setColorAt(i, col);
      });
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      this.scene.add(mesh);
    }
    base.dispose();
    this.fol = {};
  }
  // ---- per frame -----------------------------------------------------------------
  updateCommon(dt) {
    super.updateCommon(dt);
    const cam = this.game.camera.position;
    const t = this.time;
    for (const f of this.flames) {
      f.g.rotation.y = Math.atan2(cam.x - f.g.position.x, cam.z - f.g.position.z);
      const k = 1 + Math.sin(t * 13 + f.ph) * 0.07 + Math.sin(t * 7.3 + f.ph * 2) * 0.06;
      f.outer.scale.set(2 - k, k, 1);
      f.inner.scale.set(0.55 * (2 - k), 0.55 * (0.9 + (k - 1) * 1.6), 1);
    }
    for (const fl of this.flickers) fl.l.intensity = fl.base * (0.82 + 0.1 * Math.sin(t * 11 + fl.ph) + 0.08 * Math.sin(t * 23.7 + fl.ph * 3));
    for (const u of this.waterU) u.uTime.value += dt;
    if (this.sky) { this.sky.position.copy(cam); this.skyU.uTime.value += dt; }
  }
}

/* =====================================================================
   LEVEL 6 — THE JUNGLE GATE
   A moonlit plaza before a pyramid. The Gate of the Five needs five
   different offerings, each guarded by a small trial: an open altar, a
   platform reached with a push block, a shrine of rising spikes, a door
   sealed by glyph dials, and a cenote crossed on crumbling stones.
   ===================================================================== */
class Level6 extends TempleLevel {
  static meta = { name: 'THE JUNGLE GATE', ambient: 'jungle', part: 2, seed: 6 };
  build() {
    const T = this.T;
    this.relicKinds = ['mask', 'disc', 'blade', 'feather', 'idol'];
    this.setAtmosphere({ bg: 0x0b1522, fog: 0x0d1924, density: 0.017, env: 0.3, hemi: [0x8aa6d6, 0x1e2616, 0.6] });
    this.skyDome({ top: 0x030814, horizon: 0x1a2c40, glow: 0x8090b0, moon: V3(0.5, 0.42, 0.75) });
    this.moonLight(V3(0.5, 0.75, 0.7), { color: 0xb4c4ff, intensity: 1.15, extent: 34, target: V3(0, 0, -2) });
    this.spawn = { pos: V3(0, 0.12, 20.5), up: Y_UP, look: V3(0, 0, -1) };
    this.bounds = { min: V3(-70, -12, -80), max: V3(70, 50, 70) };
    this.hints = [
      'The Gate of the Five needs five different offerings. A pillar of coloured light marks where each one lies.',
      `The Sun Disc rests on a platform too high to climb. Push the loose carved block (${ctl('E', 'USE')}) right up against it, climb onto the block, then jump.`,
      'In the Shrine of Knives the spikes rise in a rhythm. Wait for a row to sink, then walk on.',
      "The Feathered Serpent's door listens to the stela beside it: turn each dial to the glyph above it on the stela, left to right.",
      'The stones in the cenote crumble a moment after you land — keep jumping. They rise again after a few seconds.',
    ];
    this.buildPlaza();
    this.buildGate();
    this.buildPyramid();
    this.buildMaskAltar();
    this.buildVenusPlatform();
    this.buildKnifeShrine();
    this.buildSerpentShrine();
    this.buildCenote();
    this.buildJungle();
    this.finish();
  }
  buildPlaza() {
    const T = this.T;
    // The jungle floor beyond, then the paved plaza with a hole for the cenote.
    const earth = (x0, z0, x1, z1) => this.box(x0, -1.4, z0, x1, -0.06, z1, T.earth, { scale: 6, shadow: false });
    earth(-90, -100, -26, 80);
    earth(26, -100, 90, 80);
    earth(-26, 24, 26, 80);
    earth(-26, -100, -2.5, -24);
    earth(2.5, -100, 26, -24);
    earth(-2.5, -100, 2.5, -38.5);
    this.box(-26, -0.5, -24, 26, 0, 6, T.floorMoss);
    this.box(-26, -0.5, 20, 26, 0, 24, T.floorMoss);
    this.box(-26, -0.5, 6, -22, 0, 20, T.floorMoss);
    this.box(-8, -0.5, 6, 26, 0, 20, T.floorMoss);
    // The white road (sacbe) to the gate.
    this.box(-2.4, 0, -23.9, 2.4, 0.12, 23.6, T.floor);
    this.box(-2.65, 0, -23.9, -2.4, 0.2, 23.6, T.stone);
    this.box(2.4, 0, -23.9, 2.65, 0.2, 23.6, T.stone);
    // Ruined boundary walls and invisible limits.
    const rnd = this.rnd;
    const ruin = (axis, c, a0, a1) => {
      for (let a = a0; a < a1; a += 2) {
        const h = 0.5 + rnd() * 1.3, b = Math.min(a1, a + 2);
        if (axis === 'x') this.box(c - 0.3, 0, a, c + 0.3, h, b, T.mossy);
        else this.box(a, 0, c - 0.3, b, h, c + 0.3, T.mossy);
      }
    };
    ruin('x', -25.7, -24, 24);
    ruin('x', 25.7, -24, 24);
    ruin('z', 23.7, -26, 26);
    ruin('z', -24.3, -26, -14.2);
    ruin('z', -24.3, 14.2, 26);
    this.block(-30, -2, -30, -25.4, 12, 30);
    this.block(25.4, -2, -30, 30, 12, 30);
    this.block(-30, -2, 23.4, 30, 12, 30);
    this.block(-30, -2, -30, -14, 12, -24.05);
    this.block(14, -2, -30, 30, 12, -24.05);
    // Braziers along the road; every other one casts light.
    let i = 0;
    for (const z of [14, 4, -6, -16]) {
      for (const x of [-3.4, 3.4]) {
        this.brazier(x, 0, z, { light: (i + (z === 4 || z === -16 ? 1 : 0)) % 2 === 0, intensity: 16, distance: 13 });
        i++;
      }
    }
    // A stela of welcome near the start.
    this.box(3.3, 0, 18.7, 5.5, 3.4, 19.3, T.carved);
    this.plaque(['THE GATE OF THE FIVE', 'five offerings open the way'], V3(4.4, 1.9, 19.32), V3(0, 0, 1), 1.9, 0.75, { size: 120 });
    this.glyphStone('sun', V3(4.4, 2.95, 19.32), V3(0, 0, 1), 0.7, { tablet: false, glow: 0.6 });
    // Fallen columns and stelae.
    for (const [x, z, h] of [[-10, -19, 2.4], [10, -19, 3.1], [-12, -8, 1.2], [21, 2, 3.6], [-6, 22, 1.4], [8, 21.5, 2.0], [-18, -14, 4.0]]) this.pillar(x, z, 0, h, 0.8);
    for (const [x, z] of [[-9, -2], [9, -9], [-16, 2.5]]) {
      this.box(x - 0.6, 0, z - 0.25, x + 0.6, 2.8, z + 0.25, T.carved);
      this.box(x - 0.75, 0, z - 0.4, x + 0.75, 0.3, z + 0.4, T.dark);
    }
    this.fireflies(V3(-25, 0.4, -23), V3(25, 4.5, 23), 170);
  }
  buildGate() {
    const T = this.T;
    // The great wall of the temple platform, with the gate in a corbel arch.
    this.archWall('z', -26, -24, -14, 14, 0, 6.5, T.stone, [{ a: 0, w: 5, h: 4.6, steps: 4 }]);
    this.box(-14.2, 6.5, -26.2, 14.2, 7.3, -23.8, T.carved);
    this.box(-14.2, 0, -24.1, -2.7, 0.7, -23.85, T.red);
    this.box(2.7, 0, -24.1, 14.2, 0.7, -23.85, T.red);
    this.box(-14.2, 4.95, -24.1, -3.2, 5.35, -23.85, T.red);
    this.box(3.2, 4.95, -24.1, 14.2, 5.35, -23.85, T.red);
    for (const x of [-10.5, 10.5]) this.glyphStone('ajaw', V3(x, 3.0, -23.85), V3(0, 0, 1), 2.2, { glow: 0.25 });
    this.torch(V3(-7, 3.2, -24), V3(0, 0, 1), { intensity: 12, distance: 11 });
    this.torch(V3(7, 3.2, -24), V3(0, 0, 1), { intensity: 12, distance: 11 });
    this.serpentHead(V3(-4.7, 0, -22.75), V3(0, 0, 1), 1.1);
    this.serpentHead(V3(4.7, 0, -22.75), V3(0, 0, 1), 1.1);
    this.plaque(['THE GATE OF THE FIVE'], V3(0, 6.9, -23.78), V3(0, 0, 1), 4.2, 0.62, { size: 150, glow: 0.35 });
    // Platform mass and the tunnel beyond the gate.
    this.box(-14, -3, -38, -2.5, 6.5, -26, T.stone);
    this.box(2.5, -3, -38, 14, 6.5, -26, T.stone);
    this.box(-2.5, 5.8, -38, 2.5, 6.5, -26, T.stone);
    for (let i = 0; i < 4; i++) {
      const k = (i + 1) * 0.57, y = 4.6 + i * 0.3;
      this.box(-2.5, y, -38, -2.5 + k, y + 0.3, -26, T.stone);
      this.box(2.5 - k, y, -38, 2.5, y + 0.3, -26, T.stone);
    }
    this.box(-2.5, -0.5, -30, 2.5, 0, -24, T.floor);
    for (let i = 0; i < 8; i++) this.box(-2.5, -3, -30 - 0.5 * (i + 1), 2.5, -0.3 * (i + 1), -30 - 0.5 * i, T.floor);
    this.box(-2.5, -3.5, -38, 2.5, -2.4, -34, T.floor);
    this.box(-2.5, -3, -38.5, 2.5, 6.5, -38, T.stone);
    this.torch(V3(-2.5, 2.2, -28.5), V3(1, 0, 0), { intensity: 8, distance: 8 });
    this.torch(V3(2.5, 2.2, -28.5), V3(-1, 0, 0), { light: false });
    this.templeExit(V3(0, -1.1, -37.98), V3(0, 0, 1), ['DESCEND', 'the temple waits below']);
    this.exitZone(V3(-2.4, -2.6, -37.8), V3(2.4, 0.5, -34.6));
    // The gate itself: a carved slab with five niches. It sinks when they are filled.
    this.gate = new Door(this, { min: V3(-2.5, 0, -25.3), max: V3(2.5, 4.6, -24.7), slide: V3(0, -4.75, 0), mat: T.carved, strip: false, sound: 'stone', speed: 4.5 });
    for (const [x, y, w, h] of [[0, 2.22, 5.0, 0.16], [0, -2.22, 5.0, 0.16], [-2.42, 0, 0.16, 4.6], [2.42, 0, 0.16, 4.6]]) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.66), T.dark);
      b.position.set(x, y, 0);
      this.gate.mesh.add(b);
    }
    const slots = [['mask', -1.45, 1.15], ['disc', 1.45, 1.15], ['blade', -1.45, 3.4], ['feather', 1.45, 3.4], ['idol', 0, 2.28]]
      .map(([kind, u, v]) => ({ kind, pos: V3(u, v - 2.3, 0.31), normal: V3(0, 0, 1) }));
    this.shrine = new OfferingShrine(this, { parent: this.gate.mesh, slots, onComplete: () => this.openGate() });
    this.gateOpen = this.shrine.complete;
    if (this.gateOpen) this.gate.snap(true);
  }
  openGate() {
    this.gateOpen = true;
    this.gate.open();
    this.game.audio.rumble(4);
    this.game.audio.awaken();
    this.game.player.shake = 2.5;
    this.game.ui.toast('THE GATE OF THE FIVE OPENS', 'good', 4);
    new ParticleField(this, { count: 160, min: V3(-3, 0.1, -25.5), max: V3(3, 5, -22), color: 0xd8c8a8, size: 0.09, intensity: 1, opacity: 0.6, drift: V3(0, 0.3, 0.4), jitter: 0.3 });
  }
  buildPyramid() {
    const T = this.T, zc = -56;
    for (let i = 0; i < 7; i++) {
      const hx = 20 - 2.4 * i, hz = 18 - 2.4 * i, y0 = i * 3.2;
      this.box(-hx, y0, zc - hz, hx, y0 + 3.2, zc + hz, i % 2 ? T.mossy : T.stone, { solid: false, scale: 6 });
      this.box(-hx - 0.06, y0 + 2.55, zc - hz - 0.06, hx + 0.06, y0 + 3.2, zc + hz + 0.06, T.carved, { solid: false });
      if (i < 3) {
        this.vines(-hx + 0.5, zc + hz + 0.08, -4, zc + hz + 0.08, y0 + 3.2, V3(0, 0, 1), 14 - i * 3, [1, 3]);
        this.vines(4, zc + hz + 0.08, hx - 0.5, zc + hz + 0.08, y0 + 3.2, V3(0, 0, 1), 14 - i * 3, [1, 3]);
      }
    }
    this.stairs(-3, 3, -38, -1, 6.5, 40, { rise: 0.4, run: 0.31, solid: false });
    this.stairs(-3.7, -3, -38, -1, 6.75, 40, { rise: 0.4, run: 0.31, solid: false, mat: T.dark });
    this.stairs(3, 3.7, -38, -1, 6.75, 40, { rise: 0.4, run: 0.31, solid: false, mat: T.dark });
    this.serpentHead(V3(-3.35, 6.5, -36.85), V3(0, 0, 1), 0.75, { solid: false });
    this.serpentHead(V3(3.35, 6.5, -36.85), V3(0, 0, 1), 0.75, { solid: false });
    // The temple on the summit, lit from within.
    const zt = zc + 3.5;
    this.box(-4.8, 22.4, zt - 4, 4.8, 27.2, zt + 3.9, T.stone, { solid: false });
    this.box(-5.0, 26.6, zt - 4.2, 5.0, 27.4, zt + 4.1, T.carved, { solid: false });
    this.box(-3.6, 27.4, zt - 0.7, 3.6, 31, zt - 0.1, T.carved, { solid: false });
    for (const x of [-2.6, 0, 2.6]) this.box(x - 0.7, 22.4, zt + 3.85, x + 0.7, 25, zt + 4.0, T.void, { solid: false, shadow: false });
    this.flame(V3(0, 22.6, zt + 3.6), 2.2);
    this.flame(V3(-2.6, 22.6, zt + 3.6), 1.4);
    this.flame(V3(2.6, 22.6, zt + 3.6), 1.4);
  }
  buildMaskAltar() {
    const T = this.T;
    const x = 7, z = 14;
    const alt = new THREE.CylinderGeometry(0.9, 1.05, 0.95, 18);
    alt.translate(x, 0.475, z);
    this.addStatic(alt, T.carved);
    const rim = new THREE.CylinderGeometry(1.0, 1.0, 0.12, 18);
    rim.translate(x, 0.95, z);
    this.addStatic(rim, T.red);
    this.block(x - 0.95, 0, z - 0.95, x + 0.95, 1.0, z + 0.95);
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * TAU + 0.4;
      const sx = x + Math.cos(a) * 2.6, sz = z + Math.sin(a) * 2.6;
      this.box(sx - 0.35, 0, sz - 0.35, sx + 0.35, 2.2 + k * 0.2, sz + 0.35, T.carved);
      this.flame(V3(sx, 2.2 + k * 0.2, sz), 0.6);
    }
    if (!this.found('mask')) new Relic(this, { kind: 'mask', pos: V3(x, 1.7, z) });
  }
  buildVenusPlatform() {
    const T = this.T;
    this.box(9, 0, 0, 15, 2.1, 6, T.carved);
    this.box(8.95, 1.6, -0.05, 15.05, 1.85, 6.05, T.red, { solid: false });
    this.box(8.95, 0, -0.05, 15.05, 0.35, 6.05, T.dark, { solid: false });
    // Its stairs have collapsed into low rubble.
    const rnd = this.rnd;
    for (let i = 0; i < 9; i++) {
      const x = 9.6 + rnd() * 4.8, z = -1.4 - rnd() * 1.6, s = 0.3 + rnd() * 0.4;
      this.box(x - s, 0, z - s, x + s, 0.25 + rnd() * 0.35, z + s, T.stone);
    }
    this.box(11.4, 2.1, 2.4, 12.6, 2.75, 3.6, T.stone);
    this.glyphStone('sun', V3(12, 1.0, 6.01), V3(0, 0, 1), 1.3, { glow: 0.3 });
    if (!this.found('disc')) {
      new Relic(this, { kind: 'disc', pos: V3(12, 3.4, 3) });
      this.pushBlock = new PushBlock(this, { pos: V3(12, 0.55, 10.82), size: V3(1.6, 1.1, 1.6) });
    }
  }
  buildKnifeShrine() {
    const T = this.T;
    this.archWall('x', -14.6, -14, -5, 1, 0, 3.4, T.mossy, [{ a: -2, w: 2.4, h: 2.4, steps: 3 }]);
    this.box(-25, 0, -5, -24.4, 3.4, 1, T.mossy);
    this.box(-24.4, 0, -5, -14.6, 3.4, -4.4, T.mossy);
    this.box(-24.4, 0, 0.4, -14.6, 3.4, 1, T.mossy);
    this.corbelRoof(-25, -5, -14, 1, 3.4, { axis: 'x', steps: 4, rise: 0.35, mat: T.mossy });
    this.box(-22, 5.3, -2.25, -17, 7.2, -1.75, T.carved, { solid: false });
    this.glyphStone('skull', V3(-13.98, 2.5, 0.0), V3(1, 0, 0), 0.8, { glow: 0.3 });
    this.plaque(['SHRINE OF KNIVES'], V3(-13.97, 2.6, -4.1), V3(1, 0, 0), 1.5, 0.45, { size: 130 });
    this.spikes = [-16.4, -18.8, -21.2].map((cx, i) => new SpikeTrap(this, { x0: cx - 0.6, z0: -4.4, x1: cx + 0.6, z1: 0.4, period: 2.4, up: 0.9, warn: 0.45, offset: i * 0.8 }));
    this.box(-24.4, 0, -2.7, -23.1, 1.0, -1.3, T.carved);
    this.torch(V3(-24.4, 2.3, -0.4), V3(1, 0, 0), { intensity: 8, distance: 9 });
    this.torch(V3(-24.4, 2.3, -3.6), V3(1, 0, 0), { light: false });
    this.bones(-20, -3.6);
    this.bones(-17.6, -0.4);
    if (!this.found('blade')) new Relic(this, { kind: 'blade', pos: V3(-23.75, 1.75, -2) });
  }
  buildSerpentShrine() {
    const T = this.T;
    this.archWall('z', -13.6, -13, 13, 23, 0, 3.6, T.stone, [{ a: 18, w: 2.4, h: 2.6, steps: 3 }]);
    this.box(13, 0, -21, 23, 3.6, -20.4, T.stone);
    this.box(13, 0, -20.4, 13.6, 3.6, -13.6, T.stone);
    this.box(22.4, 0, -20.4, 23, 3.6, -13.6, T.stone);
    this.corbelRoof(13, -21, 23, -13, 3.6, { axis: 'x', steps: 4, rise: 0.35 });
    this.box(15, 5.5, -17.3, 21, 7.6, -16.7, T.carved, { solid: false });
    this.box(12.8, 0, -13.1, 23.2, 0.5, -12.8, T.red, { solid: false });
    this.serpentHead(V3(15.6, 0, -11.9), V3(0, 0, 1), 0.6);
    this.serpentHead(V3(20.4, 0, -11.9), V3(0, 0, 1), 0.6);
    this.featherDoor = new Door(this, { min: V3(16.8, 0, -13.45), max: V3(19.2, 2.6, -13.15), slide: V3(0, -2.65, 0), mat: T.carved, strip: false, sound: 'stone', speed: 2.4 });
    this.box(17.4, 0, -19.9, 18.6, 1.0, -18.7, T.carved);
    this.torch(V3(18, 2.4, -20.4), V3(0, 0, 1), { intensity: 8, distance: 8 });
    if (!this.found('feather')) new Relic(this, { kind: 'feather', pos: V3(18, 1.8, -19.3) });
    // Three dials; the stela beside them shows the order.
    const faces = ['sun', 'moon', 'jaguar', 'serpent'];
    this.dialAnswer = [3, 0, 2];
    const start = [0, 1, 3];
    this.dials = [15.6, 18, 20.4].map((x, i) => new GlyphDial(this, { pos: V3(x, 0, -9.6), facing: V3(0, 0, 1), faces, value: start[i], onChange: () => this.checkDials() }));
    this.box(10.6, 0, -10.2, 13.4, 3.4, -9.6, T.stone);
    this.box(10.4, 3.4, -10.4, 13.6, 3.8, -9.4, T.carved);
    this.mural(V3(12, 1.8, -9.58), V3(0, 0, 1), 2.6, 3.0, (x, w, h, pad) => {
      const tex = this.game.tex;
      x.font = `700 ${h * 0.07}px ${FONT_TEMPLE}`;
      x.textAlign = 'center';
      x.fillStyle = '#2a1a0c';
      x.fillText('THE SERPENT LISTENS', w / 2, pad + h * 0.08);
      const s = w * 0.3;
      this.answerGlyphs = this.dialAnswer.map((v) => faces[v]);
      this.answerGlyphs.forEach((k, i) => {
        const cx = w * (0.2 + i * 0.3), cy = h * 0.42;
        tex.carveInto(x, 'cart', cx, cy, s * 1.05);
        tex.carveInto(x, k, cx, cy - s * 0.03, s * 0.75);
      });
      x.font = `600 ${h * 0.05}px ${FONT_TEMPLE}`;
      x.fillText('first · second · third', w / 2, h * 0.66);
      x.strokeStyle = '#2a1a0c'; x.lineWidth = 4;
      x.beginPath(); x.moveTo(w * 0.18, h * 0.74); x.lineTo(w * 0.82, h * 0.74); x.lineTo(w * 0.78, h * 0.71); x.moveTo(w * 0.82, h * 0.74); x.lineTo(w * 0.78, h * 0.77); x.stroke();
    }, { bg: '#b8a682', border: '#4a3418', glow: 0.25 });
    this.featherSolved = !!this.carry.featherDoor;
    if (this.featherSolved) {
      this.dials.forEach((d, i) => d.setValue(this.dialAnswer[i]));
      this.featherDoor.snap(true);
    }
  }
  checkDials() {
    if (this.featherSolved) return;
    if (!this.dials.every((d, i) => d.value === this.dialAnswer[i])) return;
    this.featherSolved = this.carry.featherDoor = true;
    this.featherDoor.open();
    this.game.audio.chime();
    this.game.ui.toast("THE SERPENT'S DOOR OPENS", 'good');
  }
  buildCenote() {
    const T = this.T;
    this.box(-23, -7, 5, -22, -0.5, 21, T.mossy);
    this.box(-8, -7, 5, -7, -0.5, 21, T.mossy);
    this.box(-22, -7, 5, -8, -0.5, 6, T.mossy);
    this.box(-22, -7, 20, -8, -0.5, 21, T.mossy);
    this.box(-22, -8, 6, -8, -7, 20, T.dark);
    this.water(-22, 6, -8, 20, -2.6);
    this.killZone(V3(-22, -9, 6), V3(-8, -2.2, 20), 'THE CENOTE SWALLOWS YOU');
    // Rim stones, with a gap on the east side.
    this.box(-22.6, 0, 5.4, -7.4, 0.6, 6, T.stone);
    this.box(-22.6, 0, 20, -7.4, 0.6, 20.6, T.stone);
    this.box(-22.6, 0, 6, -22, 0.6, 20, T.stone);
    this.box(-8, 0, 6, -7.4, 0.6, 11.6, T.stone);
    this.box(-8, 0, 14.4, -7.4, 0.6, 20, T.stone);
    this.glyphStone('serpent', V3(-7.38, 1.1, 15.6), V3(1, 0, 0), 0.8, { glow: 0.3 });
    // Crumbling stepping stones and the island.
    for (const [x, z] of [[-9.6, 13], [-11.8, 12.3], [-14.0, 13.4], [-16.2, 12.5]]) {
      new CrumbleTile(this, { min: V3(x - 0.7, -7, z - 0.7), max: V3(x + 0.7, -0.05, z + 0.7), mat: T.mossy, delay: 1.0, regen: 4 });
    }
    this.box(-21.9, -7, 10.6, -17.8, -0.05, 15.4, T.mossy);
    this.box(-20.8, -0.05, 12.4, -19.6, 0.85, 13.6, T.carved);
    if (!this.found('idol')) new Relic(this, { kind: 'idol', pos: V3(-20.2, 1.55, 13) });
    this.plant(-21.3, -0.05, 11.2, 'fern', 1.2);
    this.plant(-18.4, -0.05, 15, 'broad', 1.0);
    this.vines(-21.9, 6.05, -8.1, 6.05, -0.5, V3(0, 0, 1), 16, [1.5, 4]);
    this.vines(-21.9, 19.95, -8.1, 19.95, -0.5, V3(0, 0, -1), 16, [1.5, 4]);
    this.vines(-21.95, 6.2, -21.95, 19.8, -0.5, V3(1, 0, 0), 12, [1.5, 4]);
  }
  buildJungle() {
    const r = this.rnd;
    // Plaza edges.
    this.scatter(-25, -22, -22.8, 22, 46);
    this.scatter(22.8, -22, 25, 22, 46);
    this.scatter(-24, 21.5, 24, 23.2, 30, 0, ['grass', 'fern']);
    this.scatter(-7, -23.3, -2.9, -22.6, 8, 0, ['fern', 'grass']);
    this.scatter(2.9, -23.3, 7, -22.6, 8, 0, ['fern', 'grass']);
    this.scatter(-13, -7, -8, 4, 10, 0, ['grass']);
    this.scatter(6, -22, 22, -15, 12, 0, ['grass', 'fern']);
    for (const [x, z, h] of [[-23.5, -21, 13], [23.4, 21, 15], [23.5, -9, 12], [-23.4, 22, 14]]) this.tree(x, z, h, 0.5);
    // The jungle beyond the walls.
    for (let i = 0; i < 46; i++) {
      const a = (i / 46) * TAU + r() * 0.1, d = 31 + r() * 22;
      const x = Math.cos(a) * d * 1.05, z = -2 + Math.sin(a) * d;
      if (z < -30 && Math.abs(x) < 24) continue;
      this.tree(x, z, 12 + r() * 10, 0.5 + r() * 0.35);
    }
    for (let i = 0; i < 80; i++) {
      const a = r() * TAU, d = 28 + r() * 30;
      const x = Math.cos(a) * d, z = Math.sin(a) * d;
      if (z < -30 && Math.abs(x) < 24) continue;
      this.plant(x, -0.06, z, r() < 0.5 ? 'broad' : 'fern', 1.6 + r() * 1.6);
    }
    for (let i = 0; i < 60; i++) {
      const a = r() * TAU, d = 55 + r() * 25;
      this.card('canopy', Math.cos(a) * d, 4 + r() * 10, Math.sin(a) * d, a + Math.PI / 2, 0.1 + r() * 0.4, 12 + r() * 8, 10 + r() * 6);
    }
    this.vines(-14, -23.9, -5.2, -23.9, 6.5, V3(0, 0, 1), 12, [1.5, 4]);
    this.vines(5.2, -23.9, 14, -23.9, 6.5, V3(0, 0, 1), 12, [1.5, 4]);
  }
  update() {
    const n = this.relicKinds.filter((k) => this.found(k)).length;
    if (this.gateOpen) this.objective('The Gate of the Five stands open. Descend into the temple.');
    else if (n < 5) this.objective(`Gather the five offerings for the Gate (${n} / 5). Pillars of light mark where they lie.`);
    else this.objective('Place the five offerings in the Gate of the Five.');
  }
}

/* =====================================================================
   LEVEL 7 — THE HALL OF COUNTING
   Maya numbers are bars and dots. The antechamber teaches them; the
   Counting Floor must be crossed one number at a time; the Corridor of
   Darts hides three murals that count each god's offerings; three
   numeral dials beneath the gods open the way on.
   ===================================================================== */
class Level7 extends TempleLevel {
  static meta = { name: 'THE HALL OF COUNTING', ambient: 'temple', part: 2, seed: 7 };
  build() {
    const T = this.T;
    this.setAtmosphere({ bg: 0x080604, density: 0.028, env: 0.35, hemi: [0x9a8a70, 0x140e08, 0.32] });
    const sp = [
      { pos: V3(0, 0, 10.4), up: Y_UP, look: V3(0, 0, -1) },
      { pos: V3(0, 0, -14.6), up: Y_UP, look: V3(0, 0, -1) },
      { pos: V3(0, 0, -42.2), up: Y_UP, look: V3(0, 0, -1) },
    ];
    this.spawn = sp[Math.min(this.cp, 2)];
    this.bounds = { min: V3(-30, -12, -80), max: V3(30, 30, 30) };
    this.hints = [
      'Maya numbers are written with dots and bars: a dot is one, a bar is five, a shell is zero. The mural in the antechamber shows them all.',
      'On the Counting Floor, step on the numbers in order — one, two, three… up to thirteen. The next number is always right beside you; any other stone falls.',
      'The dart holes glow just before they fire. Cross a lane right after its volley. The alcoves between the lanes are safe.',
      'Each alcove mural counts the offerings one god received. Set the dial beneath each god to that number.',
      'Count carefully: the Sun received seven, the Moon four, the Jaguar six. Seven is a bar and two dots.',
    ];
    this.answers = [7, 4, 6];
    this.buildAntechamber();
    this.buildCountingFloor();
    this.buildDartCorridor();
    this.buildGodsChamber();
    this.finish();
  }
  buildAntechamber() {
    const T = this.T, tex = this.game.tex;
    this.chamber({ x0: -5, z0: 0, x1: 5, z1: 12, h: 4.6, doors: { n: [{ a: 0, w: 2.4, h: 2.8 }], s: [{ a: 0, w: 2.4, h: 2.8 }] } });
    // The way you came in, choked with rubble.
    const r = this.rnd;
    for (let i = 0; i < 4; i++) this.box(-1.2, 0, 12.6 + i * 0.45, 1.2, 0.3 * (i + 1), 13.05 + i * 0.45, T.stone);
    this.box(-1.6, 0, 13.6, 1.6, 4, 14.2, T.dark);
    for (let i = 0; i < 10; i++) { const x = (r() - 0.5) * 2.2, z = 12.1 + r() * 0.5, s = 0.25 + r() * 0.3; this.box(x - s, 0, z - s, x + s, 0.3 + r() * 1.8, z + s * 0.6, T.dark); }
    this.block(-1.2, 0, 12, 1.2, 3, 12.6);
    // Murals: the numerals, and the rule of the Counting Floor.
    this.mural(V3(-4.97, 2.2, 6), V3(1, 0, 0), 7.2, 3.2, (x, w, h, pad) => {
      x.textAlign = 'center';
      x.font = `700 ${h * 0.085}px ${FONT_TEMPLE}`;
      x.fillStyle = '#f0d9a8';
      x.fillText('THE COUNT OF THE GODS', w / 2, pad + h * 0.08);
      const s = h * 0.2;
      for (let n = 0; n <= 13; n++) {
        const row = n < 7 ? 0 : 1, col = n % 7;
        const cx = w * (0.1 + col * 0.133), cy = pad + h * (0.2 + row * 0.29);
        x.drawImage(tex.glyphCanvas(`num:${n}`, '#1d120a', 256), cx - s / 2, cy - s / 2, s, s);
        x.font = `700 ${h * 0.06}px ${FONT_TEMPLE}`;
        x.fillStyle = '#f0d9a8';
        x.fillText(String(n), cx, cy + s * 0.6);
      }
      x.font = `600 ${h * 0.05}px ${FONT_TEMPLE}`;
      x.fillText('A DOT IS ONE · A BAR IS FIVE · THE SHELL IS NOTHING', w / 2, h - pad - h * 0.05);
    });
    this.mural(V3(4.97, 2.2, 6), V3(-1, 0, 0), 6.0, 3.2, (x, w, h, pad) => {
      x.textAlign = 'center';
      x.font = `700 ${h * 0.08}px ${FONT_TEMPLE}`;
      x.fillStyle = '#f0d9a8';
      x.fillText('COUNT YOUR STEPS TO THE GODS', w / 2, pad + h * 0.08);
      const s = h * 0.17;
      for (let i = 0; i < 4; i++) {
        const sx = w * (0.14 + i * 0.17), sy = h * (0.78 - i * 0.12);
        x.fillStyle = 'rgba(20,12,6,0.55)';
        x.fillRect(sx - w * 0.08, sy, w * 0.17, h * 0.8 - sy + h * 0.06);
        x.drawImage(tex.glyphCanvas(`num:${i + 1}`, '#f0d9a8', 256), sx - s / 2, sy - s * 1.05, s, s);
      }
      x.drawImage(tex.glyphCanvas('sun', '#f2c05a', 256), w * 0.8 - s * 0.9, h * 0.3 - s * 0.9, s * 1.8, s * 1.8);
      x.font = `600 ${h * 0.05}px ${FONT_TEMPLE}`;
      x.fillStyle = '#f0d9a8';
      x.fillText('ONE STEP AFTER ANOTHER · A FALSE STEP IS A FALL', w / 2, h - pad - h * 0.05);
    }, { bg: '#2a5a54' });
    this.box(-0.8, 0, 6.2, 0.8, 1.1, 7.8, T.carved);
    this.glyphStone('ajaw', V3(0, 1.62, 7), V3(0, 1, 0), 1.2, { tablet: false, glow: 0.2 });
    this.brazier(-3.9, 0, 1.4, { intensity: 14, distance: 12 });
    this.brazier(3.9, 0, 1.4, { intensity: 14, distance: 12 });
    this.brazier(-3.9, 0, 10.8, { light: false });
    this.brazier(3.9, 0, 10.8, { light: false });
    this.vines(-5, 0.05, 5, 0.05, 4.6, V3(0, 0, 1), 6, [0.8, 2]);
    this.dust(V3(-5, 0.2, 0), V3(5, 4.5, 12), 90);
  }
  buildCountingFloor() {
    const T = this.T, tex = this.game.tex;
    const Z0 = -16, Z1 = -0.6;
    this.chamber({ x0: -5, z0: Z0, x1: 5, z1: Z1, h: 5, floorBox: false, skip: ['s'], doors: { n: [{ a: 0, w: 2.4, h: 2.8 }] } });
    // Extend the walls down into the pit.
    this.box(-5.6, -6, Z0 - 0.6, -5, 0, Z1, T.dark);
    this.box(5, -6, Z0 - 0.6, 5.6, 0, Z1, T.dark);
    // Entry and exit ledges, the pit and its spikes.
    this.box(-5, -6, -2.0, 5, 0, Z1, T.floor);
    this.box(-5, -6, Z0, 5, 0, -13.3, T.floor);
    this.box(-5, -6.5, -13.3, 5, -6, -2.0, T.dark);
    const spikeGeo = new THREE.ConeGeometry(0.08, 0.9, 6);
    for (let i = 0; i < 70; i++) {
      const g = spikeGeo.clone();
      g.translate((this.rnd() - 0.5) * 9.6, -5.55, -2.2 - this.rnd() * 10.9);
      this.addStatic(g, T.bronze);
    }
    spikeGeo.dispose();
    this.bones(-2, -6, -6.0);
    this.bones(2.6, -10, -6.0);
    this.killZone(V3(-5, -8, -13.3), V3(5, -2.2, -2.0), 'YOU MISCOUNTED — THE FLOOR GAVE WAY');
    this.point(0, -4, -7.6, 0xff4a2a, 18, 12);
    // The tiles: the path counts 1 → 13; every other stone is false.
    const path = [[1, 0], [1, 1], [2, 1], [3, 1], [3, 2], [3, 3], [2, 3], [1, 3], [1, 4], [1, 5], [2, 5], [3, 5], [3, 6]];
    const val = Array.from({ length: 7 }, () => new Array(5).fill(-1));
    path.forEach(([c, r], i) => { val[r][c] = i + 1; });
    const at = (c, r) => (r >= 0 && r < 7 && c >= 0 && c < 5 ? val[r][c] : -1);
    const rnd = mulberry32(707);
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 5; c++) {
        if (val[r][c] > 0) continue;
        for (let tries = 0; tries < 200; tries++) {
          const v = Math.floor(rnd() * 20);
          let bad = (r === 0 && v === 1);
          for (let dr = -1; dr <= 1 && !bad; dr++) for (let dc = -1; dc <= 1; dc++) {
            const n = at(c + dc, r + dr);
            if (n > 0 && path[n - 1] && v === n + 1) bad = true;
          }
          if (!bad) { val[r][c] = v; break; }
        }
      }
    }
    this.tileVals = val;
    this.tiles = [];
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 5; c++) {
        const x = -3.2 + 1.6 * c, z = -2.85 - 1.6 * r, v = val[r][c];
        const face = tex.tileFace(`num:${v}`);
        const top = this.own(new THREE.MeshStandardMaterial({ map: face.map, roughness: 0.85, emissive: 0xffa050, emissiveMap: face.em, emissiveIntensity: 0.16 }));
        const safe = path.some(([pc, pr]) => pc === c && pr === r);
        this.tiles.push(new CrumbleTile(this, { min: V3(x - 0.75, -0.45, z - 0.75), max: V3(x + 0.75, 0, z + 0.75), mat: T.stone, top, safe, delay: 0.35 }));
      }
    }
    for (let r = 0; r < 6; r++) this.box(-4, -0.9, -2.85 - 1.6 * r - 0.85, 4, -0.5, -2.85 - 1.6 * r - 0.75, T.dark, { solid: false });
    this.mural(V3(0, 2.4, Z1 - 0.03), V3(0, 0, -1), 3.4, 1.0, (x, w, h, pad) => {
      x.textAlign = 'center';
      x.font = `700 ${h * 0.26}px ${FONT_TEMPLE}`;
      x.fillStyle = '#f0d9a8';
      x.fillText('ONE · TWO · THREE …', w / 2, h * 0.6);
    });
    this.mural(V3(0, 3.6, Z0 + 0.03), V3(0, 0, 1), 3.0, 0.9, (x, w, h) => {
      const s = h * 0.62;
      for (let i = 0; i < 3; i++) x.drawImage(tex.glyphCanvas(`num:${11 + i}`, '#f0d9a8', 256), w * (0.25 + i * 0.25) - s / 2, h / 2 - s / 2, s, s);
    });
    this.torch(V3(-5, 2.6, -1.3), V3(1, 0, 0), { intensity: 9, distance: 10 });
    this.torch(V3(5, 2.6, -14.6), V3(-1, 0, 0), { intensity: 9, distance: 10 });
    this.torch(V3(5, 2.6, -1.3), V3(-1, 0, 0), { light: false });
    this.torch(V3(-5, 2.6, -14.6), V3(1, 0, 0), { light: false });
    this.bones(-3.6, -1.2);
    new Trigger(this, { min: V3(-5, 0, -16), max: V3(5, 4, -13.4), onEnter: () => this.setCheckpoint(1) });
  }
  buildDartCorridor() {
    const T = this.T, tex = this.game.tex;
    const Z0 = -40, Z1 = -16.6;
    this.box(-2.1, -0.5, Z0, 2.1, 0, Z1, T.floor);
    this.box(-2.1, 0, Z0, -1.5, 3.4, Z1, T.carved);
    this.alcoves = [-22.6, -28.2, -33.8];
    this.wall('x', 1.5, 2.1, Z0, Z1, 0, 3.4, T.carved, this.alcoves.map((c) => ({ a0: c - 0.8, a1: c + 0.8, b0: -1, b1: 2.6 })));
    this.corbelRoof(-2.1, Z0, 2.1, Z1, 3.4, { axis: 'z', steps: 3, rise: 0.35 });
    // Alcoves with the murals that count each god's offerings.
    const gods = [['sun', 'THE SUN', 'disc', 7], ['moon', 'THE MOON', 'gem', 4], ['jaguar', 'THE JAGUAR', 'feather', 6]];
    this.alcoves.forEach((c, i) => {
      this.box(2.1, -0.5, c - 1.4, 3.9, 0, c + 1.4, T.floor);
      this.box(3.3, 0, c - 1.4, 3.9, 3.0, c + 1.4, T.stone);
      this.box(2.1, 0, c - 1.4, 3.3, 3.0, c - 0.8, T.stone);
      this.box(2.1, 0, c + 0.8, 3.3, 3.0, c + 1.4, T.stone);
      this.box(2.1, 2.6, c - 0.8, 3.3, 3.0, c + 0.8, T.stone);
      const [god, name, icon, n] = gods[i];
      this.mural(V3(3.28, 1.45, c), V3(-1, 0, 0), 1.5, 2.0, (x, w, h, pad) => {
        x.textAlign = 'center';
        const s = w * 0.42;
        x.drawImage(tex.glyphCanvas('cart', '#f0d9a8', 256), w / 2 - s * 0.55, pad + h * 0.02, s * 1.1, s * 1.1);
        x.drawImage(tex.glyphCanvas(god, '#f2c05a', 256), w / 2 - s * 0.4, pad + h * 0.05, s * 0.8, s * 0.8);
        x.font = `700 ${h * 0.055}px ${FONT_TEMPLE}`;
        x.fillStyle = '#f0d9a8';
        x.fillText(`${name} RECEIVED`, w / 2, pad + h * 0.43);
        const per = 4, is = w * 0.19;
        for (let k = 0; k < n; k++) {
          const row = Math.floor(k / per), col = k % per, inRow = Math.min(per, n - row * per);
          const cx = w / 2 + (col - (inRow - 1) / 2) * is * 1.12, cy = pad + h * (0.55 + row * 0.15);
          x.drawImage(tex.glyphCanvas(icon, '#1d120a', 256), cx - is / 2, cy - is / 2, is, is);
        }
      }, { glow: 0.32 });
      this.flame(V3(2.4, 0.05, c + 1.05), 0.45);
    });
    // Four lanes of darts, firing in a rolling wave.
    this.lanes = [-19.8, -25.4, -31.0, -36.6];
    this.darts = this.lanes.map((z, i) => new DartTrap(this, { origin: V3(-1.5, 0, z), dir: V3(1, 0, 0), length: 3.0, period: 1.9, warn: 0.6, offset: i * 0.47 }));
    for (const z of this.lanes) this.box(1.45, 0, z - 0.7, 1.5, 1.9, z + 0.7, T.dark, { solid: false });
    this.torch(V3(-1.5, 2.5, -17.6), V3(1, 0, 0), { intensity: 8, distance: 9 });
    this.torch(V3(-1.5, 2.5, -39.0), V3(1, 0, 0), { intensity: 8, distance: 9 });
    this.plaque(['THE CORRIDOR OF DARTS', 'the gods count the careless too'], V3(0, 2.25, Z1 - 0.04), V3(0, 0, -1), 2.4, 0.7, { size: 110 });
    this.bones(0.6, -27.0);
    this.bones(-0.8, -34.2);
  }
  buildGodsChamber() {
    const T = this.T;
    const Z0 = -54, Z1 = -40.6;
    this.chamber({ x0: -6, z0: Z0, x1: 6, z1: Z1, h: 6.5, wall: T.carved, roofMat: T.stone, doors: { s: [{ a: 0, w: 2.4, h: 2.8 }], n: [{ a: 0, w: 3, h: 3.2 }] } });
    new Trigger(this, { min: V3(-6, 0, -47), max: V3(6, 4, -40.6), onEnter: () => this.setCheckpoint(2) });
    const gods = ['sun', 'moon', 'jaguar'];
    const faces = Array.from({ length: 10 }, (_, n) => `num:${n}`);
    this.dials = [-3.6, 0, 3.6].map((x, i) => new GlyphDial(this, { pos: V3(x, 0, -48.6), facing: V3(0, 0, 1), faces, value: 0, title: gods[i], radius: 0.78, height: 0.95, label: 'Turn the numeral dial', onChange: () => this.checkDials() }));
    gods.forEach((g, i) => this.glyphStone(g, V3([-3.6, 0, 3.6][i], 5.5, Z0 + 0.01), V3(0, 0, 1), 1.3, { glow: 0.5 }));
    this.door = new Door(this, { min: V3(-1.5, 0, Z0 - 0.45), max: V3(1.5, 3.2, Z0 - 0.15), slide: V3(0, -3.25, 0), mat: T.stone, strip: false, sound: 'stone', speed: 3 });
    for (const x of [-4.6, 4.6]) this.pillar(x, -44.2, 0, 6.5, 0.9);
    for (const x of [-4.6, 4.6]) this.pillar(x, -51.8, 0, 6.5, 0.9);
    this.brazier(-5.2, 0, -48.6, { intensity: 16, distance: 14 });
    this.brazier(5.2, 0, -48.6, { intensity: 16, distance: 14 });
    this.serpentHead(V3(-2.6, 0, -53.0), V3(0, 0, 1), 0.65);
    this.serpentHead(V3(2.6, 0, -53.0), V3(0, 0, 1), 0.65);
    this.plaque(['THE CHAMBER OF THE THREE', 'give each god its due'], V3(0, 4.2, Z1 - 0.04), V3(0, 0, -1), 3.0, 0.8, { size: 110 });
    // The way on.
    this.box(-1.5, -0.5, -60, 1.5, 0, Z0 - 0.6, T.floor);
    this.box(-2.1, 0, -60, -1.5, 3.4, Z0 - 0.6, T.stone);
    this.box(1.5, 0, -60, 2.1, 3.4, Z0 - 0.6, T.stone);
    this.box(-2.1, 3.4, -60, 2.1, 3.9, Z0 - 0.6, T.stone);
    this.box(-2.1, 0, -60.6, 2.1, 3.9, -60, T.stone);
    this.templeExit(V3(0, 1.5, -59.97), V3(0, 0, 1));
    this.exitZone(V3(-1.5, 0, -59.6), V3(1.5, 3, -57));
    this.dust(V3(-6, 0.2, -54), V3(6, 6, -40.6), 120);
  }
  checkDials() {
    if (this.solved) return;
    if (!this.dials.every((d, i) => d.value === this.answers[i])) return;
    this.solved = true;
    this.door.open();
    this.game.audio.chime();
    this.game.ui.toast('THE GODS ARE SATISFIED', 'good');
  }
  update() {
    const z = this.game.player.pos.z;
    if (z > -0.6) this.objective('Learn how the gods count, then go on to the Counting Floor.');
    else if (z > -13.3) this.objective('Cross the Counting Floor: step on the numbers in order, one to thirteen.');
    else if (z > -40.6) this.objective('Run the Corridor of Darts, and read the murals in its alcoves.');
    else if (this.solved) this.objective('The door is open. Leave the Hall of Counting.');
    else this.objective("Set each god's dial to the number of offerings it received.");
  }
}
/* =====================================================================
   LEVEL 8 — THE SERPENT'S EYE
   Sunlight enters through slits in the walls. Bronze mirrors turn it, a
   jade prism splits it, and one mirror rides a stone block that must be
   pushed into place. Light both eyes of the serpent facade and its mouth
   opens onto the Bridge of Blades.
   ===================================================================== */
class Level8 extends TempleLevel {
  static meta = { name: "THE SERPENT'S EYE", ambient: 'sunlit', part: 2, seed: 8 };
  build() {
    const T = this.T;
    this.setAtmosphere({ bg: 0x1c140c, density: 0.016, env: 0.5, hemi: [0xffe6c0, 0x3a2a18, 0.5] });
    const sp = [
      { pos: V3(3, 0, 4.2), up: Y_UP, look: V3(-0.35, 0, -1) },
      { pos: V3(0, 0, -15.6), up: Y_UP, look: V3(0, 0, -1) },
      { pos: V3(0, 0, -38.6), up: Y_UP, look: V3(0, 0, -1) },
    ];
    this.spawn = sp[Math.min(this.cp, 2)];
    this.bounds = { min: V3(-30, -40, -90), max: V3(30, 30, 30) };
    this.hints = [
      `Sunlight enters through the slit in the west wall. Turn the bronze mirrors (${ctl('E', 'USE')}) to guide the beam into the jade eye on the north wall.`,
      'A mirror only reflects from its polished face; light that strikes the stone back stops. The golden mirrors are set in stone.',
      'In the Court of the Serpent the jade prism splits the light in two. Each beam must reach one eye of the serpent.',
      'One mirror stands on a loose stone. Push it into the empty corner of the light path, then turn it.',
      'On the Bridge of Blades, wait for a blade to swing past, then go. The cracked stones in the middle crumble — keep moving.',
    ];
    this.net = new BeamNetwork(this);
    this.buildHallOfMirrors();
    this.buildCourt();
    this.buildBridge();
    this.finish();
  }
  // Sunlight through a narrow slit in a wall, as a beam source.
  sunSlit(x, z, y, dir) {
    const T = this.T;
    this.net.addSource(V3(x, y, z), dir);
    const n = dir.clone().negate();
    const glow = this.own(new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 2.6, 1.8) }));
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.8), glow);
    m.position.set(x + n.x * 0.5, y, z + n.z * 0.5);
    this.orientPlane(m, dir, Y_UP);
    this.scene.add(m);
    const halo = this.own(new THREE.MeshBasicMaterial({ map: this.game.tex.glowSprite(), color: new THREE.Color(1.6, 1.2, 0.7), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    const h = new THREE.Mesh(new THREE.PlaneGeometry(3, 3), halo);
    h.position.set(x + dir.x * 0.05, y, z + dir.z * 0.05);
    this.orientPlane(h, dir, Y_UP);
    this.scene.add(h);
    this.glyphStone('sun', V3(x + dir.x * 0.02, y + 1.1, z + dir.z * 0.02), dir, 0.8, { glow: 0.9, tablet: false });
  }
  // A skylight: real light from above plus a visible shaft.
  skylight(x, z, yTop, { shadow = true, intensity = 260 } = {}) {
    this.spot(V3(x, yTop + 4, z), V3(x, 0, z), { color: 0xffe8c4, intensity, angle: 0.62, penumbra: 0.7, distance: 40, shadow });
    this.shaft(x, z, yTop, 0, 1.5, 0xfff0c8, 0.055);
    const sky = this.own(new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 2.0, 1.7) }));
    const m = new THREE.Mesh(new THREE.PlaneGeometry(3, 3), sky);
    m.rotation.x = Math.PI / 2;
    m.position.set(x, yTop + 1.9, z);
    this.scene.add(m);
  }
  buildHallOfMirrors() {
    const T = this.T, net = this.net;
    // Walls: the west wall has the sun slit.
    this.box(-10.6, -0.5, -14.6, 10.6, 0, 6.6, T.floor);
    this.archWall('z', 6, 6.6, -10.6, 10.6, 0, 9, T.stone, []);
    this.archWall('z', -14.6, -14, -10.6, 10.6, 0, 9, T.carved, [{ a: 0, w: 3, h: 3.4, steps: 4 }]);
    this.wall('x', 10, 10.6, -14, 6, 0, 9, T.stone);
    this.wall('x', -10.6, -10, -14, 6, 0, 9, T.stone, [{ a0: 1.7, a1: 2.3, b0: 0.95, b1: 1.75 }]);
    this.corbelRoof(-10.6, -14.6, 10.6, 6.6, 9, { axis: 'z', steps: 4, hole: { x0: -1.5, z0: -5.5, x1: 1.5, z1: -2.5 } });
    this.skylight(0, -4, 11.4);
    this.sunSlit(-10.3, 2, 1.35, V3(1, 0, 0));
    // Mirrors. The two golden ones are fixed; the bronze ones turn.
    const A = this.cp >= 1;
    const mk = (x, z, state, sol, fixed = false) => new SunMirror(this, net, { pos: V3(x, 0, z), state: A ? sol : state, fixed });
    this.mA = [mk(-8, 2, 2, 2, true), mk(-8, -6, 1, 0), mk(-4, -6, 0, 2), mk(-4, -10, 0, 0, true), mk(4, -10, 1, 2), mk(0, -6, 3, 3), mk(-8, -10, 1, 1)];
    // The jade eye of Kinich Ahau on the north wall.
    this.box(2.6, 0.2, -14, 5.4, 2.6, -13.75, T.red, { solid: false });
    this.glyphStone('ajaw', V3(4, 2.5, -13.74), V3(0, 0, 1), 1.1, { glow: 0.2 });
    this.solvedA = A;
    this.eyeA = new BeamReceiver(this, net, { pos: V3(4, 1.35, -13.55), radius: 0.3, onChange: (on) => { if (on) this.solveA(); } });
    this.doorA = new Door(this, { min: V3(-1.5, 0, -14.45), max: V3(1.5, 3.4, -14.15), slide: V3(0, -3.45, 0), mat: T.carved, strip: false, sound: 'stone', speed: 3 });
    if (A) this.doorA.snap(true);
    // Dressing.
    for (const z of [3.5, -2, -7.5, -12.4]) this.pillar(8.9, z, 0, 9, 1.0);
    for (const z of [-2, -12.4]) this.pillar(-9.0, z, 0, 9, 0.9);
    this.brazier(6.6, 0, 4.6, { intensity: 14, distance: 13 });
    this.brazier(-6.6, 0, -12.6, { light: false });
    this.plaque(['THE HALL OF MIRRORS', 'what the sun sees, the serpent sees'], V3(0, 6.2, 5.97), V3(0, 0, -1), 4, 1.0, { size: 110 });
    this.mural(V3(-9.97, 3.6, -6), V3(1, 0, 0), 5, 2.4, (x, w, h, pad) => {
      const tex = this.game.tex, s = h * 0.36;
      x.textAlign = 'center';
      x.font = `700 ${h * 0.09}px ${FONT_TEMPLE}`;
      x.fillStyle = '#f0d9a8';
      x.fillText('THE SUN WALKS · THE BRONZE TURNS', w / 2, pad + h * 0.1);
      x.drawImage(tex.glyphCanvas('sun', '#f2c05a', 256), w * 0.15 - s / 2, h * 0.55 - s / 2, s, s);
      x.strokeStyle = '#f2c05a'; x.lineWidth = 6;
      x.beginPath(); x.moveTo(w * 0.24, h * 0.55); x.lineTo(w * 0.5, h * 0.55); x.lineTo(w * 0.5, h * 0.3); x.lineTo(w * 0.78, h * 0.3); x.stroke();
      x.fillStyle = '#1d120a';
      for (const [px, py] of [[0.5, 0.55], [0.5, 0.3]]) { x.save(); x.translate(w * px, h * py); x.rotate(Math.PI / 4); x.fillRect(-s * 0.3, -s * 0.06, s * 0.6, s * 0.12); x.restore(); }
      x.drawImage(tex.glyphCanvas('ajaw', '#3dd68a', 256), w * 0.85 - s / 2, h * 0.3 - s / 2, s, s);
    }, { bg: '#2a5a54' });
    this.dust(V3(-10, 0.2, -14), V3(10, 8.5, 6), 140, 0xfff0d0);
  }
  solveA() {
    if (this.solvedA) return;
    this.solvedA = true;
    this.doorA.open();
    this.game.ui.toast('THE SUN GOD SEES', 'good');
  }
  buildCourt() {
    const T = this.T, net = this.net;
    const B = this.cp >= 2;
    this.box(-8.6, -0.5, -34.6, 8.6, 0, -14.6, T.floor);
    this.wall('x', 8, 8.6, -34, -14.6, 0, 10, T.stone);
    this.wall('x', -8.6, -8, -34, -14.6, 0, 10, T.stone, [{ a0: -20.4, a1: -19.6, b0: 2.35, b1: 3.25 }]);
    this.archWall('z', -34.6, -34, -8.6, 8.6, 0, 10, T.carved, [{ a: 0, w: 2.6, h: 2.2, steps: 0 }], { lintel: false });
    this.corbelRoof(-8.6, -34.6, 8.6, -14.6, 10, { axis: 'z', steps: 4, hole: { x0: -1.5, z0: -26, x1: 1.5, z1: -23 } });
    this.skylight(0, -24.5, 12.4, { shadow: false, intensity: 200 });
    this.sunSlit(-8.3, -20, 2.8, V3(1, 0, 0));
    this.prism = new BeamPrism(this, net, { pos: V3(0, 0, -20), height: 2.8 });
    const mk = (x, z, state, sol) => new SunMirror(this, net, { pos: V3(x, 0, z), state: B ? sol : state, height: 2.8 });
    this.mB = [mk(0, -28, 0, 3), mk(-2, -28, 0, 1), mk(0, -18, 0, 1)];
    this.block = new PushBlock(this, { pos: B ? V3(2, 0.5, -18) : V3(4, 0.5, -26), size: V3(1.6, 1.0, 1.6) });
    this.blockMirror = new SunMirror(this, net, { pos: V3(4, 0, -26), state: B ? 2 : 0, carrier: this.block, height: 1.8 });
    // The serpent facade: its mouth is the door, its eyes take the light.
    this.solvedB = B;
    this.eyes = [-2, 2].map((x) => new BeamReceiver(this, net, { pos: V3(x, 2.8, -33.35), radius: 0.32, onChange: () => this.checkEyes() }));
    for (const sx of [-1, 1]) {
      this.box(sx * 1.3, 0, -34, sx * 2.0, 2.2, -33.5, T.red);
      this.box(sx * 1.4, 3.15, -34, sx * 2.8, 3.5, -33.35, T.stone);
      this.box(sx * 2.45, 2.2, -34, sx * 3.2, 3.15, -33.5, T.carved, { solid: false });
      this.box(sx * 1.2, 2.2, -34, sx * 1.55, 3.15, -33.5, T.carved, { solid: false });
    }
    this.box(-3.4, 2.2, -34, 3.4, 2.5, -33.4, T.red);
    this.box(-0.9, 2.5, -34, 0.9, 4.2, -33.2, T.carved);
    this.box(-0.6, 4.2, -34, 0.6, 4.8, -33.4, T.stone, { solid: false });
    for (const fx of [-1.0, -0.45, 0.45, 1.0]) {
      const f = new THREE.ConeGeometry(0.08, 0.34, 6);
      f.rotateX(Math.PI);
      f.translate(fx, 2.03, -33.55);
      this.addStatic(f, T.bone);
    }
    for (let i = 0; i < 9; i++) {
      const g = new THREE.BoxGeometry(0.5, 3.2, 0.12);
      g.translate(0, 1.6, 0);
      g.applyMatrix4(new THREE.Matrix4().makeRotationZ((i - 4) * 0.28));
      g.translate(0, 4.6, -33.9);
      this.addStatic(g, i % 2 ? T.teal : T.jade);
    }
    this.mouth = new Door(this, { min: V3(-1.3, 0, -34.45), max: V3(1.3, 2.2, -34.15), slide: V3(0, -2.25, 0), mat: T.dark, strip: false, sound: 'stone', speed: 2.6 });
    if (B) this.mouth.snap(true);
    new Trigger(this, { min: V3(-8, 0, -20), max: V3(8, 4, -14.6), onEnter: () => this.setCheckpoint(1) });
    for (const [x, z] of [[-6.6, -16.4], [6.6, -16.4], [-6.6, -32.4], [6.6, -32.4]]) this.pillar(x, z, 0, 10, 1.0);
    this.torch(V3(8, 2.6, -24), V3(-1, 0, 0), { intensity: 10, distance: 12 });
    this.torch(V3(-8, 2.0, -27), V3(1, 0, 0), { light: false });
    this.plaque(['THE COURT OF THE SERPENT', 'two eyes · one sun'], V3(0, 6.5, -14.63), V3(0, 0, -1), 3.6, 0.9, { size: 110 });
    this.dust(V3(-8, 0.2, -34), V3(8, 9.5, -14.6), 130, 0xfff0d0);
  }
  checkEyes() {
    if (this.solvedB || !this.eyes.every((e) => e.lit)) return;
    this.solvedB = true;
    this.mouth.open();
    this.game.audio.rumble(2.5);
    this.game.player.shake = 1.2;
    this.game.ui.toast('THE SERPENT OPENS ITS MOUTH', 'good');
  }
  buildBridge() {
    const T = this.T;
    // Passage through the mouth.
    this.box(-1.9, -0.5, -37.6, 1.9, 0, -34.6, T.floor);
    this.box(-1.9, 0, -37, -1.3, 2.8, -34.6, T.dark);
    this.box(1.3, 0, -37, 1.9, 2.8, -34.6, T.dark);
    this.box(-1.9, 2.2, -37, 1.9, 2.8, -34.6, T.dark);
    // The chasm hall.
    const Z0 = -66, Z1 = -37;
    this.wall('x', -6.6, -6, Z0, Z1, -30, 9, T.dark);
    this.wall('x', 6, 6.6, Z0, Z1, -30, 9, T.dark);
    this.archWall('z', Z1, Z1 + 0.6, -6.6, 6.6, 0, 9, T.dark, [{ a: 0, w: 2.6, h: 2.2, steps: 0 }], { lintel: false });
    this.box(-6.6, -30, Z1, 6.6, 0, Z1 + 0.6, T.dark);
    this.archWall('z', Z0 - 0.6, Z0, -6.6, 6.6, 0, 9, T.dark, [{ a: 0, w: 2.4, h: 2.8 }]);
    this.box(-6.6, -30, Z0 - 0.6, 6.6, 0, Z0, T.dark);
    this.corbelRoof(-6.6, Z0 - 0.6, 6.6, Z1 + 0.6, 9, { axis: 'z', steps: 4, mat: T.dark });
    this.box(-6, -0.5, -40, 6, 0, Z1, T.floor);
    this.box(-6, -6, -40.4, 6, 0, -40, T.dark);
    this.box(-6, -0.5, Z0, 6, 0, -62, T.floor);
    this.box(-6, -6, -62, 6, 0, -61.6, T.dark);
    this.box(-6, -31, Z0, 6, -30, Z1, T.dark);
    this.killZone(V3(-6, -40, -62), V3(6, -3, -40), 'YOU FELL INTO THE DARK');
    // The bridge, with a cracked section in the middle.
    this.box(-0.9, -0.5, -49.3, 0.9, 0, -40, T.stone);
    this.box(-0.9, -0.5, -62, 0.9, 0, -52.5, T.stone);
    for (const z of [-49.3, -50.9]) new CrumbleTile(this, { min: V3(-0.9, -0.5, z - 1.6), max: V3(0.9, 0, z), mat: T.mossy, delay: 0.45, regen: 3 });
    for (let z = -41; z > -62; z -= 3) this.box(-0.6, -6, z - 0.4, 0.6, -0.5, z + 0.4, T.dark, { solid: false });
    // Four swinging blades.
    this.blades = [[-43.4, 2.6, 0], [-47.2, 3.0, 1.7], [-55.4, 2.8, 3.4], [-59.0, 2.4, 0.9]].map(([z, period, phase]) => new Pendulum(this, { pivot: V3(0, 7.6, z), axis: 'z', length: 6.6, amp: 0.75, period, phase }));
    for (const b of this.blades) this.box(-0.3, 7.6, b.pivot.z - 0.3, 0.3, 9.4, b.pivot.z + 0.3, T.bronze, { solid: false });
    this.point(0, -14, -51, 0xff3a1a, 60, 30);
    new ParticleField(this, { count: 160, min: V3(-6, -20, -62), max: V3(6, -2, -40), color: 0xff8a5a, size: 0.06, intensity: 1.4, opacity: 0.6, drift: V3(0, 0.5, 0), jitter: 0.1 });
    new Trigger(this, { min: V3(-6, 0, -40), max: V3(6, 4, -37.6), onEnter: () => this.setCheckpoint(2) });
    this.torch(V3(-6, 2.4, -38.6), V3(1, 0, 0), { intensity: 9, distance: 10 });
    this.torch(V3(6, 2.4, -63.6), V3(-1, 0, 0), { light: false });
    this.plaque(['THE BRIDGE OF BLADES'], V3(0, 4.2, Z1 - 0.03), V3(0, 0, -1), 3.2, 0.6, { size: 130 });
    // Exit.
    this.box(-1.2, -0.5, -70, 1.2, 0, Z0 - 0.6, T.floor);
    this.box(-1.8, 0, -70, -1.2, 3.4, Z0 - 0.6, T.dark);
    this.box(1.2, 0, -70, 1.8, 3.4, Z0 - 0.6, T.dark);
    this.box(-1.8, 3.4, -70, 1.8, 3.9, Z0 - 0.6, T.dark);
    this.box(-1.8, 0, -70.6, 1.8, 3.9, -70, T.dark);
    this.templeExit(V3(0, 1.5, -69.97), V3(0, 0, 1));
    this.exitZone(V3(-1.2, 0, -69.6), V3(1.2, 3, -67.4));
  }
  update() {
    const z = this.game.player.pos.z;
    if (z > -14.6) this.objective(this.solvedA ? 'The way is open. Go on to the Court of the Serpent.' : 'Turn the bronze mirrors to guide the sunlight into the jade eye.');
    else if (z > -34.6) this.objective(this.solvedB ? 'The serpent has opened its mouth. Go through.' : `Light both eyes of the serpent (${this.eyes.filter((e) => e.lit).length} / 2). The prism splits the sun in two.`);
    else this.objective('Cross the Bridge of Blades.');
  }
}
/* =====================================================================
   LEVEL 9 — THE TRIAL OF TRAPS
   A gauntlet in the tomb beneath the temple: a hall of swinging blades,
   a hall of fire, a chamber whose ceiling falls when the Heart of Jade
   is taken, and a long stair down which a great stone rolls.
   ===================================================================== */
class Level9 extends TempleLevel {
  static meta = { name: 'THE TRIAL OF TRAPS', ambient: 'tomb', part: 2, seed: 9 };
  build() {
    const T = this.T;
    // The heart only stays yours once you are past the falling sky, and
    // placing it always re-arms the stone.
    if (this.cp < 3) this.carry.found = [];
    else this.carry.found = ['heart'];
    this.carry.placed = [];
    this.relicKinds = ['heart'];
    this.setAtmosphere({ bg: 0x060403, density: 0.032, env: 0.3, hemi: [0x7a6a58, 0x0a0604, 0.28] });
    const sp = [
      { pos: V3(0, 0, 4.4), up: Y_UP, look: V3(0, 0, -1) },
      { pos: V3(0, 0, -23.6), up: Y_UP, look: V3(0, 0, -1) },
      { pos: V3(0, 0, -41.6), up: Y_UP, look: V3(0, 0, -1) },
      { pos: V3(-1.5, 0, -52.4), up: Y_UP, look: V3(1, 0, -0.6) },
    ];
    this.spawn = sp[Math.min(this.cp, 3)];
    this.bounds = { min: V3(-30, -30, -120), max: V3(30, 30, 30) };
    this.hints = [
      'Each blade swings in its own rhythm, and you can stand safely between two of them. Go when the next blade swings away.',
      'The fire vents burn in two alternating rows. Cross a row the moment its flames die, then wait in the gap for the next.',
      'Taking the Heart of Jade wakes the Chamber of the Falling Sky. Run for the north door the moment it opens.',
      `When you lay the Heart on its altar, run down the stair — ${ctl('hold SHIFT to sprint', 'push the stick all the way to sprint')} — and turn right into the side passage at the bottom.`,
    ];
    this.buildEntry();
    this.buildBlades();
    this.buildFire();
    this.buildFallingSky();
    this.buildRun();
    this.finish();
  }
  buildEntry() {
    const T = this.T;
    this.chamber({ x0: -3, z0: 0, x1: 3, z1: 6, h: 4, wall: T.dark, doors: { n: [{ a: 0, w: 2.4, h: 2.8 }] } });
    this.plaque(['THE TRIAL OF TRAPS', 'only the swift and the patient pass'], V3(0, 2.0, 5.97), V3(0, 0, -1), 3.2, 1.0, { size: 110, glow: 0.3 });
    this.torch(V3(-3, 2.4, 3), V3(1, 0, 0), { intensity: 9, distance: 10 });
    this.torch(V3(3, 2.4, 3), V3(-1, 0, 0), { light: false });
    this.bones(1.8, 1.2);
    this.glyphStone('skull', V3(0, 3.35, 0.02), V3(0, 0, 1), 0.7, { glow: 0.5, color: 0xff6040 });
  }
  buildBlades() {
    const T = this.T;
    const Z0 = -22, Z1 = -0.6;
    this.chamber({ x0: -1.8, z0: Z0, x1: 1.8, z1: Z1, h: 7.5, wall: T.dark, skip: ['s'], doors: { n: [{ a: 0, w: 2.4, h: 2.8 }] }, roofSteps: 3 });
    const specs = [[-3.4, 2.2, 0.0], [-6.0, 2.6, 1.9], [-8.6, 2.0, 3.7], [-11.2, 2.8, 0.9], [-13.8, 2.3, 2.6], [-16.4, 2.5, 4.4], [-19.0, 2.1, 1.2]];
    this.blades = specs.map(([z, period, phase]) => new Pendulum(this, { pivot: V3(0, 7.0, z), axis: 'z', length: 6.0, amp: 0.62, period, phase }));
    for (const b of this.blades) {
      const z = b.pivot.z;
      this.box(-1.8, 0.15, z - 0.06, -1.74, 4.2, z + 0.06, T.void, { solid: false, shadow: false });
      this.box(1.74, 0.15, z - 0.06, 1.8, 4.2, z + 0.06, T.void, { solid: false, shadow: false });
      this.box(-0.25, 7.0, z - 0.25, 0.25, 8.6, z + 0.25, T.bronze, { solid: false });
    }
    this.torch(V3(-1.8, 2.6, -2.0), V3(1, 0, 0), { intensity: 8, distance: 10 });
    this.torch(V3(1.8, 2.6, -9.9), V3(-1, 0, 0), { intensity: 8, distance: 10 });
    this.torch(V3(-1.8, 2.6, -15.1), V3(1, 0, 0), { light: false });
    this.torch(V3(1.8, 2.6, -20.6), V3(-1, 0, 0), { intensity: 8, distance: 10 });
    this.bones(-0.9, -9.9);
    this.bones(0.8, -14.9);
  }
  buildFire() {
    const T = this.T;
    const Z0 = -40, Z1 = -22.6;
    this.chamber({ x0: -5, z0: Z0, x1: 5, z1: Z1, h: 6, wall: T.dark, skip: ['s'], doors: { n: [{ a: 0, w: 2.4, h: 2.8 }] } });
    new Trigger(this, { min: V3(-5, 0, -25), max: V3(5, 4, -22.6), onEnter: () => this.setCheckpoint(1) });
    this.rows = [-26.5, -30, -33.5, -37];
    this.jets = [];
    this.rows.forEach((z, r) => {
      for (const x of [-4, -2, 0, 2, 4]) this.jets.push(new FlameJet(this, { pos: V3(x, 0, z), period: 4, on: 1.3, offset: r % 2 ? 2.0 : 0, warn: 0.6, height: 3.0, radius: 1.0 }));
      this.box(-5, 0.0, z - 0.03, -4.95, 3.5, z + 0.03, T.void, { solid: false, shadow: false });
    });
    this.fireLight = this.point(0, 2.5, -31.8, 0xff7a2a, 0, 22);
    this.door = new Door(this, { min: V3(-1.2, 0, Z0 - 0.45), max: V3(1.2, 2.8, Z0 - 0.15), slide: V3(0, -2.85, 0), mat: T.carved, strip: false, sound: 'stone', speed: 1.6 });
    this.lever = new StoneLever(this, { pos: V3(3.4, 1.1, Z0), normal: V3(0, 0, 1), label: 'Pull the lever', onPull: () => { this.door.open(); this.game.ui.toast('THE WAY OPENS', 'good'); } });
    this.torch(V3(-5, 2.6, -39), V3(1, 0, 0), { intensity: 8, distance: 10 });
    this.plaque(['THE HALL OF FIRE'], V3(0, 4.4, Z1 - 0.03), V3(0, 0, -1), 2.6, 0.55, { size: 130 });
  }
  buildFallingSky() {
    const T = this.T;
    const Z0 = -50, Z1 = -40.6;
    this.chamber({ x0: -4, z0: Z0, x1: 4, z1: Z1, h: 6.4, wall: T.carved, skip: ['s'], doors: { n: [{ a: 0, w: 2.4, h: 2.8 }] }, roof: false });
    this.box(-4.6, 6.4, Z0 - 0.6, 4.6, 7.2, Z1, T.dark);
    new Trigger(this, { min: V3(-4, 0, -43), max: V3(4, 4, -40.6), onEnter: () => this.setCheckpoint(2) });
    this.box(-0.6, 0, -45.9, 0.6, 1.0, -44.7, T.carved);
    this.box(-0.75, 1.0, -46.05, 0.75, 1.12, -44.55, T.gold, { solid: false });
    this.ceilY = 6.35;
    this.ceiling = new THREE.Mesh(new THREE.BoxGeometry(8, 0.5, 9.4), T.carved);
    this.ceiling.position.set(0, this.ceilY + 0.25, (Z0 + Z1) / 2);
    this.ceiling.castShadow = true;
    this.scene.add(this.ceiling);
    for (let i = 0; i < 4; i++) {
      const s = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.5, 6), T.bronze);
      s.rotation.x = Math.PI;
      s.position.set(-3 + i * 2, -0.45, 0);
      this.ceiling.add(s);
    }
    this.skyZone = this.killZone(V3(-4, 50, Z0), V3(4, 60, Z1), 'CRUSHED BY THE FALLING SKY');
    this.exitDoor = new Door(this, { min: V3(-1.2, 0, Z0 - 0.45), max: V3(1.2, 2.8, Z0 - 0.15), slide: V3(0, -2.85, 0), mat: T.carved, strip: false, sound: 'stone', speed: 2.4 });
    this.torch(V3(-4, 2.4, -45.3), V3(1, 0, 0), { intensity: 10, distance: 11 });
    this.torch(V3(4, 2.4, -45.3), V3(-1, 0, 0), { light: false });
    this.plaque(['THE FALLING SKY', 'what you take, the tomb takes back'], V3(0, 3.6, Z0 + 0.03), V3(0, 0, 1), 3, 0.8, { size: 110 });
    this.skyFalling = false;
    if (this.cp >= 3) {
      this.ceilY = 0.6;
      this.ceiling.position.y = this.ceilY + 0.25;
      this.door.snap(false);
      this.exitDoor.snap(false);
    } else {
      new Relic(this, { kind: 'heart', pos: V3(0, 1.75, -45.3), beacon: false, onTake: () => this.dropSky() });
    }
  }
  dropSky() {
    this.skyFalling = true;
    this.door.close();
    this.exitDoor.open();
    this.game.audio.rumble(3);
    this.game.player.shake = 1.5;
    this.game.ui.toast('THE SKY IS FALLING — RUN!', 'warn', 3);
    this.dust(V3(-4, 0.5, -50), V3(4, 6, -40.6), 120, 0xc8b898);
  }
  buildRun() {
    const T = this.T;
    // The dais with the altar of the Heart.
    this.chamber({ x0: -3, z0: -56, x1: 3, z1: -50.6, h: 6, wall: T.dark, skip: ['s', 'n'], roof: false });
    this.box(-3.6, 6, -56.6, 3.6, 6.6, -50.6, T.dark);
    this.box(-1.0, 6.0, -53.4, 1.0, 6.6, -51.0, T.void, { solid: false, shadow: false });
    new Trigger(this, { min: V3(-3, 0, -55), max: V3(3, 4, -51.2), onEnter: () => { if (this.found('heart')) this.setCheckpoint(3); } });
    this.box(2.0, 0, -54.4, 3, 1.0, -52.8, T.carved);
    const altar = new THREE.Group();
    altar.position.set(2.0, 1.55, -53.6);
    this.scene.add(altar);
    this.box(2.6, 1.0, -54.3, 3, 2.2, -52.9, T.carved, { solid: false });
    this.heartShrine = new OfferingShrine(this, { parent: altar, slots: [{ kind: 'heart', pos: V3(0, 0, 0), normal: V3(-1, 0, 0) }], onComplete: () => this.startRun() });
    this.plaque(['THE ALTAR OF THE STONE'], V3(2.98, 3.0, -53.6), V3(-1, 0, 0), 2.2, 0.5, { size: 120 });
    this.torch(V3(-3, 2.4, -53.6), V3(1, 0, 0), { intensity: 9, distance: 10 });
    this.gate = new Door(this, { min: V3(-2, 0, -56.45), max: V3(2, 3.2, -56.15), slide: V3(0, -3.25, 0), mat: T.dark, strip: false, sound: 'stone', speed: 1.0 });
    this.box(-3.6, 0, -56.6, -2, 6, -56, T.dark);
    this.box(2, 0, -56.6, 3.6, 6, -56, T.dark);
    this.box(-2, 3.2, -56.6, 2, 6, -56, T.dark);
    // The long stair down.
    const floorY = (z) => (z > -58 ? 0 : Math.max(-8.8, -0.2 * (-58 - z)));
    this.box(-2, -0.5, -58, 2, 0, -56, T.floor);
    for (let i = 0; i < 44; i++) {
      const za = -58 - i, zb = -59 - i, y = -0.2 * (i + 1);
      this.box(-2, y - 0.5, zb, 2, y, za, T.floor);
      this.box(-2.6, y - 0.5, zb, -2, y + 4.5, za, T.dark);
      if (!(zb < -98.4 && za > -101.6)) this.box(2, y - 0.5, zb, 2.6, y + 4.5, za, T.dark);
      this.box(-2.6, y + 4.5, zb, 2.6, y + 5.0, za, T.dark);
    }
    this.box(-2.6, -9.5, -102.6, 2.6, -4, -102, T.dark);
    // The side passage and the way out.
    this.box(2, -9.3, -101.4, 9, -8.8, -98.6, T.floor);
    this.box(2, -8.8, -102, 9, -5.4, -101.4, T.dark);
    this.box(2, -8.8, -98.6, 9, -5.4, -98, T.dark);
    this.box(2, -5.4, -102, 9, -4.9, -98, T.dark);
    this.box(9, -8.8, -102, 9.6, -4.9, -98, T.dark);
    this.templeExit(V3(8.97, -7.4, -100), V3(-1, 0, 0), ['ONWARD', 'to the heart of the world']);
    this.exitZone(V3(4.5, -9, -101.4), V3(8.8, -6, -98.6));
    for (const z of [-66, -80, -94]) this.torch(V3(-2, floorY(z) + 2.6, z), V3(1, 0, 0), { intensity: 8, distance: 11, light: z !== -80 });
    this.boulder = new Boulder(this, { start: V3(0, 7.5, -52.2), endZ: -100.4, radius: 1.5, floorY, accel: 3, vmax: 7, onCrash: () => this.game.ui.toast('THE STONE IS STILL', 'good') });
  }
  startRun() {
    this.gate.open();
    this.game.audio.rumble(1.4);
    this.game.player.shake = 1;
    this.game.ui.toast('RUN!', 'warn', 3);
    this.runT = 1.0;
  }
  update(dt) {
    if (this.runT > 0) { this.runT -= dt; if (this.runT <= 0) this.boulder.release(); }
    // The falling sky.
    if (this.skyFalling && this.ceilY > 0.6) {
      this.ceilY = Math.max(0.6, this.ceilY - dt * 0.9);
      this.ceiling.position.y = this.ceilY + 0.25;
      this.skyZone.min.y = this.ceilY - 0.45;
      this.skyZone.max.y = this.ceilY + 1;
      this.game.player.shake = Math.max(this.game.player.shake, 0.15);
    }
    // Fire light follows the flames.
    let k = 0;
    for (const j of this.jets) k += j.k;
    this.fireLight.intensity = 5 + k * 1.1;
    const z = this.game.player.pos.z, y = this.game.player.pos.y;
    if (z > -22.6) this.objective('Pass the Hall of Blades.');
    else if (z > -40.6) this.objective(this.door.target ? 'The way is open. Go on.' : 'Cross the Hall of Fire and pull the lever on the far wall.');
    else if (z > -50.6) this.objective(this.found('heart') ? 'The sky is falling — get out through the north door!' : 'Take the Heart of Jade from the altar.');
    else if (!this.heartShrine.complete && !this.heartShrine.queue.length) this.objective('Lay the Heart of Jade on the Altar of the Stone.');
    else if (y > -8) this.objective('RUN! Down the stair and into the side passage at the bottom.');
    else this.objective('Into the side passage — out of the stone\'s path.');
  }
}
/* =====================================================================
   LEVEL 10 — THE FIVE DIRECTIONS
   The heart of the pyramid: a World Tree with a niche for each direction.
   Red East (dawn light and mirrors), white North (sums in bars and dots),
   black West (crumbling stones and darts in the dark), yellow South (push
   the blocks onto the plates). With four stones set, steps rise around
   the tree to the green heart of the world — and the temple lets you go.
   ===================================================================== */
class Level10 extends TempleLevel {
  static meta = { name: 'THE FIVE DIRECTIONS', ambient: 'sanctum', part: 2, seed: 10 };
  build() {
    const T = this.T;
    this.relicKinds = ['east', 'north', 'west', 'south', 'center'];
    this.setAtmosphere({ bg: 0x07060a, density: 0.018, env: 0.35, hemi: [0x8a8aa8, 0x1a120a, 0.34] });
    this.skyDome({ top: 0x050a1c, horizon: 0x1c2440, glow: 0x5a6a9a, moon: V3(-0.3, 0.75, 0.5), stars: 1, moonSize: 0.0009 });
    this.spawn = { pos: V3(0, 0, 6.6), up: Y_UP, look: V3(0, 0.15, -1) };
    this.bounds = { min: V3(-60, -40, -60), max: V3(60, 80, 60) };
    this.hints = [
      'Each passage leads to one direction and its stone: red East, white North, black West, yellow South. Their colours glow above the doorways.',
      'East: guide the dawn light into the eye to lift the cage. North: each dial wants the sum carved above it, written in bars and dots.',
      'West: the stones crumble under you and darts cross the dark. Watch the dart holes glow, then keep moving.',
      'South: push both carved blocks onto the sun plates. A block pushed against a wall is stuck — R resets the chamber.',
      'When the four stones are set, steps rise around the World Tree. Climb them to the green heart of the world and set it in the tree.',
    ];
    this.finale = null;
    this.net = new BeamNetwork(this, { color: 0xffc890 });
    this.buildHub();
    this.buildEast();
    this.buildNorth();
    this.buildWest();
    this.buildSouth();
    this.buildExterior();
    this.finish();
  }
  // A corridor between the hub and a chamber, along an axis.
  passage(axis, a0, a1) {
    const T = this.T;
    if (axis === 'x') {
      this.box(a0, -0.5, -2.1, a1, 0, 2.1, T.floor);
      this.box(a0, 0, -2.1, a1, 3.6, -1.5, T.stone);
      this.box(a0, 0, 1.5, a1, 3.6, 2.1, T.stone);
      this.corbelRoof(a0, -2.1, a1, 2.1, 3.6, { axis: 'z', steps: 3, rise: 0.3 });
    } else {
      this.box(-2.1, -0.5, a0, 2.1, 0, a1, T.floor);
      this.box(-2.1, 0, a0, -1.5, 3.6, a1, T.stone);
      this.box(1.5, 0, a0, 2.1, 3.6, a1, T.stone);
      this.corbelRoof(-2.1, a0, 2.1, a1, 3.6, { axis: 'x', steps: 3, rise: 0.3 });
    }
  }
  // A carved cage over a stone's altar; lifts away when the puzzle is solved.
  cage(x, z, kind) {
    const T = this.T;
    this.box(x - 0.7, 0, z - 0.7, x + 0.7, 1.0, z + 0.7, T.carved);
    this.box(x - 0.8, 1.0, z - 0.8, x + 0.8, 1.1, z + 0.8, T.gold, { solid: false });
    const g = new THREE.Group();
    g.position.set(x, 1.1, z);
    for (const [dx, dz] of [[-0.75, -0.75], [0.75, -0.75], [-0.75, 0.75], [0.75, 0.75], [0, -0.75], [0, 0.75], [-0.75, 0], [0.75, 0]]) {
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 1.6, 6), T.gold);
      bar.position.set(dx, 0.8, dz);
      g.add(bar);
    }
    const lid = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.16, 1.7), T.carved);
    lid.position.y = 1.65;
    g.add(lid);
    this.scene.add(g);
    const door = { g, t: 0, open: false, solid: this.world.addBox(x - 0.8, 1.1, z - 0.8, x + 0.8, 2.85, z + 0.8, null, 'static') };
    if (!this.found(kind)) door.relic = new Relic(this, { kind, pos: V3(x, 1.75, z) });
    if (door.relic) door.relic.range = 0;
    this.cages = this.cages || [];
    this.cages.push(door);
    return door;
  }
  openCage(c, silent = false) {
    if (c.open) return;
    c.open = true;
    c.solid.enabled = false;
    if (c.relic) c.relic.range = 3.4;
    if (silent) { c.t = 1; c.g.position.y = 1.1 + 2.6; return; }
    this.game.audio.stoneGrind(1.2, 0.8);
    this.game.audio.chime();
  }
  buildHub() {
    const T = this.T;
    this.chamber({ x0: -8, z0: -8, x1: 8, z1: 8, h: 14, wall: T.carved, roofMat: T.stone, skylight: { x0: -2, z0: -2, x1: 2, z1: 2 },
      doors: { n: [{ a: 0, w: 3, h: 3.4 }], s: [{ a: 0, w: 3, h: 3.4 }], e: [{ a: 0, w: 3, h: 3.4 }], w: [{ a: 0, w: 3, h: 3.4 }] } });
    // Moonlight through the oculus.
    this.spot(V3(-2.5, 26, 3), V3(0, 0, 0), { color: 0xb8c8ff, intensity: 900, angle: 0.3, penumbra: 0.6, distance: 60 });
    this.shaft(0, 0, 15.9, 0, 2.0, 0xb8c8ff, 0.05);
    // The World Tree.
    this.box(-0.9, 0, -0.9, 0.9, 7.2, 0.9, T.carved);
    for (const [x0, z0, x1, z1] of [[-1.7, -0.5, -0.9, 0.5], [0.9, -0.5, 1.7, 0.5], [-0.5, -1.7, 0.5, -0.9], [-0.5, 0.9, 0.5, 1.7]]) this.box(x0, 0, z0, x1, 0.7, z1, T.dark);
    this.box(-1.0, 2.2, -1.0, 1.0, 2.5, 1.0, T.jade, { solid: false });
    this.box(-1.0, 4.4, -1.0, 1.0, 4.7, 1.0, T.red, { solid: false });
    this.box(-2.6, 5.0, -2.6, 2.6, 5.4, 2.6, T.stone);
    this.box(-2.7, 5.0, -2.7, 2.7, 5.15, 2.7, T.gold, { solid: false });
    this.box(-3.2, 7.6, -0.4, 3.2, 8.1, 0.4, T.carved);
    this.box(-0.4, 7.6, -3.2, 0.4, 8.1, 3.2, T.carved);
    this.box(-1.1, 7.2, -1.1, 1.1, 8.6, 1.1, T.jade);
    for (const [x, z] of [[3.2, 0], [-3.2, 0], [0, 3.2], [0, -3.2]]) {
      const g = new THREE.SphereGeometry(0.35, 14, 10);
      g.translate(x, 7.85, z);
      this.addStatic(g, T.jade);
    }
    this.glyphStone('tree', V3(0, 3.4, 0.91), V3(0, 0, 1), 1.2, { tablet: false, glow: 0.4, color: 0x5dffb0 });
    this.treeGlow = this.point(0, 3, 0, 0x5dffb0, 0, 16);
    // Niches for the four directions, and the heart's niche above the platform.
    const root = new THREE.Group();
    this.scene.add(root);
    this.treeShrine = new OfferingShrine(this, {
      parent: root,
      slots: [
        { kind: 'east', pos: V3(0.92, 1.35, 0), normal: V3(1, 0, 0) },
        { kind: 'north', pos: V3(0, 1.35, -0.92), normal: V3(0, 0, -1) },
        { kind: 'west', pos: V3(-0.92, 1.35, 0), normal: V3(-1, 0, 0) },
        { kind: 'south', pos: V3(0, 1.35, 0.92), normal: V3(0, 0, 1) },
      ],
      onComplete: () => this.awakenTree(),
    });
    this.heartShrine = new OfferingShrine(this, { parent: root, slots: [{ kind: 'center', pos: V3(0, 6.5, 0.92), normal: V3(0, 0, 1) }], onComplete: () => this.game.startFinale() });
    // Steps that rise around the tree once the four stones are set.
    const ring = [[3.5, 2.0], [3.5, 0], [3.5, -2.0], [2.0, -3.5], [0, -3.5], [-2.0, -3.5], [-3.5, -2.0], [-3.5, 0], [-3.5, 2.0]];
    this.steps = ring.map(([x, z], i) => {
      const top = 0.55 * (i + 1);
      return new RisingBlock(this, { min: V3(x - 0.7, top - 0.5, z - 0.7), max: V3(x + 0.7, top, z + 0.7), mat: T.carved, depth: top + 0.6 });
    });
    // Coloured glyphs above each doorway point the way.
    for (const [kind, x, z, n, col] of [['sun', 8, 0, V3(-1, 0, 0), 0xff5a46], ['moon', 0, -8, V3(0, 0, 1), 0xf0f0ff], ['jaguar', -8, 0, V3(1, 0, 0), 0x9a7cff], ['serpent', 0, 8, V3(0, 0, -1), 0xffd84a]]) {
      this.glyphStone(kind, V3(x + n.x * 0.01, 6.0, z + n.z * 0.01), n, 1.6, { glow: 0.9, color: col });
    }
    this.brazier(-5.6, 0, -5.6, { intensity: 14, distance: 14 });
    this.brazier(5.6, 0, 5.6, { intensity: 14, distance: 14 });
    this.brazier(5.6, 0, -5.6, { light: false });
    this.brazier(-5.6, 0, 5.6, { light: false });
    this.plaque(['THE HEART OF THE WORLD', 'four corners · one centre'], V3(0, 10, 7.97), V3(0, 0, -1), 4.4, 1.1, { size: 110, glow: 0.3 });
    this.dust(V3(-8, 0.2, -8), V3(8, 13, 8), 160, 0xd8e0ff);
    // Restore progress after a respawn.
    if (this.treeShrine.complete) this.awakenTree(true);
  }
  awakenTree(silent = false) {
    if (this.awake) return;
    this.awake = true;
    this.treeGlow.intensity = 18;
    this.steps.forEach((s, i) => s.rise(i * 0.35, silent));
    if (!this.found('center')) this.heartRelic = new Relic(this, { kind: 'center', pos: V3(0, 6.9, 2.1) });
    if (!silent) {
      this.game.audio.awaken();
      this.game.player.shake = 1.5;
      this.game.ui.toast('THE WORLD TREE AWAKENS', 'good', 4);
    }
  }
  buildEast() {
    const T = this.T, net = this.net;
    this.passage('x', 8.6, 17.4);
    this.chamber({ x0: 18, z0: -6, x1: 30, z1: 6, h: 7, wall: T.red, roofMat: T.stone, doors: { w: [{ a: 0, w: 3, h: 3.2 }] }, skip: [] });
    // The dawn slit in the east wall.
    this.box(30, 0.95, 3.6, 30.6, 1.75, 4.4, T.void, { solid: false, shadow: false });
    net.addSource(V3(29.9, 1.35, 4), V3(-1, 0, 0));
    const glow = this.own(new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 1.9, 1.2) }));
    const pl = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.8), glow);
    pl.position.set(29.98, 1.35, 4);
    pl.rotation.y = -Math.PI / 2;
    this.scene.add(pl);
    this.glyphStone('sun', V3(29.98, 2.6, 4), V3(-1, 0, 0), 0.9, { glow: 0.9, color: 0xff9050, tablet: false });
    const mk = (x, z, state) => new SunMirror(this, net, { pos: V3(x, 0, z), state });
    this.mE = [mk(22, 4, 0), mk(22, -2, 2), mk(26, -2, 0)];
    this.mE.sol = [1, 0, 2];
    this.eyeE = new BeamReceiver(this, net, { pos: V3(26, 1.35, -5.6), radius: 0.3, onChange: (on) => { if (on) this.openCage(this.cageE); } });
    this.glyphStone('ajaw', V3(26, 2.5, -5.98), V3(0, 0, 1), 1.0, { glow: 0.2 });
    this.cageE = this.cage(24, 0, 'east');
    if (this.found('east')) this.openCage(this.cageE, true);
    this.torch(V3(18, 2.6, 4.5), V3(1, 0, 0), { intensity: 10, distance: 12 });
    this.plaque(['THE RED EAST', 'where the sun is born'], V3(24, 4.6, 5.97), V3(0, 0, -1), 3.2, 0.85, { size: 110 });
  }
  buildNorth() {
    const T = this.T, tex = this.game.tex;
    this.passage('z', -17.4, -8.6);
    this.chamber({ x0: -6, z0: -30, x1: 6, z1: -18, h: 7, wall: T.stone, doors: { s: [{ a: 0, w: 3, h: 3.2 }] } });
    this.sums = [[2, 3], [6, 1], [4, 5]];
    this.answersN = this.sums.map(([a, b]) => a + b);
    const faces = Array.from({ length: 10 }, (_, n) => `num:${n}`);
    this.dialsN = [-3.2, 0, 3.2].map((x) => new GlyphDial(this, { pos: V3(x, 0, -23.5), facing: V3(0, 0, 1), faces, value: 0, radius: 0.78, label: 'Turn the numeral dial', onChange: () => this.checkNorth() }));
    this.sums.forEach(([a, b], i) => {
      this.mural(V3([-3.2, 0, 3.2][i], 4.0, -29.97), V3(0, 0, 1), 2.6, 1.5, (x, w, h) => {
        const s = h * 0.62;
        x.drawImage(tex.glyphCanvas(`num:${a}`, '#1d120a', 256), w * 0.2 - s / 2, h / 2 - s / 2, s, s);
        x.drawImage(tex.glyphCanvas('plus', '#1d120a', 256), w * 0.5 - s * 0.3, h / 2 - s * 0.3, s * 0.6, s * 0.6);
        x.drawImage(tex.glyphCanvas(`num:${b}`, '#1d120a', 256), w * 0.8 - s / 2, h / 2 - s / 2, s, s);
      }, { bg: '#e8e2d0', border: '#7a6a50', glow: 0.3 });
    });
    this.cageN = this.cage(0, -27.4, 'north');
    if (this.found('north')) { this.openCage(this.cageN, true); this.dialsN.forEach((d, i) => d.setValue(this.answersN[i])); this.solvedN = true; }
    this.torch(V3(-6, 2.6, -21), V3(1, 0, 0), { intensity: 10, distance: 12 });
    this.torch(V3(6, 2.6, -21), V3(-1, 0, 0), { light: false });
    this.plaque(['THE WHITE NORTH', 'the sum of things'], V3(0, 5.6, -18.03), V3(0, 0, -1), 3.0, 0.8, { size: 110 });
  }
  checkNorth() {
    if (this.solvedN || !this.dialsN.every((d, i) => d.value === this.answersN[i])) return;
    this.solvedN = true;
    this.openCage(this.cageN);
    this.game.ui.toast('THE NORTH IS SATISFIED', 'good');
  }
  buildWest() {
    const T = this.T, tex = this.game.tex;
    this.passage('x', -17.4, -8.6);
    this.chamber({ x0: -30, z0: -6, x1: -18, z1: 6, h: 7, wall: T.dark, floorBox: false, doors: { e: [{ a: 0, w: 3, h: 3.2 }] } });
    this.box(-30.6, -8, -6.6, -29.4, 0, 6.6, T.dark);
    this.box(-20, -8, -6.6, -17.4, 0, 6.6, T.floor);
    this.box(-29.4, -8, -6.6, -27.8, 0, 6.6, T.floor);
    this.box(-30.6, -8.5, -6.6, -17.4, -8, 6.6, T.dark);
    this.killZone(V3(-27.8, -12, -6), V3(-20, -2.5, 6), 'THE DARK TOOK YOU');
    for (const x of [-20.9, -22.9, -24.9, -26.9]) {
      const face = tex.tileFace('skull');
      const top = this.own(new THREE.MeshStandardMaterial({ map: face.map, emissive: 0x8a5cff, emissiveMap: face.em, emissiveIntensity: 0.5, roughness: 0.85 }));
      new CrumbleTile(this, { min: V3(x - 0.8, -0.5, -0.8), max: V3(x + 0.8, 0, 0.8), mat: T.dark, top, delay: 0.5, regen: 3.5 });
    }
    this.dartW = new DartTrap(this, { origin: V3(-23.9, 0, -6), dir: V3(0, 0, 1), length: 12, period: 2.2, warn: 0.6 });
    this.cageW = this.cage(-29.0, 0, 'west');
    this.openCage(this.cageW, true);
    this.point(-28.6, 2.4, 0, 0x8a5cff, 8, 12);
    this.plaque(['THE BLACK WEST', 'where the sun dies'], V3(-24, 4.8, 5.97), V3(0, 0, -1), 3.0, 0.8, { size: 110, glow: 0.12 });
  }
  buildSouth() {
    const T = this.T;
    this.passage('z', 8.6, 17.4);
    this.chamber({ x0: -6, z0: 18, x1: 6, z1: 30, h: 7, wall: T.ochre, roofMat: T.stone, doors: { n: [{ a: 0, w: 3, h: 3.2 }] } });
    const refresh = () => this.checkSouth();
    this.platesS = [-3, 3].map((x) => new PressurePlate(this, { pos: V3(x, 0, 27), size: 1.7, color: 0xffc457, glyph: 'sun', onChange: refresh }));
    this.blocksS = [new PushBlock(this, { pos: V3(-3, 0.55, 23) }), new PushBlock(this, { pos: V3(1, 0.55, 23) })];
    this.pillar(3, 23, 0, 7, 1.4);
    this.cageS = this.cage(0, 29.2, 'south');
    if (this.found('south')) { this.openCage(this.cageS, true); this.solvedS = true; }
    this.torch(V3(6, 2.6, 21), V3(-1, 0, 0), { intensity: 10, distance: 12 });
    this.torch(V3(-6, 2.6, 21), V3(1, 0, 0), { light: false });
    this.plaque(['THE YELLOW SOUTH', 'weigh down the sun'], V3(0, 4.8, 18.03), V3(0, 0, 1), 3.0, 0.8, { size: 110 });
  }
  checkSouth() {
    if (this.solvedS || !this.platesS.every((p) => p.pressed)) return;
    this.solvedS = true;
    this.openCage(this.cageS);
    this.game.ui.toast('THE SOUTH IS SATISFIED', 'good');
  }
  // Outside: the pyramid falls away below the apex, into the jungle.
  buildExterior() {
    const T = this.T;
    const ring = (y0, y1, half, hole, mat) => this.wall('y', y0, y1, -half, half, -half, half, mat, [{ a0: -hole, a1: hole, b0: -hole, b1: hole }], { solid: false, scale: 6 });
    // Stepped tiers. Their hollow centres hide the chambers inside, and
    // each tier's top overlaps the hole of the one below, so from above
    // the pyramid reads as solid.
    ring(15.9, 16.6, 5, 2, T.carved);
    ring(14.6, 15.9, 11, 8.65, T.stone);
    ring(13.3, 14.6, 15.5, 8.65, T.mossy);
    ring(12.0, 13.3, 20, 8.65, T.stone);
    ring(10.6, 12.0, 25, 8.65, T.mossy);
    ring(9.2, 10.6, 30.7, 8.65, T.stone);
    let y = 9.2, half = 33.7, i = 0;
    while (y > -30) {
      ring(y - 4, y, half, 30.65, i % 2 ? T.stone : T.mossy);
      this.wall('y', y - 0.6, y, -half - 0.08, half + 0.08, -half - 0.08, half + 0.08, T.carved, [{ a0: -half + 0.6, a1: half - 0.6, b0: -half + 0.6, b1: half - 0.6 }], { solid: false });
      y -= 4; half += 3; i++;
    }
    // A pierced crest around the oculus, and other temples above the jungle.
    for (const [x0, z0, x1, z1] of [[-3.8, -3.8, 3.8, -3.2], [-3.8, 3.2, 3.8, 3.8], [-3.8, -3.2, -3.2, 3.2], [3.2, -3.2, 3.8, 3.2]]) {
      this.box(x0, 16.6, z0, x1, 17.4, z1, T.carved, { solid: false });
      this.box(x0, 18.6, z0, x1, 19.4, z1, T.red, { solid: false });
    }
    for (const [x, z] of [[-3.5, -3.5], [3.5, -3.5], [-3.5, 3.5], [3.5, 3.5]]) this.box(x - 0.3, 17.4, z - 0.3, x + 0.3, 18.6, z + 0.3, T.carved, { solid: false });
    for (const [cx, cz, base, tiers] of [[190, -70, 34, 7], [-150, -175, 30, 6], [70, -215, 26, 6], [-210, 60, 24, 5]]) {
      for (let t = 0; t < tiers; t++) {
        const h = base - t * (base - 6) / tiers, y0 = -33 + t * 5.5;
        this.box(cx - h, y0, cz - h, cx + h, y0 + 5.5, cz + h, t % 2 ? T.stone : T.mossy, { solid: false, scale: 8 });
      }
      this.box(cx - 5, -33 + tiers * 5.5, cz - 5, cx + 5, -33 + tiers * 5.5 + 7, cz + 5, T.stone, { solid: false });
    }
    // Four great stairways down the faces.
    for (let k = 0; k < 4; k++) {
      for (let j = 0; j < 40; j++) {
        const yy = 9.2 - j * 1.0, d = 30.7 + j * 0.75;
        const [x0, z0, x1, z1] = k === 0 ? [-3, d, 3, d + 0.8] : k === 1 ? [-3, -d - 0.8, 3, -d] : k === 2 ? [d, -3, d + 0.8, 3] : [-d - 0.8, -3, -d, 3];
        this.box(x0, yy - 1.0, z0, x1, yy, z1, T.stone, { solid: false });
      }
    }
    // The jungle far below, and a temple on a distant hill.
    const r = this.rnd;
    for (let k = 0; k < 220; k++) {
      const a = r() * TAU, d = 66 + r() * 140;
      this.card('canopy', Math.cos(a) * d, -32 + r() * 6, Math.sin(a) * d, r() * TAU, 1.2 + r() * 0.3, 16 + r() * 12, 16 + r() * 12);
    }
    this.box(-200, -34, -200, 200, -33, 200, T.earth, { solid: false, scale: 12, shadow: false });
    // Sunlight for the finale (dark until then).
    this.sun = new THREE.DirectionalLight(0xffc890, 0);
    this.sun.position.set(80, 10, -20);
    this.sun.target.position.set(0, 0, 0);
    this.scene.add(this.sun, this.sun.target);
    // The feathered serpent of light (hidden until the finale).
    this.serpent = [];
    const featherMat = this.own(new THREE.MeshBasicMaterial({ map: this.game.tex.glowSprite(), color: new THREE.Color(0.3, 1.2, 0.75), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    const headMat = this.own(new THREE.MeshBasicMaterial({ map: this.game.tex.glowSprite(), color: new THREE.Color(1.6, 1.3, 0.6), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    for (let k = 0; k < 30; k++) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), k === 0 ? headMat : featherMat);
      m.visible = false;
      this.scene.add(m);
      this.serpent.push(m);
    }
  }
  isOutOfBounds(p) { return this.finale ? false : super.isOutOfBounds(p); }
  update(dt) {
    for (const c of this.cages || []) {
      if (c.open && c.t < 1) { c.t = Math.min(1, c.t + dt / 1.6); c.g.position.y = 1.1 + easeInOut(c.t) * 2.6; }
    }
    const fourPlaced = ['east', 'north', 'west', 'south'].filter((k) => this.placed(k)).length;
    const fourFound = ['east', 'north', 'west', 'south'].filter((k) => this.found(k)).length;
    if (!this.awake) {
      if (fourFound > fourPlaced) this.objective(`Set the stones you carry into the World Tree (${fourPlaced} / 4 set).`);
      else this.objective(`Find the stones of the four directions (${fourFound} / 4). Each waits at the end of a passage.`);
    } else if (!this.found('center')) this.objective('The World Tree awakens. Climb the rising steps to the green heart of the world.');
    else this.objective('Set the green heart into the World Tree.');
  }
  // Finale: the feathered serpent of light spirals up the tree and out of
  // the pyramid; the camera follows it into the dawn.
  updateFinale(dt) {
    const f = this.finale;
    if (!f.init) {
      f.init = true;
      this.game.audio.awaken();
      this.game.audio.finale();
      f.from = f.start.clone();
    }
    f.t += dt;
    const t = f.t;
    const cam = this.game.camera;
    // Serpent along a rising helix.
    const head = t * 5.5 + Math.max(0, t - 3) ** 2 * 1.6;
    this.serpent.forEach((m, i) => {
      const s = head - i * 0.45;
      m.visible = s > 0;
      if (!m.visible) return;
      const y = 0.6 + s * 0.62, a = s * 0.55;
      const r = y < 10 ? 2.4 : y < 18 ? lerp(2.4, 1.2, clamp((y - 10) / 3, 0, 1)) : 1.2 + (y - 18) * 0.3;
      m.position.set(Math.cos(a) * r, y, Math.sin(a) * r);
      m.quaternion.copy(cam.quaternion);
      const k = i === 0 ? 1.3 : 0.9 * (1 - i / this.serpent.length) + 0.25;
      m.scale.setScalar(k);
    });
    this.treeGlow.intensity = Math.min(34, 18 + t * 6);
    // Camera: step back to watch the serpent climb the tree, rise up the
    // axis of the oculus, then fly out west and look back at the pyramid
    // standing against the sunrise.
    const pA = V3(2.6, 6.6, 5.0), p1 = V3(0, 10.4, 0), p2 = V3(0, 30, 0), p3 = V3(-95, 38, 25);
    const ez = (x) => easeInOut(clamp(x, 0, 1));
    cam.position.lerpVectors(f.from, pA, ez(t / 2.5)).lerp(p1, ez((t - 2.5) / 2)).lerp(p2, ez((t - 4.5) / 2.2)).lerp(p3, ez((t - 6.2) / 4.5));
    const look = V3(0, 6.5 + Math.min(t, 3) * 1.7, 0).lerp(V3(0, 80, -9), ez((t - 2.5) / 2)).lerp(V3(0, 12, 0), ez((t - 6) / 2.5));
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(cam.position, look, Y_UP));
    cam.quaternion.slerpQuaternions(f.startQ, q, Math.min(1, t / 1.6));
    if (t > 1.6) cam.quaternion.copy(q);
    cam.updateMatrixWorld();
    // Dawn breaks.
    const d = clamp((t - 3) / 5, 0, 1);
    const u = this.skyU;
    u.uTop.value.setHex(0x050a1c).lerp(new THREE.Color(0x2a4a8a), d);
    u.uHorizon.value.setHex(0x1c2440).lerp(new THREE.Color(0xffa060), d);
    u.uGlow.value.setHex(0x5a6a9a).lerp(new THREE.Color(0xffb060), d);
    u.uMoon.value.set(-0.3, 0.75, 0.5).normalize().lerp(V3(0.95, 0.12, -0.25).normalize(), d).normalize();
    u.uMoonCol.value.setHex(0xfff6e0).lerp(new THREE.Color(0xffe0a0), d).multiplyScalar(1.6 + d);
    u.uMoonSize.value = lerp(0.0009, 0.0016, d);
    u.uStars.value = 1 - d;
    this.scene.fog.color.setHex(0x07060a).lerp(new THREE.Color(0x8a6a5a), d);
    this.scene.fog.density = lerp(0.018, 0.004, d);
    this.sun.intensity = d * 2.6;
    this.game.ui.setWhite(clamp((t - 10.2) / 1.8, 0, 1));
    return t >= 12.2;
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
  { name: 'THE JUNGLE GATE', blurb: 'Five offerings open the way.' },
  { name: 'THE HALL OF COUNTING', blurb: 'The gods count in bars and dots.' },
  { name: "THE SERPENT'S EYE", blurb: 'Bend the light of the sun.' },
  { name: 'THE TRIAL OF TRAPS', blurb: 'Blade, fire, stone. Run.' },
  { name: 'THE FIVE DIRECTIONS', blurb: 'The heart of the world.' },
];
const PART_INFO = [
  { title: 'PART I · THE FACILITY', from: 0 },
  { title: 'PART II · THE SUNKEN TEMPLE', from: PART_ONE_COUNT },
];

class UI {
  constructor(game) {
    this.game = game;
    this.$ = (id) => document.getElementById(id);
    this.screens = ['menu-main', 'menu-levels', 'menu-settings', 'menu-credits', 'menu-pause', 'controls-overlay', 'click-resume', 'level-complete', 'chapter-complete', 'victory'];
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
      const part = PART_INFO.find((p) => p.from === i);
      if (part) {
        const h = document.createElement('div');
        h.className = `part-head ${i >= PART_ONE_COUNT ? 'temple' : ''}`;
        h.textContent = part.title;
        grid.appendChild(h);
      }
      const locked = i + 1 > save.unlocked;
      const b = document.createElement('button');
      b.className = `level-card ${locked ? 'locked' : ''} ${save.completed[i] ? 'done' : ''} ${i >= PART_ONE_COUNT ? 'temple' : ''}`;
      b.dataset.action = locked ? 'locked-level' : 'start-level';
      b.dataset.level = String(i);
      const best = save.bestTimes[i];
      b.innerHTML = `<div class="lv-num">${String(i + 1).padStart(2, '0')}</div><div class="lv-name">${info.name}</div>
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
  // Offering tray in the HUD: one slot per relic the level asks for.
  setRelics(kinds, found = [], placed = []) {
    const el = this.$('relic-tray');
    if (!kinds || !kinds.length) { el.classList.add('hidden'); this.relicKey = null; return; }
    const key = `${kinds.join()}|${found.join()}|${placed.join()}`;
    if (key === this.relicKey) return;
    this.relicKey = key;
    el.classList.remove('hidden');
    const tex = this.game.tex;
    const n = kinds.filter((k) => found.includes(k)).length;
    el.innerHTML = `<div class="relic-label">${kinds.length > 1 ? `OFFERINGS ${n} / ${kinds.length}` : 'RELIC'}</div><div class="relic-slots">${kinds.map((k) => {
      const info = RELIC_INFO[k];
      const state = placed.includes(k) ? 'placed' : found.includes(k) ? 'found' : '';
      return `<span class="relic ${state}" title="${info.name}" style="--rc:${info.color}"><img alt="" src="${tex.relicIcon(k, state ? info.color : '#8a8070')}"></span>`;
    }).join('')}</div>`;
  }
  // A large title card that fades in and out over the game.
  chapterCard(kicker, title, sub = '') {
    const el = this.$('chapter-card');
    el.innerHTML = `<div class="cc-kicker">${kicker}</div><div class="cc-title">${title}</div>${sub ? `<div class="cc-sub">${sub}</div>` : ''}`;
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
  }
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
const LEVELS = [Level1, Level2, Level3, Level4, Level5, Level6, Level7, Level8, Level9, Level10];

const _plane = new THREE.Plane();
const _clip = new THREE.Vector4();
const _qv = new THREE.Vector4();
const _frustum = new THREE.Frustum();
const _pv = new THREE.Matrix4();
const _vm = new THREE.Matrix4();
const _size = new THREE.Vector2();
const _hzMin = new THREE.Vector3();
const _hzMax = new THREE.Vector3();

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
    if (this.state !== 'menu' && this.state !== 'victory' && this.state !== 'chapter') { this.camera.fov = this.settings.fov; this.camera.updateProjectionMatrix(); }
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
    if (i === PART_ONE_COUNT) this.ui.chapterCard('PART II', 'THE SUNKEN TEMPLE', 'The light set you down somewhere older.');
    requestAnimationFrame(() => this.ui.fade(0, i === PART_ONE_COUNT ? 2.2 : 0.8));
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
    const carry = !fresh && this.level && this.levelIndex === i ? this.level.carry : null;
    if (this.level) {
      this.level.scene.remove(this.player.avatar);
      this.level.dispose();
    }
    this.held = null;
    this.ui.setHeld(null);
    const L = new LEVELS[i](this, cp, carry);
    this.level = L;
    this.levelIndex = i;
    document.body.classList.toggle('temple', L.meta.part === 2);
    this.ui.setRelics(null);
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
    document.body.classList.remove('temple');
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
  // Per-level times for a range of levels, plus their total.
  breakdown(from, to) {
    const times = this.save.data.lastTimes;
    let total = 0;
    const rows = [];
    for (let i = from; i < to; i++) {
      total += times[i] || 0;
      rows.push(`<span>${i + 1}. ${LEVEL_INFO[i].name}</span><span>${formatTime(times[i])}</span>`);
    }
    return { total, html: rows.join('') };
  }
  // Leave the finale for a results screen drawn over the menu backdrop.
  showResults(screen, state) {
    if (this.level) { this.level.scene.remove(this.player.avatar); this.level.dispose(); this.level = null; }
    document.body.classList.remove('temple');
    this.state = state;
    this.camera.fov = 16; this.camera.near = 0.5; this.camera.updateProjectionMatrix();
    this.renderPass.scene = this.menu.scene;
    this.audio.startAmbient(AMBIENT_PROFILES.menu);
    this.ui.setWhite(1);
    requestAnimationFrame(() => requestAnimationFrame(() => this.ui.fade(0, 2.5, '#f4f8ff')));
    this.ui.showScreen(screen);
  }
  // End of level 5: the facility is behind you, the temple is ahead.
  finishPartOne() {
    this.save.completeLevel(PART_ONE_COUNT - 1, this.levelTime);
    const b = this.breakdown(0, PART_ONE_COUNT);
    document.getElementById('chapter-time').textContent = formatTime(b.total);
    document.getElementById('chapter-breakdown').innerHTML = b.html;
    this.showResults('chapter-complete', 'chapter');
  }
  finishGame() {
    this.save.completeLevel(LEVEL_COUNT - 1, this.levelTime);
    const one = this.breakdown(0, PART_ONE_COUNT), two = this.breakdown(PART_ONE_COUNT, LEVEL_COUNT);
    document.getElementById('victory-time').textContent = formatTime(one.total + two.total);
    document.getElementById('victory-breakdown').innerHTML =
      `<span class="part">${PART_INFO[0].title}</span><span class="part">${formatTime(one.total)}</span>${one.html}` +
      `<span class="part">${PART_INFO[1].title}</span><span class="part">${formatTime(two.total)}</span>${two.html}`;
    this.showResults('victory', 'victory');
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

  // A trap got the player: red flash, a thud, then back to the last checkpoint.
  killPlayer(msg = 'THE TEMPLE CLAIMS YOU') {
    if (this.respawning || this.state !== 'playing') return;
    this.audio.death();
    this.ui.flash(0xff2a1a, 0.7);
    this.player.shake = 0.5;
    this.respawn(msg, 'warn');
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
      case 'chapter':
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
    if (L.isOutOfBounds(pl.pos) && !this.respawning) { this.respawn(L.meta.part === 2 ? 'THE DARK SWALLOWS YOU — BACK TO THE LAST CHECKPOINT' : 'SIGNAL LOST — RETURNING TO CHECKPOINT'); return; }
    if (L.hazards.length && !this.respawning) {
      boxFrom(pl.pos, pl.half, _hzMin, _hzMax);
      for (const h of L.hazards) {
        if (h.hits(_hzMin, _hzMax)) { this.killPlayer(h.message); return; }
      }
    }
    this.updateTarget();
    this.handleInteract();
    if (this.touchMode) this.touchCtl.setUse(this.held ? 'holding' : this.target && !this.target.out ? 'ready' : '');
    this.ui.setGravity(L.showGravity, pl.up);
  }
  updateFinale(dt) {
    const L = this.level;
    for (const e of L.entities.slice()) if (!(e instanceof Trigger) && !(e instanceof PhysObject) && !(e instanceof PressurePlate)) e.update(dt);
    L.updateCommon(dt);
    if (L.updateFinale(dt)) {
      if (this.levelIndex === PART_ONE_COUNT - 1) this.finishPartOne();
      else this.finishGame();
    }
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
      Promise.all([document.fonts.load("700 48px 'Orbitron'"), document.fonts.load("600 32px 'Rajdhani'"), document.fonts.load("500 32px 'Rajdhani'"), document.fonts.load("700 48px 'Cinzel'")]),
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
