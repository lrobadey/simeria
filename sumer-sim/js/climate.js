// ── Climate: the sun, the air, and the daily water cycle ────────────────
// Time is a single float `simDay` (fractional days since Jan 1). The sun's
// altitude drives light and temperature; the seasonal curves drive the
// once-per-day surface-water simulation ported from the terrain prototype.

function dayOfYearOf(simDay) { return ((simDay % CFG.YEAR_DAYS) + CFG.YEAR_DAYS) % CFG.YEAR_DAYS; }
function timeOfDayOf(simDay) { return simDay - Math.floor(simDay); } // 0..1, 0 = midnight

function daylightHours(dayOfYear) {
  // Solstice-driven: ~14.2h midsummer, ~9.8h midwinter at this latitude.
  return 12 + 2.2 * Math.cos(((dayOfYear - 172) / CFG.YEAR_DAYS) * Math.PI * 2);
}

// Sun altitude in [-1, 1]: positive while the sun is up.
function sunAltitude(simDay) {
  const dayOfYear = dayOfYearOf(simDay);
  const hour = timeOfDayOf(simDay) * 24;
  const dayLen = daylightHours(dayOfYear);
  const sunrise = 12 - dayLen / 2;
  const sunset = 12 + dayLen / 2;
  if (hour >= sunrise && hour <= sunset) {
    return Math.sin(Math.PI * (hour - sunrise) / dayLen);
  }
  const nightLen = 24 - dayLen;
  const sinceSunset = hour > sunset ? hour - sunset : hour + (24 - sunset);
  return -Math.sin(Math.PI * sinceSunset / nightLen);
}

function temperatureAt(simDay) {
  const dayOfYear = dayOfYearOf(simDay);
  const base = seasonalValueForDay(dayOfYear, MONTHLY_TEMP);
  // Diurnal swing lags the sun by ~2 hours; clear desert skies swing hard.
  const lagged = sunAltitude(simDay - 2 / 24);
  return base + lagged * 7;
}

// Ambient light color for the multiply pass. Keyed off sun altitude so dawn
// and dusk get their gold automatically as the sun crosses the horizon.
const LIGHT_NIGHT = { r: 54, g: 68, b: 116 };
const LIGHT_ASTRO = { r: 78, g: 82, b: 128 };  // deep twilight
const LIGHT_HORIZON = { r: 250, g: 176, b: 126 }; // sun on the horizon
const LIGHT_GOLDEN = { r: 255, g: 214, b: 158 };
const LIGHT_NOON = { r: 255, g: 252, b: 244 };

function ambientLight(simDay) {
  const sun = sunAltitude(simDay);
  if (sun <= -0.25) return LIGHT_NIGHT;
  if (sun <= 0) {
    const t = (sun + 0.25) / 0.25;
    return mixColor(LIGHT_NIGHT, mixColor(LIGHT_ASTRO, LIGHT_HORIZON, t), smoothstep(t));
  }
  if (sun <= 0.18) return mixColor(LIGHT_HORIZON, LIGHT_GOLDEN, smoothstep(sun / 0.18));
  return mixColor(LIGHT_GOLDEN, LIGHT_NOON, smoothstep(clamp((sun - 0.18) / 0.5, 0, 1)));
}

function nightness(simDay) {
  return clamp(-sunAltitude(simDay) / 0.3, 0, 1);
}

// ── Daily surface-water simulation ──────────────────────────────────────

const WATER_MOVEMENT_PASSES = 6;
const RAIN_TO_SURFACE_WATER = 0.00006;
const RIVER_STAGE_PER_FLOW = 0.008;
const SURFACE_EVAPORATION = 0.00028;
const SURFACE_ABSORPTION = 0.00022;
const SURFACE_WATER_VISIBLE_DEPTH = 0.00035;

function seasonalBaseLevel(tile) {
  return tile.pondingDepth > 0 ? tile.waterSurface : tile.elevation;
}

function seasonalWaterLevel(tile) {
  return seasonalBaseLevel(tile) + tile.surfaceWater;
}

function applySeasonalForcing(dayOfYear) {
  const riverMultiplier = riverFlowForDay(dayOfYear);
  const rainfall = rainfallForDay(dayOfYear);
  const area = world.width * world.height;
  const rainDepth = rainfall * RAIN_TO_SURFACE_WATER;

  for (const tile of world.tiles) {
    tile.riverStage = 0;
    if (!isOpenSeaSink(tile) && tile.terrain !== "river") {
      tile.surfaceWater += rainDepth;
    }
    if (tile.terrain === "river") {
      const channelStrength = clamp(Math.sqrt(tile.flow / (area * 0.6)), 0.25, 1.2);
      tile.riverStage = (0.006 + riverMultiplier * RIVER_STAGE_PER_FLOW) * channelStrength;
      tile.surfaceWater = tile.riverStage;
    }
  }
}

function moveSeasonalSurfaceWater() {
  const deltas = new Float32Array(world.tiles.length);

  for (let pass = 0; pass < WATER_MOVEMENT_PASSES; pass++) {
    deltas.fill(0);

    for (const tile of world.tiles) {
      if (tile.surfaceWater <= 0.00001) continue;

      const tileLevel = seasonalWaterLevel(tile);
      const lower = [];
      let totalDrop = 0;

      for (const [dx, dy] of NEIGHBORS_8) {
        const neighbor = getTile(tile.x + dx, tile.y + dy);
        if (!neighbor) continue;
        const drop = tileLevel - seasonalWaterLevel(neighbor);
        if (drop <= 0.00002) continue;
        const weightedDrop = drop / Math.sqrt(dx * dx + dy * dy);
        lower.push({ neighbor, drop: weightedDrop });
        totalDrop += weightedDrop;
      }

      if (lower.length === 0) continue;

      const spillFraction = tile.terrain === "river" ? 0.65 : 0.45;
      const slopeFraction = tile.terrain === "river" ? 0.35 : 0.18;
      const transferable = Math.min(tile.surfaceWater * spillFraction, totalDrop * slopeFraction);
      if (transferable <= 0) continue;

      deltas[tileIndex(tile.x, tile.y)] -= transferable;
      for (const option of lower) {
        deltas[tileIndex(option.neighbor.x, option.neighbor.y)] += transferable * (option.drop / totalDrop);
      }
    }

    for (let i = 0; i < world.tiles.length; i++) {
      const tile = world.tiles[i];
      tile.surfaceWater = Math.max(0, tile.surfaceWater + deltas[i]);
      if (tile.terrain === "river") {
        // The river is a boundary source fed from off-map.
        tile.surfaceWater = Math.max(tile.surfaceWater, tile.riverStage);
      }
    }
  }
}

function infiltrateAndEvaporateSeasonalWater(dayOfYear) {
  const evaporation = evaporationForDay(dayOfYear);

  for (const tile of world.tiles) {
    if (isOpenSeaSink(tile)) {
      tile.surfaceWater = 0;
      tile.riverStage = 0;
      continue;
    }
    if (tile.terrain === "river") {
      tile.surfaceWater = tile.riverStage;
      continue;
    }
    if (tile.surfaceWater > 0) {
      const saturatedGround = clamp(tile.pondingDepth / 0.012, 0, 0.8);
      const absorption = Math.min(tile.surfaceWater, SURFACE_ABSORPTION * (1 - saturatedGround));
      tile.surfaceWater = Math.max(0, tile.surfaceWater - absorption);
      tile.surfaceWater = Math.max(0, tile.surfaceWater - SURFACE_EVAPORATION * evaporation);
    }
  }
}

function simulateSeasonalWaterDay(dayOfYear) {
  applySeasonalForcing(dayOfYear);
  moveSeasonalSurfaceWater();
  infiltrateAndEvaporateSeasonalWater(dayOfYear);
}

// Effective wetness a plant or animal experiences right now: worldgen
// moisture plus any seasonal flood water currently sitting on the tile.
function liveWetness(tile) {
  return clamp(tile.moisture + clamp(tile.surfaceWater / 0.004, 0, 0.5), 0, 1);
}
