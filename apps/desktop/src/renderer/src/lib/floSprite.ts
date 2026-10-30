import type { FloMood } from "@frontflow/ui-components";

/**
 * Flo's pixel art, drawn from data on a 40×36 grid: a browser-window head whose screen shows the
 * face, a body with `>>` on the chest, and one prop per mood. `t` is the animation tick.
 */
export const FLO_W = 40;
export const FLO_H = 36;
export const FLO_TICK_MS = 150;

/** The sprite's own colours, like a bitmap's. Eyes, chest and shadow come from theme tokens. */
const PAL: Record<string, string> = {
  O: "#1b1733", V: "#6b5cf0", L: "#9d91ff", D: "#4a3bc0", K: "#141129", G: "#2c2756",
  W: "#ffffff", R: "#ff6b6b", Y: "#ffc145", N: "#3fd68a", Q: "#cdc8e3", M: "#2b2650",
  C: "#6cc6ff", S: "#3fd68a", Z: "#9a95bd", B: "#7fd0ff", P: "#ff8fb8",
  T: "#c46a4f", I: "#e8c3aa", U: "#ffe08a", X: "#ffd166",
};

/** CSS custom property each mood's eyes glow in. */
export const FLO_EYE_TOKEN: Record<FloMood, string> = {
  idle: "--color-accent-purple",
  thinking: "--color-accent-purple",
  reading: "--info-dot",
  coding: "--info-dot",
  testing: "--info-dot",
  retrying: "--info-dot",
  waiting: "--warning-dot",
  paused: "--muted",
  passed: "--success-dot",
  assumed: "--assumed",
  blocked: "--warning-dot",
  failed: "--danger-dot",
};

export interface FloColors {
  eye: string;
  shadow: string;
}

type Pt = readonly [number, number];
type Rows = readonly string[];

interface Painter {
  ox: number;
  oy: number;
  px(x: number, y: number, c: string): void;
}

function painter(ctx: CanvasRenderingContext2D, u: number, colors: FloColors): Painter {
  return {
    ox: 0,
    oy: 0,
    px(x, y, c) {
      ctx.fillStyle = c === "E" ? colors.eye : c === "H" ? colors.shadow : (PAL[c] ?? c);
      // Rounded edges so fractional scales leave no seams between cells.
      const x0 = Math.round((x + this.ox) * u);
      const y0 = Math.round((y + this.oy) * u);
      ctx.fillRect(x0, y0, Math.round((x + this.ox + 1) * u) - x0, Math.round((y + this.oy + 1) * u) - y0);
    },
  };
}

function rect(p: Painter, x0: number, y0: number, x1: number, y1: number, c: string): void {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) p.px(x, y, c);
}

function pat(p: Painter, rows: Rows, x: number, y: number, map?: Record<string, string>): void {
  rows.forEach((row, j) => {
    for (let i = 0; i < row.length; i++) {
      const ch = row.charAt(i);
      if (ch !== ".") p.px(x + i, y + j, map?.[ch] ?? ch);
    }
  });
}

function line([ax, ay]: Pt, [bx, by]: Pt): Pt[] {
  const pts: Pt[] = [];
  let x = ax;
  let y = ay;
  const dx = Math.abs(bx - ax);
  const dy = -Math.abs(by - ay);
  const sx = ax < bx ? 1 : -1;
  const sy = ay < by ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    pts.push([x, y]);
    if (x === bx && y === by) return pts;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}

/** An arm: a 3px outlined stroke along `path`, with a 2×2 hand at its last point. */
function arm(p: Painter, path: readonly Pt[]): void {
  const end = path[path.length - 1];
  if (!end) return;
  const pts: Pt[] = [];
  for (let i = 0; i + 1 < path.length; i++) pts.push(...line(path[i] ?? end, path[i + 1] ?? end));
  for (const [x, y] of pts) rect(p, x - 1, y - 1, x + 1, y + 1, "O");
  rect(p, end[0] - 1, end[1] - 1, end[0] + 2, end[1] + 2, "O");
  for (const [x, y] of pts) p.px(x, y, "V");
  rect(p, end[0], end[1], end[0] + 1, end[1] + 1, "L");
}

function hand(p: Painter, x: number, y: number): void {
  rect(p, x - 1, y - 1, x + 2, y + 2, "O");
  rect(p, x, y, x + 1, y + 1, "L");
}

/** The right arm from a left-arm pose; the hand is 2 cells wide, so its anchor shifts by one. */
const mirror = (path: readonly Pt[]): Pt[] => path.map(([x, y], i): Pt => [i === path.length - 1 ? 38 - x : 39 - x, y]);

const POSE = {
  down: [[14, 24], [12, 25], [11, 27]],
  raiseA: [[14, 24], [10, 22], [8, 17], [7, 11]],
  raiseB: [[14, 24], [10, 22], [8, 17], [5, 12]],
  cheer: [[14, 24], [10, 21], [8, 16], [7, 11]],
  shrugA: [[14, 24], [10, 25], [7, 21]],
  shrugB: [[14, 24], [10, 24], [7, 20]],
} satisfies Record<string, Pt[]>;
const R_HOLD: Pt[] = [[25, 24], [28, 23], [29, 22]];
const R_CHIN: Pt[] = [[25, 24], [28, 24], [27, 22], [25, 20]];
const ARMS_DOWN = [POSE.down, mirror(POSE.down)];

// Face parts on the 16×10 screen.
const EY = {
  dot: ["EE", "EE", "EE"],
  small: ["EE", "EE"],
  line: ["EE"],
  up: [".EE.", "E..E"],
  down: ["E..E", ".EE."],
  x: ["E..E", ".EE.", ".EE.", "E..E"],
  ring: ["EEE", "EWE", "EEE"],
  gt: ["EE..", "..EE", "EE.."],
  lt: ["..EE", "EE..", "..EE"],
} satisfies Record<string, Rows>;
const MO = {
  smile: ["E..E", ".EE."],
  flat: ["EEEE"],
  tiny: ["EE"],
  wide: ["EEEEEE"],
  grin: ["EEEEEE", ".EEEE."],
  frown: [".EE.", "E..E"],
  o: ["EE", "EE"],
  wavy: [".E.E.E", "E.E.E."],
  slant: ["EE..", "..EE"],
} satisfies Record<string, Rows>;

interface Face {
  le: Rows;
  re?: Rows;
  lx: number;
  rx: number;
  y: number;
  m: Rows;
  mx: number;
  my: number;
  ex?: [Rows, number, number][];
}
const FOCUS_BROWS: [Rows, number, number][] = [[["EEE"], 3, 1], [["EEE"], 10, 1]];
const FACE = {
  neutral: { le: EY.dot, lx: 4, rx: 10, y: 2, m: MO.smile, mx: 6, my: 6 },
  blink: { le: EY.line, lx: 4, rx: 10, y: 4, m: MO.smile, mx: 6, my: 6 },
  up: { le: EY.dot, lx: 5, rx: 11, y: 1, m: MO.tiny, mx: 8, my: 7 },
  upBlink: { le: EY.line, lx: 5, rx: 11, y: 3, m: MO.tiny, mx: 8, my: 7 },
  right: { le: EY.small, lx: 6, rx: 12, y: 3, m: MO.tiny, mx: 9, my: 7 },
  rightBlink: { le: EY.line, lx: 6, rx: 12, y: 4, m: MO.tiny, mx: 9, my: 7 },
  focus: { le: EY.dot, lx: 4, rx: 10, y: 3, m: MO.flat, mx: 6, my: 7, ex: FOCUS_BROWS },
  focusBlink: { le: EY.line, lx: 4, rx: 10, y: 5, m: MO.flat, mx: 6, my: 7, ex: FOCUS_BROWS },
  wait: { le: EY.ring, lx: 3, rx: 10, y: 2, m: MO.o, mx: 7, my: 6, ex: [[["EEE"], 3, 0], [["EEE"], 10, 0]] },
  strain: { le: EY.gt, re: EY.lt, lx: 3, rx: 9, y: 2, m: MO.wavy, mx: 5, my: 6 },
  sleep: { le: EY.down, lx: 3, rx: 9, y: 4, m: MO.tiny, mx: 7, my: 7 },
  happy: { le: EY.up, lx: 3, rx: 9, y: 2, m: MO.grin, mx: 5, my: 5, ex: [[["PP"], 1, 4], [["PP"], 13, 4]] },
  assume: { le: EY.dot, lx: 4, rx: 10, y: 3, m: MO.slant, mx: 6, my: 7, ex: [[["EEE"], 10, 1]] },
  blocked: { le: EY.dot, lx: 4, rx: 10, y: 3, m: MO.wide, mx: 5, my: 7, ex: [[["EE.", "..E"], 3, 1], [[".EE", "E.."], 10, 1]] },
  blockedBlink: { le: EY.line, lx: 4, rx: 10, y: 5, m: MO.wide, mx: 5, my: 7, ex: [[["EE.", "..E"], 3, 1], [[".EE", "E.."], 10, 1]] },
  fail: { le: EY.x, lx: 3, rx: 9, y: 1, m: MO.frown, mx: 6, my: 7 },
} satisfies Record<string, Face>;

function face(p: Painter, f: Face): void {
  const X = 12;
  const Y = 10;
  pat(p, f.le, X + f.lx, Y + f.y);
  pat(p, f.re ?? f.le, X + f.rx, Y + f.y);
  pat(p, f.m, X + f.mx, Y + f.my);
  for (const [rows, x, y] of f.ex ?? []) pat(p, rows, X + x, Y + y);
}

function head(p: Painter, f: Face): void {
  for (let x = 11; x <= 28; x++) {
    p.px(x, 6, "O");
    p.px(x, 21, "O");
  }
  for (let y = 7; y <= 20; y++) {
    p.px(10, y, "O");
    p.px(29, y, "O");
  }
  rect(p, 11, 7, 28, 20, "V");
  rect(p, 11, 7, 28, 9, "L"); // browser chrome
  p.px(13, 8, "R");
  p.px(15, 8, "Y");
  p.px(17, 8, "N");
  rect(p, 20, 8, 26, 8, "D"); // address bar
  for (let y = 7; y <= 20; y++) p.px(28, y, "D");
  for (let x = 11; x <= 28; x++) p.px(x, 20, "D");
  rect(p, 12, 10, 27, 19, "K"); // screen
  p.px(13, 11, "G");
  p.px(14, 11, "G");
  p.px(13, 12, "G");
  face(p, f);
}

function body(p: Painter): void {
  for (let y = 22; y <= 27; y++) {
    p.px(14, y, "O");
    p.px(25, y, "O");
  }
  for (let x = 15; x <= 24; x++) p.px(x, 28, "O");
  rect(p, 15, 22, 24, 27, "V");
  for (let y = 22; y <= 27; y++) p.px(24, y, "D");
  for (let x = 15; x <= 24; x++) p.px(x, 27, "D");
  for (let y = 22; y <= 26; y++) p.px(15, y, "L");
  pat(p, ["E.E.", ".E.E", "E.E."], 18, 23); // >> on the chest
}

function feet(p: Painter): void {
  pat(p, ["ODDO", "OOOO"], 15, 29);
  pat(p, ["ODDO", "OOOO"], 21, 29);
}

// Props
const BUBBLE = [".OOOOOOOO.", "OWWWWWWWWO", "OWWWWWWWWO", "OWWWWWWWWO", "OWWWWWWWWO", "OWWWWWWWWO", ".OWOOOOOO.", ".OO......."];
const Q_GLYPH = [".XX.", "X..X", "..X.", "....", "..X."];
const PAPER = ["OOOOOO..", "OWWWWQO.", "OWWWWQQO", "OWllllWO", "OWWWWWWO", "OWllllWO", "OWWWWWWO", "OWlllWWO", "OWWWWWWO", "OWllllWO", "OWWWWWWO", "OOOOOOOO"];
const CLIP = ["..OZZO..", "OOOOOOOO", "OWWWWWWO", "OWbWllWO", "OWWWWWWO", "OWbWllWO", "OWWWWWWO", "OWbWllWO", "OWWWWWWO", "OWWWWWWO", "OOOOOOOO"];
const NOTE = ["OOOOOOO", "OUUUUUO", "OUZZZUO", "OUUUUUO", "OUZZUUO", "OUUUUOO", "OOOOOO."];
const LOGO = [".X..XX.", "X..X..X", ".XX..X."];
const BITS = [["XXX", "X.X", "X.X", "XXX"], [".X", "XX", ".X", ".X"]];
const STAR = ["..X..", "..X..", "XXWXX", "..X..", "..X.."];
const STAR_S = [".X.", "XWX", ".X."];
const Z_SMALL = ["XXX", "..X", ".X.", "X..", "XXX"];
const Z_BIG = ["XXXXX", "...X.", "..X..", ".X...", "XXXXX"];
const PUFF = [".Z.", "ZQZ", ".Z."];
const DROP = [".B.", "BBB", "BBW", ".B."];
const FOLDED = [".OOOOOOOOOOOO.", "OLLVVVVVVVVLLO", ".OOOOOOOOOOOO."];

function bubble(p: Painter, dy: number, glyph?: Rows, color?: string): void {
  pat(p, BUBBLE, 30, dy);
  if (glyph && color) pat(p, glyph, 33, 1 + dy, { X: color });
}

function laptop(p: Painter, t: number): void {
  rect(p, 12, 22, 27, 27, "O");
  rect(p, 13, 23, 26, 26, "M");
  pat(p, LOGO, 16, 23, { X: t % 4 < 2 ? "C" : "L" });
  rect(p, 9, 28, 30, 28, "Q");
  p.px(9, 28, "O");
  p.px(30, 28, "O");
  rect(p, 9, 29, 30, 29, "O");
}

function wall(p: Painter): void {
  for (let y = 11; y <= 30; y++) {
    for (let x = 31; x <= 38; x++) {
      const edge = x === 31 || x === 38 || y === 11 || y === 30;
      const row = Math.floor((y - 12) / 3);
      const mortar = (y - 12) % 3 === 2 || (x - 31 + (row % 2 ? 2 : 0)) % 4 === 0;
      p.px(x, y, edge ? "O" : mortar ? "I" : "T");
    }
  }
}

function spinner(p: Painter, cx: number, cy: number, r: number, phase: number): void {
  const gap = (phase * Math.PI) / 4;
  for (let a = 0; a < 360; a += 5) {
    const rad = (a * Math.PI) / 180;
    const rel = (((rad - gap) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    if (rel >= 1.4) p.px(Math.round(cx + r * Math.cos(rad)), Math.round(cy + r * Math.sin(rad)), "C");
  }
  const ex = cx + r * Math.cos(gap);
  const ey = cy + r * Math.sin(gap);
  const nx = Math.cos(gap);
  const ny = Math.sin(gap);
  for (const [x, y] of [[ex, ey], [ex + nx, ey + ny], [ex - nx, ey - ny], [ex - ny, ey + nx]] as const) p.px(Math.round(x), Math.round(y), "C");
}

interface Look {
  /** The tick shown when motion is reduced: one frame that still reads as the mood. */
  still: number;
  face(t: number): Face;
  /** [x, y] offset of the character (not the props around it). */
  bob(t: number): Pt;
  /** Arms behind the body, and arms in front of it. */
  arms(t: number): { back: readonly (readonly Pt[])[]; front?: readonly (readonly Pt[])[] };
  /** Drawn with the character (things it holds). */
  held?(p: Painter, t: number): void;
  /** Drawn around it, not moving with it. */
  world?(p: Painter, t: number): void;
  /** `world` goes behind the character. */
  worldBehind?: boolean;
}

const blinkAt = (t: number, every: number) => t % every === every - 1;
const slowBob = (t: number): Pt => [0, (t >> 2) % 2];
const JUMP = [0, -1, -3, -4, -3, -1, 0, 0];
const SHAKE = [0, 1, 0, -1, 0, 1, 0, 0, 0, 0, 0, 0];

const LOOKS: Record<FloMood, Look> = {
  idle: {
    still: 0,
    face: (t) => (blinkAt(t, 22) ? FACE.blink : FACE.neutral),
    bob: slowBob,
    arms: () => ({ back: ARMS_DOWN }),
  },
  thinking: {
    still: 5,
    face: (t) => (blinkAt(t, 28) ? FACE.upBlink : FACE.up),
    bob: slowBob,
    arms: () => ({ back: [POSE.down], front: [R_CHIN] }),
    world: (p, t) => {
      bubble(p, 0);
      for (let i = 0; i < (t >> 1) % 4; i++) p.px(33 + i * 2, 3, "O");
    },
  },
  reading: {
    still: 2,
    face: (t) => (blinkAt(t, 26) ? FACE.rightBlink : FACE.right),
    bob: slowBob,
    arms: () => ({ back: [POSE.down], front: [R_HOLD] }),
    held: (p, t) => {
      pat(p, PAPER, 30, 12, { l: "Q" });
      const row = [3, 5, 7, 9][(t >> 1) % 4] ?? 3;
      pat(p, [(PAPER[row] ?? "").replace(/[^l]/g, ".")], 30, 12 + row, { l: "C" });
    },
  },
  coding: {
    still: 1,
    face: (t) => (blinkAt(t, 30) ? FACE.focusBlink : FACE.focus),
    bob: () => [0, 0],
    arms: () => ({ back: ARMS_DOWN }),
    held: (p, t) => {
      laptop(p, t);
      hand(p, 11, t % 2 ? 25 : 26);
      hand(p, 27, t % 2 ? 26 : 25);
    },
    world: (p, t) => {
      BITS.forEach((bit, i) => {
        const k = (t + i * 5) % 10;
        if (k < 9) pat(p, bit, 32 + i * 4, 14 - k, { X: "C" });
      });
    },
  },
  testing: {
    still: 13,
    face: (t) => (blinkAt(t, 26) ? FACE.rightBlink : FACE.right),
    bob: slowBob,
    arms: () => ({ back: [POSE.down], front: [R_HOLD] }),
    held: (p, t) => {
      pat(p, CLIP, 30, 12, { b: "Q", l: "Q" });
      const ticks = Math.min(3, Math.floor((t % 16) / 3));
      for (let i = 0; i < ticks; i++) {
        p.px(32, 15 + i * 2, "S");
        pat(p, ["ll"], 34, 15 + i * 2, { l: "S" });
      }
    },
  },
  waiting: {
    still: 0,
    face: () => FACE.wait,
    bob: (t) => [0, (t >> 1) % 2],
    arms: (t) => ({ back: [(t >> 1) % 2 ? POSE.raiseB : POSE.raiseA, mirror(POSE.down)] }),
    world: (p, t) => bubble(p, (t >> 1) % 2, Q_GLYPH, "E"),
  },
  retrying: {
    still: 3,
    face: () => FACE.strain,
    bob: (t) => [0, (t >> 1) % 2],
    arms: () => ({ back: ARMS_DOWN }),
    world: (p, t) => {
      spinner(p, 35, 3, 3, t % 8);
      pat(p, DROP, 30, 9 + (t % 5));
    },
  },
  paused: {
    still: 6,
    face: () => FACE.sleep,
    bob: (t) => [0, (t >> 3) % 2],
    arms: () => ({ back: ARMS_DOWN }),
    world: (p, t) => {
      const k1 = (t >> 1) % 8;
      const k2 = ((t >> 1) + 4) % 8;
      pat(p, Z_SMALL, 31 + (k1 >> 2), 12 - k1, { X: "Z" });
      pat(p, Z_BIG, 33 + (k2 >> 2), 10 - k2, { X: "Z" });
    },
  },
  passed: {
    still: 3,
    face: () => FACE.happy,
    bob: (t) => [0, JUMP[t % JUMP.length] ?? 0],
    arms: () => ({ back: [POSE.cheer, mirror(POSE.cheer)] }),
    world: (p, t) => {
      const spots: Pt[] = [[2, 6], [33, 13], [4, 21], [33, 25], [30, 2]];
      spots.forEach(([x, y], i) => {
        if ((t + i * 2) % 6 >= 3) return;
        if ((t + i) % 2) pat(p, STAR, x, y, { X: "X" });
        else pat(p, STAR_S, x + 1, y + 1, { X: "X" });
      });
    },
  },
  assumed: {
    still: 0,
    face: () => FACE.assume,
    bob: () => [0, 0],
    arms: (t) => {
      const pose = (t >> 1) % 2 ? POSE.shrugB : POSE.shrugA;
      return { back: [pose, mirror(pose)] };
    },
    world: (p, t) => pat(p, NOTE, 31, (t >> 2) % 2),
  },
  blocked: {
    still: 0,
    face: (t) => (blinkAt(t, 24) ? FACE.blockedBlink : FACE.blocked),
    bob: () => [0, 0],
    arms: () => ({ back: [] }),
    held: (p) => pat(p, FOLDED, 13, 24),
    world: (p) => wall(p),
  },
  failed: {
    still: 1,
    face: () => FACE.fail,
    bob: (t) => [SHAKE[t % SHAKE.length] ?? 0, 1],
    arms: () => ({ back: ARMS_DOWN }),
    worldBehind: true,
    world: (p, t) => {
      for (let i = 0; i < 3; i++) {
        const k = (t + i * 3) % 9;
        pat(p, PUFF, 14 + i * 5 + (k % 4 < 2 ? 0 : 1), 4 - Math.floor(k / 2));
      }
    },
  },
};

export const floStill = (mood: FloMood): number => LOOKS[mood].still;

/** Draws one frame of Flo filling the canvas (sized to a multiple of FLO_W × FLO_H). */
export function drawFlo(ctx: CanvasRenderingContext2D, mood: FloMood, t: number, colors: FloColors): void {
  const look = LOOKS[mood];
  const p = painter(ctx, ctx.canvas.width / FLO_W, colors);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  pat(p, ["..HHHHHHHHHHHH..", "HHHHHHHHHHHHHHHH", "..HHHHHHHHHHHH.."], 12, 30);
  if (look.worldBehind) look.world?.(p, t);
  [p.ox, p.oy] = look.bob(t);
  const arms = look.arms(t);
  feet(p);
  arms.back.forEach((a) => arm(p, a));
  body(p);
  head(p, look.face(t));
  look.held?.(p, t);
  arms.front?.forEach((a) => arm(p, a));
  p.ox = 0;
  p.oy = 0;
  if (!look.worldBehind) look.world?.(p, t);
}
