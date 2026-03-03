// ============================================================
//  WORLDVIEW — OSINT Global Intelligence Interface
//  app.js — All modules combined (Globe + Layers + UI + App)
// ============================================================

// ─── CONFIG ─────────────────────────────────────────────────
const WORKER_BASE = (() => {
  const h = window.location.hostname;
  if (h === 'localhost' || h === '127.0.0.1') return '';
  return 'https://worldview-worker.YOUR_ACCOUNT.workers.dev';
})();

const CITY_SUBLOCS = {
  'Austin':        ['Texas State Capitol','Frost Bank Tower','Pennybacker Bridge','The Jenga Tower','UT Tower'],
  'San Francisco': ['Golden Gate Bridge','Alcatraz','Transamerica Pyramid','Coit Tower','Bay Bridge'],
  'New York':      ['Empire State Building','Times Square','Central Park','Brooklyn Bridge','One WTC'],
  'Tokyo':         ['Tokyo Tower','Shibuya Crossing','Shinjuku','Akihabara','Skytree'],
  'London':        ['Tower Bridge','The Shard','Big Ben / Parliament',"St. Paul's Cathedral",'The Gherkin'],
  'Paris':         ['Eiffel Tower','Louvre','Arc de Triomphe','Notre Dame','Sacré-Cœur'],
  'Dubai':         ['Burj Khalifa','Palm Jumeirah','Dubai Mall','Burj Al Arab','Museum of the Future'],
  'Washington DC': ['US Capitol','Washington Monument','Lincoln Memorial','Pentagon','Jefferson Memorial'],
};

const LANDMARK_COORDS = {
  'Texas State Capitol': [30.2747,-97.7404,16], 'Frost Bank Tower': [30.2665,-97.7437,17],
  'Pennybacker Bridge': [30.3659,-97.7903,15],  'The Jenga Tower': [30.2660,-97.7424,17],
  'UT Tower': [30.2849,-97.7341,16],             'Golden Gate Bridge': [37.8199,-122.4783,15],
  'Alcatraz': [37.8267,-122.4230,15],            'Transamerica Pyramid': [37.7952,-122.4028,17],
  'Coit Tower': [37.8024,-122.4058,16],          'Bay Bridge': [37.7983,-122.3778,15],
  'Empire State Building': [40.7484,-73.9857,17],'Times Square': [40.7580,-73.9855,16],
  'Central Park': [40.7829,-73.9654,14],         'Brooklyn Bridge': [40.7061,-73.9969,16],
  'One WTC': [40.7127,-74.0134,17],              'Tokyo Tower': [35.6586,139.7454,16],
  'Shibuya Crossing': [35.6595,139.7005,17],     'Skytree': [35.7101,139.8107,16],
  'Tower Bridge': [51.5055,-0.0754,16],          'The Shard': [51.5045,-0.0865,16],
  'Big Ben / Parliament': [51.5007,-0.1246,17],  "St. Paul's Cathedral": [51.5138,-0.0984,16],
  'The Gherkin': [51.5145,-0.0804,17],           'Eiffel Tower': [48.8584,2.2945,16],
  'Louvre': [48.8606,2.3376,16],                 'Arc de Triomphe': [48.8738,2.2950,17],
  'Burj Khalifa': [25.1972,55.2744,16],          'Palm Jumeirah': [25.1124,55.1390,13],
  'US Capitol': [38.8899,-77.0091,16],           'Washington Monument': [38.8895,-77.0352,17],
  'Lincoln Memorial': [38.8893,-77.0502,17],     'Pentagon': [38.8719,-77.0563,15],
  'Jefferson Memorial': [38.8814,-77.0365,17],
};

// ─── GLOBE CONTROLLER ───────────────────────────────────────
class GlobeController {
  constructor(mapId) {
    this.map = null;
    this.baseTile = null;
    this.groups = {};
    this.onMoveCb = null;
    this._init(mapId);
  }

  _init(id) {
    this.map = L.map(id, {
      center: [20, 0], zoom: 3,
      zoomControl: false, attributionControl: false,
      preferCanvas: true, renderer: L.canvas(),
      minZoom: 2, maxZoom: 19, worldCopyJump: true,
    });

    this._setTile('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}');

    ['flights','earthquakes','satellites','traffic','weather','cctv'].forEach(n => {
      this.groups[n] = L.layerGroup().addTo(this.map);
    });

    this.map.on('move', () => {
      if (this.onMoveCb) {
        const c = this.map.getCenter();
        this.onMoveCb(c.lat, c.lng, this.map.getZoom());
      }
    });

    // Resize overlay canvas
    this.map.on('moveend zoomend resize', () => this._syncCanvas());
    setTimeout(() => this._syncCanvas(), 400);
  }

  _syncCanvas() {
    const s = this.map.getSize();
    const oc = document.getElementById('oc');
    if (oc) { oc.width = s.x; oc.height = s.y; }
  }

  _setTile(url) {
    if (this.baseTile) this.map.removeLayer(this.baseTile);
    this.baseTile = L.tileLayer(url, { maxZoom:19, crossOrigin:true }).addTo(this.map);
    // Keep data layers on top
    Object.values(this.groups).forEach(g => { g.remove(); g.addTo(this.map); });
  }

  setOnMove(cb) { this.onMoveCb = cb; }

  flyTo(lat, lon, zoom = 14) {
    this.map.flyTo([lat, lon], zoom, { duration: 1.4, easeLinearity: 0.3 });
  }

  toggleGroup(name, visible) {
    if (!this.groups[name]) return;
    if (visible) { if (!this.map.hasLayer(this.groups[name])) this.groups[name].addTo(this.map); }
    else this.map.removeLayer(this.groups[name]);
  }

  clearGroup(name) { this.groups[name]?.clearLayers(); }

  // ─ Flights ─
  renderFlights(data) {
    this.clearGroup('flights');
    if (!data?.states) return;
    data.states.slice(0, 600).forEach(s => {
      if (!s[6] || !s[5]) return;
      const [, cs,,,, lon, lat,,,, head] = s;
      const icon = L.divIcon({
        className: '',
        html: `<div class="fmk" style="transform:rotate(${head||0}deg)">✈</div>`,
        iconSize: [20,20], iconAnchor: [10,10],
      });
      const m = L.marker([lat, lon], { icon });
      m.bindPopup(`<b>${(cs||'').trim()||'N/A'}</b><br>ALT: FL${Math.round((s[13]||0)/30.48)}<br>${Math.round(s[9]||0)} kts`, { closeButton: false });
      m.on('mouseover', () => m.openPopup()).on('mouseout', () => m.closePopup());
      this.groups.flights.addLayer(m);
    });
  }

  // ─ Earthquakes ─
  renderEarthquakes(data) {
    this.clearGroup('earthquakes');
    if (!data?.features) return;
    data.features.forEach(f => {
      const { mag, place } = f.properties;
      const [lon, lat] = f.geometry.coordinates;
      if (!lat || !lon) return;
      const sz = Math.max(8, mag * 6);
      const col = mag >= 5 ? '#FF3B3B' : mag >= 3 ? '#FFB020' : '#4FD1C5';
      const icon = L.divIcon({
        className:'',
        html:`<div style="width:${sz}px;height:${sz}px;border-radius:50%;background:${col}22;border:2px solid ${col};box-shadow:0 0 ${sz}px ${col};cursor:pointer"></div>`,
        iconSize:[sz,sz], iconAnchor:[sz/2,sz/2],
      });
      const m = L.marker([lat,lon],{icon});
      m.bindPopup(`<b>M${mag?.toFixed(1)}</b><br>${place}`,{closeButton:false});
      m.on('mouseover',()=>m.openPopup()).on('mouseout',()=>m.closePopup());
      this.groups.earthquakes.addLayer(m);
    });
  }

  // ─ Satellites ─
  renderSatellites(sats) {
    this.clearGroup('satellites');
    if (!sats?.length) return;
    // Orbit ring
    this.groups.satellites.addLayer(L.polyline(
      this._orbitPts(400,51.6), { color:'#FF3B3B', weight:1, opacity:.5, dashArray:'4 8' }
    ));
    // Sat markers (max 180)
    sats.slice(0,180).forEach(s => {
      if (!s.lat || !s.lon) return;
      const icon = L.divIcon({
        className:'',
        html:`<div class="smk">▪ SAT-${s.noradId||'?'}</div>`,
        iconSize:[80,16], iconAnchor:[40,8],
      });
      const m = L.marker([s.lat,s.lon],{icon});
      m.bindPopup(`<b>${s.name||'UNKNOWN'}</b><br>${Math.round(s.altitude||0)} km · NORAD ${s.noradId||''}`,{closeButton:false});
      m.on('mouseover',()=>m.openPopup()).on('mouseout',()=>m.closePopup());
      this.groups.satellites.addLayer(m);
    });
  }

  _orbitPts(alt, inc) {
    const pts = [];
    for (let t=0;t<=360;t+=2) {
      const r = t*Math.PI/180, ir = inc*Math.PI/180;
      const x=Math.cos(r), y=Math.sin(r)*Math.cos(ir), z=Math.sin(r)*Math.sin(ir);
      pts.push([Math.atan2(z,Math.sqrt(x*x+y*y))*180/Math.PI, Math.atan2(y,x)*180/Math.PI]);
    }
    return pts;
  }

  renderWeather(on) {
    this.clearGroup('weather');
    if (!on) return;
    this.groups.weather.addLayer(L.tileLayer(
      'https://tilecache.rainviewer.com/v2/radar/nowcast/256/{z}/{x}/{y}/4/1_1.png',
      { opacity:0.55, tileSize:256 }
    ));
  }

  renderTraffic(on) {
    this.clearGroup('traffic');
    if (!on) return;
    this.groups.traffic.addLayer(L.tileLayer(
      'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      { opacity:0.25, tileSize:256 }
    ));
  }

  addCCTVMarker(lat, lon, url, id) {
    const icon = L.divIcon({ className:'', html:'<div class="cmk">📹</div>', iconSize:[24,24], iconAnchor:[12,12] });
    const m = L.marker([lat,lon],{icon});
    m.bindPopup(`<b>CCTV STREAM</b><br>${lat.toFixed(4)}° ${lon.toFixed(4)}°<br>${url.slice(0,32)}…`,{closeButton:false});
    m.on('click',()=>window.dispatchEvent(new CustomEvent('cctv-click',{detail:{url,lat,lon,id}})));
    this.groups.cctv.addLayer(m);
  }

  applyPreset(p) {
    const tiles = {
      nvg:'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
      noir:'https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png',
    };
    this._setTile(tiles[p] || 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}');
  }
}

// ─── LAYER MANAGER ──────────────────────────────────────────
class LayerManager {
  constructor(globe) {
    this.globe = globe;
    this.state = {
      flights:{active:false,lastUpdate:null,count:0},
      earthquakes:{active:false,lastUpdate:null,count:0},
      satellites:{active:false,lastUpdate:null,count:0},
      traffic:{active:false,lastUpdate:null,count:0},
      weather:{active:false,lastUpdate:null,count:0},
      cctv:{active:false,streams:[],count:0},
    };
    this.live = true;
    this.timers = {};
    this.cbs = {};
    this._satPositions = this._genSatPositions();
  }

  on(e,cb){ this.cbs[e]=cb; }
  _emit(e,d){ this.cbs[e]?.(d); }

  async toggle(layer, active) {
    this.state[layer].active = active;
    if (active) {
      await this._fetch(layer);
      if (this.live) this._poll(layer);
    } else {
      clearInterval(this.timers[layer]);
      delete this.timers[layer];
      this.globe.toggleGroup(layer, false);
    }
  }

  setLive(live) {
    this.live = live;
    Object.keys(this.timers).forEach(l => { clearInterval(this.timers[l]); delete this.timers[l]; });
    if (live) Object.keys(this.state).forEach(l => { if (this.state[l].active) this._poll(l); });
  }

  async _fetch(layer) {
    this._emit('loading', { layer });
    try {
      let data;
      if (layer === 'flights')     data = await this._fetchFlights();
      else if (layer === 'earthquakes') data = await this._fetchEQ();
      else if (layer === 'satellites')  data = this._updateSats();
      else data = { enabled: true };

      if (data) {
        this.state[layer].lastUpdate = new Date();
        this._apply(layer, data);
        const count = this._count(layer, data);
        this.state[layer].count = count;
        this._emit('updated', { layer, count });
      }
    } catch(e) {
      console.warn('Layer fetch err:', layer, e.message);
      this._fallback(layer);
    }
  }

  async _fetchFlights() {
    // Try worker
    if (WORKER_BASE) {
      try {
        const r = await fetch(`${WORKER_BASE}/api/flights`, { signal: AbortSignal.timeout(8000) });
        if (r.ok) return await r.json();
      } catch{}
    }
    // CORS proxy
    try {
      const r = await fetch(`https://corsproxy.io/?${encodeURIComponent('https://opensky-network.org/api/states/all')}`, { signal: AbortSignal.timeout(10000) });
      if (r.ok) return await r.json();
    } catch{}
    return this._simFlights();
  }

  async _fetchEQ() {
    try {
      const r = await fetch('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson', { signal: AbortSignal.timeout(8000) });
      if (r.ok) return await r.json();
    } catch{}
    if (WORKER_BASE) {
      try {
        const r = await fetch(`${WORKER_BASE}/api/earthquakes`, { signal: AbortSignal.timeout(8000) });
        if (r.ok) return await r.json();
      } catch{}
    }
    return this._simEQ();
  }

  _updateSats() {
    const t = Date.now() / 1000;
    this._satPositions = this._satPositions.map(s => {
      const angle = ((t / s.period) * Math.PI * 2 + s.phase) % (Math.PI * 2);
      const ir = s.inclination * Math.PI / 180;
      const x = Math.cos(angle), y = Math.sin(angle)*Math.cos(ir), z = Math.sin(angle)*Math.sin(ir);
      const lat = Math.atan2(z, Math.sqrt(x*x+y*y)) * 180/Math.PI;
      let lon = ((Math.atan2(y,x)*180/Math.PI) + (t*s.prec)) % 360;
      return { ...s, lat, lon: lon>180 ? lon-360 : lon };
    });
    return this._satPositions;
  }

  _genSatPositions() {
    const names = ['ISS','STARLINK','HUBBLE','NOAA-15','TERRA','AQUA','LANDSAT-8','SENTINEL-2A','GOES-16','GOES-18','METEOSAT','HIMAWARI','METOP-A','METOP-B','SUOMI-NPP'];
    return Array.from({length:180}, (_,i) => ({
      noradId: 25000+i,
      name: names[i%names.length]+(i>=names.length?`-${Math.floor(i/names.length)}`:''),
      altitude: 350+Math.random()*800,
      inclination: 20+Math.random()*80,
      period: 5400+Math.random()*3600,
      phase: Math.random()*Math.PI*2,
      prec: (Math.random()-.5)*0.02,
      lat:0, lon:0,
    }));
  }

  _fallback(layer) {
    const data = layer==='flights'?this._simFlights() : layer==='earthquakes'?this._simEQ() : layer==='satellites'?this._updateSats():{enabled:true};
    this.state[layer].lastUpdate = new Date();
    this._apply(layer, data);
    const count = this._count(layer, data);
    this.state[layer].count = count;
    this._emit('updated', { layer, count });
  }

  _apply(layer, data) {
    this.globe.toggleGroup(layer, true);
    if (layer==='flights') this.globe.renderFlights(data);
    else if (layer==='earthquakes') this.globe.renderEarthquakes(data);
    else if (layer==='satellites') this.globe.renderSatellites(data);
    else if (layer==='weather') this.globe.renderWeather(true);
    else if (layer==='traffic') this.globe.renderTraffic(true);
  }

  _count(layer, data) {
    if (layer==='flights') return data?.states?.length||0;
    if (layer==='earthquakes') return data?.features?.length||0;
    if (layer==='satellites') return data?.length||0;
    return 0;
  }

  _poll(layer) {
    clearInterval(this.timers[layer]);
    const intervals = {flights:15000,earthquakes:60000,satellites:5000,weather:120000,traffic:30000};
    this.timers[layer] = setInterval(() => {
      if (this.state[layer].active && this.live) this._fetch(layer);
    }, intervals[layer]||30000);
  }

  addCCTV(url, lat, lon) {
    const id = `cctv-${Date.now()}`;
    this.globe.addCCTVMarker(lat, lon, url, id);
    this.state.cctv.streams.push({ id, url, lat, lon });
    this.state.cctv.count = this.state.cctv.streams.length;
    this.globe.toggleGroup('cctv', true);
    this._emit('updated', { layer:'cctv', count: this.state.cctv.count });
  }

  timeAgo(d) {
    if (!d) return 'never';
    const s = Math.floor((Date.now()-d)/1000);
    if (s<10) return 'just now'; if (s<60) return `${s}s ago`;
    if (s<3600) return `${Math.floor(s/60)}m ago`; return `${Math.floor(s/3600)}h ago`;
  }

  _simFlights() {
    return { states: Array.from({length:320},(_,i)=>[
      `ac${i.toString(16)}`,[`SIM${i}`].join('').padEnd(8),
      'SIM',null,null,(Math.random()-.5)*360,(Math.random()-.5)*130,
      10000+Math.random()*30000,false,200+Math.random()*400,Math.random()*360,
      null,null,10000+Math.random()*30000,null,false,0
    ]), time: Date.now()/1000, simulated:true };
  }

  _simEQ() {
    return { type:'FeatureCollection', features: Array.from({length:50},(_,i)=>({
      type:'Feature',
      properties:{ mag: parseFloat((1+Math.random()*6).toFixed(1)), place:`${Math.floor(Math.random()*500)}km from Somewhere` },
      geometry:{ type:'Point', coordinates:[(Math.random()-.5)*360,(Math.random()-.5)*150,Math.random()*100] }
    }))};
  }
}

// ─── UI CONTROLLER ──────────────────────────────────────────
class UIController {
  constructor() {
    this.preset = 'normal';
    this.cleanMode = false;
    this.cbs = {};
  }
  on(e,cb){ this.cbs[e]=cb; }
  _emit(e,d){ this.cbs[e]?.(d); }

  init() {
    this._bindPresets();
    this._bindCities();
    this._bindToggles();
    this._bindSliders();
    this._bindLive();
    this._bindPanels();
    this._bindActions();
    this._clock();
    this._panopticLoop();
    this._telemetryLoop();
  }

  _bindPresets() {
    document.querySelectorAll('.pb').forEach(b => {
      b.addEventListener('click', () => {
        const p = b.dataset.preset;
        document.body.className = document.body.className.replace(/mode-\w+/g,'').trim();
        if (p !== 'normal') document.body.classList.add(`mode-${p}`);
        document.querySelectorAll('.pb').forEach(x => x.classList.toggle('a', x.dataset.preset===p));
        const labels = {normal:'NORMAL',crt:'CRT',nvg:'NIGHT VISION',flir:'FLIR',anime:'ANIME',noir:'NOIR',snow:'SNOW',ai:'AI EDIT'};
        const name = labels[p]||p.toUpperCase();
        document.getElementById('asn').textContent = name;
        document.getElementById('mode-n').textContent = p.toUpperCase();
        this.preset = p;
        this._emit('preset', p);
        this.toast(`Style: ${name}`);
      });
    });
  }

  _bindCities() {
    document.querySelectorAll('.cb').forEach(b => {
      b.addEventListener('click', () => {
        document.querySelectorAll('.cb').forEach(x => x.classList.remove('a'));
        b.classList.add('a');
        const city = b.dataset.city;
        const lat = parseFloat(b.dataset.lat), lon = parseFloat(b.dataset.lon), zoom = +b.dataset.zoom||13;
        this._showSublocs(city);
        this._setSummary(city);
        this._emit('city', { city, lat, lon, zoom });
      });
    });
  }

  _showSublocs(city) {
    const row = document.getElementById('slr');
    row.innerHTML = '';
    (CITY_SUBLOCS[city]||[]).forEach((loc, i) => {
      const b = document.createElement('button');
      b.className = 'slb' + (i===0?' a':'');
      b.textContent = loc;
      b.addEventListener('click', () => {
        document.querySelectorAll('.slb').forEach(x=>x.classList.remove('a'));
        b.classList.add('a');
        const c = LANDMARK_COORDS[loc];
        if (c) this._emit('subloc', { lat:c[0], lon:c[1], zoom:c[2]||15 });
      });
      row.appendChild(b);
    });
    row.classList.remove('h');
  }

  _setSummary(city) {
    const el = document.getElementById('mode-sm');
    if (el) el.textContent = `${this.preset.toUpperCase()} STREET NEAR ${city.toUpperCase()}`;
  }

  _bindToggles() {
    document.querySelectorAll('.tb').forEach(b => {
      b.addEventListener('click', () => {
        const on = !b.classList.contains('on');
        b.classList.toggle('on', on);
        b.textContent = on ? 'ON' : 'OFF';
        this._emit('toggle', { layer: b.dataset.layer, active: on });
      });
    });
  }

  updateLayer(layer, count, ago) {
    const ids = { flights:['fc','fu'], earthquakes:['ec','eu'], satellites:['sc','su'],
                  traffic:['trc','tru'], weather:['wc','wu'], cctv:['clc','clu'] };
    const [cid, tid] = ids[layer]||[];
    if (cid && count!=null) document.getElementById(cid).textContent = count>=1000?`${(count/1e3).toFixed(1)}K`:count||'—';
    if (tid && ago) document.getElementById(tid).textContent = ago;
  }

  _bindSliders() {
    const bind = (id, valId, suffix, cb) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('input', () => {
        if (valId) document.getElementById(valId).textContent = el.value + suffix;
        cb?.(+el.value);
      });
    };
    bind('sbl','vbl','%', v => this._emit('bloom', v));
    bind('ssh','vsh','%', v => this._emit('sharpen', v));
    bind('spn','vpn','%', v => this._emit('panoptic', v));
    bind('spx',null,'', v => this._emit('pixel', v));
    bind('sds',null,'', v => this._emit('distort', v));
    bind('sin',null,'', v => this._emit('instab', v));
    document.getElementById('blr')?.addEventListener('click', () => {
      const s = document.getElementById('sbl'); s.value=100;
      document.getElementById('vbl').textContent='100%';
      this._emit('bloom',100);
    });
  }

  _bindLive() {
    document.getElementById('bl')?.addEventListener('click', () => {
      document.getElementById('bl').classList.add('active');
      document.getElementById('bp').classList.remove('active');
      this._emit('live', true); this.toast('LIVE MODE ACTIVE');
    });
    document.getElementById('bp')?.addEventListener('click', () => {
      document.getElementById('bp').classList.add('active');
      document.getElementById('bl').classList.remove('active');
      this._emit('live', false); this.toast('PAUSED');
    });
  }

  _bindPanels() {
    // CCTV expand
    document.getElementById('cctv-xb')?.addEventListener('click', () => {
      const b = document.getElementById('cctv-body');
      const btn = document.getElementById('cctv-xb');
      b.classList.toggle('col');
      btn.textContent = b.classList.contains('col') ? '+' : '−';
    });
    // Layers min
    document.getElementById('lmin')?.addEventListener('click', () => {
      const b = document.getElementById('lbody');
      const btn = document.getElementById('lmin');
      const open = b.style.display !== 'none';
      b.style.display = open ? 'none' : '';
      btn.textContent = open ? '+' : '−';
    });
    // Params min
    document.getElementById('prmin')?.addEventListener('click', () => {
      const b = document.getElementById('prbody');
      const btn = document.getElementById('prmin');
      const open = b.style.display !== 'none';
      b.style.display = open ? 'none' : '';
      btn.textContent = open ? '+' : '−';
    });
    // Subloc toggle
    document.getElementById('slt')?.addEventListener('click', () => {
      document.getElementById('slr').classList.toggle('h');
    });
    // CCTV add
    document.getElementById('cadd')?.addEventListener('click', () => {
      const url = document.getElementById('cu').value.trim();
      const lat = parseFloat(document.getElementById('clat').value);
      const lon = parseFloat(document.getElementById('clon').value);
      if (!url||isNaN(lat)||isNaN(lon)) { this.toast('Enter valid URL, LAT and LON'); return; }
      this._emit('cctvAdd', { url, lat, lon });
      document.getElementById('cu').value='';
      document.getElementById('clat').value='';
      document.getElementById('clon').value='';
      this.toast('CCTV stream added');
    });
  }

  _bindActions() {
    document.getElementById('bdet')?.addEventListener('click', () => {
      this.toast('DETECT: Scanning objects…');
      this._emit('detect',{});
    });
    document.getElementById('bcln')?.addEventListener('click', () => {
      this.cleanMode = !this.cleanMode;
      document.body.classList.toggle('ui-clean', this.cleanMode);
      this.toast(this.cleanMode ? 'CLEAN UI ON' : 'CLEAN UI OFF');
    });
    document.getElementById('tlb')?.addEventListener('click', () => {
      navigator.clipboard?.writeText(window.location.href).catch(()=>{});
      this.toast('Link copied');
    });
    document.getElementById('movb')?.addEventListener('click', () => this._emit('move',{}));
  }

  _clock() {
    const tick = () => {
      const now = new Date();
      const ts = now.toISOString().replace('T',' ').slice(0,19)+'Z';
      const el = document.getElementById('rt');
      if (el) el.textContent = ts;
      const lht = document.getElementById('lht');
      if (lht) lht.textContent = now.toISOString().slice(11,19)+'Z';
    };
    tick(); setInterval(tick, 1000);
  }

  _panopticLoop() {
    setInterval(() => {
      document.getElementById('vis-val').textContent = 50+Math.floor(Math.random()*200);
      document.getElementById('src-val').textContent = 100+Math.floor(Math.random()*150);
      document.getElementById('dens-val').textContent = (Math.random()*2).toFixed(2);
      document.getElementById('ms-val').textContent = (Math.random()*2+.1).toFixed(1);
    }, 2000);
  }

  _telemetryLoop() {
    setInterval(() => {
      const z = 3+Math.random()*10;
      const gsd = (100/Math.pow(2,z)).toFixed(2);
      const niirs = Math.max(0,Math.min(9.9,z-.8+Math.random())).toFixed(1);
      const alt = Math.round(6371000/Math.pow(2,z));
      const sun = (-50+Math.random()*60).toFixed(1);
      const el = id => document.getElementById(id);
      el('tgsd').textContent = `${gsd}M`;
      el('tni').textContent = niirs;
      el('talt').textContent = alt>1000?`${(alt/1e3).toFixed(0)}KM`:`${alt}M`;
      el('tsun').textContent = `${sun}° EL`;
      el('vtag').textContent = `VEH-${1000+Math.floor(Math.random()*5000)}`;
    }, 3500);
  }

  updateTelemetry(lat, lon, zoom) {
    const mpp = 156543.03 * Math.cos(lat*Math.PI/180) / Math.pow(2, zoom);
    const gsd = (mpp*0.1).toFixed(2);
    const niirs = Math.max(0,Math.min(9.9,zoom*.8-1)).toFixed(1);
    const alt = Math.round(mpp*1000);
    const el = id => document.getElementById(id);
    el('tgsd').textContent = `${gsd}M`;
    el('tni').textContent = niirs;
    el('talt').textContent = alt>10000?`${(alt/1e3).toFixed(0)}KM`:`${alt}M`;
    // Coords
    const latS = `${Math.abs(lat).toFixed(4)}°${lat>=0?'N':'S'}`;
    const lonS = `${Math.abs(lon).toFixed(4)}°${lon>=0?'E':'W'}`;
    el('dd').textContent = `${latS} ${lonS}`;
    const zone = Math.floor((lon+180)/6)+1;
    const band = 'CDEFGHJKLMNPQRSTUVWX'[Math.floor((lat+80)/8)]||'U';
    el('mgrs').textContent = `MGRS: ${zone}${band} ${(Math.abs(lon*1e3)%1e4).toFixed(0).padStart(4,'0')} ${(Math.abs(lat*1e3)%1e4).toFixed(0).padStart(4,'0')}`;
  }

  toast(msg) {
    const c = document.getElementById('tc');
    const t = document.createElement('div');
    t.className = 'tst'; t.textContent = msg;
    c.appendChild(t);
    setTimeout(() => { t.style.opacity='0'; t.style.transition='opacity .3s'; setTimeout(()=>t.remove(),300); }, 2200);
  }
}

// ─── MAIN APP ────────────────────────────────────────────────
(function boot() {
  if (typeof L === 'undefined') { setTimeout(boot, 100); return; }

  const globe = new GlobeController('map');
  const layers = new LayerManager(globe);
  const ui = new UIController();

  // Wire layer events
  layers.on('loading', ({ layer }) => ui.updateLayer(layer, null, 'loading…'));
  layers.on('updated', ({ layer, count }) => {
    ui.updateLayer(layer, count, layers.timeAgo(layers.state[layer].lastUpdate));
  });

  // Wire UI events
  ui.on('preset', p => globe.applyPreset(p));
  ui.on('city', ({ lat, lon, zoom }) => globe.flyTo(lat, lon, zoom));
  ui.on('subloc', ({ lat, lon, zoom }) => globe.flyTo(lat, lon, zoom));
  ui.on('toggle', ({ layer, active }) => layers.toggle(layer, active));
  ui.on('live', v => layers.setLive(v));
  ui.on('cctvAdd', ({ url, lat, lon }) => { layers.addCCTV(url, lat, lon); globe.flyTo(lat, lon, 17); });

  ui.on('bloom', v => {
    document.getElementById('gv').style.filter = `brightness(${.5+v/200})`;
  });
  ui.on('sharpen', v => {
    document.getElementById('map').style.filter = v>100 ? `contrast(${1+(v-100)/100})` : '';
  });
  ui.on('instab', v => {
    document.getElementById('gv').style.animation = v>20 ? `glitch ${(100-v)*.05+.1}s infinite` : '';
  });
  ui.on('detect', () => {
    const gv = document.getElementById('gv');
    gv.style.boxShadow = '0 0 0 3px rgba(255,176,32,.8),0 0 70px rgba(255,176,32,.5)';
    ui.toast('🎯 Object recognition active');
    setTimeout(() => { gv.style.boxShadow=''; }, 2200);
  });

  // Map move → update telemetry
  globe.setOnMove((lat, lon, zoom) => ui.updateTelemetry(lat, lon, zoom));

  // CCTV click events
  window.addEventListener('cctv-click', e => {
    const { lat, lon } = e.detail;
    globe.flyTo(lat, lon, 18);
    ui.toast(`CCTV: ${lat.toFixed(4)}, ${lon.toFixed(4)}`);
  });

  // Init UI & defaults
  ui.init();

  // Start on Austin
  setTimeout(() => {
    const austin = document.querySelector('[data-city="Austin"]');
    if (austin) austin.click();
    globe.flyTo(30.2672, -97.7431, 12);
  }, 600);

  // FX canvas loop (CRT grain etc.)
  const fxCanvas = document.getElementById('fx-canvas');
  const fxCtx = fxCanvas.getContext('2d');
  let frame = 0;
  (function fxLoop() {
    frame++;
    if (frame % 12 === 0) {
      fxCanvas.width = window.innerWidth;
      fxCanvas.height = window.innerHeight;
      fxCtx.clearRect(0, 0, fxCanvas.width, fxCanvas.height);
      if (ui.preset === 'crt') {
        fxCtx.strokeStyle = 'rgba(0,217,255,0.04)';
        fxCtx.lineWidth = 1;
        for (let y=0; y<fxCanvas.height; y+=4) {
          fxCtx.beginPath();
          fxCtx.moveTo(0, y);
          fxCtx.lineTo(fxCanvas.width, y + Math.sin(y*.08+frame*.02)*1.5);
          fxCtx.stroke();
        }
        fxCanvas.style.opacity = '1';
      } else {
        fxCanvas.style.opacity = '0';
      }
    }
    requestAnimationFrame(fxLoop);
  })();

  // Resize handler
  window.addEventListener('resize', () => {
    const oc = document.getElementById('oc');
    const gv = document.getElementById('gv');
    if (oc && gv) { oc.width = gv.clientWidth; oc.height = gv.clientHeight; }
  });

  console.log('%cWORLDVIEW INITIALIZED','color:#00D9FF;font-family:monospace;font-size:14px;font-weight:bold;text-shadow:0 0 10px #00D9FF');
})();
