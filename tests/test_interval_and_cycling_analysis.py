"""
tests/test_interval_and_cycling_analysis.py — Synthetic unit tests for deep interval & cycling analysis.
Runs 100% offline without Garmin connection.
Covers:
  1. 6x3 min interval session with 90s rests + warmup + cooldown (via laps and via stream detection)
  2. Continuous tempo session
  3. Steady aerobic easy run (rodaje)
  4. Cycling WITH power (constant power NP == power, peak efforts, estimated FTP, IF/TSS with and without profile FTP)
  5. Cycling WITHOUT power (all power metrics None + warning)
  6. Legacy activity in DB without laps_json (backward compatibility)
"""
import unittest
import analytics_engine
import ai_coach
import database


class TestIntervalAndCyclingAnalysis(unittest.TestCase):
    def test_1_intervals_6x3min_with_rests_and_warmup_cooldown(self):
        # 10 min warmup @ 6:00/km (360s), 6 x (3 min work @ 4:30/km [270s] + 90s rest @ 6:30/km [390s]), 10 min cooldown @ 6:05/km (365s)
        laps = [
            {
                "index": 1,
                "intent": "WARMUP",
                "duration_sec": 600.0,
                "distance_m": 1667.0,
                "pace_sec": 360,
                "avg_hr": 135,
                "max_hr": 144,
                "cadence": 166,
                "source": "laps_garmin",
            }
        ]
        work_paces = [268, 269, 270, 271, 272, 274]
        work_hrs = [164, 166, 168, 170, 171, 173]
        idx = 2
        for rep in range(6):
            laps.append({
                "index": idx,
                "intent": "INTERVAL",
                "duration_sec": 180.0,
                "distance_m": round(180.0 / work_paces[rep] * 1000.0, 1),
                "pace_sec": work_paces[rep],
                "avg_hr": work_hrs[rep],
                "max_hr": work_hrs[rep] + 4,
                "cadence": 178,
                "source": "laps_garmin",
            })
            idx += 1
            laps.append({
                "index": idx,
                "intent": "RECOVERY",
                "duration_sec": 90.0,
                "distance_m": 230.0,
                "pace_sec": 390,
                "avg_hr": work_hrs[rep] - 22,
                "max_hr": work_hrs[rep],
                "cadence": 160,
                "source": "laps_garmin",
            })
            idx += 1
        laps.append({
            "index": idx,
            "intent": "COOLDOWN",
            "duration_sec": 600.0,
            "distance_m": 1640.0,
            "pace_sec": 365,
            "avg_hr": 140,
            "max_hr": 148,
            "cadence": 165,
            "source": "laps_garmin",
        })

        act = {
            "external_id": "test_intervals_1",
            "sport_type": "Carrera",
            "name": "6x3 min Series",
            "duration_min": 47.0,
            "distance_km": 9.3,
        }
        planned = {
            "titulo": "Calidad Runna 6x3'",
            "phases": [{"type": "WORK", "target_pace": "4:25 - 4:35"}],
        }

        res = analytics_engine.analyze_activity_deep(act, laps=laps, stream=None, planned_day=planned)
        self.assertEqual(res["tipo"], "series")
        self.assertEqual(res["fuente"], "laps_garmin")
        m = res["metricas"]
        self.assertEqual(m["repeticiones_trabajo"], 6)
        # Warmup (360) and cooldown (365) must NOT be mixed into work average (~270.7)
        self.assertAlmostEqual(m["ritmo_medio_trabajo_sec"], 270.7, places=1)
        self.assertIsNotNone(res["calentamiento"])
        self.assertIsNotNone(res["enfriamiento"])
        self.assertEqual(m["fatiga_primera_vs_ultima_sec"], 6.0)
        self.assertEqual(m["deriva_fc_primera_vs_ultima_bpm"], 9.0)
        self.assertEqual(m["recuperacion_caida_60s_media_bpm"], 22.0)
        self.assertIsNotNone(m["cumplimiento_plan"])
        self.assertEqual(m["cumplimiento_plan"]["compliance_pct"], 100)

        # AI / deterministic interpretation must return 3 conclusions
        interp = ai_coach.generate_session_deep_interpretation(res)
        self.assertEqual(len(interp["conclusiones"]), 3)
        self.assertTrue(bool(interp["punto_a_mejorar"]))
        self.assertTrue(bool(interp["recomendacion_siguiente_sesion"]))

    def test_2_stream_interval_detection_without_laps(self):
        # Build a synthetic stream with 5s samples: 5 min warmup @ 360s/km, 4 x (120s @ 260s/km + 90s @ 380s/km), 5 min cool @ 360s/km
        times, paces, hrs, dists = [], [], [], []
        t = 0.0
        d_km = 0.0

        def _append_block(dur_s, pace_s, hr_v):
            nonlocal t, d_km
            steps = int(dur_s // 5)
            for _ in range(steps):
                t += 5.0
                d_km += (5.0 / pace_s)
                times.append(t)
                paces.append(pace_s)
                hrs.append(hr_v)
                dists.append(round(d_km, 4))

        _append_block(300, 360, 136)
        for _ in range(4):
            _append_block(120, 260, 170)
            _append_block(90, 380, 145)
        _append_block(300, 360, 138)

        stream = {"time_sec": times, "pace_sec": paces, "hr": hrs, "dist_km": dists}
        act = {"external_id": "test_stream_series", "sport_type": "Carrera", "name": "Entrenamiento", "duration_min": 24.0}
        res = analytics_engine.analyze_activity_deep(act, laps=[], stream=stream)
        self.assertEqual(res["fuente"], "stream")
        self.assertEqual(res["tipo"], "series")
        self.assertEqual(res["metricas"]["repeticiones_trabajo"], 4)

    def test_3_tempo_and_rodaje_classification(self):
        # Tempo: 10 min @ 350s/km, 20 min steady @ 275s/km (HR 164), 10 min @ 355s/km
        times, paces, hrs = [], [], []
        t = 0.0
        for dur, p, h in [(600, 350, 138), (1200, 275, 164), (600, 355, 140)]:
            for _ in range(dur // 10):
                t += 10.0
                times.append(t)
                paces.append(p)
                hrs.append(h)
        tempo_act = {"external_id": "test_tempo", "sport_type": "Carrera", "name": "Carrera matutina", "duration_min": 40.0}
        res_tempo = analytics_engine.analyze_activity_deep(tempo_act, laps=[], stream={"time_sec": times, "pace_sec": paces, "hr": hrs})
        self.assertEqual(res_tempo["tipo"], "tempo")

        # Rodaje: 40 min steady @ 345s/km (HR 139)
        r_times = [float(i * 10) for i in range(1, 241)]
        r_paces = [345.0 + (i % 3 - 1) * 2.0 for i in range(240)]
        r_hrs = [139.0 for _ in range(240)]
        rodaje_act = {"external_id": "test_rodaje", "sport_type": "Carrera", "name": "Salida suave", "duration_min": 40.0}
        res_rodaje = analytics_engine.analyze_activity_deep(rodaje_act, laps=[], stream={"time_sec": r_times, "pace_sec": r_paces, "hr": r_hrs})
        self.assertEqual(res_rodaje["tipo"], "rodaje")

    def test_4_cycling_with_power_and_constant_np(self):
        # 25 minutes (1500s) at constant 200 W (1 sample every 5s -> 301 samples)
        times = [float(i * 5) for i in range(301)]
        powers = [200.0 for _ in range(301)]
        hrs = [145.0 for _ in range(301)]
        stream = {"time_sec": times, "power_w": powers, "hr": hrs, "dist_km": [round(i * 0.04, 3) for i in range(301)]}
        act = {"external_id": "test_bike_pwr", "sport_type": "Ciclismo", "name": "Ruta Bici", "duration_min": 25.0, "distance_km": 12.0}

        # (a) With athlete_ftp = 250 W
        res_with_ftp = analytics_engine.analyze_activity_deep(act, laps=[], stream=stream, athlete_ftp=250.0)
        self.assertEqual(res_with_ftp["tipo"], "bici_potencia")
        m = res_with_ftp["metricas"]
        # NP of constant 200 W must equal 200.0 W
        self.assertEqual(m["potencia_normalizada_np_w"], 200.0)
        self.assertEqual(m["factor_intensidad_if"], 0.8)
        self.assertIsNotNone(m["tss"])
        self.assertEqual(m["mejores_esfuerzos_w"]["20m"], 200.0)
        self.assertEqual(m["ftp_estimado_20m_w"], 190.0)

        # (b) Without athlete_ftp (None) -> IF and TSS must be None with warning
        res_no_ftp = analytics_engine.analyze_activity_deep(act, laps=[], stream=stream, athlete_ftp=None)
        self.assertIsNone(res_no_ftp["metricas"]["factor_intensidad_if"])
        self.assertIsNone(res_no_ftp["metricas"]["tss"])
        self.assertTrue(any("FTP" in a for a in res_no_ftp["avisos"]))

    def test_5_cycling_without_power(self):
        times = [float(i * 10) for i in range(180)]
        hrs = [142.0 for _ in range(180)]
        dists = [round(i * 0.07, 3) for i in range(180)]
        elevs = [100.0 + i * 1.5 for i in range(180)]
        stream = {"time_sec": times, "hr": hrs, "dist_km": dists, "elevation_m": elevs}
        act = {"external_id": "test_bike_nopwr", "sport_type": "Ciclismo", "name": "Bici sin potenciómetro", "duration_min": 30.0, "distance_km": 12.6, "elevation_gain": 270.0, "avg_hr": 142}

        res = analytics_engine.analyze_activity_deep(act, laps=[], stream=stream, athlete_ftp=240.0)
        self.assertEqual(res["tipo"], "bici_sin_potencia")
        m = res["metricas"]
        self.assertIsNone(m["potencia_normalizada_np_w"])
        self.assertIsNone(m["factor_intensidad_if"])
        self.assertIsNone(m["tss"])
        self.assertTrue(m["analisis_limitado"])
        self.assertTrue(any("Sin potencia" in a for a in res["avisos"]))

    def test_6_legacy_activity_without_laps_in_db(self):
        database.init_db()
        database.upsert_activities([{
            "id": "legacy_act_999",
            "fecha": "2026-11-01",
            "tipo": "Carrera",
            "nombre": "Rodaje Antiguo",
            "duracion_min": 30.0,
            "distancia_km": 5.0,
        }])
        database.save_activity_stream(
            "legacy_act_999",
            polyline=[[40.0, -3.0], [40.01, -3.01]],
            splits=[{"km": 1, "pace_sec": 360, "pace_str": "6:00 /km"}],
            hr_zones=[],
            chart_series={"dist_km": [0.0, 5.0], "time_sec": [0.0, 1800.0], "pace_sec": [360, 360]},
        )
        detail = database.get_activity_detail("legacy_act_999")
        self.assertIsNotNone(detail)
        self.assertEqual(detail.get("laps"), [])
        self.assertIsNone(detail.get("analysis"))


if __name__ == "__main__":
    unittest.main()
