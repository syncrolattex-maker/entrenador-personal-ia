"""
tests/test_flyover_3d.py — Automated test suite for AARONFIT FLYOVER 3D.
Covers:
  1. Polyline decoding
  2. Temporal GPS ordering & deduplication of duplicate GPS points
  3. Geodesic distance calculation (Haversine)
  4. Stream & altitude synchronization + elevation smoothing
  5. Playback controller: 1x / 2x / 4x speeds, pause, resume, restart, seek, camera modes
  6. Activities without GPS (mode='none')
  7. Activities without timestamps (mode='geometry_only', never faking pace/time)
  8. Incomplete/partial streams (hiding missing HR/cadence)
  9. Lazy-loading & WebGL resource cleanup verification (no MapLibre in initial HTML)
 10. Mobile responsive CSS rules & WebGL 2D fallback presence
"""
import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENGINE_JS = (ROOT / "static" / "flyover-engine.js").as_posix()


def _run_node_engine_test(js_body: str) -> dict:
    script = f"""
    const Engine = require({json.dumps(ENGINE_JS)});
    const result = (() => {{
        {js_body}
    }})();
    console.log(JSON.stringify(result));
    """
    proc = subprocess.run(
        ["node", "-e", script],
        capture_output=True,
        text=True,
        check=True,
        timeout=10,
    )
    return json.loads(proc.stdout.strip())


class TestFlyover3D(unittest.TestCase):
    def test_1_decode_polyline_and_haversine_distance(self):
        res = _run_node_engine_test("""
            // Standard Google encoded polyline sample (~3 points)
            const pts = Engine.decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@");
            const d01 = Engine.haversineMeters(pts[0][0], pts[0][1], pts[1][0], pts[1][1]);
            return { len: pts.length, p0: pts[0], d01 };
        """)
        self.assertEqual(res["len"], 3)
        self.assertAlmostEqual(res["p0"][0], 38.5, places=2)
        self.assertAlmostEqual(res["p0"][1], -120.2, places=2)
        self.assertGreater(res["d01"], 100000)

    def test_2_deduplicate_and_temporal_ordering(self):
        res = _run_node_engine_test("""
            // Out-of-order timestamps + consecutive duplicate <0.5m
            const raw = [
                [40.4000, -3.7000, 20],
                [40.4000, -3.7000, 20], // duplicate
                [40.3990, -3.7000, 0],  // earlier timestamp
                [40.4010, -3.7000, 40],
                [40.401001, -3.700001, 41], // <0.5m duplicate
            ];
            const clean = Engine.deduplicateAndOrderTrack(raw);
            return { count: clean.length, times: clean.map(p => p.time_sec) };
        """)
        self.assertEqual(res["count"], 3)
        self.assertEqual(res["times"], [0, 20, 40])

    def test_3_full_stream_sync_altitude_and_smoothing(self):
        res = _run_node_engine_test("""
            const act = {
                polyline: [
                    [40.4000, -3.7000],
                    [40.4045, -3.7000], // ~500m north
                    [40.4090, -3.7000], // ~1000m north
                ],
                chart_series: {
                    dist_km: [0.0, 0.5, 1.0],
                    time_sec: [0, 150, 300],
                    elevation_m: [600, 625, 650],
                    hr: [135, 148, 158],
                    cadence: [170, 174, 176],
                    speed_mps: [3.33, 3.33, 3.33],
                    pace_sec: [300, 300, 300],
                }
            };
            const track = Engine.buildFlyoverTrack(act);
            const mid = Engine.sampleTrackAtProgress(track, 0.5);
            const atTime = Engine.sampleTrackAtTime(track, 150);
            return {
                mode: track.mode,
                hasElev: track.hasElevation,
                hasHr: track.hasHr,
                hasCad: track.hasCadence,
                totalDistM: track.totalDistanceM,
                midDistKm: mid.dist_km,
                midTime: mid.time_sec,
                midHr: mid.hr,
                midElev: mid.elev_m,
                atTimeDistKm: atTime.dist_km,
            };
        """)
        self.assertEqual(res["mode"], "full")
        self.assertTrue(res["hasElev"])
        self.assertTrue(res["hasHr"])
        self.assertTrue(res["hasCad"])
        self.assertGreater(res["totalDistM"], 950)
        self.assertLess(res["totalDistM"], 1050)
        self.assertAlmostEqual(res["midTime"], 150, delta=5)
        self.assertAlmostEqual(res["midHr"], 148, delta=3)
        self.assertIsNotNone(res["midElev"])
        self.assertAlmostEqual(res["atTimeDistKm"], res["midDistKm"], delta=0.05)

    def test_4_playback_speeds_pause_resume_and_seek(self):
        res = _run_node_engine_test("""
            const track = Engine.buildFlyoverTrack({
                polyline: [[40.400, -3.700], [40.405, -3.700], [40.410, -3.700]],
                chart_series: { dist_km: [0, 0.55, 1.1], time_sec: [0, 150, 300], elevation_m: [600, 610, 620] }
            });
            const ctrl = new Engine.FlyoverPlayerController(track, 10000);
            ctrl.play();
            ctrl.step(1000); // 1x -> 0.1
            const p1x = ctrl.progress;
            ctrl.setSpeed(2);
            ctrl.step(1000); // 2x -> +0.2 = 0.3
            const p2x = ctrl.progress;
            ctrl.setSpeed(4);
            ctrl.step(1000); // 4x -> +0.4 = 0.7
            const p4x = ctrl.progress;
            ctrl.pause();
            ctrl.step(2000); // paused -> stays 0.7
            const pPaused = ctrl.progress;
            ctrl.seek(0.25);
            const pSeek = ctrl.progress;
            ctrl.restart();
            const pRestart = ctrl.progress;
            return { p1x, p2x, p4x, pPaused, pSeek, pRestart, playing: ctrl.isPlaying };
        """)
        self.assertAlmostEqual(res["p1x"], 0.1, places=4)
        self.assertAlmostEqual(res["p2x"], 0.3, places=4)
        self.assertAlmostEqual(res["p4x"], 0.7, places=4)
        self.assertAlmostEqual(res["pPaused"], 0.7, places=4)
        self.assertAlmostEqual(res["pSeek"], 0.25, places=4)
        self.assertEqual(res["pRestart"], 0)
        self.assertTrue(res["playing"])

    def test_5_no_gps_and_geometry_only_and_partial_streams(self):
        res = _run_node_engine_test("""
            const noGps = Engine.buildFlyoverTrack({ polyline: [] });
            const geomOnly = Engine.buildFlyoverTrack({
                polyline: [[40.400, -3.700], [40.404, -3.700]]
            });
            const partial = Engine.buildFlyoverTrack({
                polyline: [[40.400, -3.700], [40.404, -3.700]],
                chart_series: { dist_km: [0, 0.44], time_sec: [0, 120] }
            });
            const gSample = Engine.sampleTrackAtProgress(geomOnly, 0.5);
            return {
                noGpsMode: noGps.mode,
                geomMode: geomOnly.mode,
                geomHasTs: geomOnly.hasTimestamps,
                geomPace: gSample.pace_sec,
                geomTime: gSample.time_sec,
                partialMode: partial.mode,
                partialHasHr: partial.hasHr,
                partialHasCad: partial.hasCadence,
            };
        """)
        self.assertEqual(res["noGpsMode"], "none")
        self.assertEqual(res["geomMode"], "geometry_only")
        self.assertFalse(res["geomHasTs"])
        self.assertIsNone(res["geomPace"])
        self.assertIsNone(res["geomTime"])
        self.assertEqual(res["partialMode"], "partial")
        self.assertFalse(res["partialHasHr"])
        self.assertFalse(res["partialHasCad"])

    def test_6_douglas_peucker_simplification_large_track(self):
        res = _run_node_engine_test("""
            const pts = [];
            for (let i = 0; i < 3000; i++) {
                pts.push([40.4 + i * 0.0001, -3.7 + Math.sin(i * 0.05) * 0.002]);
            }
            const track = Engine.buildFlyoverTrack({ polyline: pts });
            return { count: track.points.length, totalDistM: track.totalDistanceM };
        """)
        self.assertLessEqual(res["count"], 1500)
        self.assertGreater(res["count"], 50)
        self.assertGreater(res["totalDistM"], 10000)

    def test_7_lazy_loading_cleanup_webgl_fallback_and_mobile_css(self):
        index_html = (ROOT / "static" / "index.html").read_text(encoding="utf-8")
        flyover_js = (ROOT / "static" / "flyover-3d.js").read_text(encoding="utf-8")
        theme_css = (ROOT / "static" / "theme-stitch.css").read_text(encoding="utf-8")

        # Lazy loading: index.html must NOT load maplibre or flyover scripts eagerly
        self.assertNotIn("maplibre-gl.js", index_html)
        self.assertNotIn("flyover-3d.js", index_html)
        self.assertIn("btn-play-flyover-3d", index_html)
        self.assertIn("flyover-3d-modal", index_html)

        # Resource cleanup & WebGL fallback & reduced motion
        self.assertIn("_map.remove()", flyover_js)
        self.assertIn("hasWebGLSupport", flyover_js)
        self.assertIn("_init2DFallback", flyover_js)
        self.assertIn("prefers-reduced-motion", flyover_js)

        # Mobile adaptation
        self.assertIn(".flyover-hud-bottom", theme_css)
        self.assertIn("@media (max-width: 640px)", theme_css)

    def test_8_cadence_validation_running_vs_cycling_no_false_interpolation(self):
        res = _run_node_engine_test("""
            const runAct = {
                sport_type: "Carrera",
                polyline: [[40.400, -3.700], [40.405, -3.700], [40.410, -3.700]],
                chart_series: {
                    dist_km: [0.0, 0.55, 1.1],
                    time_sec: [0, 150, 300],
                    cadence: [170, 0, 174]
                }
            };
            const bikeAct = {
                sport_type: "Ciclismo",
                polyline: [[40.400, -3.700], [40.405, -3.700], [40.410, -3.700]],
                chart_series: {
                    dist_km: [0.0, 0.55, 1.1],
                    time_sec: [0, 60, 120],
                    cadence: [85, 0, 90]
                }
            };
            const rTrack = Engine.buildFlyoverTrack(runAct);
            const bTrack = Engine.buildFlyoverTrack(bikeAct);
            return {
                rMidCad: Engine.sampleTrackAtProgress(rTrack, 0.5).cadence,
                rStartCad: Engine.sampleTrackAtProgress(rTrack, 0).cadence,
                bMidCad: Engine.sampleTrackAtProgress(bTrack, 0.5).cadence,
                bStartCad: Engine.sampleTrackAtProgress(bTrack, 0).cadence,
            };
        """)
        self.assertIsNone(res["rMidCad"])
        self.assertEqual(res["rStartCad"], 170)
        self.assertIsNone(res["bMidCad"])
        self.assertEqual(res["bStartCad"], 85)

    def test_9_running_pace_scale_inversion_pauses_and_invalid_gaps(self):
        res = _run_node_engine_test("""
            const act = {
                sport_type: "Carrera",
                polyline: [
                    [40.4000, -3.7000],
                    [40.4020, -3.7000],
                    [40.4040, -3.7000],
                    [40.40401, -3.7000], // pause (<0.5m? wait: >0.5m to survive dedup, ~1.1m in 20s = 0.055 m/s)
                    [40.4060, -3.7000],
                    [40.4080, -3.7000],
                ],
                chart_series: {
                    dist_km: [0.0, 0.22, 0.44, 0.442, 0.66, 0.88],
                    time_sec: [0, 80, 140, 170, 220, 265],
                    pace_sec: [360, 360, 240, null, 240, 240],
                    speed_mps: [2.78, 2.78, 4.17, 0.05, 4.17, 4.17],
                }
            };
            const track = Engine.buildFlyoverTrack(act);
            const segs = track.segments;
            return {
                hasPaceSpeed: track.analytics.hasPaceSpeed,
                isCycling: track.analytics.isCycling,
                slowNorm: segs[0].paceNorm,
                slowColor: segs[0].paceColor,
                pauseFlag: segs[2].isPause,
                pauseColor: segs[2].paceColor,
                fastNorm: segs[4].paceNorm,
                fastColor: segs[4].paceColor,
                scale: track.analytics.paceScale,
            };
        """)
        self.assertTrue(res["hasPaceSpeed"])
        self.assertFalse(res["isCycling"])
        self.assertLess(res["slowNorm"], res["fastNorm"])
        self.assertEqual(res["slowColor"], "#EF4444")
        self.assertEqual(res["fastColor"], "#14B8A6")
        self.assertTrue(res["pauseFlag"])
        self.assertEqual(res["pauseColor"], "#9CA3AF")
        self.assertTrue(res["scale"]["hasPauses"])

    def test_10_cycling_speed_scale_and_outliers(self):
        res = _run_node_engine_test("""
            const pts = [];
            const distKm = [];
            const timeSec = [];
            const speedMps = [];
            for (let i = 0; i < 25; i++) {
                pts.push([40.400 + i * 0.002, -3.700]);
                distKm.push(i * 0.222);
                timeSec.push(i * 25);
                // Mostly 6..12 m/s, with 1 extreme outlier (25 m/s = 90 km/h)
                speedMps.push(i === 12 ? 25.0 : (6.0 + (i % 5) * 1.5));
            }
            const track = Engine.buildFlyoverTrack({
                sport_type: "Ciclismo",
                polyline: pts,
                chart_series: { dist_km: distKm, time_sec: timeSec, speed_mps: speedMps }
            });
            return {
                hasPaceSpeed: track.analytics.hasPaceSpeed,
                isCycling: track.analytics.isCycling,
                pLow: track.analytics.paceScale.pLow,
                pHigh: track.analytics.paceScale.pHigh,
                slowColor: track.segments[0].paceColor,
                fastNormalColor: track.segments[4].paceColor,
            };
        """)
        self.assertTrue(res["hasPaceSpeed"])
        self.assertTrue(res["isCycling"])
        # P95 prevents the single 90 km/h outlier from stretching pHigh to 90
        self.assertLess(res["pHigh"], 60.0)
        self.assertEqual(res["slowColor"], "#EF4444")

    def test_11_grade_positive_negative_flat_and_dem_separation(self):
        res = _run_node_engine_test("""
            // Up (+8%), flat (0%), down (-6%) over 1.2 km
            const pts = [];
            const distKm = [];
            const elevM = [];
            for (let i = 0; i <= 24; i++) {
                pts.push([40.400 + i * 0.00045, -3.700]);
                const d = i * 0.05; // 50m per step
                distKm.push(d);
                if (i <= 8) elevM.push(100 + i * 4);        // +8%
                else if (i <= 16) elevM.push(132);           // 0%
                else elevM.push(132 - (i - 16) * 3);         // -6%
            }
            const track = Engine.buildFlyoverTrack({
                sport_type: "Carrera",
                polyline: pts,
                chart_series: { dist_km: distKm, time_sec: distKm.map(d => d * 300), elevation_m: elevM }
            });
            const upSample = Engine.sampleTrackAtProgress(track, 0.16);
            const flatSample = Engine.sampleTrackAtProgress(track, 0.5);
            const downSample = Engine.sampleTrackAtProgress(track, 0.85);

            // Also test geometry-only + DEM separation
            const noElevTrack = Engine.buildFlyoverTrack({ polyline: pts });
            const demApplied = Engine.applyDemElevationToTrack(noElevTrack, elevM);
            return {
                hasGrade: track.analytics.hasGrade,
                gradeSource: track.analytics.gradeSource,
                upGrade: upSample.grade_percent,
                flatGrade: flatSample.grade_percent,
                downGrade: downSample.grade_percent,
                upColor: track.segments[3].gradeColor,
                flatColor: track.segments[12].gradeColor,
                downColor: track.segments[20].gradeColor,
                demApplied,
                demHasElevFlag: noElevTrack.hasElevation,
                demGradeSource: noElevTrack.analytics.gradeSource,
                demHasGrade: noElevTrack.analytics.hasGrade,
            };
        """)
        self.assertTrue(res["hasGrade"])
        self.assertEqual(res["gradeSource"], "garmin")
        self.assertGreater(res["upGrade"], 4.0)
        self.assertAlmostEqual(res["flatGrade"], 0.0, delta=1.5)
        self.assertLess(res["downGrade"], -3.0)
        self.assertEqual(res["flatColor"], "#14B8A6")
        self.assertTrue(res["demApplied"])
        self.assertFalse(res["demHasElevFlag"])
        self.assertEqual(res["demGradeSource"], "dem")
        self.assertTrue(res["demHasGrade"])

    def test_12_mode_switching_geometry_only_and_1500_point_perf(self):
        res = _run_node_engine_test("""
            // Geometry-only activity must not invent pace or grade colors
            const polyOnly = Engine.buildFlyoverTrack({
                polyline: [[40.400, -3.700], [40.405, -3.700], [40.410, -3.700]]
            });

            // 1500-point track performance & GeoJSON build + mode switching while playing
            const pts = [];
            const distKm = [];
            const timeSec = [];
            const elevM = [];
            const paceSec = [];
            for (let i = 0; i < 1500; i++) {
                pts.push([40.4 + i * 0.0001, -3.7 + Math.sin(i * 0.03) * 0.001]);
                distKm.push(i * 0.011);
                timeSec.push(i * 3.2);
                elevM.push(200 + Math.sin(i * 0.02) * 35);
                paceSec.push(280 + (i % 40));
            }
            const t0 = Date.now();
            const track = Engine.buildFlyoverTrack({
                sport_type: "Carrera",
                polyline: pts,
                chart_series: { dist_km: distKm, time_sec: timeSec, elevation_m: elevM, pace_sec: paceSec }
            });
            const geo = Engine.buildSegmentsGeoJson(track);
            const elapsedMs = Date.now() - t0;

            const ctrl = new Engine.FlyoverPlayerController(track, 20000);
            ctrl.play();
            ctrl.step(4000);
            const beforeMode = ctrl.colorMode;
            ctrl.setColorMode("grade");
            const afterMode = ctrl.colorMode;

            return {
                polyHasPace: polyOnly.analytics.hasPaceSpeed,
                polyHasGrade: polyOnly.analytics.hasGrade,
                polySegColor: Engine.buildSegmentsGeoJson(polyOnly).features[0].properties.paceColor,
                featCount: geo.features.length,
                elapsedMs,
                beforeMode,
                afterMode,
                stillPlaying: ctrl.isPlaying,
                progress: ctrl.progress,
            };
        """)
        self.assertFalse(res["polyHasPace"])
        self.assertFalse(res["polyHasGrade"])
        self.assertEqual(res["polySegColor"], "#EE5A2B")
        self.assertEqual(res["featCount"], 1499)
        self.assertLess(res["elapsedMs"], 500)
        self.assertEqual(res["beforeMode"], "pace_speed")
        self.assertEqual(res["afterMode"], "grade")
        self.assertTrue(res["stillPlaying"])
        self.assertAlmostEqual(res["progress"], 0.2, places=3)

    def test_13_prolonged_pause_vs_telemetry_gap_and_discipline_variants(self):
        res = _run_node_engine_test("""
            // Prolonged pause (180s, ~2m) vs telemetry gap while moving (150s, ~500m) vs normal moving
            const act = {
                sport_type: "road_biking",
                polyline: [
                    [40.4000, -3.7000],
                    [40.4050, -3.7000],  // seg 0: moving (9.26 -> 9.26 m/s)
                    [40.40502, -3.7000], // seg 1: transition into pause
                    [40.40504, -3.7000], // seg 2: prolonged pause (~2.2m in 180s, 0.0 -> 0.0 m/s)
                    [40.4100, -3.7000],  // seg 3: telemetry gap while moving (~551m in 150s, 0.0 -> 12.35 m/s)
                    [40.4150, -3.7000],  // seg 4: moving (12.35 -> 12.35 m/s)
                ],
                chart_series: {
                    dist_km: [0.0, 0.556, 0.558, 0.560, 1.111, 1.667],
                    time_sec: [0, 60, 65, 245, 395, 440],
                    speed_mps: [9.26, 9.26, 0.0, 0.0, 12.35, 12.35],
                    pace_sec: [108, 108, null, null, 81, 81],
                }
            };
            const track = Engine.buildFlyoverTrack(act);
            return {
                isCycling: track.analytics.isCycling,
                unit: track.analytics.paceScale && track.analytics.paceScale.unit,
                seg0: { pause: track.segments[0].isPause, gap: track.segments[0].isGap, color: track.segments[0].paceColor },
                seg2: { pause: track.segments[2].isPause, gap: track.segments[2].isGap, color: track.segments[2].paceColor },
                seg3: { pause: track.segments[3].isPause, gap: track.segments[3].isGap, color: track.segments[3].paceColor },
                seg4: { pause: track.segments[4].isPause, gap: track.segments[4].isGap, color: track.segments[4].paceColor },
            };
        """)
        self.assertTrue(res["isCycling"])
        self.assertEqual(res["unit"], "km/h")
        # seg 0: moving (slowest valid -> Red)
        self.assertFalse(res["seg0"]["pause"])
        self.assertFalse(res["seg0"]["gap"])
        self.assertEqual(res["seg0"]["color"], "#EF4444")
        # seg 2: prolonged 180s stationary pause -> Grey (#9CA3AF), NOT gap
        self.assertTrue(res["seg2"]["pause"])
        self.assertFalse(res["seg2"]["gap"])
        self.assertEqual(res["seg2"]["color"], "#9CA3AF")
        # seg 3: 150s telemetry gap while moving -> Slate (#64748B), NOT pause
        self.assertFalse(res["seg3"]["pause"])
        self.assertTrue(res["seg3"]["gap"])
        self.assertEqual(res["seg3"]["color"], "#64748B")
        # seg 4: moving (fastest valid -> Turquoise)
        self.assertFalse(res["seg4"]["pause"])
        self.assertFalse(res["seg4"]["gap"])
        self.assertEqual(res["seg4"]["color"], "#14B8A6")


if __name__ == "__main__":
    unittest.main()
