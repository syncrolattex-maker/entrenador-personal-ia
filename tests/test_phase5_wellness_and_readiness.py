import os
import sqlite3
import tempfile
import unittest
from datetime import date, timedelta
from unittest.mock import patch

from fastapi.testclient import TestClient

import ai_coach
import database
import main
import wellness_engine


class TestPhase5WellnessAndReadiness(unittest.TestCase):
    def setUp(self):
        self.tmp_dir = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self.tmp_dir.name, "test_phase5.db")
        self._orig_get_conn = database._get_conn
        database._get_conn = lambda: sqlite3.connect(self.db_path)
        database._DB_INITIALIZED = False
        database.init_db()
        self.client = TestClient(main.app)

    def tearDown(self):
        database._get_conn = self._orig_get_conn
        database._DB_INITIALIZED = False
        self.tmp_dir.cleanup()

    # 1. Sleep normalization & overnight wake-up date association (never invent sleep score)
    def test_sleep_normalization_and_overnight_date_association(self):
        raw_sleep = {
            "dailySleepDTO": {
                "calendarDate": "2026-07-23",
                "sleepTimeSeconds": 27000,  # 7.5 h
                "deepSleepSeconds": 5400,
                "lightSleepSeconds": 14400,
                "remSleepSeconds": 7200,
                "awakeSleepSeconds": 1200,
                "awakeCount": 2,
                "sleepStartTimestampLocal": "2026-07-22T23:15:00",
                "sleepEndTimestampLocal": "2026-07-23T07:05:00",
                "averageSpO2Value": 96.4,
                "averageRespirationValue": 14.2,
                # No sleepScores provided -> sleep_score must be None (never invented)
            }
        }
        norm = wellness_engine.normalize_garmin_sleep(raw_sleep, fallback_date="2026-07-22")
        self.assertEqual(norm["sleep_date"], "2026-07-23")
        self.assertEqual(norm["sleep_total_sec"], 27000)
        self.assertEqual(norm["deep_sleep_sec"], 5400)
        self.assertEqual(norm["rem_sleep_sec"], 7200)
        self.assertEqual(norm["interruptions_count"], 2)
        self.assertIsNone(norm["sleep_score"])
        self.assertAlmostEqual(norm["sleep_spo2_avg"], 96.4)
        self.assertAlmostEqual(norm["sleep_respiration_avg"], 14.2)

    # 2. Bundle normalization: full data -> complete, sentinel -1 filtered to None
    def test_bundle_normalization_complete_and_negative_sentinels(self):
        bundle = {
            "date": "2026-07-23",
            "summary": {
                "calendarDate": "2026-07-23",
                "totalSteps": 9450,
                "dailyStepGoal": 10000,
                "totalDistanceMeters": 7420.5,
                "floorsAscended": 8.0,
                "moderateIntensityMinutes": 25,
                "vigorousIntensityMinutes": 15,
                "activeKilocalories": 520,
                "totalKilocalories": 2480,
                "sedentarySeconds": 28800,
                "restingHeartRate": 51,
                "averageHeartRate": 66,
                "averageStressLevel": -1,  # Garmin sentinel for unmeasured stress -> must be None
                "bodyBatteryHighestValue": 88,
                "bodyBatteryLowestValue": 24,
                "bodyBatteryChargedValue": 64,
                "bodyBatteryDrainedValue": 52,
                "bodyBatteryMostRecentValue": 48,
            },
            "sleep": {
                "dailySleepDTO": {
                    "calendarDate": "2026-07-23",
                    "sleepTimeSeconds": 28800,
                    "sleepScores": {"overall": {"value": 84}},
                }
            },
            "hrv": {
                "hrvSummary": {
                    "lastNightAvg": 62.0,
                    "weeklyAvg": 60.5,
                    "status": "BALANCED",
                }
            },
        }
        row = wellness_engine.normalize_garmin_daily_bundle(bundle, target_date="2026-07-23")
        self.assertEqual(row["date"], "2026-07-23")
        self.assertEqual(row["day_status"], "complete")
        self.assertEqual(row["steps"], 9450)
        self.assertEqual(row["sleep_score"], 84)
        self.assertEqual(row["hrv_last_night"], 62.0)
        self.assertEqual(row["resting_hr"], 51)
        self.assertIsNone(row["stress_avg"])
        self.assertEqual(row["body_battery_max"], 88)

    # 3. Missing data vs partial vs pending vs unavailable (never treat missing as 0)
    def test_missing_and_partial_data_never_treated_as_zero(self):
        today_iso = date.today().isoformat()
        empty_today = wellness_engine.normalize_garmin_daily_bundle({"date": today_iso}, target_date=today_iso)
        self.assertEqual(empty_today["day_status"], "pending")
        self.assertIsNone(empty_today["steps"])
        self.assertIsNone(empty_today["sleep_total_sec"])
        self.assertIsNone(empty_today["hrv_last_night"])
        self.assertIsNone(empty_today["resting_hr"])

        past_empty = wellness_engine.normalize_garmin_daily_bundle({"date": "2026-06-01"}, target_date="2026-06-01")
        self.assertEqual(past_empty["day_status"], "unavailable")

        partial_bundle = {
            "date": "2026-07-20",
            "summary": {"totalSteps": 4200, "dailyStepGoal": 10000},
        }
        partial_row = wellness_engine.normalize_garmin_daily_bundle(partial_bundle, target_date="2026-07-20")
        self.assertEqual(partial_row["day_status"], "partial")
        self.assertEqual(partial_row["steps"], 4200)
        self.assertIsNone(partial_row["sleep_total_sec"])
        self.assertIsNone(partial_row["hrv_last_night"])

    # 4. Idempotent UPSERT in daily_wellness (COALESCE preserves existing non-null metrics)
    def test_database_upsert_idempotency_and_coalesce(self):
        first = {
            "date": "2026-07-21",
            "source": "garmin",
            "day_status": "partial",
            "sleep_total_sec": 27000,
            "sleep_score": 81,
            "hrv_last_night": 58.0,
            "steps": None,
        }
        database.upsert_daily_wellness([first])
        saved1 = database.get_daily_wellness("2026-07-21")
        self.assertEqual(saved1["sleep_total_sec"], 27000)
        self.assertIsNone(saved1["steps"])

        # Second partial update adds steps & RHR without wiping sleep_total_sec
        second = {
            "date": "2026-07-21",
            "source": "garmin",
            "day_status": "complete",
            "sleep_total_sec": None,
            "steps": 8900,
            "resting_hr": 52,
        }
        database.upsert_daily_wellness([second])
        saved2 = database.get_daily_wellness("2026-07-21")
        self.assertEqual(saved2["day_status"], "complete")
        self.assertEqual(saved2["sleep_total_sec"], 27000)
        self.assertEqual(saved2["sleep_score"], 81)
        self.assertEqual(saved2["hrv_last_night"], 58.0)
        self.assertEqual(saved2["steps"], 8900)
        self.assertEqual(saved2["resting_hr"], 52)

        all_rows = database.get_daily_wellness_range("2026-07-21", "2026-07-21")
        self.assertEqual(len(all_rows), 1)

    # 5. Incremental sync skips already complete past days
    def test_incremental_sync_skips_complete_historical_days(self):
        ref = date(2026, 7, 23)
        # Pre-seed 2026-07-22 as complete and 2026-07-21 as partial
        database.upsert_daily_wellness([
            {"date": "2026-07-22", "day_status": "complete", "steps": 10000, "sleep_total_sec": 28000, "hrv_last_night": 60.0},
            {"date": "2026-07-21", "day_status": "partial", "steps": 5000},
        ])

        fetched_dates = []

        def fake_fetch(d_str):
            fetched_dates.append(d_str)
            return {
                "date": d_str,
                "summary": {"totalSteps": 8500, "restingHeartRate": 52, "bodyBatteryHighestValue": 82},
                "sleep": {"dailySleepDTO": {"calendarDate": d_str, "sleepTimeSeconds": 27500}},
                "hrv": {"hrvSummary": {"lastNightAvg": 59.0}},
            }

        with patch("garmin_client.is_garmin_connected", return_value=True), patch(
            "garmin_client.fetch_garmin_daily_wellness_raw", side_effect=fake_fetch
        ):
            res = wellness_engine.sync_wellness_range(days=3, force=False, ref_date=ref)

        self.assertEqual(res["status"], "ok")
        self.assertEqual(res["days_skipped_complete"], 1)
        self.assertIn("2026-07-23", fetched_dates)  # Today always synced
        self.assertIn("2026-07-21", fetched_dates)  # Partial day synced
        self.assertNotIn("2026-07-22", fetched_dates)  # Complete day skipped

    # 6. 7d vs 28d personal baselines & separation of sport steps vs everyday non-sport steps
    def test_baselines_7d_28d_and_non_sport_steps_separation(self):
        ref = date(2026, 7, 23)
        rows = []
        for i in range(14):
            d_str = (ref - timedelta(days=i)).isoformat()
            rows.append({
                "date": d_str,
                "sleep_total_sec": 27000,  # 7.5 h
                "sleep_score": 80,
                "sleep_start_local": f"{d_str}T23:15:00",
                "sleep_end_local": f"{d_str}T06:45:00",
                "steps": 12000,
                "step_goal": 10000,
                "hrv_last_night": 60.0,
                "resting_hr": 52,
                "stress_avg": 28,
                "body_battery_max": 85,
            })
        # Suppose every day in the last 7 days had a 4 km run (~5000 sport steps -> 7000 non-sport steps)
        summaries = [
            {"date": (ref - timedelta(days=i)).isoformat(), "run_km": 4.0, "other_km": 0.0}
            for i in range(7)
        ]
        trends = wellness_engine.compute_wellness_baselines_and_trends(rows, daily_summaries=summaries, ref_date=ref)
        self.assertEqual(trends["sleep"]["avg_hours_7d"], 7.5)
        self.assertEqual(trends["sleep"]["avg_hours_28d"], 7.5)
        self.assertEqual(trends["sleep"]["schedule_regularity_label"], "regular")
        self.assertEqual(trends["mobility"]["avg_steps_7d"], 12000)
        self.assertEqual(trends["mobility"]["avg_non_sport_steps_7d"], 7000)
        self.assertEqual(trends["recovery"]["hrv_baseline_28d"], 60.0)
        self.assertEqual(trends["recovery"]["hrv_personal_band"], "within_personal_range")

    # 7. Daily Readiness Engine: 4 states, low steps never mistaken for physiological fatigue, plan never auto-modified
    def test_readiness_engine_all_four_states_and_low_steps_rule(self):
        ref = date(2026, 7, 23)
        # Base 28d history
        base_rows = [
            {
                "date": (ref - timedelta(days=i)).isoformat(),
                "sleep_total_sec": 27000,
                "sleep_score": 80,
                "steps": 10000,
                "step_goal": 10000,
                "hrv_last_night": 60.0,
                "resting_hr": 52,
                "body_battery_max": 82,
            }
            for i in range(1, 15)
        ]

        # A) DATOS INSUFICIENTES
        empty_today = {"date": ref.isoformat(), "day_status": "pending"}
        trends_empty = wellness_engine.compute_wellness_baselines_and_trends(base_rows, ref_date=ref)
        r_insuff = wellness_engine.evaluate_daily_readiness(empty_today, trends_empty)
        self.assertEqual(r_insuff["estado"], wellness_engine.READINESS_INSUFFICIENT)
        self.assertFalse(r_insuff["sugerencia_plan"]["modificacion_automatica"])

        # B) Low steps day (e.g. 2100 steps on an office day) but good sleep & HRV -> MUST NOT be PRECAUCIÓN / FATIGA
        low_steps_today = {
            "date": ref.isoformat(),
            "day_status": "complete",
            "sleep_total_sec": 28800,  # 8.0 h
            "sleep_score": 86,
            "steps": 2100,  # very low steps
            "step_goal": 10000,
            "hrv_last_night": 63.0,
            "resting_hr": 50,
            "body_battery_max": 90,
        }
        trends_fav = wellness_engine.compute_wellness_baselines_and_trends(base_rows + [low_steps_today], ref_date=ref)
        r_fav = wellness_engine.evaluate_daily_readiness(
            low_steps_today,
            trends_fav,
            planned_day={"type": "Intervalos Runna", "title": "6x800m VO2"},
        )
        self.assertEqual(r_fav["estado"], wellness_engine.READINESS_FAVORABLE)
        self.assertFalse(r_fav["sugerencia_plan"]["modificacion_automatica"])

        # C) ESTADO NORMAL
        normal_today = {
            "date": ref.isoformat(),
            "day_status": "complete",
            "sleep_total_sec": 26500,
            "sleep_score": 74,
            "steps": 8500,
            "hrv_last_night": 59.0,
            "resting_hr": 53,
            "body_battery_max": 72,
        }
        trends_norm = wellness_engine.compute_wellness_baselines_and_trends(base_rows + [normal_today], ref_date=ref)
        r_norm = wellness_engine.evaluate_daily_readiness(normal_today, trends_norm)
        self.assertEqual(r_norm["estado"], wellness_engine.READINESS_NORMAL)

        # D) PRECAUCIÓN / FATIGA (poor sleep + suppressed HRV + elevated RHR + demanding planned workout)
        fatigued_today = {
            "date": ref.isoformat(),
            "day_status": "complete",
            "sleep_total_sec": 18000,  # 5.0 h
            "sleep_score": 52,
            "steps": 9000,
            "hrv_last_night": 44.0,
            "hrv_status": "UNBALANCED",
            "resting_hr": 58,  # +6 bpm vs baseline
            "body_battery_max": 48,
        }
        trends_fat = wellness_engine.compute_wellness_baselines_and_trends(base_rows + [fatigued_today], ref_date=ref)
        r_fat = wellness_engine.evaluate_daily_readiness(
            fatigued_today,
            trends_fat,
            training_load_latest={"ctl": 45.0, "atl": 66.0, "tsb": -21.0},
            planned_day={"type": "Series Umbral", "title": "Series 4x2km"},
        )
        self.assertEqual(r_fat["estado"], wellness_engine.READINESS_CAUTION)
        self.assertEqual(r_fat["sugerencia_plan"]["accion"], "valorar_reduccion_intensidad")
        self.assertFalse(r_fat["sugerencia_plan"]["modificacion_automatica"])

    # 8. AI Coach Wellness interpretation & secret sanitization
    def test_ai_coach_wellness_sanitization_and_interpretation(self):
        dirty_snapshot = {
            "date": "2026-07-23",
            "access_token": "SECRET_TOKEN_123",
            "api_key": "SECRET_KEY_456",
            "readiness": {
                "estado": "RECUPERACIÓN FAVORABLE",
                "datos_faltantes": ["checkin_subjetivo"],
                "recomendacion": "Buen día para mantener la sesión.",
                "sugerencia_plan": {
                    "accion": "mantener_sesion_calidad",
                    "mensaje": "Mantener sesión prevista.",
                    "modificacion_automatica": False,
                },
                "metricas_justificativas": {
                    "aaronfit_calculado": {"tsb_banister_ewma": 4.2},
                },
            },
            "trends_7d_vs_28d": {
                "sleep": {"last_night_hours": 7.8, "avg_hours_7d": 7.5, "avg_hours_28d": 7.4, "last_night_score": 85},
                "mobility": {"today_steps": 9200, "avg_steps_7d": 9500, "avg_steps_28d": 9100},
                "recovery": {
                    "hrv_last_night": 64.0,
                    "hrv_baseline_28d": 60.0,
                    "resting_hr_today": 50,
                    "resting_hr_baseline_28d": 52.0,
                    "body_battery_max_today": 89,
                },
            },
        }
        cleaned = ai_coach.sanitize_snapshot_for_gemini(dirty_snapshot)
        self.assertNotIn("access_token", cleaned)
        self.assertNotIn("api_key", cleaned)

        with patch.dict(os.environ, {"GEMINI_API_KEY": ""}):
            interp = ai_coach.generate_wellness_and_readiness_interpretation(
                dirty_snapshot,
                question="¿Cómo he descansado hoy?",
            )
        self.assertEqual(interp["estado_diario"], "RECUPERACIÓN FAVORABLE")
        self.assertIn("7.8 h", interp["lectura_descanso"])
        self.assertIn("64.0 ms", interp["lectura_recuperacion"])
        self.assertIn("checkin_subjetivo", interp["datos_faltantes"])
        self.assertTrue(len(interp["fuentes_citadas"]) >= 2)

    # 9. All 6 FastAPI endpoints (/api/wellness/*)
    def test_wellness_api_endpoints_end_to_end(self):
        target_date = "2026-07-23"
        database.upsert_daily_wellness([
            {
                "date": target_date,
                "source": "garmin",
                "day_status": "complete",
                "sleep_total_sec": 27900,
                "sleep_score": 83,
                "steps": 10250,
                "step_goal": 10000,
                "hrv_last_night": 61.0,
                "resting_hr": 51,
                "body_battery_max": 86,
            }
        ])

        # 1) POST /api/wellness/checkin
        r_post_chk = self.client.post(
            "/api/wellness/checkin",
            json={
                "date": target_date,
                "energy": 4,
                "sleep_quality": 5,
                "muscle_fatigue": 2,
                "perceived_stress": 2,
                "general_feeling": 4,
                "physical_discomfort": "Ninguna",
                "notes": "Buenas sensaciones al despertar",
            },
        )
        self.assertEqual(r_post_chk.status_code, 200)
        body_chk = r_post_chk.json()
        self.assertEqual(body_chk["checkin"]["energy"], 4)
        self.assertEqual(body_chk["checkin"]["sleep_quality"], 5)

        # 2) GET /api/wellness/checkin
        r_get_chk = self.client.get(f"/api/wellness/checkin?date={target_date}")
        self.assertEqual(r_get_chk.status_code, 200)
        self.assertEqual(r_get_chk.json()["checkin"]["notes"], "Buenas sensaciones al despertar")

        # 3) GET /api/wellness/today
        r_today = self.client.get(f"/api/wellness/today?date={target_date}")
        self.assertEqual(r_today.status_code, 200)
        body_today = r_today.json()
        self.assertEqual(body_today["day_status"], "complete")
        self.assertEqual(body_today["wellness"]["steps"], 10250)
        self.assertIn("readiness", body_today)

        # 4) GET /api/wellness/history
        r_hist = self.client.get(f"/api/wellness/history?days=14&end_date={target_date}")
        self.assertEqual(r_hist.status_code, 200)
        body_hist = r_hist.json()
        self.assertEqual(body_hist["count"], 1)
        self.assertEqual(len(body_hist["checkins"]), 1)

        # 5) GET /api/wellness/readiness
        with patch.dict(os.environ, {"GEMINI_API_KEY": ""}):
            r_ready = self.client.get(f"/api/wellness/readiness?date={target_date}&include_ai=true")
        self.assertEqual(r_ready.status_code, 200)
        body_ready = r_ready.json()
        self.assertIn(
            body_ready["readiness"]["estado"],
            [
                wellness_engine.READINESS_FAVORABLE,
                wellness_engine.READINESS_NORMAL,
                wellness_engine.READINESS_CAUTION,
                wellness_engine.READINESS_INSUFFICIENT,
            ],
        )
        self.assertIsNotNone(body_ready["ai_interpretation"])

        # 6) POST /api/wellness/sync
        with patch("garmin_client.is_garmin_connected", return_value=False):
            r_sync = self.client.post("/api/wellness/sync", json={"days": 7, "end_date": target_date})
        self.assertEqual(r_sync.status_code, 200)
        self.assertEqual(r_sync.json()["sync"]["status"], "not_connected")

    # 10. Phase 5.1 Hardening: Garmin Personal API JWT exp decoding, HTTP 401 token refresh & official endpoints
    def test_10_personal_api_jwt_exp_401_refresh_and_official_endpoints(self):
        import base64
        import json
        import time
        from unittest.mock import MagicMock
        import garmin_client

        # Build a synthetic JWT with real 'exp' claim 6 hours in the future
        future_exp = int(time.time()) + 6 * 3600
        hdr = base64.urlsafe_b64encode(b'{"alg":"HS256"}').decode("ascii").rstrip("=")
        pld = base64.urlsafe_b64encode(json.dumps({"exp": future_exp}).encode("utf-8")).decode("ascii").rstrip("=")
        fake_jwt_1 = f"{hdr}.{pld}.sig1"
        fake_jwt_2 = f"{hdr}.{pld}.sig2"

        self.assertEqual(garmin_client._extract_jwt_expiration(fake_jwt_1), float(future_exp))

        # Simulate HTTP 401 on first GET, then automatic token exchange and 200 OK retry
        post_resp = MagicMock()
        post_resp.status_code = 200
        post_resp.text = json.dumps({"access_token": fake_jwt_2})
        post_resp.json.return_value = {"access_token": fake_jwt_2}

        get_401 = MagicMock()
        get_401.status_code = 401
        get_401.text = "Unauthorized"

        get_200 = MagicMock()
        get_200.status_code = 200
        get_200.text = '{"totalSteps": 9100}'
        get_200.json.return_value = {"totalSteps": 9100}

        garmin_client._personal_token_cache["token"] = fake_jwt_1
        garmin_client._personal_token_cache["expires_at"] = float(future_exp)

        with patch("garmin_client.get_saved_personal_key", return_value="GCDC_TEST_KEY"), patch(
            "garmin_client.requests.post", return_value=post_resp
        ) as mock_post, patch("garmin_client.requests.get", side_effect=[get_401, get_200]) as mock_get:
            resp = garmin_client._personal_api_get("/usersummary-service/usersummary/daily", params={"calendarDate": "2026-07-23"})
            self.assertEqual(resp.status_code, 200)
            self.assertEqual(mock_post.call_count, 1)
            self.assertEqual(mock_get.call_count, 2)
            # Verify second GET used the refreshed JWT
            second_headers = mock_get.call_args_list[1][1]["headers"]
            self.assertEqual(second_headers["Authorization"], f"Bearer {fake_jwt_2}")

    # 11. Phase 5.1 Hardening: No double-counting of correlated autonomic metrics & explicit labeling of estimated steps
    def test_11_no_double_counting_of_correlated_variables_and_estimated_steps(self):
        ref = date(2026, 7, 23)
        base_rows = [
            {
                "date": (ref - timedelta(days=i)).isoformat(),
                "sleep_total_sec": 27000,  # 7.5 h
                "sleep_score": 82,
                "steps": 10000,
                "step_goal": 10000,
                "hrv_last_night": 60.0,
                "resting_hr": 50,
                "body_battery_max": 85,
            }
            for i in range(1, 15)
        ]
        # Today has good sleep (7.8 h, score 84) and high Body Battery (86),
        # but BOTH HRV is low (45 ms) AND RHR is elevated (56 ppm, +6 ppm).
        # Because HRV and RHR belong to the SAME autonomic axis, they must count as ONLY 1 fatigue signal,
        # so the athlete is classified as ESTADO NORMAL (not PRECAUCIÓN / FATIGA).
        today_autonomic_only = {
            "date": ref.isoformat(),
            "day_status": "complete",
            "sleep_total_sec": 28080,  # 7.8 h
            "sleep_score": 84,
            "steps": 9800,
            "step_goal": 10000,
            "hrv_last_night": 45.0,
            "hrv_status": "LOW",
            "resting_hr": 56,
            "body_battery_max": 86,
        }
        summaries = [{"date": ref.isoformat(), "run_km": 5.0, "other_km": 0.0}]
        trends = wellness_engine.compute_wellness_baselines_and_trends(
            base_rows + [today_autonomic_only],
            daily_summaries=summaries,
            ref_date=ref,
        )
        # Verify explicit labeling of estimated non-sport steps vs Garmin real steps
        self.assertEqual(trends["mobility"]["steps_source"], "garmin_real")
        self.assertTrue(trends["mobility"]["non_sport_steps_is_estimated"])
        self.assertEqual(trends["mobility"]["non_sport_steps_source"], "aaronfit_estimated_from_sport_km")

        readiness = wellness_engine.evaluate_daily_readiness(today_autonomic_only, trends)
        self.assertEqual(readiness["estado"], wellness_engine.READINESS_NORMAL)
        self.assertIn("reglas_y_umbrales", readiness)


if __name__ == "__main__":
    unittest.main()
