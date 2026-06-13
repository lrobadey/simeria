// ── Flora: continuous vegetation fields + discrete trees ────────────────
// Grasses, scrub, reeds and fish live as per-tile densities that grow
// logistically toward a carrying capacity *derived* from the hydrology,
// disperse into neighboring habitat, and get eaten down by fauna. Trees
// are individuals: they age, fruit in season, seed saplings nearby, and
// die into deadwood that a human can gather.

// ── Carrying capacities (read once from worldgen, refreshed on flood) ───

function computeVegCapacities() {
  const area = world.width * world.height;

  for (const tile of world.tiles) {
    const saltKill = 1 - clamp((tile.salinity - 0.25) / 0.45, 0, 1);
    const saltTolerant = 1 - clamp((tile.salinity - 0.6) / 0.3, 0, 1);

    // Floodplain grass: wants moist fertile ground that isn't drowned.
    const drowned = clamp(tile.pondingDepth / 0.004, 0, 1);
    tile.grassCap = isWaterTerrain(tile) ? 0 :
      clamp(tile.fertility * 1.25, 0, 1) * (1 - drowned) * saltKill;

    // Desert scrub: peaks on dry marginal ground where grass gives up —
    // the niches partition themselves along the moisture axis.
    const dryness = 1 - clamp((tile.moisture - 0.15) / 0.35, 0, 1);
    const notBarren = clamp(tile.moisture / 0.06, 0, 1);
    tile.scrubCap = isWaterTerrain(tile) ? 0 :
      dryness * notBarren * saltTolerant * 0.7;

    // Reeds: roots wet, crowns dry — a hump over ponding depth, scoured
    // out of moving channels, giving up in hypersaline lagoons.
    if (tile.terrain === "river") {
      tile.reedCap = 0;
    } else {
      const depth = tile.pondingDepth;
      const rise = clamp((depth - 0.0005) / 0.0015, 0, 1);
      const fall = 1 - clamp((depth - 0.01) / 0.006, 0, 1);
      const flowTolerance = 1 - clamp(tile.flow / (area * 0.01), 0, 1);
      const saltTol = 1 - clamp((tile.salinity - 0.35) / 0.35, 0, 1);
      tile.reedCap = Math.min(rise, fall) * flowTolerance * saltTol;
    }

    // Fish: need real water; thrive where it's fresh-ish and where reeds
    // give cover (the marsh is the nursery, the open gulf is poorer).
    if (isWaterTerrain(tile)) {
      const depthOk = clamp(tile.pondingDepth / 0.006, 0, 1);
      const freshness = 1 - clamp((tile.salinity - 0.5) / 0.4, 0, 1);
      const cover = 0.5 + 0.5 * clamp(tile.reedCap * 2, 0, 1);
      tile.fishCap = (tile.terrain === "river" ? 0.8 : depthOk) * freshness * cover;
    } else {
      tile.fishCap = 0;
    }
  }
}

function seedVegetation() {
  // A mature world: fields near capacity, thinned by noise so everything
  // reads patchy rather than carpeted.
  for (const tile of world.tiles) {
    tile.grass = tile.grassCap * (0.45 + 0.55 * valueNoise(tile.x + 3100, tile.y + 3100, 9));
    tile.scrub = tile.scrubCap * (0.4 + 0.6 * valueNoise(tile.x + 4200, tile.y + 4200, 13));
    tile.reeds = tile.reedCap * (0.5 + 0.5 * valueNoise(tile.x + 7000, tile.y + 7000, 11));
    tile.fish = tile.fishCap * (0.5 + 0.5 * valueNoise(tile.x + 8100, tile.y + 8100, 15));
  }
}

// Logistic growth + neighbor dispersal, called once per game-hour with the
// elapsed time. Growth rates are per-day; regrowth is slow enough that
// overgrazing has real consequences.
const FIELD_FLORA = [
  { key: "grass", cap: "grassCap", rate: 0.16, disperse: 0.03 },
  { key: "scrub", cap: "scrubCap", rate: 0.025, disperse: 0.006 },
  { key: "reeds", cap: "reedCap", rate: 0.07, disperse: 0.015 },
  { key: "fish",  cap: "fishCap", rate: 0.06, disperse: 0.03 },
];

let fieldFloraNeighbors = new Int32Array(0);
let fieldFloraNeighborsKey = "";

function ensureFieldFloraNeighbors() {
  const key = `${world.width}x${world.height}x${world.tiles.length}`;
  if (fieldFloraNeighborsKey === key) return;

  fieldFloraNeighbors = new Int32Array(world.tiles.length * 4);
  const width = world.width;
  const height = world.height;

  for (let i = 0; i < world.tiles.length; i++) {
    const tile = world.tiles[i];
    const x = tile.x;
    const y = tile.y;
    const offset = i * 4;
    fieldFloraNeighbors[offset] = y > 0 ? (y - 1) * width + x : -1;
    fieldFloraNeighbors[offset + 1] = y < height - 1 ? (y + 1) * width + x : -1;
    fieldFloraNeighbors[offset + 2] = x > 0 ? y * width + x - 1 : -1;
    fieldFloraNeighbors[offset + 3] = x < width - 1 ? y * width + x + 1 : -1;
  }

  fieldFloraNeighborsKey = key;
}

function updateFieldFlora(dtDays) {
  ensureFieldFloraNeighbors();
  const dayOfYear = dayOfYearOf(sim.day);
  // Plants track the rain/heat year: lush spring growth, summer dormancy.
  const seasonVigor = clamp(0.35 + rainfallForDay(dayOfYear) * 0.6 +
    riverFlowForDay(dayOfYear) * 0.05 - (evaporationForDay(dayOfYear) - 1) * 0.25, 0.1, 1.2);

  updateGrassField(dtDays, seasonVigor);
  updateScrubField(dtDays, seasonVigor);
  updateReedField(dtDays, seasonVigor);
  updateFishField(dtDays);
}

function updateGrassField(dtDays, vigor) {
  const tiles = world.tiles;
  const neighbors = fieldFloraNeighbors;
  const decay = 0.05 * dtDays;
  for (let i = 0, offset = 0; i < tiles.length; i++, offset += 4) {
    const tile = tiles[i];
    const K = tile.grassCap;
    let d = tile.grass;
    if (K <= 0.01) {
      if (d > 0) tile.grass = Math.max(0, d - decay); // habitat gone, die back
      continue;
    }
    // Seeds drift in from the four neighbors — empty habitat refills
    // from its edges, so recovery fronts sweep across grazed ground.
    let neighborSeed = 0;
    const up = neighbors[offset], down = neighbors[offset + 1];
    const left = neighbors[offset + 2], right = neighbors[offset + 3];
    if (up >= 0) neighborSeed += tiles[up].grass;
    if (down >= 0) neighborSeed += tiles[down].grass;
    if (left >= 0) neighborSeed += tiles[left].grass;
    if (right >= 0) neighborSeed += tiles[right].grass;
    neighborSeed *= 0.25;

    const growth = 0.16 * vigor * d * (1 - d / K) +
      0.03 * vigor * neighborSeed * (1 - d / K);
    tile.grass = clamp(d + growth * dtDays, 0, 1);
  }
}

function updateScrubField(dtDays, vigor) {
  const tiles = world.tiles;
  const neighbors = fieldFloraNeighbors;
  const decay = 0.05 * dtDays;
  for (let i = 0, offset = 0; i < tiles.length; i++, offset += 4) {
    const tile = tiles[i];
    const K = tile.scrubCap;
    let d = tile.scrub;
    if (K <= 0.01) {
      if (d > 0) tile.scrub = Math.max(0, d - decay); // habitat gone, die back
      continue;
    }
    let neighborSeed = 0;
    const up = neighbors[offset], down = neighbors[offset + 1];
    const left = neighbors[offset + 2], right = neighbors[offset + 3];
    if (up >= 0) neighborSeed += tiles[up].scrub;
    if (down >= 0) neighborSeed += tiles[down].scrub;
    if (left >= 0) neighborSeed += tiles[left].scrub;
    if (right >= 0) neighborSeed += tiles[right].scrub;
    neighborSeed *= 0.25;

    const growth = 0.025 * vigor * d * (1 - d / K) +
      0.006 * vigor * neighborSeed * (1 - d / K);
    tile.scrub = clamp(d + growth * dtDays, 0, 1);
  }
}

function updateReedField(dtDays, vigor) {
  const tiles = world.tiles;
  const neighbors = fieldFloraNeighbors;
  const decay = 0.05 * dtDays;
  for (let i = 0, offset = 0; i < tiles.length; i++, offset += 4) {
    const tile = tiles[i];
    const K = tile.reedCap;
    let d = tile.reeds;
    if (K <= 0.01) {
      if (d > 0) tile.reeds = Math.max(0, d - decay); // habitat gone, die back
      continue;
    }
    let neighborSeed = 0;
    const up = neighbors[offset], down = neighbors[offset + 1];
    const left = neighbors[offset + 2], right = neighbors[offset + 3];
    if (up >= 0) neighborSeed += tiles[up].reeds;
    if (down >= 0) neighborSeed += tiles[down].reeds;
    if (left >= 0) neighborSeed += tiles[left].reeds;
    if (right >= 0) neighborSeed += tiles[right].reeds;
    neighborSeed *= 0.25;

    const growth = 0.07 * vigor * d * (1 - d / K) +
      0.015 * vigor * neighborSeed * (1 - d / K);
    tile.reeds = clamp(d + growth * dtDays, 0, 1);
  }
}

function updateFishField(dtDays) {
  const tiles = world.tiles;
  const neighbors = fieldFloraNeighbors;
  const decay = 0.05 * dtDays;
  for (let i = 0, offset = 0; i < tiles.length; i++, offset += 4) {
    const tile = tiles[i];
    const K = tile.fishCap;
    let d = tile.fish;
    if (K <= 0.01) {
      if (d > 0) tile.fish = Math.max(0, d - decay); // habitat gone, die back
      continue;
    }
    let neighborSeed = 0;
    const up = neighbors[offset], down = neighbors[offset + 1];
    const left = neighbors[offset + 2], right = neighbors[offset + 3];
    if (up >= 0) neighborSeed += tiles[up].fish;
    if (down >= 0) neighborSeed += tiles[down].fish;
    if (left >= 0) neighborSeed += tiles[left].fish;
    if (right >= 0) neighborSeed += tiles[right].fish;
    neighborSeed *= 0.25;

    const growth = 0.06 * d * (1 - d / K) +
      0.03 * neighborSeed * (1 - d / K);
    tile.fish = clamp(d + growth * dtDays, 0, 1);
  }
}

// ── Trees ───────────────────────────────────────────────────────────────

const TREE_SPECIES = {
  palm: {
    // Date palm: feet in the water table, head in the sun. Levee banks and
    // moist silt near channels; drowned or salted ground refuses it.
    suitability(tile) {
      if (isWaterTerrain(tile) || tile.pondingDepth > 0.003) return 0;
      const waterTable = Math.pow(1 - clamp(tile.distanceToRiver / (world.height * 0.1), 0, 1), 1.4);
      const moist = clamp((tile.moisture - 0.25) / 0.3, 0, 1);
      const salt = 1 - clamp((tile.salinity - 0.4) / 0.3, 0, 1);
      return Math.max(waterTable, moist * 0.8) * salt;
    },
    matureYears: 8, maxYears: 90, spacing: 2.2,
    fruiting: true, woodYield: 6,
  },
  tamarisk: {
    // Salt cedar: shrubby, frugal, salt-tolerant — it owns the margins
    // where palms and grass both fail.
    suitability(tile) {
      if (isWaterTerrain(tile) || tile.pondingDepth > 0.003) return 0;
      const some = clamp(tile.moisture / 0.12, 0, 1);
      const notLush = 1 - clamp((tile.fertility - 0.5) / 0.3, 0, 1); // outcompeted on prime ground
      const salt = 1 - clamp((tile.salinity - 0.75) / 0.2, 0, 1);
      return some * notLush * salt * 0.8;
    },
    matureYears: 4, maxYears: 40, spacing: 1.8,
    fruiting: false, woodYield: 3,
  },
};

const trees = [];
const treeGrid = new Map(); // coarse cell -> tree list, for spacing/search

function treeCellKey(x, y) { return ((y >> 2) << 12) | (x >> 2); }

function treeGridAdd(tree) {
  const key = treeCellKey(Math.floor(tree.x), Math.floor(tree.y));
  let list = treeGrid.get(key);
  if (!list) { list = []; treeGrid.set(key, list); }
  list.push(tree);
}

function treesNear(x, y, radius) {
  const found = [];
  const r2 = radius * radius;
  const minCx = (Math.floor(x - radius)) >> 2, maxCx = (Math.floor(x + radius)) >> 2;
  const minCy = (Math.floor(y - radius)) >> 2, maxCy = (Math.floor(y + radius)) >> 2;
  for (let cy = minCy; cy <= maxCy; cy++) {
    for (let cx = minCx; cx <= maxCx; cx++) {
      const list = treeGrid.get((cy << 12) | cx);
      if (!list) continue;
      for (const tree of list) {
        if (!tree.removed && dist2(tree.x, tree.y, x, y) <= r2) found.push(tree);
      }
    }
  }
  return found;
}

function tryPlantTree(speciesKey, x, y, ageDays) {
  const species = TREE_SPECIES[speciesKey];
  const tile = getTileF(x, y);
  if (!tile || species.suitability(tile) < 0.25) return null;
  if (treesNear(x, y, species.spacing).length > 0) return null;
  const tree = {
    species: speciesKey, x, y,
    age: ageDays,
    fruit: 0,        // 0..1 ripeness, palms only
    dead: false, wood: 0, decay: 0,
    removed: false,
    variant: Math.floor(random() * 4),
  };
  trees.push(tree);
  treeGridAdd(tree);
  return tree;
}

function initTrees() {
  // Scatter by rejection sampling against suitability — groves assemble
  // themselves along the levees and channel margins.
  for (const tile of world.tiles) {
    for (const speciesKey of ["palm", "tamarisk"]) {
      const species = TREE_SPECIES[speciesKey];
      const s = species.suitability(tile);
      if (s <= 0.25) continue;
      const chance = speciesKey === "palm" ? s * 0.075 : s * 0.05;
      if (random() < chance) {
        const ageDays = random() * species.maxYears * 0.7 * CFG.YEAR_DAYS;
        tryPlantTree(speciesKey, tile.x + random(), tile.y + random(), ageDays);
      }
    }
  }
}

function treeIsMature(tree) {
  return tree.age >= TREE_SPECIES[tree.species].matureYears * CFG.YEAR_DAYS;
}

// Date season: fruit swells through high summer, ripens Aug–Oct, and what
// nobody eats falls and may germinate.
function dailyTreeUpdate(dayOfYear) {
  for (const tree of trees) {
    if (tree.removed) continue;
    const species = TREE_SPECIES[tree.species];

    if (tree.dead) {
      tree.decay += 1;
      if (tree.wood <= 0 || tree.decay > 400) tree.removed = true;
      continue;
    }

    tree.age += 1;

    // Habitat can die under a tree (salt creep, drying): stressed trees die
    // young, which redraws the groves when the water moves.
    const tile = getTileF(tree.x, tree.y);
    const s = tile ? species.suitability(tile) : 0;
    const stress = s < 0.15 ? 0.004 : 0;
    const senescence = tree.age > species.maxYears * CFG.YEAR_DAYS ? 0.01 : 0;
    if (random() < stress + senescence + 0.00002) {
      tree.dead = true;
      tree.wood = species.woodYield * (0.4 + 0.6 * Math.min(1, tree.age / (species.matureYears * CFG.YEAR_DAYS)));
      tree.fruit = 0;
      continue;
    }

    if (species.fruiting && treeIsMature(tree)) {
      if (dayOfYear > 180 && dayOfYear < 290) {
        tree.fruit = clamp(tree.fruit + (1 / 70) * (0.5 + s), 0, 1);
      } else if (tree.fruit > 0) {
        // Falling fruit is the reproduction event.
        tree.fruit = Math.max(0, tree.fruit - 0.05);
        if (random() < tree.fruit * 0.02) {
          const angle = random() * Math.PI * 2;
          const r = 2 + random() * 6;
          tryPlantTree(tree.species, tree.x + Math.cos(angle) * r, tree.y + Math.sin(angle) * r, 0);
        }
      }
    } else if (!species.fruiting && treeIsMature(tree) && random() < 0.001) {
      const angle = random() * Math.PI * 2;
      const r = 1.5 + random() * 5;
      tryPlantTree(tree.species, tree.x + Math.cos(angle) * r, tree.y + Math.sin(angle) * r, 0);
    }
  }
}

function initFlora() {
  computeVegCapacities();
  seedVegetation();
  initTrees();
}
