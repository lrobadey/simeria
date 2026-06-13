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
const HUNGER_FORAGE_THRESHOLD = 0.4;
const HUNGER_MEAL_THRESHOLD = 0.55;
const HUNGER_URGENT_THRESHOLD = 0.7;

function createAgentMind() {
  return {
    longTermGoal: null,
    activeProject: null,
    dailyIntent: null,
    memory: {
      resources: { forage: [], reeds: [], wood: [] },
      shelterSites: [],
      failedTargets: [],
    },
  };
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
}

function agentSpeed() { return kmhToTilesPerDay(4); }

// ── Perception: scored searches over the world near him ────────────────

function rememberedForageTarget() {
  let best = null, bestScore = 0;
  for (const memory of agent.mind.memory.resources.forage) {
    const forage = memory.forage;
    if (!forage || agentAvoids(memory.x, memory.y)) continue;
    if (forage.kind === "dates") {
      if (!forage.tree || forage.tree.removed || forage.tree.dead || forage.tree.fruit <= 0.03) continue;
    } else if (!forage.tile || forage.tile[forage.kind === "rhizomes" ? "reeds" : "grass"] <= 0.05) {
      continue;
    }
    const score = (memory.score || 0) * memoryFreshness(memory, 20);
    if (score > bestScore) { best = forage; bestScore = score; }
  }
  return best;
}

function rememberedReedTarget() {
  let best = null, bestScore = 0;
  for (const memory of agent.mind.memory.resources.reeds) {
    const tile = memory.target;
    if (!tile || tile.reeds <= 0.06 || isWaterTerrain(tile) || agentAvoids(tile.x, tile.y)) continue;
    const score = tile.reeds * memoryFreshness(memory, 12) / (1 + Math.hypot(tile.x - agent.x, tile.y - agent.y) * 0.02);
    if (score > bestScore) { best = tile; bestScore = score; }
  }
  return best;
}

function rememberedWoodTarget() {
  let best = null, bestScore = 0;
  for (const memory of agent.mind.memory.resources.wood) {
    const tree = memory.target;
    if (!tree || tree.removed || agentAvoids(tree.x, tree.y)) continue;
    const yieldScore = tree.dead ? tree.wood * 2 : (tree.species === "tamarisk" && treeIsMature(tree) ? 1 : 0);
    if (yieldScore <= 0) continue;
    const score = yieldScore * memoryFreshness(memory, 30) / (1 + Math.hypot(tree.x - agent.x, tree.y - agent.y) * 0.03);
    if (score > bestScore) { best = tree; bestScore = score; }
  }
  return best;
}

function rememberedShelterSite() {
  let best = null, bestScore = -Infinity;
  for (const memory of agent.mind.memory.shelterSites) {
    const tile = memory.tile;
    if (!tile || isWaterTerrain(tile) || tile.pondingDepth > 0 || agentAvoids(tile.x, tile.y)) continue;
    const score = (memory.score || 0) * memoryFreshness(memory, 60) -
      Math.hypot(tile.x - agent.x, tile.y - agent.y) * 0.01;
    if (score > bestScore) { best = tile; bestScore = score; }
  }
  return best;
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
      const score = tile.reeds / (1 + r * (radius > 40 ? 0.008 : 0.05));
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
  if (best) rememberResource("wood", best, bestScore);
  return best;
}

function chooseShelterSite() {
  // The decision that founds a settlement: dry feet, fresh water close,
  // food in reach, slightly raised against the flood.
  const remembered = rememberedShelterSite();
  if (remembered) return remembered;

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
  if (best) rememberShelterSite(best, bestScore);
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

function answerHunger(urgentOnly = false) {
  if (agent.state === "eatMeal") return false;

  const inv = agent.inventory;
  const eatThreshold = urgentOnly ? HUNGER_URGENT_THRESHOLD : HUNGER_MEAL_THRESHOLD;
  if (agent.hunger > eatThreshold && inv.food > 0) {
    startEating(urgentOnly ? "Eating from the pack" : "Eating");
    return true;
  }

  const forageThreshold = urgentOnly ? HUNGER_URGENT_THRESHOLD : HUNGER_FORAGE_THRESHOLD;
  const needsFoodNow = agent.hunger > forageThreshold && inv.food <= 0;
  if (needsFoodNow) {
    const forage = findForageTarget();
    if (forage) {
      seekForage(forage);
      return true;
    }
  }

  return false;
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

function ensureShelterProject() {
  if (agent.shelter && agent.shelter.built) {
    setLongTermGoal("maintainHome", "Keep the first shelter useful");
    if (agent.mind.activeProject && agent.mind.activeProject.kind === "buildShelter") {
      agent.mind.activeProject.status = "complete";
      agent.mind.activeProject.progress = 1;
      agent.mind.activeProject.updatedAt = currentAgentDay();
    }
    return null;
  }

  setLongTermGoal("buildShelter", "Make a safer place to sleep");
  if (!agent.mind.activeProject || agent.mind.activeProject.kind !== "buildShelter" ||
      agent.mind.activeProject.status === "complete") {
    agent.mind.activeProject = createBuildShelterProject();
  }
  return agent.mind.activeProject;
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

  return false;
}

function decideAgent() {
  const sun = sunAltitude(sim.day);
  const inv = agent.inventory;

  // Hunger is a body need, not a daytime errand. If it is strong enough, it
  // displaces sleep and work through the same path as every other decision.
  if (answerHunger()) return;

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

  if (inv.food < 1) {
    const forage = findForageTarget();
    if (forage) {
      seekForage(forage);
      return;
    }
  }

  const shelterProject = ensureShelterProject();
  if (shelterProject && pursueBuildShelterProject(shelterProject)) {
    return;
  }

  if (agent.shelter && agent.shelter.built) {
    // Homeowner life: keep the larder and woodpile stocked.
    if (inv.food < 3) {
      const forage = findForageTarget();
      if (forage) {
        seekForage(forage, "Foraging to stock the larder");
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

  // Exhaustion forces sleep wherever he stands.
  if (agent.energy <= 0.03 && agent.state !== "sleep") {
    agent.state = "sleep";
    agent.task = "Collapsed from exhaustion";
    agent.stateUntil = sim.day + 0.05;
  }

  // Real hunger interrupts whatever he's doing: he eats from the pack or drops
  // the errand to find food. Sleep is not special; it is just another task.
  if (agent.hunger > HUNGER_URGENT_THRESHOLD &&
      (agent.inventory.food > 0 ||
        (agent.state !== "forage" && (!agent.target || agent.target.then !== "forage")))) {
    answerHunger(true);
  }

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
      const fromX = agent.x, fromY = agent.y;
      const arrived = moveToward(agent, AGENT_SPECIES, t.x, t.y, agentSpeed(), dtDays);
      // No progress means the straight path is water he can't cross. Give
      // it a few minutes of bank-sliding, then write the place off for a
      // day and choose differently.
      if (!arrived && dist2(fromX, fromY, agent.x, agent.y) < 1e-8) {
        agent.blockedTime += dtDays;
        if (agent.blockedTime > 0.004) {
          agent.blockedTime = 0;
          rememberFailedTarget(t, "blocked");
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
        if (agent.mind.activeProject && agent.mind.activeProject.kind === "buildShelter") {
          agent.mind.activeProject.status = "complete";
          agent.mind.activeProject.progress = 1;
          agent.mind.activeProject.updatedAt = currentAgentDay();
        }
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
