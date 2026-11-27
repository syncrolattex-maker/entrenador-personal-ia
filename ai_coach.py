"""
ai_coach.py — Phase 4: Grounded Gemini AI Interpretation Layer for AaronFit.
Consumes ONLY the aggregated, sanitized output of analytics_engine.build_ai_ready_analytics_snapshot().
Never accesses GPS coordinates, polylines, passwords, tokens, private notes, or raw payloads.
"""
import json
import os
import time
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field
import perf_monitor

try:
    from google import genai
    from google.genai import types
    HAS_GENAI = True
except ImportError:
    genai = None  # type: ignore
    types = None  # type: ignore
    HAS_GENAI = False


_FORBIDDEN_KEYS = {
    "polyline", "polyline_json", "lat", "lon", "latitude", "longitude",
    "password", "token", "access_token", "refresh_token", "api_key",
    "private_notes", "raw_payload", "raw_payload_json", "email", "secret",
}

_AI_CACHE: Dict[str, Any] = {"key": None, "expires_at": 0.0, "data": None}


def invalidate_ai_cache() -> None:
    """Clears the in-memory and DB AI interpretation cache when sports/wellness data updates."""
    _AI_CACHE.update({"key": None, "expires_at": 0.0, "data": None})
    try:
        import database
        database.set_setting("analytics_ai_cache_v1", "")
        database.set_setting("wellness_ai_cache_v1", "")
    except Exception:
        pass


class AnalyticsInterpretationResponse(BaseModel):
    resumen_estado_deportivo: str = Field(..., description="Resumen claro del estado deportivo actual basado en los datos.")
    evolucion: str = Field(..., description="Comparativa real entre periodos (semana, mes, 3m, 6m, 12m) citando fechas y deltas.")
    eficiencia: str = Field(..., description="Interpretación de la eficiencia aeróbica (velocidad vs FC) o aviso de muestra insuficiente.")
    carga: str = Field(..., description="Análisis de carga (CTL, ATL, TSB) y tendencias de recuperación, aclarando que es cálculo propio de AaronFit.")
    puntos_fuertes: List[str] = Field(default_factory=list, description="Aspectos positivos respaldados por cifras reales.")
    aspectos_a_mejorar: List[str] = Field(default_factory=list, description="Aspectos a vigilar o mejorar según los indicadores.")
    conclusion: str = Field(..., description="Conclusión global comprensible y prudente (sin diagnósticos médicos).")
    periodos_evaluados: List[str] = Field(default_factory=list, description="Lista exacta de periodos analizados.")
    indicadores_utilizados: List[str] = Field(default_factory=list, description="Indicadores reales y calculados citados.")
    datos_insuficientes: bool = Field(default=False, description="True si la muestra es insuficiente para afirmar tendencias.")


def sanitize_snapshot_for_gemini(obj: Any) -> Any:
    """Recursively strips any sensitive or geographical fields before sending data to Gemini."""
    if isinstance(obj, dict):
        return {
            k: sanitize_snapshot_for_gemini(v)
            for k, v in obj.items()
            if str(k).lower() not in _FORBIDDEN_KEYS
        }
    if isinstance(obj, list):
        return [sanitize_snapshot_for_gemini(x) for x in obj]
    return obj


def _deterministic_fallback_interpretation(snapshot: Dict[str, Any], mode: str = "deterministic_fallback") -> Dict[str, Any]:
    """Produces a strictly data-grounded interpretation when Gemini is unavailable or returns invalid output."""
    scope = snapshot.get("data_scope") or {}
    total_acts = int(scope.get("activities_analyzed") or 0)
    comps = snapshot.get("comparisons") or {}
    eff = snapshot.get("aerobic_efficiency") or {}
    load = snapshot.get("training_load") or {}
    latest = load.get("latest") or {}

    if total_acts == 0:
        return {
            "resumen_estado_deportivo": "No hay actividades suficientes registradas en el periodo evaluado para determinar el estado deportivo.",
            "evolucion": "Sin actividad registrada para comparar periodos.",
            "eficiencia": "Muestra insuficiente: se requieren al menos 3 carreras comparables en cada ventana de 6 semanas.",
            "carga": "Sin datos suficientes para calcular CTL/ATL/TSB.",
            "puntos_fuertes": [],
            "aspectos_a_mejorar": ["Sincroniza tus actividades de Garmin Connect para iniciar el seguimiento."],
            "conclusion": "Datos insuficientes para emitir conclusiones de evolución deportiva.",
            "periodos_evaluados": [],
            "indicadores_utilizados": [],
            "datos_insuficientes": True,
            "source_mode": mode,
        }

    w = comps.get("week") or {}
    m12 = comps.get("months_12") or {}
    w_curr = w.get("current") or {}
    w_prev = w.get("previous") or {}
    w_del = w.get("deltas") or {}
    m12_del = m12.get("deltas") or {}

    ctl = latest.get("ctl", 0.0)
    atl = latest.get("atl", 0.0)
    tsb = latest.get("tsb", 0.0)
    load_q = load.get("sample_quality", "insufficient")

    dist_pct_w = w_del.get("distance_pct")
    dist_pct_12 = m12_del.get("distance_pct")
    pace_diff_12 = m12_del.get("run_pace_sec_diff")

    puntos: List[str] = []
    mejoras: List[str] = []

    if dist_pct_12 is not None and dist_pct_12 > 0:
        puntos.append(f"Volumen anual acumulado +{dist_pct_12}% ({m12_del.get('distance_km_diff')} km adicionales en los últimos 12 meses).")
    if pace_diff_12 is not None and pace_diff_12 < 0:
        puntos.append(f"Ritmo medio en carrera más rápido en {abs(pace_diff_12)} s/km respecto a los 12 meses previos.")
    if eff.get("status") == "ok" and eff.get("ef_change_pct") is not None and eff["ef_change_pct"] >= 2.5:
        puntos.append(eff.get("conclusion", ""))
    if not puntos:
        puntos.append(f"Constancia registrada: {total_acts} actividades analizadas en la ventana histórica.")

    if tsb < -10:
        mejoras.append(f"Fatiga aguda elevada (TSB calculado = {tsb}): conviene vigilar la recuperación antes de añadir más intensidad.")
    if eff.get("status") == "insufficient_sample":
        mejoras.append("Faltan sesiones comparables de carrera con pulso para evaluar la eficiencia aeróbica.")
    if not mejoras:
        mejoras.append("Mantener la progresión gradual de volumen semanal sin saltos bruscos.")

    return {
        "resumen_estado_deportivo": f"Se han analizado {total_acts} actividades reales de Garmin. Esta semana acumulas {w_curr.get('distance_km', 0)} km ({w_curr.get('activities_count', 0)} sesiones) frente a {w_prev.get('distance_km', 0)} km la semana anterior.",
        "evolucion": f"Comparativa 12 meses: variación de volumen {dist_pct_12 if dist_pct_12 is not None else 'N/D'}% y variación de ritmo en carrera {pace_diff_12 if pace_diff_12 is not None else 'N/D'} s/km.",
        "eficiencia": eff.get("conclusion") or "Muestra insuficiente para evaluar eficiencia aeróbica.",
        "carga": f"Cálculo propio AaronFit (Banister EWMA, no oficial Garmin, calidad {load_q}): CTL={ctl}, ATL={atl}, TSB={tsb}.",
        "puntos_fuertes": puntos,
        "aspectos_a_mejorar": mejoras,
        "conclusion": f"Estado general basado en datos reales hasta {snapshot.get('reference_date')}: carga equilibrada y evolución respaldada por histórico.",
        "periodos_evaluados": [
            f"Semana actual ({(w_curr.get('period') or {}).get('start')} a {(w_curr.get('period') or {}).get('end')})",
            "Últimos 12 meses vs 12 meses previos",
            "Eficiencia aeróbica (6 semanas vs 6 semanas previas)",
        ],
        "indicadores_utilizados": [
            "Distancia (Garmin real)",
            "Duración (Garmin real)",
            "Ritmo medio y FC media (Garmin real)",
            "Eficiencia aeróbica EF (cálculo AaronFit)",
            "CTL/ATL/TSB Banister EWMA (cálculo AaronFit)",
        ],
        "datos_insuficientes": load_q == "insufficient" and eff.get("status") == "insufficient_sample",
        "source_mode": mode,
    }


def generate_analytics_interpretation(
    snapshot: Dict[str, Any],
    use_cache: bool = True,
    cache_ttl_sec: int = 300,
) -> Dict[str, Any]:
    """
    Calls Gemini server-side using ONLY the sanitized analytics_engine snapshot.
    Falls back cleanly to deterministic grounded interpretation on error, timeout, or invalid JSON.
    """
    sanitized = sanitize_snapshot_for_gemini(snapshot)
    cache_key = json.dumps(
        {
            "ref": sanitized.get("reference_date"),
            "acts": (sanitized.get("data_scope") or {}).get("activities_analyzed"),
            "latest_load": (sanitized.get("training_load") or {}).get("latest"),
            "eff": (sanitized.get("aerobic_efficiency") or {}).get("ef_change_pct"),
        },
        sort_keys=True,
    )

    now = time.time()
    if use_cache and _AI_CACHE["key"] == cache_key and now < _AI_CACHE["expires_at"] and _AI_CACHE["data"]:
        perf_monitor.mark_cache_hit(True)
        return _AI_CACHE["data"]

    if use_cache:
        try:
            import database
            raw_db_cache = database.get_setting("analytics_ai_cache_v1")
            if raw_db_cache:
                db_obj = json.loads(raw_db_cache)
                if (
                    isinstance(db_obj, dict)
                    and db_obj.get("key") == cache_key
                    and now < float(db_obj.get("expires_at") or 0)
                    and isinstance(db_obj.get("data"), dict)
                ):
                    _AI_CACHE.update({"key": cache_key, "expires_at": float(db_obj["expires_at"]), "data": db_obj["data"]})
                    perf_monitor.mark_cache_hit(True)
                    return db_obj["data"]
        except Exception:
            pass

    if (sanitized.get("data_scope") or {}).get("activities_analyzed", 0) == 0:
        res = _deterministic_fallback_interpretation(sanitized, mode="insufficient_data")
        return res

    api_key = os.getenv("GEMINI_API_KEY", "").strip()
    if not HAS_GENAI or not api_key:
        res = _deterministic_fallback_interpretation(sanitized, mode="deterministic_no_key")
        if use_cache:
            _AI_CACHE.update({"key": cache_key, "expires_at": now + cache_ttl_sec, "data": res})
        return res

    system_instruction = (
        "Eres el analista deportivo de AaronFit. Interpreta ÚNICAMENTE los indicadores reales del JSON adjunto.\n"
        "REGLAS ESTRICTAS:\n"
        "1. Usa SOLO cifras y periodos presentes en el JSON. Prohibido inventar datos, porcentajes o tendencias.\n"
        "2. Cita los periodos evaluados y los indicadores utilizados.\n"
        "3. Diferencia explícitamente entre datos reales de Garmin (distancia, duración, ritmo, FC) y cálculos propios de AaronFit (Eficiencia Aeróbica EF y CTL/ATL/TSB Banister EWMA).\n"
        "4. Si algún indicador tiene status='insufficient_sample' o sample_quality='insufficient', dilo expresamente.\n"
        "5. No realices diagnósticos médicos ni recomendaciones arriesgadas."
    )

    try:
        with perf_monitor.measure_stage("gemini_ms"):
            client = genai.Client(api_key=api_key, http_options={"timeout": 20000})
            resp = client.models.generate_content(
                model="gemini-2.5-flash",
                contents=f"Analiza este snapshot del motor analítico AaronFit:\n{json.dumps(sanitized, ensure_ascii=False)}",
                config=types.GenerateContentConfig(
                    system_instruction=system_instruction,
                    response_mime_type="application/json",
                    response_schema=AnalyticsInterpretationResponse,
                    temperature=0.2,
                ),
            )
        parsed = json.loads(resp.text)
        validated = AnalyticsInterpretationResponse(**parsed).model_dump()
        validated["source_mode"] = "gemini_live"
        if use_cache:
            db_ttl = max(cache_ttl_sec, 3600)
            _AI_CACHE.update({"key": cache_key, "expires_at": now + cache_ttl_sec, "data": validated})
            try:
                import database
                database.set_setting(
                    "analytics_ai_cache_v1",
                    json.dumps({"key": cache_key, "expires_at": now + db_ttl, "data": validated}, ensure_ascii=False),
                )
            except Exception:
                pass
        return validated
    except Exception as e:
        print(f"[AI Coach] Gemini fallback triggered: {e}")
        res = _deterministic_fallback_interpretation(sanitized, mode="deterministic_fallback_on_error")
        return res


class SessionDeepInterpretationResponse(BaseModel):
    conclusiones: List[str] = Field(..., description="Exactamente 3 conclusiones respaldadas únicamente por cifras del resumen.")
    punto_a_mejorar: str = Field(..., description="1 aspecto concreto a mejorar o vigilar según los datos.")
    recomendacion_siguiente_sesion: str = Field(..., description="1 recomendación específica para la próxima sesión del mismo tipo.")
    datos_faltantes: List[str] = Field(default_factory=list, description="Avisos de métricas ausentes sin suponer valores.")


def _deterministic_session_interpretation(summary: Dict[str, Any], mode: str = "deterministic_fallback") -> Dict[str, Any]:
    tipo = summary.get("tipo") or "otro"
    m = summary.get("metricas") or {}
    avisos = list(summary.get("avisos") or [])
    fuente = summary.get("fuente") or "stream"

    conclusiones: List[str] = []
    mejorar = "Mantener el control de intensidad y registrar pulso/vueltas completas en reloj."
    recomendacion = "Repetir estructura similar en la próxima sesión manteniendo progresión gradual."

    if tipo in ("series", "fartlek"):
        reps = m.get("repeticiones_trabajo") or 0
        pace_str = m.get("ritmo_medio_trabajo_str") or "N/D"
        fc_med = m.get("fc_media_trabajo")
        cv = m.get("consistencia_cv_pct")
        fat = m.get("fatiga_primera_vs_ultima_sec")
        drop = m.get("recuperacion_caida_60s_media_bpm")
        conclusiones.append(f"Sesión clasificada como {tipo} ({fuente}) con {reps} repeticiones de trabajo a ritmo medio {pace_str}" + (f" y FC media {fc_med} ppm." if fc_med else "."))
        conclusiones.append(f"Consistencia entre repeticiones: variación CV={cv if cv is not None else 'N/D'}% y diferencia primera vs última serie de {fat if fat is not None else 'N/D'} s/km.")
        conclusiones.append(f"Recuperación cardíaca en los primeros 60 s de descanso: caída media de {drop if drop is not None else 'N/D'} ppm (calentamiento y enfriamiento excluidos de la media de trabajo).")
        if fat is not None and fat > 8:
            mejorar = f"La última repetición fue {fat} s/km más lenta que la primera: conviene empezar la primera serie de forma más conservadora."
            recomendacion = "En la próxima sesión de series, inicia las 2 primeras repeticiones en el extremo suave del ritmo objetivo para cerrar en progresión."
        elif cv is not None and cv > 4.0:
            mejorar = f"Variabilidad de ritmo entre series (CV {cv}%): busca mayor regularidad entre repeticiones."
            recomendacion = "Mantén el mismo ritmo objetivo en todas las repeticiones antes de aumentar el número de series."
        else:
            mejorar = "Control de ritmo sólido entre repeticiones; vigilar la recuperación entre bloques."
            recomendacion = "En la próxima sesión de intervalos puedes mantener el ritmo o añadir 1 repetición si el TSB es favorable."
    elif tipo == "bici_potencia":
        np_w = m.get("potencia_normalizada_np_w")
        avg_w = m.get("potencia_media_w")
        if_val = m.get("factor_intensidad_if")
        tss = m.get("tss")
        dec = m.get("desacoplamiento_potencia_fc_pct")
        est_ftp = m.get("ftp_estimado_20m_w")
        conclusiones.append(f"Salida de ciclismo con potenciómetro ({fuente}): potencia media {avg_w if avg_w is not None else 'N/D'} W y Potencia Normalizada (NP) {np_w if np_w is not None else 'N/D'} W.")
        conclusiones.append(f"Carga relativa al FTP: IF={if_val if if_val is not None else 'N/D (sin FTP en perfil)'} y TSS={tss if tss is not None else 'N/D (sin FTP en perfil)'}.")
        conclusiones.append(f"Desacoplamiento potencia/FC entre mitades: {dec if dec is not None else 'N/D'}% y FTP estimado (20 min): {est_ftp if est_ftp is not None else 'N/D'} W.")
        if if_val is None:
            mejorar = "Configura tu FTP en el perfil para poder calcular el Factor de Intensidad (IF) y el TSS."
        elif dec is not None and dec > 5.0:
            mejorar = f"Desacoplamiento aeróbico de {dec}% (>5%): indica deriva cardíaca en la segunda mitad."
        recomendacion = "En la próxima salida en bici, mantén cadencia fluida y potencia estable en los tramos de subida."
    elif tipo == "bici_sin_potencia":
        spd = m.get("velocidad_media_kmh")
        vam = m.get("vam_mh")
        fc = m.get("fc_media")
        conclusiones.append(f"Salida de ciclismo sin potenciómetro ({fuente}): análisis limitado a telemetría GPS y pulso.")
        conclusiones.append(f"Velocidad media {spd if spd is not None else 'N/D'} km/h y VAM {vam if vam is not None else 'N/D'} m/h.")
        conclusiones.append(f"Frecuencia cardíaca media registrada: {fc if fc is not None else 'N/D'} ppm.")
        mejorar = "Sin potenciómetro no se calculan NP, IF ni TSS; usa las zonas de FC para regular el esfuerzo en subidas."
        recomendacion = "En la próxima salida en bici, controla que la FC en subidas sostenidas no supere Z4."
    else:
        p_str = m.get("ritmo_medio_str") or "N/D"
        fc = m.get("fc_media")
        cv = m.get("estabilidad_ritmo_cv_pct")
        conclusiones.append(f"Sesión clasificada como {tipo} ({fuente}) con ritmo medio {p_str}.")
        conclusiones.append(f"Frecuencia cardíaca media: {fc if fc is not None else 'N/D'} ppm.")
        conclusiones.append(f"Estabilidad del ritmo: CV={cv if cv is not None else 'N/D'}% y deriva entre mitades={m.get('deriva_fc_mitades_bpm') if m.get('deriva_fc_mitades_bpm') is not None else 'N/D'} ppm.")

    while len(conclusiones) < 3:
        conclusiones.append("Datos verificados directamente desde el resumen estructurado de la sesión.")

    return {
        "conclusiones": conclusiones[:3],
        "punto_a_mejorar": mejorar,
        "recomendacion_siguiente_sesion": recomendacion,
        "datos_faltantes": avisos,
        "source_mode": mode,
    }


def generate_session_deep_interpretation(analysis_summary: Dict[str, Any]) -> Dict[str, Any]:
    """
    Paso 5: Interprets ONLY the structured session summary from Paso 3 (never raw streams or GPS).
    Returns 3 conclusions, 1 point to improve, and 1 recommendation for the next session of the same type.
    """
    compact_summary = sanitize_snapshot_for_gemini({
        "tipo": analysis_summary.get("tipo"),
        "fuente": analysis_summary.get("fuente"),
        "metricas": analysis_summary.get("metricas"),
        "calentamiento": analysis_summary.get("calentamiento"),
        "enfriamiento": analysis_summary.get("enfriamiento"),
        "avisos": analysis_summary.get("avisos"),
        "resumen_laps": [
            {
                "index": l.get("index"),
                "role": l.get("role"),
                "rep_num": l.get("rep_num"),
                "duration_sec": l.get("duration_sec"),
                "distance_m": l.get("distance_m"),
                "pace_str": l.get("pace_str"),
                "avg_hr": l.get("avg_hr"),
                "avg_power_w": l.get("avg_power_w"),
                "recovery_drop_60s_bpm": l.get("recovery_drop_60s_bpm"),
            }
            for l in (analysis_summary.get("series_o_laps") or [])[:25]
        ],
    })

    api_key = os.getenv("GEMINI_API_KEY", "").strip()
    if not HAS_GENAI or not api_key:
        return _deterministic_session_interpretation(compact_summary, mode="deterministic_no_key")

    system_instruction = (
        "Eres el analista fisiológico de AaronFit. Recibes ÚNICAMENTE el resumen estructurado de una sesión (nunca el stream crudo).\n"
        "REGLAS ESTRICTAS:\n"
        "1. Devuelve exactamente 3 conclusiones en 'conclusiones', 1 'punto_a_mejorar' y 1 'recomendacion_siguiente_sesion' del mismo tipo.\n"
        "2. PROHIBIDO citar cifras que no estén presentes en el JSON recibido.\n"
        "3. Si una métrica es null/None o está en 'avisos' (ej. sin potencia, sin FTP, sin FC), indícalo explícitamente en vez de suponerla."
    )

    try:
        client = genai.Client(api_key=api_key, http_options={"timeout": 15000})
        resp = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=f"Analiza este resumen estructurado de sesión:\n{json.dumps(compact_summary, ensure_ascii=False)}",
            config=types.GenerateContentConfig(
                system_instruction=system_instruction,
                response_mime_type="application/json",
                response_schema=SessionDeepInterpretationResponse,
                temperature=0.15,
            ),
        )
        parsed = json.loads(resp.text)
        validated = SessionDeepInterpretationResponse(**parsed).model_dump()
        validated["conclusiones"] = (validated.get("conclusiones") or [])[:3]
        validated["source_mode"] = "gemini_live"
        return validated
    except Exception as e:
        print(f"[AI Coach Session] Gemini fallback triggered: {e}")
        return _deterministic_session_interpretation(compact_summary, mode="deterministic_fallback_on_error")


class WellnessCoachResponse(BaseModel):
    estado_diario: str = Field(..., description="Estado de preparación del día (RECUPERACIÓN FAVORABLE, ESTADO NORMAL, PRECAUCIÓN / FATIGA, DATOS INSUFICIENTES).")
    lectura_descanso: str = Field(..., description="Análisis del sueño nocturno frente a la media personal de 7 y 28 días.")
    lectura_recuperacion: str = Field(..., description="Análisis de HRV, FC en reposo, Body Battery y estrés frente al histórico individual.")
    lectura_movilidad_y_carga: str = Field(..., description="Relación entre pasos/movilidad cotidiana y carga deportiva (CTL/ATL/TSB).")
    recomendacion_entrenamiento_hoy: str = Field(..., description="Si es razonable mantener o adaptar la sesión prevista hoy, sin modificar el plan automáticamente.")
    respuesta_pregunta: Optional[str] = Field(default=None, description="Respuesta directa si el usuario formuló una pregunta específica.")
    fuentes_citadas: List[str] = Field(default_factory=list, description="Separación explícita: Garmin real, cálculo AaronFit y check-in subjetivo.")
    datos_faltantes: List[str] = Field(default_factory=list, description="Métricas no disponibles hoy.")


def _deterministic_wellness_interpretation(
    wellness_snapshot: Dict[str, Any],
    question: Optional[str] = None,
    mode: str = "deterministic_fallback",
) -> Dict[str, Any]:
    readiness = wellness_snapshot.get("readiness") or {}
    trends = wellness_snapshot.get("trends_7d_vs_28d") or {}
    slp = trends.get("sleep") or {}
    mob = trends.get("mobility") or {}
    rec = trends.get("recovery") or {}
    chk = wellness_snapshot.get("subjective_checkin") or {}
    sug = readiness.get("sugerencia_plan") or {}

    estado = readiness.get("estado") or "DATOS INSUFICIENTES"
    missing = list(readiness.get("datos_faltantes") or [])

    slp_last = slp.get("last_night_hours")
    slp_7 = slp.get("avg_hours_7d")
    slp_28 = slp.get("avg_hours_28d")
    slp_scr = slp.get("last_night_score")
    if slp_last is not None:
        lectura_descanso = (
            f"Última noche: {slp_last} h (Garmin real"
            + (f", puntuación {slp_scr}/100" if slp_scr is not None else "")
            + f") frente a tu media calculada de 7 días ({slp_7 if slp_7 is not None else 'N/D'} h) y 28 días ({slp_28 if slp_28 is not None else 'N/D'} h)."
        )
    else:
        lectura_descanso = "Sin datos de sueño nocturno registrados hoy en Garmin."

    hrv_last = rec.get("hrv_last_night")
    hrv_28 = rec.get("hrv_baseline_28d")
    rhr_today = rec.get("resting_hr_today")
    rhr_28 = rec.get("resting_hr_baseline_28d")
    bb_max = rec.get("body_battery_max_today")
    if any(x is not None for x in (hrv_last, rhr_today, bb_max)):
        lectura_rec = (
            f"HRV nocturna: {hrv_last if hrv_last is not None else 'N/D'} ms (referencia personal 28d AaronFit: {hrv_28 if hrv_28 is not None else 'N/D'} ms); "
            f"FC reposo: {rhr_today if rhr_today is not None else 'N/D'} ppm (base 28d: {rhr_28 if rhr_28 is not None else 'N/D'} ppm); "
            f"Body Battery máx: {bb_max if bb_max is not None else 'N/D'}/100."
        )
    else:
        lectura_rec = "Sin mediciones de HRV, FC en reposo ni Body Battery disponibles para hoy."

    steps_today = mob.get("today_steps")
    steps_7 = mob.get("avg_steps_7d")
    steps_28 = mob.get("avg_steps_28d")
    tsb = ((readiness.get("metricas_justificativas") or {}).get("aaronfit_calculado") or {}).get("tsb_banister_ewma")
    lectura_mob = (
        f"Pasos hoy: {steps_today if steps_today is not None else 'N/D'} (media 7d: {steps_7 if steps_7 is not None else 'N/D'}, 28d: {steps_28 if steps_28 is not None else 'N/D'}). "
        f"Balance de carga deportiva (TSB Banister EWMA AaronFit): {tsb if tsb is not None else 'N/D'}."
    )

    fuentes = ["Garmin Connect (sueño, pasos, HRV, FC reposo, Body Battery)", "AaronFit (medias 7d/28d, referencias personales y TSB)"]
    if chk and any(chk.get(k) is not None for k in ("energy", "sleep_quality", "muscle_fatigue", "general_feeling")):
        fuentes.append(f"Check-in subjetivo del usuario (energía {chk.get('energy')}/5, fatiga {chk.get('muscle_fatigue')}/5)")

    ans = None
    if question:
        ans = f"{readiness.get('recomendacion') or ''} {lectura_descanso} {lectura_rec}".strip()

    return {
        "estado_diario": estado,
        "lectura_descanso": lectura_descanso,
        "lectura_recuperacion": lectura_rec,
        "lectura_movilidad_y_carga": lectura_mob,
        "recomendacion_entrenamiento_hoy": sug.get("mensaje") or readiness.get("recomendacion") or "Sin recomendación.",
        "respuesta_pregunta": ans,
        "fuentes_citadas": fuentes,
        "datos_faltantes": missing,
        "source_mode": mode,
    }


_WELLNESS_AI_CACHE: Dict[str, Any] = {"key": None, "expires_at": 0.0, "data": None}


def generate_wellness_and_readiness_interpretation(
    wellness_snapshot: Dict[str, Any],
    question: Optional[str] = None,
    use_cache: bool = True,
    cache_ttl_sec: int = 1800,
) -> Dict[str, Any]:
    """
    Section 7: Grounded Gemini interpretation for Daily Wellness, Mobility & Readiness.
    Strictly separates Garmin measurements, AaronFit calculations, and subjective check-in data.
    Never invents missing values or emits medical diagnoses.
    """
    sanitized = sanitize_snapshot_for_gemini(wellness_snapshot)
    cache_key = None
    now = time.time()
    if use_cache and not question:
        cache_key = json.dumps(
            {
                "date": sanitized.get("date"),
                "readiness": (sanitized.get("readiness") or {}).get("estado"),
                "garmin": sanitized.get("garmin_real"),
                "checkin": sanitized.get("subjetivo_usuario"),
            },
            sort_keys=True,
        )
        if _WELLNESS_AI_CACHE["key"] == cache_key and now < _WELLNESS_AI_CACHE["expires_at"] and _WELLNESS_AI_CACHE["data"]:
            perf_monitor.mark_cache_hit(True)
            return _WELLNESS_AI_CACHE["data"]
        try:
            import database
            raw_db = database.get_setting("wellness_ai_cache_v1")
            if raw_db:
                db_obj = json.loads(raw_db)
                if (
                    isinstance(db_obj, dict)
                    and db_obj.get("key") == cache_key
                    and now < float(db_obj.get("expires_at") or 0)
                    and isinstance(db_obj.get("data"), dict)
                ):
                    _WELLNESS_AI_CACHE.update({"key": cache_key, "expires_at": float(db_obj["expires_at"]), "data": db_obj["data"]})
                    perf_monitor.mark_cache_hit(True)
                    return db_obj["data"]
        except Exception:
            pass

    api_key = os.getenv("GEMINI_API_KEY", "").strip()
    if not HAS_GENAI or not api_key:
        return _deterministic_wellness_interpretation(sanitized, question=question, mode="deterministic_no_key")

    system_instruction = (
        "Eres el entrenador personal integral de AaronFit. Analizas descanso, recuperación fisiológica, movilidad diaria y carga deportiva.\n"
        "REGLAS ESTRICTAS:\n"
        "1. Cita ÚNICAMENTE métricas reales presentes en el JSON y menciona los periodos comparados (última noche vs 7 días vs 28 días).\n"
        "2. Separa expresamente qué datos provienen de Garmin, cuáles son cálculos propios de AaronFit (medias 7d/28d, TSB) y cuáles del check-in subjetivo.\n"
        "3. Reconoce explícitamente cualquier dato que falte en 'datos_faltantes'. Prohibido inventar mediciones o asumir 0 cuando es null.\n"
        "4. No emitas diagnósticos médicos ni uses una única métrica aislada para conclusiones contundentes.\n"
        "5. No confundas un día de pocos pasos con mala recuperación fisiológica."
    )
    prompt_text = f"Analiza este resumen de bienestar y preparación diaria:\n{json.dumps(sanitized, ensure_ascii=False)}"
    if question:
        prompt_text += f"\n\nPregunta específica del atleta: {question}"

    try:
        with perf_monitor.measure_stage("gemini_ms"):
            client = genai.Client(api_key=api_key, http_options={"timeout": 15000})
            resp = client.models.generate_content(
                model="gemini-2.5-flash",
                contents=prompt_text,
                config=types.GenerateContentConfig(
                    system_instruction=system_instruction,
                    response_mime_type="application/json",
                    response_schema=WellnessCoachResponse,
                    temperature=0.15,
                ),
            )
        parsed = json.loads(resp.text)
        validated = WellnessCoachResponse(**parsed).model_dump()
        validated["source_mode"] = "gemini_live"
        if use_cache and cache_key:
            _WELLNESS_AI_CACHE.update({"key": cache_key, "expires_at": now + cache_ttl_sec, "data": validated})
            try:
                import database
                database.set_setting(
                    "wellness_ai_cache_v1",
                    json.dumps({"key": cache_key, "expires_at": now + cache_ttl_sec, "data": validated}, ensure_ascii=False),
                )
            except Exception:
                pass
        return validated
    except Exception as e:
        print(f"[AI Coach Wellness] Gemini fallback triggered: {e}")
        return _deterministic_wellness_interpretation(sanitized, question=question, mode="deterministic_fallback_on_error")


