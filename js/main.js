/*
  WorldView V2 — Free & Legal Edition

  FIX:
  - No shader header redeclare (czm_viewport/out_FragColor/etc).
  - Start Viewer with OSM imageryProvider to avoid any Ion calls.
*/

(function () {
  const LS_WORKER = 'worldview.workerBase';
  let viewer;

  const state = {
    style: 'NORMAL',
    mode: 'LIVE',
    workerBase: localStorage.getItem(LS_WORKER) || '',
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
      const statesArr = json.states || [];
      layers.flights.entities.removeAll();
      for (const st of statesArr.slice(0, 900)) {
        const [icao24, callsign, originCountry, , , lon, lat, baroAlt, , velocity, heading, , , geoAlt] = st;
        if (lat == null || lon == null) continue;
        const altM = (geoAlt != null ? geoAlt : (baroAlt != null ? baroAlt : 0));
        const labelText = (callsign || icao24 || '').trim();
        layers.flights.entities.add({
          position: Cesium.Cartesian3.fromDegrees(lon, lat, altM),
          point: { pixelSize: 4, color: Cesium.Color.fromCssColorString('#ffd166'), outlineColor: Cesium.Color.BLACK, outlineWidth: 1 },
          label: { text: labelText, font: '10px sans-serif', fillColor: Cesium.Color.WHITE, pixelOffset: new Cesium.Cartesian2(0, -12), showBackground: false,
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0.0, 1.4e6) },
          properties: { type: 'flight', icao24, callsign: labelText, originCountry, velocity, heading },
        });
      }
    } catch (e) { console.warn('Flights fetch failed', e); }
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
          point: { pixelSize: Math.min(22, 4 + mag * 3.1), color: Cesium.Color.fromCssColorString('#ff5f75').withAlpha(0.65),
            outlineColor: Cesium.Color.fromCssColorString('#ffd166').withAlpha(0.9), outlineWidth: 1 },
          label: { text: mag.toFixed(1), font: '10px sans-serif', fillColor: Cesium.Color.WHITE, pixelOffset: new Cesium.Cartesian2(0, -12), showBackground: false,
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0.0, 5.0e6) },
          properties: { type: 'quake', mag, depthKm },
        });
      }
    } catch (e) { console.warn('Earthquakes fetch failed', e); }
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
    } catch (e) { console.warn('Satellites fetch failed', e); }
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

  // CCTV projection
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

  // --- Post FX (NO redeclare!) ---
  let stages = { bloom: null, sharpen: null, noise: null, style: null, pixel: null };

  function resetPostFx() { viewer.scene.postProcessStages.removeAll(); stages = { bloom: null, sharpen: null, noise: null, style: null, pixel: null }; }

  function addBloom(v) {
    const s = Cesium.PostProcessStageLibrary.createBloomStage();
    s.enabled = v > 0;
    viewer.scene.postProcessStages.add(s);
    stages.bloom = s;
    applyBloom(v);
  }
  function applyBloom(v) {
    if (!stages.bloom) return;
    stages.bloom.enabled = v > 0.01;
    stages.bloom.uniforms.brightness = Cesium.Math.lerp(-0.35, 0.15, v);
    stages.bloom.uniforms.sigma = Cesium.Math.lerp(1.2, 3.6, v);
  }

  function addSharpen(v) {
    const st = new Cesium.PostProcessStage({
      fragmentShader: `
uniform sampler2D colorTexture;
in vec2 v_textureCoordinates;
out vec4 out_FragColor;
uniform vec4 czm_viewport;
uniform float amount;
void main(){
  vec2 uv = v_textureCoordinates;
  vec2 px = 1.0 / czm_viewport.zw;
  vec4 c = texture(colorTexture, uv);
  vec4 n = texture(colorTexture, uv + vec2(0.0, px.y));
  vec4 s = texture(colorTexture, uv - vec2(0.0, px.y));
  vec4 e = texture(colorTexture, uv + vec2(px.x, 0.0));
  vec4 w = texture(colorTexture, uv - vec2(px.x, 0.0));
  vec4 edge = (n + s + e + w - 4.0*c);
  out_FragColor = c - edge * amount;
}`,
      uniforms: { amount: v },
    });
    viewer.scene.postProcessStages.add(st);
    stages.sharpen = st;
    applySharpen(v);
  }
  function applySharpen(v) {
    if (!stages.sharpen) return;
    stages.sharpen.uniforms.amount = v * 0.75;
    stages.sharpen.enabled = v > 0.01;
  }

  function addNoise(v) {
    const st = new Cesium.PostProcessStage({
      fragmentShader: `
uniform sampler2D colorTexture;
in vec2 v_textureCoordinates;
out vec4 out_FragColor;
uniform float amount;
float rand(vec2 co){ return fract(sin(dot(co.xy, vec2(12.9898,78.233))) * 43758.5453); }
void main(){
  vec4 c = texture(colorTexture, v_textureCoordinates);
  float r = rand(v_textureCoordinates * 1000.0);
  c.rgb += (r-0.5)*amount;
  out_FragColor = c;
}`,
      uniforms: { amount: v },
    });
    viewer.scene.postProcessStages.add(st);
    stages.noise = st;
    applyNoise(v);
  }
  function applyNoise(v) {
    if (!stages.noise) return;
    stages.noise.uniforms.amount = v * 0.08;
    stages.noise.enabled = v > 0.01;
  }

  function addPixelation(v) {
    const st = new Cesium.PostProcessStage({
      fragmentShader: `
uniform sampler2D colorTexture;
in vec2 v_textureCoordinates;
out vec4 out_FragColor;
uniform float amount;
void main(){
  vec2 uv = v_textureCoordinates;
  float px = mix(1.0, 200.0, amount);
  vec2 q = floor(uv * px) / px;
  out_FragColor = texture(colorTexture, q);
}`,
      uniforms: { amount: v },
    });
    viewer.scene.postProcessStages.add(st);
    stages.pixel = st;
    applyPixelation(v);
  }
  function applyPixelation(v) {
    if (!stages.pixel) return;
    stages.pixel.uniforms.amount = v;
    stages.pixel.enabled = v > 0.01;
  }

  function addStyleStage(style) {
    const shaders = {
      NORMAL: null,
      CRT: `
uniform sampler2D colorTexture;
in vec2 v_textureCoordinates;
out vec4 out_FragColor;
uniform float intensity;
uniform float saturation;
void main(){
  vec2 uv = v_textureCoordinates;
  vec4 c = texture(colorTexture, uv);
  float shift = 0.0012 * intensity;
  float r = texture(colorTexture, uv + vec2(shift,0.0)).r;
  float b = texture(colorTexture, uv - vec2(shift,0.0)).b;
  c.rgb = vec3(r, c.g, b);
  vec2 p = uv - 0.5;
  float v = smoothstep(0.65, 0.10, dot(p,p));
  c.rgb *= mix(0.65, 1.0, v);
  float g = (c.r + c.g + c.b)/3.0;
  c.rgb = mix(vec3(g), c.rgb, 1.0 + saturation);
  out_FragColor = c;
}`,
      NVG: `
uniform sampler2D colorTexture;
in vec2 v_textureCoordinates;
out vec4 out_FragColor;
uniform float intensity;
void main(){
  vec4 c = texture(colorTexture, v_textureCoordinates);
  float g = dot(c.rgb, vec3(0.299,0.587,0.114));
  g = pow(g, 0.85);
  vec3 nvg = vec3(0.06, 1.0, 0.12) * g;
  nvg *= (1.0 + intensity*0.35);
  out_FragColor = vec4(nvg, c.a);
}`,
      FLIR: `
uniform sampler2D colorTexture;
in vec2 v_textureCoordinates;
out vec4 out_FragColor;
uniform float intensity;
uniform float saturation;
vec3 ramp(float t){
  t = clamp(t, 0.0, 1.0);
  vec3 a = vec3(0.05,0.05,0.08);
  vec3 b = vec3(0.1,0.2,0.6);
  vec3 c = vec3(0.9,0.65,0.05);
  vec3 d = vec3(1.0,1.0,1.0);
  if(t < 0.35) return mix(a,b,t/0.35);
  if(t < 0.75) return mix(b,c,(t-0.35)/0.40);
  return mix(c,d,(t-0.75)/0.25);
}
void main(){
  vec4 c0 = texture(colorTexture, v_textureCoordinates);
  float l = dot(c0.rgb, vec3(0.299,0.587,0.114));
  l = smoothstep(0.05, 0.95, l);
  l = mix(l, pow(l, 0.55), intensity);
  vec3 col = ramp(l);
  float g = (col.r + col.g + col.b)/3.0;
  col = mix(vec3(g), col, 1.0 + saturation);
  out_FragColor = vec4(col, c0.a);
}`,
      NOIR: `
uniform sampler2D colorTexture;
in vec2 v_textureCoordinates;
out vec4 out_FragColor;
void main(){
  vec4 c = texture(colorTexture, v_textureCoordinates);
  float g = dot(c.rgb, vec3(0.299,0.587,0.114));
  g = smoothstep(0.05, 0.95, g);
  out_FragColor = vec4(vec3(g), c.a);
}`,
      SNOW: `
uniform sampler2D colorTexture;
in vec2 v_textureCoordinates;
out vec4 out_FragColor;
uniform float intensity;
float rand(vec2 co){ return fract(sin(dot(co.xy, vec2(12.9898,78.233))) * 43758.5453); }
void main(){
  vec4 c = texture(colorTexture, v_textureCoordinates);
  float g = dot(c.rgb, vec3(0.299,0.587,0.114));
  c.rgb = mix(c.rgb, vec3(g)*vec3(0.85,0.95,1.0), 0.65);
  float r = rand(v_textureCoordinates*vec2(1200.0,800.0));
  c.rgb += (r-0.5)*0.06*intensity;
  out_FragColor = c;
}`,
      ANIME: `
uniform sampler2D colorTexture;
in vec2 v_textureCoordinates;
out vec4 out_FragColor;
uniform float intensity;
void main(){
  vec4 c = texture(colorTexture, v_textureCoordinates);
  float levels = mix(10.0, 4.0, intensity);
  c.rgb = floor(c.rgb * levels)/levels;
  out_FragColor = c;
}`,
    };

    const src = shaders[style];
    if (!src) { stages.style = null; return; }

    const st = new Cesium.PostProcessStage({ fragmentShader: src, uniforms: { intensity: state.fx.intensity, saturation: state.fx.saturation } });
    viewer.scene.postProcessStages.add(st);
    stages.style = st;
  }

  function applyStyle(style) {
    state.style = style;
    $('activeStyle').textContent = `STYLE: ${style}`;
    $('crtOverlay').classList.toggle('on', style === 'CRT');

    resetPostFx();
    addBloom(state.fx.bloom);
    addSharpen(state.fx.sharpen);
    addPixelation(state.fx.pixelation);
    addStyleStage(style);
    addNoise(state.fx.noise);

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
    applySharpen(sharpen);
    applyNoise(noise);
    applyPixelation(pix);

    if (stages.style?.uniforms) {
      if ('intensity' in stages.style.uniforms) stages.style.uniforms.intensity = intensity;
      if ('saturation' in stages.style.uniforms) stages.style.uniforms.saturation = sat;
    }
  }

  let map2d;
  function init2dMap() {
    const el = $('miniMapWrap');
    if (!el || map2d) return;

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
      if (!map2d) return;
      const c = viewer.camera.positionCartographic;
      map2d.jumpTo({ center: [Cesium.Math.toDegrees(c.longitude), Cesium.Math.toDegrees(c.latitude)], zoom: 3.5 });
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
    if (typeof Cesium === 'undefined') { alert('Cesium failed to load (check network).'); return; }

    // IMPORTANT: Avoid Ion from the start (no token needed)
    Cesium.Ion.defaultAccessToken = "";

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

    viewer.scene.fog.enabled = true;
    viewer.scene.fog.density = 0.00015;

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

    $('workerBase').value = state.workerBase;
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
    applyFxFromUi();

    $('toggleMap').addEventListener('click', toggle2dMap);

    $('saveWorker').addEventListener('click', () => {
      const v = ($('workerBase').value || '').trim();
      state.workerBase = v;
      localStorage.setItem(LS_WORKER, v);
      alert('Saved. Refresh for immediate effect.');
    });

    $('cctvProject').addEventListener('click', () => { state.layers.cctv = true; $('layerCctv').checked = true; projectCctv(); });

    applyStyle('NORMAL');
    setWeatherEnabled(state.layers.weather);
    setTrafficEnabled(state.layers.traffic);

    initTelemetry();
    refreshAll();
    setInterval(refreshAll, 15000);
  });
})();
