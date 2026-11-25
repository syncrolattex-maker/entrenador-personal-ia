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
