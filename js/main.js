/*
  WorldView V2 — Free & Legal Edition (Stable build)

  Goal: WORKS everywhere (no custom WebGL fragment shaders).
  - Globe imagery: ESRI World Imagery (default) or OSM
  - Optional Cesium ion token (only for ion services; not required for ESRI/OSM)
  - Layers: flights (OpenSky via Worker), satellites (CelesTrak), earthquakes (USGS), weather radar (RainViewer), traffic glow (sim), CCTV quad (user-provided permitted URL)
  - 2D Map: MapLibre mirrors camera center
*/

(function () {
  const LS_WORKER = 'worldview.workerBase';
  const LS_TOKEN  = 'worldview.ionToken';
  const LS_IMAGERY = 'worldview.imagery';

  /** @type {import('cesium').Viewer | any} */
  let viewer;

  const state = {
    style: 'NORMAL',
    mode: 'LIVE',
    workerBase: localStorage.getItem(LS_WORKER) || '',
    ionToken: localStorage.getItem(LS_TOKEN) || '',
    imagery: localStorage.getItem(LS_IMAGERY) || 'ESRI',
    layers: {
      flights: true,
      sats: true,
      quakes: true,
      weather: false,
      traffic: false,
      cctv: false,
    },
    fx: {
      bloom: 0.35,
      sharpen: 0.2,
      noise: 0.25,
      pixelation: 0,
      intensity: 0.75,
      saturation: 0,
    },
  };

  // --- UI helpers ---
  const $ = (id) => document.getElementById(id);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  function setBadge(id, v) {
    const el = $(id);
    if (el) el.textContent = String(v);
  }

  function nowRecString() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  // --- Networking ---
  function apiUrl(path, params) {
    // Prefer worker base if provided, else same-origin.
    const base = (state.workerBase || '').replace(/\/$/, '');
    const url = new URL((base ? base : '') + path, window.location.origin);
    if (base) {
      try {
        const u = new URL(base);
        url.protocol = u.protocol;
        url.host = u.host;
        url.pathname = u.pathname.replace(/\/$/, '') + path;
      } catch {
        // ignore
      }
    }
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  async function safeJson(url) {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return await r.json();
  }

  // --- Cesium layers ---
  const layers = {
    flights: null,
    sats: null,
    quakes: null,
    traffic: null,
    cctv: null,
  };

  const entityRegistry = {
    count() {
      let c = 0;
      for (const k of ['flights', 'sats', 'quakes', 'traffic', 'cctv']) {
        const ds = layers[k];
        if (ds && ds.entities) c += ds.entities.values.length;
      }
      return c;
    },
  };

  // --- Imagery (fixes "blue globe") ---
  function buildBaseImagery(kind) {
    if (kind === 'OSM') {
      return new Cesium.OpenStreetMapImageryProvider({
        url: 'https://tile.openstreetmap.org/',
        credit: '© OpenStreetMap contributors',
      });
    }
    // Default: ESRI World Imagery
    return new Cesium.ArcGisMapServerImageryProvider({
      url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer',
      enablePickFeatures: false,
    });
  }

  function addLabelOverlay() {
    // light-only labels from CARTO (optional, helps readability on satellite)
    try {
      const labels = new Cesium.UrlTemplateImageryProvider({
        url: 'https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}.png',
        subdomains: ['a', 'b', 'c', 'd'],
        credit: '© OpenStreetMap, © CARTO',
      });
      const layer = viewer.imageryLayers.addImageryProvider(labels);
      layer.alpha = 0.85;
    } catch {
      // ignore
    }
  }

  function applyImagery(kind) {
    state.imagery = kind;
    localStorage.setItem(LS_IMAGERY, kind);

    const il = viewer.imageryLayers;
    while (il.length > 0) il.remove(il.get(0), true);

    il.addImageryProvider(buildBaseImagery(kind));
    addLabelOverlay();
  }

  // --- Layers ---
  async function updateFlights() {
    if (!state.layers.flights) {
      layers.flights.entities.removeAll();
      return;
    }

    // Needs worker for best reliability
    const url = apiUrl('/api/flights', { extended: 1 });
    try {
      const json = await safeJson(url);
      const statesArr = json.states || [];
      layers.flights.entities.removeAll();

      // Performance guard
      const limit = 900;
      const list = statesArr.slice(0, limit);

      for (const st of list) {
        const [icao24, callsign, originCountry, timePos, lastContact, lon, lat, baroAlt, onGround, velocity, heading, verticalRate, sensors, geoAlt] = st;
        if (lat == null || lon == null) continue;

        const altM = (geoAlt != null ? geoAlt : (baroAlt != null ? baroAlt : 0));
        const labelText = (callsign || icao24 || '').trim();

        layers.flights.entities.add({
          position: Cesium.Cartesian3.fromDegrees(lon, lat, altM),
          point: {
            pixelSize: 4,
            color: Cesium.Color.fromCssColorString('#ffd166'),
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 1,
          },
          label: {
            text: labelText,
            font: '10px sans-serif',
            fillColor: Cesium.Color.WHITE,
            pixelOffset: new Cesium.Cartesian2(0, -12),
            showBackground: false,
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0.0, 1.4e6),
          },
          properties: {
            type: 'flight',
            icao24,
            callsign: labelText,
            originCountry,
            velocity,
            heading,
            lastContact,
          },
        });
      }
    } catch (e) {
      console.warn('Flights fetch failed. Tip: set Worker Base URL for OpenSky.', e);
    }
  }

  async function updateQuakes() {
    if (!state.layers.quakes) {
      layers.quakes.entities.removeAll();
      return;
    }
    // USGS feed (CORS OK)
    const url = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson';
    try {
      const json = await safeJson(url);
      layers.quakes.entities.removeAll();
      const feats = json.features || [];
      for (const f of feats) {
        const coords = f.geometry?.coordinates;
        if (!coords || coords.length < 3) continue;
        const [lon, lat, depthKm] = coords;
        const mag = f.properties?.mag ?? 1.0;
        const t = f.properties?.time ? new Date(f.properties.time).toISOString().slice(0, 19).replace('T', ' ') : '';

        layers.quakes.entities.add({
          position: Cesium.Cartesian3.fromDegrees(lon, lat, -Math.abs(depthKm) * 1000),
          point: {
            pixelSize: Math.min(22, 4 + mag * 3.1),
            color: Cesium.Color.fromCssColorString('#ff5f75').withAlpha(0.65),
            outlineColor: Cesium.Color.fromCssColorString('#ffd166').withAlpha(0.9),
            outlineWidth: 1,
          },
          label: {
            text: mag.toFixed(1),
            font: '10px sans-serif',
            fillColor: Cesium.Color.WHITE,
            pixelOffset: new Cesium.Cartesian2(0, -12),
            showBackground: false,
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0.0, 5.0e6),
          },
          description: `<div style="font-family:ui-monospace,monospace; font-size:12px;">MAG ${mag.toFixed(1)} · DEPTH ${depthKm}km<br/>${t}</div>`,
          properties: { type: 'quake', mag, depthKm, time: t },
        });
      }
    } catch (e) {
      console.warn('Earthquakes fetch failed', e);
    }
  }

  async function updateSats() {
    if (!state.layers.sats) {
      layers.sats.entities.removeAll();
      return;
    }

    // CelesTrak JSON
    const url = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=json';
    try {
      const sats = await safeJson(url);
      layers.sats.entities.removeAll();

      const now = new Date();
      const limit = 350; // performance guard
      for (const sat of (sats || []).slice(0, limit)) {
        const line1 = sat.TLE_LINE1 || sat.line1;
        const line2 = sat.TLE_LINE2 || sat.line2;
        if (!line1 || !line2) continue;

        try {
          const rec = satellite.twoline2satrec(line1, line2);
          const pv = satellite.propagate(rec, now);
          if (!pv.position) continue;
          const gmst = satellite.gstime(now);
          const gd = satellite.eciToGeodetic(pv.position, gmst);
          const lon = satellite.degreesLong(gd.longitude);
          const lat = satellite.degreesLat(gd.latitude);
          const alt = gd.height * 1000;

          const name = (sat.OBJECT_NAME || sat.objectName || sat.satelliteName || '').toString().slice(0, 24);
          const norad = sat.NORAD_CAT_ID || sat.noradCatId || '';

          layers.sats.entities.add({
            position: Cesium.Cartesian3.fromDegrees(lon, lat, alt),
            point: {
              pixelSize: 3,
              color: Cesium.Color.fromCssColorString('#7de3ff'),
              outlineColor: Cesium.Color.BLACK,
              outlineWidth: 1,
            },
            label: {
              text: norad ? `SAT-${norad}` : '',
              font: '9px sans-serif',
              fillColor: Cesium.Color.fromCssColorString('#7de3ff'),
              pixelOffset: new Cesium.Cartesian2(0, -10),
              showBackground: false,
              distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0.0, 2.0e7),
            },
            properties: { type: 'sat', norad, name },
          });
        } catch {
          // ignore broken TLEs
        }
      }
    } catch (e) {
      console.warn('Satellites fetch failed (CORS?). If it fails, use a Worker proxy later.', e);
    }
  }

  // Weather radar via RainViewer tiles (no key). We only show a recent frame.
  let weatherLayer;
  async function setWeatherEnabled(enabled) {
    if (!enabled) {
      if (weatherLayer) {
        viewer.imageryLayers.remove(weatherLayer, true);
        weatherLayer = null;
      }
      return;
    }

    try {
      const meta = await safeJson('https://api.rainviewer.com/public/weather-maps.json');
      const frames = meta?.radar?.past || [];
      const last = frames[frames.length - 1];
      if (!last) return;

      const template = `https://tilecache.rainviewer.com${last.path}/256/{z}/{x}/{y}/2/1_1.png`;
      const provider = new Cesium.UrlTemplateImageryProvider({ url: template, credit: 'RainViewer' });

      weatherLayer = viewer.imageryLayers.addImageryProvider(provider);
      weatherLayer.alpha = 0.55;
    } catch (e) {
      console.warn('Weather radar failed', e);
    }
  }

  // Traffic Glow (simulated): animated points near camera center
  let trafficTimer;
  function setTrafficEnabled(enabled) {
    if (!enabled) {
      if (trafficTimer) clearInterval(trafficTimer);
      trafficTimer = null;
      layers.traffic.entities.removeAll();
      return;
    }

    const seedPoints = () => {
      layers.traffic.entities.removeAll();
      const carto = viewer.camera.positionCartographic;
      const centerLon = Cesium.Math.toDegrees(carto.longitude);
      const centerLat = Cesium.Math.toDegrees(carto.latitude);
      const N = 600;
      for (let i = 0; i < N; i++) {
        const lon = centerLon + (Math.random() - 0.5) * 0.28;
        const lat = centerLat + (Math.random() - 0.5) * 0.22;
        layers.traffic.entities.add({
          position: Cesium.Cartesian3.fromDegrees(lon, lat, 0),
          point: {
            pixelSize: 2,
            color: Cesium.Color.fromCssColorString('#ffd166').withAlpha(0.35),
          },
          properties: { type: 'traffic' },
        });
      }
    };

    seedPoints();
    trafficTimer = setInterval(seedPoints, 8000);
  }

  // CCTV projection (simple ground quad)
  let cctvEntity;
  function clearCctv() {
    if (cctvEntity) {
      layers.cctv.entities.remove(cctvEntity);
      cctvEntity = null;
    }
  }

  async function projectCctv() {
    const url = ($('cctvUrl').value || '').trim();
    const lat = parseFloat(($('cctvLat').value || '').trim());
    const lon = parseFloat(($('cctvLon').value || '').trim());

    if (!url || Number.isNaN(lat) || Number.isNaN(lon)) {
      alert('CCTV: please provide URL + lat/lon');
      return;
    }

    clearCctv();

    const halfSizeDeg = 0.0012; // ~130m
    const rect = Cesium.Rectangle.fromDegrees(lon - halfSizeDeg, lat - halfSizeDeg, lon + halfSizeDeg, lat + halfSizeDeg);

    const video = document.createElement('video');
    video.src = url;
    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.autoplay = true;

    try { await video.play(); } catch {}

    cctvEntity = layers.cctv.entities.add({
      rectangle: { coordinates: rect, material: video, height: 0 },
      properties: { type: 'cctv', url },
    });

    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, 900),
      orientation: { heading: 0.0, pitch: Cesium.Math.toRadians(-45), roll: 0 },
      duration: 1.4,
    });
  }

  // --- Post FX (stable: only bloom + CSS + resolutionScale) ---
  let bloomStage = null;

  function resetPostFx() {
    const pps = viewer.scene.postProcessStages;
    pps.removeAll();
    bloomStage = null;
  }

  function addBloom(v) {
    const s = Cesium.PostProcessStageLibrary.createBloomStage();
    viewer.scene.postProcessStages.add(s);
    bloomStage = s;
    applyBloom(v);
  }

  function applyBloom(v) {
    if (!bloomStage) return;
    bloomStage.enabled = v > 0.01;
    bloomStage.uniforms.glowOnly = false;
    bloomStage.uniforms.contrast = 128;
    bloomStage.uniforms.brightness = Cesium.Math.lerp(-0.35, 0.15, v);
    bloomStage.uniforms.delta = 1.0;
    bloomStage.uniforms.sigma = Cesium.Math.lerp(1.2, 3.6, v);
    bloomStage.uniforms.stepSize = 1.0;
    bloomStage.uniforms.isSelected = function () { return false; };
  }

  function applyFxToCss() {
    // intensity => brightness; sharpen => contrast; saturation => saturate
    const bright = Cesium.Math.lerp(0.85, 1.35, state.fx.intensity);
    const contrast = Cesium.Math.lerp(0.95, 1.55, state.fx.sharpen);
    const sat = Cesium.Math.lerp(0.0, 1.65, state.fx.saturation);

    document.documentElement.style.setProperty('--fx-bright', bright.toFixed(3));
    document.documentElement.style.setProperty('--fx-contrast', contrast.toFixed(3));
    document.documentElement.style.setProperty('--fx-sat', sat.toFixed(3));

    // noise overlay opacity
    const noiseEl = $('noiseOverlay');
    if (noiseEl) noiseEl.style.opacity = String(Math.max(0, Math.min(0.75, state.fx.noise * 0.6)));

    // pixelation => lower internal resolution (stable)
    viewer.resolutionScale = Cesium.Math.lerp(1.0, 0.45, state.fx.pixelation);
  }

  function applyStyle(style) {
    state.style = style;
    $('activeStyle').textContent = `STYLE: ${style}`;

    const body = document.body;
    body.classList.remove('style-normal','style-crt','style-nvg','style-flir','style-noir','style-snow','style-anime');
    const map = {
      NORMAL: 'style-normal',
      CRT: 'style-crt',
      NVG: 'style-nvg',
      FLIR: 'style-flir',
      NOIR: 'style-noir',
      SNOW: 'style-snow',
      ANIME: 'style-anime',
    };
    body.classList.add(map[style] || 'style-normal');

    // button active state
    $$('#bottomBar [data-style]').forEach((b) => {
      b.classList.toggle('active', b.dataset.style === style);
    });
  }

  function applyFxFromUi() {
    const bloom = parseFloat($('bloom').value);
    const sharpen = parseFloat($('sharpen').value);
    const noise = parseFloat($('noise').value);
    const pix = parseFloat($('pixelation').value);
    const intensity = parseFloat($('intensity').value);
    const sat = parseFloat($('saturation').value);

    state.fx = { ...state.fx, bloom, sharpen, noise, pixelation: pix, intensity, saturation: sat };

    setBadge('bloomVal', bloom.toFixed(2));
    setBadge('sharpenVal', sharpen.toFixed(2));
    setBadge('noiseVal', noise.toFixed(2));
    setBadge('pixVal', pix.toFixed(2));
    setBadge('intVal', intensity.toFixed(2));
    setBadge('satVal', sat.toFixed(2));

    applyBloom(bloom);
    applyFxToCss();
  }

  // --- 2D Map ---
  let map2d;
  function init2dMap() {
    const el = $('miniMapWrap');
    if (!el || map2d) return;

    map2d = new maplibregl.Map({
      container: 'miniMap',
      style: {
        version: 8,
        sources: {
          osm: {
            type: 'raster',
            tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
            tileSize: 256,
            attribution: '© OpenStreetMap contributors',
          },
        },
        layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
      },
      center: [0, 20],
      zoom: 1.6,
      attributionControl: false,
    });

    const sync = () => {
      if (!map2d) return;
      const c = viewer.camera.positionCartographic;
      const lon = Cesium.Math.toDegrees(c.longitude);
      const lat = Cesium.Math.toDegrees(c.latitude);
      map2d.jumpTo({ center: [lon, lat], zoom: 3.5 });
    };

    viewer.camera.changed.addEventListener(() => {
      if (!map2d) return;
      if (sync._t) return;
      sync._t = setTimeout(() => { sync._t = null; sync(); }, 300);
    });
  }

  function toggle2dMap() {
    const wrap = $('miniMapWrap');
    const on = wrap.style.display !== 'block';
    wrap.style.display = on ? 'block' : 'none';
    if (on) init2dMap();
  }

  // --- Refresh loop ---
  async function refreshAll() {
    if (state.mode !== 'LIVE') return;
    await Promise.all([updateFlights(), updateSats(), updateQuakes()]);
    setBadge('entityCount', entityRegistry.count());
  }

  // FPS meter
  function initTelemetry() {
    let last = performance.now();
    let frames = 0;
    function tick() {
      frames++;
      const t = performance.now();
      if (t - last >= 1000) {
        setBadge('fps', Math.round((frames * 1000) / (t - last)));
        frames = 0;
        last = t;
      }
      setBadge('simTime', new Date().toISOString().slice(11, 19));
      $('recTime').textContent = nowRecString();
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  // --- Boot ---
  window.addEventListener('load', async () => {
    if (typeof Cesium === 'undefined') {
      alert('Cesium failed to load (check network).');
      return;
    }

    // Optional token (prevents warnings; only needed for ion services)
    if (state.ionToken) {
      try { Cesium.Ion.defaultAccessToken = state.ionToken; } catch {}
    }

    // Viewer: we control imagery ourselves (baseLayerPicker off = no ion token popup)
    viewer = new Cesium.Viewer('viewer', {
      animation: false,
      timeline: false,
      geocoder: true,
      homeButton: true,
      baseLayerPicker: false,
      sceneModePicker: true,
      navigationHelpButton: false,
      fullscreenButton: true,
      infoBox: true,
      selectionIndicator: true,
      shouldAnimate: true,
      imageryProvider: buildBaseImagery(state.imagery),
      terrainProvider: new Cesium.EllipsoidTerrainProvider(),
    });

    // UI + readability
    viewer.scene.globe.baseColor = Cesium.Color.BLACK;
    viewer.scene.fog.enabled = true;
    viewer.scene.fog.density = 0.00015;
    viewer.scene.skyAtmosphere.hueShift = -0.05;
    viewer.scene.skyAtmosphere.saturationShift = -0.15;

    // Add label overlay layer
    addLabelOverlay();

    // DataSources
    layers.flights = new Cesium.CustomDataSource('flights');
    layers.sats = new Cesium.CustomDataSource('satellites');
    layers.quakes = new Cesium.CustomDataSource('earthquakes');
    layers.traffic = new Cesium.CustomDataSource('traffic');
    layers.cctv = new Cesium.CustomDataSource('cctv');

    viewer.dataSources.add(layers.flights);
    viewer.dataSources.add(layers.sats);
    viewer.dataSources.add(layers.quakes);
    viewer.dataSources.add(layers.traffic);
    viewer.dataSources.add(layers.cctv);

    // Start camera
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(-97.7431, 30.2672, 6000),
      orientation: { heading: 0.0, pitch: Cesium.Math.toRadians(-35), roll: 0.0 },
      duration: 0.0,
    });

    // PostFX (safe)
    resetPostFx();
    addBloom(state.fx.bloom);

    // --- UI initial ---
    $('workerBase').value = state.workerBase;
    $('ionToken').value = state.ionToken;
    $('imagerySel').value = state.imagery;

    $('layerFlights').checked = state.layers.flights;
    $('layerSats').checked = state.layers.sats;
    $('layerQuakes').checked = state.layers.quakes;
    $('layerWeather').checked = state.layers.weather;
    $('layerTraffic').checked = state.layers.traffic;
    $('layerCctv').checked = state.layers.cctv;

    // Wire layer toggles
    $('layerFlights').addEventListener('change', (e) => { state.layers.flights = e.target.checked; refreshAll(); });
    $('layerSats').addEventListener('change', (e) => { state.layers.sats = e.target.checked; refreshAll(); });
    $('layerQuakes').addEventListener('change', (e) => { state.layers.quakes = e.target.checked; refreshAll(); });
    $('layerWeather').addEventListener('change', async (e) => { state.layers.weather = e.target.checked; await setWeatherEnabled(state.layers.weather); });
    $('layerTraffic').addEventListener('change', (e) => { state.layers.traffic = e.target.checked; setTrafficEnabled(state.layers.traffic); });
    $('layerCctv').addEventListener('change', (e) => { state.layers.cctv = e.target.checked; if (!state.layers.cctv) clearCctv(); });

    $('refreshBtn').addEventListener('click', () => refreshAll());

    // Style preset buttons
    $$('#bottomBar [data-style]').forEach((b) => b.addEventListener('click', () => applyStyle(b.dataset.style)));

    // Mode
    $('modeLive').addEventListener('click', () => {
      state.mode = 'LIVE';
      $('modeLive').classList.add('active');
      $('modePause').classList.remove('active');
    });
    $('modePause').addEventListener('click', () => {
      state.mode = 'PAUSE';
      $('modePause').classList.add('active');
      $('modeLive').classList.remove('active');
    });

    // FX sliders
    ['bloom','sharpen','noise','pixelation','intensity','saturation'].forEach((id) => $(id).addEventListener('input', applyFxFromUi));
    applyFxFromUi();

    // Imagery selector
    $('imagerySel').addEventListener('change', (e) => applyImagery(e.target.value));

    // 2D map toggle
    $('toggleMap').addEventListener('click', toggle2dMap);

    // Worker base save
    $('saveWorker').addEventListener('click', () => {
      const v = ($('workerBase').value || '').trim();
      state.workerBase = v;
      localStorage.setItem(LS_WORKER, v);
      alert('Saved worker URL. Reload page to apply.');
    });

    // Token save
    $('saveToken').addEventListener('click', () => {
      const t = ($('ionToken').value || '').trim();
      state.ionToken = t;
      localStorage.setItem(LS_TOKEN, t);
      alert('Saved token. Reload page to apply.');
    });

    // CCTV project
    $('cctvProject').addEventListener('click', () => {
      state.layers.cctv = true;
      $('layerCctv').checked = true;
      projectCctv();
    });

    // Initial style
    applyStyle('NORMAL');

    // Initial weather/traffic
    setWeatherEnabled(state.layers.weather);
    setTrafficEnabled(state.layers.traffic);

    // Start loops
    initTelemetry();
    refreshAll();
    setInterval(refreshAll, 15000); // refresh every 15s
  });
})();
