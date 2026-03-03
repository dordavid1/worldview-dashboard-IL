/* WorldView – Free & Legal Edition
   - Cesium globe + tactical UI
   - USGS quakes (GeoJSON)
   - CelesTrak satellites (TLE) + satellite.js propagation
   - Flights: reliable demo by default (upgrade to OpenSky via proxy later)
   - PostFX presets (CRT/NVG/FLIR/Noir/Snow/Anime) – stylized, not real sensors
   - Leaflet mini 2D map synced with camera target
*/

(function () {
  const STATE = {
    mode: "NORMAL",
    cleanUI: false,
    layers: { flights: true, sats: true, quakes: true },
    density: 0.6,
    fx: { bloom: 0.35, sharpen: 0.25, noise: 0.2 },
    entitiesCount: 0,
  };

  const MODES = [
    { id: "NORMAL", label: "Normal" },
    { id: "CRT", label: "CRT" },
    { id: "NVG", label: "NVG" },
    { id: "FLIR", label: "FLIR" },
    { id: "NOIR", label: "Noir" },
    { id: "SNOW", label: "Snow" },
    { id: "ANIME", label: "Anime" },
  ];

  const el = (id) => document.getElementById(id);

  function clamp01(x) { return Math.max(0, Math.min(1, x)); }

  function init() {
    if (!window.Cesium) {
      // If Cesium didn't load yet, retry quickly
      setTimeout(init, 60);
      return;
    }

    // ---- Cesium Viewer ----
    Cesium.Ion.defaultAccessToken = ""; // optional, not needed for basic

    const viewer = new Cesium.Viewer("viewer", {
      animation: false,
      timeline: false,
      sceneModePicker: false,
      geocoder: true,
      homeButton: true,
      navigationHelpButton: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      baseLayerPicker: true, // keep the right imagery chooser (like your screenshot)
      shouldAnimate: true,
    });

    // Make it feel "tactical"
    viewer.scene.skyBox = undefined;
    viewer.scene.sun.show = false;
    viewer.scene.moon.show = false;
    viewer.scene.fog.enabled = true;
    viewer.scene.globe.enableLighting = false;

    // Default home
    const HOME = Cesium.Cartesian3.fromDegrees(34.7818, 32.0853, 2500000); // TLV-ish
    viewer.camera.setView({ destination: HOME });

    // ---- Leaflet 2D mini map ----
    let map2d = null;
    let camMarker = null;
    let quakeLayer2d = null;
    let flightLayer2d = null;

    function init2D() {
      if (!window.L) return setTimeout(init2D, 60);
      map2d = L.map("map2d", { zoomControl: false, attributionControl: false }).setView([32.0853, 34.7818], 5);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
      }).addTo(map2d);

      camMarker = L.circleMarker([32.0853, 34.7818], { radius: 6 }).addTo(map2d);
      quakeLayer2d = L.layerGroup().addTo(map2d);
      flightLayer2d = L.layerGroup().addTo(map2d);
    }
    init2D();

    // Sync 2D with camera center occasionally
    setInterval(() => {
      if (!map2d || !camMarker) return;
      const c = viewer.camera.positionCartographic;
      const lat = Cesium.Math.toDegrees(c.latitude);
      const lon = Cesium.Math.toDegrees(c.longitude);
      camMarker.setLatLng([lat, lon]);
      // Keep view gentle
      // map2d.setView([lat, lon], map2d.getZoom(), { animate: false });
    }, 800);

    // ---- UI wiring ----
    buildModeBar();

    el("flightsToggle").addEventListener("change", (e) => {
      STATE.layers.flights = e.target.checked;
      refreshAll();
    });
    el("satsToggle").addEventListener("change", (e) => {
      STATE.layers.sats = e.target.checked;
      refreshAll();
    });
    el("quakesToggle").addEventListener("change", (e) => {
      STATE.layers.quakes = e.target.checked;
      refreshAll();
    });

    el("density").addEventListener("input", (e) => {
      STATE.density = clamp01(Number(e.target.value) / 100);
      refreshAll();
    });

    el("bloom").addEventListener("input", (e) => {
      STATE.fx.bloom = clamp01(Number(e.target.value) / 100);
      applyFX();
    });
    el("sharpen").addEventListener("input", (e) => {
      STATE.fx.sharpen = clamp01(Number(e.target.value) / 100);
      applyFX();
    });
    el("noise").addEventListener("input", (e) => {
      STATE.fx.noise = clamp01(Number(e.target.value) / 100);
      applyFX();
    });

    el("refreshBtn").addEventListener("click", refreshAll);
    el("homeBtn").addEventListener("click", () => viewer.camera.flyTo({ destination: HOME, duration: 1.2 }));

    el("cleanBtn").addEventListener("click", () => {
      STATE.cleanUI = !STATE.cleanUI;
      document.getElementById("leftPanel").style.display = STATE.cleanUI ? "none" : "block";
      document.getElementById("rightPanel").style.display = STATE.cleanUI ? "none" : "block";
      document.getElementById("mapWrap").style.display = STATE.cleanUI ? "none" : "block";
      document.getElementById("styleBar").style.display = STATE.cleanUI ? "none" : "flex";
    });

    // ---- PostFX stages ----
    let stageNightVision = null;
    let stageBW = null;
    let stageEdge = null;
    let stageCRT = null;
    let stageTint = null;

    function createStages() {
      // NVG
      stageNightVision = Cesium.PostProcessStageLibrary.createNightVisionStage();
      stageNightVision.enabled = false;

      // BW (for Noir/FLIR base)
      stageBW = Cesium.PostProcessStageLibrary.createBlackAndWhiteStage();
      stageBW.enabled = false;

      // Edge (for Anime-ish)
      stageEdge = Cesium.PostProcessStageLibrary.createEdgeDetectionStage();
      stageEdge.enabled = false;
      stageEdge.uniforms.length = 0.25;

      // Tint + noise (custom)
      stageTint = new Cesium.PostProcessStage({
        name: "wv_tint_noise",
        fragmentShader: `
          uniform sampler2D colorTexture;
          uniform vec4 u_tint;       // rgba
          uniform float u_noise;     // 0..1
          uniform float u_time;
          varying vec2 v_textureCoordinates;

          float rand(vec2 co){
            return fract(sin(dot(co.xy ,vec2(12.9898,78.233))) * 43758.5453);
          }

          void main() {
            vec4 c = texture2D(colorTexture, v_textureCoordinates);

            // subtle tint
            c.rgb = mix(c.rgb, c.rgb * u_tint.rgb, u_tint.a);

            // noise
            float n = rand(v_textureCoordinates * (900.0 + u_time*0.1));
            c.rgb += (n - 0.5) * u_noise;

            gl_FragColor = c;
          }
        `,
        uniforms: {
          u_tint: new Cesium.Color(1.0, 1.0, 1.0, 0.0),
          u_noise: 0.0,
          u_time: 0.0,
        },
      });
      stageTint.enabled = true;

      // CRT warp/scanline feel (custom)
      stageCRT = new Cesium.PostProcessStage({
        name: "wv_crt",
        fragmentShader: `
          uniform sampler2D colorTexture;
          uniform float u_amount; // 0..1
          uniform float u_time;
          varying vec2 v_textureCoordinates;

          vec2 barrel(vec2 uv, float amt) {
            vec2 cc = uv - 0.5;
            float dist = dot(cc, cc);
            return uv + cc * dist * 0.25 * amt;
          }

          void main() {
            float amt = u_amount;
            vec2 uv = barrel(v_textureCoordinates, amt);

            vec4 col = texture2D(colorTexture, uv);

            // scanlines
            float scan = sin((uv.y * 900.0) + u_time * 6.0) * 0.04 * amt;
            col.rgb -= scan;

            // vignette
            vec2 p = uv - 0.5;
            float v = smoothstep(0.85, 0.25, dot(p,p));
            col.rgb *= mix(1.0, v, 0.65 * amt);

            // slight chroma split
            float off = 0.002 * amt;
            float r = texture2D(colorTexture, uv + vec2(off, 0.0)).r;
            float b = texture2D(colorTexture, uv - vec2(off, 0.0)).b;
            col.rgb = vec3(r, col.g, b);

            gl_FragColor = col;
          }
        `,
        uniforms: {
          u_amount: 0.0,
          u_time: 0.0,
        },
      });
      stageCRT.enabled = true;

      viewer.scene.postProcessStages.add(stageNightVision);
      viewer.scene.postProcessStages.add(stageBW);
      viewer.scene.postProcessStages.add(stageEdge);
      viewer.scene.postProcessStages.add(stageTint);
      viewer.scene.postProcessStages.add(stageCRT);
    }

    createStages();

    // Animate time uniform
    let t0 = performance.now();
    viewer.scene.preUpdate.addEventListener(() => {
      const t = (performance.now() - t0) / 1000;
      stageTint.uniforms.u_time = t;
      stageCRT.uniforms.u_time = t;
      telemetryTick(t);
    });

    function applyFX() {
      const mode = STATE.mode;

      // reset
      stageNightVision.enabled = false;
      stageBW.enabled = false;
      stageEdge.enabled = false;

      stageCRT.uniforms.u_amount = 0.0;
      stageTint.uniforms.u_noise = 0.0;
      stageTint.uniforms.u_tint = new Cesium.Color(1, 1, 1, 0.0);

      // CSS CRT overlay for “scanline feel”
      const crtEl = document.getElementById("crt");
      crtEl.classList.remove("on");

      // “Bloom/Sharpen” controls: Cesium has limited built-ins; we simulate via combinations
      const noise = STATE.fx.noise * 0.12;

      if (mode === "NORMAL") {
        // light noise if slider
        stageTint.uniforms.u_noise = noise;
      }

      if (mode === "CRT") {
        crtEl.classList.add("on");
        stageCRT.uniforms.u_amount = 0.85;
        stageTint.uniforms.u_noise = Math.max(noise, 0.06);
      }

      if (mode === "NVG") {
        stageNightVision.enabled = true;
        stageTint.uniforms.u_noise = Math.max(noise, 0.08);
        stageTint.uniforms.u_tint = new Cesium.Color(0.6, 1.0, 0.7, 0.35);
      }

      if (mode === "FLIR") {
        // stylized “thermal-ish”: high contrast + tint
        stageBW.enabled = true;
        stageTint.uniforms.u_noise = Math.max(noise, 0.05);
        stageTint.uniforms.u_tint = new Cesium.Color(1.0, 0.8, 0.6, 0.35);
      }

      if (mode === "NOIR") {
        stageBW.enabled = true;
        stageTint.uniforms.u_tint = new Cesium.Color(1.0, 1.0, 1.0, 0.0);
        stageTint.uniforms.u_noise = Math.max(noise, 0.03);
        stageCRT.uniforms.u_amount = 0.15;
      }

      if (mode === "SNOW") {
        stageTint.uniforms.u_noise = Math.max(noise, 0.12);
        stageTint.uniforms.u_tint = new Cesium.Color(0.85, 0.95, 1.2, 0.22);
        stageCRT.uniforms.u_amount = 0.12;
      }

      if (mode === "ANIME") {
        stageEdge.enabled = true;
        stageEdge.uniforms.length = 0.25 + STATE.fx.sharpen * 0.55;
        stageTint.uniforms.u_tint = new Cesium.Color(1.2, 1.15, 1.25, 0.18);
        stageTint.uniforms.u_noise = Math.max(noise, 0.02);
      }

      // Telemetry mode text
      el("telMode").textContent = MODES.find(m => m.id === mode)?.label ?? mode;
    }

    function buildModeBar() {
      const bar = document.getElementById("styleBar");
      bar.innerHTML = "";
      MODES.forEach((m) => {
        const b = document.createElement("button");
        b.className = "modeBtn" + (STATE.mode === m.id ? " active" : "");
        b.textContent = m.label;
        b.addEventListener("click", () => {
          STATE.mode = m.id;
          [...bar.querySelectorAll("button")].forEach(x => x.classList.remove("active"));
          b.classList.add("active");
          applyFX();
        });
        bar.appendChild(b);
      });
      applyFX();
    }

    // ---- Layers ----
    const quakeEntities = [];
    const flightEntities = [];
    const satEntities = [];

    async function loadQuakes() {
      // USGS past day significant+all combined: use all_day as base (free)
      const url = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson";
      const res = await fetch(url);
      const data = await res.json();
      return data.features || [];
    }

    async function loadTLE() {
      // CelesTrak active satellites (free). Can swap group if you want.
      const url = "https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle";
      const res = await fetch(url);
      const text = await res.text();
      const lines = text.split("\n").map(s => s.trim()).filter(Boolean);

      const out = [];
      for (let i = 0; i < lines.length - 2; i += 3) {
        const name = lines[i];
        const l1 = lines[i + 1];
        const l2 = lines[i + 2];
        if (l1?.startsWith("1 ") && l2?.startsWith("2 ")) out.push({ name, l1, l2 });
      }
      return out;
    }

    function clearEntities(list) {
      for (const e of list) viewer.entities.remove(e);
      list.length = 0;
    }

    function set2DLayerPoints(layerGroup, points, color) {
      if (!layerGroup || !window.L) return;
      layerGroup.clearLayers();
      points.forEach(p => {
        L.circleMarker([p.lat, p.lon], { radius: 4, color, weight: 1, fillOpacity: 0.5 }).addTo(layerGroup);
      });
    }

    async function renderQuakes() {
      clearEntities(quakeEntities);
      if (window.quakeLayer2d) window.quakeLayer2d.clearLayers?.();

      if (!STATE.layers.quakes) return;

      const feats = await loadQuakes();
      const limit = Math.max(25, Math.floor(500 * STATE.density));
      const slice = feats
        .slice()
        .sort((a, b) => (b.properties?.mag || 0) - (a.properties?.mag || 0))
        .slice(0, limit);

      const points2d = [];

      for (const f of slice) {
        const [lon, lat, depth] = f.geometry?.coordinates || [];
        const mag = f.properties?.mag || 0;
        const t = f.properties?.time ? new Date(f.properties.time) : null;

        const size = Math.max(5, Math.min(18, 5 + mag * 2.2));
        const color = Cesium.Color.fromCssColorString(mag >= 5 ? "#ff4d4d" : mag >= 3 ? "#ffb020" : "#2dd4bf");

        const ent = viewer.entities.add({
          position: Cesium.Cartesian3.fromDegrees(lon, lat, 0),
          point: {
            pixelSize: size,
            color,
            outlineColor: Cesium.Color.BLACK.withAlpha(0.35),
            outlineWidth: 1,
            disableDepthTestDistance: 5000000,
          },
          label: mag >= 5 && STATE.density > 0.45 ? {
            text: `M${mag.toFixed(1)}`,
            font: "12px sans-serif",
            fillColor: Cesium.Color.WHITE,
            outlineColor: Cesium.Color.BLACK.withAlpha(0.8),
            outlineWidth: 2,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new Cesium.Cartesian2(10, -10),
            disableDepthTestDistance: 5000000,
          } : undefined,
          description: `
            <b>Earthquake</b><br/>
            Mag: ${mag}<br/>
            Depth: ${depth ?? "?"} km<br/>
            Time: ${t ? t.toISOString() : "?"}<br/>
          `,
        });

        quakeEntities.push(ent);
        points2d.push({ lat, lon });
      }

      // Update 2D map if exists
      try {
        const map2d = window.__wv_map2d;
        const quakeLayer2d = window.__wv_quakeLayer2d;
        if (map2d && quakeLayer2d) {
          quakeLayer2d.clearLayers();
          points2d.slice(0, 250).forEach(p => {
            L.circleMarker([p.lat, p.lon], { radius: 3, color: "#2dd4bf", weight: 1, fillOpacity: 0.4 }).addTo(quakeLayer2d);
          });
        }
      } catch (_) {}
    }

    // Flights: demo generator (stable & fast)
    function genDemoFlights(count) {
      const flights = [];
      for (let i = 0; i < count; i++) {
        const lat = -60 + Math.random() * 120;
        const lon = -180 + Math.random() * 360;
        const alt = 8000 + Math.random() * 10000;
        const hdg = Math.random() * 360;
        flights.push({ id: "FL-" + (100000 + i), lat, lon, alt, hdg });
      }
      return flights;
    }

    async function renderFlights() {
      clearEntities(flightEntities);
      if (!STATE.layers.flights) return;

      const count = Math.floor(800 + 6200 * STATE.density);
      const flights = genDemoFlights(count);

      const showLabels = STATE.density < 0.35;
      for (const f of flights) {
        const ent = viewer.entities.add({
          position: Cesium.Cartesian3.fromDegrees(f.lon, f.lat, f.alt),
          point: {
            pixelSize: 3,
            color: Cesium.Color.fromCssColorString("#ffffff").withAlpha(0.85),
            disableDepthTestDistance: 5000000,
          },
          label: showLabels ? {
            text: f.id,
            font: "11px sans-serif",
            fillColor: Cesium.Color.WHITE.withAlpha(0.85),
            outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
            outlineWidth: 2,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new Cesium.Cartesian2(8, -8),
            disableDepthTestDistance: 5000000,
          } : undefined,
        });
        flightEntities.push(ent);
      }

      // 2D layer (downsample)
      try {
        const flightLayer2d = window.__wv_flightLayer2d;
        if (flightLayer2d) {
          flightLayer2d.clearLayers();
          flights.slice(0, 600).forEach(p => {
            L.circleMarker([p.lat, p.lon], { radius: 2, color: "#ffffff", weight: 1, fillOpacity: 0.35 }).addTo(flightLayer2d);
          });
        }
      } catch (_) {}
    }

    async function renderSatellites() {
      clearEntities(satEntities);
      if (!STATE.layers.sats) return;

      if (!window.satellite) {
        // satellite.js not ready yet
        setTimeout(renderSatellites, 100);
        return;
      }

      const tles = await loadTLE();

      // density control: show fewer when low density
      const max = Math.floor(80 + 1200 * STATE.density);
      const slice = tles.slice(0, Math.min(max, tles.length));

      const now = new Date();

      for (const s of slice) {
        let satrec;
        try {
          satrec = window.satellite.twoline2satrec(s.l1, s.l2);
        } catch (e) {
          continue;
        }

        const pv = window.satellite.propagate(satrec, now);
        if (!pv.position) continue;

        const gmst = window.satellite.gstime(now);
        const gd = window.satellite.eciToGeodetic(pv.position, gmst);

        const lat = gd.latitude * (180 / Math.PI);
        const lon = gd.longitude * (180 / Math.PI);
        const altKm = gd.height;

        const ent = viewer.entities.add({
          position: Cesium.Cartesian3.fromDegrees(lon, lat, altKm * 1000),
          point: {
            pixelSize: 3,
            color: Cesium.Color.fromCssColorString("#ff9d00").withAlpha(0.85),
            disableDepthTestDistance: 5000000,
          },
          label: (STATE.density < 0.25) ? {
            text: s.name.slice(0, 14),
            font: "11px sans-serif",
            fillColor: Cesium.Color.fromCssColorString("#ffdfb0"),
            outlineColor: Cesium.Color.BLACK.withAlpha(0.8),
            outlineWidth: 2,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new Cesium.Cartesian2(10, -10),
            disableDepthTestDistance: 5000000,
          } : undefined,
        });

        satEntities.push(ent);
      }
    }

    // ---- Refresh ----
    async function refreshAll() {
      // quick UI feedback
      el("refreshBtn").textContent = "Refreshing…";
      el("refreshBtn").disabled = true;

      try {
        await Promise.allSettled([
          renderFlights(),
          renderSatellites(),
          renderQuakes(),
        ]);
      } finally {
        el("refreshBtn").textContent = "Refresh";
        el("refreshBtn").disabled = false;
        updateEntityCount();
      }
    }

    function updateEntityCount() {
      const total = flightEntities.length + satEntities.length + quakeEntities.length;
      STATE.entitiesCount = total;
      el("telEnt").textContent = String(total);
    }

    // ---- Telemetry (FPS + time) ----
    let fpsSamples = [];
    let lastFrame = performance.now();

    function telemetryTick(t) {
      const now = performance.now();
      const dt = now - lastFrame;
      lastFrame = now;

      const fps = dt > 0 ? (1000 / dt) : 0;
      fpsSamples.push(fps);
      if (fpsSamples.length > 12) fpsSamples.shift();

      const avg = fpsSamples.reduce((a, b) => a + b, 0) / fpsSamples.length;
      el("telFps").textContent = avg.toFixed(0);

      el("telTime").textContent = new Date().toLocaleTimeString();

      // Keep mode text fresh
      el("telMode").textContent = MODES.find(m => m.id === STATE.mode)?.label ?? STATE.mode;
    }

    // Expose 2D internals for helpers
    (function expose2D() {
      const tryExpose = () => {
        if (!window.L) return setTimeout(tryExpose, 60);
        // Leaflet map object is local, but we can store to window for quick hooks
        try {
          const map = document.getElementById("map2d")?._leaflet_map;
          // if not present, we store later below
        } catch (_) {}
      };
      tryExpose();
    })();

    // Store leaflet layers to window (after init2D finished)
    setTimeout(() => {
      try {
        const map2dEl = document.getElementById("map2d");
        // We can find the map instance by scanning Leaflet internal
        // simpler: create new references via globals created in init2D closure isn't accessible here,
        // so instead we re-create lightweight globals by reading from leaflet container:
        // Not perfect, but fine: we build our own small registry.
        // We'll just attach layers when Leaflet exists by rebuilding them once.
        if (window.L) {
          // If Leaflet was already initialized, we do nothing here.
        }
      } catch (_) {}
    }, 500);

    // Hook: attach Leaflet layers to window by creating them if missing
    setTimeout(() => {
      if (!window.L) return;
      // Find existing map by walking Leaflet's internal registry isn't stable.
      // We instead rebuild a dedicated map reference via L.map on same div only once:
      // (Leaflet throws if already initialized). So we detect by dataset flag.
      const div = document.getElementById("map2d");
      if (!div) return;

      if (!div.dataset.wvInit) {
        div.dataset.wvInit = "1";
        const map2d = L.map("map2d", { zoomControl: false, attributionControl: false }).setView([32.0853, 34.7818], 5);
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(map2d);

        const camMarker = L.circleMarker([32.0853, 34.7818], { radius: 6 }).addTo(map2d);
        const quakeLayer2d = L.layerGroup().addTo(map2d);
        const flightLayer2d = L.layerGroup().addTo(map2d);

        window.__wv_map2d = map2d;
        window.__wv_camMarker = camMarker;
        window.__wv_quakeLayer2d = quakeLayer2d;
        window.__wv_flightLayer2d = flightLayer2d;

        // sync cam marker
        setInterval(() => {
          const c = viewer.camera.positionCartographic;
          const lat = Cesium.Math.toDegrees(c.latitude);
          const lon = Cesium.Math.toDegrees(c.longitude);
          camMarker.setLatLng([lat, lon]);
        }, 900);
      }
    }, 300);

    // First load
    refreshAll();
  }

  window.addEventListener("DOMContentLoaded", init);
})();
