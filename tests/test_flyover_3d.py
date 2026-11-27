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


if __name__ == "__main__":
    unittest.main()
