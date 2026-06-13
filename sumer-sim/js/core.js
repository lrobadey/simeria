// ── Core: configuration, math, noise, calendar ──────────────────────────
// The only numbers in the project that are *allowed* to be authored live
// here: world scale, the physical datum, and the pace of time. Everything
// else downstream must be derived from terrain, water, and these clocks.

const CFG = {
  WORLD: 192,            // tiles per side
  TILE: 5,               // rendered px per tile
  TILE_METERS: 10,
  SEA_LEVEL: 0.42,       // the one physical datum
  DAY_REAL_SECONDS: 3600, // one full day-night cycle per real-world hour
  YEAR_DAYS: 365,
  START_DAY: 89.27,      // late March, just past dawn — spring rise begins
  SEED: 1337,
};

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }
function smoothstep(t) { return t * t * (3 - 2 * t); }
function dist2(ax, ay, bx, by) { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; }

function seededRandom(seed) {
  let value = seed;
  return function random() {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}
const random = seededRandom(CFG.SEED);

function hashNoise(x, y) {
  let n = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  n = n ^ (n >>> 16);
  return (n >>> 0) / 4294967296;
}

function valueNoise(x, y, scale) {
  const cellX = Math.floor(x / scale);
  const cellY = Math.floor(y / scale);
  const localX = smoothstep(((x % scale) + scale) % scale / scale);
  const localY = smoothstep(((y % scale) + scale) % scale / scale);
  const top = lerp(hashNoise(cellX, cellY), hashNoise(cellX + 1, cellY), localX);
  const bottom = lerp(hashNoise(cellX, cellY + 1), hashNoise(cellX + 1, cellY + 1), localX);
  return lerp(top, bottom, localY);
}

function layeredNoise(x, y) {
  return (
    valueNoise(x, y, 64) * 0.55 +
    valueNoise(x, y, 32) * 0.3 +
    valueNoise(x, y, 16) * 0.15
  );
}

// ── Calendar & seasonal forcing curves ──────────────────────────────────
// Southern Mesopotamia: low winter rain, spring snowmelt flood pulse from
// the mountains, brutal summer evaporation. These curves force the climate;
// the terrain decides what the water actually does.

const MONTHS = [
  { name: "Jan", days: 31 }, { name: "Feb", days: 28 }, { name: "Mar", days: 31 },
  { name: "Apr", days: 30 }, { name: "May", days: 31 }, { name: "Jun", days: 30 },
  { name: "Jul", days: 31 }, { name: "Aug", days: 31 }, { name: "Sep", days: 30 },
  { name: "Oct", days: 31 }, { name: "Nov", days: 30 }, { name: "Dec", days: 31 },
];

const MONTHLY_RIVER_FLOW = [2.0, 3.0, 6.0, 10.0, 9.0, 4.0, 2.0, 1.2, 1.0, 1.0, 1.3, 1.7];
const MONTHLY_RAIN = [1.0, 0.9, 0.8, 0.5, 0.15, 0.0, 0.0, 0.0, 0.0, 0.15, 0.5, 0.9];
const MONTHLY_EVAPORATION = [0.2, 0.3, 0.45, 0.7, 1.0, 1.4, 1.8, 1.8, 1.4, 0.9, 0.45, 0.25];
const MONTHLY_TEMP = [11, 13, 17, 23, 29, 34, 37, 36, 32, 26, 18, 12]; // °C daily mean

function dateForDay(dayOfYear) {
  let remaining = Math.floor(dayOfYear);
  for (const month of MONTHS) {
    if (remaining < month.days) return { month: month.name, day: remaining + 1 };
    remaining -= month.days;
  }
  return { month: "Dec", day: 31 };
}

function monthIndexAndProgressForDay(dayOfYear) {
  let remaining = dayOfYear;
  for (let i = 0; i < MONTHS.length; i++) {
    if (remaining < MONTHS[i].days) return { index: i, progress: remaining / MONTHS[i].days };
    remaining -= MONTHS[i].days;
  }
  return { index: 11, progress: 1 };
}

function seasonalValueForDay(dayOfYear, monthlyValues) {
  const { index, progress } = monthIndexAndProgressForDay(dayOfYear);
  return lerp(monthlyValues[index], monthlyValues[(index + 1) % 12], smoothstep(progress));
}

function riverFlowForDay(d) { return seasonalValueForDay(d, MONTHLY_RIVER_FLOW); }
function rainfallForDay(d) { return seasonalValueForDay(d, MONTHLY_RAIN); }
function evaporationForDay(d) { return seasonalValueForDay(d, MONTHLY_EVAPORATION); }

function seasonForDay(dayOfYear) {
  if (dayOfYear < 59) return "Winter rains";
  if (dayOfYear < 151) return "Spring river rise";
  if (dayOfYear < 243) return "High summer";
  if (dayOfYear < 304) return "Autumn low water";
  return "Winter rains return";
}

function mixColor(a, b, t) {
  return {
    r: Math.round(lerp(a.r, b.r, t)),
    g: Math.round(lerp(a.g, b.g, t)),
    b: Math.round(lerp(a.b, b.b, t)),
  };
}
function colorToRgb(c) { return `rgb(${c.r}, ${c.g}, ${c.b})`; }
