"""
wellness_engine.py — Fase 5: Wellness, Daily Activity & Readiness Engine for AaronFit.

Responsibilities:
- Normalize Garmin daily wellness payloads (Sleep, Steps/Mobility, HRV, RHR, Stress, Body Battery, SpO2, Respiration).
- Associate overnight sleep strictly with the local calendar date on which the sleep ends.
- Never invent missing metrics or treat None/missing values as zero.
- Separate daily non-sport mobility from registered sport activities.
- Compute 7-day and 28-day personal baselines and trends.
- Evaluate Daily Readiness into 4 explainable states:
    1. RECUPERACIÓN FAVORABLE
    2. ESTADO NORMAL
    3. PRECAUCIÓN / FATIGA
    4. DATOS INSUFICIENTES
- Suggest non-destructive training plan adaptations without auto-modifying the plan.
- Build a sanitized, structured snapshot for Gemini AI (ai_coach.py).
"""
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple
import math


READINESS_FAVORABLE = "RECUPERACIÓN FAVORABLE"
READINESS_NORMAL = "ESTADO NORMAL"
READINESS_CAUTION = "PRECAUCIÓN / FATIGA"
READINESS_INSUFFICIENT = "DATOS INSUFICIENTES"

DAY_STATUS_COMPLETE = "complete"
DAY_STATUS_PARTIAL = "partial"
DAY_STATUS_PENDING = "pending"
DAY_STATUS_UNAVAILABLE = "unavailable"
DAY_STATUS_ERROR = "sync_error"


def _safe_int(val: Any, min_val: Optional[int] = None, max_val: Optional[int] = None) -> Optional[int]:
    if val is None or val == "":
        return None
    try:
        iv = int(round(float(val)))
        if min_val is not None and iv < min_val:
            return None
        if max_val is not None and iv > max_val:
            return None
        return iv
    except Exception:
        return None


def _safe_float(val: Any, min_val: Optional[float] = None, max_val: Optional[float] = None, digits: int = 2) -> Optional[float]:
    if val is None or val == "":
        return None
    try:
        fv = float(val)
        if math.isnan(fv) or math.isinf(fv):
            return None
        if min_val is not None and fv < min_val:
            return None
        if max_val is not None and fv > max_val:
            return None
        return round(fv, digits)
    except Exception:
        return None


def _ts_to_local_iso(ts_val: Any) -> Optional[str]:
    """Converts Garmin epoch milliseconds (or ISO string) into an ISO local datetime string YYYY-MM-DDTHH:MM:SS."""
    if ts_val is None or ts_val == "":
        return None
    if isinstance(ts_val, str):
        clean = ts_val.strip()
        if "T" in clean or "-" in clean:
            return clean[:19]
        try:
            ts_val = float(clean)
        except Exception:
            return None
    try:
        num = float(ts_val)
        if num > 1e11:  # milliseconds
            num = num / 1000.0
        if num <= 0:
            return None
        dt = datetime.fromtimestamp(num, tz=timezone.utc)
        return dt.strftime("%Y-%m-%dT%H:%M:%S")
    except Exception:
        return None


def _clock_minutes_from_iso(iso_str: Optional[str]) -> Optional[int]:
    """Returns minutes from midnight (wrapped around midnight for bedtime regularity) from YYYY-MM-DDTHH:MM:SS."""
    if not iso_str or "T" not in iso_str:
        return None
    try:
        time_part = iso_str.split("T")[1]
        hh, mm = int(time_part[0:2]), int(time_part[3:5])
        mins = hh * 60 + mm
        # Wrap late-night hours (e.g. 22:00..23:59) relative to midnight so 23:30 and 00:15 are 45 min apart
        if mins >= 18 * 60:
            mins -= 24 * 60
        return mins
    except Exception:
        return None


def _mean(vals: List[float]) -> Optional[float]:
    if not vals:
        return None
    return sum(vals) / len(vals)


def _std(vals: List[float]) -> Optional[float]:
    if len(vals) < 2:
        return None
    m = sum(vals) / len(vals)
    var = sum((x - m) ** 2 for x in vals) / len(vals)
    return math.sqrt(var)


# ==============================================================================
# 2.1 — SLEEP NORMALIZATION
# ==============================================================================

def normalize_garmin_sleep(raw_sleep: Any, fallback_date: str) -> Dict[str, Any]:
    """
    Normalizes Garmin sleep payload (supports official Personal API /sleep-service/sleep/dailySleep,
    /sleep-service/sleep/dailySleepSummariesByDate, and legacy /wellness-service/wellness/dailySleepData).
    Associates overnight sleep strictly with the local date on which the sleep ends.
    Never invents a sleep score if Garmin does not provide one.
    """
    if not raw_sleep:
        return {}
    if isinstance(raw_sleep, list) and raw_sleep and isinstance(raw_sleep[0], dict):
        raw_sleep = raw_sleep[0]
    if not isinstance(raw_sleep, dict):
        return {}

    if isinstance(raw_sleep.get("dailySleepDTO"), dict):
        dto = raw_sleep["dailySleepDTO"]
    elif isinstance(raw_sleep.get("dailySleepSummaries"), list) and raw_sleep["dailySleepSummaries"]:
        dto = raw_sleep["dailySleepSummaries"][0] if isinstance(raw_sleep["dailySleepSummaries"][0], dict) else {}
    else:
        dto = raw_sleep
    if not isinstance(dto, dict):
        return {}

    sleep_total_sec = _safe_int(dto.get("sleepTimeSeconds"), min_val=1)
    deep_sec = _safe_int(dto.get("deepSleepSeconds"), min_val=0)
    light_sec = _safe_int(dto.get("lightSleepSeconds"), min_val=0)
    rem_sec = _safe_int(dto.get("remSleepSeconds"), min_val=0)
    awake_sec = _safe_int(dto.get("awakeSleepSeconds"), min_val=0)
    interruptions = _safe_int(dto.get("awakeCount"), min_val=0)

    nap_sec = _safe_int(dto.get("napTimeSeconds"), min_val=0)
    if nap_sec is None and isinstance(raw_sleep.get("dailyNapDTOs"), list):
        nap_sum = sum(_safe_int(n.get("napTimeSeconds"), min_val=0) or 0 for n in raw_sleep["dailyNapDTOs"] if isinstance(n, dict))
        nap_sec = nap_sum if nap_sum > 0 else None

    start_iso = _ts_to_local_iso(dto.get("sleepStartTimestampLocal") or dto.get("sleepStartTimestampGMT"))
    end_iso = _ts_to_local_iso(dto.get("sleepEndTimestampLocal") or dto.get("sleepEndTimestampGMT"))

    # Associate sleep with wake-up local date (or calendarDate from Garmin)
    sleep_date = str(dto.get("calendarDate") or (end_iso[:10] if end_iso else fallback_date))[:10]

    time_in_bed_sec: Optional[int] = None
    if dto.get("sleepStartTimestampLocal") and dto.get("sleepEndTimestampLocal"):
        try:
            diff_ms = float(dto["sleepEndTimestampLocal"]) - float(dto["sleepStartTimestampLocal"])
            if diff_ms > 0:
                time_in_bed_sec = int(round(diff_ms / 1000.0))
        except Exception:
            pass
    if time_in_bed_sec is None and sleep_total_sec is not None and awake_sec is not None:
        time_in_bed_sec = sleep_total_sec + awake_sec

    # Official Garmin sleep score ONLY (never fabricated)
    scores = dto.get("sleepScores") or {}
    overall = (scores.get("overall") if isinstance(scores, dict) else None) or {}
    sleep_score = _safe_int(overall.get("value") if isinstance(overall, dict) else dto.get("sleepScore"), min_val=1, max_val=100)

    spo2 = _safe_float(dto.get("averageSpO2Value"), min_val=70.0, max_val=100.0, digits=1)
    resp = _safe_float(dto.get("averageRespirationValue"), min_val=5.0, max_val=40.0, digits=1)

    return {
        "sleep_date": sleep_date,
        "sleep_total_sec": sleep_total_sec,
        "sleep_start_local": start_iso,
        "sleep_end_local": end_iso,
        "time_in_bed_sec": time_in_bed_sec,
        "sleep_score": sleep_score,
        "deep_sleep_sec": deep_sec,
        "light_sleep_sec": light_sec,
        "rem_sleep_sec": rem_sec,
        "awake_sec": awake_sec,
        "interruptions_count": interruptions,
        "nap_sec": nap_sec,
        "sleep_spo2_avg": spo2,
        "sleep_respiration_avg": resp,
    }


# ==============================================================================
# 2.2 & 2.3 — MOBILITY & RECOVERY NORMALIZATION
# ==============================================================================

def normalize_garmin_daily_bundle(
    bundle: Dict[str, Any],
    target_date: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Normalizes a raw Garmin daily bundle {date, summary, sleep, hrv, body_battery, stress}
    into a clean daily_wellness record.
    Missing metrics remain None (never 0).
    """
    d_str = str(target_date or bundle.get("date") or date.today().isoformat())[:10]
    raw_sum = bundle.get("summary")
    if isinstance(raw_sum, list) and raw_sum and isinstance(raw_sum[0], dict):
        summary = raw_sum[0]
    elif isinstance(raw_sum, dict) and isinstance(raw_sum.get("dailySummaries"), list) and raw_sum["dailySummaries"]:
        summary = raw_sum["dailySummaries"][0] if isinstance(raw_sum["dailySummaries"][0], dict) else raw_sum
    else:
        summary = raw_sum if isinstance(raw_sum, dict) else {}

    hrv_raw = bundle.get("hrv") if isinstance(bundle.get("hrv"), dict) else {}
    bb_raw = bundle.get("body_battery")
    raw_stress = bundle.get("stress")
    if isinstance(raw_stress, list) and raw_stress and isinstance(raw_stress[0], dict):
        stress_raw = raw_stress[0]
    else:
        stress_raw = raw_stress if isinstance(raw_stress, dict) else {}
    stress_vals_obj = stress_raw.get("values") if isinstance(stress_raw.get("values"), dict) else {}
    daily_hr_raw = bundle.get("daily_hr") if isinstance(bundle.get("daily_hr"), dict) else {}
    spo2_raw = bundle.get("spo2") if isinstance(bundle.get("spo2"), dict) else {}

    sleep_norm = normalize_garmin_sleep(bundle.get("sleep"), d_str)
    effective_date = sleep_norm.get("sleep_date") or str(summary.get("calendarDate") or d_str)[:10]

    # Steps & Mobility (treat negative sentinel values or missing keys as None)
    steps = _safe_int(summary.get("totalSteps"), min_val=0)
    step_goal = _safe_int(summary.get("dailyStepGoal"), min_val=1)
    dist_m = _safe_float(summary.get("totalDistanceMeters"), min_val=0.0, digits=1)
    floors = _safe_float(summary.get("floorsAscended"), min_val=0.0, digits=1)
    mod_min = _safe_int(summary.get("moderateIntensityMinutes"), min_val=0)
    vig_min = _safe_int(summary.get("vigorousIntensityMinutes"), min_val=0)
    act_cal = _safe_int(summary.get("activeKilocalories"), min_val=0)
    tot_cal = _safe_int(summary.get("totalKilocalories"), min_val=0)
    sed_sec = _safe_int(summary.get("sedentarySeconds"), min_val=0)

    # HRV (supports /hrv-service/hrv/{date} and /hrv-service/hrv/daily/{from}/{to})
    if isinstance(hrv_raw.get("hrvSummary"), dict):
        hrv_sum = hrv_raw["hrvSummary"]
    elif isinstance(hrv_raw.get("hrvSummaries"), list) and hrv_raw["hrvSummaries"] and isinstance(hrv_raw["hrvSummaries"][0], dict):
        hrv_sum = hrv_raw["hrvSummaries"][0]
    else:
        hrv_sum = hrv_raw
    hrv_last = _safe_float(hrv_sum.get("lastNightAvg") if isinstance(hrv_sum, dict) else None, min_val=5.0, max_val=300.0, digits=1)
    hrv_wk = _safe_float(hrv_sum.get("weeklyAvg") if isinstance(hrv_sum, dict) else None, min_val=5.0, max_val=300.0, digits=1)
    hrv_status = str(hrv_sum.get("status")).strip() if (isinstance(hrv_sum, dict) and hrv_sum.get("status")) else None

    # Heart Rate & Stress (Garmin often uses -1 for unmeasured stress; min_val=1 filters it out)
    rhr = _safe_int(
        summary.get("restingHeartRate")
        or summary.get("currentDayRestingHeartRate")
        or daily_hr_raw.get("restingHeartRate"),
        min_val=25,
        max_val=150,
    )
    avg_hr = _safe_int(summary.get("averageHeartRate"), min_val=30, max_val=220)
    if avg_hr is None and summary.get("minAvgHeartRate") and summary.get("maxAvgHeartRate"):
        avg_hr = _safe_int((float(summary["minAvgHeartRate"]) + float(summary["maxAvgHeartRate"])) / 2.0, min_val=30, max_val=220)

    stress_avg = _safe_int(
        summary.get("averageStressLevel")
        or stress_raw.get("avgStressLevel")
        or stress_raw.get("overallStressLevel")
        or stress_vals_obj.get("overallStressLevel"),
        min_val=1,
        max_val=100,
    )
    stress_max = _safe_int(
        summary.get("maxStressLevel")
        or stress_raw.get("maxStressLevel")
        or stress_vals_obj.get("maxStressLevel"),
        min_val=1,
        max_val=100,
    )

    # Body Battery
    bb_dict = bb_raw[0] if (isinstance(bb_raw, list) and bb_raw and isinstance(bb_raw[0], dict)) else (bb_raw if isinstance(bb_raw, dict) else {})
    bb_recent = _safe_int(summary.get("bodyBatteryMostRecentValue") or bb_dict.get("mostRecentValue"), min_val=1, max_val=100)
    bb_max = _safe_int(summary.get("bodyBatteryHighestValue") or bb_dict.get("highestValue"), min_val=1, max_val=100)
    bb_min = _safe_int(summary.get("bodyBatteryLowestValue") or bb_dict.get("lowestValue"), min_val=1, max_val=100)
    bb_charged = _safe_int(summary.get("bodyBatteryChargedValue") or bb_dict.get("charged"), min_val=0, max_val=100)
    bb_drained = _safe_int(summary.get("bodyBatteryDrainedValue") or bb_dict.get("drained"), min_val=0, max_val=100)

    if (bb_max is None or bb_min is None) and isinstance(bb_dict.get("bodyBatteryValuesArray"), list):
        bb_vals = [
            _safe_int(pt[1], min_val=1, max_val=100)
            for pt in bb_dict["bodyBatteryValuesArray"]
            if isinstance(pt, (list, tuple)) and len(pt) >= 2
        ]
        bb_vals_clean = [v for v in bb_vals if v is not None]
        if bb_vals_clean:
            if bb_max is None:
                bb_max = max(bb_vals_clean)
            if bb_min is None:
                bb_min = min(bb_vals_clean)
            if bb_recent is None:
                bb_recent = bb_vals_clean[-1]

    # Respiration & SpO2
    resp_avg = _safe_float(summary.get("avgWakingRespirationValue") or sleep_norm.get("sleep_respiration_avg"), min_val=5.0, max_val=40.0, digits=1)
    spo2_avg = _safe_float(
        summary.get("averageSpo2")
        or sleep_norm.get("sleep_spo2_avg")
        or spo2_raw.get("averageSpO2")
        or spo2_raw.get("averageSpo2"),
        min_val=70.0,
        max_val=100.0,
        digits=1,
    )

    has_sleep = sleep_norm.get("sleep_total_sec") is not None or sleep_norm.get("sleep_score") is not None
    has_mobility = steps is not None
    has_recovery = any(x is not None for x in (hrv_last, rhr, bb_max, bb_charged, stress_avg))

    blocks_present = sum([1 if has_sleep else 0, 1 if has_mobility else 0, 1 if has_recovery else 0])
    is_today = (effective_date == date.today().isoformat())
    errors = bundle.get("errors") or []

    if blocks_present == 3 and not is_today:
        day_status = DAY_STATUS_COMPLETE
    elif blocks_present >= 1:
        day_status = DAY_STATUS_PARTIAL
    elif errors and not bundle.get("auth_method"):
        day_status = DAY_STATUS_ERROR
    elif is_today:
        day_status = DAY_STATUS_PENDING
    elif errors:
        day_status = DAY_STATUS_ERROR
    else:
        day_status = DAY_STATUS_UNAVAILABLE

    auth_src = bundle.get("auth_method") or "garmin_connect"
    ep_used = bundle.get("endpoints_used") if isinstance(bundle.get("endpoints_used"), dict) else {}
    sources = {
        "sleep": (ep_used.get("sleep") or auth_src) if has_sleep else None,
        "mobility": (ep_used.get("summary") or auth_src) if has_mobility else None,
        "recovery": (ep_used.get("hrv") or ep_used.get("body_battery") or ep_used.get("summary") or auth_src) if has_recovery else None,
        "endpoints_used": ep_used,
    }
    data_quality = {
        "has_sleep": has_sleep,
        "has_mobility": has_mobility,
        "has_recovery": has_recovery,
        "blocks_present": blocks_present,
        "errors_count": len(errors),
    }

    return {
        "date": effective_date,
        "timezone": "Europe/Madrid",
        "sleep_total_sec": sleep_norm.get("sleep_total_sec"),
        "sleep_start_local": sleep_norm.get("sleep_start_local"),
        "sleep_end_local": sleep_norm.get("sleep_end_local"),
        "time_in_bed_sec": sleep_norm.get("time_in_bed_sec"),
        "sleep_score": sleep_norm.get("sleep_score"),
        "deep_sleep_sec": sleep_norm.get("deep_sleep_sec"),
        "light_sleep_sec": sleep_norm.get("light_sleep_sec"),
        "rem_sleep_sec": sleep_norm.get("rem_sleep_sec"),
        "awake_sec": sleep_norm.get("awake_sec"),
        "interruptions_count": sleep_norm.get("interruptions_count"),
        "nap_sec": sleep_norm.get("nap_sec"),
        "steps": steps,
        "step_goal": step_goal,
        "steps_distance_m": dist_m,
        "floors_climbed": floors,
        "moderate_intensity_min": mod_min,
        "vigorous_intensity_min": vig_min,
        "active_calories": act_cal,
        "total_calories": tot_cal,
        "sedentary_sec": sed_sec,
        "hrv_last_night": hrv_last,
        "hrv_weekly_avg": hrv_wk,
        "hrv_status": hrv_status,
        "resting_hr": rhr,
        "avg_hr": avg_hr,
        "stress_avg": stress_avg,
        "stress_max": stress_max,
        "body_battery_most_recent": bb_recent,
        "body_battery_max": bb_max,
        "body_battery_min": bb_min,
        "body_battery_charged": bb_charged,
        "body_battery_drained": bb_drained,
        "respiration_avg": resp_avg,
        "spo2_avg": spo2_avg,
        "day_status": day_status,
        "data_quality": data_quality,
        "sources": sources,
    }


# ==============================================================================
# PERSONAL BASELINES & TRENDS (7 DAYS vs 28 DAYS)
# ==============================================================================

def compute_wellness_baselines_and_trends(
    wellness_rows: List[Dict[str, Any]],
    daily_summaries: Optional[List[Dict[str, Any]]] = None,
    ref_date: Optional[date] = None,
) -> Dict[str, Any]:
    """
    Computes 7-day and 28-day personal baselines and trends for Sleep, Mobility, and Recovery.
    Distinguishes everyday non-sport steps from registered running/walking activities.
    Never treats None as 0.
    """
    today = ref_date or date.today()
    d_7 = (today - timedelta(days=6)).isoformat()
    d_14 = (today - timedelta(days=13)).isoformat()
    d_28 = (today - timedelta(days=27)).isoformat()
    today_iso = today.isoformat()

    rows_sorted = sorted(
        [r for r in (wellness_rows or []) if r.get("date") and str(r["date"])[:10] <= today_iso],
        key=lambda x: str(x["date"])[:10],
    )
    w7 = [r for r in rows_sorted if str(r["date"])[:10] >= d_7]
    w_prev7 = [r for r in rows_sorted if d_14 <= str(r["date"])[:10] < d_7]
    w28 = [r for r in rows_sorted if str(r["date"])[:10] >= d_28]
    latest = rows_sorted[-1] if rows_sorted else {}

    # Map registered sport distance by date to separate sport steps vs everyday mobility steps
    sport_run_km_by_date: Dict[str, float] = {}
    for s in (daily_summaries or []):
        sd = str(s.get("date") or "")[:10]
        if sd:
            sport_run_km_by_date[sd] = float(s.get("run_km") or 0.0) + float(s.get("other_km") or 0.0)

    # --- 1. SLEEP ---
    slp_7 = [float(r["sleep_total_sec"]) / 3600.0 for r in w7 if r.get("sleep_total_sec") is not None and float(r["sleep_total_sec"]) > 0]
    slp_28 = [float(r["sleep_total_sec"]) / 3600.0 for r in w28 if r.get("sleep_total_sec") is not None and float(r["sleep_total_sec"]) > 0]
    scr_7 = [float(r["sleep_score"]) for r in w7 if r.get("sleep_score") is not None]
    scr_28 = [float(r["sleep_score"]) for r in w28 if r.get("sleep_score") is not None]

    bed_mins_7 = [_clock_minutes_from_iso(r.get("sleep_start_local")) for r in w7]
    bed_mins_valid = [float(m) for m in bed_mins_7 if m is not None]
    wake_mins_7 = [_clock_minutes_from_iso(r.get("sleep_end_local")) for r in w7]
    wake_mins_valid = [float(m) for m in wake_mins_7 if m is not None]

    bed_std = _std(bed_mins_valid)
    wake_std = _std(wake_mins_valid)
    reg_std_min = round(bed_std if bed_std is not None else (wake_std or 0.0), 1) if (bed_std is not None or wake_std is not None) else None
    if reg_std_min is None:
        regularity_label = "insufficient_data"
    elif reg_std_min <= 35.0:
        regularity_label = "regular"
    elif reg_std_min <= 65.0:
        regularity_label = "moderate"
    else:
        regularity_label = "irregular"

    avg_slp_7 = round(_mean(slp_7), 2) if slp_7 else None
    avg_slp_28 = round(_mean(slp_28), 2) if slp_28 else None
    last_slp_h = round(float(latest["sleep_total_sec"]) / 3600.0, 2) if latest.get("sleep_total_sec") else None
    slp_diff_vs_28 = round(last_slp_h - avg_slp_28, 2) if (last_slp_h is not None and avg_slp_28 is not None) else None

    avg_scr_7 = round(_mean(scr_7), 1) if scr_7 else None
    avg_scr_28 = round(_mean(scr_28), 1) if scr_28 else None
    if avg_scr_7 is not None and avg_scr_28 is not None and len(scr_28) >= 4:
        sleep_quality_trend = "improving" if (avg_scr_7 - avg_scr_28) >= 3.0 else ("declining" if (avg_scr_7 - avg_scr_28) <= -3.0 else "stable")
    elif avg_slp_7 is not None and avg_slp_28 is not None and len(slp_28) >= 4:
        sleep_quality_trend = "improving" if (avg_slp_7 - avg_slp_28) >= 0.35 else ("declining" if (avg_slp_7 - avg_slp_28) <= -0.35 else "stable")
    else:
        sleep_quality_trend = "insufficient_data"

    # --- 2. MOBILITY & STEPS (SEPARATING SPORT VS NON-SPORT) ---
    steps_7 = [int(r["steps"]) for r in w7 if r.get("steps") is not None]
    steps_prev7 = [int(r["steps"]) for r in w_prev7 if r.get("steps") is not None]
    steps_28 = [int(r["steps"]) for r in w28 if r.get("steps") is not None]

    non_sport_steps_7: List[int] = []
    for r in w7:
        if r.get("steps") is None:
            continue
        tot_s = int(r["steps"])
        r_km = sport_run_km_by_date.get(str(r["date"])[:10], 0.0)
        est_sport_s = min(tot_s, int(round(r_km * 1250.0)))
        non_sport_steps_7.append(max(0, tot_s - est_sport_s))

    avg_steps_7 = round(_mean([float(x) for x in steps_7])) if steps_7 else None
    avg_steps_prev7 = round(_mean([float(x) for x in steps_prev7])) if steps_prev7 else None
    avg_steps_28 = round(_mean([float(x) for x in steps_28])) if steps_28 else None
    avg_non_sport_steps_7 = round(_mean([float(x) for x in non_sport_steps_7])) if non_sport_steps_7 else None

    low_thresh = max(4000, int(avg_steps_28 * 0.55)) if avg_steps_28 else 4500
    low_mobility_days_7d = sum(1 for s in steps_7 if s < low_thresh)
    steps_delta_pct = round(((avg_steps_7 - avg_steps_28) / max(1, avg_steps_28)) * 100.0, 1) if (avg_steps_7 is not None and avg_steps_28) else None

    if avg_steps_7 is not None and avg_steps_28 is not None and len(steps_28) >= 4:
        mobility_trend = "up" if steps_delta_pct and steps_delta_pct >= 10.0 else ("down" if steps_delta_pct and steps_delta_pct <= -10.0 else "stable")
    else:
        mobility_trend = "insufficient_data"

    # --- 3. RECOVERY (HRV, RHR, STRESS, BODY BATTERY) ---
    hrv_7 = [float(r["hrv_last_night"]) for r in w7 if r.get("hrv_last_night") is not None]
    hrv_28 = [float(r["hrv_last_night"]) for r in w28 if r.get("hrv_last_night") is not None]
    hrv_avg_7 = round(_mean(hrv_7), 1) if hrv_7 else None
    hrv_base_28 = round(_mean(hrv_28), 1) if hrv_28 else None
    hrv_sd_28 = round(max(2.5, _std(hrv_28) or 3.5), 2) if len(hrv_28) >= 4 else None
    latest_hrv = _safe_float(latest.get("hrv_last_night"), digits=1)

    if latest_hrv is not None and hrv_base_28 is not None and hrv_sd_28 is not None:
        if latest_hrv < (hrv_base_28 - hrv_sd_28):
            hrv_band = "below_personal_range"
        elif latest_hrv > (hrv_base_28 + hrv_sd_28):
            hrv_band = "above_personal_range"
        else:
            hrv_band = "within_personal_range"
    else:
        hrv_band = "insufficient_baseline"

    rhr_7 = [float(r["resting_hr"]) for r in w7 if r.get("resting_hr") is not None]
    rhr_28 = [float(r["resting_hr"]) for r in w28 if r.get("resting_hr") is not None]
    rhr_avg_7 = round(_mean(rhr_7), 1) if rhr_7 else None
    rhr_base_28 = round(_mean(rhr_28), 1) if rhr_28 else None
    latest_rhr = _safe_int(latest.get("resting_hr"))
    rhr_diff_vs_28 = round(latest_rhr - rhr_base_28, 1) if (latest_rhr is not None and rhr_base_28 is not None) else None

    str_7 = [float(r["stress_avg"]) for r in w7 if r.get("stress_avg") is not None]
    str_28 = [float(r["stress_avg"]) for r in w28 if r.get("stress_avg") is not None]
    str_avg_7 = round(_mean(str_7), 1) if str_7 else None
    str_base_28 = round(_mean(str_28), 1) if str_28 else None

    bb_7 = [float(r["body_battery_max"]) for r in w7 if r.get("body_battery_max") is not None]
    bb_28 = [float(r["body_battery_max"]) for r in w28 if r.get("body_battery_max") is not None]
    bb_avg_7 = round(_mean(bb_7), 1) if bb_7 else None
    bb_base_28 = round(_mean(bb_28), 1) if bb_28 else None

    return {
        "reference_date": today_iso,
        "days_with_data_28d": len(w28),
        "sleep": {
            "last_night_hours": last_slp_h,
            "last_night_score": latest.get("sleep_score"),
            "avg_hours_7d": avg_slp_7,
            "avg_hours_28d": avg_slp_28,
            "diff_vs_28d_hours": slp_diff_vs_28,
            "avg_score_7d": avg_scr_7,
            "avg_score_28d": avg_scr_28,
            "quality_trend": sleep_quality_trend,
            "schedule_regularity_std_min_7d": reg_std_min,
            "schedule_regularity_label": regularity_label,
        },
        "mobility": {
            "today_steps": latest.get("steps"),
            "today_step_goal": latest.get("step_goal"),
            "today_goal_pct": round((int(latest["steps"]) / max(1, int(latest["step_goal"]))) * 100.0, 1)
            if (latest.get("steps") is not None and latest.get("step_goal")) else None,
            "avg_steps_7d": avg_steps_7,
            "avg_steps_prev_7d": avg_steps_prev7,
            "avg_steps_28d": avg_steps_28,
            "steps_source": "garmin_real",
            "avg_non_sport_steps_7d": avg_non_sport_steps_7,
            "estimated_non_sport_steps_7d": avg_non_sport_steps_7,
            "non_sport_steps_is_estimated": True,
            "non_sport_steps_source": "aaronfit_estimated_from_sport_km",
            "non_sport_steps_note": (
                "Estimación orientativa de pasos cotidianos descontando ~1250 pasos/km de carreras o caminatas registradas. "
                "No es una medición directa de Garmin y no modifica la media real de pasos diarios (avg_steps_7d / avg_steps_28d)."
            ),
            "steps_7d_vs_28d_pct": steps_delta_pct,
            "low_mobility_days_7d": low_mobility_days_7d,
            "mobility_trend": mobility_trend,
        },
        "recovery": {
            "hrv_last_night": latest_hrv,
            "hrv_status_garmin": latest.get("hrv_status"),
            "hrv_avg_7d": hrv_avg_7,
            "hrv_baseline_28d": hrv_base_28,
            "hrv_std_28d": hrv_sd_28,
            "hrv_vs_baseline_diff": round(latest_hrv - hrv_base_28, 1) if (latest_hrv is not None and hrv_base_28 is not None) else None,
            "hrv_personal_band": hrv_band,
            "resting_hr_today": latest_rhr,
            "resting_hr_avg_7d": rhr_avg_7,
            "resting_hr_baseline_28d": rhr_base_28,
            "resting_hr_vs_baseline_bpm": rhr_diff_vs_28,
            "stress_today": latest.get("stress_avg"),
            "stress_avg_7d": str_avg_7,
            "stress_baseline_28d": str_base_28,
            "body_battery_max_today": latest.get("body_battery_max"),
            "body_battery_most_recent": latest.get("body_battery_most_recent"),
            "body_battery_charged": latest.get("body_battery_charged"),
            "body_battery_drained": latest.get("body_battery_drained"),
            "body_battery_max_avg_7d": bb_avg_7,
            "body_battery_max_baseline_28d": bb_base_28,
            "respiration_avg": latest.get("respiration_avg"),
            "spo2_avg": latest.get("spo2_avg"),
            "physiological_note": "SpO2 y frecuencia respiratoria se muestran de forma descriptiva (no constituyen diagnóstico médico).",
        },
    }


# ==============================================================================
# 5 & 6 — DAILY READINESS ENGINE & TRAINING PLAN INTEGRATION
# ==============================================================================

def evaluate_daily_readiness(
    today_wellness: Optional[Dict[str, Any]],
    trends: Dict[str, Any],
    training_load_latest: Optional[Dict[str, Any]] = None,
    checkin: Optional[Dict[str, Any]] = None,
    planned_day: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Evaluates the athlete's Daily Readiness into one of 4 explainable states:
      - RECUPERACIÓN FAVORABLE
      - ESTADO NORMAL
      - PRECAUCIÓN / FATIGA
      - DATOS INSUFICIENTES
    Never confuses a low-step day with poor physiological recovery.
    Never modifies the training plan automatically.
    """
    tw = today_wellness or {}
    slp_t = trends.get("sleep") or {}
    mob_t = trends.get("mobility") or {}
    rec_t = trends.get("recovery") or {}
    load = training_load_latest or {}
    chk = checkin or {}

    missing: List[str] = []
    if tw.get("sleep_total_sec") is None and tw.get("sleep_score") is None:
        missing.append("sueño_nocturno")
    if tw.get("hrv_last_night") is None:
        missing.append("hrv_nocturna")
    if tw.get("resting_hr") is None:
        missing.append("fc_reposo")
    if tw.get("body_battery_max") is None and tw.get("body_battery_charged") is None:
        missing.append("body_battery")
    if tw.get("steps") is None:
        missing.append("pasos_diarios")
    if not chk or all(chk.get(k) is None for k in ("energy", "sleep_quality", "muscle_fatigue", "general_feeling")):
        missing.append("checkin_subjetivo")

    has_sleep = "sueño_nocturno" not in missing
    has_hrv_or_rhr = ("hrv_nocturna" not in missing) or ("fc_reposo" not in missing)
    has_bb = "body_battery" not in missing
    has_checkin = "checkin_subjetivo" not in missing

    available_pillars = sum([1 if has_sleep else 0, 1 if has_hrv_or_rhr else 0, 1 if has_bb else 0, 1 if has_checkin else 0])

    if available_pillars == 0 or (not has_sleep and not has_hrv_or_rhr and not has_checkin):
        return {
            "date": tw.get("date") or trends.get("reference_date") or date.today().isoformat(),
            "estado": READINESS_INSUFFICIENT,
            "confianza": "baja",
            "motivos_principales": [
                "No hay suficientes mediciones de sueño, recuperación fisiológica (HRV / FC en reposo) ni check-in subjetivo para evaluar el estado del día con rigor."
            ],
            "metricas_justificativas": {
                "garmin_real": {},
                "aaronfit_calculado": {},
                "subjetivo_usuario": {},
            },
            "datos_faltantes": missing,
            "recomendacion": "Sincroniza tu reloj Garmin tras levantarte o registra un check-in subjetivo rápido (1–5) para obtener una recomendación fundamentada.",
            "sugerencia_plan": {
                "accion": "mantener_sin_cambios",
                "mensaje": "Faltan datos fisiológicos hoy; se mantiene la sesión prevista sin sugerir cambios a ciegas.",
                "modificacion_automatica": False,
            },
        }

    fatigue_signals: List[str] = []
    favorable_signals: List[str] = []
    neutral_notes: List[str] = []

    # --- A. Descanso (Sueño) ---
    slp_h = round(float(tw["sleep_total_sec"]) / 3600.0, 2) if tw.get("sleep_total_sec") else None
    slp_scr = tw.get("sleep_score")
    slp_diff = slp_t.get("diff_vs_28d_hours")
    if slp_h is not None:
        if (slp_diff is not None and slp_diff <= -1.0) or slp_h < 5.8:
            fatigue_signals.append(f"Sueño inferior a tu referencia habitual ({slp_h} h vs media 28d de {slp_t.get('avg_hours_28d') or 'N/D'} h).")
        elif (slp_diff is not None and slp_diff >= 0.25 and slp_h >= 7.0) or (slp_scr is not None and slp_scr >= 80):
            favorable_signals.append(f"Descanso nocturno sólido ({slp_h} h" + (f", puntuación Garmin {slp_scr}/100)." if slp_scr else ")."))
        else:
            neutral_notes.append(f"Duración de sueño dentro de tu rango habitual ({slp_h} h).")
    elif slp_scr is not None:
        if slp_scr < 60:
            fatigue_signals.append(f"Puntuación de sueño Garmin baja ({slp_scr}/100).")
        elif slp_scr >= 80:
            favorable_signals.append(f"Puntuación de sueño Garmin favorable ({slp_scr}/100).")

    # --- B. Recuperación autonómica (HRV y FC Reposo: agrupadas en UN SOLO eje para no duplicar peso correlacionado) ---
    hrv_band = rec_t.get("hrv_personal_band")
    hrv_val = tw.get("hrv_last_night")
    hrv_base = rec_t.get("hrv_baseline_28d")
    rhr_val = tw.get("resting_hr")
    rhr_diff = rec_t.get("resting_hr_vs_baseline_bpm")

    hrv_low = hrv_band == "below_personal_range" or str(tw.get("hrv_status") or "").upper() in ("UNBALANCED", "LOW", "POOR")
    hrv_ok = hrv_band in ("within_personal_range", "above_personal_range")
    rhr_high = rhr_diff is not None and rhr_diff >= 4.0
    rhr_ok = rhr_diff is not None and rhr_diff <= -1.5

    autonomic_fatigue = bool(hrv_low or rhr_high)
    autonomic_favorable = bool(not autonomic_fatigue and (hrv_ok or rhr_ok) and (rhr_diff is None or rhr_diff <= 2.0))

    if hrv_low and rhr_high:
        fatigue_signals.append(
            f"Eje autonómico fatigado (cuenta como 1 señal unificada): HRV nocturna bajo tu rango personal ({hrv_val} ms vs base 28d {hrv_base or 'N/D'} ms) y FC en reposo elevada ({rhr_val} ppm, +{rhr_diff} ppm vs base 28d)."
        )
    elif hrv_low:
        fatigue_signals.append(
            f"HRV nocturna por debajo de tu rango personal ({hrv_val} ms vs base 28d {hrv_base or 'N/D'} ms)."
        )
    elif rhr_high:
        fatigue_signals.append(
            f"FC en reposo elevada respecto a tu media de 28 días ({rhr_val} ppm, +{rhr_diff} ppm)."
        )
    elif autonomic_favorable:
        if hrv_ok and rhr_ok:
            favorable_signals.append(
                f"Eje autonómico favorable (HRV {hrv_val} ms en rango personal y FC reposo {rhr_val} ppm, {rhr_diff} ppm vs base 28d)."
            )
        elif hrv_ok:
            favorable_signals.append(
                f"HRV nocturna estable dentro de tu referencia personal ({hrv_val} ms vs base 28d {hrv_base} ms)."
            )
        elif rhr_ok:
            favorable_signals.append(
                f"FC en reposo favorable ({rhr_val} ppm, {rhr_diff} ppm vs base 28d)."
            )

    # --- B2. Energía y estrés simpático (Body Battery y Estrés diario: agrupados en UN SOLO eje para no duplicar peso) ---
    bb_max = tw.get("body_battery_max")
    bb_chg = tw.get("body_battery_charged")
    stress_today = tw.get("stress_avg")
    stress_base = rec_t.get("stress_baseline_28d")
    bb_low = (bb_max is not None and bb_max < 55) or (bb_max is None and bb_chg is not None and bb_chg < 35)
    bb_high = bb_max is not None and bb_max >= 80
    stress_elevated = (
        stress_today is not None
        and stress_today >= 45
        and (stress_base is None or (stress_today - stress_base) >= 8.0)
    )

    if bb_low and stress_elevated:
        fatigue_signals.append(
            f"Recarga energética limitada y estrés elevado (1 señal unificada): Body Battery máx. {bb_max if bb_max is not None else f'+{bb_chg}'}/100 y estrés medio {stress_today}/100."
        )
    elif bb_low:
        if bb_max is not None:
            fatigue_signals.append(f"Recarga de Body Battery limitada al despertar (máx. {bb_max}/100).")
        else:
            fatigue_signals.append(f"Carga nocturna de Body Battery baja (+{bb_chg}).")
    elif stress_elevated:
        fatigue_signals.append(f"Estrés fisiológico diario elevado ({stress_today}/100 vs base 28d {stress_base or 'N/D'}).")
    elif bb_high:
        favorable_signals.append(f"Body Battery alta ({bb_max}/100).")

    # --- C. Carga deportiva (CTL / ATL / TSB) ---
    tsb = _safe_float(load.get("tsb"), digits=1)
    if tsb is not None:
        if tsb < -18.0:
            fatigue_signals.append(f"Carga deportiva aguda elevada (TSB calculado = {tsb}).")
        elif -10.0 <= tsb <= 15.0:
            favorable_signals.append(f"Equilibrio de carga deportiva favorable (TSB = {tsb}).")

    # --- D. Actividad cotidiana (NUNCA suma como fatiga si los pasos son bajos) ---
    low_mob_days = int(mob_t.get("low_mobility_days_7d") or 0)
    mobility_observation: Optional[str] = None
    if low_mob_days >= 3:
        mobility_observation = f"Se observan {low_mob_days} días recientes con movilidad cotidiana baja (media 7d: {mob_t.get('avg_steps_7d') or 'N/D'} pasos). Oportunidad para añadir paseos suaves sin confundirlo con fatiga ni con entrenamiento intenso."

    # --- E. Sensaciones subjetivas (check-in voluntario) ---
    if has_checkin:
        e_val = chk.get("energy")
        f_val = chk.get("muscle_fatigue")
        g_val = chk.get("general_feeling")
        if (e_val is not None and int(e_val) <= 2) or (f_val is not None and int(f_val) >= 4) or (g_val is not None and int(g_val) <= 2):
            fatigue_signals.append(f"Check-in subjetivo indica fatiga o baja energía (energía {e_val or '-'}/5, fatiga muscular {f_val or '-'}/5).")
        elif (e_val is not None and int(e_val) >= 4) and (f_val is not None and int(f_val) <= 2):
            favorable_signals.append(f"Sensaciones subjetivas positivas en tu check-in (energía {e_val}/5, fatiga {f_val}/5).")
        if chk.get("physical_discomfort"):
            fatigue_signals.append(f"Molestia física registrada por el usuario: '{chk['physical_discomfort']}'.")

    # Decision logic requiring convergent signals (never a single isolated metric unless extreme)
    if len(fatigue_signals) >= 2 or (autonomic_fatigue and has_sleep and (slp_h or 8) < 6.2):
        estado = READINESS_CAUTION
    elif len(favorable_signals) >= 2 and len(fatigue_signals) == 0:
        estado = READINESS_FAVORABLE
    else:
        estado = READINESS_NORMAL

    days_28 = int(trends.get("days_with_data_28d") or 0)
    if available_pillars >= 3 and days_28 >= 7:
        confianza = "alta"
    elif available_pillars >= 2:
        confianza = "media"
    else:
        confianza = "baja"

    motivos = fatigue_signals + favorable_signals + neutral_notes
    if mobility_observation:
        motivos.append(mobility_observation)
    if not motivos:
        motivos.append("Indicadores fisiológicos y de descanso dentro de la normalidad.")

    # Section 6: Integration with planned workout
    plan_tipo = str((planned_day or {}).get("tipo") or (planned_day or {}).get("type") or "")
    plan_titulo = str((planned_day or {}).get("titulo") or (planned_day or {}).get("title") or "sesión del día")
    plan_zona = str((planned_day or {}).get("zona_objetivo") or (planned_day or {}).get("zone") or "")
    is_intense_plan = any(k in f"{plan_tipo} {plan_titulo} {plan_zona}".lower() for k in ("calidad", "serie", "interval", "tempo", "z4", "z5", "umbral"))

    if estado == READINESS_CAUTION:
        if is_intense_plan:
            recomendacion = f"Se detectan señales convergentes de fatiga antes de '{plan_titulo}'. Valora reducir la intensidad a rodaje aeróbico Z2 o acortar el bloque principal."
            sugerencia_plan = {
                "accion": "valorar_reduccion_intensidad",
                "entrenamiento_previsto": plan_titulo,
                "es_intenso": True,
                "mensaje": f"Tu sesión prevista ('{plan_titulo}') es exigente y hoy coinciden {len(fatigue_signals)} señales de fatiga. Recomendamos valorar bajar a Z2 o reducir repeticiones. La decisión final es tuya (el plan no se modifica automáticamente).",
                "modificacion_automatica": False,
            }
        else:
            recomendacion = "Prioriza un ritmo cómodo, hidratación y adelantar la hora de descanso esta noche."
            sugerencia_plan = {
                "accion": "mantener_con_prudencia",
                "entrenamiento_previsto": plan_titulo,
                "es_intenso": False,
                "mensaje": f"Mantén '{plan_titulo}' en zona cómoda sin forzar ritmos. El plan no se modifica automáticamente.",
                "modificacion_automatica": False,
            }
    elif estado == READINESS_FAVORABLE:
        recomendacion = f"Tus indicadores de sueño y recuperación son compatibles con '{plan_titulo}'." + (f" {mobility_observation}" if mobility_observation else "")
        sugerencia_plan = {
            "accion": "mantener_plan_previsto",
            "entrenamiento_previsto": plan_titulo,
            "es_intenso": is_intense_plan,
            "mensaje": f"Descanso y recuperación favorables: luz verde para ejecutar '{plan_titulo}' según lo previsto.",
            "modificacion_automatica": False,
        }
    else:
        recomendacion = f"Estado equilibrado para realizar '{plan_titulo}' regulando el esfuerzo por sensaciones." + (f" {mobility_observation}" if mobility_observation else "")
        sugerencia_plan = {
            "accion": "mantener_plan_previsto",
            "entrenamiento_previsto": plan_titulo,
            "es_intenso": is_intense_plan,
            "mensaje": f"Indicadores compatibles con '{plan_titulo}'. Si notas pesadez al calentar, ajusta el ritmo sin sobrepasar tu zona objetivo.",
            "modificacion_automatica": False,
        }

    return {
        "date": tw.get("date") or trends.get("reference_date") or date.today().isoformat(),
        "estado": estado,
        "confianza": confianza,
        "motivos_principales": motivos,
        "metricas_justificativas": {
            "garmin_real": {
                "sleep_hours": slp_h,
                "sleep_score": slp_scr,
                "hrv_last_night_ms": hrv_val,
                "resting_hr_bpm": rhr_val,
                "body_battery_max": bb_max,
                "stress_avg": tw.get("stress_avg"),
                "steps": tw.get("steps"),
            },
            "aaronfit_calculado": {
                "sleep_avg_28d_hours": slp_t.get("avg_hours_28d"),
                "hrv_baseline_28d_ms": hrv_base,
                "resting_hr_baseline_28d_bpm": rec_t.get("resting_hr_baseline_28d"),
                "tsb_banister_ewma": tsb,
                "low_mobility_days_7d": low_mob_days,
            },
            "subjetivo_usuario": {
                "energy": chk.get("energy"),
                "sleep_quality": chk.get("sleep_quality"),
                "muscle_fatigue": chk.get("muscle_fatigue"),
                "perceived_stress": chk.get("perceived_stress"),
                "general_feeling": chk.get("general_feeling"),
                "physical_discomfort": chk.get("physical_discomfort"),
            } if has_checkin else {},
        },
        "datos_faltantes": missing,
        "recomendacion": recomendacion,
        "sugerencia_plan": sugerencia_plan,
        "reglas_y_umbrales": {
            "naturaleza": "Reglas heurísticas explicables de AaronFit basadas en referencias personales de 7 y 28 días (no constituyen diagnóstico médico ni métrica oficial Training Readiness de Garmin).",
            "no_doble_conteo": [
                "HRV nocturna y FC en reposo se agrupan en un único eje autonómico (máximo 1 señal de fatiga o favorable).",
                "Body Battery y estrés diario se agrupan en un único eje energético/simpático (máximo 1 señal de fatiga o favorable)."
            ],
            "umbrales_aplicados": {
                "sueno_fatiga": "< 5.8 h absolutas o <= -1.0 h respecto a media personal 28d (o sleep_score Garmin < 60)",
                "sueno_favorable": ">= 7.0 h y >= +0.25 h vs media 28d (o sleep_score Garmin >= 80)",
                "eje_autonomico_fatiga": "HRV < (media_28d - 1*SD_28d) o estado Garmin UNBALANCED/LOW/POOR, o FC reposo >= +4.0 ppm vs media 28d",
                "eje_energetico_fatiga": "Body Battery máx < 55/100 (o recarga < +35) o estrés diario >= 45 y >= +8 pts vs media 28d",
                "carga_tsb_fatiga": "TSB Banister EWMA < -18.0",
                "movilidad_cotidiana": "Días con pocos pasos nunca suman fatiga fisiológica; solo añaden observación contextual si >= 3 días bajos en 7d"
            },
        },
    }


def build_ai_wellness_snapshot(
    today_wellness: Optional[Dict[str, Any]],
    trends: Dict[str, Any],
    readiness: Dict[str, Any],
    checkin: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Prepares a clean, structured, sanitized wellness & readiness context block for Gemini (ai_coach.py),
    strictly separating Garmin measurements, AaronFit baselines/calculations, and subjective check-in data.
    """
    return {
        "date": readiness.get("date"),
        "day_status": (today_wellness or {}).get("day_status") or "pending",
        "readiness": readiness,
        "trends_7d_vs_28d": trends,
        "subjective_checkin": checkin or None,
    }


def sync_wellness_range(
    days: int = 14,
    force: bool = False,
    ref_date: Optional[date] = None,
    max_api_calls: int = 90,
) -> Dict[str, Any]:
    """
    Section 4: Incremental wellness synchronization.
    - Always updates today (and yesterday if partial/pending).
    - Skips past dates already marked 'complete' in daily_wellness unless force=True.
    - Supports up to 90 days backfill to establish 28d personal baselines.
    """
    import database
    import garmin_client

    today = ref_date or date.today()
    safe_days = max(1, min(90, int(days or 14)))
    start_dt = today - timedelta(days=safe_days - 1)
    start_iso = start_dt.isoformat()
    today_iso = today.isoformat()

    if not garmin_client.is_garmin_connected():
        return {
            "status": "not_connected",
            "days_requested": safe_days,
            "days_synced": 0,
            "days_skipped_complete": 0,
            "date_from": start_iso,
            "date_to": today_iso,
        }

    complete_dates = set() if force else database.get_complete_wellness_dates(start_iso, today_iso)
    records_to_save: List[Dict[str, Any]] = []
    skipped = 0
    api_calls = 0

    for offset in range(safe_days):
        target_dt = today - timedelta(days=offset)
        d_str = target_dt.isoformat()
        # Never skip today; skip past days if already complete and not force
        if offset > 0 and d_str in complete_dates:
            skipped += 1
            continue
        if api_calls >= max_api_calls:
            break
        raw_bundle = garmin_client.fetch_garmin_daily_wellness_raw(d_str)
        api_calls += 1
        norm = normalize_garmin_daily_bundle(raw_bundle, target_date=d_str)
        records_to_save.append(norm)

    saved_count = database.upsert_daily_wellness(records_to_save) if records_to_save else 0
    return {
        "status": "ok",
        "days_requested": safe_days,
        "days_synced": saved_count,
        "days_skipped_complete": skipped,
        "date_from": start_iso,
        "date_to": today_iso,
    }

