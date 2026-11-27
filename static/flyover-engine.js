/**
 * flyover-engine.js — Pure geometric, temporal & telemetry synchronization engine
 * for AARONFIT FLYOVER 3D. Zero DOM/WebGL dependencies (testable in Node.js & Browser).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.AaronFlyoverEngine = factory();
  }
}(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const EARTH_RADIUS_M = 6371000.0;

  function toRad(deg) {
    return (deg * Math.PI) / 180.0;
  }

  function toDeg(rad) {
    return (rad * 180.0) / Math.PI;
  }

  /**
   * Geodesic distance in meters between two WGS84 coordinates.
   */
  function haversineMeters(lat1, lon1, lat2, lon2) {
    const p1 = toRad(lat1);
    const p2 = toRad(lat2);
    const dp = toRad(lat2 - lat1);
    const dl = toRad(lon2 - lon1);
    const a =
      Math.sin(dp / 2) * Math.sin(dp / 2) +
      Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    return 2.0 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0.0, 1.0 - a)));
  }

  /**
   * Initial forward azimuth (bearing) in degrees [0, 360).
   */
  function computeBearing(lat1, lon1, lat2, lon2) {
    const p1 = toRad(lat1);
    const p2 = toRad(lat2);
    const dl = toRad(lon2 - lon1);
    const y = Math.sin(dl) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    const brng = toDeg(Math.atan2(y, x));
    return (brng + 360.0) % 360.0;
  }

  /**
   * Shortest-arc circular interpolation between two angles in degrees.
   */
  function smoothBearingAngle(prevDeg, targetDeg, alpha) {
    if (prevDeg == null || isNaN(prevDeg)) return ((targetDeg % 360) + 360) % 360;
    const diff = ((((targetDeg - prevDeg) % 360) + 540) % 360) - 180;
    return (prevDeg + diff * Math.min(1, Math.max(0, alpha)) + 360) % 360;
  }

  /**
   * Decodes an encoded Google/Strava polyline string into [[lat, lon], ...].
   */
  function decodePolyline(encoded) {
    if (!encoded || typeof encoded !== "string") return [];
    const points = [];
    let index = 0;
    const len = encoded.length;
    let lat = 0;
    let lng = 0;

    while (index < len) {
      let b, shift = 0, result = 0;
      do {
        b = encoded.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20 && index < len);
      const dlat = (result & 1) ? ~(result >> 1) : (result >> 1);
      lat += dlat;

      shift = 0;
      result = 0;
      do {
        b = encoded.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20 && index < len);
      const dlng = (result & 1) ? ~(result >> 1) : (result >> 1);
      lng += dlng;

      points.push([lat / 1e5, lng / 1e5]);
    }
    return points;
  }

  /**
   * Removes invalid coordinates, consecutive duplicates (<0.5m), and sorts by timestamp if present.
   */
  function deduplicateAndOrderTrack(rawPoints) {
    if (!Array.isArray(rawPoints)) return [];
    const valid = [];
    for (let i = 0; i < rawPoints.length; i++) {
      const pt = rawPoints[i];
      let lat, lon, timeSec = null;
      if (Array.isArray(pt) && pt.length >= 2) {
        lat = Number(pt[0]);
        lon = Number(pt[1]);
        if (pt.length >= 3 && pt[2] != null && !isNaN(Number(pt[2]))) {
          timeSec = Number(pt[2]);
        }
      } else if (pt && typeof pt === "object") {
        lat = Number(pt.lat ?? pt.latitude);
        lon = Number(pt.lon ?? pt.lng ?? pt.longitude);
        if (pt.time_sec != null && !isNaN(Number(pt.time_sec))) {
          timeSec = Number(pt.time_sec);
        }
      } else {
        continue;
      }
      if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        continue;
      }
      valid.push({ lat, lon, time_sec: timeSec, _origIdx: i });
    }

    const hasAllTs = valid.length > 1 && valid.every(p => p.time_sec !== null);
    if (hasAllTs) {
      valid.sort((a, b) => a.time_sec - b.time_sec || a._origIdx - b._origIdx);
    }

    const deduped = [];
    for (let i = 0; i < valid.length; i++) {
      const cur = valid[i];
      if (deduped.length === 0) {
        deduped.push(cur);
        continue;
      }
      const prev = deduped[deduped.length - 1];
      const d = haversineMeters(prev.lat, prev.lon, cur.lat, cur.lon);
      if (d < 0.5) {
        continue;
      }
      if (hasAllTs && cur.time_sec <= prev.time_sec) {
        continue;
      }
      deduped.push(cur);
    }
    return deduped;
  }

  /**
   * Perpendicular distance from point p to segment a-b (in planar degree space, fast for simplification).
   */
  function _perpDistSq(p, a, b) {
    let x = a.lon;
    let y = a.lat;
    let dx = b.lon - x;
    let dy = b.lat - y;
    if (dx !== 0 || dy !== 0) {
      const t = ((p.lon - x) * dx + (p.lat - y) * dy) / (dx * dx + dy * dy);
      if (t > 1) {
        x = b.lon;
        y = b.lat;
      } else if (t > 0) {
        x += dx * t;
        y += dy * t;
      }
    }
    dx = p.lon - x;
    dy = p.lat - y;
    return dx * dx + dy * dy;
  }

  /**
   * Ramer-Douglas-Peucker simplification preserving route geometry and key turns.
   */
  function simplifyTrackDouglasPeucker(points, maxPoints = 1500, epsilonDeg = 0.000025) {
    if (!Array.isArray(points) || points.length <= maxPoints) return points || [];

    const sqTol = epsilonDeg * epsilonDeg;
    const len = points.length;
    const markers = new Uint8Array(len);
    markers[0] = 1;
    markers[len - 1] = 1;

    const stack = [[0, len - 1]];
    while (stack.length > 0) {
      const [first, last] = stack.pop();
      let maxSqDist = 0;
      let index = -1;
      for (let i = first + 1; i < last; i++) {
        const sqDist = _perpDistSq(points[i], points[first], points[last]);
        if (sqDist > maxSqDist) {
          index = i;
          maxSqDist = sqDist;
        }
      }
      if (maxSqDist > sqTol && index !== -1) {
        markers[index] = 1;
        stack.push([first, index], [index, last]);
      }
    }

    const simplified = [];
    for (let i = 0; i < len; i++) {
      if (markers[i]) simplified.push(points[i]);
    }

    // If still above maxPoints, uniformly thin while keeping endpoints
    if (simplified.length > maxPoints) {
      const out = [];
      for (let i = 0; i < maxPoints; i++) {
        const idx = Math.round((i * (simplified.length - 1)) / (maxPoints - 1));
        out.push(simplified[idx]);
      }
      return out;
    }
    return simplified;
  }

  /**
   * Moderate centered moving average for elevation smoothing, preserving null gaps.
   */
  function smoothElevationArray(elevs, windowSize = 5) {
    if (!Array.isArray(elevs) || elevs.length === 0) return [];
    const half = Math.floor(windowSize / 2);
    return elevs.map((val, idx) => {
      if (val == null || isNaN(Number(val))) return null;
      let sum = 0;
      let cnt = 0;
      const start = Math.max(0, idx - half);
      const end = Math.min(elevs.length - 1, idx + half);
      for (let j = start; j <= end; j++) {
        const v = elevs[j];
        if (v != null && !isNaN(Number(v))) {
          sum += Number(v);
          cnt++;
        }
      }
      return cnt > 0 ? Math.round((sum / cnt) * 10) / 10 : Number(val);
    });
  }

  function _interpArr(arr, fracIdx) {
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const i0 = Math.max(0, Math.min(arr.length - 1, Math.floor(fracIdx)));
    const i1 = Math.max(0, Math.min(arr.length - 1, Math.ceil(fracIdx)));
    const v0 = arr[i0];
    const v1 = arr[i1];
    if (v0 == null && v1 == null) return null;
    if (v0 == null) return Number(v1);
    if (v1 == null || i0 === i1) return Number(v0);
    const t = fracIdx - i0;
    return Number(v0) + (Number(v1) - Number(v0)) * t;
  }

  function _isValidCadence(val, isCycling) {
    if (val == null || isNaN(Number(val))) return false;
    const n = Number(val);
    return isCycling ? (n >= 20 && n <= 160) : (n >= 70 && n <= 240);
  }

  function _interpCadence(arr, fracIdx, isCycling) {
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const i0 = Math.max(0, Math.min(arr.length - 1, Math.floor(fracIdx)));
    const i1 = Math.max(0, Math.min(arr.length - 1, Math.ceil(fracIdx)));
    const t = fracIdx - i0;
    const v0 = arr[i0];
    const v1 = arr[i1];
    const ok0 = _isValidCadence(v0, isCycling);
    const ok1 = _isValidCadence(v1, isCycling);
    if (ok0 && ok1) {
      return Math.round(Number(v0) + (Number(v1) - Number(v0)) * t);
    }
    // Never interpolate across a 0/stopped/invalid sample; use nearest valid only if closer to it
    const nearest = t < 0.5 ? (ok0 ? v0 : null) : (ok1 ? v1 : null);
    return nearest != null ? Math.round(Number(nearest)) : null;
  }

  /**
   * Builds a synchronized Flyover track from an AaronFit activity object.
   * Handles all 4 data completeness cases (A: full, B: partial, C: geometry_only, D: none).
   */
  function buildFlyoverTrack(activity) {
    if (!activity || typeof activity !== "object") {
      return { mode: "none", points: [], totalDistanceM: 0, totalTimeSec: 0, bounds: null, hasStreams: false, hasTimestamps: false, hasElevation: false, hasHr: false, hasCadence: false };
    }

    let rawPoly = activity.polyline;
    if (typeof rawPoly === "string") {
      rawPoly = decodePolyline(rawPoly);
    }
    const cleanPts = deduplicateAndOrderTrack(rawPoly || []);
    if (cleanPts.length < 2) {
      return { mode: "none", points: [], totalDistanceM: 0, totalTimeSec: 0, bounds: null, hasStreams: false, hasTimestamps: false, hasElevation: false, hasHr: false, hasCadence: false };
    }

    const pts = simplifyTrackDouglasPeucker(cleanPts, 1500, 0.00002);

    // Compute cumulative geodesic distance along GPS track
    let cumM = 0;
    let minLat = pts[0].lat, maxLat = pts[0].lat;
    let minLon = pts[0].lon, maxLon = pts[0].lon;
    pts[0].dist_m = 0;
    for (let i = 1; i < pts.length; i++) {
      const seg = haversineMeters(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
      cumM += seg;
      pts[i].dist_m = cumM;
      if (pts[i].lat < minLat) minLat = pts[i].lat;
      if (pts[i].lat > maxLat) maxLat = pts[i].lat;
      if (pts[i].lon < minLon) minLon = pts[i].lon;
      if (pts[i].lon > maxLon) maxLon = pts[i].lon;
    }

    const cs = activity.chart_series || {};
    const csDist = Array.isArray(cs.dist_km) ? cs.dist_km : [];
    const csTime = Array.isArray(cs.time_sec) ? cs.time_sec : [];
    const csElev = Array.isArray(cs.elevation_m) ? cs.elevation_m : [];
    const csHr = Array.isArray(cs.hr) ? cs.hr : [];
    const csPace = Array.isArray(cs.pace_sec) ? cs.pace_sec : [];
    const csSpeed = Array.isArray(cs.speed_mps) ? cs.speed_mps : [];
    const csCad = Array.isArray(cs.cadence) ? cs.cadence : [];

    const hasStreamTime = csTime.some(v => v != null && !isNaN(Number(v)));
    const hasPointTs = pts.every(p => p.time_sec != null);
    const hasTimestamps = hasPointTs || hasStreamTime;
    const hasElevation = csElev.some(v => v != null && !isNaN(Number(v)));
    const hasHr = csHr.some(v => v != null && Number(v) > 30);
    const isCycling = String(activity.sport_type || "").toLowerCase().includes("cicl");
    const hasCadence = csCad.some(v => _isValidCadence(v, isCycling));
    const hasPaceOrSpeed = csPace.some(v => v != null && Number(v) > 0) || csSpeed.some(v => v != null && Number(v) > 0);
    const hasStreams = csDist.length >= 2 && (hasStreamTime || hasElevation || hasHr || hasPaceOrSpeed);

    const smoothElevStream = hasElevation ? smoothElevationArray(csElev, 5) : [];

    // Map each GPS point to chart_series by cumulative distance ratio
    const totalTrackM = cumM > 0 ? cumM : 1;
    const totalCsKm = csDist.length >= 2 ? Number(csDist[csDist.length - 1] || 0) : 0;
    const officialDistKm = (totalCsKm > 0)
      ? totalCsKm
      : ((activity.distance_km != null && Number(activity.distance_km) > 0)
        ? Number(activity.distance_km)
        : (cumM / 1000.0));

    let csCursor = 0;
    let gainM = 0;
    let prevSmoothElev = null;

    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      // Use Garmin stream dist_km directly when present; otherwise official distance_km or Haversine
      p.dist_km = Math.round(((p.dist_m / totalTrackM) * officialDistKm) * 1000) / 1000;

      if (hasStreams && csDist.length >= 2) {
        const targetKm = totalCsKm > 0
          ? (p.dist_m / totalTrackM) * totalCsKm
          : (i / (pts.length - 1)) * (csDist.length - 1);

        let fracIdx = 0;
        if (totalCsKm > 0) {
          while (csCursor < csDist.length - 2 && Number(csDist[csCursor + 1] || 0) < targetKm) {
            csCursor++;
          }
          const d0 = Number(csDist[csCursor] || 0);
          const d1 = Number(csDist[csCursor + 1] || d0);
          const span = d1 - d0;
          const t = span > 1e-6 ? Math.max(0, Math.min(1, (targetKm - d0) / span)) : 0;
          fracIdx = csCursor + t;
        } else {
          fracIdx = (i / Math.max(1, pts.length - 1)) * (csDist.length - 1);
        }

        if (p.time_sec == null && hasStreamTime) {
          const tVal = _interpArr(csTime, fracIdx);
          p.time_sec = tVal != null ? Math.round(tVal * 10) / 10 : null;
        }
        p.elev_raw_m = hasElevation ? _interpArr(csElev, fracIdx) : null;
        p.elev_m = hasElevation ? _interpArr(smoothElevStream, fracIdx) : null;
        p.hr = hasHr ? _interpArr(csHr, fracIdx) : null;
        p.cadence = hasCadence ? _interpCadence(csCad, fracIdx, isCycling) : null;

        let spd = _interpArr(csSpeed, fracIdx);
        let pace = _interpArr(csPace, fracIdx);
        if (spd == null && pace != null && pace > 0) spd = 1000.0 / pace;
        if (pace == null && spd != null && spd > 0.4) pace = 1000.0 / spd;
        p.speed_mps = spd != null ? Math.round(spd * 100) / 100 : null;
        p.pace_sec = pace != null ? Math.round(pace) : null;

        if (p.elev_m != null) {
          p.elev_m = Math.round(p.elev_m * 10) / 10;
          if (prevSmoothElev != null && p.elev_m > prevSmoothElev) {
            gainM += (p.elev_m - prevSmoothElev);
          }
          prevSmoothElev = p.elev_m;
        }
        p.elev_gain_m = hasElevation ? Math.round(gainM) : null;
      } else {
        p.elev_raw_m = null;
        p.elev_m = null;
        p.elev_gain_m = null;
        p.hr = null;
        p.cadence = null;
        p.speed_mps = null;
        p.pace_sec = null;
      }

      // Compute forward bearing for camera orientation
      const nextIdx = Math.min(pts.length - 1, i + 1);
      const prevIdx = Math.max(0, i - 1);
      if (nextIdx > i) {
        p.bearing = computeBearing(p.lat, p.lon, pts[nextIdx].lat, pts[nextIdx].lon);
      } else if (i > prevIdx) {
        p.bearing = computeBearing(pts[prevIdx].lat, pts[prevIdx].lon, p.lat, p.lon);
      } else {
        p.bearing = 0;
      }
    }

    let mode = "geometry_only";
    if (hasStreams && hasTimestamps && hasElevation) {
      mode = "full";
    } else if (hasStreams || hasTimestamps) {
      mode = "partial";
    }

    const lastTime = pts[pts.length - 1].time_sec;
    const totalTimeSec = hasTimestamps && lastTime != null ? Number(lastTime) : 0;

    return {
      mode,
      points: pts,
      totalDistanceM: Math.round(officialDistKm * 1000.0),
      totalDistanceKm: Math.round(officialDistKm * 100) / 100,
      totalTimeSec,
      bounds: [[minLon, minLat], [maxLon, maxLat]],
      hasStreams,
      hasTimestamps,
      hasElevation,
      hasHr,
      hasCadence,
    };
  }

  /**
   * Samples interpolated track state at normalized progress [0..1].
   */
  function sampleTrackAtProgress(track, progress01) {
    const pts = track && track.points;
    if (!pts || pts.length === 0) return null;
    const cl = Math.max(0, Math.min(1, Number(progress01) || 0));
    if (pts.length === 1) return Object.assign({ index: 0, progress: cl }, pts[0]);

    const exactIdx = cl * (pts.length - 1);
    const i0 = Math.floor(exactIdx);
    const i1 = Math.min(pts.length - 1, i0 + 1);
    const t = exactIdx - i0;
    const a = pts[i0];
    const b = pts[i1];

    function lerp(va, vb) {
      if (va == null && vb == null) return null;
      if (va == null) return vb;
      if (vb == null) return va;
      return va + (vb - va) * t;
    }

    // Look ahead slightly for smoother camera bearing on corners
    const lookIdx = Math.min(pts.length - 1, i0 + Math.max(3, Math.round(pts.length * 0.025)));
    const lookAheadBearing = lookIdx > i0
      ? computeBearing(a.lat, a.lon, pts[lookIdx].lat, pts[lookIdx].lon)
      : a.bearing;

    const interpDistKm = lerp(a.dist_km, b.dist_km);
    return {
      index: i0,
      progress: cl,
      lat: lerp(a.lat, b.lat),
      lon: lerp(a.lon, b.lon),
      dist_m: interpDistKm * 1000.0,
      dist_km: Math.round(interpDistKm * 100) / 100,
      time_sec: lerp(a.time_sec, b.time_sec),
      elev_m: lerp(a.elev_m, b.elev_m),
      elev_gain_m: lerp(a.elev_gain_m, b.elev_gain_m) != null ? Math.round(lerp(a.elev_gain_m, b.elev_gain_m)) : null,
      hr: lerp(a.hr, b.hr),
      cadence: (a.cadence != null && b.cadence != null)
        ? Math.round(lerp(a.cadence, b.cadence))
        : (t < 0.5 ? (a.cadence ?? null) : (b.cadence ?? null)),
      speed_mps: lerp(a.speed_mps, b.speed_mps),
      pace_sec: lerp(a.pace_sec, b.pace_sec),
      bearing: smoothBearingAngle(a.bearing, lookAheadBearing, 0.65),
    };
  }

  /**
   * Samples track state by elapsed time in seconds (when timestamps exist).
   */
  function sampleTrackAtTime(track, elapsedSec) {
    const pts = track && track.points;
    if (!pts || pts.length === 0) return null;
    if (!track.hasTimestamps || !track.totalTimeSec) {
      return sampleTrackAtProgress(track, 0);
    }
    const targetT = Math.max(0, Math.min(track.totalTimeSec, Number(elapsedSec) || 0));
    let lo = 0, hi = pts.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if ((pts[mid].time_sec || 0) <= targetT) lo = mid;
      else hi = mid;
    }
    const t0 = pts[lo].time_sec || 0;
    const t1 = pts[hi].time_sec || t0;
    const frac = t1 > t0 ? (targetT - t0) / (t1 - t0) : 0;
    const prog = (lo + frac) / Math.max(1, pts.length - 1);
    return sampleTrackAtProgress(track, prog);
  }

  /**
   * Playback controller state machine (1x, 2x, 4x, play, pause, restart, seek, camera mode).
   */
  class FlyoverPlayerController {
    constructor(track, baseDurationMs = 45000) {
      this.track = track;
      this.baseDurationMs = Math.max(10000, baseDurationMs);
      this.isPlaying = false;
      this.speed = 1;
      this.progress = 0;
      this.cameraMode = "chase"; // 'chase' | 'overview' | 'free'
    }

    play() {
      if (this.progress >= 1) this.progress = 0;
      this.isPlaying = true;
    }

    pause() {
      this.isPlaying = false;
    }

    restart() {
      this.progress = 0;
      this.isPlaying = true;
    }

    seek(progress01) {
      this.progress = Math.max(0, Math.min(1, Number(progress01) || 0));
      return this.getCurrentSample();
    }

    setSpeed(mult) {
      if ([1, 2, 4].includes(Number(mult))) {
        this.speed = Number(mult);
      }
    }

    setCameraMode(mode) {
      if (["chase", "overview", "free"].includes(mode)) {
        this.cameraMode = mode;
      }
    }

    step(deltaMs) {
      if (!this.isPlaying) return this.getCurrentSample();
      const inc = (Math.max(0, deltaMs) * this.speed) / this.baseDurationMs;
      this.progress = Math.min(1, this.progress + inc);
      if (this.progress >= 1) {
        this.isPlaying = false;
      }
      return this.getCurrentSample();
    }

    getCurrentSample() {
      return sampleTrackAtProgress(this.track, this.progress);
    }
  }

  return {
    haversineMeters,
    computeBearing,
    smoothBearingAngle,
    decodePolyline,
    deduplicateAndOrderTrack,
    simplifyTrackDouglasPeucker,
    smoothElevationArray,
    buildFlyoverTrack,
    sampleTrackAtProgress,
    sampleTrackAtTime,
    FlyoverPlayerController,
  };
}));
