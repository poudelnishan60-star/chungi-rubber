/* Chungi Rubber — flick your tire-rubber slice onto your rival's. */
(() => {
  'use strict';

  // =====================================================================
  // Config
  // =====================================================================
  const COLORS = ['#dc143c', '#2f6fe0', '#f4b400', '#1fa67a'];
  const NEUTRAL = '#f3ede2';           // white target rubbers in Levels
  const NAMES = ['Red', 'Blue', 'Yellow', 'Green'];
  // Computer: aim noise (rad), power noise (fraction), how many of its best shots it picks from
  const CPU_SKILL = [
    { ang: 0.10, pow: 0.16, pick: 10 },
    { ang: 0.045, pow: 0.08, pick: 4 },
    { ang: 0.018, pow: 0.035, pick: 1 },
  ];
  // Versus ground: obstacle count, blocker chance per pair, how often the centre blocker is a brick,
  // how deep the overlap must be to count (lower = harder), finger shake.
  const GROUND = [
    { count: [3, 4], blockers: 0.35, brick: 0.2, overlap: 0.82, tremor: 0.012 },
    { count: [5, 7], blockers: 0.8, brick: 0.5, overlap: 0.72, tremor: 0.03 },
    { count: [8, 11], blockers: 1, brick: 0.8, overlap: 0.62, tremor: 0.05 },
  ];
  const ALL_TYPES = ['rock', 'rock', 'brick', 'brick', 'mud', 'mud', 'mud', 'slab', 'slab'];
  const LEVEL_COUNT = 30;
  // Rubber styles, unlocked with stars from Levels. Looks only — every rubber plays the same.
  const SKINS = [
    { id: 'classic', name: 'Classic tire', need: 0 },
    { id: 'bike', name: 'Bicycle tube', need: 6, thick: 0.24, treads: 0, stripe: 0.45, body: ['#5a5a60', '#2e2e33', '#1b1b1e'] },
    { id: 'truck', name: 'Truck tire', need: 15, thick: 0.47, treads: 30, treadW: 2.4 },
    { id: 'tractor', name: 'Tractor lug', need: 25, thick: 0.43, lugs: true },
    { id: 'red', name: 'Red inner tube', need: 40, thick: 0.3, treads: 0, body: ['#d65a48', '#a3301f', '#6d1a12'] },
    { id: 'gold', name: 'Golden chungi', need: 60, body: ['#ffe58a', '#d4a017', '#8a6508'], sparkle: true },
    { id: 'festival', name: 'Festival rubber', need: 80, rainbow: true },
  ];
  const PHYS_DT = 1 / 240;
  const STOP_SPEED = 6;
  const POWER_EXP = 1.35;          // power -> distance curve (small pulls are gentle, big pulls jump)
  const TURN_TIME = 10;            // seconds from first touching your rubber; then it's flicked automatically
  const MUD_FRICTION = 3.2;        // mud slows you down a lot
  const SLAB_FRICTION = 0.35;      // smooth stone slab: you slide further
  const OVER_RUBBER_FRICTION = 1.25;
  const BOUNCE = { rock: 0.62, brick: 0.5 };

  // =====================================================================
  // Storage (best effort)
  // =====================================================================
  const store = {
    get(k, d) { try { const v = localStorage.getItem('chungi.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('chungi.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
  };
  const settings = Object.assign(
    { count: 2, kinds: ['human', 'cpu', 'cpu', 'cpu'], points: 5, skill: 1, ground: 1, sound: true, music: true, skin: 'classic' },
    store.get('settings', {})
  );
  delete settings.rounds;
  if (![3, 5, 7].includes(settings.points)) settings.points = 5;
  if (![0, 1, 2].includes(settings.ground)) settings.ground = 1;
  const saveSettings = () => store.set('settings', settings);
  const progress = Object.assign({ stars: {} }, store.get('progress', {}));
  const saveProgress = () => store.set('progress', progress);
  const totalStars = () => Object.values(progress.stars).reduce((a, b) => a + b, 0);
  const skinById = (id) => SKINS.find(s => s.id === id) || SKINS[0];
  if (totalStars() < skinById(settings.skin).need) settings.skin = 'classic';

  // =====================================================================
  // Random helpers (seedable, so each level is the same every time)
  // =====================================================================
  let rng = Math.random;
  function mulberry32(a) {
    return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  }
  function withSeed(seed, fn) { const old = rng; rng = mulberry32(seed); try { return fn(); } finally { rng = old; } }
  const rand = (a, b) => a + rng() * (b - a);
  const randInt = (a, b) => Math.floor(rand(a, b + 1));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const perfNow = () => performance.now();
  function gauss() { let u = 0, v = 0; while (!u) u = rng(); while (!v) v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];

  // =====================================================================
  // Canvas & board
  // =====================================================================
  const canvas = document.getElementById('board');
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0, DPR = 1, S = 1; // S = scale unit
  let groundCanvas = null, obstacleCanvas = null;
  const board = { x0: 0, y0: 0, x1: 0, y1: 0 };
  let obstacles = [];

  function resize() {
    const oldB = { ...board }, oldS = S;
    DPR = Math.min(window.devicePixelRatio || 1, 2.5);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
    S = Math.min(W, H) / 400;
    const pad = 10 * S, inset = safeInsets();
    board.x0 = pad + inset.left; board.x1 = W - pad - inset.right;
    board.y0 = inset.top + 64 + pad * 0.5; board.y1 = H - pad - inset.bottom;
    if (oldB.x1 > oldB.x0) remap(oldB, oldS);
    buildGround();
    buildObstacleLayer();
  }
  // Keep everything in the same relative place when the screen size changes.
  function remap(oldB, oldS) {
    const fx = (v) => board.x0 + (v - oldB.x0) / (oldB.x1 - oldB.x0) * (board.x1 - board.x0);
    const fy = (v) => board.y0 + (v - oldB.y0) / (oldB.y1 - oldB.y0) * (board.y1 - board.y0);
    const k = S / oldS;
    for (const r of game.rubbers) {
      r.x = fx(r.x); r.y = fy(r.y); r.r = rubberRadius();
      if (r.prevX != null) { r.prevX = fx(r.prevX); r.prevY = fy(r.prevY); }
    }
    for (const o of obstacles) {
      o.x = fx(o.x); o.y = fy(o.y);
      for (const key of ['r', 'w', 'h', 'rx', 'ry']) if (o[key]) o[key] *= k;
    }
  }
  // Status bar / gesture bar sizes (phones draw the app edge-to-edge).
  let insetProbe = null;
  function safeInsets() {
    if (!insetProbe) {
      insetProbe = document.createElement('div');
      insetProbe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;' +
        'padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
      document.body.appendChild(insetProbe);
    }
    const cs = getComputedStyle(insetProbe), px = (v) => parseFloat(v) || 0;
    return { top: px(cs.paddingTop), right: px(cs.paddingRight), bottom: px(cs.paddingBottom), left: px(cs.paddingLeft) };
  }
  const rubberRadius = () => 34 * S;
  const maxTravel = () => Math.hypot(board.x1 - board.x0, board.y1 - board.y0) * 0.8;
  const friction = () => 520 * S; // px/s^2 constant sliding friction
  const speedFor = (power) => Math.sqrt(2 * friction() * maxTravel() * Math.pow(clamp(power, 0, 1), POWER_EXP));
  const maxPullLen = () => Math.min(W, H) * 0.36;

  // =====================================================================
  // Ground (dusty mato courtyard)
  // =====================================================================
  function buildGround() {
    groundCanvas = document.createElement('canvas');
    groundCanvas.width = canvas.width; groundCanvas.height = canvas.height;
    const g = groundCanvas.getContext('2d');
    g.scale(DPR, DPR);
    const grad = g.createRadialGradient(W / 2, H / 2, 10, W / 2, H / 2, Math.max(W, H) * 0.75);
    grad.addColorStop(0, '#d8b58a'); grad.addColorStop(1, '#a67c52');
    g.fillStyle = grad; g.fillRect(0, 0, W, H);
    const n = Math.floor(W * H / 90);
    for (let i = 0; i < n; i++) {
      const x = Math.random() * W, y = Math.random() * H;
      g.fillStyle = Math.random() < 0.5 ? `rgba(90,60,30,${0.05 + Math.random() * 0.13})` : `rgba(255,240,210,${0.05 + Math.random() * 0.15})`;
      g.fillRect(x, y, 0.6 + Math.random() * 1.2, 0.6 + Math.random() * 1.2);
    }
    for (let i = 0; i < 20; i++) {
      const x = Math.random() * W, y = Math.random() * H, r = (1.2 + Math.random() * 1.8) * S;
      g.fillStyle = 'rgba(60,40,20,.18)';
      g.beginPath(); g.ellipse(x + 1, y + 1.5, r, r * 0.75, 0, 0, 7); g.fill();
      g.fillStyle = `hsl(${20 + Math.random() * 20},${10 + Math.random() * 20}%,${55 + Math.random() * 20}%)`;
      g.beginPath(); g.ellipse(x, y, r, r * 0.75, Math.random() * 3, 0, 7); g.fill();
    }
    g.strokeStyle = 'rgba(70,45,20,.22)'; g.lineWidth = 1;
    for (let i = 0; i < 7; i++) {
      let x = Math.random() * W, y = Math.random() * H, a = Math.random() * 6.28;
      g.beginPath(); g.moveTo(x, y);
      for (let k = 0; k < 8; k++) { a += Math.random() * 1.4 - 0.7; x += Math.cos(a) * 14 * S; y += Math.sin(a) * 14 * S; g.lineTo(x, y); }
      g.stroke();
    }
    // chalk boundary: cross it and you're out
    g.setLineDash([10 * S, 7 * S]); g.lineWidth = 3 * S; g.strokeStyle = 'rgba(255,255,245,.75)';
    roundRect(g, board.x0, board.y0, board.x1 - board.x0, board.y1 - board.y0, 14 * S); g.stroke();
    g.setLineDash([]);
  }
  function roundRect(c, x, y, w, h, r) {
    c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  }

  // =====================================================================
  // Obstacles
  // =====================================================================
  const isSolid = (o) => o.type === 'rock' || o.type === 'brick';
  function local(o, x, y) { // point in obstacle's rotated frame
    const c = Math.cos(o.a), s = Math.sin(o.a), dx = x - o.x, dy = y - o.y;
    return { x: dx * c + dy * s, y: -dx * s + dy * c };
  }
  function inEllipse(o, x, y) { const p = local(o, x, y); return (p.x * p.x) / (o.rx * o.rx) + (p.y * p.y) / (o.ry * o.ry) <= 1; }
  function inRect(o, x, y) { const p = local(o, x, y); return Math.abs(p.x) <= o.w / 2 && Math.abs(p.y) <= o.h / 2; }
  function extent(o) {
    if (o.type === 'rock') return o.r;
    if (o.type === 'mud') return Math.max(o.rx, o.ry) * 1.12;
    return Math.hypot(o.w, o.h) / 2;
  }
  // distance from a point to the obstacle's edge (0 if inside)
  function edgeDist(o, x, y) {
    if (o.type === 'rock') return Math.max(0, Math.hypot(x - o.x, y - o.y) - o.r);
    const p = local(o, x, y);
    if (o.type === 'mud') {
      const k = Math.sqrt((p.x * p.x) / (o.rx * o.rx) + (p.y * p.y) / (o.ry * o.ry));
      return k <= 1 ? 0 : (k - 1) * Math.min(o.rx, o.ry);
    }
    const dx = Math.max(0, Math.abs(p.x) - o.w / 2), dy = Math.max(0, Math.abs(p.y) - o.h / 2);
    return Math.hypot(dx, dy);
  }

  function makeObstacle(type, x, y, a) {
    const o = { type, x, y, a };
    if (type === 'rock') {
      o.r = rand(13, 22) * S;
      o.pts = Array.from({ length: 9 }, () => rand(0.9, 1.08));
      const l = rand(56, 68); o.light = `hsl(30,6%,${l}%)`; o.dark = `hsl(30,8%,${l - 30}%)`;
    } else if (type === 'brick') {
      o.w = rand(64, 92) * S; o.h = rand(20, 25) * S;
      o.specks = Array.from({ length: 14 }, () => [rand(-0.95, 0.95), rand(-0.9, 0.9), rng() < 0.5]);
    } else if (type === 'mud') {
      o.rx = rand(40, 62) * S; o.ry = o.rx * rand(0.55, 0.8); o.seed = rand(0, 6.28);
    } else { // slab
      o.w = rand(82, 115) * S; o.h = rand(50, 70) * S;
      o.crack = [[rand(-0.5, -0.2), -0.5], [rand(-0.2, 0.1), rand(-0.1, 0.2)], [rand(0.1, 0.4), 0.5]];
    }
    return o;
  }

  // ---------- Fair layouts ----------
  // The board is symmetric so no starting spot is better than another:
  // 2 players: turned 180° around the centre; 4 players: mirrored both ways;
  // 3 players: mirrored left-right (the third spot is on the centre line, balanced by simulation).
  function symmetryFor(n) {
    const cx = (board.x0 + board.x1) / 2, cy = (board.y0 + board.y1) / 2;
    const flipPts = (p) => p.pts && p.pts.map((_, j, a) => a[(a.length - j) % a.length]); // rock outline under a mirror
    const id = (p) => ({ ...p });
    const rot = (p) => ({ ...p, x: 2 * cx - p.x, y: 2 * cy - p.y, a: p.a + Math.PI });
    const mx = (p) => ({ ...p, x: 2 * cx - p.x, a: Math.PI - p.a, pts: flipPts(p) });
    const my = (p) => ({ ...p, y: 2 * cy - p.y, a: -p.a, pts: flipPts(p) });
    if (n === 2) return [id, rot];
    if (n === 3) return [id, mx];
    if (n === 4) return [id, mx, my, rot];
    return [id];
  }
  const sameAngle = (a, b) => { const d = (((a - b) % Math.PI) + Math.PI) % Math.PI; return d < 1e-6 || Math.PI - d < 1e-6; };

  // cfg: { count: [min, max], blockers, brick, types }
  function genObstacles(rubbers, cfg, sym = [(p) => ({ ...p })]) {
    const r = rubberRadius(), list = [], types = cfg.types || ALL_TYPES;
    const gapBetween = (o, p) => isSolid(o) && isSolid(p) ? r * 2.3 : 6 * S; // room for a rubber to pass between solids
    const fits = (o) => {
      const e = extent(o), m = 4 * S, bar = 40; // same margin top and bottom keeps the board symmetric
      if (o.x - e < board.x0 + m || o.x + e > board.x1 - m || o.y - e < board.y0 + m + bar || o.y + e > board.y1 - m - bar) return false;
      for (const rb of rubbers) if (edgeDist(o, rb.x, rb.y) < r * 1.4) return false;
      for (const p of list) if (Math.hypot(o.x - p.x, o.y - p.y) < e + extent(p) + gapBetween(o, p)) return false;
      return true;
    };
    // Add an obstacle together with all its mirror images (or none of them).
    const addSym = (o) => {
      const imgs = [];
      for (const T of sym) {
        const q = T(o), same = imgs.find(p => Math.hypot(p.x - q.x, p.y - q.y) < 0.5);
        if (!same) { imgs.push(q); continue; }
        if (q.type !== 'rock' && !sameAngle(q.a, same.a)) return false; // sits on the centre line but isn't symmetric
      }
      for (let i = 0; i < imgs.length; i++)
        for (let j = i + 1; j < imgs.length; j++)
          if (Math.hypot(imgs[i].x - imgs[j].x, imgs[i].y - imgs[j].y) < extent(imgs[i]) * 2 + gapBetween(imgs[i], imgs[j])) return false;
      if (!imgs.every(fits)) return false;
      list.push(...imgs);
      return true;
    };
    // Blockers: a rock or brick between rubbers so the straight shot is hard.
    // The first tries sit exactly on the centre line, so they block both players equally.
    if (cfg.blockers > 0) {
      for (let i = 0; i < rubbers.length; i++) {
        for (let j = i + 1; j < rubbers.length; j++) {
          if (rng() > cfg.blockers) continue;
          const A = rubbers[i], B = rubbers[j], d = Math.hypot(B.x - A.x, B.y - A.y);
          if (d < r * 4.5) continue;
          const ang = Math.atan2(B.y - A.y, B.x - A.x), mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
          const centred = [makeObstacle('brick', mx, my, ang + Math.PI / 2), makeObstacle('rock', mx, my, 0)];
          if (rng() >= cfg.brick) centred.reverse(); // easy ground mostly gets a small rock
          if (addSym(centred[0]) || addSym(centred[1])) continue;
          for (let k = 0; k < 30; k++) {
            const t = rand(0.38, 0.62), off = rand(-0.6, 0.6) * r;
            const x = A.x + (B.x - A.x) * t - Math.sin(ang) * off, y = A.y + (B.y - A.y) * t + Math.cos(ang) * off;
            const o = rng() < 0.6 ? makeObstacle('brick', x, y, ang + Math.PI / 2 + rand(-0.4, 0.4)) : makeObstacle('rock', x, y, rand(0, 6.28));
            if (addSym(o)) break;
          }
        }
      }
    }
    // Fill the rest of the ground
    const target = randInt(cfg.count[0], cfg.count[1]);
    for (let tries = 0; types.length && list.length < target && tries < 600; tries++) {
      addSym(makeObstacle(pick(types), rand(board.x0, board.x1), rand(board.y0, board.y1), rand(0, Math.PI)));
    }
    // zones drawn first (under), solids on top
    return list.sort((a, b) => isSolid(a) - isSolid(b));
  }

  function buildObstacleLayer() {
    obstacleCanvas = document.createElement('canvas');
    obstacleCanvas.width = canvas.width; obstacleCanvas.height = canvas.height;
    const g = obstacleCanvas.getContext('2d');
    g.scale(DPR, DPR);
    for (const o of obstacles) ({ mud: drawMud, slab: drawSlab, rock: drawRock, brick: drawBrick })[o.type](g, o);
  }
  function drawMud(g, o) {
    g.save(); g.translate(o.x, o.y); g.rotate(o.a);
    const blob = (k) => {
      g.beginPath();
      for (let i = 0; i <= 40; i++) {
        const t = (i / 40) * Math.PI * 2, w = 1 + 0.08 * Math.sin(3 * t + o.seed) + 0.05 * Math.sin(5 * t + o.seed * 2);
        const x = Math.cos(t) * o.rx * w * k, y = Math.sin(t) * o.ry * w * k;
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.closePath();
    };
    g.fillStyle = 'rgba(110,72,40,.45)'; blob(1.14); g.fill();
    const gr = g.createRadialGradient(0, 0, 0, 0, 0, o.rx);
    gr.addColorStop(0, '#3f2814'); gr.addColorStop(1, '#5c3c20');
    g.fillStyle = gr; blob(1); g.fill();
    g.strokeStyle = 'rgba(255,255,255,.25)'; g.lineWidth = 2.5 * S; g.lineCap = 'round';
    g.beginPath(); g.ellipse(-o.rx * 0.2, -o.ry * 0.25, o.rx * 0.45, o.ry * 0.3, 0, Math.PI * 1.1, Math.PI * 1.7); g.stroke();
    g.beginPath(); g.ellipse(o.rx * 0.3, o.ry * 0.25, o.rx * 0.18, o.ry * 0.12, 0, Math.PI * 1.2, Math.PI * 1.8); g.stroke();
    g.restore();
  }
  function drawSlab(g, o) {
    g.save(); g.translate(o.x + 2 * S, o.y + 3 * S); g.rotate(o.a);
    g.fillStyle = 'rgba(40,25,10,.25)'; roundRect(g, -o.w / 2, -o.h / 2, o.w, o.h, 6 * S); g.fill();
    g.restore();
    g.save(); g.translate(o.x, o.y); g.rotate(o.a);
    const gr = g.createLinearGradient(-o.w / 2, -o.h / 2, o.w / 2, o.h / 2);
    gr.addColorStop(0, '#e2ddd3'); gr.addColorStop(1, '#a9a296');
    g.fillStyle = gr; roundRect(g, -o.w / 2, -o.h / 2, o.w, o.h, 6 * S); g.fill();
    g.strokeStyle = 'rgba(60,50,40,.35)'; g.lineWidth = 1.5 * S; g.stroke();
    g.strokeStyle = 'rgba(80,70,60,.4)'; g.lineWidth = 1 * S;
    g.beginPath(); o.crack.forEach(([x, y], i) => i ? g.lineTo(x * o.w, y * o.h) : g.moveTo(x * o.w, y * o.h)); g.stroke();
    g.strokeStyle = 'rgba(255,255,255,.45)'; g.lineWidth = 3 * S; g.lineCap = 'round';
    g.beginPath(); g.moveTo(-o.w * 0.38, -o.h * 0.3); g.lineTo(-o.w * 0.1, -o.h * 0.38); g.stroke();
    g.restore();
  }
  function drawRock(g, o) {
    const path = (ox, oy) => {
      g.beginPath();
      o.pts.forEach((k, i) => {
        const t = (i / o.pts.length) * Math.PI * 2 + o.a;
        const x = ox + Math.cos(t) * o.r * k, y = oy + Math.sin(t) * o.r * k * 0.92;
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      });
      g.closePath();
    };
    g.fillStyle = 'rgba(40,25,10,.35)'; path(o.x + 3 * S, o.y + 5 * S); g.fill();
    const gr = g.createRadialGradient(o.x - o.r * 0.35, o.y - o.r * 0.4, o.r * 0.1, o.x, o.y, o.r * 1.1);
    gr.addColorStop(0, o.light); gr.addColorStop(1, o.dark);
    g.fillStyle = gr; path(o.x, o.y); g.fill();
    g.strokeStyle = 'rgba(30,25,20,.5)'; g.lineWidth = 1.2 * S; g.stroke();
  }
  function drawBrick(g, o) {
    g.save(); g.translate(o.x + 3 * S, o.y + 5 * S); g.rotate(o.a);
    g.fillStyle = 'rgba(40,25,10,.35)'; roundRect(g, -o.w / 2, -o.h / 2, o.w, o.h, 3 * S); g.fill();
    g.restore();
    g.save(); g.translate(o.x, o.y); g.rotate(o.a);
    const gr = g.createLinearGradient(0, -o.h / 2, 0, o.h / 2);
    gr.addColorStop(0, '#c9653c'); gr.addColorStop(1, '#8f3a1f');
    g.fillStyle = gr; roundRect(g, -o.w / 2, -o.h / 2, o.w, o.h, 3 * S); g.fill();
    g.strokeStyle = '#5e2412'; g.lineWidth = 1.5 * S; g.stroke();
    g.fillStyle = 'rgba(70,25,10,.45)'; roundRect(g, -o.w * 0.28, -o.h * 0.22, o.w * 0.56, o.h * 0.44, 2 * S); g.fill();
    for (const s of o.specks) {
      g.fillStyle = s[2] ? 'rgba(255,220,180,.3)' : 'rgba(60,20,5,.35)';
      g.fillRect(s[0] * o.w / 2, s[1] * o.h / 2, 1.5 * S, 1.5 * S);
    }
    g.restore();
  }

  // =====================================================================
  // Physics (shared by the real game, the computer's planning and level checks)
  // =====================================================================
  function zoneFactor(x, y) {
    let f = 1;
    for (const o of obstacles) {
      if (o.type === 'mud' && inEllipse(o, x, y)) f *= MUD_FRICTION;
      else if (o.type === 'slab' && inRect(o, x, y)) f *= SLAB_FRICTION;
    }
    return f;
  }
  function reflect(b, nx, ny, e) {
    const vn = b.vx * nx + b.vy * ny;
    if (vn >= 0) return 0;
    b.vx -= (1 + e) * vn * nx; b.vy -= (1 + e) * vn * ny;
    b.vx *= 0.94; b.vy *= 0.94;
    return -vn;
  }
  function collideRock(b, o) {
    const dx = b.x - o.x, dy = b.y - o.y, d = Math.hypot(dx, dy), R = b.r * 0.98 + o.r * 0.97;
    if (d >= R || d === 0) return 0;
    const nx = dx / d, ny = dy / d;
    b.x = o.x + nx * R; b.y = o.y + ny * R;
    return reflect(b, nx, ny, BOUNCE.rock);
  }
  function collideBrick(b, o) {
    const p = local(o, b.x, b.y), R = b.r * 0.98, hw = o.w / 2, hh = o.h / 2;
    const qx = clamp(p.x, -hw, hw), qy = clamp(p.y, -hh, hh);
    const dx = p.x - qx, dy = p.y - qy, d = Math.hypot(dx, dy);
    if (d >= R) return 0;
    let nx, ny;
    if (d < 1e-6) { // centre inside the brick: push out along the shortest side
      if (hw - Math.abs(p.x) < hh - Math.abs(p.y)) { nx = Math.sign(p.x) || 1; ny = 0; p.x = nx * (hw + R); }
      else { nx = 0; ny = Math.sign(p.y) || 1; p.y = ny * (hh + R); }
    } else { nx = dx / d; ny = dy / d; p.x = qx + nx * R; p.y = qy + ny * R; }
    const c = Math.cos(o.a), s = Math.sin(o.a);
    b.x = o.x + p.x * c - p.y * s; b.y = o.y + p.x * s + p.y * c;
    return reflect(b, nx * c - ny * s, nx * s + ny * c, BOUNCE.brick);
  }
  // One fixed physics step for the moving rubber. Returns 'stop', 'out', a hit, or null.
  function physStep(b, others) {
    const sp = Math.hypot(b.vx, b.vy);
    if (sp < STOP_SPEED) { b.vx = b.vy = 0; return 'stop'; }
    let mu = friction() * zoneFactor(b.x, b.y);
    for (const o of others) if (Math.hypot(o.x - b.x, o.y - b.y) < (o.r + b.r) * 0.8) { mu *= OVER_RUBBER_FRICTION; break; }
    const ns = Math.max(0, sp - mu * PHYS_DT);
    b.vx *= ns / sp; b.vy *= ns / sp;
    b.x += b.vx * PHYS_DT; b.y += b.vy * PHYS_DT;
    let hit = null;
    for (const o of obstacles) {
      if (!isSolid(o)) continue;
      const impact = o.type === 'rock' ? collideRock(b, o) : collideBrick(b, o);
      if (impact > 25) hit = { o, impact };
    }
    if (b.x < board.x0 || b.x > board.x1 || b.y < board.y0 || b.y > board.y1) return 'out';
    return hit;
  }
  function simulate(start, vx, vy, others) {
    const b = { x: start.x, y: start.y, vx, vy, r: start.r };
    let bounces = 0;
    for (let i = 0; i < 240 * 10; i++) {
      const ev = physStep(b, others);
      if (ev === 'stop') break;
      if (ev === 'out') return { out: true, b, bounces };
      if (ev) bounces++;
    }
    return { out: false, b, bounces };
  }
  // Has rubber a landed properly on top of b?
  function landedOn(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y) < (a.r + b.r) * game.rules.overlap;
  }

  // =====================================================================
  // Rubber
  // =====================================================================
  const colorOf = (rb) => rb.player < 0 ? NEUTRAL : COLORS[rb.player];
  function makeRubber(player, x, y, skinId = 'classic') {
    const skin = skinById(skinId);
    return {
      player, x, y, vx: 0, vy: 0, angle: rand(0, Math.PI * 2), spin: 0, r: rubberRadius(), skin,
      wob: [rand(0, 6.28), rand(0, 6.28), rand(0, 6.28), rand(0.03, 0.07), rand(0.02, 0.05)],
      stretch: rand(1.05, 1.22), thick: skin.thick ? skin.thick * rand(0.95, 1.05) : rand(0.34, 0.4), lift: 0, z: 0, alpha: 1,
    };
  }
  function outerR(rb, t) {
    const w = rb.wob;
    return rb.r * (1 + w[3] * Math.sin(2 * t + w[0]) + w[4] * Math.sin(3 * t + w[1]));
  }
  function drawRubber(rb, highlight, c = ctx) {
    const N = 56, col = colorOf(rb), skin = rb.skin || SKINS[0], now = perfNow();
    c.save();
    c.globalAlpha = rb.alpha;
    c.translate(rb.x, rb.y);
    const so = (3 + rb.lift * 10) * S;
    c.save();
    c.translate(so * 0.6, so);
    c.rotate(rb.angle); c.scale(rb.stretch, 1 / rb.stretch);
    c.fillStyle = `rgba(40,25,10,${0.32 - rb.lift * 0.12})`;
    ringPath(c, rb, N, 1.02); c.fill('evenodd');
    c.restore();

    if (highlight) {
      const pulse = 0.5 + 0.5 * Math.sin(now / 220);
      c.save(); c.rotate(rb.angle); c.scale(rb.stretch, 1 / rb.stretch);
      c.strokeStyle = col; c.globalAlpha = 0.35 + pulse * 0.4; c.lineWidth = (5 + pulse * 3) * S;
      c.beginPath(); c.arc(0, 0, rb.r * 1.25, 0, 7); c.stroke();
      c.restore();
    }

    c.rotate(rb.angle);
    let sc = 1 + rb.lift * 0.08;
    if (rb.popT) { const k = (now - rb.popT) / 450; if (k < 1) sc *= 1 + 0.16 * Math.sin(k * Math.PI) * (1 - k * 0.5); }
    c.scale(rb.stretch * sc, sc / rb.stretch);
    const body = skin.body || ['#3b3b3e', '#1c1c1e', '#0d0d0f'];
    const grad = c.createLinearGradient(-rb.r, -rb.r, rb.r, rb.r);
    grad.addColorStop(0, body[0]); grad.addColorStop(0.5, body[1]); grad.addColorStop(1, body[2]);
    c.fillStyle = grad;
    ringPath(c, rb, N, 1); c.fill('evenodd');
    const th = rb.thick * rb.r;
    // treads
    if (skin.lugs) {
      c.strokeStyle = 'rgba(0,0,0,.6)'; c.lineWidth = 3.4 * S;
      for (let i = 0; i < 16; i++) {
        const t = (i / 16) * Math.PI * 2, t2 = t + (i % 2 ? 0.13 : -0.13), ro = outerR(rb, t);
        c.beginPath(); c.moveTo(Math.cos(t) * (ro - th * 0.05), Math.sin(t) * (ro - th * 0.05));
        c.lineTo(Math.cos(t2) * (ro - th * 0.55), Math.sin(t2) * (ro - th * 0.55)); c.stroke();
      }
    } else {
      const n = skin.treads ?? 22;
      c.lineWidth = (skin.rainbow ? 2.6 : skin.treadW || 1.6) * S;
      for (let i = 0; i < n; i++) {
        const t = (i / n) * Math.PI * 2, ro = outerR(rb, t), cs = Math.cos(t), sn = Math.sin(t);
        c.strokeStyle = skin.rainbow ? `hsl(${(i * 360 / n + now / 15) % 360},90%,60%)` : 'rgba(0,0,0,.55)';
        c.beginPath(); c.moveTo(cs * (ro - th * 0.08), sn * (ro - th * 0.08)); c.lineTo(cs * (ro - th * 0.45), sn * (ro - th * 0.45)); c.stroke();
      }
    }
    // painted stripe in the player's colour
    c.strokeStyle = col; c.lineWidth = th * (skin.stripe || 0.3); c.lineCap = 'round';
    c.beginPath();
    for (let i = 0; i <= N; i++) {
      const t = (i / N) * Math.PI * 2, rr = outerR(rb, t) - th * 0.68;
      const px = Math.cos(t) * rr, py = Math.sin(t) * rr;
      i ? c.lineTo(px, py) : c.moveTo(px, py);
    }
    c.stroke();
    // rim highlight
    c.strokeStyle = 'rgba(255,255,255,.18)'; c.lineWidth = 1.4 * S;
    c.beginPath();
    for (let i = 0; i <= N / 2; i++) {
      const t = Math.PI * 1.05 + (i / N) * Math.PI * 2 * 0.45, rr = outerR(rb, t) - 1.5 * S;
      const px = Math.cos(t) * rr, py = Math.sin(t) * rr;
      i ? c.lineTo(px, py) : c.moveTo(px, py);
    }
    c.stroke();
    if (skin.sparkle) {
      for (let k = 0; k < 2; k++) {
        const t = now / 900 + k * Math.PI, ro = outerR(rb, t) - th * 0.25;
        const x = Math.cos(t) * ro, y = Math.sin(t) * ro, s = (3 + 2 * Math.sin(now / 160 + k * 2)) * S;
        c.fillStyle = 'rgba(255,255,235,.95)';
        c.fillRect(x - s / 2, y - 0.6 * S, s, 1.2 * S); c.fillRect(x - 0.6 * S, y - s / 2, 1.2 * S, s);
      }
    }
    c.restore();
  }
  function ringPath(c, rb, N, k) {
    const th = rb.thick * rb.r;
    c.beginPath();
    for (let i = 0; i <= N; i++) {
      const t = (i / N) * Math.PI * 2, rr = outerR(rb, t) * k;
      const px = Math.cos(t) * rr, py = Math.sin(t) * rr;
      i ? c.lineTo(px, py) : c.moveTo(px, py);
    }
    c.closePath();
    for (let i = N; i >= 0; i--) {
      const t = (i / N) * Math.PI * 2, rr = (outerR(rb, t) - th * (1 + 0.12 * Math.sin(5 * t + rb.wob[2]))) * k;
      const px = Math.cos(t) * rr, py = Math.sin(t) * rr;
      i === N ? c.moveTo(px, py) : c.lineTo(px, py);
    }
    c.closePath();
  }

  // =====================================================================
  // Effects: particles, ripples, floating text, shake
  // =====================================================================
  const particles = [], ripples = [], floaters = [];
  function burst(x, y, n, color, speed, size, life, grav = 0, under = false) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, sp = speed * (0.3 + Math.random() * 0.7);
      particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life, max: life, size: size * (0.6 + Math.random() * 0.7), grav, under,
        color: Array.isArray(color) ? color[Math.floor(Math.random() * color.length)] : color, rot: Math.random() * 6, vr: Math.random() * 20 - 10 });
    }
  }
  const ripple = (x, y, color, maxR, dur = 600) => ripples.push({ x, y, color, maxR, dur, t0: perfNow() });
  const floater = (x, y, text, color = '#fff') => floaters.push({ x, y, text, color, t0: perfNow() });
  function clearEffects() { particles.length = 0; ripples.length = 0; floaters.length = 0; }
  function updateEffects(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= dt;
      if (p.life <= 0) { particles.splice(i, 1); continue; }
      p.x += p.vx * dt; p.y += p.vy * dt; p.vy += p.grav * dt;
      const k = Math.pow(0.1, dt); p.vx *= k; if (!p.grav) p.vy *= k;
      p.rot += p.vr * dt;
    }
    const now = perfNow();
    for (let i = ripples.length - 1; i >= 0; i--) if (now - ripples[i].t0 > ripples[i].dur) ripples.splice(i, 1);
    for (let i = floaters.length - 1; i >= 0; i--) if (now - floaters[i].t0 > 1200) floaters.splice(i, 1);
    game.shake *= Math.pow(0.002, dt);
  }
  function drawParticles(under) {
    for (const p of particles) {
      if (!!p.under !== under) continue;
      ctx.save();
      ctx.globalAlpha = clamp(p.life / p.max, 0, 1) * (under ? 0.45 : 1);
      ctx.fillStyle = p.color;
      ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      if (under) { ctx.beginPath(); ctx.arc(0, 0, p.size / 2, 0, 7); ctx.fill(); }
      else ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * (p.grav ? 0.6 : 1));
      ctx.restore();
    }
  }
  function drawRipples() {
    const now = perfNow();
    for (const r of ripples) {
      const k = clamp((now - r.t0) / r.dur, 0, 1), e = 1 - Math.pow(1 - k, 3);
      ctx.save();
      ctx.globalAlpha = 1 - k; ctx.strokeStyle = r.color; ctx.lineWidth = (1 + 5 * (1 - k)) * S;
      ctx.beginPath(); ctx.arc(r.x, r.y, r.maxR * (0.35 + 0.65 * e), 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
  }
  function drawFloaters() {
    const now = perfNow();
    for (const f of floaters) {
      const k = clamp((now - f.t0) / 1200, 0, 1), y = f.y - 55 * S * (1 - Math.pow(1 - k, 2));
      ctx.save();
      ctx.globalAlpha = 1 - k * k;
      ctx.font = `900 ${Math.round(24 * S * (1 + 0.25 * Math.sin(Math.min(1, k * 4) * Math.PI)))}px system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineWidth = 5 * S; ctx.strokeStyle = '#2b1d12'; ctx.strokeText(f.text, f.x, y);
      ctx.fillStyle = f.color; ctx.fillText(f.text, f.x, y);
      ctx.restore();
    }
  }

  // =====================================================================
  // Audio: sound effects + madal-style background rhythm
  // =====================================================================
  let actx = null;
  function getCtx() {
    if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; } }
    if (actx.state === 'suspended') actx.resume();
    return actx;
  }
  const audio = () => settings.sound ? getCtx() : null;
  function noiseBurst(dur, freq, gain, type = 'bandpass') {
    const a = audio(); if (!a) return;
    const len = Math.floor(a.sampleRate * dur), buf = a.createBuffer(1, len, a.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    const src = a.createBufferSource(); src.buffer = buf;
    const f = a.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = 1.2;
    const g = a.createGain(); g.gain.value = gain;
    src.connect(f).connect(g).connect(a.destination); src.start();
  }
  function tone(freq, t0, dur, gain = 0.15, type = 'triangle') {
    const a = audio(); if (!a) return;
    const o = a.createOscillator(), g = a.createGain();
    o.type = type; o.frequency.value = freq;
    const t = a.currentTime + t0;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(a.destination); o.start(t); o.stop(t + dur + 0.05);
  }
  const sfx = {
    flick: (p) => { noiseBurst(0.06, 2500, 0.5 + p * 0.5, 'highpass'); tone(180 + p * 120, 0, 0.08, 0.12, 'square'); },
    rock: (k) => { noiseBurst(0.04, 3200, 0.3 + k * 0.4); tone(900 + Math.random() * 300, 0, 0.05, 0.1, 'square'); },
    brick: (k) => { noiseBurst(0.07, 450, 0.4 + k * 0.4); tone(130, 0, 0.09, 0.14, 'sine'); },
    mud: () => { noiseBurst(0.22, 260, 0.45, 'lowpass'); },
    land: () => noiseBurst(0.08, 350, 0.25, 'lowpass'),
    heart: () => { tone(62, 0, 0.16, 0.3, 'sine'); tone(55, 0.2, 0.2, 0.25, 'sine'); },
    out: () => { [440, 330, 220].forEach((f, i) => tone(f, i * 0.09, 0.16, 0.12, 'sine')); },
    close: () => { tone(392, 0, 0.18, 0.1); tone(311, 0.16, 0.3, 0.1); },
    collect: () => { tone(784, 0, 0.12, 0.14); tone(1175, 0.08, 0.2, 0.14); },
    win: () => { [523, 659, 784, 1046].forEach((f, i) => tone(f, i * 0.11, 0.3, 0.16)); },
    trick: () => { [523, 784, 659, 1046, 1318].forEach((f, i) => tone(f, i * 0.09, 0.28, 0.16)); },
    match: () => { [392, 523, 659, 784, 659, 1046].forEach((f, i) => tone(f, i * 0.13, 0.35, 0.16)); },
    fail: () => { [392, 349, 311, 262].forEach((f, i) => tone(f, i * 0.14, 0.3, 0.12, 'sine')); },
    turn: () => tone(880, 0, 0.08, 0.05, 'sine'),
    tick: (last) => tone(last ? 1320 : 990, 0, 0.07, 0.09, 'square'),
    timeUp: () => { tone(220, 0, 0.25, 0.14, 'sawtooth'); noiseBurst(0.1, 900, 0.3); },
  };
  const buzz = (ms) => { try { navigator.vibrate && navigator.vibrate(ms); } catch { /* ignore */ } };

  // Background rhythm: madal-like "dhin" (low) and "ta" (slap), a soft shaker and the odd plucked note.
  const music = { timer: null, step: 0, next: 0, out: null };
  const MUSIC_SCALE = [293.66, 329.63, 369.99, 440, 493.88, 587.33];
  const MAD_LOW = [1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 0];
  const MAD_HIGH = [0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 0, 1, 1];
  function mDrum(a, t, f0, f1, dur, gain) {
    const o = a.createOscillator(), g = a.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(music.out); o.start(t); o.stop(t + dur + 0.02);
  }
  function mNoise(a, t, freq, dur, gain, type) {
    const len = Math.floor(a.sampleRate * dur), buf = a.createBuffer(1, len, a.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 4);
    const src = a.createBufferSource(); src.buffer = buf;
    const f = a.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = 1.5;
    const g = a.createGain(); g.gain.value = gain;
    src.connect(f).connect(g).connect(music.out); src.start(t);
  }
  function mPluck(a, t, f) {
    const o = a.createOscillator(), g = a.createGain();
    o.type = 'triangle'; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.07, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.8);
    o.connect(g).connect(music.out); o.start(t); o.stop(t + 0.85);
  }
  function musicTick() {
    const a = actx;
    if (!a || a.state !== 'running') return;
    const stepDur = 60 / 104 / 2;
    if (music.next < a.currentTime) music.next = a.currentTime + 0.05;
    while (music.next < a.currentTime + 0.2) {
      const s = music.step, t = music.next;
      if (MAD_LOW[s]) mDrum(a, t, 120, 52, 0.3, 0.32);
      if (MAD_HIGH[s]) { mNoise(a, t, 2400, 0.07, 0.2, 'bandpass'); mDrum(a, t, 540, 400, 0.06, 0.05); }
      mNoise(a, t, 7500, 0.03, s % 2 ? 0.02 : 0.04, 'highpass');
      if (s % 4 === 0 && Math.random() < 0.5) mPluck(a, t, MUSIC_SCALE[Math.floor(Math.random() * MUSIC_SCALE.length)] * (Math.random() < 0.25 ? 0.5 : 1));
      music.next += stepDur; music.step = (s + 1) % 16;
    }
  }
  function startMusic() {
    if (!settings.music || music.timer || document.hidden) return;
    const a = getCtx(); if (!a) return;
    if (!music.out) { music.out = a.createGain(); music.out.gain.value = 0.5; music.out.connect(a.destination); }
    music.next = a.currentTime + 0.1; music.step = 0;
    music.timer = setInterval(musicTick, 60);
  }
  function stopMusic() { clearInterval(music.timer); music.timer = null; }

  // =====================================================================
  // Game state
  // =====================================================================
  const game = {
    mode: 'menu', // menu | aim | moving | out | over | paused
    kind: 'versus', // versus | level
    rules: { overlap: GROUND[1].overlap, tremor: GROUND[1].tremor },
    rubbers: [], players: [], turn: 0, starter: 0, mover: null, round: 1,
    aim: null, cpuAim: null, outAnim: null, zTop: 1, token: 0, acc: 0, shake: 0,
    turnEnds: null, timeLeft: null, lastTick: 0, // turnEnds stays null until the player touches their rubber
    timeScale: 1, drama: false,
    level: 1, flicksLeft: 0, flicksUsed: 0, streak: { player: -1, n: 0 },
  };
  const current = () => game.rubbers[game.turn];
  const humanCount = () => game.players.filter(q => q.kind === 'human').length;
  // rubbers still in this round (knocked-out / collected ones are gone until the next round)
  const alive = () => game.rubbers.filter(r => !r.dead);
  const rivalsOf = (rb) => game.rubbers.filter(o => o !== rb && !o.dead);

  // ---------------------------------------------------------------------
  // Versus
  // ---------------------------------------------------------------------
  function newMatch() {
    game.kind = 'versus';
    const gr = GROUND[settings.ground];
    game.rules = { overlap: gr.overlap, tremor: gr.tremor };
    game.players = [];
    for (let i = 0; i < settings.count; i++) {
      game.players.push({ id: i, kind: settings.kinds[i], score: 0, name: settings.kinds[i] === 'cpu' ? `${NAMES[i]} (CPU)` : NAMES[i] });
    }
    game.starter = Math.floor(Math.random() * settings.count);
    game.round = 1;
    game.streak = { player: -1, n: 0 };
    newRound();
  }

  // Symmetric starting spots (see symmetryFor), handed out to players in random order.
  function placeRubbers(n) {
    const r = rubberRadius(), cx = (board.x0 + board.x1) / 2, cy = (board.y0 + board.y1) / 2;
    const minD = Math.min(board.x1 - board.x0, board.y1 - board.y0) * (n > 2 ? 0.4 : 0.55);
    const x0 = board.x0 + r * 2, x1 = board.x1 - r * 2, y0 = board.y0 + r * 2 + 50, y1 = board.y1 - r * 2 - 50;
    let pos = null;
    for (let k = 0; k < 600; k++) {
      let c;
      if (n === 2) { const a = { x: rand(x0, x1), y: rand(y0, y1) }; c = [a, { x: 2 * cx - a.x, y: 2 * cy - a.y }]; }
      else if (n === 3) { const a = { x: rand(x0, cx), y: rand(y0, y1) }; c = [a, { x: 2 * cx - a.x, y: a.y }, { x: cx, y: rand(y0, y1) }]; }
      else { const a = { x: rand(x0, cx), y: rand(y0, cy) }; c = [a, { x: 2 * cx - a.x, y: a.y }, { x: a.x, y: 2 * cy - a.y }, { x: 2 * cx - a.x, y: 2 * cy - a.y }]; }
      if (c.every((p, i) => c.every((q, j) => i === j || Math.hypot(p.x - q.x, p.y - q.y) >= minD))) { pos = c; break; }
    }
    pos = pos || Array.from({ length: n }, (_, i) => ({ x: cx, y: y0 + (y1 - y0) * (i / Math.max(1, n - 1)) }));
    for (let i = pos.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [pos[i], pos[j]] = [pos[j], pos[i]]; }
    const ownerSkin = game.players[0] && game.players[0].kind === 'human' ? settings.skin : 'classic';
    return pos.map((p, i) => Object.assign(makeRubber(i, p.x, p.y, i === 0 ? ownerSkin : 'classic'), { z: i }));
  }

  // How easy is it to score from a spot? Fires the same fixed set of test shots from every rubber.
  const PROBES = (() => {
    let s = 20261105;
    const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
    const g = () => Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());
    // Mirror-symmetric on purpose: each aimed shot also has its left/right twin, and the
    // wild shots cover 12 evenly spaced directions at 3 strengths.
    const half = Array.from({ length: 8 }, () => ({ da: Math.abs(g()) * 0.25, dp: g() * 0.2 }));
    const wild = [];
    for (let i = 0; i < 12; i++) for (const p of [0.35, 0.6, 0.85]) wild.push({ a: (i / 12) * Math.PI * 2, p });
    return { aimed: half.flatMap(h => [h, { da: -h.da, dp: h.dp }]), wild };
  })();
  // Score per shot: 1 for landing on top, partial credit for ending close to a rival, 0 for out.
  function scoringChance(me, rubbers) {
    const others = rubbers.filter(o => o !== me);
    let hits = 0, shots = 0;
    const tryShot = (ang, pow) => {
      const v = speedFor(clamp(pow, 0.04, 1)), res = simulate(me, Math.cos(ang) * v, Math.sin(ang) * v, others);
      shots++;
      if (res.out) return;
      if (others.some(o => landedOn(res.b, o))) { hits++; return; }
      const near = Math.min(...others.map(o => Math.hypot(o.x - res.b.x, o.y - res.b.y)));
      hits += 0.5 * Math.max(0, 1 - near / (me.r * 5));
    };
    for (const o of others) {
      const base = Math.atan2(o.y - me.y, o.x - me.x), p0 = Math.pow(Math.hypot(o.x - me.x, o.y - me.y) / maxTravel(), 1 / POWER_EXP);
      for (const pr of PROBES.aimed) tryShot(base + pr.da, p0 * (1 + pr.dp));
    }
    for (const pr of PROBES.wild) tryShot(pr.a, pr.p);
    return hits / shots;
  }

  function newRound() {
    clearEffects();
    const n = game.players.length, sym = symmetryFor(n), gr = GROUND[settings.ground];
    if (n === 3) {
      // 3 players can't be perfectly mirrored, so try several layouts and keep the most even one.
      let best = null;
      const t0 = perfNow();
      for (let k = 0; k < 20 && (k < 3 || perfNow() - t0 < 250); k++) {
        const rubbers = placeRubbers(n);
        obstacles = genObstacles(rubbers, gr, sym);
        const ch = rubbers.map(rb => scoringChance(rb, rubbers)), spread = Math.max(...ch) - Math.min(...ch);
        if (!best || spread < best.spread) best = { rubbers, obstacles, spread };
        if (spread <= 0.03) break;
      }
      game.rubbers = best.rubbers; obstacles = best.obstacles;
    } else {
      game.rubbers = placeRubbers(n);
      obstacles = genObstacles(game.rubbers, gr, sym);
    }
    buildObstacleLayer();
    game.zTop = n;
    game.turn = game.starter;
    game.starter = (game.starter + 1) % n;
    toast(`Round ${game.round}`);
    startTurn();
  }

  // ---------------------------------------------------------------------
  // Levels: land on every white rubber within a few flicks
  // ---------------------------------------------------------------------
  function levelConfig(n) {
    const lin = (n - 1) / (LEVEL_COUNT - 1), t = Math.pow(lin, 0.7); // ramps up quickly at the start
    return {
      targets: n <= 2 ? 1 : n <= 7 ? 2 : n <= 18 ? (n % 3 === 0 ? 2 : 3) : 3,
      count: n === 1 ? [1, 1] : [Math.round(2 + t * 6), Math.round(3 + t * 8)],
      blockers: n === 1 ? 0 : Math.min(1, 0.55 + t),
      brick: 0.4 + t * 0.5,
      types: n <= 2 ? ['rock', 'brick'] : n <= 4 ? ['rock', 'brick', 'mud'] : ALL_TYPES,
      overlap: 0.78 - t * 0.16,   // stricter landing as you go
      tremor: 0.02 + t * 0.035,   // shakier finger as you go
      spare: n === 1 ? 2 : 1,     // extra flicks beyond one per target
      reach: 0.5 + t * 0.4,       // how far away the targets are
      // How often a decent player's straight first shot may score (checked by simulation):
      // about half the time on level 1, down to 1 in 10 on level 30.
      maxEase: 0.5 - lin * 0.4,
      minEase: n <= 3 ? 0.15 : n <= 10 ? 0.06 : 0, // early levels always leave some open straight shot
    };
  }
  // Share of straight shots by a decent player (±3.5° aim, ±10% power) that land on a target.
  function levelEase(me, targets) {
    let hits = 0, shots = 0;
    for (const o of targets) {
      const base = Math.atan2(o.y - me.y, o.x - me.x), p0 = Math.pow(Math.hypot(o.x - me.x, o.y - me.y) / maxTravel(), 1 / POWER_EXP);
      let bestP = p0, bestD = Infinity;
      for (const k of [0.85, 0.92, 1, 1.08, 1.16, 1.25]) { // the strength that stops closest to the target
        const v = speedFor(clamp(p0 * k, 0.02, 1)), r = simulate(me, Math.cos(base) * v, Math.sin(base) * v, targets);
        const d = r.out ? Infinity : Math.hypot(r.b.x - o.x, r.b.y - o.y);
        if (d < bestD) { bestD = d; bestP = p0 * k; }
      }
      for (let i = 0; i < 24; i++) {
        const a = base + gauss() * 0.06, v = speedFor(clamp(bestP * (1 + gauss() * 0.1), 0.02, 1));
        const r = simulate(me, Math.cos(a) * v, Math.sin(a) * v, targets);
        shots++;
        if (!r.out && targets.some(q => landedOn(r.b, q))) hits++;
      }
    }
    return shots ? hits / shots : 0;
  }
  function layoutLevel(cfg) {
    const r = rubberRadius(), bw = board.x1 - board.x0, bh = board.y1 - board.y0, cx = (board.x0 + board.x1) / 2;
    const me = makeRubber(0, cx + rand(-0.22, 0.22) * bw, board.y1 - r * 2 - 50 - rand(0, 0.08) * bh);
    const dMin = bh * (0.18 + cfg.reach * 0.35), dMax = bh * (0.3 + cfg.reach * 0.7);
    const targets = [];
    for (let k = 0; k < 400 && targets.length < cfg.targets; k++) {
      const x = rand(board.x0 + r * 2, board.x1 - r * 2), y = rand(board.y0 + r * 2 + 10, board.y1 - r * 2 - 50);
      const d = Math.hypot(x - me.x, y - me.y);
      if (d < dMin || d > dMax || targets.some(t => Math.hypot(t.x - x, t.y - y) < r * 3.4)) continue;
      targets.push(makeRubber(-1, x, y));
    }
    return [me, ...targets];
  }
  // Can the level be cleared with one flick per target (so ★★★ is always possible)?
  function levelSolvable(me0, targets, shots) {
    let me = { x: me0.x, y: me0.y, r: me0.r }, left = targets.slice();
    for (let s = 0; s < shots && left.length; s++) {
      let found = null, hits = 0;
      const tryShot = (ang, pow) => {
        const v = speedFor(clamp(pow, 0.04, 1)), res = simulate(me, Math.cos(ang) * v, Math.sin(ang) * v, left);
        if (res.out) return;
        const got = left.filter(q => landedOn(res.b, q));
        if (!got.length) return;
        hits++;
        if (!found || got.length > found.got.length) found = { b: res.b, got };
      };
      for (const o of left) {
        const base = Math.atan2(o.y - me.y, o.x - me.x), p0 = Math.pow(Math.hypot(o.x - me.x, o.y - me.y) / maxTravel(), 1 / POWER_EXP);
        for (let i = 0; i < 40; i++) tryShot(base + gauss() * 0.15, p0 * (1 + gauss() * 0.15));
      }
      for (let i = 0; i < 40; i++) tryShot(rand(0, Math.PI * 2), rand(0.1, 1)); // bank shots
      if (!found || hits < 2) return false; // needs a shot that isn't razor-thin
      me = { x: found.b.x, y: found.b.y, r: me.r };
      left = left.filter(q => !found.got.includes(q));
    }
    return left.length === 0;
  }
  const levelCache = {};
  const levelKey = (n) => `${n}:${Math.round(board.x1 - board.x0)}x${Math.round(board.y1 - board.y0)}`;
  function buildLevel(n) {
    const key = levelKey(n);
    if (levelCache[key]) return JSON.parse(levelCache[key]);
    const cfg = levelConfig(n), savedObs = obstacles, savedRules = game.rules;
    game.rules = { overlap: cfg.overlap, tremor: cfg.tremor };
    let found = null, best = null;
    try {
      // Keep the first layout that is clearable in one flick per target AND inside the
      // difficulty band for this level; otherwise the closest one we saw.
      for (let k = 0; k < 40 && !found; k++) {
        withSeed(n * 7919 + k * 104729, () => {
          const rubbers = layoutLevel(cfg);
          if (rubbers.length - 1 < cfg.targets) return;
          obstacles = genObstacles(rubbers, cfg);
          const ease = levelEase(rubbers[0], rubbers.slice(1));
          const miss = Math.max(0, ease - cfg.maxEase) + Math.max(0, cfg.minEase - ease);
          if (best && miss >= best.miss) return;
          if (!levelSolvable(rubbers[0], rubbers.slice(1), cfg.targets)) return;
          best = { me: { x: rubbers[0].x, y: rubbers[0].y }, targets: rubbers.slice(1).map(t => ({ x: t.x, y: t.y })), obstacles, ease, miss };
          if (miss === 0) found = best;
        });
      }
      found = found || best;
      if (!found) { // fallback: same idea, open ground
        withSeed(n * 7919, () => {
          const rubbers = layoutLevel(cfg);
          found = { me: { x: rubbers[0].x, y: rubbers[0].y }, targets: rubbers.slice(1).map(t => ({ x: t.x, y: t.y })), obstacles: [] };
        });
      }
    } finally { obstacles = savedObs; game.rules = savedRules; }
    levelCache[key] = JSON.stringify(found);
    return JSON.parse(levelCache[key]);
  }

  function startLevel(n) {
    n = clamp(n, 1, LEVEL_COUNT);
    if (!levelCache[levelKey(n)]) { // first time: show the level name, then build (can take a moment)
      game.mode = 'over'; game.token++;
      toast(`Level ${n}`); showHint('Setting up the ground…');
      const tok = game.token;
      setTimeout(() => { if (tok === game.token) { buildLevel(n); startLevel(n); } }, 60);
      return;
    }
    const cfg = levelConfig(n), built = buildLevel(n);
    game.kind = 'level'; game.level = n;
    game.rules = { overlap: cfg.overlap, tremor: cfg.tremor };
    game.players = [{ id: 0, kind: 'human', score: 0, name: 'You' }];
    clearEffects();
    game.rubbers = [makeRubber(0, built.me.x, built.me.y, settings.skin), ...built.targets.map(t => makeRubber(-1, t.x, t.y))];
    game.rubbers.forEach((rb, i) => rb.z = i);
    game.zTop = game.rubbers.length;
    obstacles = built.obstacles;
    buildObstacleLayer();
    game.flicksLeft = cfg.targets + cfg.spare; game.flicksUsed = 0;
    game.turn = 0;
    toast(`Level ${n}`);
    startTurn();
  }
  const nextLevelToPlay = () => {
    for (let n = 1; n <= LEVEL_COUNT; n++) if (!progress.stars[n]) return n;      // first level not cleared yet
    for (let n = 1; n <= LEVEL_COUNT; n++) if (progress.stars[n] < 3) return n;   // then the first without ★★★
    return LEVEL_COUNT;
  };

  // ---------------------------------------------------------------------
  // Save & continue: the game in progress is saved at the start of every turn,
  // so closing the app (even mid-level or mid-match) picks up from that turn.
  // Positions are stored relative to the board so they fit any screen size.
  // ---------------------------------------------------------------------
  const SIZE_KEYS = ['r', 'w', 'h', 'rx', 'ry'];
  function saveGame(extra = {}) {
    const bw = board.x1 - board.x0, bh = board.y1 - board.y0;
    store.set('save', {
      v: 1, kind: game.kind, level: game.level, flicksLeft: game.flicksLeft, flicksUsed: game.flicksUsed,
      round: game.round, starter: game.starter, turn: game.turn, streak: game.streak, rules: game.rules,
      players: game.players.map(p => ({ ...p })),
      match: { count: settings.count, kinds: settings.kinds.slice(), points: settings.points, skill: settings.skill, ground: settings.ground },
      rubbers: game.rubbers.map(r => ({ player: r.player, x: (r.x - board.x0) / bw, y: (r.y - board.y0) / bh, dead: !!r.dead, skin: r.skin.id, kos: r.kos || 0, z: r.z, angle: r.angle })),
      obstacles: obstacles.map(o => {
        const c = { ...o, x: (o.x - board.x0) / bw, y: (o.y - board.y0) / bh };
        for (const k of SIZE_KEYS) if (o[k]) c[k] = o[k] / S;
        return c;
      }),
      ...extra,
    });
  }
  const loadSave = () => { const s = store.get('save', null); return s && s.v === 1 ? s : null; };
  const clearSave = () => { try { localStorage.removeItem('chungi.save'); } catch { /* ignore */ } };
  function resumeGame() {
    const s = loadSave();
    if (!s) return false;
    const bw = board.x1 - board.x0, bh = board.y1 - board.y0;
    clearEffects();
    Object.assign(game, {
      kind: s.kind, level: s.level, flicksLeft: s.flicksLeft, flicksUsed: s.flicksUsed, round: s.round,
      starter: s.starter, turn: s.turn, streak: s.streak, rules: s.rules, players: s.players, timeScale: 1,
    });
    if (s.kind === 'versus') { Object.assign(settings, s.match); saveSettings(); }
    if (s.pendingRound) { game.round++; newRound(); return true; } // closed on the round result: start the next round
    game.rubbers = s.rubbers.map(d => Object.assign(makeRubber(d.player, board.x0 + d.x * bw, board.y0 + d.y * bh, d.skin),
      { dead: d.dead, koT: d.dead ? -1e9 : 0, kos: d.kos, z: d.z, angle: d.angle }));
    game.zTop = Math.max(...game.rubbers.map(r => r.z)) + 1;
    obstacles = s.obstacles.map(o => {
      const c = { ...o, x: board.x0 + o.x * bw, y: board.y0 + o.y * bh };
      for (const k of SIZE_KEYS) if (o[k]) c[k] = o[k] * S;
      return c;
    });
    buildObstacleLayer();
    toast(s.kind === 'level' ? `Level ${s.level}` : `Round ${s.round}`);
    startTurn();
    return true;
  }

  function levelDone(success) {
    clearSave();
    game.mode = 'over';
    renderHud();
    const tok = game.token, me = game.rubbers[0];
    if (success) {
      const T = levelConfig(game.level).targets, used = game.flicksUsed;
      const stars = used <= T ? 3 : used <= T + 1 ? 2 : 1;
      const before = totalStars(), prev = progress.stars[game.level] || 0;
      if (stars > prev) { progress.stars[game.level] = stars; saveProgress(); }
      const unlocked = SKINS.filter(s => s.need > before && s.need <= totalStars());
      toast(stars === 3 ? 'PERFECT!' : 'Cleared!');
      sfx.match(); buzz([30, 40, 60]);
      burst(me.x, me.y, 50, [...COLORS, '#fff'], 340 * S, 7 * S, 1.5, 500 * S);
      setTimeout(() => { if (tok === game.token) showLevelResult(true, stars, used, unlocked); }, 1100);
    } else {
      toast('Out of flicks');
      sfx.fail(); buzz(60);
      setTimeout(() => { if (tok === game.token) showLevelResult(false); }, 900);
    }
  }

  // ---------------------------------------------------------------------
  // Turns
  // ---------------------------------------------------------------------
  // `seconds` lets a paused turn carry on with the time it had left (null = clock not started yet).
  function startTurn(seconds = null) {
    game.mode = 'aim'; game.aim = null; game.cpuAim = null; game.mover = null;
    startClock(seconds);
    const tok = ++game.token;
    renderHud();
    saveGame();
    const p = game.players[game.turn];
    if (game.kind === 'level') {
      const left = rivalsOf(current()).length;
      showHint(game.level === 1 && game.flicksUsed === 0 ? 'Drag back from your rubber & let go'
        : `Land on ${left} white rubber${left > 1 ? 's' : ''} · ${game.flicksLeft} flick${game.flicksLeft > 1 ? 's' : ''} left`);
      sfx.turn();
      return;
    }
    if (p.kind === 'cpu') {
      showHint(`${p.name} is thinking…`);
      setTimeout(() => { if (tok === game.token) cpuPlay(); }, 700);
    } else {
      showHint(humanCount() > 1 ? `${p.name}'s turn — pull back & release` : 'Your turn — pull back & release');
      sfx.turn();
    }
  }

  function flick(rb, dirX, dirY, power) {
    power = clamp(power, 0, 1);
    const v = speedFor(power), len = Math.hypot(dirX, dirY) || 1;
    rb.vx = (dirX / len) * v; rb.vy = (dirY / len) * v;
    rb.prevX = rb.x; rb.prevY = rb.y;
    rb.spin = (Math.random() * 2 - 1) * (3 + power * 9);
    rb.bounces = 0; rb.inMud = false;
    rb.z = ++game.zTop; // the flicked rubber slides over the others
    game.mover = rb; game.mode = 'moving'; game.acc = 0; game.timeScale = 1; game.drama = false;
    if (game.kind === 'level') { game.flicksLeft--; game.flicksUsed++; renderHud(); }
    hideHint();
    sfx.flick(power); buzz(15);
    burst(rb.x, rb.y, 6, '#efe1c6', 90 * S, 6 * S, 0.5, 0, true);
  }

  // ---------- Computer player: tries lots of shots in its head, then flicks (with human-like error) ----------
  function cpuPlay() {
    if (game.mode !== 'aim' || game.players[game.turn].kind !== 'cpu') return;
    const me = current(), others = rivalsOf(me), sk = CPU_SKILL[settings.skill];
    const cands = [];
    for (const o of others) {
      const base = Math.atan2(o.y - me.y, o.x - me.x), d = Math.hypot(o.x - me.x, o.y - me.y);
      const p0 = Math.pow(d / maxTravel(), 1 / POWER_EXP);
      cands.push({ ang: base, pow: p0 });
      for (let i = 0; i < 70; i++) cands.push({ ang: base + gauss() * 0.3, pow: clamp(p0 * (1 + gauss() * 0.25), 0.05, 1) });
    }
    for (let i = 0; i < 150; i++) cands.push({ ang: rand(0, Math.PI * 2), pow: rand(0.1, 1) }); // bank shots
    for (const c of cands) {
      const v = speedFor(c.pow), res = simulate(me, Math.cos(c.ang) * v, Math.sin(c.ang) * v, others);
      if (res.out) { c.score = -1e4; continue; }
      const hits = others.filter(o => landedOn(res.b, o)).length;
      if (hits) { c.score = 1e3 * hits * (res.bounces ? 2 : 1); continue; }
      c.score = -Math.min(...others.map(o => Math.hypot(o.x - res.b.x, o.y - res.b.y)));
    }
    cands.sort((a, b) => b.score - a.score);
    const choice = cands[Math.floor(Math.random() * Math.min(sk.pick, cands.length))];
    const ang = choice.ang + gauss() * sk.ang;
    const power = clamp(choice.pow * (1 + gauss() * sk.pow), 0.04, 1);
    game.cpuAim = { t0: perfNow(), dur: 750, ang, power };
  }
  // Turn clock: starts when you first touch your rubber. No ring on screen —
  // only ticks, a buzz and a "Let go!" hint in the last 3 seconds, then an automatic flick.
  function startClock(seconds) {
    game.turnEnds = seconds == null ? null : perfNow() + seconds * 1000;
    game.lastTick = seconds == null ? TURN_TIME + 1 : Math.ceil(seconds) + 1;
  }
  function updateTimer() {
    if (game.mode !== 'aim' || game.cpuAim || game.turnEnds == null) return;
    const left = (game.turnEnds - perfNow()) / 1000, sec = Math.ceil(left);
    if (sec < game.lastTick && sec >= 1 && sec <= 3) {
      sfx.tick(sec === 1); buzz(sec === 1 ? 25 : 10);
      showHint(`Let go! ${sec}…`);
    }
    game.lastTick = Math.min(game.lastTick, sec);
    if (left > 0) return;
    const me = current();
    toast("Time's up!"); sfx.timeUp(); buzz([40, 30, 40]);
    if (game.aim) { // still pulling: fire with the current aim
      const a = humanAim(); game.aim = null;
      if (a.power >= 0.06) { flick(me, a.ux, a.uy, a.power); return; }
    }
    const ang = Math.random() * Math.PI * 2; // no aim: a careless random flick
    game.cpuAim = null;
    flick(me, Math.cos(ang), Math.sin(ang), 0.25 + Math.random() * 0.5);
  }
  function updateCpuAim() {
    const a = game.cpuAim; if (!a) return;
    if (perfNow() - a.t0 >= a.dur) { game.cpuAim = null; flick(current(), Math.cos(a.ang), Math.sin(a.ang), a.power); }
  }

  // ---------- Input (pull back and release) ----------
  // The finger shakes a little, more the harder and longer you pull.
  function tremor(power, holdSec) {
    const t = perfNow() / 1000, amp = game.rules.tremor * (0.4 + power) * Math.min(1, holdSec / 0.9);
    return amp * (Math.sin(t * 4.3) + 0.6 * Math.sin(t * 7.7 + 1.3));
  }
  function humanAim() {
    const me = current(), dx = me.x - game.aim.x, dy = me.y - game.aim.y;
    const power = Math.min(Math.hypot(dx, dy), maxPullLen()) / maxPullLen();
    const a = Math.atan2(dy, dx) + tremor(power, (perfNow() - game.aim.t0) / 1000);
    return { ux: Math.cos(a), uy: Math.sin(a), power };
  }
  function toLocal(e) { const b = canvas.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; }
  canvas.addEventListener('pointerdown', (e) => {
    audio();
    if (game.mode !== 'aim' || game.players[game.turn].kind !== 'human' || game.aim) return;
    const p = toLocal(e), me = current();
    if (Math.hypot(p.x - me.x, p.y - me.y) > me.r * 2.2) { showHint('Touch YOUR rubber (the glowing one) to aim'); return; }
    game.aim = { id: e.pointerId, x: p.x, y: p.y, t0: perfNow() };
    if (game.turnEnds == null) startClock(TURN_TIME); // first touch starts the 10-second clock
    try { canvas.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!game.aim || e.pointerId !== game.aim.id) return;
    const p = toLocal(e); game.aim.x = p.x; game.aim.y = p.y;
  });
  canvas.addEventListener('pointerup', (e) => {
    if (!game.aim || e.pointerId !== game.aim.id) return;
    const a = humanAim();
    game.aim = null;
    if (a.power < 0.06) { showHint('Pull further back to flick'); return; }
    flick(current(), a.ux, a.uy, a.power);
  });
  canvas.addEventListener('pointercancel', (e) => { if (game.aim && e.pointerId === game.aim.id) game.aim = null; });

  // ---------- Movement ----------
  function stepGame(dt) {
    if (game.mode === 'out') { updateOut(); return; }
    if (game.mode !== 'moving') { game.timeScale = 1; return; }
    const m = game.mover, others = rivalsOf(m);
    game.acc += dt * game.timeScale;
    while (game.acc >= PHYS_DT) {
      game.acc -= PHYS_DT;
      const ev = physStep(m, others);
      if (ev === 'stop') { settle(); return; }
      if (ev === 'out') { goOut(); return; }
      if (ev) onHit(m, ev);
    }
    const sp = Math.hypot(m.vx, m.vy), sdt = dt * game.timeScale;
    // Drama: slow motion when the rubber is about to stop on a rival
    if (sp > STOP_SPEED) {
      const mu = friction() * zoneFactor(m.x, m.y), dRest = sp * sp / (2 * mu);
      const px = m.x + m.vx / sp * dRest, py = m.y + m.vy / sp * dRest;
      const close = dRest < m.r * 3.5 && others.some(o => Math.hypot(o.x - px, o.y - py) < (o.r + m.r) * game.rules.overlap * 1.2);
      if (close && !game.drama) { game.drama = true; sfx.heart(); }
      game.timeScale += ((close ? 0.3 : 1) - game.timeScale) * Math.min(1, dt * 8);
    }
    m.angle += m.spin * sdt; m.spin *= Math.pow(0.6, sdt);
    m.lift = clamp(sp / (900 * S), 0, 1);
    if (sp > 140 * S && Math.random() < 0.6) burst(m.x, m.y, 1, '#f1e3c8', 18 * S, 9 * S, 0.55, 0, true); // dust trail
    const inMud = obstacles.some(o => o.type === 'mud' && inEllipse(o, m.x, m.y));
    if (inMud && !m.inMud && sp > 40) { sfx.mud(); burst(m.x, m.y, 8, ['#3f2814', '#5c3c20'], 120 * S, 4 * S, 0.45); }
    if (inMud && sp > 30 && Math.random() < 0.35) burst(m.x, m.y, 1, '#4a2f19', 70 * S, 3 * S, 0.35);
    m.inMud = inMud;
  }
  function onHit(m, { o, impact }) {
    const k = clamp(impact / (600 * S), 0, 1);
    m.bounces++;
    m.spin = -m.spin * 0.7 + (Math.random() * 8 - 4);
    game.shake = Math.max(game.shake, (2 + k * 6) * S);
    if (o.type === 'rock') { sfx.rock(k); burst(m.x, m.y, 6, ['#8d877f', '#d8d2c8'], 160 * S, 3 * S, 0.4); }
    else { sfx.brick(k); burst(m.x, m.y, 7, ['#b5532f', '#e0a07a', '#d8b58a'], 150 * S, 3 * S, 0.45); }
    buzz(10);
  }
  function settle() {
    const m = game.mover, others = rivalsOf(m);
    m.lift = 0; m.popT = perfNow(); game.timeScale = 1; sfx.land();
    ripple(m.x, m.y, 'rgba(255,245,225,.9)', m.r * 1.9, 450);
    const victims = others.filter(o => landedOn(m, o)), trick = m.bounces > 0;
    for (const v of victims) {
      v.dead = true; v.koT = perfNow();
      burst(v.x, v.y, 18, [colorOf(v), '#1c1c1e'], 220 * S, 5 * S, 0.8);
      ripple(v.x, v.y, colorOf(m), m.r * 3.2, 750);
    }
    const near = !victims.length && others.some(o => Math.hypot(o.x - m.x, o.y - m.y) < (o.r + m.r) * 1.1);
    if (near) { toast('So close!'); sfx.close(); }

    if (game.kind === 'level') {
      if (victims.length) {
        floater(m.x, m.y - m.r, trick ? 'TRICK!' : victims.length > 1 ? 'DOUBLE!' : 'GOT IT!');
        sfx.collect(); buzz([20, 30]); game.shake = Math.max(game.shake, 4 * S);
      }
      renderHud();
      if (!rivalsOf(game.rubbers[0]).length) return levelDone(true);
      return afterShot();
    }

    if (victims.length) {
      m.kos = (m.kos || 0) + victims.length;
      if (alive().length === 1) return winRound(m, trick, victims);
      // Several players still in: knockout, and play goes on.
      renderHud();
      toast(trick ? 'TRICK KNOCKOUT!' : victims.length > 1 ? 'DOUBLE KNOCKOUT!' : 'Knocked out!');
      floater(m.x, m.y - m.r, 'KO!', colorOf(m));
      sfx.trick(); buzz([20, 30, 40]);
      game.shake = Math.max(game.shake, 6 * S);
      game.mode = 'over'; // short pause so everyone sees who went out
      const left = alive().length, names = victims.map(v => NAMES[v.player]).join(' & '), tok = game.token;
      setTimeout(() => {
        if (tok !== game.token) return;
        showHint(`${names} ${victims.length > 1 ? 'are' : 'is'} out — ${left} left`);
        setTimeout(() => { if (tok === game.token) nextTurn(); }, 1100);
      }, 700);
      return;
    }
    nextTurn();
  }
  // Versus: the last rubber left wins the round: 1 point, 2 if the final shot was a trick shot.
  function winRound(m, trick, victims) {
    const pts = trick ? 2 : 1, p = game.players[m.player];
    p.score += pts;
    game.streak = game.streak.player === p.id ? { player: p.id, n: game.streak.n + 1 } : { player: p.id, n: 1 };
    game.mode = 'over';
    renderHud();
    const matchWon = p.score >= settings.points;
    matchWon ? clearSave() : saveGame({ pendingRound: true });
    toast(trick ? 'TRICK SHOT!' : matchWon ? 'CHUNGI!' : game.players.length > 2 ? 'Last one standing!' : 'On top!');
    floater(m.x, m.y - m.r, `+${pts}`, colorOf(m));
    burst(m.x, m.y, 40, COLORS, 320 * S, 7 * S, 1.4, 500 * S);
    buzz([30, 40, 60]);
    matchWon ? sfx.match() : trick ? sfx.trick() : sfx.win();
    const tok = game.token;
    setTimeout(() => { if (tok === game.token) showResult(p, victims, pts, trick, matchWon, m.kos); }, 1200);
  }
  function afterShot() {
    if (game.kind === 'level' && game.flicksLeft <= 0) return levelDone(false);
    nextTurn();
  }
  function nextTurn() {
    const n = game.players.length;
    do { game.turn = (game.turn + 1) % n; } while (game.rubbers[game.turn].dead);
    startTurn();
  }
  function goOut() {
    const m = game.mover;
    game.mode = 'out'; game.timeScale = 1;
    m.vx = m.vy = 0; m.lift = 0;
    toast('Out!'); sfx.out(); buzz(40);
    burst(m.x, m.y, 12, ['#efe1c6', '#d8b58a'], 140 * S, 4 * S, 0.6);
    game.outAnim = { t0: perfNow() };
  }
  function updateOut() {
    const m = game.mover, k = clamp((perfNow() - game.outAnim.t0) / 1000, 0, 1);
    if (k < 0.45) m.alpha = 1 - k / 0.45;
    else { m.x = m.prevX; m.y = m.prevY; m.alpha = (k - 0.45) / 0.55; }
    if (k >= 1) { m.alpha = 1; game.outAnim = null; afterShot(); }
  }

  // =====================================================================
  // Rendering
  // =====================================================================
  function draw() {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.fillStyle = '#a67c52'; ctx.fillRect(0, 0, W, H);
    if (game.shake > 0.3) ctx.translate((Math.random() * 2 - 1) * game.shake, (Math.random() * 2 - 1) * game.shake);
    if (groundCanvas) ctx.drawImage(groundCanvas, 0, 0, W, H);
    if (obstacleCanvas) ctx.drawImage(obstacleCanvas, 0, 0, W, H);
    drawParticles(true);
    const sorted = [...game.rubbers].sort((a, b) => a.z - b.z);
    const me = game.mode === 'aim' ? current() : null;
    for (const rb of sorted) {
      if (rb.dead) { // knocked out / collected: fade away
        const k = (perfNow() - rb.koT) / 700;
        if (k >= 1) continue;
        rb.alpha = 1 - k; drawRubber(rb, false); rb.alpha = 1;
        continue;
      }
      drawRubber(rb, rb === me);
    }
    drawRipples();
    drawParticles(false);
    drawFloaters();
    if (game.mode === 'aim') drawAim();
    if (game.timeScale < 0.97) { // slow-motion vignette
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      const v = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.75);
      v.addColorStop(0, 'rgba(20,10,0,0)'); v.addColorStop(1, `rgba(20,10,0,${(1 - game.timeScale) * 0.55})`);
      ctx.fillStyle = v; ctx.fillRect(0, 0, W, H);
    }
  }

  function drawAim() {
    const me = current();
    let ux, uy, power;
    if (game.aim) ({ ux, uy, power } = humanAim());
    else if (game.cpuAim) {
      const a = game.cpuAim, k = clamp((perfNow() - a.t0) / a.dur, 0, 1), e = 1 - Math.pow(1 - k, 3);
      ux = Math.cos(a.ang); uy = Math.sin(a.ang); power = a.power * e;
    } else return;
    const pull = power * maxPullLen();

    // finger behind the rubber
    const fx = me.x - ux * (me.r * 1.1 + pull * 0.5), fy = me.y - uy * (me.r * 1.1 + pull * 0.5);
    ctx.save();
    ctx.translate(fx, fy); ctx.rotate(Math.atan2(uy, ux));
    ctx.fillStyle = 'rgba(40,25,10,.25)'; roundRectFill(-43 * S, -6 * S, 52 * S, 22 * S, 11 * S);
    ctx.fillStyle = '#e8b48c'; ctx.strokeStyle = '#8a5a3a'; ctx.lineWidth = 2 * S;
    roundRectFill(-46 * S, -11 * S, 52 * S, 22 * S, 11 * S, true);
    ctx.fillStyle = '#f6d6c0'; roundRectFill(-6 * S, -7 * S, 10 * S, 14 * S, 4 * S);
    ctx.restore();

    // short direction arrow (shows direction and strength, not where it lands)
    const col = power < 0.5 ? `hsl(${120 - power * 120},80%,45%)` : `hsl(${60 - (power - 0.5) * 120},85%,48%)`;
    const ax0 = me.x + ux * me.r * 1.2, ay0 = me.y + uy * me.r * 1.2;
    const alen = me.r * 0.5 + power * me.r * 2.2;
    const ax1 = ax0 + ux * alen, ay1 = ay0 + uy * alen;
    ctx.save();
    ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 6 * S; ctx.lineCap = 'round';
    ctx.setLineDash([2 * S, 10 * S]);
    ctx.beginPath(); ctx.moveTo(ax0, ay0); ctx.lineTo(ax1, ay1); ctx.stroke();
    ctx.setLineDash([]);
    ctx.translate(ax1, ay1); ctx.rotate(Math.atan2(uy, ux));
    ctx.beginPath(); ctx.moveTo(10 * S, 0); ctx.lineTo(-8 * S, -9 * S); ctx.lineTo(-8 * S, 9 * S); ctx.closePath(); ctx.fill();
    ctx.restore();

    // power meter
    ctx.save();
    const mx = me.x - 26 * S, my = me.y + me.r * 1.6, mw = 52 * S, mh = 7 * S;
    ctx.fillStyle = 'rgba(43,29,18,.6)'; roundRectFill(mx, my, mw, mh, mh / 2);
    ctx.fillStyle = col; roundRectFill(mx, my, Math.max(mh, mw * power), mh, mh / 2);
    ctx.restore();
  }
  function roundRectFill(x, y, w, h, r, stroke) { roundRect(ctx, x, y, w, h, r); ctx.fill(); if (stroke) ctx.stroke(); }

  // =====================================================================
  // UI
  // =====================================================================
  const $ = (id) => document.getElementById(id);
  const screens = ['menu', 'setup', 'howto', 'levels', 'skins', 'pause', 'result'];
  const menuScreens = ['menu', 'setup', 'howto', 'levels', 'skins'];
  function show(name) {
    screens.forEach(s => $(s).classList.toggle('hidden', s !== name));
    const inGame = !menuScreens.includes(name);
    $('hud').classList.toggle('hidden', !inGame);
    if (!inGame) hideHint();
  }
  function hideScreens() { screens.forEach(s => $(s).classList.add('hidden')); $('hud').classList.remove('hidden'); }

  function renderHud() {
    if (game.kind === 'level') {
      const targets = game.rubbers.filter(r => r.player < 0), got = targets.filter(r => r.dead).length;
      const pips = '<span class="on">●</span>'.repeat(Math.max(0, game.flicksLeft)) + '<span>●</span>'.repeat(game.flicksUsed);
      $('scores').innerHTML = `<div class="chip turn">Level ${game.level}</div><div class="chip">◎ ${got}/${targets.length}</div><div class="chip pips">${pips}</div>`;
      return;
    }
    $('scores').innerHTML = game.players.map((p, i) =>
      `<div class="chip ${i === game.turn && game.mode !== 'over' ? 'turn' : ''} ${game.rubbers[i] && game.rubbers[i].dead ? 'ko' : ''}"><span class="dot" style="background:${COLORS[i]}"></span>${p.kind === 'cpu' ? 'CPU' : NAMES[i]}<span class="sc">${p.score}</span></div>`
    ).join('') + `<div class="chip goal">to ${settings.points}</div>`;
  }
  function showHint(t) { const h = $('hint'); h.textContent = t; h.classList.remove('hidden'); }
  function hideHint() { $('hint').classList.add('hidden'); }
  let toastTimer = 0;
  function toast(t) {
    const el = $('toast'); el.textContent = t; el.classList.remove('hidden');
    el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.add('hidden'), 950);
  }

  function setResultButtons({ next, nextAction, retry, menu }) {
    $('nextBtn').textContent = next; $('nextBtn').dataset.action = nextAction;
    $('retryBtn').classList.toggle('hidden', !retry);
    $('resultMenuBtn').textContent = menu;
  }
  function showResult(p, victims, pts, trick, matchWon, kos) {
    const solo = p.kind === 'human' && humanCount() === 1, multi = game.players.length > 2;
    $('resultDot').classList.remove('hidden'); $('resultStars').classList.add('hidden');
    $('resultDot').style.background = COLORS[p.id];
    const streak = game.streak.n >= 2 ? ` 🔥 ${game.streak.n} in a row!` : '';
    if (matchWon) {
      $('resultTitle').textContent = solo ? 'You win the match!' : `${p.name} wins the match!`;
      $('resultSub').textContent = 'Final: ' + game.players.map(q => `${q.kind === 'cpu' ? 'CPU ' + NAMES[q.id] : NAMES[q.id]} ${q.score}`).join(' · ');
      setResultButtons({ next: 'Play again', nextAction: 'newMatch', retry: false, menu: 'Main menu' });
    } else {
      const ptsText = `+${pts} point${pts > 1 ? 's' : ''}${trick ? ' (trick shot)' : ''}. First to ${settings.points} wins.`;
      if (multi) {
        $('resultTitle').textContent = solo ? 'You are the last one standing!' : `${p.name} is the last one standing!`;
        $('resultSub').textContent = `${kos || 0} knockout${kos === 1 ? '' : 's'} this round · ${ptsText}${streak}`;
      } else {
        $('resultTitle').textContent = trick ? 'Trick shot!' : solo ? 'You landed on top!' : `${p.name} lands on top!`;
        $('resultSub').textContent = `Landed on ${victims.map(v => NAMES[v.player]).join(' & ')} · ${ptsText}${streak}`;
      }
      setResultButtons({ next: 'Next round', nextAction: 'nextRound', retry: false, menu: 'Main menu' });
    }
    show('result');
  }
  function showLevelResult(success, stars = 0, used = 0, unlocked = []) {
    $('resultDot').classList.add('hidden');
    const st = $('resultStars'); st.classList.remove('hidden');
    st.innerHTML = [1, 2, 3].map(i => `<span class="${i <= stars ? 'on' : ''}" style="animation-delay:${0.15 + i * 0.18}s">★</span>`).join('');
    const T = levelConfig(game.level).targets;
    if (success) {
      $('resultTitle').textContent = `Level ${game.level} cleared!`;
      let sub = `${used} flick${used > 1 ? 's' : ''} used.`;
      if (stars < 3) sub += ` Clear it in ${T} for ★★★.`;
      if (unlocked.length) sub += ` New rubber unlocked: ${unlocked.map(s => s.name).join(', ')}!`;
      $('resultSub').textContent = sub;
      const last = game.level >= LEVEL_COUNT;
      setResultButtons({ next: last ? 'All levels' : 'Next level', nextAction: last ? 'levels' : 'nextLevel', retry: true, menu: 'Levels' });
      if (!last) setTimeout(() => buildLevel(game.level + 1), 400); // get the next level ready while you read
    } else {
      $('resultTitle').textContent = 'Out of flicks!';
      $('resultSub').textContent = `Land on every white rubber before your flicks run out.`;
      setResultButtons({ next: 'Try again', nextAction: 'retry', retry: false, menu: 'Levels' });
    }
    show('result');
  }

  // ---------- Setup (versus) ----------
  function renderSetup() {
    const segs = { countSeg: 'count', pointsSeg: 'points', skillSeg: 'skill', groundSeg: 'ground' };
    for (const [id, key] of Object.entries(segs)) document.querySelectorAll(`#${id} button`).forEach(b => b.classList.toggle('on', +b.dataset.n === settings[key]));
    let html = '';
    for (let i = 0; i < settings.count; i++) {
      const k = settings.kinds[i];
      html += `<div class="prow"><span class="dot" style="background:${COLORS[i]}"></span><span class="pname">${NAMES[i]}</span>` +
        `<button class="kind ${k}" data-i="${i}">${k === 'cpu' ? '🤖 Computer' : '👆 Human'}</button></div>`;
    }
    $('playerList').innerHTML = html;
    $('playerList').querySelectorAll('.kind').forEach(b => b.onclick = () => {
      const i = +b.dataset.i; settings.kinds[i] = settings.kinds[i] === 'cpu' ? 'human' : 'cpu'; renderSetup();
    });
  }
  function bindSeg(id, key) {
    document.querySelectorAll(`#${id} button`).forEach(b => b.onclick = () => { settings[key] = +b.dataset.n; renderSetup(); });
  }
  bindSeg('countSeg', 'count'); bindSeg('pointsSeg', 'points'); bindSeg('skillSeg', 'skill'); bindSeg('groundSeg', 'ground');

  // ---------- Levels screen ----------
  function renderLevels() {
    $('starTotal').textContent = `★ ${totalStars()} / ${LEVEL_COUNT * 3}`;
    let html = '';
    for (let n = 1; n <= LEVEL_COUNT; n++) {
      const s = progress.stars[n] || 0, open = n === 1 || (progress.stars[n - 1] || 0) > 0;
      html += `<button class="lvl ${open ? '' : 'locked'} ${s ? 'done' : ''}" data-n="${n}" ${open ? '' : 'disabled'}>` +
        `<b>${open ? n : '🔒'}</b><i>${open ? '<span class="on">★</span>'.repeat(s) + '<span>★</span>'.repeat(3 - s) : ''}</i></button>`;
    }
    $('levelGrid').innerHTML = html;
    $('levelGrid').querySelectorAll('.lvl:not(.locked)').forEach(b => b.onclick = () => { hideScreens(); startLevel(+b.dataset.n); });
  }
  function openLevels() { toMenu(false); renderLevels(); show('levels'); }

  // ---------- Rubbers (skins) screen ----------
  function renderSkins() {
    const total = totalStars();
    $('skinStars').textContent = `★ ${total} — earn stars in Levels to unlock more`;
    $('skinGrid').innerHTML = SKINS.map(s => {
      const open = total >= s.need, on = settings.skin === s.id;
      return `<button class="skin ${open ? '' : 'locked'} ${on ? 'on' : ''}" data-id="${s.id}" ${open ? '' : 'disabled'}>` +
        `<canvas></canvas><b>${s.name}</b><i>${on ? '✓ Using' : open ? 'Use' : `🔒 ★ ${s.need}`}</i></button>`;
    }).join('');
    $('skinGrid').querySelectorAll('.skin').forEach(btn => {
      const s = skinById(btn.dataset.id), cv = btn.querySelector('canvas'), size = 76;
      cv.width = size * DPR; cv.height = size * DPR; cv.style.width = cv.style.height = size + 'px';
      const c = cv.getContext('2d'); c.scale(DPR, DPR);
      const rb = makeRubber(0, size / 2, size / 2, s.id);
      rb.r = 25; rb.angle = -0.5; rb.stretch = 1.12;
      if (btn.classList.contains('locked')) rb.alpha = 0.35;
      drawRubber(rb, false, c);
      if (!btn.disabled) btn.onclick = () => { settings.skin = s.id; saveSettings(); renderSkins(); };
    });
  }

  document.querySelectorAll('[data-go]').forEach(b => b.onclick = () => {
    const to = b.dataset.go;
    if (to === 'setup') renderSetup();
    if (to === 'levels') renderLevels();
    if (to === 'skins') renderSkins();
    if (to === 'menu') updateMenu();
    show(to);
  });
  $('startBtn').onclick = () => {
    if (!settings.kinds.slice(0, settings.count).includes('human')) settings.kinds[0] = 'human';
    saveSettings(); audio(); hideScreens(); newMatch();
  };
  function updateMenu() {
    const s = loadSave();
    $('continueBtn').textContent =
      s && s.kind === 'level' ? `▶ Continue · Level ${s.level}`
      : s && s.kind === 'versus' ? `▶ Continue match · ${s.players.map(p => p.score).join(' – ')}`
      : totalStars() ? `▶ Play · Level ${nextLevelToPlay()}` : '▶ Play';
    $('soundBtn').textContent = 'Sound: ' + (settings.sound ? 'On' : 'Off');
    $('musicBtn').textContent = 'Music: ' + (settings.music ? 'On' : 'Off');
    $('menuStars').textContent = `★ ${totalStars()} / ${LEVEL_COUNT * 3} stars`;
  }
  $('continueBtn').onclick = () => { audio(); hideScreens(); if (!resumeGame()) startLevel(nextLevelToPlay()); };
  $('soundBtn').onclick = () => { settings.sound = !settings.sound; saveSettings(); updateMenu(); };
  $('musicBtn').onclick = () => { settings.music = !settings.music; saveSettings(); settings.music ? startMusic() : stopMusic(); updateMenu(); };
  updateMenu();

  let pausedFrom = null;
  function pause() {
    if (!['aim', 'moving'].includes(game.mode)) return;
    game.timeLeft = game.mode === 'aim' && game.turnEnds != null ? Math.max(0.5, (game.turnEnds - perfNow()) / 1000) : null;
    pausedFrom = game.mode; game.mode = 'paused'; game.aim = null; show('pause');
  }
  function resume() {
    hideScreens(); game.mode = pausedFrom || 'aim'; pausedFrom = null;
    if (game.mode === 'aim') startTurn(game.timeLeft); // pausing doesn't reset your clock
  }
  $('pauseBtn').onclick = pause;
  $('resumeBtn').onclick = resume;
  $('restartBtn').onclick = () => { hideScreens(); game.kind === 'level' ? startLevel(game.level) : newMatch(); };
  $('quitBtn').onclick = () => game.kind === 'level' ? openLevels() : toMenu();
  $('resultMenuBtn').onclick = () => game.kind === 'level' ? openLevels() : toMenu();
  $('retryBtn').onclick = () => { hideScreens(); startLevel(game.level); };
  $('nextBtn').onclick = () => {
    const act = $('nextBtn').dataset.action;
    if (act === 'levels') return openLevels();
    hideScreens();
    if (act === 'newMatch') newMatch();
    else if (act === 'nextRound') { game.round++; newRound(); }
    else if (act === 'nextLevel') startLevel(game.level + 1);
    else if (act === 'retry') startLevel(game.level);
  };
  function toMenu(showIt = true) {
    game.mode = 'menu'; game.cpuAim = null; game.token++; game.timeScale = 1;
    clearEffects(); demoBoard();
    if (showIt) { updateMenu(); show('menu'); }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { pause(); stopMusic(); } else startMusic();
  });
  document.addEventListener('pointerdown', () => startMusic()); // browsers need a tap before sound can play
  try {
    const App = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
    if (App) App.addListener('backButton', () => {
      if (!$('pause').classList.contains('hidden')) resume();
      else if (['aim', 'moving'].includes(game.mode)) pause();
      else if (!$('menu').classList.contains('hidden')) App.exitApp();
      else toMenu();
    });
  } catch { /* not native */ }

  // decorative board behind the menu
  function demoBoard() {
    game.rubbers = [
      makeRubber(0, W * 0.25, H * 0.2, settings.skin), makeRubber(1, W * 0.78, H * 0.84),
      makeRubber(2, W * 0.18, H * 0.86), makeRubber(3, W * 0.82, H * 0.2),
    ];
    game.rubbers.forEach((r, i) => r.z = i);
    obstacles = genObstacles(game.rubbers, GROUND[1]);
    buildObstacleLayer();
  }

  // =====================================================================
  // Loop
  // =====================================================================
  let last = perfNow();
  function frame(now) {
    const dt = Math.min(0.033, (now - last) / 1000); last = now;
    stepGame(dt);
    if (game.mode === 'aim') { updateCpuAim(); updateTimer(); }
    updateEffects(dt);
    draw();
    requestAnimationFrame(frame);
  }

  window.addEventListener('resize', resize);
  resize();
  demoBoard();
  show('menu');
  requestAnimationFrame(frame);

  // exposed for testing
  window.__chungi = {
    game, settings, progress, flick, simulate, landedOn, scoringChance, newRound, startLevel, buildLevel, levelConfig, speedFor,
    renderHud, showLevelResult,
    get obstacles() { return obstacles; },
  };
})();
