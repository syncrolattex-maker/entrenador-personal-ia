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
    """Clears the in-memory AI interpretation cache when sports data updates."""
    _AI_CACHE.update({"key": None, "expires_at": 0.0, "data": None})


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
        return _AI_CACHE["data"]

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
            _AI_CACHE.update({"key": cache_key, "expires_at": now + cache_ttl_sec, "data": validated})
        return validated
    except Exception as e:
        print(f"[AI Coach] Gemini fallback triggered: {e}")
        res = _deterministic_fallback_interpretation(sanitized, mode="deterministic_fallback_on_error")
        return res
