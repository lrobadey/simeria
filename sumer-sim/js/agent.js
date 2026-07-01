// ── Adapa: the first human ──────────────────────────────────────────────
// One agent with needs (hunger, sleep), an inventory, and a goal he was
// never told how to reach: survive, then build a home. Body needs can interrupt
// him, but shelter comes from a remembered long-term project that breaks itself
// into daily intent and immediate action. Where the hut ends up is decided by
// scoring real tiles — not by us.

const SHELTER_REEDS_NEEDED = 24;
const SHELTER_WOOD_NEEDED = 10;
const SHELTER_BUILD_HOURS = 9;     // total work-hours of construction
const FIRE_WOOD_PER_NIGHT = 1;
const HUNGER_MEAL_THRESHOLD = 0.55;
const HUNGER_URGENT_THRESHOLD = 0.7;
const LAND_SIGHT_RADIUS = 18;
const LAND_MEMORY_FADE_DAYS = 45;

function createAgentMind() {
  return {
    longTermGoal: null,
    activeProject: null,
    dailyIntent: null,
    pressures: null,
    memory: {
      land: null,
      resources: { forage: [], reeds: [], wood: [] },
      shelterSites: [],
      failedTargets: [],
    },
  };
}

function createLandKnowledge() {
  const lastSeen = new Float32Array(world.width * world.height);
  lastSeen.fill(-1);
  return {
    width: world.width,
    height: world.height,
    lastSeen,
    knownCount: 0,
    lastObservedAt: -1,
  };
}

function ensureLandKnowledge() {
  const knowledge = agent.mind.memory.land;
  if (knowledge && knowledge.width === world.width && knowledge.height === world.height) {
    return knowledge;
  }
  agent.mind.memory.land = createLandKnowledge();
  return agent.mind.memory.land;
}

function observeLand(radius = LAND_SIGHT_RADIUS) {
  if (typeof world === "undefined" || !world.tiles.length) return null;
  const knowledge = ensureLandKnowledge();
  const day = currentAgentDay();
  const cx = Math.floor(agent.x);
  const cy = Math.floor(agent.y);
  const r2 = radius * radius;

  for (let y = Math.max(0, cy - radius); y <= Math.min(world.height - 1, cy + radius); y++) {
    for (let x = Math.max(0, cx - radius); x <= Math.min(world.width - 1, cx + radius); x++) {
      const dx = x + 0.5 - agent.x;
      const dy = y + 0.5 - agent.y;
      if (dx * dx + dy * dy > r2) continue;
      const i = tileIndex(x, y);
      if (knowledge.lastSeen[i] < 0) knowledge.knownCount++;
      knowledge.lastSeen[i] = day;
    }
  }

  knowledge.lastObservedAt = day;
  return knowledge;
}

function landMemoryFreshnessAt(x, y) {
  const knowledge = agent.mind.memory.land;
  if (!knowledge) return 0;
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  if (tx < 0 || ty < 0 || tx >= knowledge.width || ty >= knowledge.height) return 0;
  const lastSeen = knowledge.lastSeen[tileIndex(tx, ty)];
  if (lastSeen < 0) return 0;
  return clamp(1 - (currentAgentDay() - lastSeen) / LAND_MEMORY_FADE_DAYS, 0, 1);
}

function knowsLandAt(x, y) {
  return landMemoryFreshnessAt(x, y) > 0;
}

function knownTileScore(tile) {
  if (!tile) return 0;
  return landMemoryFreshnessAt(tile.x + 0.5, tile.y + 0.5);
}

const agent = {
  name: "Adapa",
  x: 0, y: 0,
  heading: 0,
  hunger: 0.3,        // 0 full → 1 starving
  energy: 0.9,        // 0 exhausted → 1 rested
  state: "idle",
  task: "Waking in a strange land",
  target: null,
  targetTree: null,
  stateUntil: 0,
  inventory: { food: 1.5, reeds: 0, wood: 0 },
  shelter: null,       // { x, y, progress 0..1, built, fireLit, fuel }
  alive: true,
  phase: 0,
  blockedTime: 0,      // game-days spent not moving during a goto
  avoid: [],           // places that proved unreachable: {x, y, until}
  mind: createAgentMind(),
};

function currentAgentDay() {
  return typeof sim === "undefined" ? 0 : sim.day;
}

function agentAvoids(x, y) {
  const day = currentAgentDay();
  const rememberedFailure = agent.mind.memory.failedTargets
    .some((p) => day < p.until && dist2(p.x, p.y, x, y) < 16);
  return rememberedFailure || agent.avoid.some((p) => day < p.until && dist2(p.x, p.y, x, y) < 16);
}

function rememberPlace(list, entry, radius = 4, limit = 16) {
  const day = currentAgentDay();
  let known = list.find((p) => dist2(p.x, p.y, entry.x, entry.y) <= radius * radius);
  if (!known) {
    known = {};
    list.push(known);
  }
  Object.assign(known, entry, { lastSeen: day, visits: (known.visits || 0) + 1 });
  list.sort((a, b) => (b.score || 0) - (a.score || 0));
  if (list.length > limit) list.length = limit;
  return known;
}

function memoryFreshness(entry, days) {
  return clamp(1 - (currentAgentDay() - entry.lastSeen) / days, 0, 1);
}

function rememberResource(kind, target, score, extra = {}) {
  const list = agent.mind.memory.resources[kind];
  if (!list) return null;
  return rememberPlace(list, {
    kind,
    x: target.x,
    y: target.y,
    score,
    target,
    ...extra,
  });
}

function rememberShelterSite(tile, score) {
  return rememberPlace(agent.mind.memory.shelterSites, {
    x: tile.x + 0.5,
    y: tile.y + 0.5,
    tile,
    score,
  }, 6, 10);
}

function rememberFailedTarget(target, reason) {
  const failed = { x: target.x, y: target.y, until: currentAgentDay() + 1, reason, score: 1 };
  agent.avoid.push(failed);
  if (agent.avoid.length > 10) agent.avoid.shift();
  rememberPlace(agent.mind.memory.failedTargets, failed, 4, 20);
}

function initAgent() {
  // He wakes on good ground near the river — the rest is up to him.
  let best = null, bestScore = -Infinity;
  for (const tile of world.tiles) {
    if (isWaterTerrain(tile) || tile.pondingDepth > 0.001) continue;
    const water = 1 - clamp(tile.distanceToRiver / 12, 0, 1);
    const green = tile.grassCap;
    const center = 1 - Math.abs(tile.y / world.height - 0.45) * 2;
    const score = water * 1.2 + green + center * 0.5 + random() * 0.2;
    if (score > bestScore) { bestScore = score; best = tile; }
  }
  agent.x = best.x + 0.5;
  agent.y = best.y + 0.5;
  agent.mind = createAgentMind();
  observeLand();
}

function agentSpeed() { return kmhToTilesPerDay(4); }

// ── Perception: scored searches over the world near him ────────────────

function rememberedForageTarget() {
  let best = null, bestScore = 0;
  for (const memory of agent.mind.memory.resources.forage) {
    const forage = memory.forage;
    if (!forage || agentAvoids(memory.x, memory.y)) continue;
    const landFreshness = landMemoryFreshnessAt(memory.x, memory.y);
    if (landFreshness <= 0) continue;
    if (forage.kind === "dates") {
      if (!forage.tree || forage.tree.removed || forage.tree.dead || forage.tree.fruit <= 0.03) continue;
    } else if (!forage.tile || forage.tile[forage.kind === "rhizomes" ? "reeds" : "grass"] <= 0.05) {
      continue;
    }
    const score = (memory.score || 0) * memoryFreshness(memory, 20) * landFreshness;
    if (score > bestScore) { best = forage; bestScore = score; }
  }
  return best;
}

function rememberedReedTarget() {
  let best = null, bestScore = 0;
  for (const memory of agent.mind.memory.resources.reeds) {
    const tile = memory.target;
    if (!tile || tile.reeds <= 0.06 || isWaterTerrain(tile) || agentAvoids(tile.x, tile.y)) continue;
    const landFreshness = knownTileScore(tile);
    if (landFreshness <= 0) continue;
    const score = tile.reeds * memoryFreshness(memory, 12) * landFreshness / (1 + Math.hypot(tile.x - agent.x, tile.y - agent.y) * 0.02);
    if (score > bestScore) { best = tile; bestScore = score; }
  }
  return best;
}

function rememberedWoodTarget() {
  let best = null, bestScore = 0;
  for (const memory of agent.mind.memory.resources.wood) {
    const tree = memory.target;
    if (!tree || tree.removed || agentAvoids(tree.x, tree.y)) continue;
    const landFreshness = landMemoryFreshnessAt(tree.x, tree.y);
    if (landFreshness <= 0) continue;
    const yieldScore = tree.dead ? tree.wood * 2 : (tree.species === "tamarisk" && treeIsMature(tree) ? 1 : 0);
    if (yieldScore <= 0) continue;
    const score = yieldScore * memoryFreshness(memory, 30) * landFreshness / (1 + Math.hypot(tree.x - agent.x, tree.y - agent.y) * 0.03);
    if (score > bestScore) { best = tree; bestScore = score; }
  }
  return best;
}

function rememberedShelterSite() {
  let best = null, bestScore = -Infinity;
  for (const memory of agent.mind.memory.shelterSites) {
    const tile = memory.tile;
    if (!tile || isWaterTerrain(tile) || tile.pondingDepth > 0 || agentAvoids(tile.x, tile.y)) continue;
    const landFreshness = knownTileScore(tile);
    if (landFreshness <= 0) continue;
    const score = (memory.score || 0) * memoryFreshness(memory, 60) * landFreshness -
      Math.hypot(tile.x - agent.x, tile.y - agent.y) * 0.01;
    if (score > bestScore) { best = tile; bestScore = score; }
  }
  return best;
}

// Once he has a hearth, work stays within a home range. Food a long walk from
// the hut is worth less than food at the doorstep — this is what keeps him from
// drifting across the floodplain and stranding himself, the way a real camp
// forages its surroundings and comes home each night.
function homeBias(x, y) {
  if (!(agent.shelter && agent.shelter.built)) return 1;
  const d = Math.hypot(x - agent.shelter.x, y - agent.shelter.y);
  return 1 / (1 + d * 0.045);
}

function findForageTarget() {
  // Candidate foods, each scored by yield over distance:
  //   ripe dates on mature palms · reed rhizomes in the marsh · grass seed
  // Local sweep first; if the country around him is bare he scans the
  // horizon and walks — subsistence here means following the food.
  const remembered = rememberedForageTarget();
  if (remembered) return remembered;

  for (const radius of [35, 140]) {
    const options = [];
    const distancePenalty = radius > 35 ? 0.008 : 0.06;

    for (const tree of treesNear(agent.x, agent.y, radius + 10)) {
      if (tree.removed || tree.dead || tree.species !== "palm") continue;
      const landFreshness = landMemoryFreshnessAt(tree.x, tree.y);
      if (landFreshness <= 0) continue;
      if (tree.fruit < 0.25 || agentAvoids(tree.x, tree.y)) continue;
      const d = Math.hypot(tree.x - agent.x, tree.y - agent.y);
      options.push({ kind: "dates", tree, x: tree.x, y: tree.y, score: tree.fruit * 3 * landFreshness * homeBias(tree.x, tree.y) / (1 + d * distancePenalty) });
    }

    // Sample tiles for rhizomes and seed rather than scanning the world.
    const samples = radius > 35 ? 240 : 60;
    for (let i = 0; i < samples; i++) {
      const angle = random() * Math.PI * 2;
      const r = random() * radius;
      const tile = getTileF(agent.x + Math.cos(angle) * r, agent.y + Math.sin(angle) * r);
      if (!tile || agentAvoids(tile.x, tile.y)) continue;
      const landFreshness = knownTileScore(tile);
      if (landFreshness <= 0) continue;
      if (tile.terrain === "marsh" && tile.reeds > 0.45) {
        options.push({ kind: "rhizomes", tile, x: tile.x + 0.5, y: tile.y + 0.5, score: tile.reeds * 1.2 * landFreshness * homeBias(tile.x, tile.y) / (1 + r * distancePenalty) });
      } else if (!isWaterTerrain(tile) && tile.grass > 0.6) {
        const dayOfYear = dayOfYearOf(sim.day);
        const seedSeason = dayOfYear > 110 && dayOfYear < 190 ? 1 : 0.25; // grain ripens early summer
        options.push({ kind: "grain", tile, x: tile.x + 0.5, y: tile.y + 0.5, score: tile.grass * seedSeason * landFreshness * homeBias(tile.x, tile.y) / (1 + r * distancePenalty) });
      }
    }

    options.sort((a, b) => b.score - a.score);
    if (options.length > 0) {
      rememberResource("forage", { x: options[0].x, y: options[0].y }, options[0].score, { forage: options[0] });
      return options[0];
    }
  }
  return null;
}

function findReedTarget() {
  // Local sweep first; failing that, he scans the horizon — on a plain
  // this flat the dark line of the reed marsh is visible from anywhere.
  const remembered = rememberedReedTarget();
  if (remembered) return remembered;

  for (const radius of [40, 130]) {
    let best = null, bestScore = 0.3;
    for (let i = 0; i < (radius > 40 ? 220 : 60); i++) {
      const angle = random() * Math.PI * 2;
      const r = random() * radius;
      const tile = getTileF(agent.x + Math.cos(angle) * r, agent.y + Math.sin(angle) * r);
      if (!tile || isWaterTerrain(tile) || agentAvoids(tile.x, tile.y)) continue;
      const landFreshness = knownTileScore(tile);
      if (landFreshness <= 0) continue;
      const score = tile.reeds * landFreshness / (1 + r * (radius > 40 ? 0.008 : 0.05));
      if (score > bestScore) { best = tile; bestScore = score; }
    }
    if (best) {
      rememberResource("reeds", best, bestScore);
      return best;
    }
  }
  return null;
}

function findWoodTarget() {
  const remembered = rememberedWoodTarget();
  if (remembered) return remembered;

  for (const radius of [50, 130]) {
    let best = null, bestScore = 0;
    for (const tree of treesNear(agent.x, agent.y, radius)) {
      if (tree.removed || agentAvoids(tree.x, tree.y)) continue;
      const landFreshness = landMemoryFreshnessAt(tree.x, tree.y);
      if (landFreshness <= 0) continue;
      const d = Math.hypot(tree.x - agent.x, tree.y - agent.y);
      // Deadwood is free fuel; a living tamarisk can spare branches slowly.
      const yieldScore = tree.dead ? tree.wood * 2 : (tree.species === "tamarisk" && treeIsMature(tree) ? 1 : 0);
      const score = yieldScore * landFreshness / (1 + d * 0.05);
      if (score > bestScore) { best = tree; bestScore = score; }
    }
    if (best) {
      rememberResource("wood", best, bestScore);
      return best;
    }
  }
  return null;
}

function chooseShelterSite() {
  // The decision that founds a settlement: dry feet, fresh water close,
  // food in reach, slightly raised against the flood.
  const remembered = rememberedShelterSite();
  if (remembered) return remembered;

  const knowledge = ensureLandKnowledge();
  let best = null, bestScore = -Infinity;
  for (let i = 0; i < knowledge.lastSeen.length; i++) {
    const lastSeen = knowledge.lastSeen[i];
    if (lastSeen < 0) continue;
    const landFreshness = clamp(1 - (currentAgentDay() - lastSeen) / LAND_MEMORY_FADE_DAYS, 0, 1);
    if (landFreshness <= 0) continue;
    const tile = world.tiles[i];
    if (isWaterTerrain(tile) || tile.pondingDepth > 0) continue;
    const d = Math.hypot(tile.x - agent.x, tile.y - agent.y);
    if (d > 50) continue;

    const waterProx = 1 - clamp((tile.distanceToRiver - 2) / 10, 0, 1);
    const tooClose = tile.distanceToRiver < 2 ? -2 : 0; // flood risk on the bank itself
    const raised = clamp((tile.elevation - CFG.SEA_LEVEL - 0.02) / 0.06, 0, 1);
    const treeFood = treesNear(tile.x, tile.y, 8).some((tree) => knowsLandAt(tree.x, tree.y)) ? 0.6 : 0;
    const food = tile.grassCap + tile.reedCap * 0.5 + treeFood;
    const fresh = 1 - tile.salinity;

    const score = (waterProx * 2 + raised * 1.2 + food + fresh + tooClose) * landFreshness - d * 0.01;
    if (score > bestScore) { bestScore = score; best = tile; }
  }
  if (best) rememberShelterSite(best, bestScore);
  return best;
}

function chooseKnownFrontierTarget() {
  const knowledge = ensureLandKnowledge();
  let best = null, bestScore = -Infinity;
  for (let i = 0; i < knowledge.lastSeen.length; i++) {
    const lastSeen = knowledge.lastSeen[i];
    if (lastSeen < 0) continue;
    const landFreshness = clamp(1 - (currentAgentDay() - lastSeen) / LAND_MEMORY_FADE_DAYS, 0, 1);
    if (landFreshness <= 0) continue;
    const tile = world.tiles[i];
    if (!tile || isWaterTerrain(tile) || tile.pondingDepth > 0 || agentAvoids(tile.x, tile.y)) continue;
    const d = Math.hypot(tile.x + 0.5 - agent.x, tile.y + 0.5 - agent.y);
    if (d < 8 || d > LAND_SIGHT_RADIUS * 1.8) continue;

    let unknownNeighbors = 0;
    for (const [dx, dy] of NEIGHBORS_8) {
      const nx = tile.x + dx;
      const ny = tile.y + dy;
      if (nx < 0 || ny < 0 || nx >= knowledge.width || ny >= knowledge.height) continue;
      if (knowledge.lastSeen[tileIndex(nx, ny)] < 0) unknownNeighbors++;
    }
    if (unknownNeighbors <= 0) continue;

    const water = 1 - clamp(tile.distanceToRiver / 14, 0, 1);
    const score = unknownNeighbors * 0.7 + water * 0.5 + landFreshness * 0.4 - d * 0.015 + random() * 0.1;
    if (score > bestScore) { best = tile; bestScore = score; }
  }
  return best;
}

function exploreKnownFrontier(task = "Walking the known edge") {
  const tile = chooseKnownFrontierTarget();
  if (!tile) return false;
  agent.state = "goto";
  agent.target = { x: tile.x + 0.5, y: tile.y + 0.5, then: "survey" };
  agent.task = task;
  agent.stateUntil = sim.day + 1;
  return true;
}

function findFishTarget() {
  // Fish gather in the shallows he can wade into — flood pools and the reed
  // marsh, not the open channel. Stand in the water and take what's there.
  let best = null, bestScore = 0.25;
  for (let i = 0; i < 90; i++) {
    const angle = random() * Math.PI * 2;
    const r = random() * 30;
    const tile = getTileF(agent.x + Math.cos(angle) * r, agent.y + Math.sin(angle) * r);
    if (!tile || !tile.fish || tile.fish < 0.3) continue;
    if (!animalCanEnter(AGENT_SPECIES, tile) || agentAvoids(tile.x, tile.y)) continue;
    const landFreshness = knownTileScore(tile);
    if (landFreshness <= 0) continue;
    const score = tile.fish * landFreshness * homeBias(tile.x, tile.y) / (1 + r * 0.05);
    if (score > bestScore) { best = tile; bestScore = score; }
  }
  return best;
}

function nearbyFishOpportunity() {
  // Cheap sense of whether fishable water is close — feeds the fish project's
  // score without committing to a full search every appraisal.
  let opportunity = 0;
  for (let i = 0; i < 28; i++) {
    const angle = random() * Math.PI * 2;
    const r = random() * 20;
    const tile = getTileF(agent.x + Math.cos(angle) * r, agent.y + Math.sin(angle) * r);
    if (!tile || !tile.fish || tile.fish < 0.3) continue;
    const landFreshness = knownTileScore(tile);
    if (landFreshness <= 0) continue;
    if (!animalCanEnter(AGENT_SPECIES, tile)) continue;
    opportunity = Math.max(opportunity, clamp(tile.fish, 0, 1) * landFreshness * (1 - r / 24));
  }
  return clamp(opportunity, 0, 1);
}

function findFrontierTarget() {
  // The pull of unseen country: cast rays outward and walk toward the
  // direction whose land he knows least (or has half-forgotten).
  const R = 30;
  let best = null, bestScore = -Infinity;
  for (let k = 0; k < 16; k++) {
    const angle = (k / 16) * Math.PI * 2 + random() * 0.2;
    const tx = clamp(agent.x + Math.cos(angle) * R, 1, world.width - 2);
    const ty = clamp(agent.y + Math.sin(angle) * R, 1, world.height - 2);
    const tile = getTileF(tx, ty);
    if (!tile || isWaterTerrain(tile) || agentAvoids(tile.x, tile.y)) continue;
    const stale = 1 - landMemoryFreshnessAt(tx, ty); // 1 = never seen
    if (stale > bestScore) { bestScore = stale; best = { x: tx, y: ty }; }
  }
  return best;
}

// ── The decision loop ───────────────────────────────────────────────────

function startEating(task) {
  agent.state = "eatMeal";
  agent.task = task;
  agent.stateUntil = sim.day + 1 / 96; // a 15-minute meal
}

function seekForage(forage, task) {
  agent.state = "goto";
  agent.target = { x: forage.x, y: forage.y, then: "forage", forage };
  agent.task = task || (forage.kind === "dates" ? "Walking to a date palm" :
    forage.kind === "rhizomes" ? "Wading toward the reed beds" : "Heading to seed grass");
}

function strongestPressure(pressures) {
  let best = { kind: "none", value: 0 };
  for (const [kind, value] of Object.entries(pressures)) {
    if (kind === "dominant" || kind === "context") continue;
    if (value > best.value) best = { kind, value };
  }
  return best;
}

function nearestPredatorPressure() {
  let pressure = 0;
  let nearest = null;
  for (const a of animals) {
    if (a.dead || !SPECIES[a.species].predator) continue;
    const d = Math.sqrt(dist2(agent.x, agent.y, a.x, a.y));
    if (d > 22) continue;
    const p = clamp(1 - d / 22, 0, 1);
    if (p > pressure) {
      pressure = p;
      nearest = { species: a.species, distance: d, x: a.x, y: a.y };
    }
  }
  return { pressure, nearest };
}

function nearbyOpportunityPressure() {
  let forage = 0;
  let prey = 0;
  let wood = 0;

  for (const memory of agent.mind.memory.resources.forage) {
    const landFreshness = landMemoryFreshnessAt(memory.x, memory.y);
    if (landFreshness > 0) {
      forage = Math.max(forage, (memory.score || 0) * memoryFreshness(memory, 16) * landFreshness);
    }
  }
  for (const tree of treesNear(agent.x, agent.y, 18)) {
    const landFreshness = landMemoryFreshnessAt(tree.x, tree.y);
    if (landFreshness <= 0) continue;
    if (tree.removed || tree.dead) {
      wood = Math.max(wood, (tree.wood || 0) * landFreshness);
      continue;
    }
    if (tree.species === "palm") forage = Math.max(forage, tree.fruit * 1.4 * landFreshness);
    if (tree.species === "tamarisk" && treeIsMature(tree)) wood = Math.max(wood, 0.5 * landFreshness);
  }
  for (const a of animals) {
    if (a.dead || !SPECIES[a.species].prey) continue;
    const d = Math.sqrt(dist2(agent.x, agent.y, a.x, a.y));
    if (d < 16) prey = Math.max(prey, 1 - d / 16);
  }

  return {
    forage: clamp(forage, 0, 1),
    prey: clamp(prey, 0, 1),
    wood: clamp(wood / 3, 0, 1),
  };
}

function assessPressures() {
  const inv = agent.inventory;
  const tile = getTileF(agent.x, agent.y);
  const sun = sunAltitude(sim.day);
  const dark = nightness(sim.day);
  const builtShelter = !!(agent.shelter && agent.shelter.built);
  const shelterDistance = builtShelter ? Math.hypot(agent.x - agent.shelter.x, agent.y - agent.shelter.y) : Infinity;
  const awayFromShelter = builtShelter && shelterDistance > 3;
  const floodDepth = tile ? liveWaterDepth(tile) : 0;
  const predator = nearestPredatorPressure();
  const opportunity = nearbyOpportunityPressure();
  const known = agent.mind.memory.resources;
  const project = agent.mind.activeProject;
  const shelterNeed = project && project.kind === "buildShelter" && project.needed ?
    project.needed : { reeds: SHELTER_REEDS_NEEDED, wood: SHELTER_WOOD_NEEDED };
  const reedGap = clamp((shelterNeed.reeds - inv.reeds) / SHELTER_REEDS_NEEDED, 0, 1);
  const woodGap = clamp((shelterNeed.wood - inv.wood) / SHELTER_WOOD_NEEDED, 0, 1);
  const foodScarcity = clamp((2.5 - inv.food) / 2.5, 0, 1);
  const knownFood = known.forage.length > 0 ? 0 : 0.35;
  const knownMaterials = (known.reeds.length > 0 ? 0 : 0.18) + (known.wood.length > 0 ? 0 : 0.18);
  const blocked = clamp(agent.mind.memory.failedTargets.filter((p) => currentAgentDay() < p.until).length / 4, 0, 1);
  const forageMemoryAge = known.forage.length
    ? Math.min(...known.forage.map((p) => currentAgentDay() - p.lastSeen))
    : Infinity;

  const pressures = {
    hunger: clamp(agent.hunger * 0.8 + foodScarcity * 0.35 - opportunity.forage * 0.18, 0, 1),
    fatigue: clamp((1 - agent.energy) * 0.9 + dark * 0.25 + (awayFromShelter ? 0.12 : 0), 0, 1),
    exposure: clamp((builtShelter ? 0 : 0.32) + dark * (builtShelter ? 0.08 : 0.25) +
      clamp(floodDepth / 0.008, 0, 1) * 0.35 + (awayFromShelter ? 0.12 : 0), 0, 1),
    scarcity: clamp(Math.max(foodScarcity, reedGap * 0.7, woodGap * 0.6) + knownFood + knownMaterials + blocked * 0.2, 0, 1),
    risk: clamp(predator.pressure * 0.8 + dark * 0.35 + clamp(floodDepth / 0.012, 0, 1) * 0.35, 0, 1),
    opportunity: clamp(Math.max(opportunity.forage, opportunity.wood, opportunity.prey * 0.75), 0, 1),
    capability: clamp(inv.food / 3 * 0.3 + inv.wood / 6 * 0.25 + inv.reeds / 24 * 0.25 +
      (builtShelter ? 0.2 : 0), 0, 1),
    curiosity: clamp((forageMemoryAge === Infinity ? 0.35 : clamp(forageMemoryAge / 25, 0, 0.35)) +
      knownFood + blocked * 0.45, 0, 1),
  };

  pressures.dominant = strongestPressure(pressures);
  pressures.context = {
    dark,
    floodDepth,
    shelterDistance,
    predator: predator.nearest,
    opportunities: opportunity,
    blocked,
  };
  agent.mind.pressures = pressures;
  return pressures;
}

function createBuildShelterProject() {
  return {
    kind: "buildShelter",
    status: "active",
    priority: 1,
    startedAt: currentAgentDay(),
    updatedAt: currentAgentDay(),
    phase: "prepare",
    site: null,
    progress: 0,
    needed: { reeds: SHELTER_REEDS_NEEDED, wood: SHELTER_WOOD_NEEDED },
    blockers: [],
  };
}

const PROJECT_HANDLERS = {};

function registerProjectHandler(handler) {
  PROJECT_HANDLERS[handler.kind] = handler;
  return handler;
}

function projectHandlerFor(kind) {
  return PROJECT_HANDLERS[kind] || null;
}

function setLongTermGoal(kind, reason) {
  const goal = agent.mind.longTermGoal;
  if (!goal || goal.kind !== kind) {
    agent.mind.longTermGoal = { kind, reason, since: currentAgentDay() };
  } else {
    goal.reason = reason;
  }
}

function setDailyIntent(project, kind, detail = {}) {
  const day = Math.floor(currentAgentDay());
  const intent = {
    day,
    project: project.kind,
    kind,
    detail,
    setAt: currentAgentDay(),
  };
  agent.mind.dailyIntent = intent;
  project.intent = intent;
  project.phase = kind;
  project.updatedAt = currentAgentDay();
}

function completeProject(project) {
  if (!project) return;
  project.status = "complete";
  project.progress = 1;
  project.updatedAt = currentAgentDay();
}

function completeActiveProject(kind) {
  if (agent.mind.activeProject && agent.mind.activeProject.kind === kind) {
    completeProject(agent.mind.activeProject);
  }
}

// ── Scoring spine ───────────────────────────────────────────────────────
// Every project answers the same question with the same arithmetic:
//   score = Σ(pressure answered) + opportunity + readiness − cost − risk
// Each term is named so the glass-mind panel can show exactly why a project
// won. The active project persists while it stays within a margin of the
// best challenger (hysteresis) so Adapa commits instead of dithering.

const SWITCH_MARGIN = 0.12;     // a challenger must lead the active by this to win
const SWITCH_LOG_GAP = 0.3;     // game-days between narrated project switches

function scored(terms) {
  let value = 0;
  for (const k in terms) value += terms[k];
  return { value, terms };
}

function dominantTerm(terms) {
  let name = "need", value = -Infinity;
  for (const k in terms) {
    if (terms[k] > value) { value = terms[k]; name = k; }
  }
  return { name, value };
}

function genericProject(kind) {
  return { kind, status: "active", startedAt: currentAgentDay(), progress: 0, blockers: [] };
}

function rankProjects(pressures) {
  const ranked = [];
  for (const handler of Object.values(PROJECT_HANDLERS)) {
    if (handler.isComplete && handler.isComplete()) continue;
    const s = handler.score(pressures);
    if (!s) continue;
    ranked.push({
      kind: handler.kind,
      label: handler.label || handler.kind,
      handler,
      value: s.value,
      terms: s.terms,
    });
  }
  ranked.sort((a, b) => b.value - a.value);
  return ranked;
}

function projectFor(handler) {
  // Reuse the live project object when the kind is unchanged so progress and
  // accumulated state (the half-built hut, gathered materials) carry over.
  const active = agent.mind.activeProject;
  if (active && active.kind === handler.kind && active.status !== "complete") return active;
  return handler.create ? handler.create() : genericProject(handler.kind);
}

function pursueProject(project) {
  const handler = projectHandlerFor(project.kind);
  return !!(handler && handler.pursue && handler.pursue(project));
}

function maybeNarrateSwitch(cand) {
  const day = currentAgentDay();
  if (agent.mind.lastSwitchLogAt != null && day - agent.mind.lastSwitchLogAt < SWITCH_LOG_GAP) return;
  agent.mind.lastSwitchLogAt = day;
  const reason = dominantTerm(cand.terms).name;
  logEvent(`${agent.name} turns to ${cand.label.toLowerCase()} — ${reason} weighs heaviest.`, "agent");
}

function commitToProject(cand, previousKind, ranked) {
  agent.mind.projectScores = ranked.map((r) => ({
    kind: r.kind, label: r.label, value: r.value, terms: r.terms, active: r.kind === cand.kind,
  }));
  agent.mind.activeProjectKind = cand.kind;
  setLongTermGoal(cand.kind, cand.label);
  if (previousKind !== null && previousKind !== cand.kind) {
    agent.mind.lastSwitch = {
      from: previousKind, to: cand.kind, reason: dominantTerm(cand.terms).name,
      value: cand.value, at: currentAgentDay(),
    };
    maybeNarrateSwitch(cand);
  }
}

function pursueBuildShelterProject(project) {
  const inv = agent.inventory;
  project.blockers = [];
  project.progress = agent.shelter ? agent.shelter.progress : 0;

  if (agent.shelter && !agent.shelter.built) {
    project.site = { x: agent.shelter.x, y: agent.shelter.y };
    setDailyIntent(project, "build", { site: project.site });
    agent.state = "goto";
    agent.target = { x: agent.shelter.x, y: agent.shelter.y, then: "build" };
    agent.task = "Returning to the building site";
    return true;
  }

  if (inv.reeds < project.needed.reeds) {
    const reedTile = findReedTarget();
    if (reedTile) {
      setDailyIntent(project, "gatherReeds", {
        x: reedTile.x + 0.5,
        y: reedTile.y + 0.5,
        have: inv.reeds,
        need: project.needed.reeds,
      });
      agent.state = "goto";
      agent.target = { x: reedTile.x + 0.5, y: reedTile.y + 0.5, then: "cutReeds" };
      agent.task = "Going to cut reeds";
      return true;
    }
    project.blockers.push("noKnownReeds");
  }

  if (inv.wood < project.needed.wood) {
    const tree = findWoodTarget();
    if (tree) {
      setDailyIntent(project, "gatherWood", {
        x: tree.x,
        y: tree.y,
        have: inv.wood,
        need: project.needed.wood,
      });
      agent.state = "goto";
      agent.targetTree = tree;
      agent.target = { x: tree.x, y: tree.y, then: "gatherWood" };
      agent.task = "Going to gather wood";
      return true;
    }
    project.blockers.push("noKnownWood");
  }

  if (inv.reeds >= project.needed.reeds && inv.wood >= project.needed.wood) {
    const site = chooseShelterSite();
    if (site) {
      project.site = { x: site.x + 0.5, y: site.y + 0.5 };
      setDailyIntent(project, "chooseSite", {
        x: project.site.x,
        y: project.site.y,
      });
      agent.shelter = { x: project.site.x, y: project.site.y, progress: 0, built: false, fireLit: false, fuel: 0 };
      agent.state = "goto";
      agent.target = { x: agent.shelter.x, y: agent.shelter.y, then: "build" };
      agent.task = "Carrying materials to the chosen ground";
      logEvent(`${agent.name} chose a place for his house near ${describePlace(site.x, site.y)}.`, "agent");
      return true;
    }
    project.blockers.push("noShelterSite");
  }

  if (project.blockers.length > 0) {
    const task = project.blockers.includes("noKnownReeds") ? "Searching the known edge for reeds" :
      project.blockers.includes("noKnownWood") ? "Searching the known edge for wood" :
      "Searching the known edge for a building site";
    if (exploreKnownFrontier(task)) {
      setDailyIntent(project, "explore", { blockers: project.blockers.slice() });
      return true;
    }
  }

  return false;
}

registerProjectHandler({
  kind: "buildShelter",
  label: "Build shelter",
  goal: { kind: "buildShelter", reason: "Make a safer place to sleep" },
  maintenanceGoal: { kind: "maintainHome", reason: "Keep the first shelter useful" },
  isComplete() {
    return !!(agent.shelter && agent.shelter.built);
  },
  score(p) {
    const c = p.context;
    const progress = agent.shelter ? agent.shelter.progress : 0;
    return scored({
      exposure: p.exposure * 1.0,
      scarcity: p.scarcity * 0.15,
      commit: progress * 0.5,           // finish what you started
      night: -c.dark * 0.7,             // no building in the dark
      hungry: -p.hunger * 0.5,          // don't raise a roof on an empty belly
    });
  },
  create: createBuildShelterProject,
  pursue: pursueBuildShelterProject,
});

// ── Forage: answer hunger and a thin larder ─────────────────────────────
function pursueForageProject() {
  const forage = findForageTarget();
  if (!forage) return false;
  seekForage(forage, agent.shelter && agent.shelter.built ? "Foraging to stock the larder" : null);
  return true;
}

registerProjectHandler({
  kind: "forage",
  label: "Forage",
  goal: { kind: "forage", reason: "Keep fed" },
  score(p) {
    const c = p.context;
    const food = agent.inventory.food;
    const safe = clamp((3 - food) / 3, 0, 1);       // 1 when empty, 0 once ~3 stored
    const sated = clamp(food / 4, 0, 1);            // full larder kills the urge
    const need = clamp(p.hunger + safe - 0.3, 0, 1); // how pressing food is
    return scored({
      hunger: p.hunger * 0.5,
      larder: safe * 0.8,                           // hold a buffer before anything optional
      urgent: need * need * 0.6,                    // ramps hard, hungry and empty
      opportunity: c.opportunities.forage * 0.2 * safe,
      sated: -sated * 0.35,
      night: -c.dark * 0.55 * (1 - need * 0.5),     // sleep through the dark unless famine
    });
  },
  pursue: pursueForageProject,
});

// ── Fish: take food from wadeable shallows when they're rich ────────────
function pursueFishProject() {
  const tile = findFishTarget();
  if (!tile) return false;
  agent.state = "goto";
  agent.target = { x: tile.x + 0.5, y: tile.y + 0.5, then: "fish" };
  agent.task = "Wading out to fish";
  return true;
}

registerProjectHandler({
  kind: "fish",
  label: "Fish",
  goal: { kind: "fish", reason: "Take fish from the shallows" },
  score(p) {
    const c = p.context;
    const opportunity = nearbyFishOpportunity();
    if (opportunity <= 0) return null;
    const food = agent.inventory.food;
    const safe = clamp((3 - food) / 3, 0, 1);
    return scored({
      hunger: p.hunger * 0.5,
      larder: safe * 0.75 * opportunity,          // a reliable larder when forage thins
      opportunity: opportunity * 0.3,
      sated: -clamp(food / 4, 0, 1) * 0.3,
      night: -c.dark * 0.55 * (1 - safe * 0.5),
    });
  },
  pursue: pursueFishProject,
});

// ── Rest: sleep through the dark and the body's exhaustion ───────────────
function pursueRestProject() {
  const inv = agent.inventory;
  // Too spent to travel: drop where he stands rather than chase a far hearth
  // he may not even reach. Otherwise he heads home, so he never drifts far.
  const exhausted = agent.energy < 0.15;
  if (agent.shelter && agent.shelter.built && !exhausted) {
    const d = Math.hypot(agent.x - agent.shelter.x, agent.y - agent.shelter.y);
    if (d > 1) {
      agent.state = "goto";
      agent.target = { x: agent.shelter.x, y: agent.shelter.y, then: "sleep" };
      agent.task = "Heading home to rest";
      return true;
    }
    if (!agent.shelter.fireLit && nightness(sim.day) > 0.2 && inv.wood >= FIRE_WOOD_PER_NIGHT) {
      inv.wood -= FIRE_WOOD_PER_NIGHT;
      agent.shelter.fireLit = true;
      agent.shelter.fuel = 1;
      logEvent(`${agent.name} lit the hearth fire.`, "agent");
    }
  }
  agent.state = "sleep";
  agent.task = agent.shelter && agent.shelter.built ? "Sleeping by the hearth" : "Sleeping under the open sky";
  agent.stateUntil = sim.day + 0.05;
  return true;
}

registerProjectHandler({
  kind: "rest",
  label: "Rest",
  goal: { kind: "rest", reason: "Recover strength" },
  score(p) {
    const c = p.context;
    // Below a fifth of full, the body simply gives out — rest overrides almost
    // everything, the way exhaustion forces sleep on a real animal.
    const collapse = clamp((0.2 - agent.energy) / 0.2, 0, 1) * 1.2;
    return scored({
      fatigue: p.fatigue * 1.0,
      collapse,
      night: c.dark * 0.55,
      daycost: -(1 - c.dark) * 0.15,    // resting in daylight wastes good light
    });
  },
  pursue: pursueRestProject,
});

// ── Gather fuel: keep the hearth fed once there's a hearth ──────────────
function pursueGatherFuelProject() {
  const tree = findWoodTarget();
  if (!tree) return false;
  agent.state = "goto";
  agent.targetTree = tree;
  agent.target = { x: tree.x, y: tree.y, then: "gatherWood" };
  agent.task = "Gathering firewood";
  return true;
}

registerProjectHandler({
  kind: "gatherFuel",
  label: "Gather fuel",
  goal: { kind: "gatherFuel", reason: "Keep the hearth burning" },
  score(p) {
    const c = p.context;
    const built = agent.shelter && agent.shelter.built;
    if (!built) return null;
    const woodNeed = clamp((4 - agent.inventory.wood) / 4, 0, 1);
    if (woodNeed <= 0) return null;
    return scored({
      cold: woodNeed * (0.4 + c.dark * 0.3),
      opportunity: c.opportunities.wood * 0.2,
      night: -c.dark * 0.5,
    });
  },
  pursue: pursueGatherFuelProject,
});

// ── Explore: the pull of unseen country ─────────────────────────────────
function pursueExploreProject() {
  const target = findFrontierTarget();
  if (!target) return false;
  agent.state = "goto";
  agent.target = { x: target.x, y: target.y, then: "survey" };
  agent.task = "Walking out to learn the land";
  return true;
}

registerProjectHandler({
  kind: "explore",
  label: "Explore",
  goal: { kind: "explore", reason: "Learn the land" },
  score(p) {
    const c = p.context;
    const stock = clamp(agent.inventory.food / 3, 0, 1); // only roam on a full larder
    return scored({
      curiosity: p.curiosity * 0.45 * stock,
      scarcity: p.scarcity * 0.15,
      larderGate: -(1 - stock) * 0.5,   // never wander off hungry
      night: -c.dark * 0.6,
      hungry: -p.hunger * 0.4,
      restless: -0.05,                  // the lowest-priority filler
    });
  },
  pursue: pursueExploreProject,
});

// ── Relocate: abandon ground that keeps failing ─────────────────────────
registerProjectHandler({
  kind: "relocate",
  label: "Move camp",
  goal: { kind: "relocate", reason: "Find better ground" },
  score(p) {
    if (!(agent.shelter && agent.shelter.built)) return null;
    const home = getTileF(agent.shelter.x, agent.shelter.y);
    const homeFlood = home ? clamp(liveWaterDepth(home) / 0.01, 0, 1) : 0;
    const trigger = Math.max(homeFlood, p.context.blocked * 0.5);
    if (trigger < 0.5) return null;
    return scored({
      exposure: p.exposure * 0.6,
      scarcity: p.scarcity * 0.3,
      failing: trigger * 0.5,
    });
  },
  pursue() {
    // Walk away from the doomed ground; forgetting the old site lets the
    // build project found a new home elsewhere.
    logEvent(`${agent.name} abandons his house — the ground keeps failing him.`, "agent");
    agent.shelter = null;
    agent.mind.memory.shelterSites = [];
    return false; // hand off to buildShelter, which now scores high again
  },
});

const FLEE_RADIUS = 9;

// Eat from the pack — a reflex, above deliberation, like an animal's "flee >
// drink > eat" prefix. Acquiring food is a scored project; swallowing is not.
function eatReflex(urgent) {
  if (agent.state === "eatMeal") return false;
  const threshold = urgent ? HUNGER_URGENT_THRESHOLD : HUNGER_MEAL_THRESHOLD;
  if (agent.hunger > threshold && agent.inventory.food > 0) {
    startEating(urgent ? "Eating from the pack" : "Eating");
    return true;
  }
  return false;
}

// Imminent danger overrides everything: drop the errand and run.
function answerDanger(pressures) {
  const threat = pressures.context.predator;
  if (!threat || threat.distance > FLEE_RADIUS) return false;
  // The hut is refuge: safe at his own hearth, he stays put and lets the
  // beast prowl rather than bolting in and out all night.
  if (agent.shelter && agent.shelter.built &&
      Math.hypot(agent.x - agent.shelter.x, agent.y - agent.shelter.y) < 2.5) return false;
  if (agent.state === "flee" && agent.target) { agent.fleeFrom = threat; return true; }

  let dx = agent.x - threat.x, dy = agent.y - threat.y;
  const d = Math.hypot(dx, dy) || 1;
  dx /= d; dy /= d;
  // Run for the hearth if home lies away from the threat; else straight away.
  let tx = agent.x + dx * 14, ty = agent.y + dy * 14;
  if (agent.shelter && agent.shelter.built) {
    const hx = agent.shelter.x - agent.x, hy = agent.shelter.y - agent.y;
    if (hx * dx + hy * dy > 0) { tx = agent.shelter.x; ty = agent.shelter.y; }
  }
  agent.state = "flee";
  agent.fleeFrom = threat;
  agent.target = {
    x: clamp(tx, 1, world.width - 1),
    y: clamp(ty, 1, world.height - 1),
    then: "survey",
  };
  agent.task = `Fleeing a ${threat.species}`;
  const day = currentAgentDay();
  if (agent.mind.activeProjectKind !== "flee" &&
      (agent.mind.lastFleeLogAt == null || day - agent.mind.lastFleeLogAt > 0.1)) {
    agent.mind.lastFleeLogAt = day;
    logEvent(`${agent.name} flees a ${threat.species}.`, "agent");
  }
  agent.mind.activeProjectKind = "flee";
  return true;
}

function agentIdle() {
  agent.state = "idle";
  agent.task = agent.shelter && agent.shelter.built ? "Resting at home" : "Surveying the land";
  agent.stateUntil = sim.day + 0.02 + random() * 0.03;
  agent.mind.activeProjectKind = agent.shelter && agent.shelter.built ? "rest" : "explore";
}

// Sense → appraise → compete → act. Pressures decide; the ladder is gone.
// updateAgent refreshes pressures every substep, so reuse them when fresh.
function decideAgent() {
  const pressures = agent.mind.pressures || assessPressures();

  // Reflexes sit above the appraisal so survival never waits on deliberation.
  if (answerDanger(pressures)) return;
  if (eatReflex(false)) return;

  const ranked = rankProjects(pressures);
  if (ranked.length === 0) { agentIdle(); return; }

  const previousKind = agent.mind.activeProject && agent.mind.activeProject.status !== "complete"
    ? agent.mind.activeProject.kind : null;

  // Hysteresis: keep the running project unless a challenger clearly beats it.
  let intended = ranked[0];
  if (previousKind) {
    const active = ranked.find((r) => r.kind === previousKind);
    if (active && ranked[0].value - active.value < SWITCH_MARGIN) intended = active;
  }

  // Try the chosen project; if it can't find a target right now, fall through
  // to the next best that can. A blocked project records why.
  const order = [intended, ...ranked.filter((r) => r !== intended)];
  for (const cand of order) {
    const project = projectFor(cand.handler);
    if (pursueProject(project)) {
      agent.mind.activeProject = project;
      commitToProject(cand, previousKind, ranked);
      return;
    }
    cand.blocked = true;
  }

  agent.mind.projectScores = ranked.map((r) => ({
    kind: r.kind, label: r.label, value: r.value, terms: r.terms, active: false, blocked: r.blocked,
  }));
  agentIdle();
}

const AGENT_SPECIES = { wades: true }; // he can wade a lagoon, not the river

function updateAgent(dtDays) {
  if (!agent.alive) return;
  observeLand();
  agent.hunger = clamp(agent.hunger + dtDays * 0.5, 0, 1.2);
  if (agent.state !== "sleep") agent.energy = clamp(agent.energy - dtDays * 0.65, 0, 1);
  assessPressures();

  // Exhaustion forces sleep wherever he stands.
  if (agent.energy <= 0.03 && agent.state !== "sleep") {
    agent.state = "sleep";
    agent.task = "Collapsed from exhaustion";
    agent.stateUntil = sim.day + 0.05;
  }

  // Reflexive interrupts, above the appraisal loop. Eat from the pack the
  // instant hunger bites; a predator inside flight range scatters any errand.
  if (agent.hunger > HUNGER_URGENT_THRESHOLD && agent.inventory.food > 0) {
    eatReflex(true);
  }
  const threat = agent.mind.pressures.context.predator;
  const fleeNow = threat && threat.distance < FLEE_RADIUS && agent.state !== "flee";
  const starvingIdle = agent.hunger > HUNGER_URGENT_THRESHOLD && agent.inventory.food <= 0 &&
    agent.state !== "forage" && agent.state !== "fish" &&
    !(agent.target && (agent.target.then === "forage" || agent.target.then === "fish"));
  if (fleeNow || starvingIdle) decideAgent();

  if (agent.hunger >= 1.2 && !(agent.state === "eatMeal" && agent.inventory.food > 0)) {
    agent.alive = false;
    agent.task = "Dead of hunger";
    logEvent(`${agent.name} has starved. The land keeps no mourners.`, "death");
    return;
  }

  if (sim.day >= agent.stateUntil && ["idle", "sleep", "eatMeal"].includes(agent.state)) {
    decideAgent();
  }

  switch (agent.state) {
    case "goto": {
      const t = agent.target;
      if (!t) { decideAgent(); break; }
      // Track real progress *toward the target*, not just any movement. A
      // straight walker on a delta slides along a lagoon bank — moving, but
      // never getting closer. If the gap to the target stops shrinking, the
      // route is blocked: write the place off and choose differently.
      if (agent.gotoRef !== t) { agent.gotoRef = t; agent.gotoBest = Infinity; agent.blockedTime = 0; }
      const arrived = moveToward(agent, AGENT_SPECIES, t.x, t.y, agentSpeed(), dtDays);
      const d2 = dist2(agent.x, agent.y, t.x, t.y);
      if (d2 < agent.gotoBest - 0.05) {
        agent.gotoBest = d2;
        agent.blockedTime = 0;
      } else if (!arrived) {
        agent.blockedTime += dtDays;
        if (agent.blockedTime > 0.012) { // ~17 game-minutes of no progress
          agent.blockedTime = 0;
          rememberFailedTarget(t, "blocked");
          agent.target = null;
          decideAgent();
          break;
        }
      }
      if (arrived) {
        const then = t.then;
        agent.state = then;
        agent.stateUntil = sim.day + 1; // work states end themselves
        if (then === "forage") agent.forage = t.forage;
        if (then === "sleep") { agent.stateUntil = sim.day + 0.01; decideAgent(); }
        if (then === "survey") { decideAgent(); }
      }
      break;
    }

    case "sleep": {
      const recovery = agent.shelter && agent.shelter.built &&
        Math.hypot(agent.x - agent.shelter.x, agent.y - agent.shelter.y) < 2 ? 1.4 : 0.9;
      agent.energy = clamp(agent.energy + dtDays * 2.2 * recovery, 0, 1);
      const sun = sunAltitude(sim.day);
      if (sun > 0.02 && agent.energy > 0.55) {
        if (agent.mind.lastRoseAt == null || currentAgentDay() - agent.mind.lastRoseAt > 0.4) {
          agent.mind.lastRoseAt = currentAgentDay();
          logEvent(`${agent.name} rose with the sun.`, "agent");
        }
        decideAgent();
      }
      break;
    }

    case "eatMeal": {
      const bite = Math.min(agent.inventory.food, dtDays * 18);
      agent.inventory.food -= bite;
      agent.hunger = clamp(agent.hunger - bite * 0.45, 0, 1.2);
      if (agent.hunger <= 0.08 || agent.inventory.food <= 0) decideAgent();
      break;
    }

    case "forage": {
      const f = agent.forage;
      if (!f) { decideAgent(); break; }
      rememberResource("forage", { x: f.x, y: f.y }, f.score || 1, { forage: f });
      const workRate = dtDays * 24; // hours of work
      if (f.kind === "dates") {
        if (f.tree.removed || f.tree.dead || f.tree.fruit <= 0.03) { decideAgent(); break; }
        const picked = Math.min(f.tree.fruit, workRate * 0.35);
        f.tree.fruit -= picked;
        agent.inventory.food += picked * 5; // dates are calorie-dense
        if (agent.inventory.food > 4 || f.tree.fruit <= 0.03) {
          agent.task = "Picked dates";
          decideAgent();
        }
      } else {
        const tile = f.tile;
        const field = f.kind === "rhizomes" ? "reeds" : "grass";
        if (tile[field] <= 0.05) { decideAgent(); break; }
        const dug = Math.min(tile[field], workRate * 0.3);
        tile[field] -= dug;
        agent.inventory.food += dug * (f.kind === "rhizomes" ? 1.6 : 1.1);
        if (agent.inventory.food > 3) decideAgent();
      }
      break;
    }

    case "cutReeds": {
      const tile = getTileF(agent.x, agent.y);
      if (!tile || tile.reeds <= 0.06) { decideAgent(); break; }
      rememberResource("reeds", tile, tile.reeds);
      const cut = Math.min(tile.reeds, dtDays * 24 * 0.25);
      tile.reeds -= cut;
      agent.inventory.reeds += cut * 28; // a tile's worth of reeds is many bundles
      agent.task = "Cutting reeds";
      if (agent.inventory.reeds >= SHELTER_REEDS_NEEDED) {
        logEvent(`${agent.name} has cut enough reeds for a house.`, "agent");
        decideAgent();
      }
      break;
    }

    case "gatherWood": {
      const tree = agent.targetTree;
      if (!tree || tree.removed) { agent.targetTree = null; decideAgent(); break; }
      rememberResource("wood", tree, tree.dead ? tree.wood * 2 : 1);
      const rate = tree.dead ? 1.4 : 0.45; // deadwood breaks free easily
      const take = dtDays * 24 * rate;
      if (tree.dead) {
        const got = Math.min(tree.wood, take);
        tree.wood -= got;
        agent.inventory.wood += got;
        if (tree.wood <= 0) tree.removed = true;
      } else {
        agent.inventory.wood += take;
      }
      agent.task = "Gathering wood";
      if (agent.inventory.wood >= SHELTER_WOOD_NEEDED || (!agent.shelter && agent.inventory.wood >= SHELTER_WOOD_NEEDED)) {
        decideAgent();
      } else if (agent.shelter && agent.shelter.built && agent.inventory.wood >= 6) {
        decideAgent();
      }
      break;
    }

    case "build": {
      const s = agent.shelter;
      if (!s) { decideAgent(); break; }
      const sun = sunAltitude(sim.day);
      if (sun < -0.02) { decideAgent(); break; } // no building in the dark
      s.progress += (dtDays * 24) / SHELTER_BUILD_HOURS;
      agent.task = `Building the reed house (${Math.round(clamp(s.progress, 0, 1) * 100)}%)`;
      if (s.progress >= 1) {
        s.progress = 1;
        s.built = true;
        completeActiveProject("buildShelter");
        agent.inventory.reeds -= SHELTER_REEDS_NEEDED;
        agent.inventory.wood -= SHELTER_WOOD_NEEDED - 2; // a little left for the first fire
        agent.inventory.reeds = Math.max(0, agent.inventory.reeds);
        agent.inventory.wood = Math.max(0, agent.inventory.wood);
        logEvent(`${agent.name} finished his reed house. The first roof in Sumer.`, "milestone");
        decideAgent();
      }
      break;
    }

    case "flee": {
      const danger = nearestPredatorPressure().nearest;
      if (!danger || danger.distance > FLEE_RADIUS * 1.7) { agent.fleeFrom = null; decideAgent(); break; }
      let dx = agent.x - danger.x, dy = agent.y - danger.y;
      const d = Math.hypot(dx, dy) || 1;
      let tx = agent.x + (dx / d) * 12, ty = agent.y + (dy / d) * 12;
      if (agent.shelter && agent.shelter.built &&
          (agent.shelter.x - agent.x) * dx + (agent.shelter.y - agent.y) * dy > 0) {
        tx = agent.shelter.x; ty = agent.shelter.y;
      }
      agent.target = { x: clamp(tx, 1, world.width - 1), y: clamp(ty, 1, world.height - 1), then: "survey" };
      agent.task = `Fleeing a ${danger.species}`;
      moveToward(agent, AGENT_SPECIES, agent.target.x, agent.target.y, agentSpeed() * 1.8, dtDays);
      break;
    }

    case "fish": {
      const tile = getTileF(agent.x, agent.y);
      if (!tile || !tile.fish || tile.fish <= 0.08) { decideAgent(); break; }
      rememberResource("forage", { x: agent.x, y: agent.y }, tile.fish);
      const got = Math.min(tile.fish, dtDays * 24 * 0.25);
      tile.fish -= got;
      agent.inventory.food += got * 2.2; // fish are calorie-rich
      agent.task = "Fishing the shallows";
      if (agent.inventory.food > 4 || tile.fish <= 0.08) decideAgent();
      break;
    }

    case "idle":
    default:
      break;
  }

  // The hearth burns down through the night and dies at dawn.
  if (agent.shelter && agent.shelter.fireLit) {
    agent.shelter.fuel -= dtDays * 2.5;
    if (agent.shelter.fuel <= 0 || sunAltitude(sim.day) > 0.1) {
      agent.shelter.fireLit = false;
    }
  }
  observeLand();
}
