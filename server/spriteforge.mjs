/**
 * SpriteForge - deterministic pixel sprite generator
 *
 * Design goals:
 * - No external assets (no licensing hassles)
 * - Deterministic from (seed, palette, animation, frameIndex)
 * - Small payloads (JSON-friendly)
 */

/** @typedef {{ name: string, colors: string[] }} Palette */

/** @type {Palette[]} */
export const PALETTES = [
  {
    name: 'neon',
    colors: ['#0b0f2e', '#1b1f4e', '#ff2e88', '#ffd400', '#00e5ff', '#7dff00', '#ffffff', '#ff7a00'],
  },
  {
    name: 'forest',
    colors: ['#0b1f14', '#143a22', '#2f6b3a', '#57a773', '#a3d9a5', '#f2e9d0', '#d36b4c', '#ffffff'],
  },
  {
    name: 'retro',
    colors: ['#221a29', '#4b2a63', '#ff4f79', '#ffb703', '#219ebc', '#8ecae6', '#f1faee', '#ff7a00'],
  },
  {
    name: 'midnight',
    colors: ['#06070a', '#0f172a', '#334155', '#22c55e', '#38bdf8', '#a78bfa', '#f8fafc', '#fb7185'],
  },
];

export function getPaletteByName(name) {
  const p = PALETTES.find((x) => x.name === name);
  return p ?? PALETTES[0];
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

// String -> 32-bit seed (xmur3)
function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

// 32-bit seed -> rng (mulberry32)
function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededRng(seed) {
  const s = xmur3(seed)();
  return mulberry32(s);
}

/**
 * Generate a single animation frame.
 *
 * Frame format:
 * - `pixels`: array of strings (height rows). Each row has `width` chars.
 * - `.` = transparent
 * - `0-7` = palette index
 */
export function generateFrame({
  seed,
  paletteName,
  animation,
  frameIndex,
  frameCount,
  width,
  height,
}) {
  const w = clamp(Math.floor(width ?? 24), 16, 32);
  const h = clamp(Math.floor(height ?? 24), 16, 32);
  const fCount = clamp(Math.floor(frameCount ?? 8), 2, 16);
  const fi = clamp(Math.floor(frameIndex ?? 0), 0, fCount - 1);
  const anim = animation === 'dance' || animation === 'idle' || animation === 'walk' ? animation : 'walk';

  const palette = getPaletteByName(paletteName);

  // Two independent RNG streams so a chosen palette has a CONSISTENT look:
  //
  // - colorRng is seeded by the palette name ALONE, so the body/accent colours
  //   are fixed for a given palette. Previously the body/accent index came from
  //   the seed-based stream, so with an empty Name (a random seed each forge)
  //   "neon" landed on a different palette slot every click — yellow, then cyan,
  //   then green. Selecting a palette now reliably means one colour identity.
  //
  // - shapeRng stays seed-based, so the silhouette and accessories still vary
  //   from forge to forge (and are reproducible when you type a Name).
  const colorRng = seededRng(`${palette.name}|colors`);
  const shapeRng = seededRng(`${seed}|${palette.name}|${anim}|shape`);

  // Colours: stable per palette.
  const body = 3 + Math.floor(colorRng() * 3); // 3-5
  const accent = 2 + Math.floor(colorRng() * 3); // 2-4
  const highlight = 6;
  const outline = 0;
  const shadow = 1;

  // Shape: varies with the seed.
  const hasCape = shapeRng() < 0.45;
  const hasHat = shapeRng() < 0.55;
  const hasSword = shapeRng() < 0.5;

  // Animation phase [0..1)
  const phase = fCount <= 1 ? 0 : fi / fCount;

  // Movement offsets (tiny bounce)
  const bounce =
    anim === 'idle'
      ? Math.round(Math.sin(phase * Math.PI * 2) * 0.5)
      : anim === 'dance'
        ? Math.round(Math.sin(phase * Math.PI * 4) * 1.0)
        : Math.round(Math.sin(phase * Math.PI * 2) * 0.8);

  const grid = Array.from({ length: h }, () => Array.from({ length: w }, () => '.'));

  const put = (x, y, c) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    grid[y][x] = c;
  };

  const putSym = (cx, x, y, c) => {
    put(cx + x, y, c);
    put(cx - x, y, c);
  };

  const cx = Math.floor(w / 2);
  const top = 2 + bounce;

  // Head (simple circle-ish)
  const headY = top + 3;
  const headR = 3;
  for (let dy = -headR; dy <= headR; dy++) {
    for (let dx = -headR; dx <= headR; dx++) {
      const d = dx * dx + dy * dy;
      if (d <= headR * headR) {
        put(cx + dx, headY + dy, String(body));
      }
      if (d === headR * headR || d === headR * headR - 1) {
        put(cx + dx, headY + dy, String(outline));
      }
    }
  }

  // Face
  put(cx - 1, headY, String(outline));
  put(cx + 1, headY, String(outline));
  put(cx, headY + 1, String(shadow));

  // Torso
  const torsoTop = headY + headR + 1;
  const torsoW = 7;
  const torsoH = 6;
  for (let y = 0; y < torsoH; y++) {
    for (let x = -Math.floor(torsoW / 2); x <= Math.floor(torsoW / 2); x++) {
      const isEdge = y === 0 || y === torsoH - 1 || x === -Math.floor(torsoW / 2) || x === Math.floor(torsoW / 2);
      put(cx + x, torsoTop + y, isEdge ? String(outline) : String(body));
    }
  }

  // Chest accent
  put(cx, torsoTop + 2, String(accent));
  put(cx, torsoTop + 3, String(accent));
  put(cx - 1, torsoTop + 3, String(accent));
  put(cx + 1, torsoTop + 3, String(accent));

  // Cape (behind)
  if (hasCape) {
    for (let y = 0; y < 7; y++) {
      putSym(cx, 4, torsoTop + y, String(shadow));
      putSym(cx, 5, torsoTop + y, String(shadow));
      if (y > 1) {
        putSym(cx, 6, torsoTop + y, String(outline));
      }
    }
  }

  // Arms (swing)
  const armSwing =
    anim === 'dance'
      ? Math.round(Math.sin(phase * Math.PI * 4) * 2)
      : anim === 'walk'
        ? Math.round(Math.sin(phase * Math.PI * 2) * 2)
        : Math.round(Math.sin(phase * Math.PI * 2) * 1);

  const armY = torsoTop + 2;
  for (let i = 0; i < 4; i++) {
    put(cx - 4 - Math.round(i / 2), armY + i + armSwing, String(outline));
    put(cx + 4 + Math.round(i / 2), armY + i - armSwing, String(outline));
    if (i < 3) {
      put(cx - 3 - Math.round(i / 2), armY + i + armSwing, String(body));
      put(cx + 3 + Math.round(i / 2), armY + i - armSwing, String(body));
    }
  }

  // Legs (walk cycle)
  const legsTop = torsoTop + torsoH;
  const step = anim === 'walk' ? Math.round(Math.sin(phase * Math.PI * 2) * 2) : 0;
  const danceStep = anim === 'dance' ? Math.round(Math.sin(phase * Math.PI * 4) * 2) : 0;
  const leftStep = step + danceStep;
  const rightStep = -step + danceStep;

  for (let y = 0; y < 6; y++) {
    put(cx - 2, legsTop + y + leftStep, String(outline));
    put(cx - 1, legsTop + y + leftStep, String(body));
    put(cx + 1, legsTop + y + rightStep, String(body));
    put(cx + 2, legsTop + y + rightStep, String(outline));
  }

  // Boots
  put(cx - 2, legsTop + 6 + leftStep, String(outline));
  put(cx - 1, legsTop + 6 + leftStep, String(accent));
  put(cx + 1, legsTop + 6 + rightStep, String(accent));
  put(cx + 2, legsTop + 6 + rightStep, String(outline));

  // Hat
  if (hasHat) {
    const brimY = headY - headR - 1;
    for (let x = -4; x <= 4; x++) put(cx + x, brimY, String(outline));
    for (let x = -3; x <= 3; x++) put(cx + x, brimY + 1, String(accent));
    put(cx, brimY + 1, String(highlight));
  }

  // Sword (right hand)
  if (hasSword) {
    const sx = cx + 7;
    const sy = armY + 2 - armSwing;
    for (let y = 0; y < 6; y++) put(sx, sy - y, String(outline));
    put(sx, sy - 6, String(highlight));
    put(sx - 1, sy + 1, String(outline));
    put(sx, sy + 1, String(accent));
    put(sx + 1, sy + 1, String(outline));
  }

  // Slight shading line under head
  for (let x = -2; x <= 2; x++) put(cx + x, torsoTop - 1, String(shadow));

  return {
    width: w,
    height: h,
    paletteName: palette.name,
    palette: palette.colors,
    pixels: grid.map((row) => row.join('')),
  };
}



