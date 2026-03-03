/*
 * WorldView client – Free & Legal Edition
 *
 * This file implements a minimal geospatial dashboard using CesiumJS and
 * publicly available APIs.  It loads real‑time aircraft data from the
 * OpenSky Network, satellite orbital elements from CelesTrak, and
 * earthquake events from the USGS.  Users can toggle layers and switch
 * between visual styles (normal, CRT, night‑vision green and pseudo‑FLIR).
 *
 * To run this demo:
 * 1. Ensure the server is running (`node server.js` in the root folder).
 * 2. Open `index.html` in a browser or via the served `public` folder.
 *
 * Note: This demo omits advanced features such as flight path trails,
 * CCTV projection or real‑time traffic overlays, which require
 * additional data sources or commercial APIs.
 */

window.addEventListener('load', () => {
  // Ensure Cesium is loaded
  if (typeof Cesium === 'undefined') {
    console.error('CesiumJS failed to load');
    return;
  }
  // Set Cesium ion access token if you have one.  Without a token
  // CesiumJS still works but uses default terrain and imagery providers.
  // Cesium.Ion.defaultAccessToken = '<Your Cesium ion access token here>';

  const viewer = new Cesium.Viewer('viewer', {
    sceneModePicker: true,
    animation: false,
    timeline: false,
    baseLayerPicker: true,
    geocoder: true,
    homeButton: true,
    navigationHelpButton: false,
    fullscreenButton: true,
  });
  // Improve globe darkness for NVG/FLIR effects
  viewer.scene.globe.baseColor = Cesium.Color.BLACK;

  // DataSources for each layer
  const flightsLayer = new Cesium.CustomDataSource('flights');
  const satsLayer = new Cesium.CustomDataSource('satellites');
  const quakesLayer = new Cesium.CustomDataSource('earthquakes');
  viewer.dataSources.add(flightsLayer);
  viewer.dataSources.add(satsLayer);
  viewer.dataSources.add(quakesLayer);

  // Fetch and update flights
  async function updateFlights() {
    try {
      const res = await fetch('/api/flights');
      const json = await res.json();
      flightsLayer.entities.removeAll();
      const states = json.states || [];
      // Limit to 500 aircraft to maintain performance
      const limit = parseInt(window.localStorage.getItem('flightsLimit') || '500', 10);
      states.slice(0, limit).forEach((state) => {
        const [icao24, callsign, origin_country, time_position, last_contact, longitude, latitude, baro_altitude, on_ground, velocity, heading, vertical_rate, sensors, geo_altitude, squawk, spi, position_source, category] = state;
        if (latitude != null && longitude != null) {
          flightsLayer.entities.add({
            position: Cesium.Cartesian3.fromDegrees(longitude, latitude, (geo_altitude || 0) * 1000),
            point: {
              pixelSize: 4,
              color: Cesium.Color.YELLOW,
              outlineColor: Cesium.Color.BLACK,
              outlineWidth: 1,
            },
            label: {
              text: callsign || icao24,
              font: '10px sans-serif',
              fillColor: Cesium.Color.WHITE,
              pixelOffset: new Cesium.Cartesian2(0, -12),
              showBackground: false,
              distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0.0, 1.0e6),
            },
          });
        }
      });
    } catch (err) {
      console.error('Error fetching flights', err);
    }
  }

  // Fetch and update earthquakes
  async function updateQuakes() {
    try {
      const res = await fetch('/api/earthquakes');
      const json = await res.json();
      quakesLayer.entities.removeAll();
      const features = json.features || [];
      features.forEach((feature) => {
        const [lon, lat, depthKm] = feature.geometry.coordinates;
        const mag = feature.properties.mag || 1.0;
        quakesLayer.entities.add({
          position: Cesium.Cartesian3.fromDegrees(lon, lat, -depthKm * 1000),
          point: {
            pixelSize: Math.min(20, 4 + mag * 3),
            color: Cesium.Color.RED.withAlpha(0.7),
            outlineColor: Cesium.Color.YELLOW.withAlpha(0.8),
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
        });
      });
    } catch (err) {
      console.error('Error fetching earthquakes', err);
    }
  }

  // Fetch and update satellites; we compute positions using satellite.js
  async function updateSats() {
    try {
      const res = await fetch('/api/satellites');
      const sats = await res.json();
      satsLayer.entities.removeAll();
      const now = new Date();
      sats.forEach((sat) => {
        try {
          const rec = satellite.twoline2satrec(sat.line1, sat.line2);
          const posVel = satellite.propagate(rec, now);
          const gmst = satellite.gstime(now);
          const p = satellite.eciToGeodetic(posVel.position, gmst);
          const lon = satellite.degreesLong(p.longitude);
          const lat = satellite.degreesLat(p.latitude);
          const alt = p.height * 1000;
          satsLayer.entities.add({
            position: Cesium.Cartesian3.fromDegrees(lon, lat, alt),
            point: {
              pixelSize: 3,
              color: Cesium.Color.CYAN,
              outlineColor: Cesium.Color.BLACK,
              outlineWidth: 1,
            },
            label: {
              text: sat.satelliteName || sat.objectName || '',
              font: '9px sans-serif',
              fillColor: Cesium.Color.CYAN,
              pixelOffset: new Cesium.Cartesian2(0, -10),
              showBackground: false,
              distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0.0, 2.0e7),
            },
          });
        } catch (e) {
          // ignore satellites with invalid TLEs
        }
      });
    } catch (err) {
      console.error('Error fetching satellites', err);
    }
  }

  // Helper to refresh layers based on toggles
  async function refresh() {
    if (document.getElementById('flightsToggle').checked) {
      await updateFlights();
    } else {
      flightsLayer.entities.removeAll();
    }
    if (document.getElementById('quakesToggle').checked) {
      await updateQuakes();
    } else {
      quakesLayer.entities.removeAll();
    }
    if (document.getElementById('satsToggle').checked) {
      await updateSats();
    } else {
      satsLayer.entities.removeAll();
    }
  }
  // Attach to refresh button
  document.getElementById('refreshBtn').addEventListener('click', () => {
    refresh();
  });
  // Initial refresh and schedule periodic updates every minute
  refresh();
  setInterval(refresh, 60000);

  // Style (post‑processing) selection
  const styleBar = document.getElementById('styleBar');
  const styles = ['Normal', 'CRT', 'NVG', 'FLIR'];
  let currentStyle = 'Normal';
  let crtOverlay;
  function setActiveButton(name) {
    document.querySelectorAll('#styleBar button').forEach((btn) => {
      btn.classList.toggle('active', btn.textContent === name);
    });
  }
  function applyStyle(style) {
    // Remove any previously attached overlay
    if (crtOverlay) {
      crtOverlay.remove();
      crtOverlay = null;
    }
    // Remove post process stages
    viewer.scene.postProcessStages.removeAll();
    if (style === 'CRT') {
      // Create CSS overlay for scanlines
      crtOverlay = document.createElement('div');
      crtOverlay.style.position = 'absolute';
      crtOverlay.style.pointerEvents = 'none';
      crtOverlay.style.top = '0';
      crtOverlay.style.left = '0';
      crtOverlay.style.right = '0';
      crtOverlay.style.bottom = '0';
      crtOverlay.style.background = 'repeating-linear-gradient(to bottom, rgba(255,255,255,0.05), rgba(255,255,255,0.05) 2px, transparent 2px, transparent 4px)';
      crtOverlay.style.mixBlendMode = 'overlay';
      document.body.appendChild(crtOverlay);
    } else if (style === 'NVG') {
      // Night vision: convert to green channel
      const nvgStage = new Cesium.PostProcessStage({
        fragmentShader:
          'uniform sampler2D colorTexture;\n' +
          'varying vec2 v_textureCoordinates;\n' +
          'void main(void) {\n' +
          '    vec4 c = texture2D(colorTexture, v_textureCoordinates);\n' +
          '    float g = (c.r + c.g + c.b) / 3.0;\n' +
          '    gl_FragColor = vec4(0.0, g, 0.0, c.a);\n' +
          '}\n',
      });
      viewer.scene.postProcessStages.add(nvgStage);
    } else if (style === 'FLIR') {
      // Pseudo thermal: map greyscale to orange/yellow
      const flirStage = new Cesium.PostProcessStage({
        fragmentShader:
          'uniform sampler2D colorTexture;\n' +
          'varying vec2 v_textureCoordinates;\n' +
          'void main(void) {\n' +
          '    vec4 c = texture2D(colorTexture, v_textureCoordinates);\n' +
          '    float g = (c.r + c.g + c.b) / 3.0;\n' +
          '    float t = smoothstep(0.2, 1.0, g);\n' +
          '    gl_FragColor = vec4(t, t * 0.5, 0.0, c.a);\n' +
          '}\n',
      });
      viewer.scene.postProcessStages.add(flirStage);
    }
    currentStyle = style;
    setActiveButton(style);
  }
  // Create buttons in the style bar
  styles.forEach((name) => {
    const btn = document.createElement('button');
    btn.textContent = name;
    if (name === currentStyle) btn.classList.add('active');
    btn.addEventListener('click', () => {
      applyStyle(name);
    });
    styleBar.appendChild(btn);
  });
  // Apply initial style
  applyStyle('Normal');
});