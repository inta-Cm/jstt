/* ════════════════════════════════════════════════════════
   TREASURE RUNNER MULTIPLAYER — c.js
   All game logic, Firebase multiplayer, audio, rendering
   ════════════════════════════════════════════════════════ */

'use strict';

/* ──────────────────────────────────────────────────────
   FIREBASE CONFIGURATION
   Replace with your actual Firebase project credentials.
   Get these from: https://console.firebase.google.com
   Project Settings → Your apps → Firebase SDK snippet → Config
────────────────────────────────────────────────────── */
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDGfARCO_6NizY0MTDKC6yaeWt1gI4EWbE",
  authDomain: "gamw-343d8.firebaseapp.com",
  projectId: "gamw-343d8",
  storageBucket: "gamw-343d8.firebasestorage.app",
  messagingSenderId: "685756422089",
  appId: "1:685756422089:web:a6e59b6afd787be71f7a18"
};

/* ──────────────────────────────────────────────────────
   CONSTANTS
────────────────────────────────────────────────────── */
const WORLD_LENGTH   = 12000; // pixels to finish line
const GROUND_Y_RATIO = 0.72;  // fraction of canvas height
const TILE_W         = 64;
const PLAYER_W       = 40;
const PLAYER_H       = 56;
const GRAVITY        = 0.55;
const JUMP_FORCE     = -13;
const BASE_SPEED     = 4.2;
const COIN_SCORE     = 10;
const SYNC_INTERVAL  = 80;    // ms between position syncs
const FINISH_LINE_X  = WORLD_LENGTH;

/* ──────────────────────────────────────────────────────
   GAME STATE
────────────────────────────────────────────────────── */
const state = {
  screen: 'home',
  playerName: '',
  roomId: '',
  playerId: '',       // 'p1' or 'p2'
  db: null,

  // Lobby
  p1Name: '', p2Name: '',
  p1Ready: false, p2Ready: false,
  isHost: false,

  // Game runtime
  running: false,
  startTime: 0,
  gameOver: false,
  winner: '',

  // My player
  me: { x: 100, y: 0, vy: 0, onGround: false, state: 'run',
        coins: 0, dist: 0, shieldActive: false, speedBoost: false,
        doubleCoins: false, powerupTimer: 0, powerupType: '' },

  // Opponent
  op: { x: 100, y: 0, state: 'run', coins: 0, dist: 0, name: '' },

  // World (seeded by host, synced to joiner)
  obstacles: [],
  coins: [],
  gems: [],
  powerups: [],
  worldReady: false,

  // Camera
  camX: 0,

  // Settings
  sfxOn: true, musicOn: true, showFps: false, quality: 'high',

  // Timing / perf
  lastSyncTime: 0,
  pingStart: 0,
  ping: 0,
  fps: 60,
  fpsFrames: 0,
  fpsTimer: 0,

  // Mobile controls
  joystick: { active: false, dx: 0 },
  mobileJump: false, mobileSlide: false,

  // Keys
  keys: {},
};

/* ──────────────────────────────────────────────────────
   AUDIO ENGINE
────────────────────────────────────────────────────── */
class AudioEngine {
  constructor() {
    this.ctx = null;
    this.musicNode = null;
    this.musicGain = null;
    this._init();
  }

  _init() {
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    } catch(e) { /* no audio */ }
  }

  _resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  // Synthesise a simple tone burst
  _beep(freq, type, duration, vol=0.4, delay=0) {
    if (!this.ctx || !state.sfxOn) return;
    this._resume();
    const g = this.ctx.createGain();
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, this.ctx.currentTime + delay);
    o.frequency.exponentialRampToValueAtTime(freq * 0.5, this.ctx.currentTime + delay + duration);
    g.gain.setValueAtTime(vol, this.ctx.currentTime + delay);
    g.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + delay + duration);
    o.connect(g); g.connect(this.ctx.destination);
    o.start(this.ctx.currentTime + delay);
    o.stop(this.ctx.currentTime + delay + duration + 0.01);
  }

  click()   { this._beep(600, 'sine',   0.08, 0.3); }
  jump()    { this._beep(400, 'sine',   0.15, 0.3); this._beep(600, 'sine', 0.1, 0.2, 0.05); }
  coin()    { this._beep(880, 'sine',   0.12, 0.25); this._beep(1100,'sine',0.1, 0.2, 0.07); }
  gem()     { this._beep(1200,'triangle',0.2, 0.3);  this._beep(1600,'triangle',0.15,0.2,0.1); }
  powerup() { [300,400,500,650].forEach((f,i)=>this._beep(f,'sawtooth',0.1,0.2,i*0.06)); }
  hit()     { this._beep(120,'sawtooth',0.2,0.4); }
  count(n)  { this._beep(n===0?880:440,'sine',0.25,0.4); }
  win()     { [523,659,784,1047].forEach((f,i)=>this._beep(f,'sine',0.3,0.35,i*0.12)); }
  lose()    { [400,320,220,160].forEach((f,i)=>this._beep(f,'sawtooth',0.25,0.3,i*0.1)); }

  startMusic() {
    if (!this.ctx || !state.musicOn || this.musicNode) return;
    this._resume();
    // Simple looping arpeggio as background music
    const notes = [261,329,392,523,392,329,261,220];
    let i = 0;
    const play = () => {
      if (!state.musicOn || state.screen === 'home') return;
      this._beep(notes[i % notes.length], 'triangle', 0.18, 0.06);
      i++;
      this.musicNode = setTimeout(play, 220);
    };
    play();
  }

  stopMusic() {
    if (this.musicNode) { clearTimeout(this.musicNode); this.musicNode = null; }
  }
}
const audio = new AudioEngine();

/* ──────────────────────────────────────────────────────
   PARTICLE SYSTEM (background canvas)
────────────────────────────────────────────────────── */
class ParticleSystem {
  constructor() {
    this.canvas = document.getElementById('particleCanvas');
    this.ctx = this.canvas.getContext('2d');
    this.particles = [];
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this._spawn();
    this._loop();
  }

  resize() {
    this.canvas.width  = window.innerWidth;
    this.canvas.height = window.innerHeight;
  }

  _spawn() {
    for (let i = 0; i < 60; i++) {
      this.particles.push({
        x: Math.random() * window.innerWidth,
        y: Math.random() * window.innerHeight,
        r: Math.random() * 2 + 0.5,
        vx: (Math.random() - 0.5) * 0.3,
        vy: -Math.random() * 0.5 - 0.1,
        alpha: Math.random() * 0.5 + 0.1,
        hue: Math.random() > 0.5 ? 260 : 200,
      });
    }
  }

  _loop() {
    requestAnimationFrame(() => this._loop());
    if (state.screen === 'game') { this.ctx.clearRect(0,0,this.canvas.width,this.canvas.height); return; }
    const c = this.ctx;
    c.clearRect(0,0,this.canvas.width, this.canvas.height);
    for (const p of this.particles) {
      p.x += p.vx; p.y += p.vy;
      if (p.y < -5) { p.y = this.canvas.height + 5; p.x = Math.random()*this.canvas.width; }
      c.beginPath();
      c.arc(p.x, p.y, p.r, 0, Math.PI*2);
      c.fillStyle = `hsla(${p.hue},80%,70%,${p.alpha})`;
      c.fill();
    }
  }
}
const particles = new ParticleSystem();

/* ──────────────────────────────────────────────────────
   SCREEN MANAGER
────────────────────────────────────────────────────── */
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(`screen-${id}`);
  if (el) el.classList.add('active');
  state.screen = id;
}

/* ──────────────────────────────────────────────────────
   TOAST
────────────────────────────────────────────────────── */
let toastTimer = null;
function toast(msg, dur=2500) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), dur);
}

/* ──────────────────────────────────────────────────────
   LOCAL STATISTICS
────────────────────────────────────────────────────── */
const Stats = {
  load() {
    return JSON.parse(localStorage.getItem('tr_stats') || '{"games":0,"wins":0,"losses":0,"coins":0,"bestTime":null}');
  },
  save(s) { localStorage.setItem('tr_stats', JSON.stringify(s)); },
  record(won, coins, timeMs) {
    const s = this.load();
    s.games++; s.coins += coins;
    if (won) { s.wins++; if (!s.bestTime || timeMs < s.bestTime) s.bestTime = timeMs; }
    else s.losses++;
    this.save(s);
  },
  display() {
    const s = this.load();
    const fmt = ms => ms ? `${Math.floor(ms/60000)}:${String(Math.floor((ms%60000)/1000)).padStart(2,'0')}` : '—';
    document.getElementById('sGames').textContent   = s.games;
    document.getElementById('sWins').textContent    = s.wins;
    document.getElementById('sLosses').textContent  = s.losses;
    document.getElementById('sCoins').textContent   = s.coins;
    document.getElementById('sBest').textContent    = fmt(s.bestTime);
    document.getElementById('sWinRate').textContent = s.games ? Math.round(s.wins/s.games*100)+'%' : '0%';
  }
};

/* ──────────────────────────────────────────────────────
   WORLD GENERATOR  (seeded pseudo-random so both players get same map)
────────────────────────────────────────────────────── */
function seededRng(seed) {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) & 0xffffffff; return (s >>> 0) / 0xffffffff; };
}

function generateWorld(seed) {
  const rng = seededRng(seed);
  const obstacles = [], coins = [], gems = [], powerups = [];
  const GROUND = 0; // will be converted at render time using groundY

  // --- Obstacles ---
  let x = 600;
  while (x < WORLD_LENGTH - 500) {
    const type = rng() < 0.6 ? 'rock' : (rng() < 0.5 ? 'cactus' : 'spike');
    const w = type === 'rock' ? 40 + rng()*30 : 30 + rng()*20;
    const h = type === 'spike' ? 20 + rng()*10 : 40 + rng()*30;
    obstacles.push({ x, y: GROUND, w, h, type });
    x += 250 + rng() * 350;
  }

  // --- Coins ---
  x = 400;
  while (x < WORLD_LENGTH - 200) {
    const cluster = Math.floor(rng()*3)+1;
    const floatY  = rng() < 0.35;
    for (let i = 0; i < cluster; i++) {
      coins.push({ x: x + i*36, y: floatY ? -(80 + rng()*60) : 0, collected: false, id: `c_${x}_${i}` });
    }
    x += 180 + rng() * 200;
  }

  // --- Gems (rare, worth 5 coins) ---
  x = 800;
  while (x < WORLD_LENGTH - 300) {
    if (rng() < 0.3) {
      gems.push({ x, y: -(70 + rng()*50), collected: false, id: `g_${x}` });
    }
    x += 500 + rng()*400;
  }

  // --- Power-ups ---
  x = 900;
  while (x < WORLD_LENGTH - 400) {
    const types = ['speed','shield','double'];
    powerups.push({ x, y: -(80 + rng()*40), type: types[Math.floor(rng()*3)], collected: false, id: `pu_${x}` });
    x += 700 + rng()*600;
  }

  return { obstacles, coins, gems, powerups, seed };
}

/* ──────────────────────────────────────────────────────
   FIREBASE HELPERS
────────────────────────────────────────────────────── */
function roomRef()  { return state.db.collection('rooms').doc(state.roomId); }
function dataRef()  { return roomRef().collection('game').doc('data'); }
function chatRef()  { return roomRef().collection('chat'); }

async function createRoom(name) {
  const code = Math.random().toString(36).substr(2,6).toUpperCase();
  state.roomId   = code;
  state.playerId = 'p1';
  state.isHost   = true;
  state.p1Name   = name;

  await roomRef().set({
    p1: { name, ready: false },
    p2: { name: '', ready: false },
    status: 'lobby',
    seed: Math.floor(Math.random() * 999999),
    createdAt: Date.now()
  });
  return code;
}

async function joinRoom(code, name) {
  const snap = await state.db.collection('rooms').doc(code).get();
  if (!snap.exists) throw new Error('Room not found');
  const d = snap.data();
  if (d.status !== 'lobby') throw new Error('Game already started');
  if (d.p2 && d.p2.name) throw new Error('Room is full');

  state.roomId   = code;
  state.playerId = 'p2';
  state.isHost   = false;
  state.p2Name   = name;
  state.p1Name   = d.p1.name;

  await roomRef().update({ 'p2.name': name, 'p2.ready': false });
}

/* ──────────────────────────────────────────────────────
   LOBBY LISTENERS
────────────────────────────────────────────────────── */
let _roomUnsub = null;

function listenRoom() {
  if (_roomUnsub) _roomUnsub();
  _roomUnsub = roomRef().onSnapshot(snap => {
    if (!snap.exists) return;
    const d = snap.data();

    state.p1Name   = d.p1.name;
    state.p1Ready  = d.p1.ready;
    state.p2Name   = d.p2?.name || '';
    state.p2Ready  = d.p2?.ready || false;

    document.getElementById('slot1Name').textContent   = state.p1Name || 'Waiting…';
    document.getElementById('slot2Name').textContent   = state.p2Name || 'Waiting…';
    document.getElementById('slot1Status').textContent = state.p1Ready ? '✅ Ready' : '⏳';
    document.getElementById('slot2Status').textContent = state.p2Ready ? '✅ Ready' : '⏳';
    document.getElementById('lobbyHint').textContent   = state.p2Name ? 'Both players connected!' : 'Share the room code with your friend!';

    if (d.status === 'starting') {
      _roomUnsub();
      startCountdown(d.seed);
    }
  });
}

/* ──────────────────────────────────────────────────────
   COUNTDOWN & GAME START
────────────────────────────────────────────────────── */
async function startCountdown(seed) {
  showScreen('countdown');
  const el = document.getElementById('countdownNum');
  const lbl = document.getElementById('countdown-label');

  const steps = ['3','2','1','GO!'];
  for (let i = 0; i < steps.length; i++) {
    el.textContent = steps[i];
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = 'countPop 0.6s cubic-bezier(0.175,0.885,0.32,1.275)';
    audio.count(i);
    await sleep(900);
  }

  initGame(seed);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ──────────────────────────────────────────────────────
   GAME CANVAS & RENDERER
────────────────────────────────────────────────────── */
let canvas, ctx, groundY, animFrame;

function initGame(seed) {
  canvas = document.getElementById('gameCanvas');
  ctx    = canvas.getContext('2d');

  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  // Generate world
  const world = generateWorld(seed);
  state.obstacles = world.obstacles;
  state.coins     = world.coins;
  state.gems      = world.gems;
  state.powerups  = world.powerups;
  state.worldReady = true;

  // Reset player state
  state.me = {
    x: state.playerId === 'p1' ? 80 : 130,
    y: groundY - PLAYER_H,
    vy: 0, onGround: true, state: 'run',
    coins: 0, dist: 0,
    shieldActive: false, speedBoost: false, doubleCoins: false,
    powerupTimer: 0, powerupType: '',
    slideTimer: 0,
    animFrame: 0, animTimer: 0,
    invincible: 0,
    spriteColor: state.playerId === 'p1' ? '#a855f7' : '#06b6d4',
  };
  state.op = {
    x: state.playerId === 'p2' ? 80 : 130,
    y: groundY - PLAYER_H,
    state: 'run', coins: 0, dist: 0,
    name: state.playerId === 'p1' ? state.p2Name : state.p1Name,
    animFrame: 0, animTimer: 0,
    spriteColor: state.playerId === 'p1' ? '#06b6d4' : '#a855f7',
  };

  state.camX      = 0;
  state.running   = true;
  state.gameOver  = false;
  state.startTime = Date.now();

  // Fix coin/gem/powerup y positions now we have groundY
  const gy = groundY;
  state.coins.forEach(c   => { if (c.y === 0) c.y = gy - 28; else c.y = gy + c.y; });
  state.gems.forEach(g    => { g.y = gy + g.y; });
  state.powerups.forEach(p => { p.y = gy + p.y; });
  state.obstacles.forEach(o => { o.groundY = gy; });

  // Update HUD labels
  document.getElementById('progLabel1').textContent = state.me.spriteColor === '#a855f7' ? 'You' : 'You';
  document.getElementById('progLabel2').textContent = state.op.name || 'Opp';

  showScreen('game');
  audio.startMusic();

  // Show mobile controls on touch device
  const isMobile = ('ontouchstart' in window) || (window.innerWidth < 768);
  document.getElementById('mobileControls').style.display = isMobile ? 'flex' : 'none';

  listenGameData();
  listenChat();
  gameLoop();
}

function resizeCanvas() {
  canvas = document.getElementById('gameCanvas');
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
  groundY = Math.floor(canvas.height * GROUND_Y_RATIO);
}

/* ────────────────────────────────────────
   MAIN GAME LOOP
──────────────────────────────────────── */
let lastTime = 0;

function gameLoop(ts = 0) {
  if (!state.running) return;
  animFrame = requestAnimationFrame(gameLoop);

  const dt = Math.min(ts - lastTime, 50); // cap at 50ms
  lastTime = ts;

  // FPS
  state.fpsFrames++;
  state.fpsTimer += dt;
  if (state.fpsTimer >= 1000) {
    state.fps = state.fpsFrames;
    state.fpsFrames = 0;
    state.fpsTimer  = 0;
    if (state.showFps) {
      const el = document.getElementById('fpsCounter');
      el.textContent = `${state.fps} FPS`;
    }
  }

  update(dt);
  render();
  syncToFirebase(ts);
}

/* ────────────────────────────────────────
   PHYSICS & UPDATE
──────────────────────────────────────── */
function update(dt) {
  const me = state.me;
  if (state.gameOver) return;

  const speed = BASE_SPEED * (me.speedBoost ? 1.6 : 1);

  // Horizontal input
  const left  = state.keys['ArrowLeft']  || state.keys['a'] || (state.joystick.dx < -0.3);
  const right = state.keys['ArrowRight'] || state.keys['d'] || (state.joystick.dx > 0.3);
  const jumpK = state.keys['ArrowUp']    || state.keys['w'] || state.keys[' '] || state.mobileJump;
  const slideK= state.keys['ArrowDown']  || state.keys['s'] || state.mobileSlide;

  if (right) me.x += speed;
  if (left && me.x > 60) me.x -= speed * 0.7;

  // Sliding
  if (slideK && me.onGround) {
    me.state = 'slide';
    me.slideTimer = 400;
  }
  if (me.slideTimer > 0) { me.slideTimer -= dt; if (me.slideTimer <= 0) me.state = 'run'; }

  // Jumping
  if (jumpK && me.onGround) {
    me.vy = JUMP_FORCE;
    me.onGround = false;
    me.state = 'jump';
    audio.jump();
    state.mobileJump = false;
  }

  // Gravity
  me.vy += GRAVITY;
  me.y  += me.vy;

  // Ground collision
  const floor = groundY - (me.state === 'slide' ? PLAYER_H * 0.5 : PLAYER_H);
  if (me.y >= floor) {
    me.y = floor;
    me.vy = 0;
    me.onGround = true;
    if (me.state === 'jump') me.state = 'run';
  }

  // Advance camera / distance
  state.camX = Math.max(0, me.x - canvas.width * 0.3);
  me.dist = Math.floor(Math.max(0, me.x - 80));

  // Animation frames
  me.animTimer += dt;
  if (me.animTimer > 120) { me.animFrame = (me.animFrame + 1) % 4; me.animTimer = 0; }

  // Power-up timer
  if (me.powerupTimer > 0) {
    me.powerupTimer -= dt;
    const frac = me.powerupTimer / 5000;
    document.getElementById('powerupFill').style.width = (frac*100) + '%';
    if (me.powerupTimer <= 0) {
      me.speedBoost = me.shieldActive = me.doubleCoins = false;
      me.powerupType = '';
      document.getElementById('powerupIndicator').classList.add('hidden');
    }
  }

  // Invincibility frames
  if (me.invincible > 0) me.invincible -= dt;

  // Obstacle collision
  if (me.invincible <= 0) {
    for (const obs of state.obstacles) {
      if (rectsOverlap(
        me.x + 4, me.y + (me.state==='slide'?PLAYER_H*0.5:0), PLAYER_W - 8, me.state==='slide'?PLAYER_H*0.5:PLAYER_H,
        obs.x, obs.groundY - obs.h, obs.w, obs.h
      )) {
        if (!me.shieldActive) {
          // Bounce back
          me.x -= 60;
          me.vy = JUMP_FORCE * 0.6;
          me.onGround = false;
          me.invincible = 900;
          audio.hit();
        } else {
          me.shieldActive = false; me.powerupTimer = 0;
          document.getElementById('powerupIndicator').classList.add('hidden');
        }
      }
    }
  }

  // Coin collection
  for (const c of state.coins) {
    if (!c.collected && circleRect(c.x, c.y, 10, me.x, me.y, PLAYER_W, PLAYER_H)) {
      c.collected = true;
      const gain  = me.doubleCoins ? 2 : 1;
      me.coins   += gain;
      audio.coin();
      spawnCollectParticle(c.x, c.y, '#ffd700');
      scheduleItemSync();
    }
  }

  // Gem collection
  for (const g of state.gems) {
    if (!g.collected && circleRect(g.x, g.y, 12, me.x, me.y, PLAYER_W, PLAYER_H)) {
      g.collected = true;
      me.coins   += me.doubleCoins ? 10 : 5;
      audio.gem();
      spawnCollectParticle(g.x, g.y, '#a855f7');
      scheduleItemSync();
    }
  }

  // Power-up collection
  for (const p of state.powerups) {
    if (!p.collected && circleRect(p.x, p.y, 14, me.x, me.y, PLAYER_W, PLAYER_H)) {
      p.collected = true;
      applyPowerup(p.type);
      audio.powerup();
      spawnCollectParticle(p.x, p.y, '#06b6d4');
      scheduleItemSync();
    }
  }

  // Finish line
  if (me.x >= FINISH_LINE_X && !state.gameOver) {
    triggerWin();
  }

  // Update HUD
  const elapsed = Date.now() - state.startTime;
  const mins    = Math.floor(elapsed / 60000);
  const secs    = Math.floor((elapsed % 60000) / 1000);
  document.getElementById('hudTimer').textContent  = `${mins}:${String(secs).padStart(2,'0')}`;
  document.getElementById('hudCoins').textContent  = me.coins;

  const prog = Math.min(me.dist / (WORLD_LENGTH - 80) * 100, 100);
  const opProg = Math.min((state.op.dist || 0) / (WORLD_LENGTH - 80) * 100, 100);
  document.getElementById('myProgress').style.width = prog + '%';
  document.getElementById('opProgress').style.width = opProg + '%';

  updateLeaderboard();
}

function applyPowerup(type) {
  const me = state.me;
  me.powerupTimer = 5000; me.powerupType = type;
  const iconEl = document.getElementById('powerupIcon');
  if (type === 'speed')  { me.speedBoost   = true; iconEl.textContent = '⚡'; }
  if (type === 'shield') { me.shieldActive  = true; iconEl.textContent = '🛡️'; }
  if (type === 'double') { me.doubleCoins   = true; iconEl.textContent = '💰'; }
  document.getElementById('powerupIndicator').classList.remove('hidden');
}

/* ────────────────────────────────────────
   COLLISION HELPERS
──────────────────────────────────────── */
function rectsOverlap(ax,ay,aw,ah, bx,by,bw,bh) {
  return ax < bx+bw && ax+aw > bx && ay < by+bh && ay+ah > by;
}
function circleRect(cx,cy,cr, rx,ry,rw,rh) {
  const nx = Math.max(rx, Math.min(cx, rx+rw));
  const ny = Math.max(ry, Math.min(cy, ry+rh));
  return (cx-nx)**2 + (cy-ny)**2 < cr*cr;
}

/* ────────────────────────────────────────
   COLLECT PARTICLES (canvas-space)
──────────────────────────────────────── */
const collectParticles = [];
function spawnCollectParticle(wx, wy, color) {
  for (let i = 0; i < 8; i++) {
    const angle = (i/8)*Math.PI*2;
    collectParticles.push({
      x: wx, y: wy, vx: Math.cos(angle)*3, vy: Math.sin(angle)*3 - 2,
      life: 1, color
    });
  }
}

/* ────────────────────────────────────────
   RENDER
──────────────────────────────────────── */
function render() {
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0,0,W,H);

  // ── SKY GRADIENT ──
  const sky = ctx.createLinearGradient(0,0,0,H);
  sky.addColorStop(0,  '#0a0b14');
  sky.addColorStop(0.6,'#111225');
  sky.addColorStop(1,  '#1a1040');
  ctx.fillStyle = sky;
  ctx.fillRect(0,0,W,H);

  // ── PARALLAX LAYERS ──
  drawParallax(W, H);

  // ── GROUND ──
  drawGround(W, H);

  ctx.save();
  ctx.translate(-state.camX, 0);

  // ── FINISH LINE ──
  drawFinishLine();

  // ── OBSTACLES ──
  state.obstacles.forEach(o => drawObstacle(o));

  // ── COINS ──
  state.coins.forEach(c => { if (!c.collected) drawCoin(c.x, c.y); });

  // ── GEMS ──
  state.gems.forEach(g => { if (!g.collected) drawGem(g.x, g.y); });

  // ── POWER-UPS ──
  state.powerups.forEach(p => { if (!p.collected) drawPowerup(p.x, p.y, p.type); });

  // ── OPPONENT ──
  drawPlayer(state.op.x, state.op.y, state.op.state, state.op.animFrame, state.op.spriteColor, state.op.name, false);

  // ── MY PLAYER ──
  const me = state.me;
  const flash = me.invincible > 0 && Math.floor(me.invincible/80)%2===0;
  if (!flash) {
    drawPlayer(me.x, me.y, me.state, me.animFrame, me.spriteColor,
      state.playerName, true, me.shieldActive);
  }

  // ── COLLECT PARTICLES ──
  for (let i = collectParticles.length-1; i>=0; i--) {
    const p = collectParticles[i];
    p.x += p.vx; p.y += p.vy; p.vy += 0.15; p.life -= 0.04;
    if (p.life <= 0) { collectParticles.splice(i,1); continue; }
    ctx.globalAlpha = p.life;
    ctx.fillStyle   = p.color;
    ctx.beginPath(); ctx.arc(p.x, p.y, 4*p.life, 0, Math.PI*2); ctx.fill();
    ctx.globalAlpha = 1;
  }

  ctx.restore();
}

/* ── PARALLAX ── */
const parallaxStars = Array.from({length:80},()=>({
  x: Math.random()*FINISH_LINE_X*1.2, y: Math.random()*300,
  r: Math.random()*1.5+0.3, speed: Math.random()*0.3+0.1
}));
const parallaxClouds = Array.from({length:12},()=>({
  x: Math.random()*FINISH_LINE_X, y: 40+Math.random()*80,
  w: 80+Math.random()*120, speed: 0.2+Math.random()*0.15
}));

function drawParallax(W,H) {
  // Stars
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  for (const s of parallaxStars) {
    const sx = ((s.x - state.camX * s.speed) % W + W) % W;
    ctx.beginPath(); ctx.arc(sx, s.y, s.r, 0, Math.PI*2); ctx.fill();
  }
  // Mountains
  ctx.fillStyle = 'rgba(124,58,237,0.15)';
  ctx.beginPath(); ctx.moveTo(0, groundY);
  const mOff = state.camX * 0.2;
  for (let x=0; x<W+100; x+=80) {
    const mx = x - mOff%80;
    ctx.lineTo(mx, groundY - 80 - Math.sin(x*0.04)*60);
  }
  ctx.lineTo(W, groundY); ctx.closePath(); ctx.fill();

  // Mid hills
  ctx.fillStyle = 'rgba(30,15,60,0.5)';
  ctx.beginPath(); ctx.moveTo(0, groundY);
  const hOff = state.camX * 0.4;
  for (let x=0; x<W+60; x+=60) {
    const hx = x - hOff%60;
    ctx.lineTo(hx, groundY - 40 - Math.sin(x*0.06)*30);
  }
  ctx.lineTo(W, groundY); ctx.closePath(); ctx.fill();
}

/* ── GROUND ── */
function drawGround(W,H) {
  // Ground strip
  const grd = ctx.createLinearGradient(0, groundY, 0, H);
  grd.addColorStop(0, '#1e0a3c');
  grd.addColorStop(1, '#0a0514');
  ctx.fillStyle = grd;
  ctx.fillRect(0, groundY, W, H - groundY);

  // Ground line glow
  ctx.strokeStyle = '#7c3aed';
  ctx.lineWidth   = 2;
  ctx.shadowColor = '#a855f7';
  ctx.shadowBlur  = 8;
  ctx.beginPath(); ctx.moveTo(0, groundY); ctx.lineTo(W, groundY); ctx.stroke();
  ctx.shadowBlur  = 0;

  // Tiled floor texture
  ctx.fillStyle = 'rgba(124,58,237,0.08)';
  const tileOff = state.camX % (TILE_W*2);
  for (let x = -tileOff; x < W; x += TILE_W) {
    ctx.fillRect(x, groundY, TILE_W-2, 16);
  }
}

/* ── PLAYER SPRITE ── */
function drawPlayer(x, y, playerState, frame, color, name, isMe, shield=false) {
  const ph = playerState === 'slide' ? PLAYER_H * 0.55 : PLAYER_H;
  const py = playerState === 'slide' ? groundY - ph : y;

  ctx.save();

  // Shield aura
  if (shield) {
    ctx.beginPath();
    ctx.arc(x + PLAYER_W/2, py + ph/2, PLAYER_W*0.8, 0, Math.PI*2);
    ctx.strokeStyle = '#06b6d4';
    ctx.lineWidth   = 3;
    ctx.globalAlpha = 0.5 + Math.sin(Date.now()*0.01)*0.2;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Body
  ctx.fillStyle = color;
  const runBob = playerState === 'run' ? Math.sin(frame * Math.PI/2)*3 : 0;

  // Legs
  ctx.fillStyle = '#4c1d95';
  const legPhase = frame % 2 === 0 ? 1 : -1;
  if (playerState !== 'slide') {
    // Left leg
    ctx.fillRect(x+6,  py+ph*0.65, 10, ph*0.35);
    // Right leg
    ctx.fillRect(x+22, py+ph*0.65, 10, ph*0.35 - legPhase*4);
  } else {
    ctx.fillRect(x+4, py+ph*0.7, 32, ph*0.3);
  }

  // Body
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(x+2, py + runBob, PLAYER_W-4, ph*0.65, 6);
  ctx.fill();

  // Head
  ctx.fillStyle = isMe ? '#fff' : '#ddd';
  ctx.beginPath();
  ctx.arc(x + PLAYER_W/2, py + runBob - 8, 14, 0, Math.PI*2);
  ctx.fill();

  // Eye
  ctx.fillStyle = '#0a0b14';
  ctx.beginPath();
  ctx.arc(x + PLAYER_W*0.65, py + runBob - 10, 3, 0, Math.PI*2);
  ctx.fill();

  // Name tag
  if (name) {
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.font      = 'bold 10px system-ui';
    const tw = ctx.measureText(name).width;
    ctx.fillRect(x + PLAYER_W/2 - tw/2 - 3, py - 28, tw+6, 14);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText(name, x + PLAYER_W/2, py - 18);
    ctx.textAlign = 'left';
  }

  // Jump dust
  if (playerState === 'jump') {
    ctx.fillStyle = 'rgba(168,85,247,0.3)';
    ctx.beginPath(); ctx.ellipse(x+PLAYER_W/2, groundY, 20, 6, 0, 0, Math.PI*2); ctx.fill();
  }

  ctx.restore();
}

/* ── OBSTACLE ── */
function drawObstacle(o) {
  const oy = o.groundY - o.h;
  ctx.save();
  if (o.type === 'rock') {
    const grad = ctx.createLinearGradient(o.x, oy, o.x+o.w, oy+o.h);
    grad.addColorStop(0,'#6b7280'); grad.addColorStop(1,'#374151');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.roundRect(o.x, oy, o.w, o.h, 8); ctx.fill();
    ctx.strokeStyle = '#9ca3af'; ctx.lineWidth = 1; ctx.stroke();
  } else if (o.type === 'cactus') {
    ctx.fillStyle = '#065f46';
    ctx.fillRect(o.x+o.w*0.35, oy, o.w*0.3, o.h);
    ctx.fillRect(o.x, oy+o.h*0.3, o.w, o.h*0.2);
    ctx.strokeStyle = '#10b981'; ctx.lineWidth = 1; ctx.strokeRect(o.x+o.w*0.35, oy, o.w*0.3, o.h);
  } else { // spike
    ctx.fillStyle = '#ef4444';
    ctx.shadowColor = '#ef4444'; ctx.shadowBlur = 6;
    for (let i=0; i<3; i++) {
      ctx.beginPath();
      ctx.moveTo(o.x + i*o.w/3, o.groundY);
      ctx.lineTo(o.x + i*o.w/3 + o.w/6, oy);
      ctx.lineTo(o.x + (i+1)*o.w/3, o.groundY);
      ctx.closePath(); ctx.fill();
    }
    ctx.shadowBlur = 0;
  }
  ctx.restore();
}

/* ── COIN ── */
function drawCoin(x, y) {
  const bob = Math.sin(Date.now()*0.004 + x*0.01)*4;
  ctx.save();
  ctx.shadowColor = '#ffd700'; ctx.shadowBlur = 10;
  ctx.fillStyle = '#ffd700';
  ctx.beginPath(); ctx.arc(x, y+bob, 10, 0, Math.PI*2); ctx.fill();
  ctx.fillStyle = '#ffaa00';
  ctx.beginPath(); ctx.arc(x+2, y+bob-2, 5, 0, Math.PI*2); ctx.fill();
  ctx.shadowBlur = 0;
  ctx.restore();
}

/* ── GEM ── */
function drawGem(x, y) {
  const bob = Math.sin(Date.now()*0.005 + x*0.01)*5;
  ctx.save();
  ctx.shadowColor = '#a855f7'; ctx.shadowBlur = 14;
  ctx.fillStyle = '#a855f7';
  // Diamond shape
  ctx.beginPath();
  ctx.moveTo(x, y+bob-14);
  ctx.lineTo(x+10, y+bob-4);
  ctx.lineTo(x, y+bob+8);
  ctx.lineTo(x-10, y+bob-4);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#c084fc';
  ctx.beginPath();
  ctx.moveTo(x-4, y+bob-8); ctx.lineTo(x+4, y+bob-8);
  ctx.lineTo(x+2, y+bob-2); ctx.lineTo(x-2, y+bob-2);
  ctx.closePath(); ctx.fill();
  ctx.shadowBlur = 0;
  ctx.restore();
}

/* ── POWER-UP ── */
function drawPowerup(x, y, type) {
  const bob  = Math.sin(Date.now()*0.006 + x*0.01)*5;
  const spin = (Date.now()*0.002) % (Math.PI*2);
  ctx.save();
  ctx.translate(x, y+bob);
  ctx.rotate(spin);
  const colors = { speed:'#facc15', shield:'#06b6d4', double:'#10b981' };
  const icons  = { speed:'⚡', shield:'🛡️', double:'💰' };
  ctx.shadowColor = colors[type]; ctx.shadowBlur = 16;
  ctx.fillStyle   = colors[type];
  ctx.beginPath();
  for (let i=0;i<5;i++) {
    const a = (i*4+1)*Math.PI/5 - Math.PI/2;
    const r = i%2===0 ? 14 : 7;
    i===0 ? ctx.moveTo(Math.cos(a)*r, Math.sin(a)*r) : ctx.lineTo(Math.cos(a)*r, Math.sin(a)*r);
  }
  ctx.closePath(); ctx.fill();
  ctx.shadowBlur  = 0;
  ctx.restore();
  // Icon (rendered in screen-space would need offset, skip for perf)
}

/* ── FINISH LINE ── */
function drawFinishLine() {
  ctx.save();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth   = 4;
  ctx.setLineDash([20,20]);
  ctx.beginPath(); ctx.moveTo(FINISH_LINE_X, groundY-200); ctx.lineTo(FINISH_LINE_X, groundY); ctx.stroke();
  ctx.setLineDash([]);

  // Checkered flag visual
  const sz = 16;
  for (let r=0;r<6;r++) {
    for (let c=0;c<2;c++) {
      ctx.fillStyle = (r+c)%2===0 ? '#fff' : '#000';
      ctx.fillRect(FINISH_LINE_X-sz/2 + c*sz, groundY-200 + r*sz, sz, sz);
    }
  }

  ctx.fillStyle = '#ffd700';
  ctx.font = 'bold 14px system-ui';
  ctx.textAlign = 'center';
  ctx.fillText('FINISH', FINISH_LINE_X, groundY - 220);
  ctx.textAlign = 'left';
  ctx.restore();
}

/* ── LEADERBOARD UPDATE ── */
function updateLeaderboard() {
  const me = state.me, op = state.op;
  const rows = [
    { name: state.playerName, dist: me.dist, coins: me.coins },
    { name: op.name, dist: op.dist||0, coins: op.coins||0 },
  ].sort((a,b) => b.dist - a.dist);

  document.getElementById('lbRows').innerHTML = rows.map((r,i)=>`
    <div class="lb-row">
      <span class="lb-name">${i===0?'🥇':'🥈'} ${r.name||'?'}</span>
      <span class="lb-dist">${Math.floor(r.dist/10)}m</span>
      <span class="lb-coins">💰${r.coins}</span>
    </div>
  `).join('');
}

/* ──────────────────────────────────────────────────────
   FIREBASE SYNC
────────────────────────────────────────────────────── */
let _itemSyncPending = false;
function scheduleItemSync() { _itemSyncPending = true; }

async function syncToFirebase(ts) {
  if (!state.running || state.gameOver) return;
  if (ts - state.lastSyncTime < SYNC_INTERVAL) return;
  state.lastSyncTime = ts;

  const me = state.me;
  const payload = {
    [`${state.playerId}`]: {
      x: Math.round(me.x),
      y: Math.round(me.y),
      state: me.state,
      coins: me.coins,
      dist:  me.dist,
      animFrame: me.animFrame,
      ts: Date.now(),
    }
  };

  if (_itemSyncPending) {
    _itemSyncPending = false;
    payload.coins    = state.coins.map(c => c.collected ? 1 : 0);
    payload.gems     = state.gems.map(g => g.collected ? 1 : 0);
    payload.powerups = state.powerups.map(p => p.collected ? 1 : 0);
  }

  try { await dataRef().set(payload, { merge: true }); } catch(e){}
}

let _gameDataUnsub = null;
function listenGameData() {
  if (_gameDataUnsub) _gameDataUnsub();
  const opId = state.playerId === 'p1' ? 'p2' : 'p1';

  _gameDataUnsub = dataRef().onSnapshot(snap => {
    if (!snap.exists) return;
    const d = snap.data();

    // Opponent position
    if (d[opId]) {
      const op = d[opId];
      state.op.x    = op.x ?? state.op.x;
      state.op.y    = op.y ?? state.op.y;
      state.op.state= op.state ?? 'run';
      state.op.coins= op.coins ?? 0;
      state.op.dist = op.dist ?? 0;
      state.op.animFrame = op.animFrame ?? 0;
      // Ping
      if (op.ts) { state.ping = Date.now() - op.ts; document.getElementById('pingVal').textContent = state.ping; }
    }

    // Sync item collection from other player
    if (d.coins)    d.coins.forEach((v,i)    => { if(v && state.coins[i])    state.coins[i].collected    = true; });
    if (d.gems)     d.gems.forEach((v,i)     => { if(v && state.gems[i])     state.gems[i].collected     = true; });
    if (d.powerups) d.powerups.forEach((v,i) => { if(v && state.powerups[i]) state.powerups[i].collected = true; });

    // Winner
    if (d.winner && !state.gameOver) {
      showWinner(d.winner, d.winnerData);
    }
  });
}

/* ──────────────────────────────────────────────────────
   CHAT
────────────────────────────────────────────────────── */
let _chatUnsub = null;
function listenChat() {
  if (_chatUnsub) _chatUnsub();
  _chatUnsub = chatRef().orderBy('ts').limitToLast(30).onSnapshot(snap => {
    const el = document.getElementById('chatMessages');
    snap.docChanges().forEach(ch => {
      if (ch.type !== 'added') return;
      const m = ch.doc.data();
      const d = document.createElement('div');
      d.className = 'chat-msg';
      const t = new Date(m.ts);
      d.innerHTML = `
        <span class="chat-name">${m.name}</span>
        <span class="chat-text">${escHtml(m.text)}</span>
        <span class="chat-time">${t.getHours()}:${String(t.getMinutes()).padStart(2,'0')}</span>`;
      el.appendChild(d);
    });
    el.scrollTop = el.scrollHeight;
  });
}

function sendChat(txt) {
  if (!txt.trim()) return;
  chatRef().add({ name: state.playerName, text: txt.trim(), ts: Date.now() }).catch(()=>{});
}

function escHtml(t) {
  return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/* ──────────────────────────────────────────────────────
   WIN / LOSE
────────────────────────────────────────────────────── */
async function triggerWin() {
  if (state.gameOver) return;
  state.gameOver = true;
  const elapsed  = Date.now() - state.startTime;

  // Write winner to Firestore
  const winner = state.playerName;
  const winnerData = { name: winner, coins: state.me.coins, time: elapsed, dist: state.me.dist };
  try { await dataRef().set({ winner, winnerData }, { merge: true }); } catch(e){}

  showWinner(winner, winnerData);
}

function showWinner(winnerName, wd) {
  if (state.screen === 'winner') return;
  state.gameOver = true;
  state.running  = false;
  cancelAnimationFrame(animFrame);
  audio.stopMusic();

  const isMe = (winnerName === state.playerName);
  const elapsed = wd?.time ?? (Date.now() - state.startTime);
  const mins = Math.floor(elapsed/60000);
  const secs = Math.floor((elapsed%60000)/1000);

  document.getElementById('winnerTitle').textContent = isMe ? '🏆 You Win!' : '💀 You Lose!';
  document.getElementById('winnerSub').textContent   = isMe
    ? `Congratulations, ${winnerName}!` : `${winnerName} won this round!`;
  document.getElementById('winnerBadge').textContent = isMe ? '🏆' : '💀';
  document.getElementById('wCoins').textContent = wd?.coins ?? state.me.coins;
  document.getElementById('wTime').textContent  = `${mins}:${String(secs).padStart(2,'0')}`;
  document.getElementById('wDist').textContent  = `${Math.floor((wd?.dist??state.me.dist)/10)}m`;

  Stats.record(isMe, state.me.coins, elapsed);

  if (isMe) audio.win(); else audio.lose();
  showScreen('winner');
}

/* ──────────────────────────────────────────────────────
   INPUT HANDLERS
────────────────────────────────────────────────────── */
function setupInput() {
  // Keyboard
  window.addEventListener('keydown', e => {
    state.keys[e.key] = true;
    if (e.key === ' ') e.preventDefault();
  });
  window.addEventListener('keyup', e => { state.keys[e.key] = false; });

  // Mobile jump / slide buttons
  const btnJump  = document.getElementById('btnJump');
  const btnSlide = document.getElementById('btnSlide');

  const setTouch = (btn, onStart, onEnd) => {
    btn.addEventListener('touchstart', e => { e.preventDefault(); onStart(); }, {passive:false});
    btn.addEventListener('touchend',   e => { e.preventDefault(); onEnd();   }, {passive:false});
    btn.addEventListener('mousedown',  onStart);
    btn.addEventListener('mouseup',    onEnd);
  };

  setTouch(btnJump,
    () => { state.mobileJump  = true; },
    () => { state.mobileJump  = false; }
  );
  setTouch(btnSlide,
    () => { state.mobileSlide = true; },
    () => { state.mobileSlide = false; }
  );

  // Joystick
  const zone  = document.getElementById('joystickZone');
  const base  = document.getElementById('joystickBase');
  const thumb = document.getElementById('joystickThumb');
  const BR    = 45; // base radius
  const TR    = 18; // thumb radius

  let jId = null, jOrig = { x:0, y:0 };

  function jStart(cx, cy) {
    const r = base.getBoundingClientRect();
    jOrig.x = r.left + r.width/2;
    jOrig.y = r.top  + r.height/2;
    state.joystick.active = true;
    jMove(cx, cy);
  }
  function jMove(cx, cy) {
    if (!state.joystick.active) return;
    let dx = cx - jOrig.x, dy = cy - jOrig.y;
    const dist = Math.sqrt(dx*dx + dy*dy);
    if (dist > BR) { dx *= BR/dist; dy *= BR/dist; }
    thumb.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    state.joystick.dx = dx / BR;
    // Vertical: jump if dy < -0.5 * BR
    if (dy < -BR*0.5) state.mobileJump = true;
    else state.mobileJump = false;
  }
  function jEnd() {
    state.joystick = { active:false, dx:0 };
    state.mobileJump = false;
    thumb.style.transform = 'translate(-50%, -50%)';
  }

  zone.addEventListener('touchstart', e => {
    e.preventDefault();
    const t = e.changedTouches[0]; jId = t.identifier; jStart(t.clientX, t.clientY);
  }, {passive:false});
  zone.addEventListener('touchmove', e => {
    e.preventDefault();
    for (const t of e.changedTouches) { if (t.identifier === jId) jMove(t.clientX, t.clientY); }
  }, {passive:false});
  zone.addEventListener('touchend', e => { jEnd(); }, {passive:false});
}

/* ──────────────────────────────────────────────────────
   SETTINGS PERSISTENCE
────────────────────────────────────────────────────── */
function loadSettings() {
  const s = JSON.parse(localStorage.getItem('tr_settings')||'{}');
  state.sfxOn   = s.sfxOn   !== false;
  state.musicOn = s.musicOn !== false;
  state.showFps = !!s.showFps;
  state.quality = s.quality || 'high';

  document.getElementById('setSfx').checked     = state.sfxOn;
  document.getElementById('setMusic').checked   = state.musicOn;
  document.getElementById('setFps').checked     = state.showFps;
  document.getElementById('setQuality').value   = state.quality;

  const fpsEl = document.getElementById('fpsCounter');
  if (state.showFps) fpsEl.classList.remove('hidden');
  else fpsEl.classList.add('hidden');
}

function saveSettings() {
  state.sfxOn   = document.getElementById('setSfx').checked;
  state.musicOn = document.getElementById('setMusic').checked;
  state.showFps = document.getElementById('setFps').checked;
  state.quality = document.getElementById('setQuality').value;
  localStorage.setItem('tr_settings', JSON.stringify({
    sfxOn: state.sfxOn, musicOn: state.musicOn,
    showFps: state.showFps, quality: state.quality
  }));
  const fpsEl = document.getElementById('fpsCounter');
  if (state.showFps) fpsEl.classList.remove('hidden');
  else fpsEl.classList.add('hidden');
}

/* ──────────────────────────────────────────────────────
   CLEANUP HELPERS
────────────────────────────────────────────────────── */
function cleanupGame() {
  state.running = false;
  cancelAnimationFrame(animFrame);
  audio.stopMusic();
  if (_gameDataUnsub) { _gameDataUnsub(); _gameDataUnsub = null; }
  if (_chatUnsub)     { _chatUnsub();     _chatUnsub     = null; }
  collectParticles.length = 0;
  state.keys = {};
  state.joystick = { active: false, dx: 0 };
  state.mobileJump = false; state.mobileSlide = false;
}

async function leaveRoom() {
  cleanupGame();
  if (_roomUnsub) { _roomUnsub(); _roomUnsub = null; }
  // Optionally clean up Firestore room
  if (state.roomId) {
    try { await roomRef().update({ status: 'abandoned' }); } catch(e){}
  }
  state.roomId = ''; state.playerId = '';
  showScreen('home');
}

/* ──────────────────────────────────────────────────────
   BUTTON WIRING
────────────────────────────────────────────────────── */
function wireButtons() {

  // ── HOME ──
  document.getElementById('btnCreate').addEventListener('click', async () => {
    audio.click();
    const name = document.getElementById('playerName').value.trim();
    if (!name) { toast('Please enter your name!'); return; }
    state.playerName = name;
    try {
      const code = await createRoom(name);
      document.getElementById('lobbyRoomCode').textContent = code;
      document.getElementById('slot1Name').textContent     = name;
      document.getElementById('btnReady').style.display    = 'block';
      showScreen('lobby');
      listenRoom();
    } catch(e) { toast('Error: ' + e.message); }
  });

  document.getElementById('btnJoin').addEventListener('click', async () => {
    audio.click();
    const name = document.getElementById('playerName').value.trim();
    const code = document.getElementById('joinCode').value.trim().toUpperCase();
    if (!name) { toast('Please enter your name!'); return; }
    if (!code) { toast('Please enter a room code!'); return; }
    state.playerName = name;
    try {
      await joinRoom(code, name);
      document.getElementById('lobbyRoomCode').textContent = code;
      document.getElementById('btnReady').style.display    = 'block';
      showScreen('lobby');
      listenRoom();
    } catch(e) { toast('Error: ' + e.message); }
  });

  document.getElementById('btnStats').addEventListener('click', () => {
    audio.click(); Stats.display(); showScreen('stats');
  });
  document.getElementById('btnSettings').addEventListener('click', () => {
    audio.click(); showScreen('settings');
  });
  document.getElementById('btnSound').addEventListener('click', () => {
    state.sfxOn = !state.sfxOn; state.musicOn = !state.musicOn;
    document.getElementById('btnSound').textContent = state.sfxOn ? '🔊 Sound' : '🔇 Muted';
    toast(state.sfxOn ? 'Sound On' : 'Sound Off');
    audio.click();
  });

  // ── LOBBY ──
  document.getElementById('btnCopyCode').addEventListener('click', () => {
    const code = document.getElementById('lobbyRoomCode').textContent;
    navigator.clipboard?.writeText(code).catch(()=>{});
    toast('Room code copied! 📋');
    audio.click();
  });

  document.getElementById('btnReady').addEventListener('click', async () => {
    audio.click();
    const field = state.playerId === 'p1' ? 'p1.ready' : 'p2.ready';
    await roomRef().update({ [field]: true });
    document.getElementById('btnReady').textContent = '✅ Ready!';
    document.getElementById('btnReady').disabled = true;

    // Check if both ready → start game (host triggers)
    const snap = await roomRef().get();
    const d = snap.data();
    if (d.p1.ready && d.p2?.ready) {
      await roomRef().update({ status: 'starting' });
    }
  });

  document.getElementById('btnLeaveLobby').addEventListener('click', async () => {
    audio.click(); await leaveRoom();
  });

  // ── WINNER ──
  document.getElementById('btnPlayAgain').addEventListener('click', async () => {
    audio.click(); cleanupGame();
    // Reset room for another game
    try {
      await roomRef().update({ status: 'lobby', 'p1.ready': false, 'p2.ready': false,
        seed: Math.floor(Math.random()*999999) });
      await dataRef().delete();
    } catch(e){}
    document.getElementById('btnReady').textContent = '✅ Ready';
    document.getElementById('btnReady').disabled    = false;
    showScreen('lobby');
    listenRoom();
  });

  document.getElementById('btnLeaveRoom').addEventListener('click', async () => {
    audio.click(); await leaveRoom();
  });

  // ── STATS / SETTINGS ──
  document.getElementById('btnBackStats').addEventListener('click', () => {
    audio.click(); showScreen('home');
  });
  document.getElementById('btnBackSettings').addEventListener('click', () => {
    audio.click(); saveSettings(); showScreen('home');
  });

  // Settings live-save
  ['setSfx','setMusic','setFps','setQuality'].forEach(id => {
    document.getElementById(id).addEventListener('change', saveSettings);
  });

  // ── CHAT ──
  document.getElementById('btnSendChat').addEventListener('click', () => {
    const inp = document.getElementById('chatInput');
    sendChat(inp.value); inp.value = '';
  });
  document.getElementById('chatInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const inp = document.getElementById('chatInput');
      sendChat(inp.value); inp.value = '';
    }
  });
  document.querySelectorAll('.emoji-btn').forEach(btn => {
    btn.addEventListener('click', () => sendChat(btn.dataset.e));
  });
}

/* ──────────────────────────────────────────────────────
   FIREBASE INIT & APP BOOT
────────────────────────────────────────────────────── */
function initFirebase() {
  try {
    firebase.initializeApp(FIREBASE_CONFIG);
    state.db = firebase.firestore();
    // Enable offline persistence for lower latency
    state.db.enablePersistence({ synchronizeTabs: true }).catch(()=>{});
    return true;
  } catch(e) {
    console.error('Firebase init failed:', e);
    return false;
  }
}

/* ──────────────────────────────────────────────────────
   MAIN ENTRY POINT
────────────────────────────────────────────────────── */
window.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  wireButtons();
  setupInput();

  const ok = initFirebase();
  if (!ok) {
    toast('⚠️ Firebase not configured. Edit FIREBASE_CONFIG in c.js', 6000);
  }

  showScreen('home');
  console.log('%c🏆 Treasure Runner Multiplayer', 'color:#ffd700;font-size:18px;font-weight:bold');
  console.log('%cReplace FIREBASE_CONFIG in c.js with your credentials.', 'color:#94a3b8');
});
