// ── Adapa: the first human ──────────────────────────────────────────────
// One agent with needs (hunger, sleep), an inventory, and a goal he was
// never told how to reach: survive, then build a home. Every choice is a
// utility pick over what his senses and stomach report. Where the hut
// ends up is decided by scoring real tiles — not by us.

const SHELTER_REEDS_NEEDED = 24;
const SHELTER_WOOD_NEEDED = 10;
const SHELTER_BUILD_HOURS = 9;     // total work-hours of construction
const FIRE_WOOD_PER_NIGHT = 1;

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
};

function agentAvoids(x, y) {
  return agent.avoid.some((p) => sim.day < p.until && dist2(p.x, p.y, x, y) < 16);
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
}

function agentSpeed() { return kmhToTilesPerDay(4); }

// ── Perception: scored searches over the world near him ────────────────

function findForageTarget() {
  // Candidate foods, each scored by yield over distance:
  //   ripe dates on mature palms · reed rhizomes in the marsh · grass seed
  // Local sweep first; if the country around him is bare he scans the
  // horizon and walks — subsistence here means following the food.
  for (const radius of [35, 140]) {
    const options = [];
    const distancePenalty = radius > 35 ? 0.008 : 0.06;

    for (const tree of treesNear(agent.x, agent.y, radius + 10)) {
      if (tree.removed || tree.dead || tree.species !== "palm") continue;
      if (tree.fruit < 0.25 || agentAvoids(tree.x, tree.y)) continue;
      const d = Math.hypot(tree.x - agent.x, tree.y - agent.y);
      options.push({ kind: "dates", tree, x: tree.x, y: tree.y, score: tree.fruit * 3 / (1 + d * distancePenalty) });
    }

    // Sample tiles for rhizomes and seed rather than scanning the world.
    const samples = radius > 35 ? 240 : 60;
    for (let i = 0; i < samples; i++) {
      const angle = random() * Math.PI * 2;
      const r = random() * radius;
      const tile = getTileF(agent.x + Math.cos(angle) * r, agent.y + Math.sin(angle) * r);
      if (!tile || agentAvoids(tile.x, tile.y)) continue;
      if (tile.terrain === "marsh" && tile.reeds > 0.45) {
        options.push({ kind: "rhizomes", tile, x: tile.x + 0.5, y: tile.y + 0.5, score: tile.reeds * 1.2 / (1 + r * distancePenalty) });
      } else if (!isWaterTerrain(tile) && tile.grass > 0.6) {
        const dayOfYear = dayOfYearOf(sim.day);
        const seedSeason = dayOfYear > 110 && dayOfYear < 190 ? 1 : 0.25; // grain ripens early summer
        options.push({ kind: "grain", tile, x: tile.x + 0.5, y: tile.y + 0.5, score: tile.grass * seedSeason / (1 + r * distancePenalty) });
      }
    }

    options.sort((a, b) => b.score - a.score);
    if (options.length > 0) return options[0];
  }
  return null;
}

function findReedTarget() {
  // Local sweep first; failing that, he scans the horizon — on a plain
  // this flat the dark line of the reed marsh is visible from anywhere.
  for (const radius of [40, 130]) {
    let best = null, bestScore = 0.3;
    for (let i = 0; i < (radius > 40 ? 220 : 60); i++) {
      const angle = random() * Math.PI * 2;
      const r = random() * radius;
      const tile = getTileF(agent.x + Math.cos(angle) * r, agent.y + Math.sin(angle) * r);
      if (!tile || isWaterTerrain(tile) || agentAvoids(tile.x, tile.y)) continue;
      const score = tile.reeds / (1 + r * (radius > 40 ? 0.008 : 0.05));
      if (score > bestScore) { best = tile; bestScore = score; }
    }
    if (best) return best;
  }
  return null;
}

function findWoodTarget() {
  let best = null, bestScore = 0;
  const radius = treesNear(agent.x, agent.y, 50).length > 0 ? 50 : 130;
  for (const tree of treesNear(agent.x, agent.y, radius)) {
    if (tree.removed || agentAvoids(tree.x, tree.y)) continue;
    const d = Math.hypot(tree.x - agent.x, tree.y - agent.y);
    // Deadwood is free fuel; a living tamarisk can spare branches slowly.
    const yieldScore = tree.dead ? tree.wood * 2 : (tree.species === "tamarisk" && treeIsMature(tree) ? 1 : 0);
    const score = yieldScore / (1 + d * 0.05);
    if (score > bestScore) { best = tree; bestScore = score; }
  }
  return best;
}

function chooseShelterSite() {
  // The decision that founds a settlement: dry feet, fresh water close,
  // food in reach, slightly raised against the flood.
  let best = null, bestScore = -Infinity;
  for (const tile of world.tiles) {
    if (isWaterTerrain(tile) || tile.pondingDepth > 0) continue;
    const d = Math.hypot(tile.x - agent.x, tile.y - agent.y);
    if (d > 50) continue;

    const waterProx = 1 - clamp((tile.distanceToRiver - 2) / 10, 0, 1);
    const tooClose = tile.distanceToRiver < 2 ? -2 : 0; // flood risk on the bank itself
    const raised = clamp((tile.elevation - CFG.SEA_LEVEL - 0.02) / 0.06, 0, 1);
    const food = tile.grassCap + tile.reedCap * 0.5 + (treesNear(tile.x, tile.y, 8).length > 0 ? 0.6 : 0);
    const fresh = 1 - tile.salinity;

    const score = waterProx * 2 + raised * 1.2 + food + fresh + tooClose - d * 0.01;
    if (score > bestScore) { bestScore = score; best = tile; }
  }
  return best;
}

// ── The decision loop ───────────────────────────────────────────────────

function decideAgent() {
  const sun = sunAltitude(sim.day);
  const inv = agent.inventory;

  // Night: get home (or hunker down) and sleep.
  if (sun < -0.02 && agent.energy < 0.92) {
    if (agent.shelter && agent.shelter.built) {
      const d = Math.hypot(agent.x - agent.shelter.x, agent.y - agent.shelter.y);
      if (d > 1) {
        agent.state = "goto";
        agent.target = { x: agent.shelter.x, y: agent.shelter.y, then: "sleep" };
        agent.task = "Heading home for the night";
        return;
      }
      if (!agent.shelter.fireLit && inv.wood >= FIRE_WOOD_PER_NIGHT) {
        inv.wood -= FIRE_WOOD_PER_NIGHT;
        agent.shelter.fireLit = true;
        agent.shelter.fuel = 1;
        logEvent(`${agent.name} lit the hearth fire.`, "agent");
      }
    }
    agent.state = "sleep";
    agent.task = agent.shelter && agent.shelter.built ? "Sleeping by the hearth" : "Sleeping under the open sky";
    agent.stateUntil = sim.day + 0.05;
    return;
  }

  // Hunger beats everything in daylight.
  if (agent.hunger > 0.55 && inv.food > 0) {
    agent.state = "eatMeal";
    agent.task = "Eating";
    agent.stateUntil = sim.day + 1 / 96; // a 15-minute meal
    return;
  }

  if ((agent.hunger > 0.4 && inv.food <= 0) || inv.food < 1) {
    const forage = findForageTarget();
    if (forage) {
      agent.state = "goto";
      agent.target = { x: forage.x, y: forage.y, then: "forage", forage };
      agent.task = forage.kind === "dates" ? "Walking to a date palm" :
        forage.kind === "rhizomes" ? "Wading toward the reed beds" : "Heading to seed grass";
      return;
    }
  }

  // With a full stomach, work toward the house.
  if (!agent.shelter) {
    if (inv.reeds >= SHELTER_REEDS_NEEDED && inv.wood >= SHELTER_WOOD_NEEDED) {
      const site = chooseShelterSite();
      if (site) {
        agent.shelter = { x: site.x + 0.5, y: site.y + 0.5, progress: 0, built: false, fireLit: false, fuel: 0 };
        agent.state = "goto";
        agent.target = { x: agent.shelter.x, y: agent.shelter.y, then: "build" };
        agent.task = "Carrying materials to the chosen ground";
        logEvent(`${agent.name} chose a place for his house near ${describePlace(site.x, site.y)}.`, "agent");
        return;
      }
    }
    if (inv.reeds < SHELTER_REEDS_NEEDED) {
      const reedTile = findReedTarget();
      if (reedTile) {
        agent.state = "goto";
        agent.target = { x: reedTile.x + 0.5, y: reedTile.y + 0.5, then: "cutReeds" };
        agent.task = "Going to cut reeds";
        return;
      }
    }
    if (inv.wood < SHELTER_WOOD_NEEDED) {
      const tree = findWoodTarget();
      if (tree) {
        agent.state = "goto";
        agent.targetTree = tree;
        agent.target = { x: tree.x, y: tree.y, then: "gatherWood" };
        agent.task = "Going to gather wood";
        return;
      }
    }
  } else if (!agent.shelter.built) {
    agent.state = "goto";
    agent.target = { x: agent.shelter.x, y: agent.shelter.y, then: "build" };
    agent.task = "Returning to the building site";
    return;
  } else {
    // Homeowner life: keep the larder and woodpile stocked.
    if (inv.food < 3) {
      const forage = findForageTarget();
      if (forage) {
        agent.state = "goto";
        agent.target = { x: forage.x, y: forage.y, then: "forage", forage };
        agent.task = "Foraging to stock the larder";
        return;
      }
    }
    if (inv.wood < 4) {
      const tree = findWoodTarget();
      if (tree) {
        agent.state = "goto";
        agent.targetTree = tree;
        agent.target = { x: tree.x, y: tree.y, then: "gatherWood" };
        agent.task = "Gathering firewood";
        return;
      }
    }
  }

  // Nothing pressing: rest by the water, watch the land.
  agent.state = "idle";
  agent.task = agent.shelter && agent.shelter.built ? "Resting at home" : "Surveying the land";
  agent.stateUntil = sim.day + 0.02 + random() * 0.03;
}

const AGENT_SPECIES = { wades: true }; // he can wade a lagoon, not the river

function updateAgent(dtDays) {
  if (!agent.alive) return;
  agent.hunger = clamp(agent.hunger + dtDays * 0.5, 0, 1.2);
  if (agent.state !== "sleep") agent.energy = clamp(agent.energy - dtDays * 0.65, 0, 1);

  if (agent.hunger >= 1.2) {
    agent.alive = false;
    agent.task = "Dead of hunger";
    logEvent(`${agent.name} has starved. The land keeps no mourners.`, "death");
    return;
  }

  // Exhaustion forces sleep wherever he stands.
  if (agent.energy <= 0.03 && agent.state !== "sleep") {
    agent.state = "sleep";
    agent.task = "Collapsed from exhaustion";
    agent.stateUntil = sim.day + 0.05;
  }

  // Real hunger interrupts whatever he's doing: he eats from the pack on
  // the move, or drops the errand to find food.
  if (agent.state !== "sleep" && agent.state !== "eatMeal" && agent.hunger > 0.7) {
    if (agent.inventory.food > 0) {
      agent.state = "eatMeal";
      agent.task = "Eating from the pack";
      agent.stateUntil = sim.day + 1 / 96;
    } else if (agent.state !== "forage" && (!agent.target || agent.target.then !== "forage")) {
      decideAgent();
    }
  }

  if (sim.day >= agent.stateUntil && ["idle", "sleep", "eatMeal"].includes(agent.state)) {
    decideAgent();
  }

  switch (agent.state) {
    case "goto": {
      const t = agent.target;
      if (!t) { decideAgent(); break; }
      const fromX = agent.x, fromY = agent.y;
      const arrived = moveToward(agent, AGENT_SPECIES, t.x, t.y, agentSpeed(), dtDays);
      // No progress means the straight path is water he can't cross. Give
      // it a few minutes of bank-sliding, then write the place off for a
      // day and choose differently.
      if (!arrived && dist2(fromX, fromY, agent.x, agent.y) < 1e-8) {
        agent.blockedTime += dtDays;
        if (agent.blockedTime > 0.004) {
          agent.blockedTime = 0;
          agent.avoid.push({ x: t.x, y: t.y, until: sim.day + 1 });
          if (agent.avoid.length > 10) agent.avoid.shift();
          agent.target = null;
          decideAgent();
          break;
        }
      } else {
        agent.blockedTime = 0;
      }
      if (arrived) {
        const then = t.then;
        agent.state = then;
        agent.stateUntil = sim.day + 1; // work states end themselves
        if (then === "forage") agent.forage = t.forage;
        if (then === "sleep") { agent.stateUntil = sim.day + 0.01; decideAgent(); }
      }
      break;
    }

    case "sleep": {
      const recovery = agent.shelter && agent.shelter.built &&
        Math.hypot(agent.x - agent.shelter.x, agent.y - agent.shelter.y) < 2 ? 1.4 : 0.9;
      agent.energy = clamp(agent.energy + dtDays * 2.2 * recovery, 0, 1);
      const sun = sunAltitude(sim.day);
      if (sun > 0.02 && agent.energy > 0.5) {
        logEvent(`${agent.name} rose with the sun.`, "agent");
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
        agent.inventory.reeds -= SHELTER_REEDS_NEEDED;
        agent.inventory.wood -= SHELTER_WOOD_NEEDED - 2; // a little left for the first fire
        agent.inventory.reeds = Math.max(0, agent.inventory.reeds);
        agent.inventory.wood = Math.max(0, agent.inventory.wood);
        logEvent(`${agent.name} finished his reed house. The first roof in Sumer.`, "milestone");
        decideAgent();
      }
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
}
