// ── Main: the clock, the loop, and the chronicle ────────────────────────

const sim = {
  day: CFG.START_DAY,
  speed: 1,
  lastHourTick: -1,
  lastDayTick: -1,
  paused: false,
};

// ── Chronicle: emergent moments, narrated ───────────────────────────────

const chronicle = [];
const chronicleEl = () => document.getElementById("chronicle");

function describePlace(x, y) {
  const tile = getTileF(x, y);
  if (!tile) return "the world's edge";
  const names = {
    river: "the river", water: "the open water", marsh: "the marshes",
    wet_floodplain: "the wet floodplain", fertile_silt: "the silt fields",
    dry_ground: "the dry plain", desert_scrub: "the scrubland",
    salt_flat: "the salt pans",
  };
  return names[tile.terrain] ?? "the plain";
}

function logEvent(text, kind) {
  // Births and deaths happen constantly once populations settle; thin the
  // routine ones so the feed stays a story, not a census.
  if ((kind === "birth" || kind === "death" || kind === "escape") && random() < 0.6) return;
  const date = dateForDay(dayOfYearOf(sim.day));
  chronicle.push({ text, kind, when: `${date.month} ${date.day}` });
  if (chronicle.length > 60) chronicle.shift();
  renderChronicle();
}

function renderChronicle() {
  const el = chronicleEl();
  if (!el) return;
  el.innerHTML = chronicle.slice(-9).reverse().map((e) =>
    `<div class="entry ${e.kind ?? ""}"><span class="when">${e.when}</span>${e.text}</div>`
  ).join("");
}

// ── Simulation stepping ─────────────────────────────────────────────────

const MAX_SUBSTEP_DAYS = 1 / 1440; // one game-minute
const MAX_SUBSTEPS_PER_FRAME = 90;

function advanceSim(gameDtDays) {
  let remaining = gameDtDays;
  let steps = 0;
  while (remaining > 0 && steps < MAX_SUBSTEPS_PER_FRAME) {
    const dt = Math.min(remaining, MAX_SUBSTEP_DAYS);
    sim.day += dt;
    remaining -= dt;
    steps++;

    updateFauna(dt);
    updateAgent(dt);

    const hour = Math.floor(sim.day * 24);
    if (hour !== sim.lastHourTick) {
      const hoursElapsed = sim.lastHourTick < 0 ? 1 : hour - sim.lastHourTick;
      sim.lastHourTick = hour;
      updateFieldFlora(hoursElapsed / 24);
      bakeFlora();
    }

    const dayNumber = Math.floor(sim.day);
    if (dayNumber !== sim.lastDayTick) {
      sim.lastDayTick = dayNumber;
      const dayOfYear = dayOfYearOf(sim.day);
      simulateSeasonalWaterDay(dayOfYear);
      dailyTreeUpdate(dayOfYear);
      dailyImmigration();
      rebuildWetTiles();
    }
  }
}

// ── HUD ─────────────────────────────────────────────────────────────────

function formatClock(simDay) {
  const t = timeOfDayOf(simDay) * 24;
  const h = Math.floor(t);
  const m = Math.floor((t - h) * 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function updateHud() {
  const dayOfYear = dayOfYearOf(sim.day);
  const date = dateForDay(dayOfYear);
  const sun = sunAltitude(sim.day);
  const phase = sun > 0.55 ? "High sun" : sun > 0.1 ? "Daylight" :
    sun > -0.05 ? (timeOfDayOf(sim.day) < 0.5 ? "Dawn" : "Dusk") :
    sun > -0.4 ? "Twilight" : "Deep night";

  document.getElementById("clock").innerHTML =
    `<span class="big">${formatClock(sim.day)}</span> · ${date.month} ${date.day}<br />` +
    `${seasonForDay(dayOfYear)} · ${phase}<br />` +
    `${temperatureAt(sim.day).toFixed(0)}°C · river ${riverFlowForDay(dayOfYear).toFixed(1)}×`;

  const counts = populationCounts();
  document.getElementById("eco-panel").innerHTML =
    `<strong>The valley</strong><br />` +
    Object.entries(counts).map(([k, n]) => `${SPECIES[k].plural}: ${n}`).join(" · ") +
    `<br />trees: ${trees.reduce((n, t) => n + (!t.removed && !t.dead ? 1 : 0), 0)}`;

  const inv = agent.inventory;
  const needs = agent.alive
    ? `hunger ${"▮".repeat(Math.round(agent.hunger * 5))}${"▯".repeat(5 - Math.round(clamp(agent.hunger, 0, 1) * 5))}` +
      ` · rest ${"▮".repeat(Math.round(agent.energy * 5))}${"▯".repeat(5 - Math.round(agent.energy * 5))}`
    : "";
  const stock = agent.shelter && agent.shelter.built
    ? `food ${inv.food.toFixed(1)} · firewood ${Math.floor(inv.wood)} · hearth ${agent.shelter.fireLit ? "burning" : "cold"}`
    : `food ${inv.food.toFixed(1)} · reeds ${Math.floor(inv.reeds)}/${SHELTER_REEDS_NEEDED} · wood ${Math.floor(inv.wood)}/${SHELTER_WOOD_NEEDED}`;
  document.getElementById("agent-panel").innerHTML =
    `<strong>${agent.name}</strong> — ${agent.task}<br />` +
    `${needs}<br />` + stock;
}

// ── Hover inspection ────────────────────────────────────────────────────

let hovered = null;

function updateTileInfo(event) {
  const canvas = view.canvas;
  const rect = canvas.getBoundingClientRect();
  const fx = ((event.clientX - rect.left) / rect.width) * world.width;
  const fy = ((event.clientY - rect.top) / rect.height) * world.height;
  hovered = { x: fx, y: fy };
  renderHoverInfo();
}

function renderHoverInfo() {
  const el = document.getElementById("tile-info");
  if (!hovered) { el.classList.remove("visible"); return; }
  const tile = getTileF(hovered.x, hovered.y);
  if (!tile) { el.classList.remove("visible"); return; }

  // An animal under the cursor takes priority over the dirt.
  let subject = null;
  for (const a of animals) {
    if (dist2(a.x, a.y, hovered.x, hovered.y) < 1.2) { subject = a; break; }
  }
  if (agent.alive && dist2(agent.x, agent.y, hovered.x, hovered.y) < 1.2) {
    el.innerHTML = `<strong>${agent.name}</strong><br />${agent.task}`;
    el.classList.add("visible");
    return;
  }
  if (subject) {
    const stateNames = {
      wander: "wandering", eat: "feeding", seekFood: "looking for food",
      seekWater: "heading to water", drink: "drinking", rest: "resting",
      flee: "fleeing!", hunt: "hunting", stalk: "stalking",
    };
    el.innerHTML = `<strong>${subject.species}</strong> — ${stateNames[subject.state] ?? subject.state}<br />` +
      `energy ${(subject.energy * 100).toFixed(0)}% · thirst ${(clamp(subject.thirst, 0, 1) * 100).toFixed(0)}%<br />` +
      `age ${(subject.age / CFG.YEAR_DAYS).toFixed(1)} yrs`;
    el.classList.add("visible");
    return;
  }

  const name = tile.terrain.split("_").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
  const lines = [`<strong>${name}</strong>`];
  if (!isWaterTerrain(tile)) {
    lines.push(`fertility ${(tile.fertility * 100).toFixed(0)}% · moisture ${(liveWetness(tile) * 100).toFixed(0)}%`);
    if (tile.salinity > 0.3) lines.push(`salt-touched (${(tile.salinity * 100).toFixed(0)}%)`);
    const veg = [];
    if (tile.grass > 0.1) veg.push(`grass ${(tile.grass * 100).toFixed(0)}%`);
    if (tile.reeds > 0.1) veg.push(`reeds ${(tile.reeds * 100).toFixed(0)}%`);
    if (tile.scrub > 0.1) veg.push(`scrub ${(tile.scrub * 100).toFixed(0)}%`);
    if (veg.length) lines.push(veg.join(" · "));
  } else {
    lines.push(`${tile.salinity > 0.6 ? "salt water" : tile.salinity > 0.3 ? "brackish" : "fresh water"}`);
    if (tile.fish > 0.1) lines.push(`fish ${(tile.fish * 100).toFixed(0)}%`);
  }
  if (tile.surfaceWater > SURFACE_WATER_VISIBLE_DEPTH && tile.terrain !== "river") lines.push("flooded");
  el.innerHTML = lines.join("<br />");
  el.classList.add("visible");
}

// ── Boot & loop ─────────────────────────────────────────────────────────

let lastFrame = null;

function frame(tReal) {
  requestAnimationFrame(frame);
  if (lastFrame === null) lastFrame = tReal;
  const dtReal = Math.min(0.1, (tReal - lastFrame) / 1000);
  lastFrame = tReal;

  if (!sim.paused) {
    advanceSim((dtReal / CFG.DAY_REAL_SECONDS) * sim.speed);
    updateFireflies(dtReal, nightness(sim.day));
  }

  renderFrame(tReal);

  // HUD at 4 Hz is plenty.
  if (!frame.lastHud || tReal - frame.lastHud > 250) {
    frame.lastHud = tReal;
    updateHud();
    if (hovered) renderHoverInfo();
  }
}

function boot() {
  generateWorld();
  initFlora();
  initFauna();
  initAgent();

  // Let the seasonal water settle so the world doesn't start bone dry.
  for (let i = 0; i < 12; i++) {
    simulateSeasonalWaterDay(dayOfYearOf(sim.day) - 12 + i);
  }
  sim.lastDayTick = Math.floor(sim.day);
  sim.lastHourTick = Math.floor(sim.day * 24);

  const canvas = document.getElementById("world");
  initRender(canvas);

  canvas.addEventListener("mousemove", updateTileInfo);
  canvas.addEventListener("mouseleave", () => { hovered = null; renderHoverInfo(); });

  for (const button of document.querySelectorAll("[data-speed]")) {
    button.addEventListener("click", () => {
      sim.speed = Number(button.dataset.speed);
      sim.paused = false;
      for (const b of document.querySelectorAll("[data-speed]")) b.classList.toggle("active", b === button);
    });
  }
  document.getElementById("pause").addEventListener("click", (e) => {
    sim.paused = !sim.paused;
    e.target.textContent = sim.paused ? "Resume" : "Pause";
  });
  document.getElementById("track-adapa").addEventListener("click", (e) => {
    view.trackAgent = !view.trackAgent;
    e.target.classList.toggle("active", view.trackAgent);
  });

  logEvent(`${agent.name} woke alone on the floodplain, with nothing but his hands.`, "milestone");
  updateHud();
  requestAnimationFrame(frame);
}

boot();
