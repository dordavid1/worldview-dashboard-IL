/*
  WorldView — v3 SAFE (no custom fragment shaders)
  If you still see out_FragColor/czm_viewport errors after this, you're NOT running this file.
*/

(function () {
  console.log("WorldView main.js v3 SAFE loaded");

  const LS_WORKER = 'worldview.workerBase';
  const LS_ION = 'worldview.ionToken';
  let viewer;

  const state = {
    style: 'NORMAL',
    mode: 'LIVE',
    workerBase: localStorage.getItem(LS_WORKER) || '',
    ionToken: localStorage.getItem(LS_ION) || '',
    layers: { flights: true, sats: true, quakes: true, weather: false, traffic: false, cctv: false },
    fx: { bloom: 0.35, sharpen: 0.2, noise: 0.25, pixelation: 0, intensity: 0.75, saturation: 0 },
  };

  const $ = (id) => document.getElementById(id);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  function setBadge(id, v) { const el = $(id); if (el) el.textContent = String(v); }
  function nowRecString() {
    const d = new Date(); const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function apiUrl(path, params) {
    const base = (state.workerBase || '').replace(/\/$/, '');
    const url = new URL((base ? base : '') + path, window.location.origin);
    if (base) {
      try {
        const u = new URL(base);
        url.protocol = u.protocol;
        url.host = u.host;
        url.pathname = u.pathname.replace(/\/$/, '') + path;
      } catch {}
    }
    if (params) for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    return url.toString();
  }

  async function safeJson(url) {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return await r.json();
  }

  const layers = { flights: null, sats: null, quakes: null, traffic: null, cctv: null };
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

  async function updateFlights() {
    if (!state.layers.flights) { layers.flights.entities.removeAll(); return; }
    try {
      const json = await safeJson(apiUrl('/api/flights', { extended: 1 }));
      layers.flights.entities.removeAll();
      for (const st of (json.states || []).slice(0, 900)) {
        const [icao24, callsign, originCountry, , , lon, lat, baroAlt, , velocity, heading, , , geoAlt] = st;
        if (lat == null || lon == null) continue;
        const altM = (geoAlt != null ? geoAlt : (baroAlt != null ? baroAlt : 0));
        const labelText = (callsign || icao24 || '').trim();
        layers.flights.entities.add({
          position: Cesium.Cartesian3.fromDegrees(lon, lat, altM),
          point: { pixelSize: 4, color: Cesium.Color.fromCssColorString('#ffd166'), outlineColor: Cesium.Color.BLACK, outlineWidth: 1 },
          label: {
            text: labelText,
            font: '10px sans-serif',
            fillColor: Cesium.Color.WHITE,
            pixelOffset: new Cesium.Cartesian2(0, -12),
            showBackground: false,
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0.0, 1.4e6),
          },
          properties: { type: 'flight', icao24, callsign: labelText, originCountry, velocity, heading },
        });
      }
    } catch (e) {
      console.warn('Flights fetch failed (worker base URL needed for OpenSky).', e);
    }
  }

  async function updateQuakes() {
    if (!state.layers.quakes) { layers.quakes.entities.removeAll(); return; }
    try {
      const json = await safeJson(apiUrl('/api/earthquakes'));
      layers.quakes.entities.removeAll();
      for (const f of (json.features || [])) {
        const coords = f.geometry?.coordinates;
        if (!coords || coords.length < 3) continue;
        const [lon, lat, depthKm] = coords;
        const mag = f.properties?.mag ?? 1.0;
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
          properties: { type: 'quake', mag, depthKm },
        });
      }
    } catch (e) {
      console.warn('Earthquakes fetch failed', e);
    }
  }

  async function updateSats() {
    if (!state.layers.sats) { layers.sats.entities.removeAll(); return; }
    try {
      const sats = await safeJson(apiUrl('/api/satellites', { group: 'active' }));
      layers.sats.entities.removeAll();
      const now = new Date();
      for (const sat of sats.slice(0, 350)) {
        const line1 = sat.line1 || sat.TLE_LINE1;
        const line2 = sat.line2 || sat.TLE_LINE2;
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
          layers.sats.entities.add({
            position: Cesium.Cartesian3.fromDegrees(lon, lat, alt),
            point: { pixelSize: 3, color: Cesium.Color.fromCssColorString('#7de3ff'), outlineColor: Cesium.Color.BLACK, outlineWidth: 1 },
            properties: { type: 'sat' },
          });
        } catch {}
      }
    } catch (e) {
      console.warn('Satellites fetch failed', e);
    }
  }

  let weatherLayer;
  async function setWeatherEnabled(enabled) {
    if (!enabled) {
      if (weatherLayer) { viewer.imageryLayers.remove(weatherLayer, true); weatherLayer = null; }
      return;
    }
    try {
      const meta = await safeJson('https://api.rainviewer.com/public/weather-maps.json');
      const frames = meta?.radar?.past || [];
      const last = frames[frames.length - 1];
      if (!last) return;
      const template = `https://tilecache.rainviewer.com${last.path}/256/{z}/{x}/{y}/2/1_1.png`;
      weatherLayer = viewer.imageryLayers.addImageryProvider(new Cesium.UrlTemplateImageryProvider({ url: template, credit: 'RainViewer' }));
      weatherLayer.alpha = 0.55;
    } catch (e) { console.warn('Weather radar failed', e); }
  }

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
      for (let i = 0; i < 600; i++) {
        const lon = centerLon + (Math.random() - 0.5) * 0.28;
        const lat = centerLat + (Math.random() - 0.5) * 0.22;
        layers.traffic.entities.add({
          position: Cesium.Cartesian3.fromDegrees(lon, lat, 0),
          point: { pixelSize: 2, color: Cesium.Color.fromCssColorString('#ffd166').withAlpha(0.35) },
          properties: { type: 'traffic' },
        });
      }
    };
    seedPoints();
    trafficTimer = setInterval(seedPoints, 8000);
  }

  let cctvEntity;
  function clearCctv() { if (cctvEntity) { layers.cctv.entities.remove(cctvEntity); cctvEntity = null; } }

  async function projectCctv() {
    const url = ($('cctvUrl').value || '').trim();
    const lat = parseFloat(($('cctvLat').value || '').trim());
    const lon = parseFloat(($('cctvLon').value || '').trim());
    if (!url || Number.isNaN(lat) || Number.isNaN(lon)) { alert('CCTV: please provide URL + lat/lon'); return; }
    clearCctv();
    const halfSizeDeg = 0.0012;
    const rect = Cesium.Rectangle.fromDegrees(lon - halfSizeDeg, lat - halfSizeDeg, lon + halfSizeDeg, lat + halfSizeDeg);
    const video = document.createElement('video');
    video.src = url;
    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.autoplay = true;
    try { await video.play(); } catch {}
    cctvEntity = layers.cctv.entities.add({ rectangle: { coordinates: rect, material: video, height: 0 }, properties: { type: 'cctv', url } });
    viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(lon, lat, 900), orientation: { heading: 0.0, pitch: Cesium.Math.toRadians(-45), roll: 0 }, duration: 1.4 });
  }

  // SAFE FX: Bloom only (Cesium builtin)
  let bloomStage = null;
  function rebuildBloom() {
    const pps = viewer.scene.postProcessStages;
    pps.removeAll();
    bloomStage = Cesium.PostProcessStageLibrary.createBloomStage();
    pps.add(bloomStage);
    applyBloom(state.fx.bloom);
  }
  function applyBloom(v) {
    if (!bloomStage) return;
    bloomStage.enabled = v > 0.01;
    bloomStage.uniforms.brightness = Cesium.Math.lerp(-0.35, 0.15, v);
    bloomStage.uniforms.sigma = Cesium.Math.lerp(1.2, 3.6, v);
  }

  function applyStyle(style) {
    state.style = style;
    $('activeStyle').textContent = `STYLE: ${style}`;
    $('crtOverlay').classList.toggle('on', style === 'CRT');
    $$('#bottomBar [data-style]').forEach((b) => b.classList.toggle('active', b.dataset.style === style));
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
  }

  // 2D map
  let map2d;
  function init2dMap() {
    if (map2d) return;
    map2d = new maplibregl.Map({
      container: 'miniMap',
      style: {
        version: 8,
        sources: { osm: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, attribution: '© OpenStreetMap contributors' } },
        layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
      },
      center: [0, 20],
      zoom: 1.6,
      attributionControl: false,
    });

    const sync = () => {
      const c = viewer.camera.positionCartographic;
      map2d.jumpTo({ center: [Cesium.Math.toDegrees(c.longitude), Cesium.Math.toDegrees(c.latitude)], zoom: 3.5 });
    };

    viewer.camera.changed.addEventListener(() => {
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

  async function refreshAll() {
    if (state.mode !== 'LIVE') return;
    await Promise.all([updateFlights(), updateSats(), updateQuakes()]);
    setBadge('entityCount', entityRegistry.count());
  }

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

  window.addEventListener('load', () => {
    if (typeof Cesium === 'undefined') { alert('Cesium failed to load.'); return; }

    // Apply Ion token ONLY if user saved one (not committed to repo)
    if (state.ionToken) Cesium.Ion.defaultAccessToken = state.ionToken;

    viewer = new Cesium.Viewer('viewer', {
      animation: false,
      timeline: false,
      geocoder: false,
      homeButton: true,
      baseLayerPicker: false,
      navigationHelpButton: false,
      fullscreenButton: true,
      infoBox: true,
      selectionIndicator: true,
      shouldAnimate: true,
      imageryProvider: new Cesium.OpenStreetMapImageryProvider({ url: "https://a.tile.openstreetmap.org/" }),
      terrainProvider: new Cesium.EllipsoidTerrainProvider(),
    });

    viewer.scene.globe.enableLighting = true;
    viewer.scene.globe.baseColor = Cesium.Color.BLACK;

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

    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(-97.7431, 30.2672, 6000),
      orientation: { heading: 0.0, pitch: Cesium.Math.toRadians(-35), roll: 0.0 },
      duration: 0.0,
    });

    // UI init
    $('workerBase').value = state.workerBase;
    $('ionToken').value = state.ionToken;

    $('layerFlights').checked = state.layers.flights;
    $('layerSats').checked = state.layers.sats;
    $('layerQuakes').checked = state.layers.quakes;
    $('layerWeather').checked = state.layers.weather;
    $('layerTraffic').checked = state.layers.traffic;
    $('layerCctv').checked = state.layers.cctv;

    $('layerFlights').addEventListener('change', (e) => { state.layers.flights = e.target.checked; refreshAll(); });
    $('layerSats').addEventListener('change', (e) => { state.layers.sats = e.target.checked; refreshAll(); });
    $('layerQuakes').addEventListener('change', (e) => { state.layers.quakes = e.target.checked; refreshAll(); });
    $('layerWeather').addEventListener('change', async (e) => { state.layers.weather = e.target.checked; await setWeatherEnabled(state.layers.weather); });
    $('layerTraffic').addEventListener('change', (e) => { state.layers.traffic = e.target.checked; setTrafficEnabled(state.layers.traffic); });
    $('layerCctv').addEventListener('change', (e) => { state.layers.cctv = e.target.checked; if (!state.layers.cctv) clearCctv(); });

    $('refreshBtn').addEventListener('click', () => refreshAll());

    $$('#bottomBar [data-style]').forEach((b) => b.addEventListener('click', () => applyStyle(b.dataset.style)));

    $('modeLive').addEventListener('click', () => { state.mode = 'LIVE'; $('modeLive').classList.add('active'); $('modePause').classList.remove('active'); });
    $('modePause').addEventListener('click', () => { state.mode = 'PAUSE'; $('modePause').classList.add('active'); $('modeLive').classList.remove('active'); });

    ['bloom','sharpen','noise','pixelation','intensity','saturation'].forEach((id) => $(id).addEventListener('input', applyFxFromUi));

    $('toggleMap').addEventListener('click', toggle2dMap);

    $('saveWorker').addEventListener('click', () => {
      const v = ($('workerBase').value || '').trim();
      state.workerBase = v;
      localStorage.setItem(LS_WORKER, v);
      alert('Saved Worker URL. Refresh page.');
    });

    $('saveIon').addEventListener('click', () => {
      const v = ($('ionToken').value || '').trim();
      state.ionToken = v;
      localStorage.setItem(LS_ION, v);
      alert('Saved Ion token. Refresh page.');
    });

    $('cctvProject').addEventListener('click', () => { state.layers.cctv = true; $('layerCctv').checked = true; projectCctv(); });

    rebuildBloom();
    applyFxFromUi();
    applyStyle('NORMAL');

    setWeatherEnabled(state.layers.weather);
    setTrafficEnabled(state.layers.traffic);

    initTelemetry();
    refreshAll();
    setInterval(refreshAll, 15000);
  });
})();
