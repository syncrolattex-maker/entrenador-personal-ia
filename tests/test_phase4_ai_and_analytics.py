"""
tests/test_phase4_ai_and_analytics.py — Comprehensive validation for Phase 3 updates & Phase 4 Gemini AI.
Tests: 6w vs 6w aerobic efficiency, variability band, EWMA rest vs unconfirmed days,
privacy sanitization, full/incomplete/empty data, Gemini error & invalid JSON fallback, and caching.
"""
from datetime import date, timedelta
import json
import sys
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import analytics_engine as ae
import ai_coach


def _run(d: date, km: float, dur: float, hr: int, elev: float = 20.0):
    return {
        "external_id": f"id_{d.isoformat()}",
        "sport_type": "Carrera",
        "name": f"Run {d.isoformat()}",
        "start_date": d.isoformat(),
        "distance_km": km,
        "duration_min": dur,
        "elevation_gain": elev,
        "avg_hr": hr,
        "relative_effort": dur * 1.3,
    }


def test_6w_efficiency_and_variability_band():
    ref = date(2026, 11, 25)
    # Within ±2.5% band (1.1745 vs 1.1741 -> ~0.0% -> stable, NOT confirmed improvement)
    acts = [
        _run(ref - timedelta(days=5), 8.0, 44.0, 150),
        _run(ref - timedelta(days=15), 8.0, 44.0, 150),
        _run(ref - timedelta(days=25), 8.0, 44.0, 150),
        _run(ref - timedelta(days=48), 8.0, 44.3, 150),
        _run(ref - timedelta(days=58), 8.0, 44.3, 150),
        _run(ref - timedelta(days=68), 8.0, 44.3, 150),
    ]
    res = ae.compute_aerobic_efficiency(acts, ref_date=ref)
    assert res["status"] == "ok"
    assert res["window_days"] == {"recent": 42, "baseline": 42}
    assert res["is_official_garmin_metric"] is False
    assert "variabilidad normal" in res["conclusion"].lower()


def test_ewma_rest_vs_unconfirmed_days():
    ref = date(2026, 11, 25)
    # Earliest confirmed activity is 20 days ago -> days before that are unconfirmed_no_data, days after without activity are rest
    ds = [
        {"date": (ref - timedelta(days=20)).isoformat(), "relative_effort": 100.0, "total_min": 60.0, "activities_count": 1},
        {"date": (ref - timedelta(days=10)).isoformat(), "relative_effort": 100.0, "total_min": 60.0, "activities_count": 1},
    ]
    ewma = ae.compute_training_load_ewma(ds, ref_date=ref, output_days=30)
    statuses = [p["day_status"] for p in ewma["curve"]]
    assert "unconfirmed_no_data" in statuses
    assert "rest" in statuses
    assert "active" in statuses
    assert ewma["unconfirmed_days"] > 0 and ewma["confirmed_rest_days"] > 0
    # During rest days at the end, ATL decays faster than CTL so TSB rises
    assert ewma["curve"][-1]["tsb"] > ewma["curve"][-10]["tsb"]


def test_privacy_sanitization_strips_forbidden_keys():
    dirty = {
        "reference_date": "2026-11-25",
        "polyline": [[39.4, -0.4]],
        "lat": 39.4,
        "lon": -0.4,
        "password": "secret",
        "token": "abc",
        "private_notes": "dolor rodilla",
        "raw_payload": {"anything": 1},
        "nested": {"email": "test@example.com", "safe_metric": 42},
    }
    clean = ai_coach.sanitize_snapshot_for_gemini(dirty)
    s = json.dumps(clean)
    for bad in ("polyline", "39.4", "password", "token", "private_notes", "raw_payload", "email"):
        assert bad not in s, f"Forbidden key/value leaked: {bad}"
    assert clean["nested"]["safe_metric"] == 42


def test_ai_empty_incomplete_error_and_invalid_json():
    # 1. Zero activity
    empty_snap = ae.build_ai_ready_analytics_snapshot([], [], [], ref_date=date(2026, 11, 25))
    res_empty = ai_coach.generate_analytics_interpretation(empty_snap, use_cache=False)
    assert res_empty["datos_insuficientes"] is True
    assert res_empty["source_mode"] == "insufficient_data"

    # 2. Realistic snapshot with Gemini error -> clean fallback
    ref = date(2026, 11, 25)
    acts = [_run(ref - timedelta(days=i * 3), 8.0, 42.0, 150) for i in range(8)]
    ds = [{"date": a["start_date"], "relative_effort": a["relative_effort"], "total_min": a["duration_min"], "activities_count": 1} for a in acts]
    snap = ae.build_ai_ready_analytics_snapshot(acts, ds, [], ref_date=ref)

    with patch.dict("os.environ", {"GEMINI_API_KEY": "fake_key"}):
        with patch.object(ai_coach.genai, "Client", side_effect=RuntimeError("API timeout")):
            res_err = ai_coach.generate_analytics_interpretation(snap, use_cache=False)
            assert res_err["source_mode"] == "deterministic_fallback_on_error"
            assert "resumen_estado_deportivo" in res_err and "carga" in res_err

        # 3. Invalid JSON from Gemini -> clean fallback
        bad_resp = MagicMock()
        bad_resp.text = "NOT VALID JSON {"
        mock_client = MagicMock()
        mock_client.models.generate_content.return_value = bad_resp
        with patch.object(ai_coach.genai, "Client", return_value=mock_client):
            res_bad = ai_coach.generate_analytics_interpretation(snap, use_cache=False)
            assert res_bad["source_mode"] == "deterministic_fallback_on_error"

        # 4. Valid structured JSON from Gemini + cache hit
        good_payload = {
            "resumen_estado_deportivo": "Evolución constante con 8 sesiones analizadas.",
            "evolucion": "Volumen estable en el periodo.",
            "eficiencia": "Muestra insuficiente para comparar 6 semanas.",
            "carga": "CTL y ATL calculados por AaronFit.",
            "puntos_fuertes": ["Constancia"],
            "aspectos_a_mejorar": ["Sumar 3 sesiones comparables más"],
            "conclusion": "Buen bloque base.",
            "periodos_evaluados": ["Últimas 6 semanas"],
            "indicadores_utilizados": ["Distancia", "CTL/ATL/TSB"],
            "datos_insuficientes": False,
        }
        good_resp = MagicMock()
        good_resp.text = json.dumps(good_payload)
        mock_client.models.generate_content.return_value = good_resp
        with patch.object(ai_coach.genai, "Client", return_value=mock_client):
            t0 = time.time()
            res_ok = ai_coach.generate_analytics_interpretation(snap, use_cache=True)
            t1 = time.time()
            res_cached = ai_coach.generate_analytics_interpretation(snap, use_cache=True)
            t2 = time.time()
            assert res_ok["source_mode"] == "gemini_live"
            assert res_cached == res_ok
            assert (t2 - t1) < 0.01  # instant cache hit


import unittest


class TestPhase4AiAndAnalytics(unittest.TestCase):
    def test_1_6w_efficiency_and_variability_band(self):
        test_6w_efficiency_and_variability_band()

    def test_2_ewma_rest_vs_unconfirmed_days(self):
        test_ewma_rest_vs_unconfirmed_days()

    def test_3_privacy_sanitization_strips_forbidden_keys(self):
        test_privacy_sanitization_strips_forbidden_keys()

    def test_4_ai_empty_incomplete_error_and_invalid_json(self):
        test_ai_empty_incomplete_error_and_invalid_json()


if __name__ == "__main__":
    unittest.main()
