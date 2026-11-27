/**
 * flyover-3d.js — AARONFIT FLYOVER 3D
 * Lazy-loaded MapLibre GL JS 3D Terrain + Cinematic Chase Camera + 2D Fallback.
 * Zero impact on initial AaronFit page load; releases all WebGL resources on exit.
 */
(function (global) {
  "use strict";

  const MAPLIBRE_VERSION = "4.7.1";
  const MAPLIBRE_JS_URL = `https://unpkg.com/maplibre-gl@${MAPLIBRE_VERSION}/dist/maplibre-gl.js`;
  const MAPLIBRE_CSS_URL = `https://unpkg.com/maplibre-gl@${MAPLIBRE_VERSION}/dist/maplibre-gl.css`;

  let _maplibreLoadPromise = null;
  let _map = null;
  let _fallbackMap = null;
  let _fallbackMarker = null;
  let _fallbackDoneLine = null;
  let _controller = null;
  let _track = null;
  let _activity = null;
  let _rafId = null;
  let _lastFrameTs = 0;
  let _smoothedBearing = null;
  let _smoothedZoom = null;
  let _baseLayerStyle = "satellite"; // 'satellite' | 'voyager'
  let _reducedMotion = false;

  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    _reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function hasWebGLSupport() {
    try {
      const canvas = document.createElement("canvas");
      return !!(
        window.WebGLRenderingContext &&
        (canvas.getContext("webgl") || canvas.getContext("experimental-webgl") || canvas.getContext("webgl2"))
      );
    } catch (e) {
      return false;
    }
  }

  function ensureMapLibreLoaded() {
    if (global.maplibregl) return Promise.resolve(global.maplibregl);
    if (_maplibreLoadPromise) return _maplibreLoadPromise;

    _maplibreLoadPromise = new Promise((resolve, reject) => {
      if (!document.getElementById("maplibre-gl-css")) {
        const link = document.createElement("link");
        link.id = "maplibre-gl-css";
        link.rel = "stylesheet";
        link.href = MAPLIBRE_CSS_URL;
        document.head.appendChild(link);
      }
      const script = document.createElement("script");
      script.id = "maplibre-gl-js";
      script.src = MAPLIBRE_JS_URL;
      script.async = true;
      script.onload = () => {
        if (global.maplibregl) resolve(global.maplibregl);
        else reject(new Error("MapLibre GL JS no se inicializó correctamente."));
      };
      script.onerror = () => reject(new Error("No se pudo cargar MapLibre GL JS."));
      document.head.appendChild(script);
    });
    return _maplibreLoadPromise;
  }

  function _fmtDuration(sec) {
    if (sec == null || isNaN(sec)) return "—";
    const s = Math.max(0, Math.round(Number(sec)));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const rem = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(rem).padStart(2, "0")}`;
    return `${m}:${String(rem).padStart(2, "0")}`;
  }

  function _fmtPace(secPerKm) {
    if (secPerKm == null || isNaN(secPerKm) || secPerKm <= 0 || secPerKm > 1800) return "—";
    const s = Math.round(Number(secPerKm));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} /km`;
  }

  function _buildMapStyle(layerMode) {
    const isSat = layerMode === "satellite";
    return {
      version: 8,
      sources: {
        "satellite-tiles": {
          type: "raster",
          tiles: [
            "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
          ],
          tileSize: 256,
          maxzoom: 18,
          attribution: "Tiles &copy; Esri &mdash; Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community"
        },
        "voyager-tiles": {
          type: "raster",
          tiles: [
            "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}"
          ],
          tileSize: 256,
          maxzoom: 18,
          attribution: "Tiles &copy; Esri &mdash; Sources: Esri, HERE, Garmin, Intermap, increment P Corp., GEBCO, USGS, FAO, NPS, NRCAN, GeoBase, IGN, Kadaster NL, Ordnance Survey, Esri Japan, METI, Esri China (Hong Kong), &copy; OpenStreetMap contributors, and the GIS User Community"
        },
        "terrain-dem": {
          type: "raster-dem",
          tiles: [
            "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
          ],
          encoding: "terrarium",
          tileSize: 256,
          maxzoom: 15,
          attribution: "Terrain &copy; Mapzen / Tilezen (AWS Open Data): ArcticDEM (NSF/NGA), EUDEM (Copernicus/EU), 3DEP, GMTED2010 &amp; SRTM (USGS)"
        }
      },
      layers: [
        {
          id: "base-satellite",
          type: "raster",
          source: "satellite-tiles",
          layout: { visibility: isSat ? "visible" : "none" }
        },
        {
          id: "base-voyager",
          type: "raster",
          source: "voyager-tiles",
          layout: { visibility: isSat ? "none" : "visible" }
        }
      ],
      terrain: {
        source: "terrain-dem",
        exaggeration: 1.35
      }
    };
  }

  function _getRouteGeoJson(pts, splitIdx) {
    const allCoords = pts.map(p => [p.lon, p.lat]);
    const doneCoords = pts.slice(0, Math.max(2, splitIdx + 1)).map(p => [p.lon, p.lat]);
    return {
      full: {
        type: "Feature",
        geometry: { type: "LineString", coordinates: allCoords }
      },
      done: {
        type: "Feature",
        geometry: { type: "LineString", coordinates: doneCoords }
      }
    };
  }

  function _renderElevationProfileSvg(track) {
    const wrap = document.getElementById("flyover-elev-svg-wrap");
    if (!wrap) return;
    if (!track.hasElevation) {
      wrap.innerHTML = `<div class="flyover-elev-empty">Perfil de elevación no disponible en este archivo (solo trazado GPS).</div>`;
      return;
    }

    const pts = track.points;
    const valid = pts.map((p, i) => ({ i, e: p.elev_m })).filter(x => x.e != null);
    if (valid.length < 2) {
      wrap.innerHTML = `<div class="flyover-elev-empty">Sin datos suficientes de altitud Garmin.</div>`;
      return;
    }

    const minE = Math.min(...valid.map(v => v.e));
    const maxE = Math.max(...valid.map(v => v.e));
    const spanE = Math.max(10, maxE - minE);
    const W = 640, H = 68, padT = 8, padB = 6;
    const plotH = H - padT - padB;

    const coords = valid.map(v => {
      const x = (v.i / Math.max(1, pts.length - 1)) * W;
      const y = padT + plotH - ((v.e - minE) / spanE) * plotH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });

    const lineD = "M " + coords.join(" L ");
    const areaD = `${lineD} L ${W},${H} L 0,${H} Z`;

    wrap.innerHTML = `
      <svg id="flyover-elev-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%; height:100%; display:block; cursor:pointer;">
        <defs>
          <linearGradient id="flyoverElevGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#EE5A2B" stop-opacity="0.45"/>
            <stop offset="100%" stop-color="#EE5A2B" stop-opacity="0.03"/>
          </linearGradient>
        </defs>
        <path d="${areaD}" fill="url(#flyoverElevGrad)"/>
        <path d="${lineD}" fill="none" stroke="#EE5A2B" stroke-width="2" stroke-linejoin="round"/>
        <line id="flyover-elev-cursor" x1="0" y1="0" x2="0" y2="${H}" stroke="#FFFFFF" stroke-width="1.8" stroke-dasharray="2,2"/>
        <circle id="flyover-elev-dot" cx="0" cy="${H / 2}" r="4.5" fill="#EE5A2B" stroke="#FFFFFF" stroke-width="2"/>
      </svg>
    `;

    const svg = document.getElementById("flyover-elev-svg");
    if (svg) {
      const seekFromPointer = (ev) => {
        const rect = svg.getBoundingClientRect();
        const clientX = ev.touches && ev.touches[0] ? ev.touches[0].clientX : ev.clientX;
        const frac = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
        if (_controller) {
          const sample = _controller.seek(frac);
          _updateVisualState(sample);
        }
      };
      let dragging = false;
      svg.addEventListener("pointerdown", (e) => { dragging = true; seekFromPointer(e); });
      svg.addEventListener("pointermove", (e) => { if (dragging) seekFromPointer(e); });
      window.addEventListener("pointerup", () => { dragging = false; }, { passive: true });
    }
  }

  function _updateElevationCursor(sample) {
    const cursor = document.getElementById("flyover-elev-cursor");
    const dot = document.getElementById("flyover-elev-dot");
    if (!cursor || !dot || !_track || !_track.hasElevation || !sample) return;

    const W = 640, H = 68, padT = 8, padB = 6;
    const plotH = H - padT - padB;
    const x = sample.progress * W;
    cursor.setAttribute("x1", x.toFixed(1));
    cursor.setAttribute("x2", x.toFixed(1));

    const valid = _track.points.map(p => p.elev_m).filter(e => e != null);
    if (valid.length && sample.elev_m != null) {
      const minE = Math.min(...valid);
      const maxE = Math.max(...valid);
      const spanE = Math.max(10, maxE - minE);
      const y = padT + plotH - ((sample.elev_m - minE) / spanE) * plotH;
      dot.setAttribute("cx", x.toFixed(1));
      dot.setAttribute("cy", y.toFixed(1));
    }
  }

  function _updateMetricsHud(sample) {
    if (!sample || !_track) return;

    const elScrubber = document.getElementById("flyover-scrubber");
    if (elScrubber) elScrubber.value = Math.round(sample.progress * 1000);

    const elDist = document.getElementById("flyover-stat-dist");
    const elTime = document.getElementById("flyover-stat-time");
    const elTimeTotal = document.getElementById("flyover-time-total");
    const elTimeCur = document.getElementById("flyover-time-cur");
    const elPace = document.getElementById("flyover-stat-pace");
    const elAvgPace = document.getElementById("flyover-stat-avg-pace");
    const elSpeed = document.getElementById("flyover-stat-speed");
    const elElev = document.getElementById("flyover-stat-elev");
    const elElevLabel = document.getElementById("flyover-stat-elev-label");
    const elGain = document.getElementById("flyover-stat-gain");
    const elGainLabel = document.getElementById("flyover-stat-gain-label");
    const officialGain = (_activity && _activity.elevation_gain != null) ? Math.round(Number(_activity.elevation_gain)) : null;
    if (elGain) {
      if (_track.hasElevation && sample.elev_gain_m != null) {
        if (elGainLabel) elGainLabel.textContent = "DESNIVEL + (STREAM)";
        elGain.textContent = `+${Math.round(sample.elev_gain_m)} m`;
        elGain.title = officialGain != null ? `Total oficial Garmin: +${officialGain} m` : "";
      } else if (officialGain != null) {
        if (elGainLabel) elGainLabel.textContent = "DESNIVEL + (GARMIN)";
        elGain.textContent = `+${officialGain} m`;
        elGain.title = "Desnivel positivo total oficial Garmin";
      } else {
        if (elGainLabel) elGainLabel.textContent = "DESNIVEL +";
        elGain.textContent = "—";
      }
    }

    if (elDist) elDist.textContent = `${sample.dist_km.toFixed(2)} km`;

    if (_track.hasTimestamps && sample.time_sec != null) {
      const tStr = _fmtDuration(sample.time_sec);
      if (elTime) elTime.textContent = tStr;
      if (elTimeCur) elTimeCur.textContent = tStr;
      if (elTimeTotal) elTimeTotal.textContent = _fmtDuration(_track.totalTimeSec);
    } else {
      if (elTime) elTime.textContent = "—";
      if (elTimeCur) elTimeCur.textContent = `${Math.round(sample.progress * 100)}%`;
      if (elTimeTotal) elTimeTotal.textContent = `${_track.totalDistanceKm.toFixed(2)} km`;
    }

    if (elPace) elPace.textContent = _track.hasStreams ? _fmtPace(sample.pace_sec) : "—";
    if (elAvgPace) elAvgPace.textContent = (_activity && _activity.avg_pace_str) ? _activity.avg_pace_str : "—";

    if (elSpeed) {
      elSpeed.textContent = (_track.hasStreams && sample.speed_mps != null)
        ? `${(sample.speed_mps * 3.6).toFixed(1)} km/h`
        : "—";
    }

    // Altitude: prefer Garmin stream, fallback to DEM terrain query clearly labeled
    if (_track.hasElevation && sample.elev_m != null) {
      if (elElev) elElev.textContent = `${Math.round(sample.elev_m)} m`;
      if (elElevLabel) elElevLabel.textContent = "ALTITUD (GARMIN)";
    } else if (_map && typeof _map.queryTerrainElevation === "function") {
      const demElev = _map.queryTerrainElevation([sample.lon, sample.lat]);
      if (demElev != null && !isNaN(demElev)) {
        if (elElev) elElev.textContent = `${Math.round(demElev)} m`;
        if (elElevLabel) elElevLabel.textContent = "TERRENO (DEM)";
      } else {
        if (elElev) elElev.textContent = "—";
      }
    } else {
      if (elElev) elElev.textContent = "—";
    }

    // Optional HR & Cadence: hide box completely if activity has no data
    const boxHr = document.getElementById("flyover-box-hr");
    const elHr = document.getElementById("flyover-stat-hr");
    if (boxHr && elHr) {
      if (_track.hasHr && sample.hr != null) {
        boxHr.style.display = "flex";
        elHr.textContent = `${Math.round(sample.hr)} ppm`;
      } else if (!_track.hasHr) {
        boxHr.style.display = "none";
      }
    }

    const boxCad = document.getElementById("flyover-box-cad");
    const elCad = document.getElementById("flyover-stat-cad");
    if (boxCad && elCad) {
      if (_track.hasCadence) {
        boxCad.style.display = "flex";
        const isBike = _activity && _activity.sport_type === "Ciclismo";
        elCad.textContent = sample.cadence != null ? `${Math.round(sample.cadence)} ${isBike ? "rpm" : "ppm"}` : "—";
      } else {
        boxCad.style.display = "none";
      }
    }
  }

  function _updateVisualState(sample) {
    if (!sample || !_track) return;
    _updateMetricsHud(sample);
    _updateElevationCursor(sample);

    // Update MapLibre sources & camera
    if (_map) {
      const markerSrc = _map.getSource("runner-marker");
      if (markerSrc) {
        markerSrc.setData({
          type: "Feature",
          geometry: { type: "Point", coordinates: [sample.lon, sample.lat] }
        });
      }
      const doneSrc = _map.getSource("route-done");
      if (doneSrc) {
        const doneCoords = _track.points
          .slice(0, Math.max(1, sample.index + 1))
          .map(p => [p.lon, p.lat]);
        doneCoords.push([sample.lon, sample.lat]);
        doneSrc.setData({
          type: "Feature",
          geometry: { type: "LineString", coordinates: doneCoords }
        });
      }

      if (_controller && _controller.cameraMode === "chase") {
        const Engine = global.AaronFlyoverEngine;
        const targetBearing = _reducedMotion ? 0 : sample.bearing;
        _smoothedBearing = Engine.smoothBearingAngle(
          _smoothedBearing,
          targetBearing,
          _reducedMotion ? 0.04 : 0.08
        );

        // Adapt zoom subtly to speed (wider on fast cycling, closer on trails)
        const spdKmh = sample.speed_mps != null ? sample.speed_mps * 3.6 : 11.0;
        const targetZoom = Math.max(13.8, Math.min(15.8, 15.7 - (spdKmh / 45.0) * 1.4));
        _smoothedZoom = _smoothedZoom == null ? targetZoom : (_smoothedZoom + (targetZoom - _smoothedZoom) * 0.05);

        _map.jumpTo({
          center: [sample.lon, sample.lat],
          bearing: _smoothedBearing,
          pitch: _reducedMotion ? 26 : 52,
          zoom: _smoothedZoom
        });
      }
    }

    // Update 2D fallback if active
    if (_fallbackMap && _fallbackMarker) {
      _fallbackMarker.setLatLng([sample.lat, sample.lon]);
      if (_fallbackDoneLine) {
        const latlngs = _track.points.slice(0, sample.index + 1).map(p => [p.lat, p.lon]);
        latlngs.push([sample.lat, sample.lon]);
        _fallbackDoneLine.setLatLngs(latlngs);
      }
      if (_controller && _controller.cameraMode === "chase") {
        _fallbackMap.panTo([sample.lat, sample.lon], { animate: false });
      }
    }

    _syncPlayButtonUI();
  }

  function _syncPlayButtonUI() {
    const btnPlay = document.getElementById("flyover-btn-play");
    if (!btnPlay || !_controller) return;
    if (_controller.isPlaying) {
      btnPlay.setAttribute("aria-label", "Pausar");
      btnPlay.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg><span>Pausar</span>`;
    } else {
      btnPlay.setAttribute("aria-label", "Reproducir");
      btnPlay.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg><span>Reproducir</span>`;
    }

    document.querySelectorAll(".flyover-cam-btn").forEach(b => {
      b.classList.toggle("active", _controller && b.dataset.cam === _controller.cameraMode);
    });
  }

  function _animationLoop(ts) {
    if (!_controller || !_controller.isPlaying) {
      _rafId = null;
      _syncPlayButtonUI();
      return;
    }
    const delta = _lastFrameTs ? Math.min(100, ts - _lastFrameTs) : 16;
    _lastFrameTs = ts;
    const sample = _controller.step(delta);
    _updateVisualState(sample);
    if (_controller.isPlaying) {
      _rafId = requestAnimationFrame(_animationLoop);
    } else {
      _rafId = null;
      _syncPlayButtonUI();
    }
  }

  function _initMapLibreScene() {
    const maplibregl = global.maplibregl;
    const container = document.getElementById("flyover-map-canvas");
    if (!container || !maplibregl || !_track) return;

    _map = new maplibregl.Map({
      container,
      style: _buildMapStyle(_baseLayerStyle),
      bounds: _track.bounds,
      fitBoundsOptions: { padding: 60, pitch: _reducedMotion ? 15 : 38, maxZoom: 15.5 },
      maxPitch: 68,
      antialias: true
    });

    _map.on("load", () => {
      if (!_map || !_track) return;
      const geo = _getRouteGeoJson(_track.points, 0);

      _map.addSource("route-full", { type: "geojson", data: geo.full });
      _map.addSource("route-done", { type: "geojson", data: geo.done });
      _map.addSource("runner-marker", {
        type: "geojson",
        data: {
          type: "Feature",
          geometry: { type: "Point", coordinates: [_track.points[0].lon, _track.points[0].lat] }
        }
      });

      _map.addLayer({
        id: "route-casing",
        type: "line",
        source: "route-full",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "rgba(17,17,17,0.7)", "line-width": 7 }
      });

      _map.addLayer({
        id: "route-remaining",
        type: "line",
        source: "route-full",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "rgba(255,255,255,0.42)", "line-width": 4 }
      });

      _map.addLayer({
        id: "route-completed",
        type: "line",
        source: "route-done",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#EE5A2B", "line-width": 5 }
      });

      _map.addLayer({
        id: "runner-halo",
        type: "circle",
        source: "runner-marker",
        paint: {
          "circle-radius": 13,
          "circle-color": "rgba(238, 90, 43, 0.35)",
          "circle-pitch-alignment": "map"
        }
      });

      _map.addLayer({
        id: "runner-dot",
        type: "circle",
        source: "runner-marker",
        paint: {
          "circle-radius": 6.5,
          "circle-color": "#EE5A2B",
          "circle-stroke-width": 2.5,
          "circle-stroke-color": "#FFFFFF",
          "circle-pitch-alignment": "map"
        }
      });

      _updateVisualState(_controller.getCurrentSample());
    });

    // Switch to free camera automatically when user manually interacts
    const switchToFree = () => {
      if (_controller && _controller.cameraMode === "chase") {
        _controller.setCameraMode("free");
        _syncPlayButtonUI();
      }
    };
    _map.on("dragstart", switchToFree);
    _map.on("wheel", switchToFree);
    _map.on("touchstart", switchToFree);

    let _satErrors = 0;
    let _demErrors = 0;
    _map.on("error", (ev) => {
      const sid = ev && ev.sourceId;
      if (sid === "terrain-dem") {
        _demErrors++;
        if (_demErrors >= 4 && _map) {
          try { _map.setTerrain(null); } catch (e) {}
          const notice = document.getElementById("flyover-mode-notice");
          if (notice) {
            notice.textContent = "Terreno DEM no disponible temporalmente: mostrando ruta sobre mapa plano.";
            notice.style.display = "block";
          }
        }
      } else if (sid === "satellite-tiles" && _baseLayerStyle === "satellite") {
        _satErrors++;
        if (_satErrors >= 4) {
          toggleFlyoverLayer();
          const notice = document.getElementById("flyover-mode-notice");
          if (notice) {
            notice.textContent = "Imágenes satélite no disponibles: cambiado automáticamente a Mapa.";
            notice.style.display = "block";
          }
        }
      }
    });
  }

  function _init2DFallback() {
    const container = document.getElementById("flyover-map-canvas");
    if (!container || !global.L || !_track) return;

    const notice = document.getElementById("flyover-mode-notice");
    if (notice) {
      notice.textContent = "WebGL no disponible en este dispositivo: modo Flyover 2D activo.";
      notice.style.display = "block";
    }

    _fallbackMap = global.L.map(container, { zoomControl: false });
    global.L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
      attribution: "&copy; OpenStreetMap &copy; CARTO",
      maxZoom: 19
    }).addTo(_fallbackMap);

    const latlngs = _track.points.map(p => [p.lat, p.lon]);
    const fullLine = global.L.polyline(latlngs, { color: "rgba(17,17,17,0.35)", weight: 4 }).addTo(_fallbackMap);
    _fallbackDoneLine = global.L.polyline([latlngs[0]], { color: "#EE5A2B", weight: 5 }).addTo(_fallbackMap);
    _fallbackMarker = global.L.circleMarker(latlngs[0], {
      radius: 7,
      color: "#FFFFFF",
      weight: 2.5,
      fillColor: "#EE5A2B",
      fillOpacity: 1
    }).addTo(_fallbackMap);
    _fallbackMap.fitBounds(fullLine.getBounds(), { padding: [40, 40] });
    _updateVisualState(_controller.getCurrentSample());
  }

  async function openFlyover3D(activity) {
    const modal = document.getElementById("flyover-3d-modal");
    if (!modal || !activity) return;

    const Engine = global.AaronFlyoverEngine;
    if (!Engine) return;

    _activity = activity;
    _track = Engine.buildFlyoverTrack(activity);
    if (_track.mode === "none") {
      if (typeof global.showSuccessBanner === "function") {
        global.showSuccessBanner("⚠️ Esta actividad no dispone de coordenadas GPS para Flyover 3D.");
      }
      return;
    }

    // Cleanup any leftover instance
    _destroyMapInstances();

    _controller = new Engine.FlyoverPlayerController(_track, 45000);
    _controller.setCameraMode("overview"); // Start in overview until user hits Play
    _smoothedBearing = null;
    _smoothedZoom = null;

    // Header & badges
    const titleEl = document.getElementById("flyover-title");
    const badgeEl = document.getElementById("flyover-data-badge");
    const noticeEl = document.getElementById("flyover-mode-notice");
    if (titleEl) titleEl.textContent = activity.name || "Actividad GPS";
    if (badgeEl) {
      if (_track.mode === "full") badgeEl.textContent = "GPS + STREAMS GARMIN";
      else if (_track.mode === "partial") badgeEl.textContent = "GPS + STREAMS PARCIALES";
      else badgeEl.textContent = "SOLO TRAZADO GEOMÉTRICO";
    }
    if (noticeEl) {
      if (_track.mode === "geometry_only") {
        noticeEl.textContent = "Solo trazado geométrico disponible (sin timestamps ni streams por punto).";
        noticeEl.style.display = "block";
      } else {
        noticeEl.style.display = "none";
      }
    }

    // Reset speed pills
    document.querySelectorAll(".flyover-speed-btn").forEach(b => {
      b.classList.toggle("active", Number(b.dataset.speed) === 1);
    });

    modal.style.display = "flex";
    document.body.style.overflow = "hidden";

    _renderElevationProfileSvg(_track);
    _updateVisualState(_controller.getCurrentSample());

    if (hasWebGLSupport()) {
      try {
        await ensureMapLibreLoaded();
        _initMapLibreScene();
      } catch (err) {
        console.warn("[Flyover 3D] MapLibre fallback to 2D:", err);
        _init2DFallback();
      }
    } else {
      _init2DFallback();
    }
  }

  function _destroyMapInstances() {
    if (_rafId) {
      cancelAnimationFrame(_rafId);
      _rafId = null;
    }
    if (_map) {
      try { _map.remove(); } catch (e) {}
      _map = null;
    }
    if (_fallbackMap) {
      try { _fallbackMap.remove(); } catch (e) {}
      _fallbackMap = null;
    }
    _fallbackMarker = null;
    _fallbackDoneLine = null;
  }

  function closeFlyover3D() {
    if (_controller) _controller.pause();
    _destroyMapInstances();
    _controller = null;
    _track = null;
    _activity = null;
    const modal = document.getElementById("flyover-3d-modal");
    if (modal) modal.style.display = "none";
    document.body.style.overflow = "";
  }

  function togglePlayFlyover() {
    if (!_controller) return;
    if (_controller.isPlaying) {
      _controller.pause();
      _syncPlayButtonUI();
    } else {
      if (_controller.cameraMode === "overview") {
        _controller.setCameraMode("chase");
      }
      _controller.play();
      _lastFrameTs = 0;
      _rafId = requestAnimationFrame(_animationLoop);
      _syncPlayButtonUI();
    }
  }

  function restartFlyover() {
    if (!_controller) return;
    _smoothedBearing = null;
    _controller.setCameraMode("chase");
    _controller.restart();
    _lastFrameTs = 0;
    if (_rafId) cancelAnimationFrame(_rafId);
    _rafId = requestAnimationFrame(_animationLoop);
    _syncPlayButtonUI();
  }

  function setFlyoverSpeed(mult) {
    if (!_controller) return;
    _controller.setSpeed(mult);
    document.querySelectorAll(".flyover-speed-btn").forEach(b => {
      b.classList.toggle("active", Number(b.dataset.speed) === Number(mult));
    });
  }

  function setFlyoverCameraMode(mode) {
    if (!_controller) return;
    _controller.setCameraMode(mode);
    if (mode === "overview" && _track) {
      if (_map) {
        _map.fitBounds(_track.bounds, { padding: 60, pitch: _reducedMotion ? 15 : 38, duration: 700 });
      } else if (_fallbackMap) {
        _fallbackMap.fitBounds(_track.points.map(p => [p.lat, p.lon]), { padding: [40, 40] });
      }
    } else if (mode === "chase") {
      _smoothedBearing = null;
      _updateVisualState(_controller.getCurrentSample());
    }
    _syncPlayButtonUI();
  }

  function zoomFlyover(delta) {
    if (_map) {
      _map.zoomTo(_map.getZoom() + delta, { duration: 220 });
    } else if (_fallbackMap) {
      _fallbackMap.setZoom(_fallbackMap.getZoom() + delta);
    }
  }

  function toggleFlyoverLayer() {
    _baseLayerStyle = _baseLayerStyle === "satellite" ? "voyager" : "satellite";
    const btn = document.getElementById("flyover-btn-layer");
    if (btn) btn.textContent = _baseLayerStyle === "satellite" ? "Mapa" : "Satélite 3D";
    if (_map) {
      const isSat = _baseLayerStyle === "satellite";
      if (_map.getLayer("base-satellite")) {
        _map.setLayoutProperty("base-satellite", "visibility", isSat ? "visible" : "none");
      }
      if (_map.getLayer("base-voyager")) {
        _map.setLayoutProperty("base-voyager", "visibility", isSat ? "none" : "visible");
      }
    }
  }

  function onFlyoverScrub(val0To1000) {
    if (!_controller) return;
    const sample = _controller.seek(Number(val0To1000) / 1000.0);
    _updateVisualState(sample);
  }

  global.AaronFlyover3D = {
    openFlyover3D,
    closeFlyover3D,
    togglePlayFlyover,
    restartFlyover,
    setFlyoverSpeed,
    setFlyoverCameraMode,
    zoomFlyover,
    toggleFlyoverLayer,
    onFlyoverScrub,
    hasWebGLSupport,
  };
})(typeof window !== "undefined" ? window : globalThis);
