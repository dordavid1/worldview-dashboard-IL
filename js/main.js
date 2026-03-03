/* WorldView – Free & Legal Edition (2 files only)
   Layers: OpenSky (via Worker proxy), CelesTrak satellites (TLE), USGS quakes, Traffic glow (sim), CCTV ground projection (authorized URLs)
   Replay: 24h local snapshots using IndexedDB
*/

(() => {
  const CFG = {
    // Put your Worker URL here once you deploy it:
    // Example: https://worldview-opensky-proxy.YOURNAME.workers.dev
    OPENSKY_PROXY: window.WORLDVIEW_OPENSKY_PROXY || "",

    // Update rates
    REFRESH_MS: 12_000,
    SAT_UPDATE_MS: 5_000,
    REPLAY_SNAPSHOT_MS: 10_000,

    // Limits (scaled by density slider)
    MAX_FLIGHTS: 7000,
    MAX_SATS: 2500,
    MAX_QUAKES: 200,

    // Home view
    HOME: { lat: 31.7683, lon: 35.2137, height: 3_500_000 }, // Jerusalem-ish

    // Free legal feeds
    USGS_DAY: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson",
    CELESTRAK_ACTIVE: "https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle",

    // 2D map tiles
    OSM_TILES: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
  };

  // ---- Helpers ----
  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const nowISO = () => new Date().toISOString();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function densityFactor() {
    return clamp(parseInt($("density").value, 10) / 100, 0.05, 1);
  }

  // ---- IndexedDB (Replay 24h) ----
  const DB_NAME = "worldview_replay";
  const DB_STORE = "snapshots";

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        const store = db.createObjectStore(DB_STORE, { keyPath: "ts" });
        store.createIndex("ts", "ts", { unique: true });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbPutSnapshot(db, snap) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).put(snap);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  async function dbGetSnapshotAtOrBefore(db, ts) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readonly");
      const store = tx.objectStore(DB_STORE);
      const req = store.openCursor(IDBKeyRange.upperBound(ts), "prev");
      req.onsuccess = () => resolve(req.result ? req.result.value : null);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbPruneOlderThan(db, cutoffTs) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readwrite");
      const store = tx.objectStore(DB_STORE);
      const req = store.openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return resolve();
        if (cur.value.ts < cutoffTs) cur.delete();
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  // ---- Cesium init ----
  let viewer;
  let leafletMap;
  let db;

  // Entity collections (fast-ish)
  let flightsDS, satsDS, quakesDS, trafficDS, cctvDS;

  // Replay state
  let mode = "LIVE"; // LIVE | REPLAY
  let replayMinutesAgo = 0;
  let playTimer = null;

  // FX state (simple post-process)
  let fxStages = {
    bloom: null,
    sharpen: null,
    noise: null,
    nvg: null,
    flir: null,
    crt: null,
    noir: null,
    snow: null,
    anime: null,
  };
  let activeStyle = "Normal";

  // In-memory latest snapshot (for immediate draw)
  const latest = {
    flights: [],
    sats: [],
    quakes: [],
    traffic: [],
    time: null,
  };

  // ---- UI ----
  function setTelemetry(entityCount) {
    $("telMode").textContent = activeStyle;
    $("telEntities").textContent = String(entityCount ?? "—");
    $("telTime").textContent = mode === "LIVE" ? "LIVE" : `T-${replayMinutesAgo}m`;
  }

  function setReplayLabel() {
    if (mode === "LIVE") {
      $("replayLabel").textContent = "Mode: LIVE";
      $("liveBtn").classList.add("primary");
    } else {
      $("replayLabel").textContent = `Mode: REPLAY (T-${replayMinutesAgo}m)`;
      $("liveBtn").classList.remove("primary");
    }
  }

  function setCleanUI(on) {
    document.body.classList.toggle("hiddenUI", on);
  }

  // ---- Styles / PostFX (simple + stable) ----
  function buildFXStages() {
    // Noise
    fxStages.noise = new Cesium.PostProcessStage({
      name: "wv_noise",
      fragmentShader: `
        uniform sampler2D colorTexture;
        uniform float intensity;
        varying vec2 v_textureCoordinates;
        float rand(vec2 co){ return fract(sin(dot(co.xy ,vec2(12.9898,78.233))) * 43758.5453); }
        void main(){
          vec4 c = texture2D(colorTexture, v_textureCoordinates);
          float r = rand(v_textureCoordinates * 1000.0);
          c.rgb += (r - 0.5) * intensity;
          gl_FragColor = c;
        }`,
      uniforms: { intensity: 0.08 },
    });

    // Sharpen (small)
    fxStages.sharpen = new Cesium.PostProcessStage({
      name: "wv_sharpen",
      fragmentShader: `
        uniform sampler2D colorTexture;
        uniform float strength;
        varying vec2 v_textureCoordinates;
        void main(){
          vec2 px = vec2(1.0) / vec2(textureSize(colorTexture, 0));
          vec3 c = texture2D(colorTexture, v_textureCoordinates).rgb;
          vec3 n = texture2D(colorTexture, v_textureCoordinates + vec2(0.0, px.y)).rgb;
          vec3 s = texture2D(colorTexture, v_textureCoordinates - vec2(0.0, px.y)).rgb;
          vec3 e = texture2D(colorTexture, v_textureCoordinates + vec2(px.x, 0.0)).rgb;
          vec3 w = texture2D(colorTexture, v_textureCoordinates - vec2(px.x, 0.0)).rgb;
          vec3 lap = (n + s + e + w) - 4.0*c;
          vec3 outc = c - lap * strength;
          gl_FragColor = vec4(outc, 1.0);
        }`,
      uniforms: { strength: 0.08 },
    });

    // NVG tint
    fxStages.nvg = new Cesium.PostProcessStage({
      name: "wv_nvg",
      fragmentShader: `
        uniform sampler2D colorTexture;
        uniform float amount;
        varying vec2 v_textureCoordinates;
        void main(){
          vec4 c = texture2D(colorTexture, v_textureCoordinates);
          float l = dot(c.rgb, vec3(0.299,0.587,0.114));
          vec3 green = vec3(0.1, 1.0, 0.2) * l;
          vec3 outc = mix(c.rgb, green, amount);
          gl_FragColor = vec4(outc, c.a);
        }`,
      uniforms: { amount: 0.85 },
    });

    // FLIR-like (false color)
    fxStages.flir = new Cesium.PostProcessStage({
      name: "wv_flir",
      fragmentShader: `
        uniform sampler2D colorTexture;
        uniform float amount;
        varying vec2 v_textureCoordinates;

        vec3 heat(float t){
          t = clamp(t,0.0,1.0);
          // simple thermal ramp
          vec3 c1 = vec3(0.0,0.0,0.0);
          vec3 c2 = vec3(0.1,0.0,0.4);
          vec3 c3 = vec3(0.9,0.2,0.0);
          vec3 c4 = vec3(1.0,1.0,0.9);
          if(t < 0.33) return mix(c1,c2,t/0.33);
          if(t < 0.66) return mix(c2,c3,(t-0.33)/0.33);
          return mix(c3,c4,(t-0.66)/0.34);
        }

        void main(){
          vec4 c = texture2D(colorTexture, v_textureCoordinates);
          float l = dot(c.rgb, vec3(0.299,0.587,0.114));
          vec3 h = heat(pow(l, 0.9));
          vec3 outc = mix(c.rgb, h, amount);
          gl_FragColor = vec4(outc, c.a);
        }`,
      uniforms: { amount: 0.95 },
    });

    // Noir
    fxStages.noir = new Cesium.PostProcessStage({
      name: "wv_noir",
      fragmentShader: `
        uniform sampler2D colorTexture;
        uniform float amount;
        varying vec2 v_textureCoordinates;
        void main(){
          vec4 c = texture2D(colorTexture, v_textureCoordinates);
          float l = dot(c.rgb, vec3(0.299,0.587,0.114));
          l = smoothstep(0.05, 0.95, l);
          vec3 g = vec3(l);
          gl_FragColor = vec4(mix(c.rgb, g, amount), c.a);
        }`,
      uniforms: { amount: 1.0 },
    });

    // Snow (simple bright + cool)
    fxStages.snow = new Cesium.PostProcessStage({
      name: "wv_snow",
      fragmentShader: `
        uniform sampler2D colorTexture;
        uniform float amount;
        varying vec2 v_textureCoordinates;
        void main(){
          vec4 c = texture2D(colorTexture, v_textureCoordinates);
          vec3 cool = c.rgb + vec3(0.08, 0.10, 0.14);
          vec3 outc = mix(c.rgb, cool, amount);
          gl_FragColor = vec4(outc, c.a);
        }`,
      uniforms: { amount: 0.8 },
    });

    // Anime-ish (posterize)
    fxStages.anime = new Cesium.PostProcessStage({
      name: "wv_anime",
      fragmentShader: `
        uniform sampler2D colorTexture;
        uniform float amount;
        varying vec2 v_textureCoordinates;
        float poster(float x){ return floor(x * 6.0)/6.0; }
        void main(){
          vec4 c = texture2D(colorTexture, v_textureCoordinates);
          vec3 p = vec3(poster(c.r), poster(c.g), poster(c.b));
          gl_FragColor = vec4(mix(c.rgb, p, amount), c.a);
        }`,
      uniforms: { amount: 0.95 },
    });

    // Add stages in a stable order (we enable/disable by style)
    viewer.scene.postProcessStages.add(fxStages.noise);
    viewer.scene.postProcessStages.add(fxStages.sharpen);
    viewer.scene.postProcessStages.add(fxStages.nvg);
    viewer.scene.postProcessStages.add(fxStages.flir);
    viewer.scene.postProcessStages.add(fxStages.noir);
    viewer.scene.postProcessStages.add(fxStages.snow);
    viewer.scene.postProcessStages.add(fxStages.anime);

    // Default: all off except base noise/sharpen controlled by sliders
    fxStages.nvg.enabled = false;
    fxStages.flir.enabled = false;
    fxStages.noir.enabled = false;
    fxStages.snow.enabled = false;
    fxStages.anime.enabled = false;
  }

  function applyStyle(name) {
    activeStyle = name;
    $("telMode").textContent = name;

    // Toggle CRT overlay DOM
    const crtOverlay = document.getElementById("crtOverlay");
    crtOverlay.style.opacity = name === "CRT" ? "0.40" : "0";

    // PostFX toggles
    fxStages.nvg.enabled = name === "NVG";
    fxStages.flir.enabled = name === "FLIR";
    fxStages.noir.enabled = name === "Noir";
    fxStages.snow.enabled = name === "Snow";
    fxStages.anime.enabled = name === "Anime";

    // Normal / CRT keep these off
    if (name === "Normal" || name === "CRT") {
      fxStages.nvg.enabled = false;
      fxStages.flir.enabled = false;
      fxStages.noir.enabled = false;
      fxStages.snow.enabled = false;
      fxStages.anime.enabled = false;
    }
  }

  function wireFXSliders() {
    $("fxNoise").addEventListener("input", () => {
      const v = parseInt($("fxNoise").value, 10) / 100;
      fxStages.noise.uniforms.intensity = 0.22 * v;
    });
    $("fxSharpen").addEventListener("input", () => {
      const v = parseInt($("fxSharpen").value, 10) / 100;
      fxStages.sharpen.uniforms.strength = 0.18 * v;
    });
    // "Bloom" placeholder: Cesium has bloom stage but can be unstable across devices; keep as UI-only now.
    $("fxBloom").addEventListener("input", () => {});
  }

  function buildStyleBar() {
    const styles = ["Normal", "CRT", "NVG", "FLIR", "Noir", "Snow", "Anime"];
    const bar = document.getElementById("styleBar");
    bar.innerHTML = "";
    styles.forEach((s) => {
      const btn = document.createElement("button");
      btn.textContent = s;
      btn.className = s === "Normal" ? "active" : "";
      btn.onclick = () => {
        [...bar.querySelectorAll("button")].forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        applyStyle(s);
      };
      bar.appendChild(btn);
    });
  }

  // ---- Data Sources ----
  async function fetchQuakes() {
    const resp = await fetch(CFG.USGS_DAY, { cache: "no-store" });
    if (!resp.ok) throw new Error("USGS fetch failed");
    const geo = await resp.json();

    const fac = densityFactor();
    const max = Math.floor(CFG.MAX_QUAKES * fac);

    const feats = (geo.features || [])
      .slice()
      .sort((a, b) => (b.properties?.mag || 0) - (a.properties?.mag || 0))
      .slice(0, max);

    return feats.map((f) => ({
      id: f.id,
      mag: f.properties?.mag ?? 0,
      place: f.properties?.place ?? "",
      time: f.properties?.time ?? Date.now(),
      lon: f.geometry?.coordinates?.[0],
      lat: f.geometry?.coordinates?.[1],
      depthKm: f.geometry?.coordinates?.[2] ?? 0,
    }));
  }

  async function fetchTLE() {
    const resp = await fetch(CFG.CELESTRAK_ACTIVE, { cache: "no-store" });
    if (!resp.ok) throw new Error("CelesTrak fetch failed");
    const text = await resp.text();
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const sats = [];
    for (let i = 0; i < lines.length - 2; i += 3) {
      const name = lines[i];
      const line1 = lines[i + 1];
      const line2 = lines[i + 2];
      if (line1?.startsWith("1 ") && line2?.startsWith("2 ")) {
        sats.push({ name, line1, line2 });
      }
    }
    // density cap
    const fac = densityFactor();
    const max = Math.floor(CFG.MAX_SATS * fac);
    return sats.slice(0, max);
  }

  async function fetchOpenSky() {
    // OpenSky needs proxy for CORS. If no proxy configured, we return demo flights.
    if (!CFG.OPENSKY_PROXY) return demoFlights();

    const url = `${CFG.OPENSKY_PROXY}/opensky/states`;
    const resp = await fetch(url, { cache: "no-store" });
    if (!resp.ok) throw new Error("OpenSky proxy fetch failed");
    const data = await resp.json();

    const fac = densityFactor();
    const max = Math.floor(CFG.MAX_FLIGHTS * fac);

    const states = (data.states || []).slice(0, max);

    return states
      .filter((s) => typeof s[6] === "number" && typeof s[5] === "number") // lat/lon
      .map((s) => ({
        icao24: s[0],
        callsign: (s[1] || "").trim(),
        lon: s[5],
        lat: s[6],
        baroAlt: s[7] ?? null,
        vel: s[9] ?? null,
        heading: s[10] ?? null,
        time: data.time ? data.time * 1000 : Date.now(),
      }));
  }

  function demoFlights() {
    // Looks alive even without proxy
    const fac = densityFactor();
    const n = Math.floor(1200 * fac);
    const out = [];
    const t = Date.now();
    for (let i = 0; i < n; i++) {
      const lat = -60 + Math.random() * 120;
      const lon = -180 + Math.random() * 360;
      out.push({
        icao24: `demo${i}`,
        callsign: `DEMO-${i}`,
        lat,
        lon,
        baroAlt: 9000 + Math.random() * 2000,
        vel: 220 + Math.random() * 180,
        heading: Math.random() * 360,
        time: t,
      });
    }
    return out;
  }

  function buildTrafficSim() {
    // Simple glowing “arteries” around a few cities (looks like flow)
    const fac = densityFactor();
    const n = Math.floor(300 * fac);

    const hubs = [
      { name: "London", lat: 51.5074, lon: -0.1278 },
      { name: "NYC", lat: 40.7128, lon: -74.006 },
      { name: "TelAviv", lat: 32.0853, lon: 34.7818 },
      { name: "Tokyo", lat: 35.6762, lon: 139.6503 },
      { name: "SF", lat: 37.7749, lon: -122.4194 },
    ];

    const paths = [];
    for (let i = 0; i < n; i++) {
      const h = hubs[i % hubs.length];
      const a = {
        lat: h.lat + (Math.random() - 0.5) * 0.35,
        lon: h.lon + (Math.random() - 0.5) * 0.55,
      };
      const b = {
        lat: h.lat + (Math.random() - 0.5) * 0.35,
        lon: h.lon + (Math.random() - 0.5) * 0.55,
      };
      paths.push({
        id: `t${i}`,
        a,
        b,
        speed: 0.5 + Math.random() * 1.6,
      });
    }
    return paths;
  }

  // ---- Rendering ----
  function ensureDataSources() {
    flightsDS = flightsDS || viewer.dataSources.add(new Cesium.CustomDataSource("flights"));
    satsDS = satsDS || viewer.dataSources.add(new Cesium.CustomDataSource("sats"));
    quakesDS = quakesDS || viewer.dataSources.add(new Cesium.CustomDataSource("quakes"));
    trafficDS = trafficDS || viewer.dataSources.add(new Cesium.CustomDataSource("traffic"));
    cctvDS = cctvDS || viewer.dataSources.add(new Cesium.CustomDataSource("cctv"));
  }

  function clearDS(ds) {
    if (!ds) return;
    ds.entities.removeAll();
  }

  function drawQuakes(items) {
    clearDS(quakesDS);
    const ds = quakesDS;

    items.forEach((q) => {
      const size = clamp(6 + q.mag * 2.2, 6, 26);
      ds.entities.add({
        id: `q_${q.id}`,
        position: Cesium.Cartesian3.fromDegrees(q.lon, q.lat, 0),
        point: {
          pixelSize: size,
          color: Cesium.Color.fromCssColorString("rgba(255,160,0,0.85)"),
          outlineColor: Cesium.Color.fromCssColorString("rgba(0,0,0,0.6)"),
          outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: q.mag >= 5
          ? {
              text: `${q.mag.toFixed(1)}`,
              font: "12px sans-serif",
              fillColor: Cesium.Color.WHITE,
              showBackground: true,
              backgroundColor: Cesium.Color.fromCssColorString("rgba(0,0,0,0.55)"),
              pixelOffset: new Cesium.Cartesian2(0, -18),
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            }
          : undefined,
      });
    });
  }

  function drawFlights(items) {
    clearDS(flightsDS);
    const ds = flightsDS;

    items.forEach((f) => {
      const alt = f.baroAlt ? clamp(f.baroAlt, 0, 16000) : 10000;

      // simple aircraft arrow as point + label
      ds.entities.add({
        id: `f_${f.icao24}`,
        position: Cesium.Cartesian3.fromDegrees(f.lon, f.lat, alt),
        point: {
          pixelSize: 4,
          color: Cesium.Color.CYAN.withAlpha(0.85),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: (f.callsign && f.callsign.length)
          ? {
              text: f.callsign,
              font: "11px sans-serif",
              fillColor: Cesium.Color.WHITE.withAlpha(0.9),
              showBackground: true,
              backgroundColor: Cesium.Color.fromCssColorString("rgba(0,0,0,0.45)"),
              pixelOffset: new Cesium.Cartesian2(10, -10),
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
              distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0.0, 2.5e6),
            }
          : undefined,
      });
    });
  }

  // Satellites: draw points; update positions from TLE every SAT_UPDATE_MS
  let satCatalog = [];
  let satTickTimer = null;

  function initSatCatalog(tleList) {
    satCatalog = tleList.map((s, idx) => {
      const satrec = satellite.twoline2satrec(s.line1, s.line2);
      return { id: `s_${idx}`, name: s.name, satrec };
    });
  }

  function drawSatPoints() {
    clearDS(satsDS);
    const ds = satsDS;
    const now = new Date();

    const fac = densityFactor();
    const showLabels = fac <= 0.30; // sparse shows labels like “SAT-xxxx”

    satCatalog.forEach((s, i) => {
      const eci = satellite.propagate(s.satrec, now);
      if (!eci.position) return;

      const gmst = satellite.gstime(now);
      const geo = satellite.eciToGeodetic(eci.position, gmst);
      const lon = Cesium.Math.toDegrees(geo.longitude);
      const lat = Cesium.Math.toDegrees(geo.latitude);
      const alt = geo.height * 1000;

      ds.entities.add({
        id: s.id,
        position: Cesium.Cartesian3.fromDegrees(lon, lat, alt),
        point: {
          pixelSize: 3,
          color: Cesium.Color.ORANGE.withAlpha(0.85),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: showLabels
          ? {
              text: `SAT-${i}`,
              font: "10px sans-serif",
              fillColor: Cesium.Color.WHITE.withAlpha(0.85),
              showBackground: true,
              backgroundColor: Cesium.Color.fromCssColorString("rgba(0,0,0,0.45)"),
              pixelOffset: new Cesium.Cartesian2(8, -8),
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
              distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0.0, 2.0e6),
            }
          : undefined,
      });
    });
  }

  function startSatUpdates() {
    if (satTickTimer) clearInterval(satTickTimer);
    satTickTimer = setInterval(() => {
      if (mode !== "LIVE") return; // live only
      if (!$("satsToggle").checked) return;
      drawSatPoints();
      setTelemetry(countAllEntities());
    }, CFG.SAT_UPDATE_MS);
  }

  // Traffic glow: moving dots along line segments
  let trafficPaths = [];
  let trafficTime0 = performance.now();

  function drawTraffic() {
    clearDS(trafficDS);
    const ds = trafficDS;
    trafficPaths.forEach((p) => {
      ds.entities.add({
        id: `road_${p.id}`,
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray([p.a.lon, p.a.lat, p.b.lon, p.b.lat]),
          width: 2,
          material: Cesium.Color.GOLD.withAlpha(0.25),
          clampToGround: true,
        },
      });
    });
  }

  function startTrafficAnimation() {
    viewer.clock.onTick.addEventListener(() => {
      if (mode !== "LIVE") return;
      if (!$("trafficToggle").checked) return;

      // animate "heads" (glow points) by reusing small number for performance
      const t = (performance.now() - trafficTime0) / 1000;
      // remove old heads
      trafficDS.entities.values
        .filter((e) => e.id && String(e.id).startsWith("head_"))
        .forEach((e) => trafficDS.entities.remove(e));

      const fac = densityFactor();
      const heads = Math.floor(120 * fac);

      for (let i = 0; i < heads; i++) {
        const p = trafficPaths[(i * 7) % trafficPaths.length];
        const u = (t * p.speed * 0.07 + i * 0.01) % 1;
        const lat = p.a.lat + (p.b.lat - p.a.lat) * u;
        const lon = p.a.lon + (p.b.lon - p.a.lon) * u;

        trafficDS.entities.add({
          id: `head_${i}`,
          position: Cesium.Cartesian3.fromDegrees(lon, lat, 0),
          point: {
            pixelSize: 5,
            color: Cesium.Color.GOLD.withAlpha(0.85),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
      }
    });
  }

  // CCTV projection: draw video to canvas → use as image material on rectangle
  let cctv = {
    video: null,
    canvas: null,
    ctx: null,
    entityId: "cctv_rect",
    anim: null,
  };

  async function addCCTVProjection(url, lat, lon) {
    // Basic safety: only proceed if user enabled CCTV layer
    if (!$("cctvToggle").checked) $("cctvToggle").checked = true;

    // Create video element
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.autoplay = true;
    video.src = url;

    // Canvas
    const canvas = document.createElement("canvas");
    canvas.width = 1024;
    canvas.height = 576;
    const ctx = canvas.getContext("2d");

    await video.play().catch(() => {
      // If autoplay blocked, user may need to tap once on page, then click Project again
      console.warn("Autoplay blocked. Tap page once then press Project again.");
    });

    cctv.video = video;
    cctv.canvas = canvas;
    cctv.ctx = ctx;

    // Remove previous
    cctvDS.entities.removeById(cctv.entityId);

    // Project onto small ground rectangle near lat/lon
    const dLat = 0.03;
    const dLon = 0.045;

    const rect = Cesium.Rectangle.fromDegrees(lon - dLon, lat - dLat, lon + dLon, lat + dLat);

    cctvDS.entities.add({
      id: cctv.entityId,
      rectangle: {
        coordinates: rect,
        material: new Cesium.ImageMaterialProperty({
          image: canvas,
          transparent: true,
        }),
        height: 0,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      },
    });

    // Animation loop: paint frames to canvas
    if (cctv.anim) cancelAnimationFrame(cctv.anim);
    const loop = () => {
      if (!$("cctvToggle").checked) return;
      if (video.readyState >= 2) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      }
      cctv.anim = requestAnimationFrame(loop);
    };
    loop();
  }

  // ---- Replay engine ----
  async function takeSnapshot() {
    const ts = Date.now();
    const snap = {
      ts,
      flights: latest.flights,
      sats: latest.sats,
      quakes: latest.quakes,
      traffic: latest.traffic,
    };
    await dbPutSnapshot(db, snap);

    // prune >24h
    const cutoff = ts - 24 * 60 * 60 * 1000;
    await dbPruneOlderThan(db, cutoff);
  }

  async function showSnapshotMinutesAgo(minAgo) {
    const ts = Date.now() - minAgo * 60 * 1000;
    const snap = await dbGetSnapshotAtOrBefore(db, ts);
    if (!snap) return;

    if ($("flightsToggle").checked) drawFlights(snap.flights || []);
    else clearDS(flightsDS);

    if ($("satsToggle").checked) {
      // satellites snapshot stores precomputed positions (we store them below)
      clearDS(satsDS);
      const ds = satsDS;
      (snap.sats || []).forEach((s, i) => {
        ds.entities.add({
          id: `rs_${i}`,
          position: Cesium.Cartesian3.fromDegrees(s.lon, s.lat, s.alt),
          point: { pixelSize: 3, color: Cesium.Color.ORANGE.withAlpha(0.85), disableDepthTestDistance: Number.POSITIVE_INFINITY },
        });
      });
    } else clearDS(satsDS);

    if ($("quakesToggle").checked) drawQuakes(snap.quakes || []);
    else clearDS(quakesDS);

    if ($("trafficToggle").checked) {
      trafficPaths = snap.traffic || [];
      drawTraffic();
    } else clearDS(trafficDS);

    setTelemetry(countAllEntities());
  }

  function enterLive() {
    mode = "LIVE";
    replayMinutesAgo = 0;
    $("replaySlider").value = "0";
    setReplayLabel();
  }

  function enterReplay(minAgo) {
    mode = "REPLAY";
    replayMinutesAgo = clamp(minAgo, 0, 1440);
    setReplayLabel();
  }

  function stopPlay() {
    if (playTimer) clearInterval(playTimer);
    playTimer = null;
  }

  function startPlay() {
    stopPlay();
    // play forward to LIVE by decreasing minutesAgo
    playTimer = setInterval(async () => {
      if (mode !== "REPLAY") return;
      replayMinutesAgo = clamp(replayMinutesAgo - 1, 0, 1440);
      $("replaySlider").value = String(replayMinutesAgo);
      if (replayMinutesAgo === 0) {
        stopPlay();
        enterLive();
        return;
      }
      await showSnapshotMinutesAgo(replayMinutesAgo);
    }, 500);
  }

  // ---- Main refresh loop ----
  async function refreshOnce() {
    ensureDataSources();

    const tasks = [];

    if ($("quakesToggle").checked) {
      tasks.push(
        fetchQuakes().then((q) => {
          latest.quakes = q;
          if (mode === "LIVE") drawQuakes(q);
        }).catch(console.warn)
      );
    } else {
      clearDS(quakesDS);
    }

    if ($("flightsToggle").checked) {
      tasks.push(
        fetchOpenSky().then((f) => {
          latest.flights = f;
          if (mode === "LIVE") drawFlights(f);
        }).catch((e) => {
          console.warn(e);
          // fallback demo
          const f = demoFlights();
          latest.flights = f;
          if (mode === "LIVE") drawFlights(f);
        })
      );
    } else {
      clearDS(flightsDS);
    }

    if ($("satsToggle").checked) {
      // satellites: store snapshot positions too
      tasks.push(
        (async () => {
          if (!satCatalog.length) {
            const tle = await fetchTLE();
            initSatCatalog(tle);
          }
          if (mode === "LIVE") drawSatPoints();

          // Snapshot positions for replay
          const now = new Date();
          const snapSats = [];
          satCatalog.forEach((s) => {
            const eci = satellite.propagate(s.satrec, now);
            if (!eci.position) return;
            const gmst = satellite.gstime(now);
            const geo = satellite.eciToGeodetic(eci.position, gmst);
            snapSats.push({
              lon: Cesium.Math.toDegrees(geo.longitude),
              lat: Cesium.Math.toDegrees(geo.latitude),
              alt: geo.height * 1000,
            });
          });
          latest.sats = snapSats;
        })().catch(console.warn)
      );
    } else {
      clearDS(satsDS);
    }

    if ($("trafficToggle").checked) {
      tasks.push(
        (async () => {
          if (!trafficPaths.length) trafficPaths = buildTrafficSim();
          latest.traffic = trafficPaths;
          if (mode === "LIVE") drawTraffic();
        })()
      );
    } else {
      clearDS(trafficDS);
    }

    await Promise.allSettled(tasks);

    // Sync 2D map view to Cesium camera center
    sync2DTo3D();

    setTelemetry(countAllEntities());
    if (mode === "LIVE") await takeSnapshot();
  }

  function countAllEntities() {
    const ds = [flightsDS, satsDS, quakesDS, trafficDS, cctvDS].filter(Boolean);
    return ds.reduce((acc, d) => acc + (d.entities?.values?.length || 0), 0);
  }

  // ---- 2D map sync ----
  function init2DMap() {
    leafletMap = L.map("map2d", { zoomControl: false, attributionControl: false }).setView([CFG.HOME.lat, CFG.HOME.lon], 5);
    L.tileLayer(CFG.OSM_TILES, { maxZoom: 18 }).addTo(leafletMap);
  }

  function sync2DTo3D() {
    if (!leafletMap || !viewer) return;
    const c = viewer.camera.positionCartographic;
    const lat = Cesium.Math.toDegrees(c.latitude);
    const lon = Cesium.Math.toDegrees(c.longitude);
    // Gentle update (no jump every frame)
    leafletMap.setView([lat, lon], leafletMap.getZoom(), { animate: false });
  }

  // ---- UI wiring ----
  function wireUI() {
    $("refreshBtn").onclick = () => refreshOnce().catch(console.warn);

    $("homeBtn").onclick = () => {
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(CFG.HOME.lon, CFG.HOME.lat, CFG.HOME.height),
      });
    };

    let clean = false;
    $("cleanBtn").onclick = () => {
      clean = !clean;
      setCleanUI(clean);
    };

    // Any toggle triggers refresh
    ["flightsToggle", "satsToggle", "quakesToggle", "trafficToggle", "cctvToggle"].forEach((id) => {
      $(id).addEventListener("change", () => refreshOnce().catch(console.warn));
    });

    $("density").addEventListener("input", () => {
      // refresh with new caps
      refreshOnce().catch(console.warn);
    });

    // Replay controls
    $("liveBtn").onclick = () => {
      stopPlay();
      enterLive();
      refreshOnce().catch(console.warn);
    };
    $("playBtn").onclick = () => {
      if (mode !== "REPLAY") {
        enterReplay(parseInt($("replaySlider").value, 10) || 60);
      }
      startPlay();
    };
    $("pauseBtn").onclick = () => stopPlay();

    $("replaySlider").addEventListener("input", async () => {
      const minAgo = parseInt($("replaySlider").value, 10) || 0;
      if (minAgo === 0) {
        enterLive();
        await refreshOnce().catch(console.warn);
        return;
      }
      stopPlay();
      enterReplay(minAgo);
      await showSnapshotMinutesAgo(replayMinutesAgo).catch(console.warn);
    });

    // CCTV projection
    $("cctvAddBtn").onclick = async () => {
      const url = $("cctvUrl").value.trim();
      const lat = parseFloat($("cctvLat").value);
      const lon = parseFloat($("cctvLon").value);
      if (!url || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
      try {
        await addCCTVProjection(url, lat, lon);
      } catch (e) {
        console.warn(e);
      }
    };
  }

  // ---- Boot ----
  async function boot() {
    // Wait for libs
    while (!window.Cesium || !window.satellite || !window.L) await sleep(30);

    // Cesium viewer (no Ion token needed for this basic setup)
    viewer = new Cesium.Viewer("viewer", {
      animation: false,
      timeline: false,
      geocoder: false,
      homeButton: false,
      baseLayerPicker: false,
      navigationHelpButton: false,
      sceneModePicker: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      shouldAnimate: true,
    });

    // Cheap base imagery (legal, free)
    viewer.imageryLayers.removeAll();
    viewer.imageryLayers.addImageryProvider(
      new Cesium.OpenStreetMapImageryProvider({
        url: "https://a.tile.openstreetmap.org/",
      })
    );

    // Start at home
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(CFG.HOME.lon, CFG.HOME.lat, CFG.HOME.height),
    });

    ensureDataSources();
    init2DMap();
    buildStyleBar();
    buildFXStages();
    wireFXSliders();
    wireUI();
    applyStyle("Normal");
    setReplayLabel();

    // FPS telemetry
    let last = performance.now();
    let frames = 0;
    viewer.scene.postRender.addEventListener(() => {
      frames++;
      const now = performance.now();
      if (now - last >= 1000) {
        $("telFps").textContent = String(frames);
        frames = 0;
        last = now;
      }
    });

    // Open DB for replay
    db = await openDB();

    // Traffic anim tick
    startTrafficAnimation();

    // Periodic refresh + snapshots
    await refreshOnce().catch(console.warn);
    startSatUpdates();

    setInterval(() => {
      if (mode !== "LIVE") return;
      refreshOnce().catch(console.warn);
    }, CFG.REFRESH_MS);

    setInterval(() => {
      if (mode !== "LIVE") return;
      takeSnapshot().catch(console.warn);
    }, CFG.REPLAY_SNAPSHOT_MS);
  }

  window.addEventListener("load", () => boot().catch(console.warn));
})();
