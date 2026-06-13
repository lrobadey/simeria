// ── Fauna: a small food web over the vegetation fields ──────────────────
// Every animal runs the same loop: needs decay with game time, a utility
// pick chooses a behavior, movement integrates continuously. Nothing is
// scripted — herds form because grazers seek the same grass and water,
// the lion patrols the river because that's where the prey must come.

const SPECIES = {
  gazelle: {
    plural: "gazelles",
    speedKmh: 3.5, fleeKmh: 18, senseR: 9,
    eats: ["grass"], eatRate: 3.5,         // density/day at full graze
    drinkInterval: 1.0,                    // days between needing water
    energyPerDay: 0.34, preyValue: 0.9, hungry: 0.6,
    adultDays: 200, maxDays: 365 * 8,
    breedEnergy: 0.7, breedProb: 0.035,    // per day when conditions met
    diurnal: true, swims: false, prey: true,
    habitat: (t) => t.grassCap * (1 - clamp(t.pondingDepth / 0.002, 0, 1)),
    initCount: 70,
  },
  boar: {
    plural: "boars",
    speedKmh: 2.5, fleeKmh: 13, senseR: 7,
    eats: ["reeds", "grass"], eatRate: 3.0, // an omnivore makes do
    drinkInterval: 1.0,
    energyPerDay: 0.3, preyValue: 1.1, hungry: 0.65,
    adultDays: 240, maxDays: 365 * 10,
    breedEnergy: 0.75, breedProb: 0.014,
    diurnal: false, swims: true, prey: true,
    habitat: (t) => t.reedCap,
    initCount: 26,
  },
  heron: {
    plural: "herons",
    speedKmh: 6, fleeKmh: 30, senseR: 12,
    eats: ["fish"], eatRate: 2.2,
    drinkInterval: 2.0,
    energyPerDay: 0.38, preyValue: 0, hungry: 0.6,
    adultDays: 150, maxDays: 365 * 12,
    breedEnergy: 0.8, breedProb: 0.008,
    diurnal: true, swims: true, flies: true, prey: false,
    habitat: (t) => t.fishCap,
    initCount: 14,
  },
  lion: {
    plural: "lions",
    speedKmh: 3, fleeKmh: 22, senseR: 13,
    eats: null, eatRate: 0,
    drinkInterval: 1.2,
    energyPerDay: 0.2, hungry: 0.45,       // big cats laze; hunts only when truly hungry
    adultDays: 500, maxDays: 365 * 14,
    breedEnergy: 0.85, breedProb: 0.0035,
    diurnal: false, swims: false, prey: false, predator: true,
    habitat: (t) => clamp(t.grassCap + t.reedCap, 0, 1) * (1 - clamp(t.pondingDepth / 0.002, 0, 1)),
    initCount: 2,
  },
};

const animals = [];
let nextAnimalId = 1;
const faunaDeaths = { starved: {}, old: {}, killed: {} };
function countDeath(cause, species) {
  faunaDeaths[cause][species] = (faunaDeaths[cause][species] ?? 0) + 1;
}

function spawnAnimal(speciesKey, x, y, ageDays) {
  const species = SPECIES[speciesKey];
  const a = {
    id: nextAnimalId++,
    species: speciesKey,
    x, y,
    heading: random() * Math.PI * 2,
    energy: 0.55 + random() * 0.35,
    thirst: random() * 0.5,            // 0 fresh → 1 desperate
    age: ageDays ?? species.adultDays + random() * species.adultDays,
    state: "wander",
    target: null,                       // {x, y}
    targetAnimal: null,
    stateUntil: 0,                      // sim.day when state expires
    dead: false,
    phase: random() * Math.PI * 2,      // render bobbing
  };
  animals.push(a);
  return a;
}

function initFauna() {
  // Populations seeded where the habitat actually is: pick weighted tiles.
  for (const [key, species] of Object.entries(SPECIES)) {
    const candidates = [];
    for (const tile of world.tiles) {
      const h = species.habitat(tile);
      if (h > 0.3) candidates.push(tile);
    }
    for (let i = 0; i < species.initCount && candidates.length > 0; i++) {
      const tile = candidates[Math.floor(random() * candidates.length)];
      spawnAnimal(key, tile.x + random(), tile.y + random());
    }
  }
}

function kmhToTilesPerDay(kmh) {
  return (kmh * 1000 / CFG.TILE_METERS) * 24;
}

function animalCanEnter(species, tile) {
  if (!tile) return false;
  if (tile.terrain === "river") return !!(species.swims || species.flies);
  if (tile.terrain === "water") {
    // Waders can cross a shallow lagoon waist-deep; nobody fords the
    // river channel itself without swimming.
    return !!(species.swims || species.flies || (species.wades && tile.pondingDepth < 0.018));
  }
  return true;
}

// Walk toward target, deflecting around water the species can't cross.
function moveToward(a, species, tx, ty, speedTilesPerDay, dtDays) {
  const dx = tx - a.x, dy = ty - a.y;
  const d = Math.hypot(dx, dy);
  if (d < 0.05) return true;
  const step = Math.min(d, speedTilesPerDay * dtDays);
  let nx = a.x + (dx / d) * step;
  let ny = a.y + (dy / d) * step;
  if (!animalCanEnter(species, getTileF(nx, ny))) {
    // Slide along the bank: try the two perpendicular deflections.
    const px = -(dy / d), py = dx / d;
    const sign = hashNoise(a.id, Math.floor(sim.day * 4)) > 0.5 ? 1 : -1;
    nx = a.x + px * step * sign;
    ny = a.y + py * step * sign;
    if (!animalCanEnter(species, getTileF(nx, ny))) {
      nx = a.x - px * step * sign;
      ny = a.y - py * step * sign;
      if (!animalCanEnter(species, getTileF(nx, ny))) return false;
    }
  }
  a.x = clamp(nx, 0.5, world.width - 0.5);
  a.y = clamp(ny, 0.5, world.height - 0.5);
  a.heading = Math.atan2(dy, dx);
  return d - step < 0.05;
}

// What can this animal eat on this tile right now? Returns the best field
// of its diet, respecting where each food actually lives.
function bestFoodAt(tile, species) {
  if (!tile || !species.eats) return null;
  let bestField = null, bestAmount = 0;
  for (const field of species.eats) {
    if (field === "fish" && !isWaterTerrain(tile)) continue;
    if (field !== "fish" && isWaterTerrain(tile) && !species.swims) continue;
    if (tile[field] > bestAmount) { bestAmount = tile[field]; bestField = field; }
  }
  return bestField ? { field: bestField, amount: bestAmount } : null;
}

// Score nearby tiles for food/water by sparse sampling — animals don't get
// global knowledge, just what's within their senses.
function findFoodTile(a, species) {
  let best = null, bestScore = 0.12;
  const R = species.senseR;
  for (let i = 0; i < 26; i++) {
    const angle = random() * Math.PI * 2;
    const r = random() * R;
    const tile = getTileF(a.x + Math.cos(angle) * r, a.y + Math.sin(angle) * r);
    if (!tile) continue;
    const food = bestFoodAt(tile, species);
    if (!food) continue;
    const score = food.amount * (1 - r / (R * 2));
    if (score > bestScore) { best = tile; bestScore = score; }
  }
  return best;
}

function findWaterTile(a, species) {
  let best = null, bestD = Infinity;
  const R = species.senseR * 2.2; // thirst widens the search
  for (let i = 0; i < 40; i++) {
    const angle = random() * Math.PI * 2;
    const r = 1 + random() * R;
    const x = a.x + Math.cos(angle) * r, y = a.y + Math.sin(angle) * r;
    const tile = getTileF(x, y);
    if (!tile) continue;
    const drinkable = (tile.terrain === "river" || tile.terrain === "marsh" ||
      (tile.terrain === "water" && tile.salinity < 0.5) ||
      tile.surfaceWater > SURFACE_WATER_VISIBLE_DEPTH * 3) && tile.salinity < 0.6;
    if (!drinkable) continue;
    const d = dist2(a.x, a.y, x, y);
    if (d < bestD) { bestD = d; best = { x, y }; }
  }
  return best;
}

function nearestThreat(a) {
  let threat = null, bestD = Infinity;
  for (const other of animals) {
    if (other.dead || !SPECIES[other.species].predator) continue;
    if (other.state !== "hunt" && other.state !== "stalk") continue;
    const d = dist2(a.x, a.y, other.x, other.y);
    if (d < 64 && d < bestD) { bestD = d; threat = other; }
  }
  return threat;
}

function nearestPrey(a, species) {
  let prey = null, bestD = species.senseR * species.senseR;
  for (const other of animals) {
    if (other.dead || other === a) continue;
    if (!SPECIES[other.species].prey) continue;
    const d = dist2(a.x, a.y, other.x, other.y);
    if (d < bestD) { bestD = d; prey = other; }
  }
  return prey;
}

function isActiveHour(species, simDay) {
  const sun = sunAltitude(simDay);
  if (species.diurnal) return sun > -0.05;
  return sun < 0.35; // crepuscular/nocturnal: rests only through midday
}

function decideAnimal(a, species) {
  // Priority: flee > drink > eat > (hunt) > rest at off-hours > wander.
  if (species.prey) {
    const threat = nearestThreat(a);
    if (threat) {
      a.state = "flee";
      a.targetAnimal = threat;
      a.stateUntil = sim.day + 0.01;
      return;
    }
  }

  if (a.thirst > 0.65) {
    const water = findWaterTile(a, species);
    if (water) {
      a.state = "seekWater";
      a.target = water;
      a.stateUntil = sim.day + 0.2;
      return;
    }
  }

  if (a.energy < species.hungry && isActiveHour(species, sim.day)) {
    if (species.predator) {
      const prey = nearestPrey(a, species);
      if (prey) {
        a.state = "hunt";
        a.targetAnimal = prey;
        a.huntStart = sim.day;
        a.stateUntil = sim.day + 0.04;
        return;
      }
    } else {
      const here = bestFoodAt(getTileF(a.x, a.y), species);
      if (here && here.amount > 0.15) {
        a.state = "eat";
        a.eatField = here.field;
        a.stateUntil = sim.day + 0.05 + random() * 0.05;
        return;
      }
      const foodTile = findFoodTile(a, species);
      if (foodTile) {
        a.state = "seekFood";
        a.target = { x: foodTile.x + 0.5, y: foodTile.y + 0.5 };
        a.stateUntil = sim.day + 0.15;
        return;
      }
    }
    // Hungry and nothing in sense range: strike out for new country. This
    // is how herds escape ground they've grazed bare and how a hungry cat
    // finds the herds at all — migration, not a rule, just an empty belly.
    const angle = random() * Math.PI * 2;
    const r = species.senseR * (2 + random() * 2);
    a.state = "wander";
    a.target = {
      x: clamp(a.x + Math.cos(angle) * r, 1, world.width - 1),
      y: clamp(a.y + Math.sin(angle) * r, 1, world.height - 1),
    };
    a.stateUntil = sim.day + 0.1 + random() * 0.1;
    return;
  }

  if (!isActiveHour(species, sim.day)) {
    a.state = "rest";
    a.stateUntil = sim.day + 0.05 + random() * 0.1;
    return;
  }

  a.state = "wander";
  const angle = random() * Math.PI * 2;
  const r = 2 + random() * 6;
  a.target = {
    x: clamp(a.x + Math.cos(angle) * r, 1, world.width - 1),
    y: clamp(a.y + Math.sin(angle) * r, 1, world.height - 1),
  };
  a.stateUntil = sim.day + 0.05 + random() * 0.08;
}

function updateAnimal(a, dtDays) {
  const species = SPECIES[a.species];
  a.age += dtDays;
  a.thirst = clamp(a.thirst + dtDays / species.drinkInterval, 0, 1.5);
  const restMultiplier = a.state === "rest" ? 0.55 : 1;
  a.energy -= species.energyPerDay * restMultiplier * dtDays;

  if (a.energy <= 0) {
    a.dead = true;
    countDeath("starved", a.species);
    logEvent(`A ${a.species} starved near ${describePlace(a.x, a.y)}.`, "death");
    return;
  }
  if (a.age > species.maxDays && random() < dtDays * 0.05) {
    a.dead = true;
    countDeath("old", a.species);
    logEvent(`An old ${a.species} lay down for the last time.`, "death");
    return;
  }

  if (sim.day >= a.stateUntil || (a.targetAnimal && a.targetAnimal.dead)) {
    a.targetAnimal = null;
    decideAnimal(a, species);
  }

  const cruise = kmhToTilesPerDay(species.speedKmh);
  const sprint = kmhToTilesPerDay(species.fleeKmh);

  switch (a.state) {
    case "flee": {
      const threat = a.targetAnimal;
      if (!threat || threat.dead || dist2(a.x, a.y, threat.x, threat.y) > 144) {
        a.targetAnimal = null;
        decideAnimal(a, species);
        break;
      }
      const dx = a.x - threat.x, dy = a.y - threat.y;
      const d = Math.hypot(dx, dy) || 1;
      moveToward(a, species, a.x + (dx / d) * 4, a.y + (dy / d) * 4, sprint, dtDays);
      a.energy -= species.energyPerDay * 2 * dtDays; // sprinting burns
      a.stateUntil = sim.day + 0.005;
      break;
    }

    case "hunt": {
      const prey = a.targetAnimal;
      if (!prey || prey.dead) { a.targetAnimal = null; decideAnimal(a, species); break; }
      const d2 = dist2(a.x, a.y, prey.x, prey.y);
      // A chase is a sprint, not a campaign: if it drags past ~25 game
      // minutes or the prey breaks away, the cat gives up and pants.
      const winded = sim.day - (a.huntStart ?? sim.day) > 0.018;
      if (winded || d2 > species.senseR * species.senseR * 4) {
        a.targetAnimal = null;
        a.state = "rest";
        a.stateUntil = sim.day + 0.08;
        break;
      }
      moveToward(a, species, prey.x, prey.y, sprint, dtDays);
      a.energy -= species.energyPerDay * 1.5 * dtDays;
      if (d2 < 0.5) {
        // Contact is not a kill: most lunges miss, and a miss ends the hunt.
        if (random() < 0.45) {
          prey.dead = true;
          countDeath("killed", prey.species);
          a.energy = clamp(a.energy + SPECIES[prey.species].preyValue, 0, 1);
          a.state = "rest";
          a.stateUntil = sim.day + 0.3; // gorged: a long rest by the carcass
          logEvent(`The lion took a ${prey.species} near ${describePlace(prey.x, prey.y)}.`, "kill");
        } else {
          a.targetAnimal = null;
          a.state = "rest";
          a.stateUntil = sim.day + 0.1;
          logEvent(`A ${prey.species} escaped the lion's lunge near ${describePlace(prey.x, prey.y)}.`, "escape");
        }
      } else {
        a.stateUntil = sim.day + 0.01;
      }
      break;
    }

    case "seekWater": {
      if (moveToward(a, species, a.target.x, a.target.y, cruise * 1.3, dtDays)) {
        a.state = "drink";
        a.stateUntil = sim.day + 0.02;
      }
      break;
    }

    case "drink": {
      a.thirst = Math.max(0, a.thirst - dtDays * 12);
      if (a.thirst <= 0.05) decideAnimal(a, species);
      break;
    }

    case "seekFood": {
      if (moveToward(a, species, a.target.x, a.target.y, cruise, dtDays)) {
        const here = bestFoodAt(getTileF(a.x, a.y), species);
        if (!here) { decideAnimal(a, species); break; }
        a.state = "eat";
        a.eatField = here.field;
        a.stateUntil = sim.day + 0.05 + random() * 0.05;
      }
      break;
    }

    case "eat": {
      const tile = getTileF(a.x, a.y);
      const field = a.eatField;
      if (!tile || !field || tile[field] <= 0.03) { decideAnimal(a, species); break; }
      const bite = Math.min(tile[field], species.eatRate * dtDays);
      tile[field] -= bite;
      a.energy = clamp(a.energy + bite * 0.7, 0, 1);
      if (a.energy >= 0.95) decideAnimal(a, species);
      break;
    }

    case "wander": {
      if (a.target) moveToward(a, species, a.target.x, a.target.y, cruise * 0.7, dtDays);
      break;
    }

    case "rest":
    default:
      break;
  }

  // Reproduction: well-fed adults in good habitat. Food limits population
  // through energy, so booms follow the flood and busts follow the salt.
  if (a.energy > species.breedEnergy && a.age > species.adultDays &&
      random() < species.breedProb * dtDays) {
    const count = animals.reduce((n, other) => n + (!other.dead && other.species === a.species ? 1 : 0), 0);
    if (count < species.initCount * 3) {
      a.energy -= 0.25;
      spawnAnimal(a.species, a.x + (random() - 0.5), a.y + (random() - 0.5), 0);
      logEvent(`A ${a.species} was born near ${describePlace(a.x, a.y)}.`, "birth");
    }
  }
}

function updateFauna(dtDays) {
  for (const a of animals) {
    if (!a.dead) updateAnimal(a, dtDays);
  }
  // Compact occasionally rather than splicing mid-iteration.
  if (animals.some((a) => a.dead)) {
    for (let i = animals.length - 1; i >= 0; i--) {
      if (animals[i].dead) animals.splice(i, 1);
    }
  }
}

// The map edge is an open boundary — the river flows in from beyond it,
// and so do animals. When a population runs thin, the odd wanderer drifts
// down from the high country to recolonize. Once per day.
function dailyImmigration() {
  for (const [key, species] of Object.entries(SPECIES)) {
    const count = animals.reduce((n, a) => n + (!a.dead && a.species === key ? 1 : 0), 0);
    if (count >= species.initCount * 0.5) continue;
    if (random() > 0.15) continue;
    for (let attempt = 0; attempt < 30; attempt++) {
      const onVertical = random() < 0.5;
      const x = onVertical ? (random() < 0.5 ? 1 : world.width - 2) : 1 + random() * (world.width - 3);
      const y = onVertical ? 1 + random() * (world.height - 3) : 1;
      const tile = getTileF(x, y);
      if (tile && species.habitat(tile) > 0.2 && animalCanEnter(species, tile)) {
        // Social animals arrive as a small band, loners alone.
        const band = species.predator ? 1 : 2 + Math.floor(random() * 3);
        for (let i = 0; i < band; i++) {
          spawnAnimal(key, x + (random() - 0.5) * 2, y + (random() - 0.5) * 2);
        }
        logEvent(band > 1 ? `A band of ${species.plural} wandered in from beyond the floodplain.`
          : `A ${key} wandered in from beyond the floodplain.`, "birth");
        break;
      }
    }
  }
}

function populationCounts() {
  const counts = {};
  for (const key of Object.keys(SPECIES)) counts[key] = 0;
  for (const a of animals) if (!a.dead) counts[a.species]++;
  return counts;
}
