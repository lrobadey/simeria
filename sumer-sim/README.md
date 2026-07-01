# Sumer · First Light

A systems-driven simulation of the ancient Mesopotamian floodplain. Open
`index.html` in a browser — no build, no dependencies.

One real hour is one in-game day. Leave it running like an aquarium.

## What's emergent (i.e. nearly everything)

The design rule: **nothing is placed by hand**. The only authored numbers are
high-level boundary conditions in `js/core.js` (world scale, sea level, day
length, the seasonal climate curves for an arid floodplain) and the species
parameter tables (what a gazelle *is* — not what it does or where it lives).

- **Terrain & hydrology** — a noisy north-south slope, priority-flood sea
  filling, stochastic flow routing, channel carving with levees, salt
  intrusion and capillary salinization. The river meanders, splits into
  distributaries, and dies into a brackish delta because of how water moves,
  not because anyone drew a delta.
- **Flora** — grass, scrub, reeds, and fish are per-tile densities growing
  logistically toward capacities *derived from the hydrology*, dispersing
  from their edges, grazed down by fauna. Date palms and tamarisk are
  individuals: they age, fruit in late summer, seed saplings, die into
  gatherable deadwood. Groves assemble along the levees on their own.
- **Fauna** — gazelle, boar, heron, lion. One shared behavior loop: needs
  decay, utility decides, movement integrates. Herds form because grazers
  want the same grass; everyone walks to the river because thirst exists;
  the lion patrols the water because that's where the prey must come.
  Hungry animals with nothing in sense range strike out for new country —
  migration as a side effect of an empty belly. The map edge is an open
  boundary: thin populations are slowly recolonized from beyond it.
- **Adapa**, the first human — hunger, sleep, an inventory, and no script.
  He forages dates, rhizomes and seed grass, fishes the shallows, cuts reeds,
  gathers deadwood, *chooses* a shelter site by scoring real tiles (dry feet,
  fresh water, food in reach, raised against the flood), builds a mudhif-style
  reed house, and lights a hearth that burns the wood he actually gathered.
  Places he can't reach get remembered and avoided for a day.
  His mind is a **living appraisal loop, not a ladder**: every decision turns
  his state into competing *pressures* (hunger, fatigue, exposure, scarcity,
  risk, opportunity, capability, curiosity) and scores a slate of projects
  against them — `pressure answered + opportunity + readiness − cost − risk`.
  The winner runs and keeps running only while it stays competitive (with
  hysteresis, so he commits instead of dithering), so the same man forages,
  fishes through a lean season, flees a lion toward his hearth, sleeps out the
  dark and explores when fed — none of it sequenced by hand. Body needs (eat,
  flee, collapse) stay reflexive, above the deliberation, the way they are for
  the animals.

## Watching it

- **Chronicle** (right) — narrated emergent events: kills, escapes, births,
  Adapa's milestones.
- **Hover** the map to read any tile, animal, or Adapa himself.
- **Find Adapa** button — leader line + pulsing ring on the agent.
- **Knowledge** button — the land he remembers, fading to dark where his
  memory has, with pins for the food, reeds, wood and sites he's found.
- **Mind** button — the glass mind: his eight live pressure meters and the
  full slate of projects competing this instant, each with its score and a
  one-line *why*. Hover any project to crack open its term-by-term breakdown;
  a thread on the map runs from Adapa to whatever he's reasoning about, and
  genuine changes of plan are narrated into the Chronicle.
- **Speed controls** — 1× is real time (1 day/hour); 240× for time-lapse.
- Night brings fireflies over the marsh, moon-glints on the water, and the
  hearth glow; dawn and dusk grade the whole valley gold.

## Files

| file | what it owns |
|---|---|
| `js/core.js` | config, math, noise, calendar, climate curves |
| `js/worldgen.js` | terrain + hydrology pipeline |
| `js/climate.js` | sun, temperature, light color, daily water cycle |
| `js/flora.js` | vegetation fields + tree individuals |
| `js/fauna.js` | the food web |
| `js/agent.js` | Adapa — perception, memory, the pressure/project appraisal loop |
| `js/render.js` | baked terrain, flora layer, actors, lighting |
| `js/main.js` | clock, loop, chronicle, HUD |
| `test/smoke.js` | headless run: `node test/smoke.js 90` |

## Tuning notes (found by running it, not asserting it)

- Predator/prey only coexists near 1 lion : ~50 prey; lions hunt below an
  energy threshold, chases time out, and most lunges miss.
- Herbivore metabolisms need slack (starve in ~3 days, not 1.5) or the herd
  pins at the eat-threshold and never reaches breeding condition.
- Stuck-detection matters more than pathfinding: on a delta, a straight
  walker dies pressed against a lagoon. Detect it by *progress toward the
  target*, not raw movement — a walker sliding along a bank is moving but
  getting no closer; write the place off once the gap stops shrinking.
- A tethered agent survives; a free-ranging one strands itself. Foraging is
  scored against distance from the hearth, so he works a home range and comes
  back — exactly how a real camp behaves, and what keeps a lean season from
  walking him off the edge of the known world.
