// ── World generation: the hydrology pipeline ────────────────────────────
// Condition the surface so every tile drains, route rain + the off-map
// Euphrates over it, carve channels where discharge concentrates, refill,
// then read moisture / fertility / salinity off the water that actually
// ended up everywhere. Nothing names the marsh or the delta — they emerge.

const world = {
  width: CFG.WORLD,
  height: CFG.WORLD,
  tiles: [],
};

const NEIGHBORS_8 = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
];

function tileIndex(x, y) { return y * world.width + x; }

function getTile(x, y) {
  if (x < 0 || x >= world.width || y < 0 || y >= world.height) return null;
  return world.tiles[tileIndex(x, y)];
}

function getTileF(fx, fy) { return getTile(Math.floor(fx), Math.floor(fy)); }

function generateElevation(x, y) {
  const southness = y / (world.height - 1);
  const noise = layeredNoise(x, y) - 0.5;
  // Concave north-to-south profile: steeper off the alluvial fans, sinking
  // under the noise amplitude near the coast — the interfingered delta
  // coastline emerges from that crossover, not from any rule.
  const profile = Math.pow(1 - southness, 1.75) * 0.16;
  return CFG.SEA_LEVEL - 0.01 + profile + noise * 0.045;
}

function isOpenSeaSink(tile) {
  return tile.distanceToSea === 0 && tile.waterSurface <= CFG.SEA_LEVEL + 0.0005;
}

function fillDepressions() {
  // Priority-flood from the map edges: any pit can only drain by rising to
  // the level we arrived from, so its water surface is raised to match.
  const heap = [];
  function heapPush(item) {
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heap[parent].level <= heap[i].level) break;
      [heap[parent], heap[i]] = [heap[i], heap[parent]];
      i = parent;
    }
  }
  function heapPop() {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      while (true) {
        const left = i * 2 + 1, right = left + 1;
        let smallest = i;
        if (left < heap.length && heap[left].level < heap[smallest].level) smallest = left;
        if (right < heap.length && heap[right].level < heap[smallest].level) smallest = right;
        if (smallest === i) break;
        [heap[i], heap[smallest]] = [heap[smallest], heap[i]];
        i = smallest;
      }
    }
    return top;
  }

  const visited = new Uint8Array(world.width * world.height);
  for (let x = 0; x < world.width; x++) {
    for (const y of [0, world.height - 1]) {
      const index = tileIndex(x, y);
      if (!visited[index]) {
        visited[index] = 1;
        heapPush({ x, y, level: Math.max(world.tiles[index].elevation, CFG.SEA_LEVEL) });
      }
    }
  }
  for (let y = 0; y < world.height; y++) {
    for (const x of [0, world.width - 1]) {
      const index = tileIndex(x, y);
      if (!visited[index]) {
        visited[index] = 1;
        heapPush({ x, y, level: Math.max(world.tiles[index].elevation, CFG.SEA_LEVEL) });
      }
    }
  }

  while (heap.length > 0) {
    const current = heapPop();
    const tile = getTile(current.x, current.y);
    tile.waterSurface = current.level;
    tile.pondingDepth = current.level - tile.elevation;

    for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      const nx = current.x + dx, ny = current.y + dy;
      const neighbor = getTile(nx, ny);
      if (!neighbor) continue;
      const index = tileIndex(nx, ny);
      if (visited[index]) continue;
      visited[index] = 1;
      // Tiny epsilon tilts filled flats toward their outlet so flow routing
      // never sees a perfectly level surface.
      heapPush({ x: nx, y: ny, level: Math.max(neighbor.elevation, current.level + 0.000002) });
    }
  }
}

function routeFlow() {
  const area = world.width * world.height;

  for (const tile of world.tiles) {
    const southness = tile.y / (world.height - 1);
    tile.flow = 0.4 + (1 - southness) * 0.8;
  }

  // The lowest northern-edge tile receives the discharge of the vast
  // catchment beyond the map — the Euphrates entering Sumer.
  let inlet = null;
  const inletMinX = Math.floor(world.width * 0.35);
  const inletMaxX = Math.floor(world.width * 0.65);
  for (let x = inletMinX; x <= inletMaxX; x++) {
    const tile = getTile(x, 0);
    if (!inlet || tile.waterSurface < inlet.waterSurface) inlet = tile;
  }
  inlet.flow += area * 0.6;

  const order = [...world.tiles].sort((a, b) => b.waterSurface - a.waterSurface);

  for (const tile of order) {
    // Stochastic slope-weighted choice among downhill neighbors is what
    // makes the channel meander instead of running straight down-gradient.
    const downhill = [];
    let totalWeight = 0;
    let steepest = 0;

    for (const [dx, dy] of NEIGHBORS_8) {
      const neighbor = getTile(tile.x + dx, tile.y + dy);
      if (!neighbor || neighbor.waterSurface >= tile.waterSurface) continue;
      const slope = (tile.waterSurface - neighbor.waterSurface) / Math.sqrt(dx * dx + dy * dy);
      const weight = slope * slope;
      downhill.push({ neighbor, slope, weight });
      totalWeight += weight;
      if (slope > steepest) steepest = slope;
    }

    if (downhill.length === 0) continue;

    let pick = random() * totalWeight;
    let chosen = downhill[downhill.length - 1];
    for (const option of downhill) {
      pick -= option.weight;
      if (pick <= 0) { chosen = option; break; }
    }

    // On near-flat ground a heavily loaded channel splits — distributaries
    // emerge in the delta; the noise gate keeps bifurcations discrete.
    const nearlyFlat = steepest < 0.0005 && tile.flow > area * 0.02;
    const alternates = downhill.filter((option) => option !== chosen);
    if (nearlyFlat && alternates.length > 0 && valueNoise(tile.x + 5000, tile.y + 5000, 17) > 0.58) {
      const second = alternates[Math.floor(random() * alternates.length)];
      chosen.neighbor.flow += tile.flow * 0.65;
      second.neighbor.flow += tile.flow * 0.35;
    } else {
      chosen.neighbor.flow += tile.flow;
    }
  }
}

function carveRivers() {
  const area = world.width * world.height;
  const riverThreshold = area * 0.02;
  const riverTiles = world.tiles.filter((tile) => tile.flow > riverThreshold);
  const leveeDeposit = new Map();

  for (const tile of riverTiles) {
    if (tile.waterSurface <= CFG.SEA_LEVEL + 0.0005) continue; // river ends at the sea

    const dischargeScale = Math.sqrt(tile.flow / (area * 0.6));
    const riverWidth = Math.max(1, Math.round(dischargeScale * (2.4 + valueNoise(tile.x, tile.y, 24) * 1.4)));
    const leveeDistance = riverWidth + 2;
    const bedElevation = tile.waterSurface - (0.018 + dischargeScale * 0.02);

    for (let dy = -leveeDistance; dy <= leveeDistance; dy++) {
      for (let dx = -leveeDistance; dx <= leveeDistance; dx++) {
        const target = getTile(tile.x + dx, tile.y + dy);
        if (!target) continue;
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance <= riverWidth) {
          target.terrain = "river";
          target.elevation = Math.min(target.elevation, bedElevation);
        } else if (distance <= leveeDistance) {
          const deposit = 0.012 + dischargeScale * 0.016;
          if (deposit > (leveeDeposit.get(target) ?? 0)) leveeDeposit.set(target, deposit);
        }
      }
    }
  }

  for (const [target, deposit] of leveeDeposit) {
    if (target.terrain === "river" || target.waterSurface <= CFG.SEA_LEVEL + 0.0005) continue;
    target.elevation += deposit;
  }
}

function computeRiverDistances() {
  const queue = [];
  for (const tile of world.tiles) {
    if (tile.terrain === "river") {
      tile.distanceToRiver = 0;
      queue.push(tile);
    } else {
      tile.distanceToRiver = Infinity;
    }
  }
  let head = 0;
  while (head < queue.length) {
    const tile = queue[head++];
    for (const [dx, dy] of NEIGHBORS_8) {
      const neighbor = getTile(tile.x + dx, tile.y + dy);
      if (!neighbor || neighbor.distanceToRiver !== Infinity) continue;
      neighbor.distanceToRiver = tile.distanceToRiver + 1;
      queue.push(neighbor);
    }
  }
}

function computeSeaDistances() {
  const queue = [];
  for (const tile of world.tiles) {
    if (tile.pondingDepth > 0 && tile.waterSurface <= CFG.SEA_LEVEL + 0.0005) {
      tile.distanceToSea = 0;
      queue.push(tile);
    } else {
      tile.distanceToSea = Infinity;
    }
  }
  let head = 0;
  while (head < queue.length) {
    const tile = queue[head++];
    for (const [dx, dy] of NEIGHBORS_8) {
      const neighbor = getTile(tile.x + dx, tile.y + dy);
      if (!neighbor || neighbor.distanceToSea !== Infinity) continue;
      neighbor.distanceToSea = tile.distanceToSea + 1;
      queue.push(neighbor);
    }
  }
}

function computePlumes() {
  // River discharge spreads into the sea as a freshwater plume whose reach
  // scales with the channel's actual flow.
  const area = world.width * world.height;
  const maxReach = world.height * 0.1;
  const queue = [];

  for (const tile of world.tiles) {
    tile.plumeReach = 0;
    if (tile.distanceToSea !== 0) continue;
    let mouthFlow = 0;
    for (const [dx, dy] of NEIGHBORS_8) {
      const neighbor = getTile(tile.x + dx, tile.y + dy);
      if (neighbor && neighbor.terrain === "river") mouthFlow = Math.max(mouthFlow, neighbor.flow);
    }
    if (mouthFlow === 0) continue;
    tile.plumeReach = maxReach * clamp(Math.sqrt(mouthFlow / (area * 0.6)), 0.1, 1);
    queue.push(tile);
  }

  let head = 0;
  while (head < queue.length) {
    const tile = queue[head++];
    for (const [dx, dy] of NEIGHBORS_8) {
      const neighbor = getTile(tile.x + dx, tile.y + dy);
      if (!neighbor || neighbor.distanceToSea !== 0) continue;
      const carried = tile.plumeReach - 1;
      if (carried <= neighbor.plumeReach) continue;
      neighbor.plumeReach = carried;
      queue.push(neighbor);
    }
  }
}

function computeSalinity() {
  // Salt rides with water and stays behind when water evaporates: marine
  // intrusion near the coast, concentrating terminal basins, capillary
  // wicking over shallow water tables — all pushed back by fresh flushing.
  computeSeaDistances();
  computePlumes();
  const area = world.width * world.height;

  for (const tile of world.tiles) {
    if (tile.terrain === "river") {
      const wedge = Math.pow(1 - clamp(tile.distanceToSea / (world.height * 0.05), 0, 1), 2);
      tile.salinity = clamp(0.02 + wedge * 0.55, 0, 1);
      continue;
    }

    if (tile.distanceToSea === 0) {
      const freshening = Math.pow(clamp(tile.plumeReach / (world.height * 0.1), 0, 1), 1.5);
      tile.salinity = clamp(1 - freshening * 0.8, 0, 1);
      continue;
    }

    const streamflow = clamp(tile.flow / (area * 0.015), 0, 1);
    const channelProximity = Math.pow(1 - clamp(tile.distanceToRiver / (world.height * 0.08), 0, 1), 2);
    const flush = clamp(streamflow + channelProximity, 0, 1);

    const reach = clamp(tile.distanceToSea / (world.height * 0.05), 0, 1);
    const head = 1 - clamp((tile.elevation - CFG.SEA_LEVEL) / 0.018, 0, 1);
    const marine = Math.pow(1 - reach, 2) * head;

    const inlandPond = tile.waterSurface > CFG.SEA_LEVEL + 0.0005;
    const basin = inlandPond ? clamp(tile.pondingDepth / 0.012, 0, 1) * 0.8 : 0;

    const waterTable = Math.pow(1 - clamp(tile.distanceToRiver / (world.height * 0.18), 0, 1), 1.6);
    const capillary = waterTable * 0.5;

    const salinityNoise = (layeredNoise(tile.x + 2700, tile.y + 2700) - 0.5) * 0.1;
    tile.salinity = clamp((marine + basin + capillary) * (1 - flush * 0.9) + salinityNoise, 0, 1);
  }
}

function applyMoistureAndFertility() {
  computeRiverDistances();
  computeSalinity();

  for (const tile of world.tiles) {
    if (tile.terrain === "river") {
      tile.moisture = 1;
      tile.fertility = 0.45;
      continue;
    }

    const ponded = clamp(tile.pondingDepth / 0.008, 0, 1);
    const streamflow = clamp(tile.flow / (world.width * world.height * 0.015), 0, 1);
    const seepage = Math.pow(1 - clamp(tile.distanceToRiver / (world.height * 0.18), 0, 1), 1.6);
    const moistureNoise = (layeredNoise(tile.x + 900, tile.y + 900) - 0.5) * 0.12;

    tile.moisture = clamp(ponded * 0.5 + streamflow * 0.3 + seepage * 0.55 + moistureNoise, 0, 1);

    const saltPenalty = clamp((tile.salinity - 0.15) / 0.6, 0, 1) * 0.85;
    tile.fertility = clamp(
      (tile.moisture * 0.8 + seepage * 0.18 + (layeredNoise(tile.x + 1800, tile.y + 1800) - 0.5) * 0.08) *
        (1 - saltPenalty),
      0, 1
    );

    if (tile.pondingDepth > 0.012) {
      tile.terrain = "water";
      tile.moisture = 1;
    } else if (tile.pondingDepth > 0.004 && tile.moisture > 0.55) {
      tile.terrain = "marsh";
    } else if (tile.pondingDepth > 0 && tile.waterSurface <= CFG.SEA_LEVEL + 0.0005) {
      tile.terrain = "water";
      tile.moisture = 1;
    } else if (tile.salinity > 0.78 && tile.pondingDepth < 0.004) {
      tile.terrain = "salt_flat";
    } else if (tile.moisture > 0.6 && tile.elevation < 0.51) {
      tile.terrain = "wet_floodplain";
    } else if (tile.fertility > 0.42) {
      tile.terrain = "fertile_silt";
    } else if (tile.moisture > 0.18) {
      tile.terrain = "dry_ground";
    } else {
      tile.terrain = "desert_scrub";
    }
  }
}

function isWaterTerrain(tile) {
  return tile.terrain === "river" || tile.terrain === "water";
}

function generateWorld() {
  world.tiles = [];
  for (let y = 0; y < world.height; y++) {
    for (let x = 0; x < world.width; x++) {
      world.tiles.push({
        x, y,
        elevation: generateElevation(x, y),
        moisture: 0, fertility: 0,
        distanceToRiver: Infinity, distanceToSea: Infinity,
        plumeReach: 0, salinity: 0,
        waterSurface: 0, pondingDepth: 0, flow: 0,
        terrain: "dry_ground",
        surfaceWater: 0, riverStage: 0,
        // flora fields, filled by flora.js
        grass: 0, grassCap: 0,
        scrub: 0, scrubCap: 0,
        reeds: 0, reedCap: 0,
        fish: 0, fishCap: 0,
      });
    }
  }

  fillDepressions();
  routeFlow();
  carveRivers();
  fillDepressions();
  applyMoistureAndFertility();
}
