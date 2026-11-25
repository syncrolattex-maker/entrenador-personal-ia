"""
tests/test_analytics_engine.py — Unit tests for Phase 3 Analytics Engine.
Covers: period comparisons, training load EWMA, aerobic efficiency, HR zone distribution,
summary consistency, incomplete data, missing data, and insufficient sample guards.
"""
from datetime import date, timedelta
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import analytics_engine as ae


def _make_run(d: date, km: float, dur_min: float, avg_hr: int, elev: float = 20.0, re: float = 70.0):
    return {
        "external_id": f"r_{d.isoformat()}",
        "sport_type": "Carrera",
        "name": f"Run {d.isoformat()}",
        "start_date": d.isoformat(),
        "distance_km": km,
        "duration_min": dur_min,
        "elevation_gain": elev,
        "elevation_loss": elev * 0.9,
        "avg_hr": avg_hr,
        "max_hr": avg_hr + 15,
        "relative_effort": re,
    }


def test_period_comparisons_and_custom_range():
    ref = date(2026, 11, 25)
    acts = [
        _make_run(date(2026, 11, 24), 10.0, 50.0, 150),
        _make_run(date(2026, 11, 18), 8.0, 42.0, 152),
        _make_run(date(2026, 10, 15), 12.0, 62.0, 154),
        _make_run(date(2026, 6, 10), 15.0, 80.0, 155),
    ]
    comps = ae.build_standard_comparisons(acts, ref_date=ref)
    assert comps["week"]["current"]["distance_km"] == 10.0
    assert comps["week"]["previous"]["distance_km"] == 8.0
    assert comps["week"]["deltas"]["distance_pct"] == 25.0
    assert comps["month"]["current"]["distance_km"] == 18.0
    assert comps["month"]["previous"]["distance_km"] == 12.0
    assert comps["months_6"]["current"]["activities_count"] == 4

    custom = ae.compare_periods(acts, "2026-11-01", "2026-11-30", "2026-10-01", "2026-10-31", "Nov vs Oct")
    assert custom["sample_quality"] == "reliable"
    assert custom["deltas"]["distance_km_diff"] == 6.0


def test_aerobic_efficiency_improvement_and_insufficient_sample():
    ref = date(2026, 11, 25)
    # Insufficient sample (< 3 runs in baseline)
    few = [
        _make_run(ref - timedelta(days=5), 8.0, 40.0, 150),
        _make_run(ref - timedelta(days=10), 8.0, 40.0, 150),
    ]
    res_insuff = ae.compute_aerobic_efficiency(few, ref_date=ref)
    assert res_insuff["status"] == "insufficient_sample"
    assert res_insuff["ef_change_pct"] is None

    # Clear improvement at identical HR (5:00/km vs 5:30/km at 150 bpm)
    acts = [
        _make_run(ref - timedelta(days=5), 10.0, 50.0, 150, elev=30.0),
        _make_run(ref - timedelta(days=12), 10.0, 50.0, 150, elev=30.0),
        _make_run(ref - timedelta(days=20), 10.0, 50.0, 150, elev=30.0),
        _make_run(ref - timedelta(days=50), 10.0, 55.0, 150, elev=30.0),
        _make_run(ref - timedelta(days=60), 10.0, 55.0, 150, elev=30.0),
        _make_run(ref - timedelta(days=75), 10.0, 55.0, 150, elev=30.0),
        # Hilly trail run should be excluded (> 25 m/km)
        _make_run(ref - timedelta(days=7), 10.0, 75.0, 165, elev=600.0),
    ]
    res_ok = ae.compute_aerobic_efficiency(acts, ref_date=ref)
    assert res_ok["status"] == "ok"
    assert res_ok["comparable"] is True
    assert res_ok["recent_period"]["count"] == 3
    assert res_ok["ef_change_pct"] > 5.0


def test_training_load_ewma_zero_seed_and_insufficient():
    ref = date(2026, 11, 25)
    # Empty data -> starts at 0.0, never 18.0
    empty_res = ae.compute_training_load_ewma([], ref_date=ref)
    assert empty_res["latest"]["ctl"] == 0.0
    assert empty_res["latest"]["atl"] == 0.0
    assert empty_res["sample_quality"] == "insufficient"
    assert empty_res["is_official_garmin_metric"] is False

    # 30 active days -> high quality
    ds = [
        {"date": (ref - timedelta(days=i)).isoformat(), "relative_effort": 80.0, "total_min": 45.0, "activities_count": 1}
        for i in range(30)
    ]
    res = ae.compute_training_load_ewma(ds, ref_date=ref)
    assert res["sample_quality"] == "high"
    assert res["latest"]["ctl"] > 0.0 and res["latest"]["atl"] > res["latest"]["ctl"]


def test_hr_zones_100_percent_and_incomplete_data():
    empty_hz = ae.compute_hr_zone_distribution([])
    assert empty_hz["status"] == "unavailable"

    rows = [
        {"hr_zones_json": json.dumps([{"pct": 10}, {"pct": 40}, {"pct": 30}, {"pct": 15}, {"pct": 5}])},
        {"hr_zones_json": json.dumps([{"pct": 20}, {"pct": 33}, {"pct": 27}, {"pct": 15}, {"pct": 5}])},
        {"hr_zones_json": "invalid-json"},
    ]
    hz = ae.compute_hr_zone_distribution(rows)
    assert hz["status"] == "ok"
    assert hz["activities_with_zones"] == 2
    assert sum(z["pct"] for z in hz["zones"]) == 100


def test_incomplete_activities_and_snapshot():
    ref = date(2026, 11, 25)
    incomplete = [
        {"external_id": "inc1", "sport_type": "Fuerza", "start_date": ref.isoformat(), "distance_km": 0, "duration_min": 30, "avg_hr": None},
        {"external_id": "inc2", "sport_type": "Carrera", "start_date": ref.isoformat(), "distance_km": 5.0, "duration_min": 25, "avg_hr": 999},
    ]
    summary = ae.summarize_activities_period(incomplete, ref.isoformat(), ref.isoformat())
    assert summary["activities_count"] == 2
    assert summary["avg_hr"] is None  # anomalous 999 rejected
    snap = ae.build_ai_ready_analytics_snapshot(incomplete, [], [], ref_date=ref)
    assert "metric_catalog" in snap and "aerobic_efficiency" in snap["metric_catalog"]


if __name__ == "__main__":
    test_period_comparisons_and_custom_range()
    test_aerobic_efficiency_improvement_and_insufficient_sample()
    test_training_load_ewma_zero_seed_and_insufficient()
    test_hr_zones_100_percent_and_incomplete_data()
    test_incomplete_activities_and_snapshot()
    print("ALL_ANALYTICS_ENGINE_TESTS_OK")
