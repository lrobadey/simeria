// Headless smoke test: load every non-render module, run the world for a
// few in-game weeks at minute resolution, and report what happened.
// Usage: node test/smoke.js [days]
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ctx = { console, Math, Map, Set, Infinity, Number, String, Object, Array, Float32Array, Uint8Array };
vm.createContext(ctx);

for (const f of ["core.js", "worldgen.js", "climate.js", "flora.js", "fauna.js", "agent.js"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../js", f), "utf8"), ctx, { filename: f });
}

const days = Number(process.argv[2] ?? 20);

vm.runInContext(`
  const sim = { day: CFG.START_DAY, lastHourTick: -1, lastDayTick: -1 };
  const events = [];
  function describePlace(x, y) {
    const tile = getTileF(x, y);
    return tile ? tile.terrain : "?";
  }
  function logEvent(text, kind) { events.push({ day: sim.day.toFixed(2), text, kind }); }

  generateWorld();
  initFlora();
  initFauna();
  initAgent();
  for (let i = 0; i < 12; i++) simulateSeasonalWaterDay(dayOfYearOf(sim.day) - 12 + i);
  sim.lastDayTick = Math.floor(sim.day);
  sim.lastHourTick = Math.floor(sim.day * 24);

  const counts0 = populationCounts();
  console.log("terrain:", Object.entries(world.tiles.reduce((m, t) => (m[t.terrain] = (m[t.terrain] ?? 0) + 1, m), {}))
    .map(([k, v]) => k + "=" + v).join(" "));
  console.log("trees:", trees.length, " start populations:", JSON.stringify(counts0));
  console.log("agent start:", agent.x.toFixed(0), agent.y.toFixed(0), getTileF(agent.x, agent.y).terrain);

  const DT = 1 / 1440;
  const end = sim.day + ${days};
  while (sim.day < end) {
    sim.day += DT;
    updateFauna(DT);
    updateAgent(DT);
    const hour = Math.floor(sim.day * 24);
    if (hour !== sim.lastHourTick) {
      sim.lastHourTick = hour;
      updateFieldFlora(1 / 24);
    }
    const dayN = Math.floor(sim.day);
    if (dayN !== sim.lastDayTick) {
      sim.lastDayTick = dayN;
      simulateSeasonalWaterDay(dayOfYearOf(sim.day));
      dailyTreeUpdate(dayOfYearOf(sim.day));
      dailyImmigration();
      if (dayN % 5 === 0) {
        console.log("day", dayN, "pop:", JSON.stringify(populationCounts()),
          "| agent:", agent.task, "| inv:", JSON.stringify({
            food: +agent.inventory.food.toFixed(1),
            reeds: Math.floor(agent.inventory.reeds),
            wood: +agent.inventory.wood.toFixed(1) }),
          "| hunger", agent.hunger.toFixed(2), "energy", agent.energy.toFixed(2),
          agent.shelter ? ("| shelter " + (agent.shelter.built ? "BUILT" : (agent.shelter.progress * 100).toFixed(0) + "%")) : "");
      }
    }
  }

  console.log("\\n--- final ---");
  console.log("populations:", JSON.stringify(populationCounts()));
  console.log("deaths:", JSON.stringify(faunaDeaths));
  const ge = animals.filter(a => a.species === "gazelle");
  console.log("gazelle mean energy:", (ge.reduce((s, a) => s + a.energy, 0) / ge.length).toFixed(2),
    "states:", JSON.stringify(ge.reduce((m, a) => (m[a.state] = (m[a.state] ?? 0) + 1, m), {})));
  console.log("agent alive:", agent.alive, "| shelter:", agent.shelter ? (agent.shelter.built ? "built" : "in progress") : "none");
  console.log("\\nchronicle (" + events.length + " events, last 25):");
  for (const e of events.slice(-25)) console.log("  d" + e.day, "[" + (e.kind ?? "") + "]", e.text);
`, ctx, { filename: "harness" });
