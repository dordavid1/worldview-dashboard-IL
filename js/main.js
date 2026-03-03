/*
  WorldView — Stable Full HUD build
  Fixes:
  - NO custom WebGL fragment shaders (they were crashing Cesium on WebGL2)
  - Uses FREE OSM imagery by default (no ion token required)
  - Worker endpoints implemented: /api/flights, /api/satellites, /api/earthquakes
  Notes:
  - "Sharpen/Noise/Pixelation" sliders drive SAFE CSS overlays (not WebGL).
*/

(function(){
  const LS_WORKER = 'worldview.workerBase';
  const LS_ION    = 'worldview.ionToken';

  const state = {
    style: 'NORMAL',
    mode: 'LIVE',
    workerBase: localStorage.getItem(LS_WORKER) || '',
    ionToken: localStorage.getItem(LS_ION) || '',
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

  const $ = (id) => document.getElementById(id);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  function setBadge(id, v){ const el = $(id); if(el) el.textContent = String(v); }

  function nowRecString(){
    const d = new Date();
    const pad = (n) => String(n).padStart(2,'0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

  // ---- URL helper (worker or same-origin) ----
  function apiUrl(path, params){
    const base = (state.workerBase || '').replace(/\/$/, '');
    let url;
    if(base){
      const u = new URL(base);
      url = new URL(u.origin + path);
    } else {
      url = new URL(path, window.location.origin);
    }
    if(params){
      for(const [k,v] of Object.entries(params)){
        if(v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  async function safeJson(url){
    const r = await fetch(url, { cache: 'no-store' });
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    if(!r.ok){
      const t = await r.text().catch(()=>'');
      throw new Error(`${r.status} ${r.statusText} — ${t.slice(0,160)}`);
    }
    if(!ct.includes('application/json')){
      const t = await r.text().catch(()=>'');
      throw new Error(`Expected JSON, got "${ct}" — ${t.slice(0,120)}`);
    }
    return await r.json();
  }

  // ---- Cesium viewer ----
  let viewer;
  let bloomStage = null;

  function initViewer(){
    // Apply ion token only if you saved it.
    if(state.ionToken){
      try {
        Cesium.Ion.defaultAccessToken = state.ionToken;
        $('ionNote').textContent = 'ion token saved locally ✅';
      } catch {
        $('ionNote').textContent = 'ion token failed to apply (still ok without it).';
      }
    } else {
      $('ionNote').textContent = 'No ion token (OK). Using free OSM imagery.';
    }

    viewer = new Cesium.Viewer('viewer',{
      animation:false,
      timeline:false,
      geocoder:false,
      homeButton:true,
      baseLayerPicker:false,
      sceneModePicker:true,
      navigationHelpButton:false,
      fullscreenButton:true,
      infoBox:true,
      selectionIndicator:true,
      shouldAnimate:true,
      terrainProvider: new Cesium.EllipsoidTerrainProvider(),
      imageryProvider: new Cesium.OpenStreetMapImageryProvider({
        url: 'https://a.tile.openstreetmap.org/'
      }),
    });

    viewer.scene.globe.enableLighting = true;
    viewer.scene.fog.enabled = true;
    viewer.scene.fog.density = 0.00015;

    // Bloom (built-in, safe)
    bloomStage = Cesium.PostProcessStageLibrary.createBloomStage();
    bloomStage.enabled = true;
    viewer.scene.postProcessStages.add(bloomStage);
    applyBloom(state.fx.bloom);

    // Start camera
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(-97.7431, 30.2672, 6000),
      orientation: { heading: 0.0, pitch: Cesium.Math.toRadians(-35), roll: 0.0 },
      duration: 0.0,
    });
  }

  function applyBloom(v){
    if(!bloomStage) return;
    const vv = clamp(v,0,1);
    bloomStage.enabled = vv > 0.01;
    bloomStage.uniforms.brightness = Cesium.Math.lerp(-0.35, 0.15, vv);
    bloomStage.uniforms.sigma = Cesium.Math.lerp(1.2, 3.6, vv);
    bloomStage.uniforms.delta = 1.0;
    bloomStage.uniforms.stepSize = 1.0;
    bloomStage.uniforms.contrast = 128;
  }

  // ---- DataSources ----
  const ds = {
    flights: null,
    sats: null,
    quakes: null,
    traffic: null,
    cctv: null,
  };

  function dsCount(){
    let c=0;
    for(const k of Object.keys(ds)){
      if(ds[k] && ds[k].entities) c += ds[k].entities.values.length;
    }
    return c;
  }

  // ---- Flights ----
  async function updateFlights(){
    if(!state.layers.flights){ ds.flights.entities.removeAll(); return; }

    // prefer worker; if none provided, this will 404 (expected)
    const url = apiUrl('/api/flights', { extended: 1 });
    try{
      const json = await safeJson(url);
      const arr = json.states || [];
      ds.flights.entities.removeAll();
      const list = arr.slice(0, 900);
      for(const st of list){
        const [icao24, callsign, originCountry, timePos, lastContact, lon, lat, baroAlt, onGround, velocity, heading, verticalRate, sensors, geoAlt] = st;
        if(lat == null || lon == null) continue;
        const altM = (geoAlt != null ? geoAlt : (baroAlt != null ? baroAlt : 0));
        const label = (callsign || icao24 || '').trim();

        ds.flights.entities.add({
          position: Cesium.Cartesian3.fromDegrees(lon, lat, altM),
          point: {
            pixelSize: 4,
            color: Cesium.Color.fromCssColorString('#ffd166'),
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 1,
          },
          label: {
            text: label,
            font: '10px sans-serif',
            fillColor: Cesium.Color.WHITE,
            pixelOffset: new Cesium.Cartesian2(0, -12),
            showBackground: false,
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0.0, 1.4e6),
          },
          properties: { type:'flight', icao24, callsign:label, originCountry, velocity, heading, lastContact },
        });
      }
    }catch(e){
      // Keep UI alive
      console.warn('Flights failed:', e.message || e);
    }
  }

  // ---- Quakes (USGS via worker) ----
  async function updateQuakes(){
    if(!state.layers.quakes){ ds.quakes.entities.removeAll(); return; }
    const url = apiUrl('/api/earthquakes');
    try{
      const json = await safeJson(url);
      const feats = json.features || [];
      ds.quakes.entities.removeAll();

      for(const f of feats){
        const coords = f.geometry?.coordinates;
        if(!coords || coords.length < 3) continue;
        const [lon, lat, depthKm] = coords;
        const mag = f.properties?.mag ?? 1.0;
        const t = f.properties?.time ? new Date(f.properties.time).toISOString().slice(0,19).replace('T',' ') : '';

        ds.quakes.entities.add({
          position: Cesium.Cartesian3.fromDegrees(lon, lat, -Math.abs(depthKm)*1000),
          point: {
            pixelSize: Math.min(22, 4 + mag*3.1),
            color: Cesium.Color.fromCssColorString('#ff5f75').withAlpha(0.65),
            outlineColor: Cesium.Color.fromCssColorString('#ffd166').withAlpha(0.9),
            outlineWidth: 1,
          },
          label: {
            text: Number(mag).toFixed(1),
            font: '10px sans-serif',
            fillColor: Cesium.Color.WHITE,
            pixelOffset: new Cesium.Cartesian2(0, -12),
            showBackground: false,
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0.0, 5.0e6),
          },
          description: `<div style="font-family:ui-monospace,monospace; font-size:12px;">MAG ${Number(mag).toFixed(1)} · DEPTH ${depthKm}km<br/>${t}</div>`,
          properties: { type:'quake', mag, depthKm, time:t },
        });
      }
    }catch(e){
      console.warn('Quakes failed:', e.message || e);
    }
  }

  // ---- Satellites (CelesTrak JSON via worker) ----
  async function updateSats(){
    if(!state.layers.sats){ ds.sats.entities.removeAll(); return; }
    const url = apiUrl('/api/satellites', { group:'active' });
    try{
      const sats = await safeJson(url);
      ds.sats.entities.removeAll();

      const now = new Date();
      const limit = 350;
      for(const sat of (Array.isArray(sats) ? sats.slice(0,limit) : [])){
        const line1 = sat.line1 || sat.TLE_LINE1;
        const line2 = sat.line2 || sat.TLE_LINE2;
        if(!line1 || !line2) continue;

        try{
          const rec = satellite.twoline2satrec(line1, line2);
          const pv = satellite.propagate(rec, now);
          if(!pv.position) continue;
          const gmst = satellite.gstime(now);
          const gd = satellite.eciToGeodetic(pv.position, gmst);
          const lon = satellite.degreesLong(gd.longitude);
          const lat = satellite.degreesLat(gd.latitude);
          const alt = gd.height * 1000;

          const name = (sat.satelliteName || sat.objectName || sat.OBJECT_NAME || '').toString().slice(0,24);
          const norad = sat.noradCatId || sat.NORAD_CAT_ID || '';

          ds.sats.entities.add({
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
            properties: { type:'sat', norad, name },
          });
        }catch(_){}
      }
    }catch(e){
      console.warn('Sats failed:', e.message || e);
    }
  }

  // Weather (RainViewer) — direct (no key)
  let weatherLayer = null;
  async function setWeatherEnabled(enabled){
    if(!enabled){
      if(weatherLayer){ viewer.imageryLayers.remove(weatherLayer, true); weatherLayer=null; }
      return;
    }
    try{
      const meta = await safeJson('https://api.rainviewer.com/public/weather-maps.json');
      const frames = meta?.radar?.past || [];
      const last = frames[frames.length-1];
      if(!last) return;
      const template = `https://tilecache.rainviewer.com${last.path}/256/{z}/{x}/{y}/2/1_1.png`;
      const provider = new Cesium.UrlTemplateImageryProvider({ url: template, credit:'RainViewer' });
      weatherLayer = viewer.imageryLayers.addImageryProvider(provider);
      weatherLayer.alpha = 0.55;
    }catch(e){
      console.warn('Weather failed:', e.message || e);
    }
  }

  // Traffic glow (simulated)
  let trafficTimer = null;
  function setTrafficEnabled(enabled){
    if(!enabled){
      if(trafficTimer) clearInterval(trafficTimer);
      trafficTimer=null;
      ds.traffic.entities.removeAll();
      return;
    }
    const seed = () => {
      ds.traffic.entities.removeAll();
      const carto = viewer.camera.positionCartographic;
      const centerLon = Cesium.Math.toDegrees(carto.longitude);
      const centerLat = Cesium.Math.toDegrees(carto.latitude);
      const N = 600;
      for(let i=0;i<N;i++){
        const lon = centerLon + (Math.random()-0.5)*0.28;
        const lat = centerLat + (Math.random()-0.5)*0.22;
        ds.traffic.entities.add({
          position: Cesium.Cartesian3.fromDegrees(lon, lat, 0),
          point: { pixelSize:2, color: Cesium.Color.fromCssColorString('#ffd166').withAlpha(0.35) },
          properties: { type:'traffic' }
        });
      }
    };
    seed();
    trafficTimer = setInterval(seed, 8000);
  }

  // CCTV projection (ground quad)
  let cctvEntity = null;
  function clearCctv(){
    if(cctvEntity){ ds.cctv.entities.remove(cctvEntity); cctvEntity=null; }
  }

  async function projectCctv(){
    const url = ($('cctvUrl').value || '').trim();
    const lat = parseFloat(($('cctvLat').value || '').trim());
    const lon = parseFloat(($('cctvLon').value || '').trim());
    if(!url || Number.isNaN(lat) || Number.isNaN(lon)){
      alert('CCTV: please provide URL + lat/lon');
      return;
    }
    clearCctv();

    const half = 0.0012; // ~130m
    const rect = Cesium.Rectangle.fromDegrees(lon-half, lat-half, lon+half, lat+half);

    const video = document.createElement('video');
    video.src = url;
    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.autoplay = true;

    try{ await video.play(); }catch(_){ /* user gesture may be required */ }

    cctvEntity = ds.cctv.entities.add({
      rectangle: { coordinates: rect, material: video, height: 0 },
      properties: { type:'cctv', url }
    });

    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, 900),
      orientation: { heading: 0.0, pitch: Cesium.Math.toRadians(-45), roll: 0 },
      duration: 1.2,
    });
  }

  // ---- Style system (CSS) ----
  function applyStyle(style){
    state.style = style;
    $('activeStyle').textContent = `STYLE: ${style}`;

    const vp = $('viewport');
    const all = ['NORMAL','CRT','NVG','FLIR','NOIR','SNOW','ANIME'];
    all.forEach(s => vp.classList.remove('style-' + s));
    vp.classList.add('style-' + style);

    // UI active buttons
    $$('#styleBar .btn[data-style]').forEach(b => b.classList.toggle('active', b.dataset.style === style));
    applyFxFromUi(); // re-apply overlays (intensity etc)
  }

  function applyFxFromUi(){
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

    // SAFE overlays (no WebGL):
    const vp = $('viewport');
    const grain = $('grain');
    const scan = $('scanlines');
    const tint = $('tint');

    // intensity drives overlay strength
    const inten = clamp(intensity, 0, 1);

    grain.style.opacity = String(clamp(noise * 0.6 * inten, 0, 0.6));
    scan.style.opacity = String(clamp((state.style === 'CRT' ? 0.55 : 0.15) * inten, 0, 0.75));

    // "sharpen" simulated by raising contrast a bit
    const contrastBoost = 1 + sharpen*0.18;
    const saturateBoost = 1 + sat*0.35;
    const brightBoost = 1 + pix*0.06; // small bump (pixelation is only "feel" here)
    vp.style.filter = (function(){
      // keep the base style filters by using CSS variables? easiest: append a generic filter
      return `contrast(${contrastBoost}) saturate(${saturateBoost}) brightness(${brightBoost})`;
    })();

    // tint opacity slightly follows saturation/intensity
    tint.style.opacity = String(clamp(0.10 + Math.abs(sat)*0.08 + inten*0.05, 0.06, 0.22));
  }

  // ---- 2D Map ----
  let map2d = null;
  function init2dMap(){
    if(map2d) return;
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
        layers: [{ id: 'osm', type:'raster', source:'osm' }],
      },
      center: [0,20],
      zoom: 1.6,
      attributionControl: false,
    });

    const sync = () => {
      if(!map2d) return;
      const c = viewer.camera.positionCartographic;
      const lon = Cesium.Math.toDegrees(c.longitude);
      const lat = Cesium.Math.toDegrees(c.latitude);
      map2d.jumpTo({ center:[lon,lat], zoom: 3.5 });
    };

    viewer.camera.changed.addEventListener(() => {
      if(sync._t) return;
      sync._t = setTimeout(() => { sync._t = null; sync(); }, 250);
    });
  }

  function toggle2dMap(){
    const wrap = $('miniMapWrap');
    const on = wrap.style.display !== 'block';
    wrap.style.display = on ? 'block' : 'none';
    if(on) init2dMap();
  }

  // ---- Refresh loop ----
  async function refreshAll(){
    if(state.mode !== 'LIVE') return;
    await Promise.all([ updateFlights(), updateSats(), updateQuakes() ]);
    setBadge('entityCount', dsCount());
  }

  function initTelemetry(){
    let last = performance.now();
    let frames = 0;
    function tick(){
      frames++;
      const t = performance.now();
      if(t - last >= 1000){
        setBadge('fps', Math.round((frames*1000)/(t-last)));
        frames = 0; last = t;
      }
      setBadge('simTime', new Date().toISOString().slice(11,19));
      $('recTime').textContent = nowRecString();
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  // ---- Boot ----
  window.addEventListener('load', () => {
    if(typeof Cesium === 'undefined'){
      alert('Cesium failed to load (check network).');
      return;
    }

    // UI init values
    $('workerBase').value = state.workerBase;
    $('ionToken').value = state.ionToken;

    // init viewer
    initViewer();

    // datasources
    ds.flights = new Cesium.CustomDataSource('flights');
    ds.sats = new Cesium.CustomDataSource('satellites');
    ds.quakes = new Cesium.CustomDataSource('earthquakes');
    ds.traffic = new Cesium.CustomDataSource('traffic');
    ds.cctv = new Cesium.CustomDataSource('cctv');

    viewer.dataSources.add(ds.flights);
    viewer.dataSources.add(ds.sats);
    viewer.dataSources.add(ds.quakes);
    viewer.dataSources.add(ds.traffic);
    viewer.dataSources.add(ds.cctv);

    // Layer checkboxes
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
    $('layerCctv').addEventListener('change', (e) => { state.layers.cctv = e.target.checked; if(!state.layers.cctv) clearCctv(); });

    $('refreshBtn').addEventListener('click', () => refreshAll());

    // Style buttons
    $$('#styleBar [data-style]').forEach((b) => b.addEventListener('click', () => applyStyle(b.dataset.style)));

    // Mode
    $('modeLive').addEventListener('click', () => {
      state.mode = 'LIVE';
      $('modeLive').classList.add('active');
      $('modePause').classList.remove('active');
      refreshAll();
    });
    $('modePause').addEventListener('click', () => {
      state.mode = 'PAUSE';
      $('modePause').classList.add('active');
      $('modeLive').classList.remove('active');
    });

    // FX sliders
    ['bloom','sharpen','noise','pixelation','intensity','saturation'].forEach((id) => $(id).addEventListener('input', applyFxFromUi));
    applyFxFromUi();

    // 2D map toggle
    $('toggleMap').addEventListener('click', toggle2dMap);

    // Save worker base
    $('saveWorker').addEventListener('click', () => {
      state.workerBase = ($('workerBase').value || '').trim().replace(/\/$/,'');
      localStorage.setItem(LS_WORKER, state.workerBase);
      alert('Saved Worker URL. Reloading…');
      location.reload();
    });

    // Save ion token (stored locally only)
    $('saveIon').addEventListener('click', () => {
      state.ionToken = ($('ionToken').value || '').trim();
      localStorage.setItem(LS_ION, state.ionToken);
      alert('Saved ion token locally. Reloading…');
      location.reload();
    });

    // CCTV
    $('cctvProject').addEventListener('click', () => {
      state.layers.cctv = true;
      $('layerCctv').checked = true;
      projectCctv();
    });

    // Start
    applyStyle('NORMAL');
    setWeatherEnabled(state.layers.weather);
    setTrafficEnabled(state.layers.traffic);
    initTelemetry();
    refreshAll();
    setInterval(refreshAll, 15000);
  });
})();
