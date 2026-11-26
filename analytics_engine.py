"""
analytics_engine.py — Independent Sports Analytics Engine for AaronFit (Phase 3).
Completely decoupled from the frontend and Gemini AI.
Computes reproducible, traceable metrics strictly from real Garmin/PostgreSQL data.
"""
from datetime import date, datetime, timedelta, timezone
import json
from typing import Any, Dict, List, Optional, Tuple


METRIC_CATALOG: Dict[str, Dict[str, str]] = {
    "volume_distance_km": {
        "definition": "Distancia total acumulada en actividades reales registradas.",
        "formula": "SUM(distance_km) en el periodo [start, end]",
        "source": "Garmin Connect (tabla activities / daily_summaries)",
        "data_required": "distance_km > 0",
        "updates": "En cada sincronización o inserción de actividad",
        "limitations": "Actividades indoor o de fuerza suelen registrar 0 km.",
    },
    "duration_min": {
        "definition": "Tiempo total de entrenamiento efectivo en minutos.",
        "formula": "SUM(duration_min) en el periodo [start, end]",
        "source": "Garmin Connect (tabla activities / daily_summaries)",
        "data_required": "duration_min > 0",
        "updates": "En cada sincronización",
        "limitations": "Usa moving_duration cuando está disponible en actividades paradas.",
    },
    "elevation_gain_loss": {
        "definition": "Desnivel positivo acumulado y desnivel negativo perdido.",
        "formula": "SUM(elevation_gain), SUM(elevation_loss)",
        "source": "Garmin Connect (altímetro barométrico / GPS)",
        "data_required": "elevation_gain >= 0",
        "updates": "En cada sincronización",
        "limitations": "Dispositivos sin altímetro barométrico pueden tener mayor error GPS.",
    },
    "avg_pace_and_speed": {
        "definition": "Ritmo medio en carrera (min/km) y velocidad media en ciclismo (km/h) ponderados por distancia y tiempo.",
        "formula": "Carrera: (SUM(dur_min)*60)/SUM(dist_km); Ciclismo: SUM(dist_km)/(SUM(dur_min)/60)",
        "source": "Garmin Connect (calculado sobre actividades con distancia y duración válidas)",
        "data_required": "distance_km > 0.2 y duration_min > 1",
        "updates": "Bajo demanda al consultar el periodo",
        "limitations": "Mezcla recorridos llanos y con desnivel; ver Eficiencia Aeróbica para comparativas homogéneas.",
    },
    "aerobic_efficiency": {
        "definition": "Eficiencia aeróbica (EF): relación entre velocidad de carrera (m/min) y frecuencia cardíaca media (ppm) en sesiones comparables.",
        "formula": "EF = (distance_km * 1000 / duration_min) / avg_hr",
        "source": "AaronFit Calculated (cálculo propio sobre datos reales de Garmin Connect; NO es métrica oficial de Garmin)",
        "data_required": "Carrera >= 3 km, >= 15 min, 90 <= avg_hr <= 210, desnivel <= 25 m/km, mínimo 3 sesiones por ventana de 6 semanas",
        "updates": "Bajo demanda sobre histórico real",
        "limitations": "Compara ventanas equivalentes (6 semanas vs 6 semanas previas). La banda ±2.5% es un criterio operativo de estabilidad, no una prueba estadística de significación; no controla temperatura ni viento si faltan.",
    },
    "training_load_ewma": {
        "definition": "Carga crónica (CTL 42d), fatiga aguda (ATL 7d) y equilibrio de frescura (TSB) mediante modelo Banister EWMA.",
        "formula": "CTL_t = CTL_{t-1} + (TSS_t - CTL_{t-1})/42; ATL_t = ATL_{t-1} + (TSS_t - ATL_{t-1})/7; TSB_t = CTL_t - ATL_t",
        "source": "AaronFit Calculated (estimación propia basada en Relative Effort / duración; NO es métrica oficial de Garmin)",
        "data_required": "daily_summaries de al menos 14 días activos; semilla inicial = 0.0 (sin valores artificiales)",
        "updates": "Al actualizarse daily_summaries",
        "limitations": "Sin potenciómetro o FC en todas las sesiones, TSS usa duración ponderada por deporte.",
    },
    "hr_zones_distribution": {
        "definition": "Distribución porcentual del tiempo en zonas de frecuencia cardíaca Z1–Z5.",
        "formula": "Porcentaje normalizado al 100% sobre muestras de FC cacheadas en activity_streams",
        "source": "Garmin Connect (streams de FC por segundo)",
        "data_required": "activity_streams.hr_zones_json disponible",
        "updates": "Al cachear streams de cada actividad",
        "limitations": "Solo incluye actividades cuyos streams detallados hayan sido descargados.",
    },
}


def _fmt_pace(sec_per_km: Optional[float]) -> Optional[str]:
    if sec_per_km is None or sec_per_km <= 0:
        return None
    s = int(round(sec_per_km))
    return f"{s // 60}:{s % 60:02d} min/km"


def _parse_date(d_str: str) -> Optional[date]:
    try:
        return datetime.strptime((d_str or "")[:10], "%Y-%m-%d").date()
    except Exception:
        return None


def _delta_pct(curr: Optional[float], prev: Optional[float]) -> Optional[float]:
    if curr is None or prev is None or prev == 0:
        return None
    return round(((curr - prev) / abs(prev)) * 100.0, 1)


def summarize_activities_period(
    activities: List[Dict[str, Any]],
    start_date: str,
    end_date: str,
) -> Dict[str, Any]:
    """Aggregates real performance metrics for a given [start_date, end_date] inclusive window."""
    filtered = [
        a for a in activities
        if start_date <= (a.get("start_date") or "")[:10] <= end_date
    ]

    total_dist = 0.0
    total_dur = 0.0
    total_elev_gain = 0.0
    total_elev_loss = 0.0
    total_rel_effort = 0.0
    hr_weighted_sum = 0.0
    hr_weight_min = 0.0
    max_hr_peak: Optional[int] = None

    by_discipline: Dict[str, Dict[str, Any]] = {}

    for a in filtered:
        sport = a.get("sport_type") or "Otro"
        dist = float(a.get("distance_km") or 0.0)
        dur = float(a.get("duration_min") or 0.0)
        eg = float(a.get("elevation_gain") or 0.0)
        el = float(a.get("elevation_loss") or 0.0)
        re = float(a.get("relative_effort") or 0.0)
        avg_hr = a.get("avg_hr")
        m_hr = a.get("max_hr")

        total_dist += dist
        total_dur += dur
        total_elev_gain += eg
        total_elev_loss += el
        total_rel_effort += re
        if avg_hr is not None and 35 <= float(avg_hr) <= 230 and dur > 0:
            hr_weighted_sum += float(avg_hr) * dur
            hr_weight_min += dur
        if m_hr is not None and 40 <= int(m_hr) <= 240:
            max_hr_peak = int(m_hr) if max_hr_peak is None else max(max_hr_peak, int(m_hr))

        d_bucket = by_discipline.setdefault(sport, {
            "count": 0,
            "distance_km": 0.0,
            "duration_min": 0.0,
            "elevation_gain_m": 0.0,
            "elevation_loss_m": 0.0,
            "relative_effort": 0.0,
            "_hr_sum": 0.0,
            "_hr_min": 0.0,
        })
        d_bucket["count"] += 1
        d_bucket["distance_km"] += dist
        d_bucket["duration_min"] += dur
        d_bucket["elevation_gain_m"] += eg
        d_bucket["elevation_loss_m"] += el
        d_bucket["relative_effort"] += re
        if avg_hr is not None and 35 <= float(avg_hr) <= 230 and dur > 0:
            d_bucket["_hr_sum"] += float(avg_hr) * dur
            d_bucket["_hr_min"] += dur

    disciplines_clean: Dict[str, Any] = {}
    for sport, b in by_discipline.items():
        d_km = round(b["distance_km"], 2)
        d_min = round(b["duration_min"], 1)
        avg_pace_sec = ((b["duration_min"] * 60.0) / b["distance_km"]) if (sport == "Carrera" and b["distance_km"] > 0.2 and b["duration_min"] > 0) else None
        avg_speed_kmh = (b["distance_km"] / (b["duration_min"] / 60.0)) if (sport == "Ciclismo" and b["distance_km"] > 0.2 and b["duration_min"] > 0) else None
        disciplines_clean[sport] = {
            "count": b["count"],
            "distance_km": d_km,
            "duration_min": d_min,
            "elevation_gain_m": round(b["elevation_gain_m"], 1),
            "elevation_loss_m": round(b["elevation_loss_m"], 1),
            "relative_effort": round(b["relative_effort"], 1),
            "avg_hr": round(b["_hr_sum"] / b["_hr_min"], 1) if b["_hr_min"] > 0 else None,
            "avg_pace_sec": round(avg_pace_sec, 1) if avg_pace_sec else None,
            "avg_pace_str": _fmt_pace(avg_pace_sec),
            "avg_speed_kmh": round(avg_speed_kmh, 1) if avg_speed_kmh else None,
        }

    run_b = disciplines_clean.get("Carrera") or {}
    bike_b = disciplines_clean.get("Ciclismo") or {}

    return {
        "period": {"start": start_date, "end": end_date},
        "activities_count": len(filtered),
        "distance_km": round(total_dist, 2),
        "duration_min": round(total_dur, 1),
        "elevation_gain_m": round(total_elev_gain, 1),
        "elevation_loss_m": round(total_elev_loss, 1),
        "relative_effort": round(total_rel_effort, 1),
        "intensity_effort_per_min": round(total_rel_effort / total_dur, 2) if total_dur > 0 else None,
        "avg_hr": round(hr_weighted_sum / hr_weight_min, 1) if hr_weight_min > 0 else None,
        "max_hr": max_hr_peak,
        "run_avg_pace_sec": run_b.get("avg_pace_sec"),
        "run_avg_pace_str": run_b.get("avg_pace_str"),
        "bike_avg_speed_kmh": bike_b.get("avg_speed_kmh"),
        "by_discipline": disciplines_clean,
    }


def compare_periods(
    activities: List[Dict[str, Any]],
    start_a: str,
    end_a: str,
    start_b: str,
    end_b: str,
    label: str = "custom",
) -> Dict[str, Any]:
    """Compares period A (current) against period B (previous baseline) with strict null-safe deltas."""
    curr = summarize_activities_period(activities, start_a, end_a)
    prev = summarize_activities_period(activities, start_b, end_b)

    reliable = curr["activities_count"] > 0 and prev["activities_count"] > 0
    return {
        "label": label,
        "current": curr,
        "previous": prev,
        "deltas": {
            "activities_count_diff": curr["activities_count"] - prev["activities_count"],
            "distance_km_diff": round(curr["distance_km"] - prev["distance_km"], 2),
            "distance_pct": _delta_pct(curr["distance_km"], prev["distance_km"]),
            "duration_min_diff": round(curr["duration_min"] - prev["duration_min"], 1),
            "duration_pct": _delta_pct(curr["duration_min"], prev["duration_min"]),
            "elevation_gain_pct": _delta_pct(curr["elevation_gain_m"], prev["elevation_gain_m"]),
            "relative_effort_pct": _delta_pct(curr["relative_effort"], prev["relative_effort"]),
            "run_pace_sec_diff": (
                round(curr["run_avg_pace_sec"] - prev["run_avg_pace_sec"], 1)
                if (curr["run_avg_pace_sec"] is not None and prev["run_avg_pace_sec"] is not None)
                else None
            ),
            "avg_hr_diff": (
                round(curr["avg_hr"] - prev["avg_hr"], 1)
                if (curr["avg_hr"] is not None and prev["avg_hr"] is not None)
                else None
            ),
        },
        "sample_quality": "reliable" if reliable else "insufficient",
    }


def build_standard_comparisons(activities: List[Dict[str, Any]], ref_date: Optional[date] = None) -> Dict[str, Any]:
    """Builds week-over-week, month-over-month, 3m, 6m, and 12m comparisons."""
    today = ref_date or date.today()

    # 1. Current week (Mon..Today) vs Previous week (Mon..Sun)
    mon_curr = today - timedelta(days=today.weekday())
    mon_prev = mon_curr - timedelta(days=7)
    sun_prev = mon_curr - timedelta(days=1)

    # 2. Current month (1st..Today) vs Previous month (1st..last day)
    first_curr = today.replace(day=1)
    last_prev = first_curr - timedelta(days=1)
    first_prev = last_prev.replace(day=1)

    return {
        "week": compare_periods(activities, mon_curr.isoformat(), today.isoformat(), mon_prev.isoformat(), sun_prev.isoformat(), "Semana actual vs anterior"),
        "month": compare_periods(activities, first_curr.isoformat(), today.isoformat(), first_prev.isoformat(), last_prev.isoformat(), "Mes actual vs anterior"),
        "months_3": compare_periods(activities, (today - timedelta(days=89)).isoformat(), today.isoformat(), (today - timedelta(days=179)).isoformat(), (today - timedelta(days=90)).isoformat(), "Últimos 3 meses vs 3 meses previos"),
        "months_6": compare_periods(activities, (today - timedelta(days=179)).isoformat(), today.isoformat(), (today - timedelta(days=359)).isoformat(), (today - timedelta(days=180)).isoformat(), "Últimos 6 meses vs 6 meses previos"),
        "months_12": compare_periods(activities, (today - timedelta(days=364)).isoformat(), today.isoformat(), (today - timedelta(days=729)).isoformat(), (today - timedelta(days=365)).isoformat(), "Últimos 12 meses vs 12 meses previos"),
    }


def compute_aerobic_efficiency(
    activities: List[Dict[str, Any]],
    ref_date: Optional[date] = None,
    recent_days: int = 42,
    baseline_days: int = 42,
    min_samples: int = 3,
    variability_band_pct: float = 2.5,
) -> Dict[str, Any]:
    """
    Computes running Aerobic Efficiency (EF = speed_m_per_min / avg_hr) strictly across
    equivalent 6-week vs 6-week windows of comparable flat/rolling runs
    (>= 3 km, >= 15 min, valid HR, <= 25 m/km gain).
    """
    today = ref_date or date.today()
    recent_start = (today - timedelta(days=recent_days - 1)).isoformat()
    base_end = (today - timedelta(days=recent_days)).isoformat()
    base_start = (today - timedelta(days=recent_days + baseline_days - 1)).isoformat()

    def _eligible(a: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        if (a.get("sport_type") or "") != "Carrera":
            return None
        dist = float(a.get("distance_km") or 0.0)
        dur = float(a.get("duration_min") or 0.0)
        hr = a.get("avg_hr")
        elev = float(a.get("elevation_gain") or 0.0)
        if dist < 3.0 or dur < 15.0 or hr is None:
            return None
        hr_f = float(hr)
        if hr_f < 90.0 or hr_f > 210.0:
            return None
        pace_sec = (dur * 60.0) / dist
        if pace_sec < 150.0 or pace_sec > 720.0:
            return None
        elev_per_km = elev / dist
        if elev_per_km > 25.0:
            return None
        speed_m_min = (dist * 1000.0) / dur
        ef = speed_m_min / hr_f
        return {
            "date": (a.get("start_date") or "")[:10],
            "name": a.get("name"),
            "distance_km": round(dist, 2),
            "duration_min": round(dur, 1),
            "avg_hr": round(hr_f, 1),
            "pace_sec": round(pace_sec, 1),
            "pace_str": _fmt_pace(pace_sec),
            "elev_per_km": round(elev_per_km, 1),
            "ef": round(ef, 4),
        }

    recent_runs: List[Dict[str, Any]] = []
    base_runs: List[Dict[str, Any]] = []
    for a in activities:
        d_str = (a.get("start_date") or "")[:10]
        if not d_str:
            continue
        item = _eligible(a)
        if not item:
            continue
        if recent_start <= d_str <= today.isoformat():
            recent_runs.append(item)
        elif base_start <= d_str <= base_end:
            base_runs.append(item)

    def _agg_ef(runs: List[Dict[str, Any]]) -> Dict[str, Any]:
        if not runs:
            return {"count": 0, "mean_ef": None, "mean_hr": None, "mean_pace_str": None}
        mean_ef = sum(r["ef"] for r in runs) / len(runs)
        mean_hr = sum(r["avg_hr"] for r in runs) / len(runs)
        mean_pace = sum(r["pace_sec"] for r in runs) / len(runs)
        return {
            "count": len(runs),
            "mean_ef": round(mean_ef, 4),
            "mean_hr": round(mean_hr, 1),
            "mean_pace_sec": round(mean_pace, 1),
            "mean_pace_str": _fmt_pace(mean_pace),
        }

    rec_agg = _agg_ef(recent_runs)
    base_agg = _agg_ef(base_runs)

    if rec_agg["count"] < min_samples or base_agg["count"] < min_samples:
        return {
            "status": "insufficient_sample",
            "comparable": False,
            "recent_period": {"start": recent_start, "end": today.isoformat(), **rec_agg},
            "baseline_period": {"start": base_start, "end": base_end, **base_agg},
            "ef_change_pct": None,
            "hr_diff_bpm": None,
            "conclusion": f"Muestra insuficiente para comparar eficiencia aeróbica (se requieren ≥ {min_samples} carreras comparables en cada periodo; recientes={rec_agg['count']}, base={base_agg['count']}).",
            "meta": METRIC_CATALOG["aerobic_efficiency"],
        }

    ef_pct = _delta_pct(rec_agg["mean_ef"], base_agg["mean_ef"])
    hr_diff = round(rec_agg["mean_hr"] - base_agg["mean_hr"], 1)
    comparable_hr = abs(hr_diff) <= 10.0

    if not comparable_hr:
        conclusion = f"La FC media difiere en {hr_diff:+.1f} ppm entre ambas ventanas de 6 semanas; la variación de EF ({ef_pct:+.1f}%) debe interpretarse con cautela por distinta intensidad."
    elif ef_pct is not None and ef_pct >= variability_band_pct:
        conclusion = f"Eficiencia aeróbica en mejora confirmada (+{ef_pct}% > ±{variability_band_pct}%): corres más rápido a frecuencias cardíacas comparables ({rec_agg['mean_pace_str']} @ {rec_agg['mean_hr']} ppm vs {base_agg['mean_pace_str']} @ {base_agg['mean_hr']} ppm)."
    elif ef_pct is not None and ef_pct <= -variability_band_pct:
        conclusion = f"Eficiencia aeróbica ligeramente inferior ({ef_pct}% < -{variability_band_pct}%): ritmo más lento o mayor pulso en carreras comparables; revisa fatiga y descanso."
    else:
        conclusion = f"Eficiencia aeróbica estable ({ef_pct:+.1f}%, dentro de la variabilidad normal ±{variability_band_pct}%) entre las últimas 6 semanas y las 6 anteriores."

    return {
        "status": "ok",
        "source": "AaronFit Calculated (NO oficial de Garmin)",
        "is_official_garmin_metric": False,
        "comparable": comparable_hr,
        "window_days": {"recent": recent_days, "baseline": baseline_days},
        "variability_band_pct": variability_band_pct,
        "recent_period": {"start": recent_start, "end": today.isoformat(), **rec_agg},
        "baseline_period": {"start": base_start, "end": base_end, **base_agg},
        "ef_change_pct": ef_pct,
        "hr_diff_bpm": hr_diff,
        "conclusion": conclusion,
        "meta": METRIC_CATALOG["aerobic_efficiency"],
    }


def compute_training_load_ewma(
    daily_summaries: List[Dict[str, Any]],
    ref_date: Optional[date] = None,
    output_days: int = 90,
) -> Dict[str, Any]:
    """
    Computes Banister EWMA (CTL 42d, ATL 7d, TSB) starting from 0.0 (NO artificial seed).
    Distinguishes confirmed rest days (within [earliest_synced_date, today]) from unconfirmed
    days prior to the first synced record.
    """
    today = ref_date or date.today()
    by_date = {str(d.get("date"))[:10]: d for d in daily_summaries if d.get("date")}
    earliest_confirmed = min(by_date.keys()) if by_date else None
    warmup_start = today - timedelta(days=output_days + 89)
    output_start = today - timedelta(days=output_days - 1)

    ctl, atl = 0.0, 0.0
    curve: List[Dict[str, Any]] = []
    active_days_in_output = 0
    confirmed_rest_days = 0
    unconfirmed_days = 0
    estimated_load_days = 0

    total_span = (today - warmup_start).days + 1
    for i in range(total_span):
        d = warmup_start + timedelta(days=i)
        ds = d.isoformat()
        row = by_date.get(ds)
        is_confirmed = earliest_confirmed is not None and ds >= earliest_confirmed
        day_tss = float(row.get("relative_effort") or 0.0) if row else 0.0
        is_estimated_day = False
        if day_tss == 0.0 and row and float(row.get("total_min") or 0.0) > 0:
            day_tss = float(row.get("total_min") or 0.0) * 0.8
            is_estimated_day = True

        ctl = ctl + (day_tss - ctl) / 42.0
        atl = atl + (day_tss - atl) / 7.0
        tsb = ctl - atl

        if d >= output_start:
            if row and int(row.get("activities_count") or 0) > 0:
                active_days_in_output += 1
                if is_estimated_day:
                    estimated_load_days += 1
            elif is_confirmed:
                confirmed_rest_days += 1
            else:
                unconfirmed_days += 1
            curve.append({
                "date": ds,
                "ctl": round(ctl, 1),
                "atl": round(atl, 1),
                "tsb": round(tsb, 1),
                "day_tss": round(day_tss, 1),
                "load_type": "estimated_duration" if is_estimated_day else ("calculated_trimp" if day_tss > 0 else "none"),
                "day_status": "active" if (row and int(row.get("activities_count") or 0) > 0) else ("rest" if is_confirmed else "unconfirmed_no_data"),
            })

    sample_quality = "high" if active_days_in_output >= 25 else "medium" if active_days_in_output >= 10 else "insufficient"
    latest = curve[-1] if curve else {"ctl": 0.0, "atl": 0.0, "tsb": 0.0}

    return {
        "source": "AaronFit Calculated (Banister EWMA)",
        "daily_load_source": "relative_effort (TRIMP por FC/duración; estimación 0.8×min en días sin FC)",
        "is_official_garmin_metric": False,
        "sample_quality": sample_quality,
        "active_days": active_days_in_output,
        "estimated_load_days": estimated_load_days,
        "confirmed_rest_days": confirmed_rest_days,
        "unconfirmed_days": unconfirmed_days,
        "latest": latest,
        "curve": curve,
        "meta": METRIC_CATALOG["training_load_ewma"],
    }


def compute_hr_zone_distribution(streams_rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Aggregates HR zones Z1-Z5 across cached activity_streams, normalized to exact 100%."""
    zone_names = [
        "Z1 Recuperación",
        "Z2 Aeróbica",
        "Z3 Tempo",
        "Z4 Umbral",
        "Z5 Máxima",
    ]
    totals = [0.0, 0.0, 0.0, 0.0, 0.0]
    used_activities = 0

    for sr in streams_rows:
        raw_hz = sr.get("hr_zones_json")
        if not raw_hz:
            continue
        try:
            hz = json.loads(raw_hz) if isinstance(raw_hz, str) else raw_hz
        except Exception:
            continue
        if not isinstance(hz, list) or len(hz) < 5:
            continue
        if sum(float(z.get("pct") or 0) for z in hz[:5]) <= 0:
            continue
        used_activities += 1
        for i in range(5):
            totals[i] += float(hz[i].get("pct") or 0)

    grand = sum(totals)
    if grand <= 0 or used_activities == 0:
        return {
            "status": "unavailable",
            "activities_with_zones": 0,
            "zones": [],
            "meta": METRIC_CATALOG["hr_zones_distribution"],
        }

    exact = [(t / grand) * 100.0 for t in totals]
    floored = [int(v) for v in exact]
    rem = 100 - sum(floored)
    order = sorted(range(5), key=lambda i: exact[i] - floored[i], reverse=True)
    for k in range(rem):
        floored[order[k]] += 1

    return {
        "status": "ok",
        "activities_with_zones": used_activities,
        "zones": [{"zone": zone_names[i], "pct": floored[i]} for i in range(5)],
        "meta": METRIC_CATALOG["hr_zones_distribution"],
    }


def build_ai_ready_analytics_snapshot(
    activities: List[Dict[str, Any]],
    daily_summaries: List[Dict[str, Any]],
    streams_rows: Optional[List[Dict[str, Any]]] = None,
    ref_date: Optional[date] = None,
) -> Dict[str, Any]:
    """
    Produces a complete, self-contained, traceable JSON snapshot of the athlete's real
    performance, period comparisons, aerobic efficiency, and load/recovery state for Phase 4 (Gemini).
    """
    today = ref_date or date.today()
    comparisons = build_standard_comparisons(activities, ref_date=today)
    efficiency = compute_aerobic_efficiency(activities, ref_date=today)
    load_ewma = compute_training_load_ewma(daily_summaries, ref_date=today, output_days=90)
    hr_zones = compute_hr_zone_distribution(streams_rows or [])

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "reference_date": today.isoformat(),
        "data_scope": {
            "activities_analyzed": len(activities),
            "daily_summaries_days": len(daily_summaries),
        },
        "comparisons": comparisons,
        "aerobic_efficiency": efficiency,
        "training_load": {
            "source": load_ewma["source"],
            "is_official_garmin_metric": load_ewma["is_official_garmin_metric"],
            "sample_quality": load_ewma["sample_quality"],
            "active_days": load_ewma["active_days"],
            "latest": load_ewma["latest"],
        },
        "hr_zones_distribution": hr_zones,
        "metric_catalog": METRIC_CATALOG,
    }


# ==============================================================================
# DEEP SESSION CLASSIFICATION & INTERVAL / CYCLING ANALYTICS
# ==============================================================================

# Documented thresholds for stream-based interval detection when Garmin/Strava laps are absent:
# - STREAM_WORK_PACE_FACTOR = 0.90: work segment pace must be >= 10% faster than session median pace
# - STREAM_MIN_SEGMENT_SEC = 20.0: segment state must be sustained for > 20 seconds to avoid GPS noise
# - TEMPO_MIN_DURATION_SEC = 720.0: sustained steady block >= 12 minutes at sub-threshold/tempo intensity
STREAM_WORK_PACE_FACTOR = 0.90
STREAM_MIN_SEGMENT_SEC = 20.0
TEMPO_MIN_DURATION_SEC = 720.0


def _fmt_pace_mmss(pace_sec: Optional[float]) -> Optional[str]:
    if pace_sec is None or pace_sec <= 0:
        return None
    s = int(round(float(pace_sec)))
    return f"{s // 60}:{s % 60:02d} /km"


def _median(vals: List[float]) -> float:
    if not vals:
        return 0.0
    s = sorted(vals)
    n = len(s)
    mid = n // 2
    return float(s[mid]) if n % 2 == 1 else (s[mid - 1] + s[mid]) / 2.0


def detect_segments_from_stream(stream: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Detects work and recovery segments directly from time-series stream when device laps are unavailable.
    A work transition requires pace_sec <= median_pace * STREAM_WORK_PACE_FACTOR sustained for > STREAM_MIN_SEGMENT_SEC.
    """
    if not stream or not isinstance(stream, dict):
        return []
    times = stream.get("time_sec") or []
    paces = stream.get("pace_sec") or []
    dists = stream.get("dist_km") or []
    hrs = stream.get("hr") or []
    cads = stream.get("cadence") or []
    pwrs = stream.get("power_w") or []
    elevs = stream.get("elevation_m") or []

    n = min(len(times), len(paces)) if (times and paces) else 0
    if n < 6:
        return []

    valid_paces = [float(p) for p in paces[:n] if p is not None and 120 <= float(p) <= 900]
    if len(valid_paces) < 6:
        return []

    med_pace = _median(valid_paces)
    work_thresh = med_pace * STREAM_WORK_PACE_FACTOR

    raw_states: List[bool] = []
    for i in range(n):
        p = paces[i]
        is_fast = (p is not None and float(p) <= work_thresh)
        raw_states.append(is_fast)

    # Group consecutive states and merge short blips (< STREAM_MIN_SEGMENT_SEC)
    runs: List[Dict[str, Any]] = []
    start_i = 0
    for i in range(1, n + 1):
        if i == n or raw_states[i] != raw_states[start_i]:
            t0 = float(times[start_i] or 0)
            t1 = float(times[i - 1] or t0)
            runs.append({
                "is_work": raw_states[start_i],
                "start_idx": start_i,
                "end_idx": i - 1,
                "dur": max(0.0, t1 - t0),
            })
            start_i = i

    merged: List[Dict[str, Any]] = []
    for seg in runs:
        if merged and seg["dur"] < STREAM_MIN_SEGMENT_SEC:
            merged[-1]["end_idx"] = seg["end_idx"]
            t0 = float(times[merged[-1]["start_idx"]] or 0)
            t1 = float(times[merged[-1]["end_idx"]] or t0)
            merged[-1]["dur"] = max(0.0, t1 - t0)
        elif merged and merged[-1]["is_work"] == seg["is_work"]:
            merged[-1]["end_idx"] = seg["end_idx"]
            t0 = float(times[merged[-1]["start_idx"]] or 0)
            t1 = float(times[merged[-1]["end_idx"]] or t0)
            merged[-1]["dur"] = max(0.0, t1 - t0)
        else:
            merged.append(dict(seg))

    laps: List[Dict[str, Any]] = []
    for idx, seg in enumerate(merged):
        i0, i1 = seg["start_idx"], seg["end_idx"]
        t0 = float(times[i0] or 0)
        t1 = float(times[i1] or t0)
        dur = max(1.0, t1 - t0)
        if idx > 0 and i0 > 0:
            dur = max(1.0, t1 - float(times[i0 - 1] or t0))

        seg_paces = [float(paces[k]) for k in range(i0, i1 + 1) if k < len(paces) and paces[k] is not None and float(paces[k]) > 0]
        avg_pace = round(sum(seg_paces) / len(seg_paces)) if seg_paces else None

        if dists and i1 < len(dists) and i0 < len(dists) and dists[i1] is not None and dists[i0] is not None:
            d_prev = float(dists[i0 - 1]) if (i0 > 0 and dists[i0 - 1] is not None) else float(dists[i0])
            dist_m = max(0.0, (float(dists[i1]) - d_prev) * 1000.0)
        elif avg_pace and avg_pace > 0:
            dist_m = (dur / avg_pace) * 1000.0
        else:
            dist_m = 0.0

        seg_hrs = [float(hrs[k]) for k in range(i0, i1 + 1) if k < len(hrs) and hrs[k] is not None and float(hrs[k]) > 40]
        seg_cads = [float(cads[k]) for k in range(i0, i1 + 1) if k < len(cads) and cads[k] is not None and float(cads[k]) > 0]
        seg_pwrs = [float(pwrs[k]) for k in range(i0, i1 + 1) if k < len(pwrs) and pwrs[k] is not None and float(pwrs[k]) > 0]
        elev_gain = 0.0
        if elevs:
            for k in range(max(1, i0), min(len(elevs), i1 + 1)):
                if elevs[k] is not None and elevs[k - 1] is not None:
                    diff = float(elevs[k]) - float(elevs[k - 1])
                    if diff > 0:
                        elev_gain += diff

        laps.append({
            "index": idx + 1,
            "intent": "INTERVAL" if seg["is_work"] else "RECOVERY",
            "duration_sec": round(dur, 1),
            "distance_m": round(dist_m, 1),
            "avg_speed_mps": round(1000.0 / avg_pace, 3) if avg_pace else None,
            "pace_sec": avg_pace,
            "avg_hr": round(sum(seg_hrs) / len(seg_hrs)) if seg_hrs else None,
            "max_hr": round(max(seg_hrs)) if seg_hrs else None,
            "cadence": round(sum(seg_cads) / len(seg_cads)) if seg_cads else None,
            "avg_power_w": round(sum(seg_pwrs) / len(seg_pwrs), 1) if seg_pwrs else None,
            "elevation_gain_m": round(elev_gain, 1),
            "start_time_sec": round(t0, 1),
            "end_time_sec": round(t1, 1),
            "start_idx": i0,
            "end_idx": i1,
            "source": "stream",
        })
    return laps


def _has_real_power(laps: Optional[List[Dict[str, Any]]], stream: Optional[Dict[str, Any]]) -> bool:
    if stream and isinstance(stream, dict):
        pwrs = [p for p in (stream.get("power_w") or []) if p is not None and float(p) > 0]
        if len(pwrs) >= 5:
            return True
    if laps:
        lap_pwrs = [l.get("avg_power_w") for l in laps if l.get("avg_power_w") is not None and float(l.get("avg_power_w") or 0) > 0]
        if len(lap_pwrs) >= 1:
            return True
    return False


def classify_session(
    activity: Dict[str, Any],
    laps: Optional[List[Dict[str, Any]]] = None,
    stream: Optional[Dict[str, Any]] = None,
    planned_day: Optional[Dict[str, Any]] = None,
) -> str:
    """
    Classifies an activity into one of:
    'rodaje', 'series', 'tempo', 'fartlek', 'bici_potencia', 'bici_sin_potencia', 'fuerza', 'otro'.
    """
    sport = (activity.get("sport_type") or activity.get("tipo") or "").strip()
    name_low = f"{activity.get('name') or activity.get('nombre') or ''} {(planned_day or {}).get('titulo') or ''}".lower()

    if sport == "Fuerza" or "fuerza" in sport.lower():
        return "fuerza"

    if sport == "Ciclismo" or "bici" in sport.lower() or "cycl" in sport.lower():
        return "bici_potencia" if _has_real_power(laps, stream) else "bici_sin_potencia"

    if sport != "Carrera" and "run" not in sport.lower():
        return "otro"

    eff_laps = laps if (laps and len(laps) >= 2) else detect_segments_from_stream(stream)
    lap_paces = [float(l["pace_sec"]) for l in eff_laps if l.get("pace_sec") and float(l["pace_sec"]) > 0]

    if len(eff_laps) >= 3 and len(lap_paces) >= 3:
        med_p = _median(lap_paces)
        fast_thresh = med_p * 0.93
        work_laps = []
        transitions = 0
        prev_fast = None
        for l in eff_laps:
            p = float(l.get("pace_sec") or 0)
            intent = str(l.get("intent") or "").upper()
            is_fast = (intent in ("INTERVAL", "ACTIVE", "WORK") and p <= med_p * 0.96) or (0 < p <= fast_thresh)
            if is_fast:
                work_laps.append(l)
            if prev_fast is not None and is_fast != prev_fast:
                transitions += 1
            prev_fast = is_fast

        if len(work_laps) >= 2 and transitions >= 3:
            if "fartlek" in name_low:
                return "fartlek"
            durs = [float(l.get("duration_sec") or 0) for l in work_laps if float(l.get("duration_sec") or 0) > 0]
            if len(durs) >= 3:
                mean_d = sum(durs) / len(durs)
                std_d = (sum((d - mean_d) ** 2 for d in durs) / len(durs)) ** 0.5
                if mean_d > 0 and (std_d / mean_d) > 0.35:
                    return "fartlek"
            return "series"
        if len(work_laps) == 1 and float(work_laps[0].get("duration_sec") or 0) >= TEMPO_MIN_DURATION_SEC:
            return "tempo"

    if "fartlek" in name_low:
        return "fartlek"
    if any(k in name_low for k in ("serie", "interval", "repeticion", "x400", "x800", "x1000")):
        return "series"
    if any(k in name_low for k in ("tempo", "umbral", "controlado")):
        return "tempo"

    # Detect sustained tempo block from stream or laps (>= 12 min steady fast block with low CV)
    if stream and isinstance(stream, dict):
        paces = [float(p) for p in (stream.get("pace_sec") or []) if p is not None and 150 <= float(p) <= 600]
        times = [float(t) for t in (stream.get("time_sec") or []) if t is not None]
        hrs = [float(h) for h in (stream.get("hr") or []) if h is not None and float(h) > 40]
        total_dur = (times[-1] - times[0]) if len(times) >= 2 else float(activity.get("duration_min") or 0) * 60.0
        if len(paces) >= 12 and total_dur >= TEMPO_MIN_DURATION_SEC:
            # Check middle 60% of the session for steady tempo effort
            i0 = int(len(paces) * 0.2)
            i1 = int(len(paces) * 0.8)
            mid_p = paces[i0:i1]
            if len(mid_p) >= 6:
                mean_mid = sum(mid_p) / len(mid_p)
                std_mid = (sum((x - mean_mid) ** 2 for x in mid_p) / len(mid_p)) ** 0.5
                cv_mid = std_mid / mean_mid if mean_mid > 0 else 1.0
                edge_p = paces[:i0] + paces[i1:]
                mean_edge = (sum(edge_p) / len(edge_p)) if edge_p else mean_mid
                mean_hr = (sum(hrs[i0:i1]) / len(hrs[i0:i1])) if len(hrs) >= i1 and i1 > i0 else float(activity.get("avg_hr") or 0)
                if cv_mid <= 0.055 and (mean_mid <= mean_edge * 0.93 or mean_hr >= 158):
                    return "tempo"

    return "rodaje"


def _parse_target_pace_range_sec(text: str) -> Optional[Tuple[float, float]]:
    if not text:
        return None
    import re
    m = re.search(r"(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})", str(text))
    if m:
        s1 = int(m.group(1)) * 60 + int(m.group(2))
        s2 = int(m.group(3)) * 60 + int(m.group(4))
        return (float(min(s1, s2)), float(max(s1, s2)))
    m_single = re.search(r"(\d{1,2}):(\d{2})\s*/?km", str(text))
    if m_single:
        s = int(m_single.group(1)) * 60 + int(m_single.group(2))
        return (float(s - 5), float(s + 5))
    return None


def compute_normalized_power(
    power_series: List[Optional[float]],
    time_series: Optional[List[Optional[float]]] = None,
) -> Optional[float]:
    """
    Computes Normalized Power (NP): 30-second rolling average of power raised to the 4th power,
    averaged and taken to the 1/4th root. For constant power P, NP == P.
    """
    if not power_series:
        return None
    valid_pairs: List[Tuple[float, float]] = []
    t_acc = 0.0
    for i, p in enumerate(power_series):
        if p is None:
            continue
        val = max(0.0, float(p))
        if time_series and i < len(time_series) and time_series[i] is not None:
            t_acc = float(time_series[i])
        else:
            t_acc = float(i)
        valid_pairs.append((t_acc, val))

    if len(valid_pairs) < 4:
        return None
    total_dur = valid_pairs[-1][0] - valid_pairs[0][0]
    if total_dur < 30.0:
        mean_p = sum(v for _, v in valid_pairs) / len(valid_pairs)
        return round(mean_p, 1)

    rolling_30s: List[float] = []
    left = 0
    window_sum = 0.0
    for right in range(len(valid_pairs)):
        t_r, p_r = valid_pairs[right]
        window_sum += p_r
        while left < right and (t_r - valid_pairs[left][0]) > 30.0:
            window_sum -= valid_pairs[left][1]
            left += 1
        if (t_r - valid_pairs[0][0]) >= 30.0 or right == len(valid_pairs) - 1:
            count = max(1, right - left + 1)
            rolling_30s.append(window_sum / count)

    if not rolling_30s:
        return None
    mean_p4 = sum(r ** 4 for r in rolling_30s) / len(rolling_30s)
    return round(mean_p4 ** 0.25, 1)


def compute_best_power_efforts(
    power_series: List[Optional[float]],
    time_series: Optional[List[Optional[float]]] = None,
) -> Dict[str, Optional[float]]:
    """Computes peak average power (W) for 5s, 1m (60s), 5m (300s), and 20m (1200s)."""
    windows = {"5s": 5.0, "1m": 60.0, "5m": 300.0, "20m": 1200.0}
    out: Dict[str, Optional[float]] = {k: None for k in windows}
    if not power_series:
        return out

    pts: List[Tuple[float, float]] = []
    for i, p in enumerate(power_series):
        if p is None:
            continue
        t = float(time_series[i]) if (time_series and i < len(time_series) and time_series[i] is not None) else float(i)
        pts.append((t, max(0.0, float(p))))

    if len(pts) < 2:
        return out
    total_span = pts[-1][0] - pts[0][0]

    for label, win_sec in windows.items():
        if total_span < win_sec * 0.92:
            out[label] = None
            continue
        best_w: Optional[float] = None
        left = 0
        w_sum = 0.0
        for right in range(len(pts)):
            w_sum += pts[right][1]
            while left < right and (pts[right][0] - pts[left][0]) >= win_sec:
                count = max(1, right - left + 1)
                avg_w = w_sum / count
                if best_w is None or avg_w > best_w:
                    best_w = avg_w
                w_sum -= pts[left][1]
                left += 1
        out[label] = round(best_w, 1) if best_w is not None else None
    return out


def _estimate_hr_recovery_from_stream(
    stream: Optional[Dict[str, Any]],
    rest_start_sec: float,
    rest_end_sec: float,
) -> Tuple[Optional[int], Optional[int]]:
    """
    Computes (hr_drop_first_60s_bpm, next_interval_start_hr) during a rest window [rest_start_sec, rest_end_sec].
    """
    if not stream or not isinstance(stream, dict):
        return (None, None)
    times = stream.get("time_sec") or []
    hrs = stream.get("hr") or []
    n = min(len(times), len(hrs))
    if n < 4:
        return (None, None)

    window_pts = [
        (float(times[i]), float(hrs[i]))
        for i in range(n)
        if times[i] is not None and hrs[i] is not None and float(hrs[i]) > 40
        and (rest_start_sec - 3.0) <= float(times[i]) <= (rest_end_sec + 3.0)
    ]
    if len(window_pts) < 2:
        return (None, None)

    start_hr = window_pts[0][1]
    end_60_t = min(rest_end_sec, rest_start_sec + 60.0)
    pts_60 = [h for t, h in window_pts if t <= end_60_t + 3.0]
    min_60_hr = pts_60[-1] if pts_60 else window_pts[-1][1]
    drop_60 = round(start_hr - min_60_hr)
    next_start_hr = round(window_pts[-1][1])
    return (drop_60, next_start_hr)


def analyze_activity_deep(
    activity: Dict[str, Any],
    laps: Optional[List[Dict[str, Any]]] = None,
    stream: Optional[Dict[str, Any]] = None,
    planned_day: Optional[Dict[str, Any]] = None,
    athlete_ftp: Optional[float] = None,
) -> Dict[str, Any]:
    """
    Full Step 2 & Step 3 analysis for intervals/series, tempo, steady runs, and cycling (with or without power).
    Returns {activity_id, tipo, fuente, metricas, series_o_laps, calentamiento, enfriamiento, avisos}.
    Never invents missing values; missing metrics are None with explicit warnings in 'avisos'.
    """
    avisos: List[str] = []
    raw_laps = [dict(l) for l in (laps or []) if isinstance(l, dict)]
    if raw_laps:
        src = str(raw_laps[0].get("source") or "laps_garmin")
        fuente = src if src in ("laps_garmin", "laps_strava") else "laps_garmin"
        eff_laps = raw_laps
    else:
        fuente = "stream"
        eff_laps = detect_segments_from_stream(stream)
        if not eff_laps:
            avisos.append("Sin vueltas registradas ni stream de alta resolución: análisis basado en métricas globales.")

    tipo = classify_session(activity, laps=eff_laps, stream=stream, planned_day=planned_day)
    act_id = str(activity.get("external_id") or activity.get("id") or "")
    print(f"[Analytics] Activity {act_id} classified as '{tipo}' using fuente='{fuente}' (laps={len(eff_laps)})")

    warmup_summary: Optional[Dict[str, Any]] = None
    cooldown_summary: Optional[Dict[str, Any]] = None
    series_out: List[Dict[str, Any]] = []
    metricas: Dict[str, Any] = {}

    if tipo in ("series", "fartlek"):
        lap_paces = [float(l["pace_sec"]) for l in eff_laps if l.get("pace_sec") and float(l["pace_sec"]) > 0]
        med_p = _median(lap_paces) if lap_paces else 0.0
        fast_thresh = med_p * 0.94 if med_p > 0 else 0.0

        # Identify work vs rest laps; separate leading warmup and trailing cooldown
        tagged: List[Dict[str, Any]] = []
        cum_t = 0.0
        for idx, l in enumerate(eff_laps):
            dur = float(l.get("duration_sec") or 0)
            t0 = float(l.get("start_time_sec")) if l.get("start_time_sec") is not None else cum_t
            t1 = float(l.get("end_time_sec")) if l.get("end_time_sec") is not None else (t0 + dur)
            cum_t = t1
            p = float(l.get("pace_sec") or 0)
            intent = str(l.get("intent") or "").upper()
            is_work = (intent in ("INTERVAL", "ACTIVE", "WORK") and (med_p == 0 or p <= med_p * 0.97)) or (0 < p <= fast_thresh)
            item = dict(l)
            item["start_time_sec"] = round(t0, 1)
            item["end_time_sec"] = round(t1, 1)
            item["role"] = "work" if is_work else "recovery"
            item["pace_str"] = _fmt_pace_mmss(p) if p > 0 else None
            tagged.append(item)

        if tagged and tagged[0]["role"] == "recovery":
            tagged[0]["role"] = "warmup"
            w = tagged[0]
            warmup_summary = {
                "duration_sec": w.get("duration_sec"),
                "distance_m": w.get("distance_m"),
                "pace_sec": w.get("pace_sec"),
                "pace_str": w.get("pace_str"),
                "avg_hr": w.get("avg_hr"),
            }
        if len(tagged) >= 2 and tagged[-1]["role"] == "recovery":
            tagged[-1]["role"] = "cooldown"
            c = tagged[-1]
            cooldown_summary = {
                "duration_sec": c.get("duration_sec"),
                "distance_m": c.get("distance_m"),
                "pace_sec": c.get("pace_sec"),
                "pace_str": c.get("pace_str"),
                "avg_hr": c.get("avg_hr"),
            }

        work_reps: List[Dict[str, Any]] = []
        rep_counter = 0
        for i, item in enumerate(tagged):
            if item["role"] == "work":
                rep_counter += 1
                item["rep_num"] = rep_counter
                # Look ahead to next recovery lap for HR recovery metrics
                drop_60, next_hr = (None, None)
                if i + 1 < len(tagged) and tagged[i + 1]["role"] in ("recovery", "cooldown"):
                    nxt = tagged[i + 1]
                    drop_60, next_hr = _estimate_hr_recovery_from_stream(
                        stream, float(nxt["start_time_sec"]), float(nxt["end_time_sec"])
                    )
                    if drop_60 is None and item.get("avg_hr") and nxt.get("avg_hr"):
                        drop_60 = round(float(item["avg_hr"]) - float(nxt["avg_hr"]))
                    if next_hr is None and i + 2 < len(tagged) and tagged[i + 2].get("avg_hr"):
                        next_hr = round(float(tagged[i + 2]["avg_hr"]))
                item["recovery_drop_60s_bpm"] = drop_60
                item["next_start_hr"] = next_hr
                work_reps.append(item)
            series_out.append(item)

        w_paces = [float(r["pace_sec"]) for r in work_reps if r.get("pace_sec")]
        w_hrs = [float(r["avg_hr"]) for r in work_reps if r.get("avg_hr")]
        w_max_hrs = [float(r["max_hr"]) for r in work_reps if r.get("max_hr")]
        w_cads = [float(r["cadence"]) for r in work_reps if r.get("cadence")]
        w_drops = [float(r["recovery_drop_60s_bpm"]) for r in work_reps if r.get("recovery_drop_60s_bpm") is not None]
        w_next_hrs = [float(r["next_start_hr"]) for r in work_reps if r.get("next_start_hr") is not None]

        avg_w_pace = round(sum(w_paces) / len(w_paces), 1) if w_paces else None
        pace_cv_pct: Optional[float] = None
        if len(w_paces) >= 2 and avg_w_pace and avg_w_pace > 0:
            std_p = (sum((p - avg_w_pace) ** 2 for p in w_paces) / len(w_paces)) ** 0.5
            pace_cv_pct = round((std_p / avg_w_pace) * 100.0, 2)

        fatigue_sec = round(w_paces[-1] - w_paces[0], 1) if len(w_paces) >= 2 else None
        hr_drift_bpm = round(w_hrs[-1] - w_hrs[0], 1) if len(w_hrs) >= 2 else None

        # Compare against planned target pace if available
        target_range = None
        if planned_day:
            for ph in (planned_day.get("phases") or []):
                if str(ph.get("type") or "").upper() == "WORK" and ph.get("target_pace"):
                    target_range = _parse_target_pace_range_sec(ph["target_pace"])
                    if target_range:
                        break
            if not target_range:
                target_range = _parse_target_pace_range_sec(
                    f"{planned_day.get('detalle') or ''} {planned_day.get('zona_objetivo') or ''}"
                )

        plan_compliance: Optional[Dict[str, Any]] = None
        if target_range and w_paces:
            t_min, t_max = target_range
            in_target = sum(1 for p in w_paces if (t_min - 3.0) <= p <= (t_max + 3.0))
            t_mid = (t_min + t_max) / 2.0
            plan_compliance = {
                "target_pace_str": f"{_fmt_pace_mmss(t_min)} – {_fmt_pace_mmss(t_max)}",
                "in_target_reps": in_target,
                "total_reps": len(w_paces),
                "compliance_pct": round((in_target / len(w_paces)) * 100.0),
                "diff_vs_target_sec": round(avg_w_pace - t_mid, 1) if avg_w_pace else None,
            }

        if not w_hrs:
            avisos.append("Sin datos de frecuencia cardíaca en las repeticiones.")

        metricas = {
            "repeticiones_trabajo": len(work_reps),
            "ritmo_medio_trabajo_sec": avg_w_pace,
            "ritmo_medio_trabajo_str": _fmt_pace_mmss(avg_w_pace),
            "fc_media_trabajo": round(sum(w_hrs) / len(w_hrs)) if w_hrs else None,
            "fc_max_trabajo": round(max(w_max_hrs)) if w_max_hrs else (round(max(w_hrs)) if w_hrs else None),
            "cadencia_media_trabajo": round(sum(w_cads) / len(w_cads)) if w_cads else None,
            "consistencia_cv_pct": pace_cv_pct,
            "rango_ritmo_sec": round(max(w_paces) - min(w_paces), 1) if len(w_paces) >= 2 else None,
            "fatiga_primera_vs_ultima_sec": fatigue_sec,
            "deriva_fc_primera_vs_ultima_bpm": hr_drift_bpm,
            "recuperacion_caida_60s_media_bpm": round(sum(w_drops) / len(w_drops), 1) if w_drops else None,
            "fc_inicio_siguiente_serie_media": round(sum(w_next_hrs) / len(w_next_hrs)) if w_next_hrs else None,
            "cumplimiento_plan": plan_compliance,
        }

    elif tipo in ("tempo", "rodaje"):
        paces = [float(p) for p in ((stream or {}).get("pace_sec") or []) if p is not None and 140 <= float(p) <= 720]
        hrs = [float(h) for h in ((stream or {}).get("hr") or []) if h is not None and float(h) > 40]
        avg_p = round(sum(paces) / len(paces), 1) if paces else None
        cv_pct = None
        if len(paces) >= 4 and avg_p:
            std_p = (sum((x - avg_p) ** 2 for x in paces) / len(paces)) ** 0.5
            cv_pct = round((std_p / avg_p) * 100.0, 2)
        drift_bpm = None
        if len(hrs) >= 6:
            mid = len(hrs) // 2
            drift_bpm = round((sum(hrs[mid:]) / len(hrs[mid:])) - (sum(hrs[:mid]) / len(hrs[:mid])), 1)
        series_out = eff_laps
        metricas = {
            "ritmo_medio_sec": avg_p,
            "ritmo_medio_str": _fmt_pace_mmss(avg_p) or activity.get("avg_pace_str"),
            "fc_media": round(sum(hrs) / len(hrs)) if hrs else activity.get("avg_hr"),
            "fc_max": round(max(hrs)) if hrs else activity.get("max_hr"),
            "estabilidad_ritmo_cv_pct": cv_pct,
            "deriva_fc_mitades_bpm": drift_bpm,
        }

    elif tipo in ("bici_potencia", "bici_sin_potencia"):
        series_out = eff_laps
        pwrs = (stream or {}).get("power_w") or []
        times = (stream or {}).get("time_sec") or []
        hrs = (stream or {}).get("hr") or []
        elevs = (stream or {}).get("elevation_m") or []
        dists = (stream or {}).get("dist_km") or []
        dur_min = float(activity.get("duration_min") or 0)
        dist_km = float(activity.get("distance_km") or 0)
        elev_m = float(activity.get("elevation_gain") or 0)
        dur_sec = (float(times[-1]) - float(times[0])) if (len(times) >= 2 and times[-1] is not None and times[0] is not None) else (dur_min * 60.0)

        avg_speed_kmh = round((dist_km / (dur_sec / 3600.0)), 1) if (dur_sec > 0 and dist_km > 0) else None
        vam_mh = round(elev_m / (dur_sec / 3600.0)) if (elev_m > 20 and dur_sec > 0) else None

        if tipo == "bici_potencia":
            valid_pwrs = [float(p) for p in pwrs if p is not None and float(p) >= 0]
            if not valid_pwrs and eff_laps:
                valid_pwrs = [float(l["avg_power_w"]) for l in eff_laps if l.get("avg_power_w") is not None]
            avg_pwr = round(sum(valid_pwrs) / len(valid_pwrs), 1) if valid_pwrs else None
            np_w = compute_normalized_power(pwrs, times) if len(valid_pwrs) >= 4 else avg_pwr
            best_efforts = compute_best_power_efforts(pwrs, times)
            est_ftp = round(best_efforts["20m"] * 0.95, 1) if best_efforts.get("20m") is not None else None

            if_val: Optional[float] = None
            tss_val: Optional[float] = None
            if athlete_ftp and float(athlete_ftp) > 0 and np_w is not None:
                ftp_f = float(athlete_ftp)
                if_val = round(np_w / ftp_f, 3)
                if dur_sec > 0:
                    tss_val = round(((dur_sec * np_w * if_val) / (ftp_f * 3600.0)) * 100.0, 1)
            else:
                avisos.append("FTP no configurado en el perfil del atleta: no se calculan IF ni TSS.")

            valid_hrs = [float(h) for h in hrs if h is not None and float(h) > 40]
            avg_hr = (sum(valid_hrs) / len(valid_hrs)) if valid_hrs else (float(activity["avg_hr"]) if activity.get("avg_hr") else None)
            ef_w_hr = round(avg_pwr / avg_hr, 2) if (avg_pwr and avg_hr and avg_hr > 0) else None

            decoupling_pct: Optional[float] = None
            paired = [
                (float(pwrs[i]), float(hrs[i]))
                for i in range(min(len(pwrs), len(hrs)))
                if pwrs[i] is not None and hrs[i] is not None and float(pwrs[i]) > 0 and float(hrs[i]) > 40
            ]
            if len(paired) >= 8:
                mid = len(paired) // 2
                p1, h1 = sum(x[0] for x in paired[:mid]) / mid, sum(x[1] for x in paired[:mid]) / mid
                p2, h2 = sum(x[0] for x in paired[mid:]) / (len(paired) - mid), sum(x[1] for x in paired[mid:]) / (len(paired) - mid)
                ef1 = p1 / h1 if h1 > 0 else 0
                ef2 = p2 / h2 if h2 > 0 else 0
                if ef1 > 0:
                    decoupling_pct = round(((ef1 - ef2) / ef1) * 100.0, 2)

            metricas = {
                "potencia_media_w": avg_pwr,
                "potencia_normalizada_np_w": np_w,
                "ftp_perfil_w": float(athlete_ftp) if athlete_ftp else None,
                "factor_intensidad_if": if_val,
                "tss": tss_val,
                "eficiencia_w_fc": ef_w_hr,
                "desacoplamiento_potencia_fc_pct": decoupling_pct,
                "mejores_esfuerzos_w": best_efforts,
                "ftp_estimado_20m_w": est_ftp,
                "ftp_estimado_nota": "Estimación (95% del mejor esfuerzo de 20 min)" if est_ftp else None,
                "velocidad_media_kmh": avg_speed_kmh,
                "vam_mh": vam_mh,
            }
        else:
            avisos.append("Sin potencia en esta actividad: análisis limitado a velocidad, VAM, desnivel y frecuencia cardíaca.")
            # HR by grade bands (<2% llano, 2-6% subida moderada, >6% subida pronunciada)
            grade_hrs: Dict[str, List[float]] = {"llano": [], "subida_moderada": [], "subida_fuerte": []}
            n_g = min(len(dists), len(elevs), len(hrs))
            for i in range(1, n_g):
                if dists[i] is None or dists[i - 1] is None or elevs[i] is None or elevs[i - 1] is None or hrs[i] is None:
                    continue
                dd_m = (float(dists[i]) - float(dists[i - 1])) * 1000.0
                if dd_m < 5.0:
                    continue
                grade_pct = ((float(elevs[i]) - float(elevs[i - 1])) / dd_m) * 100.0
                h_val = float(hrs[i])
                if h_val <= 40:
                    continue
                if grade_pct < 2.0:
                    grade_hrs["llano"].append(h_val)
                elif grade_pct <= 6.0:
                    grade_hrs["subida_moderada"].append(h_val)
                else:
                    grade_hrs["subida_fuerte"].append(h_val)

            metricas = {
                "potencia_media_w": None,
                "potencia_normalizada_np_w": None,
                "factor_intensidad_if": None,
                "tss": None,
                "mejores_esfuerzos_w": None,
                "ftp_estimado_20m_w": None,
                "velocidad_media_kmh": avg_speed_kmh,
                "vam_mh": vam_mh,
                "fc_media": activity.get("avg_hr"),
                "fc_max": activity.get("max_hr"),
                "fc_por_pendiente": {
                    k: (round(sum(v) / len(v)) if v else None)
                    for k, v in grade_hrs.items()
                },
                "analisis_limitado": True,
            }
    else:
        series_out = eff_laps
        metricas = {
            "duracion_min": activity.get("duration_min"),
            "fc_media": activity.get("avg_hr"),
        }

    return {
        "activity_id": act_id,
        "tipo": tipo,
        "fuente": fuente,
        "metricas": metricas,
        "series_o_laps": series_out,
        "calentamiento": warmup_summary,
        "enfriamiento": cooldown_summary,
        "avisos": avisos,
    }


