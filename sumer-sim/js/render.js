// ── Rendering: a painterly diorama over the data ────────────────────────
// Layers, cheapest first:
//   terrain   — baked once: palette + hillshade relief + per-pixel grain
//   water     — animated shimmer + seasonal flood overlay (list per day)
//   flora     — tuft/reed/scrub strokes + trees, rebaked once per game-hour
//   actors    — animals, Adapa, the hut, drawn per frame
//   light     — multiply ambient from the sun, then additive fire glow,
//               water glints, fireflies, drifting night

const view = {
  canvas: null, ctx: null,
  terrainLayer: null, floraLayer: null,
  wetTiles: [], riverTiles: [], marshTiles: [],
  fireflies: [],
  glints: [],
  px: CFG.WORLD * CFG.TILE,
};

const TERRAIN_PALETTES = {
  marsh: { low: { r: 35, g: 76, b: 70 }, high: { r: 63, g: 99, b: 77 } },
  wet_floodplain: { low: { r: 74, g: 92, b: 57 }, high: { r: 113, g: 119, b: 68 } },
  fertile_silt: { low: { r: 123, g: 109, b: 55 }, high: { r: 161, g: 143, b: 77 } },
  dry_ground: { low: { r: 145, g: 111, b: 66 }, high: { r: 212, g: 174, b: 112 } },
  desert_scrub: { low: { r: 182, g: 150, b: 88 }, high: { r: 224, g: 197, b: 132 } },
  salt_flat: { low: { r: 184, g: 170, b: 142 }, high: { r: 218, g: 207, b: 180 } },
};

function baseTileColor(tile) {
  if (tile.terrain === "river") {
    return mixColor({ r: 38, g: 105, b: 140 }, { r: 70, g: 148, b: 184 }, clamp(tile.flow / (world.width * world.height * 0.4), 0, 1));
  }
  if (tile.terrain === "water") {
    const depth = clamp((tile.pondingDepth - 0.012) / 0.025, 0, 1);
    let water = mixColor({ r: 62, g: 130, b: 152 }, { r: 22, g: 70, b: 110 }, depth);
    const murk = clamp((0.6 - tile.salinity) / 0.6, 0, 1);
    return mixColor(water, { r: 86, g: 124, b: 108 }, murk * 0.5);
  }
  const palette = TERRAIN_PALETTES[tile.terrain] ?? TERRAIN_PALETTES.dry_ground;
  const elevationShade = clamp((tile.elevation - 0.38) / 0.26, 0, 1);
  let color = mixColor(palette.low, palette.high, elevationShade * 0.7 + clamp(tile.moisture, 0, 1) * 0.3);
  const bloom = clamp((tile.salinity - 0.45) / 0.55, 0, 1);
  if (bloom > 0) color = mixColor(color, { r: 222, g: 212, b: 190 }, bloom * 0.35);
  return color;
}

function bakeTerrain() {
  const size = view.px;
  const layer = document.createElement("canvas");
  layer.width = size; layer.height = size;
  const lctx = layer.getContext("2d");
  const img = lctx.createImageData(size, size);
  const data = img.data;
  const T = CFG.TILE;

  for (let ty = 0; ty < world.height; ty++) {
    for (let tx = 0; tx < world.width; tx++) {
      const tile = world.tiles[tileIndex(tx, ty)];
      const color = baseTileColor(tile);

      // Hillshade: light from the northwest reveals levees and banks.
      const west = getTile(tx - 1, ty - 1) ?? tile;
      const east = getTile(tx + 1, ty + 1) ?? tile;
      const relief = isWaterTerrain(tile) ? 0 : clamp((west.elevation - east.elevation) * 14, -0.22, 0.22);

      for (let py = 0; py < T; py++) {
        for (let px = 0; px < T; px++) {
          const gx = tx * T + px, gy = ty * T + py;
          // Per-pixel grain: silt isn't flat. Water gets gentler grain.
          const grain = (hashNoise(gx * 7 + 13, gy * 7 + 41) - 0.5) * (isWaterTerrain(tile) ? 0.05 : 0.13);
          const v = 1 + relief + grain;
          const o = (gy * size + gx) * 4;
          data[o] = clamp(color.r * v, 0, 255);
          data[o + 1] = clamp(color.g * v, 0, 255);
          data[o + 2] = clamp(color.b * v, 0, 255);
          data[o + 3] = 255;
        }
      }
    }
  }

  lctx.putImageData(img, 0, 0);
  view.terrainLayer = layer;

  view.riverTiles = world.tiles.filter((t) => t.terrain === "river");
  view.marshTiles = world.tiles.filter((t) => t.terrain === "marsh" || (t.terrain === "water" && t.reedCap > 0.2));
}

function rebuildWetTiles() {
  // Seasonal flood water only changes on day ticks; cache the visible set.
  view.wetTiles = world.tiles.filter((t) =>
    t.surfaceWater > SURFACE_WATER_VISIBLE_DEPTH && t.terrain !== "river" && !isOpenSeaSink(t));
}

// ── Flora layer: rebaked when flora updates (once per game-hour) ────────

function bakeFlora() {
  if (!view.floraLayer) {
    view.floraLayer = document.createElement("canvas");
    view.floraLayer.width = view.px;
    view.floraLayer.height = view.px;
  }
  const fctx = view.floraLayer.getContext("2d");
  fctx.clearRect(0, 0, view.px, view.px);
  const T = CFG.TILE;
  const dayOfYear = dayOfYearOf(sim.day);
  // Grass greens with the rains and burns gold through high summer.
  const cure = clamp((evaporationForDay(dayOfYear) - 0.6) / 1.2, 0, 1);
  const grassGreen = mixColor({ r: 96, g: 128, b: 58 }, { r: 168, g: 148, b: 76 }, cure);
  const grassDark = mixColor({ r: 70, g: 100, b: 46 }, { r: 140, g: 120, b: 60 }, cure);

  for (const tile of world.tiles) {
    const x0 = tile.x * T, y0 = tile.y * T;

    if (tile.grass > 0.12) {
      const n = Math.min(4, 1 + Math.floor(tile.grass * 3.2));
      for (let i = 0; i < n; i++) {
        const hx = hashNoise(tile.x * 31 + i, tile.y * 17 + i);
        const hy = hashNoise(tile.x * 13 + i * 7, tile.y * 29 + i);
        const c = hy > 0.5 ? grassGreen : grassDark;
        fctx.fillStyle = `rgba(${c.r},${c.g},${c.b},${0.5 + tile.grass * 0.4})`;
        fctx.fillRect(x0 + hx * (T - 1), y0 + hy * (T - 2), 1, 2);
      }
    }

    if (tile.scrub > 0.15) {
      const n = Math.min(2, Math.round(tile.scrub * 2.5));
      for (let i = 0; i < n; i++) {
        const hx = hashNoise(tile.x * 53 + i, tile.y * 11 + i);
        const hy = hashNoise(tile.x * 7 + i * 3, tile.y * 43 + i);
        fctx.fillStyle = `rgba(96, 92, 58, ${0.45 + tile.scrub * 0.3})`;
        fctx.beginPath();
        fctx.arc(x0 + 1 + hx * (T - 2), y0 + 1 + hy * (T - 2), 1 + tile.scrub, 0, Math.PI * 2);
        fctx.fill();
      }
    }

    if (tile.reeds > 0.1) {
      const n = Math.min(5, 1 + Math.floor(tile.reeds * 4));
      for (let i = 0; i < n; i++) {
        const hx = hashNoise(tile.x * 19 + i * 5, tile.y * 23 + i);
        const hy = hashNoise(tile.x * 37 + i, tile.y * 7 + i * 11);
        const px = x0 + hx * (T - 1);
        const py = y0 + 1 + hy * (T - 2);
        const h = 2 + tile.reeds * 2.5;
        fctx.strokeStyle = `rgba(126, 134, 58, ${0.55 + tile.reeds * 0.35})`;
        fctx.lineWidth = 1;
        fctx.beginPath();
        fctx.moveTo(px, py + 1);
        fctx.lineTo(px + (hx - 0.5) * 1.6, py - h);
        fctx.stroke();
        if (tile.reeds > 0.5 && i === 0) {
          fctx.fillStyle = "rgba(168, 152, 96, 0.8)"; // seed head
          fctx.fillRect(px + (hx - 0.5) * 1.6, py - h - 1, 1, 1);
        }
      }
    }
  }

  for (const tree of trees) {
    if (!tree.removed) drawTree(fctx, tree);
  }
}

function drawTree(fctx, tree) {
  const x = tree.x * CFG.TILE, y = tree.y * CFG.TILE;
  const species = TREE_SPECIES[tree.species];
  const maturity = clamp(tree.age / (species.matureYears * CFG.YEAR_DAYS), 0.25, 1);

  if (tree.dead) {
    fctx.strokeStyle = "rgba(92, 74, 52, 0.9)";
    fctx.lineWidth = 1.5;
    fctx.beginPath();
    fctx.moveTo(x, y);
    fctx.lineTo(x + 2, y - 5 * maturity);
    fctx.moveTo(x, y - 2 * maturity);
    fctx.lineTo(x - 3, y - 4 * maturity);
    fctx.stroke();
    return;
  }

  if (tree.species === "palm") {
    const h = 7 * maturity;
    const lean = (tree.variant - 1.5) * 1.2;
    // Shadow pools at the foot; the fronds burst from the crown.
    fctx.fillStyle = "rgba(30, 30, 16, 0.25)";
    fctx.beginPath();
    fctx.ellipse(x + 2, y + 1, 3.5 * maturity, 1.4, 0, 0, Math.PI * 2);
    fctx.fill();
    fctx.strokeStyle = "rgb(118, 88, 54)";
    fctx.lineWidth = 1.4 * maturity;
    fctx.beginPath();
    fctx.moveTo(x, y);
    fctx.quadraticCurveTo(x + lean, y - h * 0.6, x + lean, y - h);
    fctx.stroke();
    const cx = x + lean, cy = y - h;
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2 + tree.variant;
      const fx = Math.cos(angle) * 4.5 * maturity;
      const fy = Math.sin(angle) * 2.4 * maturity - 1;
      fctx.strokeStyle = i % 2 ? "rgb(58, 96, 44)" : "rgb(74, 116, 52)";
      fctx.lineWidth = 1.2;
      fctx.beginPath();
      fctx.moveTo(cx, cy);
      fctx.quadraticCurveTo(cx + fx * 0.6, cy + fy * 0.4 - 1.5, cx + fx, cy + fy + 1);
      fctx.stroke();
    }
    if (tree.fruit > 0.3) {
      fctx.fillStyle = `rgba(196, 124, 40, ${tree.fruit})`;
      fctx.beginPath();
      fctx.arc(cx - 1, cy + 1, 1.1, 0, Math.PI * 2);
      fctx.arc(cx + 1.2, cy + 0.8, 1.0, 0, Math.PI * 2);
      fctx.fill();
    }
  } else {
    // Tamarisk: a feathery grey-green dome.
    const r = 2.6 * maturity + 0.8;
    fctx.fillStyle = "rgba(30, 30, 16, 0.2)";
    fctx.beginPath();
    fctx.ellipse(x + 1, y + 1, r, r * 0.45, 0, 0, Math.PI * 2);
    fctx.fill();
    fctx.fillStyle = "rgb(110, 124, 96)";
    fctx.beginPath();
    fctx.arc(x, y - r * 0.6, r, 0, Math.PI * 2);
    fctx.fill();
    fctx.fillStyle = "rgb(132, 144, 110)";
    fctx.beginPath();
    fctx.arc(x - r * 0.3, y - r * 0.9, r * 0.6, 0, Math.PI * 2);
    fctx.fill();
  }
}

// ── Actors ──────────────────────────────────────────────────────────────

function drawAnimal(ctx, a, tReal) {
  const x = a.x * CFG.TILE, y = a.y * CFG.TILE;
  const bob = Math.sin(tReal * 0.004 + a.phase) * 0.4;
  const moving = ["seekFood", "seekWater", "wander", "flee", "hunt"].includes(a.state);
  const gait = moving ? Math.sin(tReal * 0.02 + a.phase) * 0.8 : 0;
  const resting = a.state === "rest";

  ctx.save();
  ctx.translate(x, y + bob);

  // Ground shadow anchors everyone to the land.
  ctx.fillStyle = "rgba(20, 18, 10, 0.3)";
  ctx.beginPath();
  ctx.ellipse(0, 1.6, 3, 1.1, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.rotate(a.heading + Math.PI / 2);

  switch (a.species) {
    case "gazelle": {
      ctx.fillStyle = resting ? "rgb(176, 142, 96)" : "rgb(196, 158, 106)";
      ctx.beginPath();
      ctx.ellipse(0, 0, 1.6, 3, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgb(238, 228, 208)"; // pale rump
      ctx.beginPath();
      ctx.ellipse(0, 1.8, 1.1, 1, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgb(70, 54, 34)"; // horns
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.moveTo(-0.6, -2.6); ctx.lineTo(-1.1 + gait * 0.2, -4);
      ctx.moveTo(0.6, -2.6); ctx.lineTo(1.1 - gait * 0.2, -4);
      ctx.stroke();
      break;
    }
    case "boar": {
      ctx.fillStyle = "rgb(74, 60, 48)";
      ctx.beginPath();
      ctx.ellipse(0, 0, 2.2, 3.2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgb(52, 42, 34)"; // bristled shoulders
      ctx.beginPath();
      ctx.ellipse(0, -1, 1.8, 1.6, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgb(214, 198, 170)"; // snout
      ctx.fillRect(-0.5, -3.6, 1, 1);
      break;
    }
    case "heron": {
      const flying = a.state === "seekFood" || a.state === "seekWater" || a.state === "wander" || a.state === "flee";
      ctx.fillStyle = "rgb(225, 228, 230)";
      ctx.beginPath();
      ctx.ellipse(0, 0, 1.4, 2.6, 0, 0, Math.PI * 2);
      ctx.fill();
      if (flying) {
        const flap = Math.sin(tReal * 0.015 + a.phase) * 3;
        ctx.strokeStyle = "rgb(168, 178, 186)";
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        ctx.moveTo(0, 0); ctx.quadraticCurveTo(-3.5, -1 + flap, -5.5, flap);
        ctx.moveTo(0, 0); ctx.quadraticCurveTo(3.5, -1 + flap, 5.5, flap);
        ctx.stroke();
      }
      ctx.strokeStyle = "rgb(190, 150, 60)"; // beak
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.moveTo(0, -2.4); ctx.lineTo(0, -4.2);
      ctx.stroke();
      break;
    }
    case "lion": {
      ctx.fillStyle = "rgb(186, 148, 88)";
      ctx.beginPath();
      ctx.ellipse(0, 0, 2.6, 4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgb(140, 100, 56)"; // mane
      ctx.beginPath();
      ctx.arc(0, -2.4, 2.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgb(186, 148, 88)";
      ctx.beginPath();
      ctx.arc(0, -2.8, 1.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgb(140, 100, 56)"; // tail
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(0, 3.8);
      ctx.quadraticCurveTo(1.5 + gait, 5.5, 0.5 + gait, 6.5);
      ctx.stroke();
      break;
    }
  }
  ctx.restore();
}

function drawAgent(ctx, tReal) {
  if (!agent.alive) return;
  const x = agent.x * CFG.TILE, y = agent.y * CFG.TILE;
  const sleeping = agent.state === "sleep";
  const working = ["cutReeds", "gatherWood", "build", "forage"].includes(agent.state);
  const sway = working ? Math.sin(tReal * 0.008) * 0.8 : 0;

  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = "rgba(20, 18, 10, 0.35)";
  ctx.beginPath();
  ctx.ellipse(0, 2, 2.6, 1, 0, 0, Math.PI * 2);
  ctx.fill();

  if (sleeping) {
    ctx.fillStyle = "rgb(188, 162, 120)";
    ctx.beginPath();
    ctx.ellipse(0, 0.5, 3.4, 1.6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgb(150, 110, 80)";
    ctx.beginPath();
    ctx.arc(-2.8, 0.2, 1.2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.fillStyle = "rgb(222, 206, 170)"; // linen kilt
    ctx.beginPath();
    ctx.ellipse(sway * 0.3, 0, 1.7, 2.6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgb(158, 116, 84)"; // skin
    ctx.beginPath();
    ctx.arc(sway * 0.5, -3.4, 1.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgb(40, 30, 22)"; // hair
    ctx.beginPath();
    ctx.arc(sway * 0.5, -3.9, 1.3, Math.PI, Math.PI * 2);
    ctx.fill();
    if (working) {
      ctx.strokeStyle = "rgb(120, 90, 58)";
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(1.5, -1.5);
      ctx.lineTo(3 + sway, -3.5 - sway);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function drawShelter(ctx) {
  const s = agent.shelter;
  if (!s) return;
  const x = s.x * CFG.TILE, y = s.y * CFG.TILE;
  const progress = clamp(s.progress, 0, 1);

  ctx.save();
  ctx.translate(x, y);

  ctx.fillStyle = "rgba(20, 18, 10, 0.3)";
  ctx.beginPath();
  ctx.ellipse(1, 3, 8 * Math.max(progress, 0.3), 2.5, 0, 0, Math.PI * 2);
  ctx.fill();

  if (progress < 1) {
    // Materials staged on the ground, frame rising with progress.
    ctx.fillStyle = "rgb(150, 138, 76)";
    ctx.fillRect(-6, 2, 5, 2);
    ctx.fillStyle = "rgb(110, 84, 52)";
    ctx.fillRect(3, 2.5, 4, 1.5);
    if (progress > 0.1) {
      ctx.strokeStyle = "rgb(118, 96, 58)";
      ctx.lineWidth = 1;
      const h = 9 * progress;
      ctx.beginPath();
      ctx.moveTo(-5, 2); ctx.lineTo(0, 2 - h);
      ctx.lineTo(5, 2);
      if (progress > 0.5) { ctx.moveTo(-3, 2 - h * 0.35); ctx.lineTo(3, 2 - h * 0.35); }
      ctx.stroke();
    }
  } else {
    // The mudhif: a barrel-vaulted reed house, golden thatch, dark door.
    const grad = ctx.createLinearGradient(0, -10, 0, 3);
    grad.addColorStop(0, "rgb(196, 172, 110)");
    grad.addColorStop(1, "rgb(140, 116, 70)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(-7, 3);
    ctx.quadraticCurveTo(-7, -8, 0, -8);
    ctx.quadraticCurveTo(7, -8, 7, 3);
    ctx.closePath();
    ctx.fill();
    // Reed-bundle ribs.
    ctx.strokeStyle = "rgba(108, 88, 50, 0.7)";
    ctx.lineWidth = 0.8;
    for (let i = -2; i <= 2; i++) {
      ctx.beginPath();
      ctx.moveTo(i * 2.4, 3);
      ctx.quadraticCurveTo(i * 2.4 * 0.9, -7.5, i * 1.2, -7.8);
      ctx.stroke();
    }
    ctx.fillStyle = "rgb(46, 34, 22)";
    ctx.beginPath();
    ctx.moveTo(-1.8, 3);
    ctx.quadraticCurveTo(-1.8, -2.5, 0, -2.5);
    ctx.quadraticCurveTo(1.8, -2.5, 1.8, 3);
    ctx.closePath();
    ctx.fill();
    // Hearth circle outside.
    ctx.fillStyle = s.fireLit ? "rgb(240, 150, 50)" : "rgb(60, 50, 40)";
    ctx.beginPath();
    ctx.arc(9, 2, 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// ── Atmosphere: shimmer, glints, fireflies, light ───────────────────────

function initGlints() {
  // Persistent sparkle points on open water; phase-offset so they twinkle.
  view.glints = [];
  for (const tile of world.tiles) {
    if (!isWaterTerrain(tile)) continue;
    if (hashNoise(tile.x * 3 + 1, tile.y * 3 + 9) > 0.92) {
      view.glints.push({
        x: tile.x * CFG.TILE + hashNoise(tile.x, tile.y) * CFG.TILE,
        y: tile.y * CFG.TILE + hashNoise(tile.y, tile.x) * CFG.TILE,
        phase: hashNoise(tile.x * 7, tile.y * 13) * Math.PI * 2,
      });
    }
  }
}

function updateFireflies(dtReal, night) {
  const flies = view.fireflies;
  const targetCount = Math.floor(night * 110);
  while (flies.length < targetCount && view.marshTiles.length > 0) {
    const tile = view.marshTiles[Math.floor(random() * view.marshTiles.length)];
    flies.push({
      x: (tile.x + random()) * CFG.TILE,
      y: (tile.y + random()) * CFG.TILE,
      phase: random() * Math.PI * 2,
      drift: random() * Math.PI * 2,
      life: 4 + random() * 8,
    });
  }
  for (let i = flies.length - 1; i >= 0; i--) {
    const f = flies[i];
    f.life -= dtReal;
    f.drift += (random() - 0.5) * 0.6;
    f.x += Math.cos(f.drift) * dtReal * 6;
    f.y += Math.sin(f.drift) * dtReal * 6 - dtReal * 2;
    if (f.life <= 0 || flies.length > targetCount + 8) flies.splice(i, 1);
  }
}

function drawWaterShimmer(ctx, tReal) {
  // Slow bands of light sliding down the channel — enough to read as
  // current without simulating one.
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  const T = CFG.TILE;
  for (const tile of view.riverTiles) {
    const wave = Math.sin(tReal * 0.0012 + tile.y * 0.45 + tile.x * 0.12);
    if (wave < 0.55) continue;
    ctx.fillStyle = `rgba(140, 190, 215, ${(wave - 0.55) * 0.25})`;
    ctx.fillRect(tile.x * T, tile.y * T, T, T);
  }
  ctx.restore();
}

function drawFloodWater(ctx) {
  const T = CFG.TILE;
  for (const tile of view.wetTiles) {
    const intensity = clamp(tile.surfaceWater / 0.03, 0, 1);
    ctx.fillStyle = `rgba(48, 130, 175, ${0.2 + intensity * 0.5})`;
    ctx.fillRect(tile.x * T, tile.y * T, T, T);
  }
}

function drawLighting(ctx, tReal) {
  const ambient = ambientLight(sim.day);
  const night = nightness(sim.day);

  ctx.save();
  ctx.globalCompositeOperation = "multiply";
  ctx.fillStyle = colorToRgb(ambient);
  ctx.fillRect(0, 0, view.px, view.px);
  ctx.restore();

  ctx.save();
  ctx.globalCompositeOperation = "screen";

  // Moon-glints on the water at night, sun-glints by day.
  for (const g of view.glints) {
    const tw = Math.sin(tReal * 0.002 + g.phase) * 0.5 + 0.5;
    const alpha = night > 0.4 ? tw * 0.5 * night : tw * 0.3;
    ctx.fillStyle = night > 0.4
      ? `rgba(190, 205, 255, ${alpha})`
      : `rgba(255, 240, 200, ${alpha})`;
    ctx.fillRect(g.x, g.y, 1.4, 1.4);
  }

  // Fireflies over the marsh.
  for (const f of view.fireflies) {
    const blink = Math.max(0, Math.sin(tReal * 0.005 + f.phase));
    if (blink < 0.2) continue;
    const a = blink * 0.9 * night;
    ctx.fillStyle = `rgba(190, 235, 110, ${a})`;
    ctx.beginPath();
    ctx.arc(f.x, f.y, 0.9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(190, 235, 110, ${a * 0.25})`;
    ctx.beginPath();
    ctx.arc(f.x, f.y, 2.4, 0, Math.PI * 2);
    ctx.fill();
  }

  // The hearth: a breathing pool of warmth in the dark.
  const s = agent.shelter;
  if (s && s.fireLit && night > 0.05) {
    const fx = s.x * CFG.TILE + 9, fy = s.y * CFG.TILE + 2;
    const flicker = 0.85 + Math.sin(tReal * 0.011) * 0.08 + Math.sin(tReal * 0.037) * 0.07;
    const r = 26 * flicker;
    const glow = ctx.createRadialGradient(fx, fy, 1, fx, fy, r);
    glow.addColorStop(0, `rgba(255, 190, 90, ${0.75 * night})`);
    glow.addColorStop(0.35, `rgba(230, 130, 40, ${0.35 * night})`);
    glow.addColorStop(1, "rgba(180, 80, 20, 0)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(fx, fy, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// ── Frame ───────────────────────────────────────────────────────────────

// Leader line from the agent panel (bottom-left) out to wherever Adapa is,
// with a pulsing ring — drawn above the lighting so it reads at night too.
function drawAgentTracker(ctx, tReal) {
  if (!view.trackAgent || !agent.alive) return;
  const ax = agent.x * CFG.TILE, ay = agent.y * CFG.TILE;
  // The panel sits 12px from the bottom-left corner; anchor at its top edge.
  const anchorX = 24, anchorY = view.px - 76;
  const pulse = 0.5 + 0.5 * Math.sin(tReal * 0.004);

  ctx.save();
  ctx.strokeStyle = `rgba(216, 168, 90, ${0.35 + pulse * 0.2})`;
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 5]);
  ctx.lineDashOffset = -tReal * 0.02;
  ctx.beginPath();
  ctx.moveTo(anchorX, anchorY);
  ctx.lineTo(ax, ay);
  ctx.stroke();
  ctx.setLineDash([]);

  const r = 8 + pulse * 3;
  ctx.strokeStyle = `rgba(216, 168, 90, ${0.8 - pulse * 0.3})`;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(ax, ay, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = "rgba(255, 230, 170, 0.9)";
  ctx.beginPath();
  ctx.arc(ax, ay, 5, 0, Math.PI * 2);
  ctx.stroke();

  // His current doing, floating beside him.
  ctx.font = "11px Georgia, serif";
  ctx.textAlign = ax > view.px - 180 ? "right" : "left";
  const tx = ax > view.px - 180 ? ax - 14 : ax + 14;
  ctx.fillStyle = "rgba(10, 8, 4, 0.65)";
  const label = agent.task;
  const w = ctx.measureText(label).width;
  ctx.fillRect(ctx.textAlign === "right" ? tx - w - 5 : tx - 5, ay - 14, w + 10, 16);
  ctx.fillStyle = "rgb(240, 216, 160)";
  ctx.fillText(label, tx, ay - 2);
  ctx.restore();
}

function renderFrame(tReal) {
  const ctx = view.ctx;
  ctx.drawImage(view.terrainLayer, 0, 0);
  drawFloodWater(ctx);
  drawWaterShimmer(ctx, tReal);
  ctx.drawImage(view.floraLayer, 0, 0);

  drawShelter(ctx);
  for (const a of animals) drawAnimal(ctx, a, tReal);
  drawAgent(ctx, tReal);

  drawLighting(ctx, tReal);
  drawAgentTracker(ctx, tReal);
}

function initRender(canvas) {
  view.canvas = canvas;
  canvas.width = view.px;
  canvas.height = view.px;
  view.ctx = canvas.getContext("2d");
  bakeTerrain();
  bakeFlora();
  rebuildWetTiles();
  initGlints();
}
