from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Literal, Optional, Any
import os
import json
import httpx
import requests
from dotenv import load_dotenv
from google import genai
from google.genai import types
import garmin_client
import fit_encoder
import database

load_dotenv()

# ── ExerciseDB RapidAPI (AscendAPI) ──────────────────────────────────────────
EXERCISEDB_KEY  = os.getenv("EXERCISEDB_KEY", "")
EXERCISEDB_HOST = "edb-with-videos-and-images-by-ascendapi.p.rapidapi.com"
EXERCISEDB_BASE = f"https://{EXERCISEDB_HOST}/api/v1"
EXERCISEDB_HEADERS = {
    "x-rapidapi-key":  EXERCISEDB_KEY,
    "x-rapidapi-host": EXERCISEDB_HOST,
    "Content-Type":    "application/json",
}
# In-memory cache: { exercise_name_lower: {...details} } and { exercise_id: {...details} }
_edb_name_cache: dict = {}
_edb_id_cache:   dict = {}

app = FastAPI(title="Fitness PWA Backend")

# Enable CORS for local testing
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

from datetime import datetime, timedelta
yesterday_str = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")

# Simulated in-memory database with history support
db = {
    "dias_sin_entrenar": 1,
    "ultimo_entreno": "Carrera",
    "siguiente_bloque": "Fuerza",
    "historial_entrenamientos": [
        {
            "tipo": "Carrera",
            "completado": True,
            "duracion_minutos": 42.0,
            "frecuencia_cardiaca_media": 148,
            "calorias_activas": 380,
            "distancia_km": 6.5,
            "esfuerzo_subjetivo": "optimo",
            "fecha": yesterday_str
        }
    ]
}

# Server-side cache for daily recommendation
cached_recommendation_data = {
    "date": "",
    "data": None
}


# --- Pydantic Models for Webhook ---
class WebhookPayload(BaseModel):
    tipo: Literal["Fuerza", "Carrera"]
    completado: bool
    duracion_minutos: Optional[float] = None
    frecuencia_cardiaca_media: Optional[float] = None
    calorias_activas: Optional[float] = None
    distancia_km: Optional[float] = None
    esfuerzo_subjetivo: Optional[Literal["facil", "optimo", "agotador"]] = None

# --- Pydantic Model for completed guided session ---
class ActividadCompletadaPayload(BaseModel):
    tipo: Literal["Fuerza", "Carrera"]
    duracion_segundos: int
    esfuerzo_subjetivo: Optional[Literal["facil", "optimo", "agotador"]] = None
    frecuencia_cardiaca_media: Optional[float] = None
    calorias: Optional[float] = None
    distancia_km: Optional[float] = None
    series_completadas: Optional[int] = None
    ejercicios_completados: Optional[int] = None

# --- Pydantic Models for Structured Gemini Output ---
class Ejercicio(BaseModel):
    nombre: str
    series: int
    repeticiones: str
    descripcion: Optional[str] = None  # Brief execution tip for the user
    gif_url: Optional[str] = None
    video_url: Optional[str] = None     # Real mp4 from ExerciseDB
    exercise_id: Optional[str] = None  # ExerciseDB exerciseId for lazy detail fetch
    equipment: Optional[str] = None
    target_muscle: Optional[str] = None
    secondary_muscles: Optional[List[str]] = None
    instructions: Optional[List[str]] = None
    tips: Optional[str] = None

class FaseCarrera(BaseModel):
    name: str
    duration_seconds: int
    type: Literal["WARMUP", "WORK", "COOLDOWN"]

class RutinaResponse(BaseModel):
    tipo_sesion: Literal["Fuerza", "Carrera", "Yoga"]
    explicacion_tipo: str  # Why the AI selected Strength, Running or Yoga today
    ejercicios: Optional[List[Ejercicio]] = None
    phases: Optional[List[FaseCarrera]] = None
    mensaje_adaptacion: Optional[str] = None


class UltimoEntrenoDetalles(BaseModel):
    tipo: str
    nombre: str
    fecha: str
    duracion_minutos: float
    frecuencia_cardiaca_media: Optional[float] = None
    calorias_activas: Optional[float] = None
    distancia_km: Optional[float] = None
    descripcion: Optional[str] = None

class RecomendacionResponse(BaseModel):
    recomendacion: Literal["Fuerza", "Carrera", "Descanso"]
    razon: str
    explicacion_semanal: str
    ultimo_entreno_detalles: Optional[UltimoEntrenoDetalles] = None

class GeminiRecomendacionResponse(BaseModel):
    recomendacion: Literal["Fuerza", "Carrera", "Descanso"]
    razon: str
    explicacion_semanal: str



class GenerarEntrenamientoPayload(BaseModel):
    tipo: Literal["Fuerza", "Carrera", "Yoga"]
    modo_rescate: Optional[bool] = False


class SincronizarCarreraPayload(BaseModel):
    phases: List[FaseCarrera]

class ChatMessage(BaseModel):
    role: str  # "user" or "model"
    parts: str  # message content

class ChatCoachRequest(BaseModel):
    mensaje: str
    historial: List[ChatMessage] = []

class GeminiChatResponse(BaseModel):
    respuesta: str
    tiene_cambio_rutina: bool
    rutina_actualizada: Optional[RutinaResponse] = None



# --- Helpers ---

async def get_intervals_history() -> List[dict]:
    """
    Fetches the last 14-30 days of real activities from Garmin Connect (if connected)
    or Intervals.icu API. Used by Gemini to decide and adapt the workout of the day.
    """
    if garmin_client.is_garmin_connected():
        garmin_acts = garmin_client.get_garmin_history(limit=30)
        if garmin_acts:
            return [
                {
                    "tipo": a["tipo"],
                    "raw_tipo": a.get("tipo_garmin", a["tipo"]),
                    "nombre": a["nombre"],
                    "fecha": a["fecha"],
                    "duracion_minutos": float(a.get("duracion_min") or 0),
                    "frecuencia_cardiaca_media": a.get("frecuencia_cardiaca_media"),
                    "frecuencia_cardiaca_max": a.get("frecuencia_cardiaca_max"),
                    "calorias_activas": a.get("calorias"),
                    "distancia_km": a.get("distancia_km"),
                    "ritmo_medio": a.get("ritmo_medio"),
                    "efecto_aerobico": a.get("efecto_aerobico"),
                    "fuente": "Garmin Connect",
                }
                for a in garmin_acts
            ]

    api_key = os.getenv("INTERVALS_API_KEY")
    athlete_id = os.getenv("INTERVALS_ATHLETE_ID", "").strip()
    
    if athlete_id.lower().startswith("i"):
        athlete_id = athlete_id[1:]
        
    if not api_key or api_key == "YOUR_INTERVALS_API_KEY":
        print("Warning: Intervals API key missing. Using local db.")
        return []
        
    from datetime import datetime, timedelta
    oldest = (datetime.now() - timedelta(days=14)).strftime("%Y-%m-%d")
    newest = (datetime.now() + timedelta(days=1)).strftime("%Y-%m-%d")
    
    # Using 0 as athlete ID accesses the authenticated athlete's data reliably
    target_id = "0"
    url = f"https://intervals.icu/api/v1/athlete/{target_id}/activities"
    auth = ("API_KEY", api_key)
    params = {"oldest": oldest, "newest": newest}
    
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(url, auth=auth, params=params, timeout=10.0)
            if response.status_code == 200:
                activities = response.json()
                history = []
                for act in activities:
                    t = act.get("type", "")
                    t_lower = t.lower()
                    
                    # Robust activity type mapping for Apple Watch / Strava / Garmin
                    if any(s in t_lower for s in ["strength", "weight", "gym", "fuerza", "fitness", "crossfit", "bodybuilding"]):
                        tipo_mapeado = "Fuerza"
                    elif any(r in t_lower for r in ["run", "carrera", "trote", "jogging", "treadmill"]):
                        tipo_mapeado = "Carrera"
                    elif any(w in t_lower for w in ["walk", "caminata", "hike", "paseo"]):
                        tipo_mapeado = "Caminata"
                    else:
                        tipo_mapeado = t
                        
                    history.append({
                        "tipo": tipo_mapeado,
                        "raw_tipo": t,
                        "nombre": act.get("name", "") or tipo_mapeado,
                        "fecha": act.get("start_date_local", "")[:10],
                        "duracion_minutos": round(act.get("moving_time", 0) / 60, 1),
                        "frecuencia_cardiaca_media": act.get("average_heartrate"),
                        "calorias_activas": act.get("calories"),
                        "distancia_km": round(act.get("distance", 0) / 1000, 2) if act.get("distance") else None,
                        "descripcion": act.get("description", "")
                    })
                return history
            else:
                print(f"Error fetching Intervals history: {response.status_code} - {response.text}")
                return []
    except Exception as e:
        print(f"Exception fetching Intervals history: {str(e)}")
        return []

async def get_wko5_metrics() -> dict:
    """
    Fetches WKO5 (Banister Impulse-Response Model) physiological metrics from Intervals.icu.
    Petición GET a https://intervals.icu/api/v1/athlete/0/fitness pasando como parámetros
    oldest y newest la fecha de hoy (YYYY-MM-DD).
    Autenticación: Basic Auth con ("API_KEY", os.getenv("INTERVALS_API_KEY")).
    Returns: { "ctl_fitness": float, "atl_fatiga": float, "tsb_forma": float }
    """
    api_key = os.getenv("INTERVALS_API_KEY")
    default_metrics = {"ctl_fitness": 0.0, "atl_fatiga": 0.0, "tsb_forma": 0.0}

    if not api_key or api_key == "YOUR_INTERVALS_API_KEY":
        return default_metrics

    from datetime import date
    today_str = date.today().isoformat()
    auth = ("API_KEY", api_key)
    params = {"oldest": today_str, "newest": today_str}

    # Primary endpoint per specification, fallback to wellness endpoint if 404
    endpoints = [
        "https://intervals.icu/api/v1/athlete/0/fitness",
        "https://intervals.icu/api/v1/athlete/0/wellness"
    ]

    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            for url in endpoints:
                try:
                    response = await client.get(url, auth=auth, params=params)
                    if response.status_code == 200:
                        data = response.json()
                        item = None
                        if isinstance(data, list) and len(data) > 0:
                            item = data[0]
                        elif isinstance(data, dict):
                            item = data

                        if item and isinstance(item, dict):
                            ctl = float(item.get("ctl") or 0.0)
                            atl = float(item.get("atl") or 0.0)
                            tsb_raw = item.get("tsb")
                            if tsb_raw is not None:
                                tsb = float(tsb_raw)
                            else:
                                tsb = ctl - atl

                            return {
                                "ctl_fitness": round(ctl, 1),
                                "atl_fatiga": round(atl, 1),
                                "tsb_forma": round(tsb, 1)
                            }
                except Exception as ep_err:
                    print(f"[WKO5] Endpoint attempt error for {url}: {ep_err}")
    except Exception as e:
        print(f"[WKO5] Exception in get_wko5_metrics: {e}")

    return default_metrics


async def calcular_estado_atleta() -> dict:
    """
    Calculates current athlete state dynamically from real Intervals.icu history (Single Source of Truth).
    Eliminates dependency on in-memory ephemeral state for Vercel serverless / cold starts.
    Returns:
    {
        "ultimo_entreno": str,
        "dias_sin_entrenar": int,
        "siguiente_bloque": str
    }
    """
    from datetime import datetime, date
    today_date = date.today()

    history = await get_intervals_history()
    
    ultimo_entreno = "Carrera"
    dias_sin_entrenar = 1
    siguiente_bloque = "Fuerza"

    if history:
        # Filter for actual athletic training sessions (exclude active recovery walks/caminatas)
        sports_history = [
            act for act in history 
            if act.get("tipo") in ["Fuerza", "Carrera", "Yoga"] or act.get("raw_tipo") in ["Run", "WeightTraining", "Yoga"]
        ]
        
        # Sort history from newest to oldest by date
        sorted_history = sorted(sports_history if sports_history else history, key=lambda x: str(x.get("fecha", "")), reverse=True)
        if sorted_history:
            last_workout = sorted_history[0]
            ultimo_entreno = last_workout.get("tipo", "Carrera")
            
            # Parse last workout date
            fecha_str = str(last_workout.get("fecha", ""))[:10]
            try:
                last_date = datetime.strptime(fecha_str, "%Y-%m-%d").date()
                diff_days = (today_date - last_date).days
                dias_sin_entrenar = max(0, diff_days)
            except Exception as e:
                print(f"[calcular_estado_atleta] Date parse error for '{fecha_str}': {e}")

            # Define siguiente_bloque logic
            if ultimo_entreno == "Fuerza":
                siguiente_bloque = "Carrera"
            else:  # Carrera or Yoga
                siguiente_bloque = "Fuerza"

    return {
        "ultimo_entreno": ultimo_entreno,
        "dias_sin_entrenar": dias_sin_entrenar,
        "siguiente_bloque": siguiente_bloque
    }


def get_wiki_context() -> str:
    """
    Reads and aggregates the LLM Wiki viva markdown knowledge base (/wiki)
    so the AI Coach and workout generator possess durable athlete memory and context.
    """
    wiki_dir = os.path.join(os.path.dirname(__file__), "wiki")
    if not os.path.exists(wiki_dir):
        return ""

    context_parts = []
    # Prioritized order of core wiki knowledge files
    priority_files = [
        os.path.join(wiki_dir, "profile", "fisiologia_ciclo.md"),
        os.path.join(wiki_dir, "profile", "respuestas_estres.md"),
        os.path.join(wiki_dir, "training", "adaptaciones_rescate.md"),
        os.path.join(wiki_dir, "training", "biblioteca_ejercicios.md"),
        os.path.join(wiki_dir, "nutrition", "pautas_energia.md"),
        os.path.join(wiki_dir, "log.md")
    ]

    for fpath in priority_files:
        if os.path.isfile(fpath):
            try:
                rel_path = os.path.relpath(fpath, wiki_dir)
                with open(fpath, "r", encoding="utf-8-sig") as f:
                    content = f.read().strip()
                    if content:
                        context_parts.append(f"### [WIKI: {rel_path}]\n{content}")
            except Exception as e:
                print(f"[WIKI Context] Error reading {fpath}: {e}")

    if not context_parts:
        return ""

    return "=== BASE DE CONOCIMIENTO VIVA DE AARÓN (LLM WIKI) ===\n" + "\n\n".join(context_parts)



async def enviar_a_intervals(phases: List[FaseCarrera]):
    """
    Sends structured workout phases to Intervals.icu API.
    Formats a plain-text structured description that Watchletic and Intervals.icu parser parse seamlessly for Apple Watch.
    """
    api_key = os.getenv("INTERVALS_API_KEY")
    if not api_key or api_key == "YOUR_INTERVALS_API_KEY":
        print("Warning: INTERVALS_API_KEY is not configured. Skipping Intervals.icu sync.")
        return False

    from datetime import datetime
    today_date = datetime.now().strftime("%Y-%m-%dT08:00:00")
    
    headers = {
        "Content-Type": "application/json"
    }
    
    desc_lines = [
        "Entrenamiento de carrera estructurado generado por tu Entrenador IA.",
        "Sincronización automática para Apple Watch (Watchletic).",
        ""
    ]
    
    warmup_steps = []
    work_steps = []
    cooldown_steps = []
    
    for p in phases:
        if p.type == "WARMUP":
            warmup_steps.append(p)
        elif p.type == "COOLDOWN":
            cooldown_steps.append(p)
        else:
            work_steps.append(p)
            
    # Format each step strictly following Intervals.icu syntax: "- [duration] [name] [target]"
    if warmup_steps:
        desc_lines.append("Warmup")
        for p in warmup_steps:
            mins = p.duration_seconds // 60
            secs = p.duration_seconds % 60
            dur_str = f"{mins}m" if secs == 0 else f"{mins}m{secs}s" if mins > 0 else f"{secs}s"
            desc_lines.append(f"- {dur_str} {p.name} 55-65% HR")
        desc_lines.append("")
        
    if work_steps:
        desc_lines.append("Main Set")
        for p in work_steps:
            mins = p.duration_seconds // 60
            secs = p.duration_seconds % 60
            dur_str = f"{mins}m" if secs == 0 else f"{mins}m{secs}s" if mins > 0 else f"{secs}s"
            hr_range = "80-85% HR" if any(w in p.name.lower() for w in ["interval", "rápido", "fartlek", "serie", "cuesta"]) else "65-75% HR"
            desc_lines.append(f"- {dur_str} {p.name} {hr_range}")
        desc_lines.append("")
        
    if cooldown_steps:
        desc_lines.append("Cooldown")
        for p in cooldown_steps:
            mins = p.duration_seconds // 60
            secs = p.duration_seconds % 60
            dur_str = f"{mins}m" if secs == 0 else f"{mins}m{secs}s" if mins > 0 else f"{secs}s"
            desc_lines.append(f"- {dur_str} {p.name} 50-60% HR")
            
    payload = {
        "category": "WORKOUT",
        "type": "Run",
        "name": "Carrera IA Flow",
        "start_date_local": today_date,
        "description": "\n".join(desc_lines)
    }
    
    url = "https://intervals.icu/api/v1/athlete/0/events"
    auth = ("API_KEY", api_key)
    
    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                url,
                headers=headers,
                auth=auth,
                json=payload,
                timeout=10.0
            )
            if response.status_code in [200, 201]:
                print("Successfully synced workout with Intervals.icu API.")
                return True
            else:
                print(f"Intervals.icu API error: {response.status_code} - {response.text}")
                return False
    except Exception as e:
        print(f"Failed to connect to Intervals.icu: {str(e)}")
        return False

async def _edb_fetch_exercise_detail(exercise_id: str) -> dict:
    """Fetches full exercise detail (videoUrl, instructions, tips) from ExerciseDB by ID."""
    if exercise_id in _edb_id_cache:
        return _edb_id_cache[exercise_id]
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            r = await client.get(
                f"{EXERCISEDB_BASE}/exercises/{exercise_id}",
                headers=EXERCISEDB_HEADERS
            )
            if r.status_code == 200:
                data = r.json().get("data", {})
                _edb_id_cache[exercise_id] = data
                return data
    except Exception as e:
        print(f"[EDB] detail fetch error for {exercise_id}: {e}")
    return {}


async def _edb_search_exercise(nombre: str) -> dict:
    """
    Searches ExerciseDB for a strength exercise matching the given name.
    Prioritizes DUMBBELL and BODY WEIGHT equipment (Aarón's gear: 5 kg dumbbells & bands).
    Returns a dict with: exercise_id, gif_url, video_url, target_muscle,
    secondary_muscles, instructions, tips.
    """
    key = nombre.lower().strip()
    if key in _edb_name_cache:
        return _edb_name_cache[key]

    # Extract meaningful search keywords from the Spanish name
    stop_words = {"con", "de", "la", "el", "en", "un", "una", "los", "las",
                  "del", "al", "por", "y", "a", "su", "sus", "mancuerna",
                  "pesas", "banda", "cinta", "cintas", "resistencia", "kg",
                  "5kg", "unilateral", "isométrica", "isometrica"}
    words = [w for w in key.split() if w not in stop_words and len(w) > 2]
    search_term = " ".join(words[:3]) if words else key

    result = {}
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            # Try name-based search first
            r = await client.get(
                f"{EXERCISEDB_BASE}/exercises",
                params={"limit": 50, "search": search_term},
                headers=EXERCISEDB_HEADERS
            )
            candidates = []
            if r.status_code == 200:
                candidates = r.json().get("data", [])

            # If no search param, fallback: get by body weight / dumbbell pool
            if not candidates:
                r2 = await client.get(
                    f"{EXERCISEDB_BASE}/exercises",
                    params={"limit": 100, "equipment": "BODY WEIGHT"},
                    headers=EXERCISEDB_HEADERS
                )
                if r2.status_code == 200:
                    candidates = r2.json().get("data", [])

            if candidates:
                # Score by name similarity
                key_words = set(search_term.lower().split())
                best = None
                best_score = -1
                for ex in candidates:
                    ex_words = set((ex.get("name") or "").lower().split())
                    score = len(key_words & ex_words)
                    # Boost preferred equipment
                    eq_list = [e.upper() for e in (ex.get("equipments") or [])]
                    if "DUMBBELL" in eq_list or "BODY WEIGHT" in eq_list:
                        score += 1
                    if score > best_score:
                        best_score = score
                        best = ex

                if best:
                    ex_id = best.get("exerciseId", "")
                    # Fetch full detail for videoUrl and instructions
                    detail = await _edb_fetch_exercise_detail(ex_id) if ex_id else {}
                    muscles = best.get("targetMuscles") or []
                    secondary = best.get("secondaryMuscles") or []
                    result = {
                        "exercise_id":       ex_id,
                        "gif_url":           best.get("imageUrl") or detail.get("imageUrl"),
                        "video_url":         detail.get("videoUrl"),
                        "target_muscle":     ", ".join(muscles) if muscles else "FULL BODY",
                        "secondary_muscles": secondary,
                        "instructions":      detail.get("instructions") or [],
                        "tips":              (detail.get("exerciseTips") or [""])[0] if detail.get("exerciseTips") else None,
                    }
    except Exception as e:
        print(f"[EDB] search error for '{nombre}': {e}")

    _edb_name_cache[key] = result
    return result


async def enrich_routine_data(routine: Any) -> Any:
    """Enriches strength exercises with real ExerciseDB RapidAPI data (images, videos, instructions)."""
    if not routine:
        return routine

    routine_dict = routine if isinstance(routine, dict) else routine.dict()

    if routine_dict.get("tipo_sesion") == "Fuerza" and routine_dict.get("ejercicios"):
        enriched_list = []
        for ex in routine_dict["ejercicios"]:
            ex_item = ex if isinstance(ex, dict) else ex.dict() if hasattr(ex, "dict") else dict(ex)
            ex_name = ex_item.get("nombre", "")
            if ex_name:
                details = await _edb_search_exercise(ex_name)
                if details:
                    ex_item["exercise_id"]      = details.get("exercise_id")
                    ex_item["gif_url"]           = details.get("gif_url")
                    ex_item["video_url"]         = details.get("video_url")
                    ex_item["target_muscle"]     = details.get("target_muscle")
                    ex_item["secondary_muscles"] = details.get("secondary_muscles")
                    ex_item["instructions"]      = details.get("instructions")
                    ex_item["tips"]              = details.get("tips")
            enriched_list.append(ex_item)
        routine_dict["ejercicios"] = enriched_list

    return routine_dict


async def generar_rutina_mock(tipo: str, mensaje_warning: str = None, modo_rescate: bool = False) -> dict:
    """
    Generates a localized mock routine with dynamic daily rotation, fatigue adaptation, or rescue mode.
    Conforms to the RutinaResponse schema.
    """
    from datetime import datetime
    day_seed = datetime.now().timetuple().tm_yday
    
    if modo_rescate:
        explicacion = (
            "🔋 Modo Rescate (Día Gris): Sesión ultra-suave de movilidad y relajación de 10 minutos. "
            "Hoy lo único importante es mantener el hábito sin ninguna exigencia ni culpa. ¡Buen trabajo, Aarón!\n\n"
            "🥗 Consejo de nutrición post-entreno: Una infusión tibia de manzanilla o té verde junto con 1/2 tostada integral con aguacate o mantequilla de almendras (opción vegetal muy ligera de ~150 kcal) para reponer minerales y calmar el sistema nervioso."
        )
        ejercicios = [
            {"nombre": "Postura del Niño (Child's Pose)", "series": 1, "repeticiones": "3 min", "descripcion": "Arrodíllate suavemente en la esterilla, apoya la frente y relaja brazos a los lados. Respira profundo."},
            {"nombre": "Gato-Vaca Suave (Cat-Cow Stretch)", "series": 1, "repeticiones": "3 min", "descripcion": "En cuadrupedia, arquea y redondea la columna al ritmo de tu respiración suave sin forzar ningún rango."},
            {"nombre": "Postura del Cadáver (Corpse Pose)", "series": 1, "repeticiones": "4 min", "descripcion": "Túmbate boca arriba con palmas hacia el cielo. Suelta cualquier tensión muscular y asimila la calma."}
        ]
        return {
            "tipo_sesion": "Yoga",
            "explicacion_tipo": explicacion,
            "ejercicios": ejercicios,
            "mensaje_adaptacion": "Sesión de rescate de 10 min activada. Cero presión hoy.",
            "mensaje": mensaje_warning
        }

    is_fatigued = False
    last_workout = next((x for x in reversed(db["historial_entrenamientos"]) if x.get("completado")), None)
    if last_workout:
        if last_workout.get("esfuerzo_subjetivo") == "agotador" or (last_workout.get("frecuencia_cardiaca_media") or 0) > 170:
            is_fatigued = True

    explicacion = f"Sesión de {tipo} diseñada con periodización variada y retadora para Aarón."
    
    if tipo == "Fuerza":
        # 4 Diverse Full-Body Templates to guarantee complete daily variety
        fuerza_templates = [
            # Template A: Glúteo & Unilateral Focus
            [
                {"nombre": "Zancadas Búlgaras con Mancuernas (5 kg)", "series": 4, "repeticiones": "15 por pierna", "descripcion": "Un pie apoyado atrás. Bajada lenta en 3 segundos manteniendo el torso erguido."},
                {"nombre": "Peso Muerto Rumano a una pierna (5 kg)", "series": 4, "repeticiones": "15 por pierna", "descripcion": "Flexiona ligeramente la rodilla y lleva la cadera atrás apretando isquio y glúteo."},
                {"nombre": "Press Militar de Hombros con Banda", "series": 4, "repeticiones": "18", "descripcion": "Pisa la banda de resistencia y empuja fuerte arriba manteniendo el abdomen contraído."},
                {"nombre": "Remo Unilateral con Mancuerna de 5 kg", "series": 4, "repeticiones": "15 por brazo", "descripcion": "Espalda neutra, tracciona el codo hacia la cadera apretando la escápula."},
                {"nombre": "Core: Plancha Isométrica con toque de hombros", "series": 3, "repeticiones": "50 seg", "descripcion": "Plancha alta sin balancear la cadera, tocando alternativamente cada hombro."}
            ],
            # Template B: Empujes & Tracciones metabólicas
            [
                {"nombre": "Sentadilla Goblet Isométrica + Bote con 5 kg", "series": 4, "repeticiones": "20", "descripcion": "Sostén la mancuerna en el pecho, realiza 3 rebotes abajo y sube explosivo."},
                {"nombre": "Hip Thrust con Banda de Resistencia", "series": 4, "repeticiones": "20", "descripcion": "Espalda sobre sofá/banco, banda sobre rodillas. Empuja cadera apretando 2 seg arriba."},
                {"nombre": "Flexiones de Pecho con Pausa en Suelo", "series": 3, "repeticiones": "12-15", "descripcion": "Apoyo de rodillas o puntas. Pausa de 1 segundo abajo y empuje fuerte."},
                {"nombre": "Remo Horizontal en Bipedestación con Cintas", "series": 4, "repeticiones": "18", "descripcion": "Sostén la cinta tensa, tracciona codos hacia atrás sintiendo la parte media de la espalda."},
                {"nombre": "Core: Bicho Muerto (Deadbug) con Mancuerna", "series": 3, "repeticiones": "16 totales", "descripcion": "Boca arriba, extiende pierna y brazo contrario manteniendo la zona lumbar pegada al suelo."}
            ],
            # Template C: Resistencia Muscular y Piernas
            [
                {"nombre": "Zancadas Caminando con Pesas de 5 kg", "series": 4, "repeticiones": "16 totales", "descripcion": "Paso amplio buscando ángulo de 90º en ambas rodillas."},
                {"nombre": "Puente de Glúteo a una Pierna", "series": 3, "repeticiones": "15 por pierna", "descripcion": "Una pierna elevada, desclava la cadera del suelo apretando fuertemente el glúteo activo."},
                {"nombre": "Elevaciones Laterales + Press Frontal con 5 kg", "series": 4, "repeticiones": "15", "descripcion": "Trabajo de hombro y parte superior del tórax con tensión constante."},
                {"nombre": "Remo al Pecho con Cintas (Agarre Neutro)", "series": 4, "repeticiones": "18", "descripcion": "Codos pegados al cuerpo, junta escápulas al final de la trayectoria."},
                {"nombre": "Core: Plancha Lateral con Elevación de Cadera", "series": 3, "repeticiones": "40 seg por lado", "descripcion": "Codo apoyado bajo el hombro, eleva y baja cadera de forma controlada."}
            ],
            # Template D: Full-Body Escuadrón Métrico
            [
                {"nombre": "Sentadillas Sumo con Mancuerna de 5 kg", "series": 4, "repeticiones": "20", "descripcion": "Pies más abiertos que el ancho de hombros, puntas hacia afuera. Énfasis en aductores y glúteos."},
                {"nombre": "Zancadas Posteriores (Reverse Lunges) con 5 kg", "series": 4, "repeticiones": "14 por pierna", "descripcion": "Paso largo atrás bajando rodilla casi a rozar el suelo."},
                {"nombre": "Aperturas de Pecho en Suelo con Pesas (Floor Press)", "series": 4, "repeticiones": "16", "descripcion": "Tumbada en esterilla, empuja las pesas de 5 kg arriba juntándolas en el punto alto."},
                {"nombre": "Pulls de Espalda y Tríceps con Banda", "series": 4, "repeticiones": "18", "descripcion": "Brazos extendidos, abre la cinta hasta tocar el pecho alto."},
                {"nombre": "Core: Escaladores (Mountain Climbers) Controlados", "series": 3, "repeticiones": "45 seg", "descripcion": "En plancha alta, lleva rodillas al pecho sin perder la alineación."}
            ]
        ]
        
        template_index = day_seed % len(fuerza_templates)
        ejercicios = fuerza_templates[template_index]
        
        msg_adapt = None
        if is_fatigued:
            for ex in ejercicios:
                ex["series"] = max(2, ex["series"] - 1)
            msg_adapt = "Notamos cansancio acumulado. Bajamos volumen de series para favorecer la recuperación celular."

        routine_res = {
            "tipo_sesion": "Fuerza",
            "explicacion_tipo": explicacion,
            "ejercicios": ejercicios,
            "mensaje_adaptacion": msg_adapt,
            "mensaje": mensaje_warning
        }
        return await enrich_routine_data(routine_res)
    elif tipo == "Yoga":
        explicacion = "Sesión de Yoga y flexibilidad diseñada para liberar la tensión acumulada y mejorar el rango de movimiento."
        ejercicios = [
            {"nombre": "Postura del Árbol (Tree Pose)", "series": 2, "repeticiones": "1 min por pierna", "descripcion": "Apoya una planta del pie en el muslo interno de la pierna contraria, junta palmas en el pecho y busca equilibrio. Respira lento."},
            {"nombre": "Perro Boca Abajo (Downward-Facing Dog)", "series": 3, "repeticiones": "1 min", "descripcion": "Forma una V invertida con tu cuerpo. Estira la espalda y empuja los talones al suelo."},
            {"nombre": "Postura del Guerrero I (Warrior One)", "series": 3, "repeticiones": "1 min por lado", "descripcion": "Da un paso amplio atrás, flexiona la rodilla delantera a 90 grados y eleva tus brazos firmes."},
            {"nombre": "Postura del Niño (Child's Pose)", "series": 2, "repeticiones": "2 min", "descripcion": "Arrodíllate y apoya la frente en el suelo con los brazos relajados extendidos. Relaja los hombros."},
            {"nombre": "Postura de la Esfinge (Sphinx Pose)", "series": 3, "repeticiones": "1 min", "descripcion": "Tumbada boca abajo, apoya los antebrazos paralelos y eleva el pecho manteniendo hombros relajados y glúteos firmes."},
            {"nombre": "Postura del Cadáver (Corpse Pose)", "series": 1, "repeticiones": "3 min", "descripcion": "Túmbate boca arriba, relaja brazos y piernas, cierra los ojos y asimila la paz de la sesión."}
        ]
        return {
            "tipo_sesion": "Yoga",
            "explicacion_tipo": explicacion,
            "ejercicios": ejercicios,
            "mensaje_adaptacion": None,
            "mensaje": mensaje_warning
        }

    else:
        # Check how many quality running sessions she did this week (allow up to 2)
        quality_runs_7d = 0
        try:
            today_date = datetime.now().date()
            monday_date = today_date - timedelta(days=today_date.weekday())
            monday_str = monday_date.strftime("%Y-%m-%d")
            for item in db.get("historial_entrenamientos", []):
                if item.get("completado") and item.get("tipo") == "Carrera":
                    f_date = item.get("fecha", "")
                    if f_date >= monday_str:
                        n_lower = (item.get("nombre") or "").lower()
                        if any(q in n_lower for q in ["fartlek", "interval", "serie", "velocidad", "calidad"]):
                            quality_runs_7d += 1
        except Exception:
            pass

        carrera_templates = [
            # Template 1: Rodaje en Zona 2 con Rectas Progresivas
            [
                {"name": "Calentamiento: Trote suave y movilidad articular", "duration_seconds": 300, "type": "WARMUP"},
                {"name": "Rodaje Aeróbico Cómodo (Zona 2 conversacional)", "duration_seconds": 1800, "type": "WORK"},
                {"name": "5 Progresiones de 80 metros (15s rápido / 45s recuperar)", "duration_seconds": 300, "type": "WORK"},
                {"name": "Enfriamiento: Vuelta a la calma caminando", "duration_seconds": 300, "type": "COOLDOWN"}
            ],
            # Template 2: Fartlek Dinámico Piramidal (Sesión de Calidad)
            [
                {"name": "Calentamiento: Trote suave y técnica de carrera", "duration_seconds": 480, "type": "WARMUP"},
                {"name": "Fartlek Pirámide: 1m rápido / 1m suave", "duration_seconds": 120, "type": "WORK"},
                {"name": "Fartlek Pirámide: 2m rápido / 2m suave", "duration_seconds": 240, "type": "WORK"},
                {"name": "Fartlek Pirámide: 3m rápido / 3m suave", "duration_seconds": 360, "type": "WORK"},
                {"name": "Fartlek Pirámide: 2m rápido / 2m suave", "duration_seconds": 240, "type": "WORK"},
                {"name": "Fartlek Pirámide: 1m rápido / 1m suave", "duration_seconds": 120, "type": "WORK"},
                {"name": "Enfriamiento: Trote regenerativo y estiramientos", "duration_seconds": 300, "type": "COOLDOWN"}
            ],
            # Template 3: Rodamiento Progresivo (Control de ritmo)
            [
                {"name": "Calentamiento: Trote suave inicial", "duration_seconds": 300, "type": "WARMUP"},
                {"name": "Bloque A: Ritmo muy suave conversacional", "duration_seconds": 600, "type": "WORK"},
                {"name": "Bloque B: Incremento de ritmo (Zona 2 media)", "duration_seconds": 600, "type": "WORK"},
                {"name": "Bloque C: Ritmo alegre exigente (Zona 2 alta)", "duration_seconds": 600, "type": "WORK"},
                {"name": "Enfriamiento: Vuelta a la calma caminando", "duration_seconds": 300, "type": "COOLDOWN"}
            ],
            # Template 4: Intervalos de Potencia Aeróbica (Sesión de Calidad)
            [
                {"name": "Calentamiento: Trote progresivo + movilidad activa", "duration_seconds": 450, "type": "WARMUP"},
                {"name": "Intervalo 1: 90 seg ritmo rápido / 90 seg andar", "duration_seconds": 180, "type": "WORK"},
                {"name": "Intervalo 2: 90 seg ritmo rápido / 90 seg andar", "duration_seconds": 180, "type": "WORK"},
                {"name": "Intervalo 3: 90 seg ritmo rápido / 90 seg andar", "duration_seconds": 180, "type": "WORK"},
                {"name": "Intervalo 4: 90 seg ritmo rápido / 90 seg andar", "duration_seconds": 180, "type": "WORK"},
                {"name": "Intervalo 5: 90 seg ritmo rápido / 90 seg andar", "duration_seconds": 180, "type": "WORK"},
                {"name": "Intervalo 6: 90 seg ritmo rápido / 90 seg andar", "duration_seconds": 180, "type": "WORK"},
                {"name": "Enfriamiento: Vuelta a la calma de vuelta", "duration_seconds": 300, "type": "COOLDOWN"}
            ]
        ]
        
        phases = carrera_templates[day_seed % len(carrera_templates)]
        is_quality = len(phases) > 5  # Templates 2 and 4 are quality
        
        msg_adapt = None
        if is_fatigued or (is_quality and quality_runs_7d >= 2):
            phases = [
                {"name": "Calentamiento: Trote suave y movilidad", "duration_seconds": 300, "type": "WARMUP"},
                {"name": "Rodamiento Suave de Asimilación (Zona 2)", "duration_seconds": 1500, "type": "WORK"},
                {"name": "Enfriamiento: Vuelta a la calma caminando", "duration_seconds": 300, "type": "COOLDOWN"}
            ]
            msg_adapt = "Adaptación inteligente: Ajustado a Rodamiento de Recuperación por fatiga previa o por haber alcanzado el límite semanal de 2 sesiones de calidad."

        return {
            "tipo_sesion": "Carrera",
            "explicacion_tipo": explicacion,
            "phases": phases,
            "mensaje_adaptacion": msg_adapt,
            "enviado_al_reloj": False,
            "mensaje": mensaje_warning
        }




async def registrar_en_intervals(payload: ActividadCompletadaPayload) -> bool:
    """
    Registers a completed workout as a real activity in Intervals.icu.
    """
    api_key = os.getenv("INTERVALS_API_KEY")
    athlete_id = os.getenv("INTERVALS_ATHLETE_ID", "").strip()

    if athlete_id.lower().startswith("i"):
        athlete_id = athlete_id[1:]

    if (not api_key or api_key == "YOUR_INTERVALS_API_KEY" or
            not athlete_id or athlete_id == "YOUR_INTERVALS_ATHLETE_ID"):
        print("Warning: Intervals.icu credentials not configured. Skipping activity registration.")
        return False

    from datetime import datetime
    now_str = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")

    if payload.tipo == "Fuerza":
        activity_type = "WeightTraining"
        name = "💪 Fuerza — AaronFit AI"
    elif payload.tipo == "Yoga":
        activity_type = "Yoga"
        name = "🧘‍♂️ Yoga — AaronFit AI"
    else:
        activity_type = "Run"
        name = "🏃 Carrera — AaronFit AI"

    description_lines = ["Sesión generada y guiada por AaronFit — Entrenador Personal IA."]


    if payload.esfuerzo_subjetivo:
        emoji = {"facil": "😊", "optimo": "⚡", "agotador": "🥵"}.get(payload.esfuerzo_subjetivo, "")
        description_lines.append(f"Esfuerzo percibido: {emoji} {payload.esfuerzo_subjetivo.capitalize()}")
    if payload.series_completadas:
        description_lines.append(f"Series completadas: {payload.series_completadas}")
    if payload.ejercicios_completados:
        description_lines.append(f"Ejercicios completados: {payload.ejercicios_completados}")

    body = {
        "name": name,
        "type": activity_type,
        "start_date_local": now_str,
        "elapsed_time": payload.duracion_segundos,
        "moving_time": payload.duracion_segundos,
        "distance": int((payload.distancia_km or 0) * 1000),
        "description": "\n".join(description_lines),
    }
    if payload.calorias:
        body["calories"] = int(payload.calorias)
    if payload.frecuencia_cardiaca_media:
        body["average_heartrate"] = int(payload.frecuencia_cardiaca_media)

    url = f"https://intervals.icu/api/v1/athlete/0/activities/manual"
    auth = ("API_KEY", api_key)

    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                url,
                auth=auth,
                json=body,
                timeout=10.0
            )
            if response.status_code in [200, 201]:
                print(f"✅ Activity '{name}' registered in Intervals.icu.")
                return True
            else:
                print(f"Intervals.icu activity error: {response.status_code} - {response.text}")
                return False
    except Exception as e:
        print(f"Failed to register activity in Intervals.icu: {str(e)}")
        return False


# --- API Endpoints ---

@app.get("/estado-db")
async def get_estado_db():
    """
    Helper endpoint to check current athlete status dynamically calculated from Intervals.icu.
    Provides stateless Single Source of Truth for frontend PWA status banner on Vercel cold starts.
    """
    estado = await calcular_estado_atleta()
    history = await get_intervals_history()
    
    response = dict(estado)
    response["historial_entrenamientos"] = history
    return response

@app.post("/webhook-iphone")
def webhook_iphone(payload: WebhookPayload):
    """
    Endpoint for iOS shortcut webhook.
    Updates the simulated database and appends metrics to the history log.
    """
    global cached_recommendation_data
    cached_recommendation_data["date"] = ""
    cached_recommendation_data["data"] = None

    if payload.completado:

        db["dias_sin_entrenar"] = 0
        db["ultimo_entreno"] = payload.tipo
        db["siguiente_bloque"] = "Carrera" if payload.tipo == "Fuerza" else "Fuerza"
        
        from datetime import date
        db["historial_entrenamientos"].append({
            "tipo": payload.tipo,
            "completado": True,
            "duracion_minutos": payload.duracion_minutos,
            "frecuencia_cardiaca_media": payload.frecuencia_cardiaca_media,
            "calorias_activas": payload.calorias_activas,
            "distancia_km": payload.distancia_km,
            "esfuerzo_subjetivo": payload.esfuerzo_subjetivo,
            "fecha": date.today().isoformat()
        })
    else:
        from datetime import date
        db["dias_sin_entrenar"] += 1
        db["historial_entrenamientos"].append({
            "tipo": payload.tipo,
            "completado": False,
            "dias_sin_entrenar_acumulados": db["dias_sin_entrenar"],
            "fecha": date.today().isoformat()
        })
        
    return {"status": "ok", "msg": "Estado actualizado", "db": db}



@app.post("/registrar-actividad")
async def post_registrar_actividad(payload: ActividadCompletadaPayload):
    """
    Called by the PWA guided session on completion.
    Registers the activity in Intervals.icu and updates local DB history.
    """
    global cached_recommendation_data
    cached_recommendation_data["date"] = ""
    cached_recommendation_data["data"] = None

    db["dias_sin_entrenar"] = 0

    db["ultimo_entreno"] = payload.tipo
    db["siguiente_bloque"] = "Carrera" if payload.tipo == "Fuerza" else "Fuerza"

    from datetime import date
    db["historial_entrenamientos"].append({
        "tipo": payload.tipo,
        "completado": True,
        "duracion_minutos": round(payload.duracion_segundos / 60, 1),
        "frecuencia_cardiaca_media": payload.frecuencia_cardiaca_media,
        "calorias_activas": payload.calorias,
        "distancia_km": payload.distancia_km,
        "esfuerzo_subjetivo": payload.esfuerzo_subjetivo,
        "series_completadas": payload.series_completadas,
        "ejercicios_completados": payload.ejercicios_completados,
        "fecha": date.today().isoformat()
    })


    registrado = await registrar_en_intervals(payload)

    return {
        "status": "ok",
        "registrado_en_intervals": registrado,
        "db": db
    }

GYM_EXERCISE_CATALOG = [
    {
        "id": "ex_01",
        "nombre": "Zancadas Búlgaras con Mancuernas (5 kg)",
        "target_muscle": "Glúteos y Cuádriceps",
        "grupo": "Piernas",
        "equipamiento": "Mancuernas de 5 kg",
        "dificultad": "Exigente",
        "tempo": "3s Bajada • 1s Pausa • 1s Empuje",
        "animClass": "anim-lunge",
        "gif": "https://upload.wikimedia.org/wikipedia/commons/1/18/Lunges_1.gif",
        "paso_a_paso": "1. Apoya el empeine trasero sobre una silla o sofá.\n2. Sostén las mancuernas de 5 kg con brazos relajados a los lados.\n3. Desciende flexionando la rodilla delantera hasta 90º en 3 segundos.\n4. Empuja fuertemente con el talón delantero para retornar a la posición inicial."
    },
    {
        "id": "ex_02",
        "nombre": "Sentadilla Goblet con Mancuerna de 5 kg",
        "target_muscle": "Cuádriceps y Glúteo Mayor",
        "grupo": "Piernas",
        "equipamiento": "Mancuernas de 5 kg",
        "dificultad": "Intermedio",
        "tempo": "3s Bajada • 1s Pausa • 1s Subida",
        "animClass": "anim-squat",
        "gif": "https://upload.wikimedia.org/wikipedia/commons/8/82/Squats.gif",
        "paso_a_paso": "1. Sostén la pesita de 5 kg pegada al pecho con ambas manos.\n2. Coloca los pies al ancho de hombros, puntas ligeramente hacia afuera.\n3. Inicia la bajada llevando la cadera atrás y abajo manteniendo el torso erguido.\n4. Mantén la presión sobre los talones y sube apretando glúteos."
    },
    {
        "id": "ex_03",
        "nombre": "Peso Muerto Rumano a Una Pierna (5 kg)",
        "target_muscle": "Isquiotibiales y Glúteo Medio",
        "grupo": "Piernas",
        "equipamiento": "Mancuernas de 5 kg",
        "dificultad": "Exigente",
        "tempo": "3s Bajar • 1s Apretar Glúteo",
        "animClass": "anim-squat",
        "gif": "https://upload.wikimedia.org/wikipedia/commons/a/a2/Barbell_Deadlift.gif",
        "paso_a_paso": "1. Mantén una pierna apoyada con ligera flexión de rodilla.\n2. Lleva la otra pierna recta hacia atrás mientras inclinas el torso adelante.\n3. Sostén la pesa de 5kg rozando la espinilla hasta sentir la tensión en el isquio.\n4. Vuelve a la vertical contrayendo fuertemente el glúteo."
    },
    {
        "id": "ex_04",
        "nombre": "Hip Thrust con Banda de Resistencia",
        "target_muscle": "Glúteo Mayor y Core",
        "grupo": "Glúteos",
        "equipamiento": "Banda de resistencia",
        "dificultad": "Intermedio",
        "tempo": "2s Subida • 2s Pausa Arriba",
        "animClass": "anim-squat",
        "gif": "https://upload.wikimedia.org/wikipedia/commons/8/82/Squats.gif",
        "paso_a_paso": "1. Apoya las escápulas sobre el borde de una silla o sofá.\n2. Coloca la banda elástica justo sobre tus rodillas y pies apoyados firmes.\n3. Desciende la cadera y empuja explosivamente hacia el techo.\n4. Aprieta intensamente los glúteos 2 segundos en el punto más alto."
    },
    {
        "id": "ex_05",
        "nombre": "Press Militar de Hombros con Banda / 5kg",
        "target_muscle": "Deltoides y Tríceps",
        "grupo": "Hombros",
        "equipamiento": "Cintas / Mancuernas 5 kg",
        "dificultad": "Intermedio",
        "tempo": "1s Empuje • 3s Bajada Controlada",
        "animClass": "anim-press",
        "gif": "https://upload.wikimedia.org/wikipedia/commons/9/91/Shoulder_press.gif",
        "paso_a_paso": "1. De pie, pisa la cinta o sostiene las mancuernas a la altura de los hombros.\n2. Contrae el abdomen y los glúteos para bloquear la zona lumbar.\n3. Empuja verticalmente hacia arriba hasta extender los brazos.\n4. Baja de forma lenta y pausada sintiendo el trabajo en los hombros."
    },
    {
        "id": "ex_06",
        "nombre": "Remo Unilateral con Mancuerna de 5 kg",
        "target_muscle": "Dorsal Ancho y Escápulas",
        "grupo": "Espalda",
        "equipamiento": "Mancuernas de 5 kg",
        "dificultad": "Intermedio",
        "tempo": "1s Tirar • 1s Apretar Escápula",
        "animClass": "anim-row",
        "gif": "https://upload.wikimedia.org/wikipedia/commons/a/a0/Dumbbell_Row.gif",
        "paso_a_paso": "1. Inclina el torso adelante apoyando una mano sobre una mesa o rodilla.\n2. Sostén la mancuerna de 5 kg con el brazo extendido.\n3. Tracciona el codo rozando las costillas dirigiéndolo hacia la cadera.\n4. Aprieta la escápula atrás 1 segundo antes de descender."
    },
    {
        "id": "ex_07",
        "nombre": "Plancha Isométrica con Toque de Hombros",
        "target_muscle": "Abdomen, Transverso y Deltoides",
        "grupo": "Core",
        "equipamiento": "Peso corporal",
        "dificultad": "Intermedio",
        "tempo": "Tensión Isométrica 45-60s",
        "animClass": "anim-plank",
        "gif": "https://upload.wikimedia.org/wikipedia/commons/a/a6/Plank.gif",
        "paso_a_paso": "1. Colócate en posición de plancha alta sobre palmas y puntas de pies.\n2. Mantén la alineación perfecta de tobillos, pelvis y cabeza.\n3. Toca alternativamente con cada mano el hombro contrario sin oscilar la cadera.\n4. Mantén la respiración fluida y abdomen en máxima tensión."
    }
]

@app.get("/api/ejercicios-catalogo")
async def get_ejercicios_catalogo_endpoint():
    """
    Returns the complete Gym Exercise Catalog structured after Kaggle Gym Exercise Dataset.
    """
    return {"status": "ok", "ejercicios": GYM_EXERCISE_CATALOG}

@app.get("/api/rapidapi-exercises/{muscle}")
async def get_rapidapi_exercises(muscle: str):
    """
    Proxy endpoint to fetch exercise data directly from Gym and Home Exercises RapidAPI.
    Supports muscle groups: adductor, quadriceps, glutes, hamstrings, shoulders, back, chest, abs.
    Falls back gracefully to local catalog if unsubscribed or offline.
    """
    rapid_key = os.getenv("RAPIDAPI_KEY", "")
    rapid_host = os.getenv("RAPIDAPI_HOST", "gym-and-home-exercises.p.rapidapi.com")

    clean_muscle = muscle.lower().strip()
    url = f"https://{rapid_host}/{clean_muscle}.json"
    headers = {
        "x-rapidapi-host": rapid_host,
        "x-rapidapi-key": rapid_key
    }

    try:
        async with httpx.AsyncClient() as client:
            res = await client.get(url, headers=headers, timeout=5.0)
            if res.status_code == 200:
                data = res.json()
                return {"status": "ok", "source": "RapidAPI", "muscle": muscle, "data": data}
            else:
                print(f"[RapidAPI Proxy] Status {res.status_code}: {res.text[:150]}")
    except Exception as e:
        print(f"[RapidAPI Proxy Exception]: {e}")

    # Seamless fallback to Kaggle Catalog filtered by muscle group
    filtered = [ex for ex in GYM_EXERCISE_CATALOG if clean_muscle in ex["target_muscle"].lower() or clean_muscle in ex["grupo"].lower()]
    if not filtered:
        filtered = GYM_EXERCISE_CATALOG

    return {
        "status": "ok",
        "source": "LocalKaggleCatalog",
        "muscle": muscle,
        "data": filtered
    }

@app.get("/api/musclewiki/ejercicios")
@app.get("/api/musclewiki/{category}")
async def get_musclewiki_exercises(category: str = "all", categoria: str = None, lang: str = "es-es"):
    """
    Official MuscleWiki REST API Proxy & Exercise Library Endpoint.
    Handles both query param `categoria` and path param `category`.
    Returns full Kaggle/MuscleWiki catalog filtered by category or muscle.
    """
    cat_query = categoria or category or "all"
    clean_cat = cat_query.lower().strip()

    mw_key = os.getenv("MUSCLEWIKI_API_KEY", "")
    url = "https://api.musclewiki.com/exercises"
    headers = {"X-API-Key": mw_key}
    params = {"limit": 20, "lang": lang}
    if clean_cat not in ["all", "todos", "ejercicios"]:
        params["category"] = clean_cat

    try:
        print(f"[MuscleWiki Attempt] Connecting to {url} with key {mw_key[:6]}... category={clean_cat}")
        async with httpx.AsyncClient() as client:
            res = await client.get(url, headers=headers, params=params, timeout=5.0)
            print(f"[MuscleWiki Response] HTTP Status: {res.status_code}")
            if res.status_code == 200:
                data = res.json()
                exercises_list = data.get("results", data) if isinstance(data, dict) else data
                print(f"[MuscleWiki Live SUCCESS] Fetched {len(exercises_list)} exercises live from MuscleWiki API.")
                return {
                    "status": "ok",
                    "source": "MuscleWikiAPI",
                    "categoria": clean_cat,
                    "count": len(exercises_list),
                    "ejercicios": exercises_list,
                    "data": exercises_list
                }
            else:
                print(f"[MuscleWiki Blocked/Restricted] Status {res.status_code}: {res.text[:150]}")
    except Exception as e:
        print(f"[MuscleWiki Proxy Exception]: {e}")


    # Fallback to local GYM_EXERCISE_CATALOG
    if clean_cat in ["all", "todos", "ejercicios"]:
        filtered = GYM_EXERCISE_CATALOG
    else:
        filtered = [ex for ex in GYM_EXERCISE_CATALOG if clean_cat in ex["target_muscle"].lower() or clean_cat in ex["grupo"].lower() or clean_cat in ex["equipamiento"].lower()]
        if not filtered:
            filtered = GYM_EXERCISE_CATALOG

    return {
        "status": "ok",
        "source": "LocalKaggleCatalog",
        "categoria": clean_cat,
        "count": len(filtered),
        "ejercicios": filtered,
        "data": filtered
    }

@app.get("/api/yoga-poses")
async def get_yoga_poses():
    """
    Yoga API Proxy Endpoint.
    Proxies alexcumplido/yoga-api (Render Hosted version).
    Falls back to a solid local database of 5 essential yoga poses if offline/slow.
    """
    url = "https://yoga-api-nzy4.onrender.com/v1/poses"
    try:
        async with httpx.AsyncClient() as client:
            res = await client.get(url, timeout=5.0)
            if res.status_code == 200:
                data = res.json()
                return {"status": "ok", "source": "YogaAPI", "poses": data}
            else:
                print(f"[Yoga API Proxy] Status {res.status_code}: {res.text[:150]}")
    except Exception as e:
        print(f"[Yoga API Proxy Exception]: {e}")

    fallback_poses = [
        {
            "id": 41,
            "english_name": "Tree",
            "sanskrit_name": "Vksana",
            "translation_name": "vrksa = tree, asana = pose",
            "pose_description": "Balance on one leg, placing the sole of the opposite foot on your inner thigh. Bring hands together in front of your chest.",
            "pose_benefits": "Improves balance, focus, and strengthens ankle and leg muscles.",
            "url_svg": "https://upload.wikimedia.org/wikipedia/commons/3/3b/Vrkshasana.svg"
        },
        {
            "id": 15,
            "english_name": "Downward-Facing Dog",
            "sanskrit_name": "Parivtta Adho Mukha vnsana",
            "translation_name": "adho = downward, mukha = face, svana = dog, asana = pose",
            "pose_description": "On all fours, lift hips back and up to form an inverted V shape. Keep heels reaching down.",
            "pose_benefits": "Stretches shoulders, hamstrings, calves, and hands. Energizes the body.",
            "url_svg": "https://upload.wikimedia.org/wikipedia/commons/7/71/Adho_Mukha_Svanasana.svg"
        },
        {
            "id": 44,
            "english_name": "Warrior One",
            "sanskrit_name": "Vrabhadrsana I",
            "translation_name": "virabhadra = warrior, asana = pose",
            "pose_description": "Step one foot back, bend front knee to 90 degrees, and raise arms straight overhead.",
            "pose_benefits": "Strengthens shoulders, arms, legs, and back. Opens hips and chest.",
            "url_svg": "https://upload.wikimedia.org/wikipedia/commons/7/7a/Warrior_Pose_I.svg"
        },
        {
            "id": 10,
            "english_name": "Child's Pose",
            "sanskrit_name": "Balsana",
            "translation_name": "bala = child, asana = pose",
            "pose_description": "Kneel, sit back on your heels, fold forward, and rest your forehead on the floor with arms extended.",
            "pose_benefits": "Gently stretches hips, thighs, and ankles. Calms the mind and relieves fatigue.",
            "url_svg": "https://upload.wikimedia.org/wikipedia/commons/0/0a/Balasana_Yoga-Pose.svg"
        },
        {
            "id": 35,
            "english_name": "Sphinx",
            "sanskrit_name": "Slamba Bhujagsana",
            "translation_name": "salamba = supported, bhujanga = cobra, asana = pose",
            "pose_description": "Lie prone, place elbows under shoulders, forearms on the floor, and lift chest up gently.",
            "pose_benefits": "Strengthens spine, stretches chest, shoulders, and abdomen. Calms nervous system.",
            "url_svg": "https://upload.wikimedia.org/wikipedia/commons/b/b3/Bhujangasana_Yoga-Pose.svg"
        },
        {
            "id": 11,
            "english_name": "Corpse",
            "sanskrit_name": "avsana",
            "translation_name": "shava = corpse, asana = pose",
            "pose_description": "Lie flat on your back, legs spread slightly, arms relaxed at your sides with palms facing up. Focus on your breathing.",
            "pose_benefits": "Calms the brain, helps relieve stress and mild depression. Relaxes the body.",
            "url_svg": "https://upload.wikimedia.org/wikipedia/commons/6/6d/Savasana_Yoga-Pose.svg"
        }
    ]


    return {"status": "ok", "source": "OfflineFallback", "poses": fallback_poses}






@app.get("/historial-actividades")
async def get_historial_actividades_endpoint():
    """
    Returns real activity history from Intervals.icu immediately for display on Metrics tab.
    Falls back to local DB history if Intervals.icu API is not configured or returns empty.
    """
    history = await get_intervals_history()
    if history:
        return {"status": "ok", "historial": history}
        
    local_history = []
    for item in db.get("historial_entrenamientos", []):
        if item.get("completado"):
            local_history.append({
                "tipo": item.get("tipo", "Fuerza"),
                "raw_tipo": item.get("tipo", "Fuerza"),
                "nombre": f"Sesión de {item.get('tipo', 'Fuerza')}",
                "fecha": item.get("fecha", "Ayer"),
                "duracion_minutos": item.get("duracion_minutos", 42.0),
                "frecuencia_cardiaca_media": item.get("frecuencia_cardiaca_media"),
                "calorias_activas": item.get("calorias_activas"),
                "distancia_km": item.get("distancia_km"),
                "descripcion": "Registrado en el dispositivo"
            })
            
    return {"status": "ok", "historial": local_history}
async def generate_gemini_content_with_retry(client, contents, system_instruction, response_schema, temperature=0.7):

    """
    Calls Gemini API with automatic retry and model fallback on 503 UNAVAILABLE or 429 RESOURCE_EXHAUSTED.
    """
    import asyncio
    models_to_try = ["gemini-2.5-flash", "gemini-2.0-flash"]
    last_exception = None

    for model_name in models_to_try:
        for attempt in range(2):
            try:
                response = client.models.generate_content(
                    model=model_name,
                    contents=contents,
                    config=types.GenerateContentConfig(
                        system_instruction=system_instruction,
                        response_mime_type="application/json",
                        response_schema=response_schema,
                        temperature=temperature,
                    )
                )
                return json.loads(response.text)
            except Exception as e:
                last_exception = e
                print(f"[Gemini Retry] Model {model_name} attempt {attempt+1} failed: {e}")
                await asyncio.sleep(1.0)
    
    raise last_exception


async def generar_analisis_plan_b(real_history: List[dict], db: dict, wko5_data: Optional[dict] = None) -> dict:
    """
    Autonomous Athletic Diagnostic & Recommendation Engine (Plan B).
    Evaluates Verónica's real Intervals.icu history and WKO5 metrics according to sports science directives.
    """
    from datetime import datetime, date, timedelta

    if wko5_data is None:
        wko5_data = await get_wko5_metrics()

    estado_atleta = await calcular_estado_atleta()

    today_date = datetime.now().date()
    weekday = today_date.weekday()  # 0 = Monday, 1 = Tuesday, ..., 6 = Sunday
    weekday_names = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"]
    
    if not real_history:
        real_history = []
        for item in db.get("historial_entrenamientos", []):
            if item.get("completado"):
                f = item.get("fecha", "")
                if f == "Hoy":
                    f = date.today().isoformat()
                elif f == "Ayer":
                    f = (date.today() - timedelta(days=1)).isoformat()
                
                real_history.append({
                    "tipo": item.get("tipo", "Fuerza"),
                    "raw_tipo": item.get("tipo", "Fuerza"),
                    "nombre": f"Sesión de {item.get('tipo', 'Fuerza')}",
                    "fecha": f,
                    "duracion_minutos": item.get("duracion_minutos", 45.0),
                    "frecuencia_cardiaca_media": item.get("frecuencia_cardiaca_media"),
                    "calorias_activas": item.get("calorias_activas"),
                    "distancia_km": item.get("distancia_km"),
                    "esfuerzo_subjetivo": item.get("esfuerzo_subjetivo")
                })

    sports_history = [
        act for act in real_history 
        if act.get("tipo") in ["Fuerza", "Carrera", "Yoga"] or act.get("raw_tipo") in ["Run", "WeightTraining", "Yoga"]
    ]

    ultimo_detalles = None
    last_type = estado_atleta["ultimo_entreno"]
    days_inactive = estado_atleta["dias_sin_entrenar"]
    last_effort = ""
    last_hr = 0
    
    fuerza_count_7d = 0
    carrera_count_7d = 0
    yoga_count_7d = 0
    has_quality_run_7d = False

    history_to_eval = sports_history if sports_history else real_history

    if history_to_eval:
        sorted_history = sorted(history_to_eval, key=lambda x: x["fecha"], reverse=True)
        ultimo_detalles = sorted_history[0]
        last_type = ultimo_detalles.get("tipo", last_type)
        last_effort = (ultimo_detalles.get("esfuerzo_subjetivo") or "").lower()
        last_hr = ultimo_detalles.get("frecuencia_cardiaca_media") or 0
        
        monday_date = today_date - timedelta(days=weekday)
        monday_str = monday_date.strftime("%Y-%m-%d")
        
        try:
            last_date = datetime.strptime(ultimo_detalles["fecha"], "%Y-%m-%d").date()
            diff_days = (today_date - last_date).days
            days_inactive = max(0, diff_days)
        except Exception:
            pass

        # Sync in-memory db so local debugging reflects real history
        db["ultimo_entreno"]   = last_type
        db["siguiente_bloque"] = "Carrera" if last_type == "Fuerza" else "Fuerza"
        db["dias_sin_entrenar"] = days_inactive

        for act in sorted_history:
            act_date_str = act.get("fecha", "")
            if act_date_str >= monday_str:
                t = act.get("tipo", "")
                if t == "Fuerza":
                    fuerza_count_7d += 1
                elif t == "Carrera":
                    carrera_count_7d += 1
                    name_lower = (act.get("nombre") or "").lower()
                    if any(q in name_lower for q in ["fartlek", "interval", "serie", "velocidad", "calidad"]):
                        has_quality_run_7d = True
                elif t == "Yoga":
                    yoga_count_7d += 1

    # WKO5 Banister Telemetry
    tsb_val = wko5_data.get("tsb_forma", 0.0)
    ctl_val = wko5_data.get("ctl_fitness", 0.0)
    atl_val = wko5_data.get("atl_fatiga", 0.0)

    # ── Intelligent Decision Tree for Aarón (43a, 1.83m, 93kg) ──
    rec_tipo = "Fuerza"
    razon = ""
    explicacion_semanal = f"Esta semana (Lunes-Domingo): {fuerza_count_7d}/3 Fuerza • {carrera_count_7d}/2 Carrera."

    # WKO5 High Fatigue Rule Override (TSB < -15)
    if tsb_val < -15.0 and days_inactive <= 1:
        rec_tipo = "Descanso"
        razon = f"¡Hola Aarón! Según la telemetría (TSB = {tsb_val}, Fatiga ATL = {atl_val}), tus reservas de recuperación están comprometidas. Hoy toca descanso activo y asimilación para proteger tus articulaciones."

    # CASE 1: Trained TODAY (days_inactive == 0)
    elif days_inactive == 0:
        rec_tipo = "Descanso"
        if last_type == "Carrera":
            razon = "¡Objetivo cumplido hoy, Aarón! Ya has completado tu entrenamiento de Carrera. Para evitar sobrecargas articulares y asimilar el estímulo, el resto del día es de reposo y asimilación."
        elif last_type == "Fuerza":
            razon = "¡Excelente sesión hoy, Aarón! Tu bloque de Fuerza ya está completado. Toca reposo y nutrición para que la musculatura repare y supercompense."
        else:
            razon = "¡Buen entrenamiento hoy, Aarón! Tu cuerpo está en fase de asimilación física. Disfruta del descanso."

    # CASE 2: High Subjective Fatigue or High HR from last workout
    elif last_effort == "agotador" or (last_hr > 170 and days_inactive <= 1):
        rec_tipo = "Descanso"
        razon = "¡Hola Aarón! Detectamos que tu última sesión requirió un esfuerzo muy exigente (FC alta / esfuerzo máximo). Para evitar sobrecargas articulares y favorecer la supercompensación muscular, hoy te prescribo descanso o movilidad muy suave."

    # CASE 3: Trained YESTERDAY (days_inactive == 1)
    elif days_inactive == 1:
        if last_type == "Fuerza":
            rec_tipo = "Carrera"
            razon = "¡Hola Aarón! Tras el bloque de Fuerza de ayer, hoy alternamos con Carrera estilo Runna (Zona 2 o intervalos controlados según tu historial) para potenciar tu base aeróbica."
        elif last_type == "Carrera":
            rec_tipo = "Fuerza"
            razon = "¡Hola Aarón! Tras la sesión de Carrera de ayer, hoy cambiamos el estímulo hacia Fuerza estilo Strava con tus mancuernas de 5 kg y cintas elásticas para mantener densidad muscular y control articular."
        else: # Other activity (e.g. Ciclismo) yesterday
            if fuerza_count_7d <= carrera_count_7d:
                rec_tipo = "Fuerza"
                razon = "¡Hola Aarón! Tras tu sesión de ayer, hoy toca equilibrar con Fuerza estilo Strava de 45 minutos."
            else:
                rec_tipo = "Carrera"
                razon = "¡Hola Aarón! Tras tu sesión de ayer, hoy prescribimos un bloque de Carrera Aeróbica en Zona 2 guiado estilo Runna."

    # CASE 4: Inactive 2 or more days (days_inactive >= 2)
    else:
        if fuerza_count_7d < carrera_count_7d:
            rec_tipo = "Fuerza"
            razon = f"¡Hola Aarón! Llevas {days_inactive} días de reposo y esta semana necesitas compensar la carga de Fuerza. Hoy te prescribimos un entrenamiento de Fuerza estilo Strava (45-55 min) con pesas de 5 kg y cintas."
        elif carrera_count_7d < fuerza_count_7d:
            rec_tipo = "Carrera"
            razon = f"¡Hola Aarón! Llevas {days_inactive} días sin entrenar. Para reactivar tu sistema cardiovascular sin impacto excesivo, hoy te recomiendo Carrera Aeróbica en Zona 2."
        else:
            # Counts are tied -> Day-of-Week Schedule Rotation!
            if weekday in [0, 2, 4]:  # Mon, Wed, Fri
                rec_tipo = "Fuerza"
                razon = f"¡Hola Aarón! Feliz {weekday_names[weekday]}. Para mantener la masa muscular y el tono físico, hoy te recomendamos una sesión de Fuerza estilo Strava con pesas de 5 kg y cintas elásticas."
            elif weekday in [1, 3, 5]:  # Tue, Thu, Sat
                rec_tipo = "Carrera"
                razon = f"¡Hola Aarón! Feliz {weekday_names[weekday]}. Hoy toca trabajo cardiovascular: Carrera estructurada guiada estilo Runna."
            else:  # Sunday (6)
                rec_tipo = "Descanso"
                razon = "¡Hola Aarón! Es domingo, día de descarga articular y recuperación para empezar la semana al 100%."

    # Calculate dynamic readiness/load score (0-100%) incorporating WKO5 TSB Form
    weekly_total = fuerza_count_7d + carrera_count_7d + yoga_count_7d
    adherence_points = min(40.0, (weekly_total / 4.0) * 40.0)  # target is 4 workouts/wk

    recovery_points = 40.0
    if days_inactive == 0:
        recovery_points = 30.0
    elif days_inactive == 1:
        recovery_points = 40.0  # 1 day rest is optimal
    elif days_inactive == 2:
        recovery_points = 35.0
    elif days_inactive >= 3:
        recovery_points = max(15.0, 40.0 - (days_inactive - 2) * 5.0)

    # WKO5 TSB Form Adjustment on Readiness Score
    if tsb_val != 0.0 or ctl_val != 0.0:
        if tsb_val < -15.0:
            recovery_points = max(5.0, recovery_points - 18.0)
        elif -10.0 <= tsb_val <= 5.0:
            recovery_points = min(40.0, recovery_points + 5.0)
        elif tsb_val > 10.0:
            recovery_points = min(35.0, recovery_points)

    if last_effort == "agotador":
        recovery_points = max(10.0, recovery_points - 15.0)
    elif last_effort == "moderado":
        recovery_points = max(10.0, recovery_points - 5.0)

    balance_points = 20.0
    # Evaluate balance using actual real sports history first, falling back to db
    recent_sports = [x.get("tipo") for x in history_to_eval if x.get("tipo") in ["Fuerza", "Carrera", "Yoga"]][:3]
    if not recent_sports:
        recent_sports = [x.get("tipo") for x in reversed(db.get("historial_entrenamientos", [])) if x.get("completado")][:3]
    if len(recent_sports) >= 2 and len(set(recent_sports)) == 1:
        balance_points = 10.0

    readiness_score = int(adherence_points + recovery_points + balance_points)
    readiness_score = max(20, min(100, readiness_score))

    return {
        "recomendacion": rec_tipo,
        "razon": razon,
        "explicacion_semanal": explicacion_semanal,
        "ultimo_entreno_detalles": ultimo_detalles,
        "historial_real": real_history,
        "readiness_score": readiness_score,
        "wko5_metrics": wko5_data
    }


@app.get("/ejercicio-detalle/{exercise_id}")
async def get_ejercicio_detalle(exercise_id: str):
    """
    Returns full ExerciseDB detail for a given exerciseId:
    videoUrl, imageUrls, instructions, exerciseTips, variations, targetMuscles.
    Results are cached in memory to avoid redundant API calls.
    """
    try:
        detail = await _edb_fetch_exercise_detail(exercise_id)
        if detail:
            return {"status": "ok", "data": detail}
        return {"status": "error", "msg": "Ejercicio no encontrado en ExerciseDB."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/ejercicio-detalle/bodyparts")
async def get_ejercicio_bodyparts():
    """Returns the ExerciseDB body-part catalog with image URLs."""
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            r = await client.get(f"{EXERCISEDB_BASE}/bodyparts", headers=EXERCISEDB_HEADERS)
            if r.status_code == 200:
                return r.json()
        return {"success": False, "data": []}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/recomendacion-hoy")
async def get_recomendacion_hoy():
    """
    Generates today's personalized recommendation for Aarón (43, 1.83m, 93kg)
    evaluating his actual activity history from Garmin Connect / Intervals.icu via Gemini AI or Plan B engine.
    """
    global cached_recommendation_data
    from datetime import date, datetime
    today_str = date.today().isoformat()
    if cached_recommendation_data["date"] == today_str and cached_recommendation_data["data"] is not None:
        print("[Cache Server] Returning cached recommendation for today.")
        return cached_recommendation_data["data"]

    try:
        real_history = await get_intervals_history()
        wko5_data = await get_wko5_metrics()
        estado_atleta = await calcular_estado_atleta()
        rec_data = await generar_analisis_plan_b(real_history, db, wko5_data=wko5_data)
        wiki_context = get_wiki_context()
        garmin_wellness = garmin_client.get_garmin_wellness() if garmin_client.is_garmin_connected() else {}

        # Try Gemini AI if API key is available
        api_key = os.getenv("GEMINI_API_KEY")
        if api_key:
            try:
                client = genai.Client(api_key=api_key)
                weekday_names = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"]
                weekday_str = weekday_names[datetime.now().weekday()]
                
                system_instruction = (
                    "Eres el Coach IA de **AaronFit**, entrenador personal de **Aarón** (43 años, 1.83m, 93kg, mancuernas de 5 kg y cintas elásticas).\n"
                    "Tu misión es analizar sus últimos entrenamientos reales de Garmin/Strava y explicarle la recomendación de hoy basándote en su estado fisiológico.\n"
                    f"{wiki_context}\n\n"
                    "TELEMETRÍA FISIOLÓGICA:\n"
                    f"- CTL (Fitness): {wko5_data.get('ctl_fitness')}\n"
                    f"- ATL (Fatiga): {wko5_data.get('atl_fatiga')}\n"
                    f"- TSB (Forma): {wko5_data.get('tsb_forma')}\n"
                    f"- Garmin Wellness hoy: {json.dumps(garmin_wellness, ensure_ascii=False)}\n\n"
                    "REGLA DE COHERENCIA ATLÉTICA:\n"
                    f"El motor de prescripción deportiva ha determinado que hoy le corresponde: '{rec_data['recomendacion']}'.\n"
                    f"Razón técnica: {rec_data['razon']}.\n"
                    "Mantén dicha disciplina ('recomendacion': '" + rec_data['recomendacion'] + "') para evitar contradicciones o cambios erráticos entre refrescos, "
                    "y redacta una razón ('razon') motivadora, técnica y profesional, dirigida a Aarón.\n"
                    "Devuelve también 'explicacion_semanal' resumiendo el volumen semanal."
                )
                
                last_type = estado_atleta["ultimo_entreno"]
                prompt = f"""
                Hoy es {weekday_str} ({today_str}).
                Días sin entrenar: {estado_atleta['dias_sin_entrenar']}.
                Último entrenamiento deportivo completado: {last_type}.
                Métricas WKO5: CTL={wko5_data.get('ctl_fitness')}, ATL={wko5_data.get('atl_fatiga')}, TSB={wko5_data.get('tsb_forma')}.
                Balance semanal: {rec_data.get('explicacion_semanal', '')}.
                
                Prescribe '{rec_data['recomendacion']}' y genera una razón inspiradora y cercana que tome en cuenta su evolución física.
                """
                
                ai_rec = await generate_gemini_content_with_retry(
                    client=client,
                    contents=prompt,
                    system_instruction=system_instruction,
                    response_schema=GeminiRecomendacionResponse,
                    temperature=0.3
                )
                if ai_rec and isinstance(ai_rec, dict) and ai_rec.get("recomendacion"):
                    rec_data["recomendacion"] = ai_rec["recomendacion"]
                    rec_data["razon"] = ai_rec["razon"]
                    if ai_rec.get("explicacion_semanal"):
                        rec_data["explicacion_semanal"] = ai_rec["explicacion_semanal"]
            except Exception as gem_err:
                print("Gemini recommendation fallback to Plan B:", gem_err)
        
        cached_recommendation_data["date"] = today_str
        cached_recommendation_data["data"] = rec_data
        return rec_data
    except Exception as e:
        print("Error in recommendation engine:", e)
        return await generar_analisis_plan_b([], db)


@app.post("/generar-entrenamiento")
async def post_generar_entrenamiento(payload: GenerarEntrenamientoPayload):
    """
    Generates a detailed workout routine (exercises for Strength, or phases for Running)
    adapted in volume and intensity based on Garmin/Strava history, WKO5 metrics, or modo_rescate for Aarón.
    """
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        mock_res = await generar_rutina_mock(payload.tipo, "Modo local offline.", modo_rescate=payload.modo_rescate)
        garmin_push = garmin_client.send_workout_to_garmin_watch(mock_res)
        mock_res["enviado_al_reloj"] = garmin_push.get("status") == "sent"
        mock_res["garmin_sync_status"] = garmin_push.get("status")
        mock_res["garmin_sync_msg"] = garmin_push.get("message")
        return mock_res
        
    try:
        real_history = await get_intervals_history()
        wko5_data = await get_wko5_metrics()
        estado_atleta = await calcular_estado_atleta()
        wiki_context = get_wiki_context()
        client = genai.Client(api_key=api_key)
        
        ctl_val = wko5_data.get("ctl_fitness", 0.0)
        atl_val = wko5_data.get("atl_fatiga", 0.0)
        tsb_val = wko5_data.get("tsb_forma", 0.0)

        system_instruction = (
            "Eres el Coach IA de **AaronFit**, la aplicación de entrenamiento personal exclusiva de **Aarón**, un atleta de 43 años "
            "que mide 1.83 m y pesa 93 kg.\n\n"
            "CONDICIÓN SUPREMA - MODO RESCATE (DÍA GRIS):\n"
            "Si el modo de rescate está activado (modo_rescate == True), IGNORA todas las reglas de intensidad y fatiga. Tu única tarea es generar una sesión ultra-suave y reconfortante de Yoga o Movilidad de máximo 10 minutos (2-3 ejercicios muy fáciles). El mensaje motivacional debe ser comprensivo, validando que lo importante hoy es mantener el hábito sin culpa.\n\n"
            "NUTRICIÓN DE RECUPERACIÓN AUTOMATIZADA POST-ENTRENO:\n"
            "Al final de la explicación del entrenamiento ('explicacion_tipo'), añade siempre un breve consejo de nutrición post-entreno adaptado a su gasto calórico (1.83m / 93kg), priorizando buena hidratación, electrolitos y proteína de calidad para recuperación muscular.\n\n"
            "TELEMETRÍA FISIOLÓGICA MODELO WKO5 (BANISTER):\n"
            f"- Carga Crónica (Fitness / CTL): {ctl_val}\n"
            f"- Carga Aguda (Fatiga / ATL): {atl_val}\n"
            f"- Equilibrio de Estrés (Forma / TSB): {tsb_val}\n\n"
            "DIRECTRICES DE PRESCRIPCIÓN FISIOLÓGICA SEGÚN TSB:\n"
            "1. Si TSB < -15 (Fatiga alta): Forzar sesión regenerativa obligatoria (Rodamiento Suave Z2 de 35 min o Yoga/Movilidad) para reducir riesgo de sobreentrenamiento/lesión articular.\n"
            "2. Si -10 <= TSB <= +5 (Zona óptima de asimilación): Autorizar sesiones exigentes de Fuerza estilo Strava o Intervalos/Calidad de Carrera estilo Runna.\n"
            "3. Si TSB > +10 (Desentrenamiento/frescura extrema): Incrementar el volumen e intensidad de la sesión para volver a estimular la subida del CTL (Fitness).\n\n"
            f"Tu tarea hoy es generar la sesión detallada para el tipo seleccionado: '{payload.tipo}'.\n\n"
            "INSTRUCCIONES DE MATERIALES Y ENFOQUE DE FUERZA (SISTEMA STRAVA STRENGTH):\n"
            "Aarón dispone de **bandas de resistencia (cintas elásticas)** y **mancuernas de 5 kg (pesas de 5 kg)**.\n"
            "Los entrenamientos de fuerza deben combinar empujes, tracciones, tren inferior y core, estructurados para registrarse con el Logger Strava (series, reps y peso).\n\n"
            "INSTRUCCIONES DE ESTRUCTURA Y VOLUMEN:\n"
            "Dirígete a él por su nombre ('Aarón') en las explicaciones y adaptaciones.\n"
            "1. Si el tipo es 'Fuerza':\n"
            "   - REGLA DE VARIEDAD Y DIVERSIFICACIÓN: NUNCA repitas la misma rutina o combinación exacta que la última sesión. Alterna entre enfoques de fuerza (Enfoque A: Predominio de cadera y glúteo con Peso muerto rumano unilateral y Hip thrust; Enfoque B: Cuádriceps y empujes con Sentadilla tempo y Press militar; Enfoque C: Tracciones y unilaterales con Zancadas y Remos con cinta).\n"
            "   - Genera una rutina intensa de 45 a 55 minutos de duración.\n"
            "   - Diseña entre 5 y 6 ejercicios exigentes, especificando 4 o 5 series de 15-22 repeticiones (el rango de repeticiones debe ser alto y con tempo controlado dada la carga de 5 kg y cintas).\n"
            "   - Incluye siempre un ejercicio de core estático o dinámico por tiempo (ej. Plancha isométrica, Bicho muerto, o Escaladores de 45-60 segundos).\n"
            "   - Rellena obligatoriamente una 'descripcion' corta y clara sobre la ejecución para cada ejercicio detallando el tempo (ej: 'bajada en 3 segundos') y el uso de las cintas o pesas de 5 kg.\n\n"
            "2. Si el tipo es 'Carrera':\n"
            "   - REGLA DE ORO DE CARRERA (PROTECCIÓN ARTICULAR 93KG): Se permiten hasta DOS (2) sesiones de calidad a la semana (últimos 7 días). Analiza el historial: si ya figuran DOS sesiones intensas en los últimos 7 días, DEBES generar obligatoriamente un Rodamiento Suave en Zona 2. Si hay menos de dos, diseña una sesión estructurada estilo Runna (Calentamiento, Intervalos/Fartlek/Tempo con fases claras y Enfriamiento).\n\n"
            "3. Si el tipo es 'Yoga':\n"
            "   - Genera una sesión de yoga y movilidad consciente de 20-30 minutos de duración.\n"
            "   - Selecciona entre 5 y 6 asanas/posturas de yoga fluidas (ej. Tadasana, Balasana, Adho Mukha Svanasana, Bhujangasana, Virabhadrasana).\n"
            "   - Define series (generalmente 1 o 2) y repeticiones expresadas en tiempo de mantenimiento estático (ej. '3 minutos' o '1 minuto por lado').\n"
            "   - Rellena una descripción detallando cómo respirar y mantener la alineación corporal durante la asana.\n\n"
            "INSTRUCCIÓN DE ADAPTACIÓN INTELIGENTE:\n"
            "Dosifica las cargas (menos series o ritmos más lentos) si el historial o WKO5 revela TSB < -15 o fatiga acumulada. De lo contrario, genera una sesión altamente retadora.\n\n"
            "Devuelve un JSON strictly compatible con RutinaResponse."
        )

        historial_str = ""
        if real_history:
            historial_str = "Historial de entrenamientos reales (últimos 10 días de Intervals.icu):\n"
            for log in real_history:
                dist_str = f", Distancia: {log['distancia_km']} km" if log['distancia_km'] else ""
                fc_str = f", FC Media: {log['frecuencia_cardiaca_media']} ppm" if log['frecuencia_cardiaca_media'] else ""
                historial_str += f"- Fecha {log['fecha']}: {log['tipo']} ({log['nombre']}). Duración: {log['duracion_minutos']} min{dist_str}{fc_str}\n"
        else:
            historial_str = "No hay historial reciente."

        prompt = f"""
        Tipo de entrenamiento solicitado: {payload.tipo}.
        Modo de rescate (Día Gris) activado: {payload.modo_rescate}.
        Días sin entrenar: {estado_atleta['dias_sin_entrenar']}.
        Último entrenamiento completado: {estado_atleta['ultimo_entreno']}.
        Telemetría WKO5 actual: Carga Crónica CTL (Fitness) = {ctl_val}, Carga Aguda ATL (Fatiga) = {atl_val}, Equilibrio de Estrés TSB (Forma) = {tsb_val}.
        {historial_str}

        {wiki_context}
        
        Genera la sesión adaptada y detallada de {payload.tipo} para Aarón ajustada a su nivel TSB actual, respetando los aprendizajes y directrices de su Wiki (o la sesión de rescate de 10 min si modo_rescate es True).
        """
        
        workout = await generate_gemini_content_with_retry(
            client=client,
            contents=prompt,
            system_instruction=system_instruction,
            response_schema=RutinaResponse,
            temperature=0.85
        )
        enriched = await enrich_routine_data(workout)
        garmin_push = garmin_client.send_workout_to_garmin_watch(enriched)
        enriched["enviado_al_reloj"] = garmin_push.get("status") == "sent"
        enriched["garmin_sync_status"] = garmin_push.get("status")
        enriched["garmin_sync_msg"] = garmin_push.get("message")
        return enriched
        
    except Exception as e:
        print("Gemini generation error:", e)
        fallback = await generar_rutina_mock(payload.tipo, "Modo de respaldo activo por alta demanda de red.", modo_rescate=payload.modo_rescate)
        garmin_push = garmin_client.send_workout_to_garmin_watch(fallback)
        fallback["enviado_al_reloj"] = garmin_push.get("status") == "sent"
        fallback["garmin_sync_status"] = garmin_push.get("status")
        fallback["garmin_sync_msg"] = garmin_push.get("message")
        return fallback


@app.post("/sincronizar-carrera")
async def post_sincronizar_carrera(payload: SincronizarCarreraPayload):
    """
    Explicitly triggered by the user to sync their generated Carrera workout to Intervals.icu
    so that it flows to Watchletic on the Apple Watch.
    """
    success = await enviar_a_intervals(payload.phases)
    return {
        "status": "ok" if success else "error",
        "msg": "Sincronizado correctamente con Apple Watch (Watchletic)" if success else "No se pudo sincronizar. Verifica las credenciales de Intervals.icu."
    }

@app.post("/chat-coach")
async def post_chat_coach(payload: ChatCoachRequest):
    """
    Handles interactive messaging with the AI Coach (Aarón's personalized trainer).
    Provides context-aware athletic guidance and dynamically adapts recommendations.
    """
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        return {"respuesta": "Hola Aarón. En este momento el modo chat de IA está desconectado. ¿En qué puedo ayudarte con tu rutina local?"}
        
    try:
        real_history = await get_intervals_history()
        wiki_context = get_wiki_context()
        garmin_wellness = garmin_client.get_garmin_wellness() if garmin_client.is_garmin_connected() else {}
        client = genai.Client(api_key=api_key)
        
        system_instruction = (
            "Eres el Coach y Entrenador Personal IA de **Aarón**, un atleta de 43 años "
            "que mide 1.83 m y pesa 93 kg.\n\n"
            "ACCESO A BASE DE CONOCIMIENTO VIVA (LLM WIKI) Y GARMIN CONNECT:\n"
            "Tienes acceso completo a la base de conocimiento viva de Aarón (/wiki) y a su historial real de Garmin Connect / Strava. "
            "DEBES consultar y respetar siempre este contexto al responderle o proponer ajustes a su plan.\n\n"
            "DIRECTRICES DE PERSONALIDAD Y COACHING:\n"
            "1. Tono: Cercano, directo, motivador y profesional. Dirígete a él siempre como 'Aarón'.\n"
            "2. Contexto físico y Materiales: Tiene 43 años, mide 1.83m y pesa 93kg. Para entrenar dispone de **bandas de resistencia (cintas elásticas)** y **mancuernas de 5 kg (pesas de 5 kg)**. Sus entrenamientos de Fuerza siguen el sistema Strava Strength.\n"
            "3. REGLA DE RECONFIGURACIÓN DE ENTRENAMIENTO EN TIEMPO REAL (COHERENCIA TOTAL EN LA APP):\n"
            "   - Si Aarón en su mensaje te pide cambiar, adaptar, acortar, personalizar o reconfigurar su entrenamiento de hoy (por ejemplo: pedir ejercicios distintos, cambiar de fuerza a carrera o viceversa, pedir una rutina de 20 minutos, enfocarse en tren superior/core, o reportar fatiga/molestias musculares), DEBES RECONFIGURAR SU ENTRENAMIENTO.\n"
            "   - En ese caso, establece 'tiene_cambio_rutina': true y rellena el objeto 'rutina_actualizada' con la sesión completa ajustada (tipo_sesion: 'Fuerza' o 'Carrera', explicacion_tipo, ejercicios para Fuerza o phases para Carrera, mensaje_adaptacion).\n"
            "   - Si el mensaje es una simple duda o conversación sin intención de cambiar la sesión del día, establece 'tiene_cambio_rutina': false y 'rutina_actualizada': null.\n"
            "4. Concisión: Mantén tu 'respuesta' escrita de forma clara (máximo 2-3 párrafos) explicando las razones del ajuste."
        )

        
        historial_str = ""
        if real_history:
            historial_str = "Historial de entrenamientos de Aarón (Garmin / Strava):\n"
            for log in real_history[:15]:
                dist_str = f", Distancia: {log['distancia_km']} km" if log.get('distancia_km') else ""
                fc_str = f", FC Media: {log['frecuencia_cardiaca_media']} ppm" if log.get('frecuencia_cardiaca_media') else ""
                ritmo_str = f", Ritmo: {log['ritmo_medio']}" if log.get('ritmo_medio') else ""
                historial_str += f"- {log['fecha']}: {log['tipo']} ({log['nombre']}). {log['duracion_minutos']} min{dist_str}{fc_str}{ritmo_str}\n"
        else:
            historial_str = "No hay historial disponible todavía en Garmin Connect."

        contents = []
        
        intro_prompt = f"""
        Perfil del atleta:
        - Nombre: Aarón
        - Edad: 43 años
        - Estatura: 1.83 m | Peso: 93 kg
        - Equipamiento: Mancuernas de 5 kg y cintas elásticas
        - Garmin Wellness hoy: {json.dumps(garmin_wellness, ensure_ascii=False)}
        - Historial físico real:
        {historial_str}

        {wiki_context}
        """
        
        for msg in payload.historial[-6:]:
            contents.append(
                types.Content(
                    role=msg.role,
                    parts=[types.Part.from_text(text=msg.parts)]
                )
            )
            
        contents.append(
            types.Content(
                role="user",
                parts=[types.Part.from_text(text=payload.mensaje)]
            )
        )
        
        chat_data = await generate_gemini_content_with_retry(
            client=client,
            contents=contents,
            system_instruction=system_instruction + "\n\n" + intro_prompt,
            response_schema=GeminiChatResponse,
            temperature=0.7
        )
        if isinstance(chat_data, dict) and chat_data.get("tiene_cambio_rutina") and chat_data.get("rutina_actualizada"):
            chat_data["rutina_actualizada"] = await enrich_routine_data(chat_data["rutina_actualizada"])
        return chat_data
        
    except Exception as e:
        print("Chat Coach error:", e)
        return {
            "respuesta": "¡Hola Aarón! En este momento los servidores centrales están experimentando una alta demanda puntual. No te preocupes: para tu entrenamiento de hoy mantenemos el enfoque planeado con tus pesas de 5kg y cintas. ¡Escríbeme en unos segundos para continuar!",
            "tiene_cambio_rutina": False,
            "rutina_actualizada": None
        }


def obtener_clima_actual(latitud: float, longitud: float) -> str:
    """
    Obtiene las condiciones climáticas actuales para una ubicación geográfica
    basándose en su latitud y longitud.

    Args:
        latitud: La latitud en grados decimales (ej. 40.4168).
        longitud: La longitud en grados decimales (ej. -3.7038).

    Returns:
        Un resumen que describe si llueve, hace calor extremo (>35°C) o si el clima es ideal para entrenar.
    """
    try:
        url = f"https://api.open-meteo.com/v1/forecast?latitude={latitud}&longitude={longitud}&current_weather=true"
        res = requests.get(url, timeout=5.0)
        if res.status_code == 200:
            data = res.json()
            current = data.get("current_weather", {})
            temp = current.get("temperature", 22.0)
            wcode = current.get("weathercode", 0)
            
            # Extreme heat check (>35 degrees Celsius)
            if temp > 35.0:
                return f"Calor extremo detectado: {temp}°C. Es peligroso correr al aire libre."
            
            # Rain weather codes check (drizzle, rain, snow, showers, thunderstorms)
            rain_codes = {51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99}
            if wcode in rain_codes:
                return f"Lluvia detectada (código de clima {wcode}). El suelo está resbaladizo."
            
            return f"Clima ideal detectado: {temp}°C con código de clima {wcode}. Es seguro entrenar fuera."
        else:
            return "No se pudo obtener el clima (error de respuesta API). Asume clima ideal."
    except Exception as e:
        return f"Excepción al consultar clima: {e}. Asume clima ideal."

def obtener_ruta_visual(categoria: str) -> str:
    """
    Obtiene la ruta local del recurso multimedia (video demostrativo o imagen vectorial SVG)
    asociado a una categoría o postura específica.

    Args:
        categoria: El nombre del ejercicio, postura o grupo muscular (ej. 'sentadilla', 'árbol', 'guerrero').

    Returns:
        La ruta relativa del archivo en el servidor (ej. '/static/videos/sentadilla.mp4').
    """
    catalog = {
        "sentadilla": "/static/videos/sentadilla.mp4",
        "squat": "/static/videos/sentadilla.mp4",
        "arbol": "/static/yoga/arbol.svg",
        "tree": "/static/yoga/arbol.svg",
        "perro": "/static/yoga/perro.svg",
        "downward-dog": "/static/yoga/perro.svg",
        "guerrero": "/static/yoga/guerrero.svg",
        "warrior": "/static/yoga/guerrero.svg",
        "nino": "/static/yoga/nino.svg",
        "child": "/static/yoga/nino.svg",
        "esfinge": "/static/yoga/esfinge.svg",
        "sphinx": "/static/yoga/esfinge.svg",
        "cadaver": "/static/yoga/cadaver.svg",
        "corpse": "/static/yoga/cadaver.svg"
    }
    clean_cat = categoria.lower()
    for key, value in catalog.items():
        if key in clean_cat:
            return value
    return "/static/images/default.png"


# --- Pydantic models for RutinaHoy Response ---
class EjercicioRutina(BaseModel):
    nombre: str
    series: int
    repeticiones: str
    descripcion: str
    ruta_recurso: str

class RutinaHoyResponse(BaseModel):
    tipo_sesion: Literal["Carrera", "Yoga", "Fuerza"]
    mensaje_motivacional: str
    ejercicios: List[EjercicioRutina]


@app.get("/rutina-hoy")
async def get_rutina_hoy(
    lat: Optional[float] = 39.3739,
    lon: Optional[float] = -0.4439,
    city: Optional[str] = "Alcàsser (Valencia) España"
):
    """
    Genera y adapta la rutina para el día de hoy utilizando Function Calling de Gemini.
    Vigila el clima usando open-meteo API y asigna las rutas visuales de los ejercicios.
    Soporta geolocalización dinámica (lat, lon, city) enviada por el frontend del navegador.
    """
    bloque_hoy = "Carrera"
    
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        print("[Rutina Hoy] API Key missing. Returning fallback.")
        return {
            "tipo_sesion": "Carrera",
            "mensaje_motivacional": f"¡Hoy toca rodar en {city}! El clima es ideal, sal a disfrutar del entrenamiento.",
            "ejercicios": [
                {
                    "nombre": "Trote Suave Regenerativo",
                    "series": 1,
                    "repeticiones": "35 min",
                    "descripcion": "Mantén un ritmo muy suave y conversacional durante toda la sesión.",
                    "ruta_recurso": "/static/images/default.png"
                }
            ]
        }
        
    try:
        # Initialize GenAI Client using google-genai SDK
        client = genai.Client(api_key=api_key)
        
        system_instruction = (
            "Eres el entrenador personal inteligente de AaronFit (entrenador personal de Aarón, 43 años, 1.83 m, 93 kg).\n"
            f"Hoy está planificado una sesión de '{bloque_hoy}' en la ubicación '{city}' (Latitud: {lat}, Longitud: {lon}).\n"
            "Debes cumplir estrictamente con las siguientes reglas:\n"
            "1. Si el tipo de sesión planificada hoy es 'Carrera', debes consultar OBLIGATORIAMENTE el clima actual llamando a la herramienta 'obtener_clima_actual' pasando las coordenadas correctas del usuario.\n"
            "2. Si la herramienta del clima indica condiciones adversas (como lluvia detectada o calor extremo mayor a 35°C), "
            "debes cancelar la carrera por seguridad y en su lugar generar una sesión de 'Yoga' de recuperación.\n"
            "3. Si el clima es ideal o seguro, procede a generar la sesión de 'Carrera' planificada.\n"
            "4. Para cada ejercicio o postura (asana) generada en la lista, debes llamar obligatoriamente a la herramienta 'obtener_ruta_visual' "
            "pasándole el nombre o la categoría para rellenar el campo 'ruta_recurso' con la ruta del archivo correspondiente.\n"
            "5. Devuelve la respuesta final estrictamente en formato JSON cumpliendo con el esquema proporcionado."
        )
        
        prompt = (
            f"Genera la rutina recomendada para hoy. Recuerda consultar el clima si toca Carrera, "
            f"y adjuntar las rutas de recursos multimedia correctas para cada ejercicio."
        )
        
        # Call Gemini with tools and schema
        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=prompt,
            config=types.GenerateContentConfig(
                system_instruction=system_instruction,
                tools=[obtener_clima_actual, obtener_ruta_visual],
                response_mime_type="application/json",
                response_schema=RutinaHoyResponse,
                temperature=0.7
            )
        )
        
        # Load and parse the structured JSON response text
        result = json.loads(response.text)
        return result
        
    except Exception as e:
        print("[Rutina Hoy Error]:", e)
        raise HTTPException(status_code=500, detail=f"Error al generar la rutina del día: {e}")






# ============================================================
# GARMIN CONNECT DIRECT ENDPOINTS
# ============================================================
class GarminLoginPayload(BaseModel):
    email: str
    password: str

class GarminMfaPayload(BaseModel):
    code: str

class GarminKeyPayload(BaseModel):
    api_key: str

@app.post("/api/garmin/set-key")
async def garmin_set_key(payload: GarminKeyPayload):
    key = payload.api_key.strip()
    if not key.startswith("GCDC_"):
        return {"status": "error", "message": "La clave debe empezar por GCDC_"}
    garmin_client.save_personal_key(key)
    token = garmin_client._get_personal_api_token()
    if not token:
        return {"status": "error", "message": "No se pudo validar la clave GCDC_ contra Garmin Connect."}
    cached_recommendation_data["date"] = None
    cached_recommendation_data["data"] = None
    return {"status": "connected", "message": "Clave GCDC_ de Garmin Connect activada correctamente."}

@app.get("/api/garmin/status")
async def garmin_status():
    connected = garmin_client.is_garmin_connected()
    write_connected = any(garmin_client.TOKEN_DIR.glob("*.json")) if garmin_client.HAS_GARMINCONNECT else False
    profile = garmin_client.get_garmin_athlete_profile() if connected else {}
    return {
        "connected": connected,
        "write_connected": write_connected,
        "db_backend": "postgresql" if database.is_postgres_active() else "sqlite",
        "profile": profile,
    }

@app.post("/api/garmin/login")
async def garmin_login(payload: GarminLoginPayload):
    return garmin_client.start_garmin_login(payload.email, payload.password)

@app.post("/api/garmin/mfa")
async def garmin_mfa(payload: GarminMfaPayload):
    return garmin_client.complete_garmin_mfa(payload.code)

@app.get("/api/garmin/sync")
async def garmin_sync():
    if not garmin_client.is_garmin_connected():
        raise HTTPException(status_code=401, detail="Garmin Connect no está vinculado todavía.")
    activities = garmin_client.get_garmin_history(limit=30)
    if activities:
        database.upsert_activities(activities)
        # Pre-cache GPS polylines & splits for latest 5 activities
        for act in activities[:5]:
            eid = str(act.get("id") or "")
            if eid:
                existing = database.get_activity_detail(eid)
                if not existing or not existing.get("polyline"):
                    det = garmin_client.get_garmin_activity_details(eid)
                    if det.get("polyline") or det.get("splits"):
                        database.save_activity_stream(
                            eid,
                            det.get("polyline"),
                            det.get("splits", []),
                            det.get("hr_zones", []),
                            det.get("chart_series", {}),
                            det.get("elevation_gain", 0),
                        )
    wellness = garmin_client.get_garmin_wellness()
    profile = garmin_client.get_garmin_athlete_profile()
    return {
        "status": "ok",
        "activities_count": len(activities),
        "activities": activities,
        "wellness": wellness,
        "profile": profile,
    }


@app.post("/api/garmin/send-workout")
async def garmin_send_workout(workout: dict):
    """
    Sends a generated workout (Fuerza or Carrera) directly to the user's Garmin watch
    if an OAuth session is active, or prepares a native Garmin .FIT download.
    """
    res = garmin_client.send_workout_to_garmin_watch(workout)
    return res


@app.post("/api/garmin/export-fit")
async def garmin_export_fit(workout: dict):
    """Encodes a generated workout (Fuerza or Carrera) as a native binary Garmin .FIT file."""
    tipo = workout.get("tipo_sesion", "Carrera")
    steps = garmin_client.workout_to_fit_steps(workout)
    fit_bytes = fit_encoder.build_garmin_fit_workout(
        workout_name=f"AaronFit {tipo}",
        sport_type=tipo,
        steps=steps,
    )
    filename = f"aaronfit_{tipo.lower()}.fit"
    return Response(
        content=fit_bytes,
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ============================================================
# PLANIFICADOR SEMANAL GARMIN + CARRERA OBJETIVO + TENDENCIA
# ============================================================
PLAN_STATE_FILE = (
    "/tmp/aaron_plan_state.json"
    if os.getenv("VERCEL")
    else os.path.join(os.path.dirname(__file__), "data", "aaron_plan_state.json")
)


def _load_plan_state() -> dict:
    try:
        raw = database.get_setting("aaron_plan_state")
        if raw:
            return json.loads(raw)
    except Exception as e:
        print(f"[PlanState] DB read error: {e}")
    try:
        if os.path.exists(PLAN_STATE_FILE):
            with open(PLAN_STATE_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
    except Exception as e:
        print(f"[PlanState] Read error: {e}")
    return {"carrera_objetivo": None, "plan_semanal": None}


def _save_plan_state(state_data: dict) -> None:
    try:
        database.set_setting("aaron_plan_state", json.dumps(state_data, ensure_ascii=False))
    except Exception as e:
        print(f"[PlanState] DB write error: {e}")
    try:
        os.makedirs(os.path.dirname(PLAN_STATE_FILE), exist_ok=True)
        with open(PLAN_STATE_FILE, "w", encoding="utf-8") as f:
            json.dump(state_data, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"[PlanState] Write error: {e}")


class CarreraObjetivoPayload(BaseModel):
    nombre: str = ""
    fecha: str = ""
    distancia_km: float = 10.0
    activo: bool = True


def _calcular_fase_y_tendencia(history: List[dict], carrera_obj: Optional[dict]) -> dict:
    from datetime import date, datetime, timedelta
    today = date.today()
    d14 = today - timedelta(days=14)
    d28 = today - timedelta(days=28)

    km_run_14 = 0.0
    km_run_prev = 0.0
    km_bike_14 = 0.0
    min_14 = 0.0
    min_prev = 0.0
    paces_sec = []

    for act in history:
        f_str = act.get("fecha", "")
        if not f_str:
            continue
        try:
            dt = datetime.strptime(f_str[:10], "%Y-%m-%d").date()
        except Exception:
            continue

        dur = float(act.get("duracion_minutos") or 0)
        dist = float(act.get("distancia_km") or 0)
        tipo = act.get("tipo", "")

        if dt >= d14:
            min_14 += dur
            if tipo == "Carrera":
                km_run_14 += dist
                if dist > 0 and dur > 0:
                    paces_sec.append((dur * 60.0) / dist)
            elif tipo == "Ciclismo":
                km_bike_14 += dist
        elif dt >= d28:
            min_prev += dur
            if tipo == "Carrera":
                km_run_prev += dist

    avg_pace_str = "5:35 min/km"
    if paces_sec:
        avg_s = sum(paces_sec) / len(paces_sec)
        avg_pace_str = f"{int(avg_s // 60)}:{int(avg_s % 60):02d} min/km"

    if min_prev > 0:
        pct = round(((min_14 - min_prev) / min_prev) * 100)
    else:
        pct = 12 if min_14 > 0 else 0

    if pct >= 5:
        tendencia_label = f"En Ascenso (+{pct}%)"
    elif pct <= -15:
        tendencia_label = f"Reactivando ({pct}%)"
    else:
        tendencia_label = f"Consolidando ({'+' if pct >= 0 else ''}{pct}%)"

    fase = "Tendencia Ascendente Continua"
    dias_restantes = None
    if carrera_obj and carrera_obj.get("activo") and carrera_obj.get("fecha"):
        try:
            race_dt = datetime.strptime(carrera_obj["fecha"][:10], "%Y-%m-%d").date()
            dias_restantes = (race_dt - today).days
            if dias_restantes < 0:
                fase = "Recuperación Post-Carrera"
            elif dias_restantes <= 10:
                fase = "Taper Pre-Carrera (Descarga)"
            elif dias_restantes <= 28:
                fase = "Pico Específico de Carrera"
            else:
                fase = "Construcción Progresiva"
        except Exception:
            pass

    return {
        "km_carrera_14d": round(km_run_14, 1),
        "km_bici_14d": round(km_bike_14, 1),
        "minutos_14d": round(min_14),
        "ritmo_medio_garmin": avg_pace_str,
        "tendencia_pct": pct,
        "tendencia_label": tendencia_label,
        "fase_actual": fase,
        "dias_para_carrera": dias_restantes,
    }


def _construir_plan_semanal(history: List[dict], carrera_obj: Optional[dict]) -> dict:
    from datetime import date, timedelta
    today = date.today()
    monday = today - timedelta(days=today.weekday())
    metrics = _calcular_fase_y_tendencia(history, carrera_obj)

    # Map completed activities by date in current week
    completed_by_date: dict = {}
    for act in history:
        f_str = (act.get("fecha") or "")[:10]
        if f_str:
            completed_by_date.setdefault(f_str, []).append(act)

    fase = metrics["fase_actual"]
    dias_carrera = metrics["dias_para_carrera"]
    is_taper = dias_carrera is not None and 0 <= dias_carrera <= 10
    is_peak = dias_carrera is not None and 11 <= dias_carrera <= 28

    # Base weekly target km slightly upward from recent 14d/2 average (capped safely)
    base_weekly_km = max(16.0, round((metrics["km_carrera_14d"] / 2.0) * 1.07, 1))
    if is_taper:
        base_weekly_km = round(base_weekly_km * 0.65, 1)

    rodaje_km = max(6.0, round(base_weekly_km * 0.30, 1))
    calidad_km = max(6.5, round(base_weekly_km * 0.32, 1))
    larga_km = max(8.0, round(base_weekly_km * 0.38, 1))

    # 7-day Monday-Sunday schedule: Cardio core + 2 Optional Strava Strength sessions
    day_names = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"]
    template = [
        {
            "dia_idx": 0,
            "tipo": "Fuerza",
            "titulo": "Fuerza Express (Opcional)",
            "detalle": "25–30 min • Strava Strength (5 kg + cintas) si tienes hueco hoy.",
            "opcional": True,
            "duracion_min": 30,
        },
        {
            "dia_idx": 1,
            "tipo": "Carrera",
            "titulo": f"Rodaje Base Z2 ({rodaje_km} km)",
            "detalle": f"Ritmo cómodo ~5:35–5:50/km • Construcción aeróbica ascendente.",
            "opcional": False,
            "duracion_min": 40,
        },
        {
            "dia_idx": 2,
            "tipo": "Descanso",
            "titulo": "Descanso / Movilidad",
            "detalle": "Asimilación de carga y cuidado articular (93 kg).",
            "opcional": False,
            "duracion_min": 0,
        },
        {
            "dia_idx": 3,
            "tipo": "Carrera",
            "titulo": (
                f"Activación Pre-Carrera ({round(calidad_km * 0.7, 1)} km)"
                if is_taper
                else f"Calidad Runna / Tempo ({calidad_km} km)"
            ),
            "detalle": (
                "Cambios de ritmo cortos para chispa sin fatiga."
                if is_taper
                else f"Intervalos progresivos estilo Runna {'específicos de carrera' if is_peak else 'para subir umbral'}."
            ),
            "opcional": False,
            "duracion_min": 45 if not is_taper else 30,
        },
        {
            "dia_idx": 4,
            "tipo": "Fuerza",
            "titulo": "Fuerza Core & Pierna (Opcional)",
            "detalle": "25 min • Prevención de lesiones (opcional según agenda).",
            "opcional": True,
            "duracion_min": 25,
        },
        {
            "dia_idx": 5,
            "tipo": "Carrera",
            "titulo": f"Tirada Larga Progresiva ({larga_km} km)",
            "detalle": "Ritmo controlado Z2–Z3 • Base sólida o bici en ruta alternativa.",
            "opcional": False,
            "duracion_min": 55 if not is_taper else 35,
        },
        {
            "dia_idx": 6,
            "tipo": "Descanso",
            "titulo": "Recuperación Semanal",
            "detalle": "Descanso completo para consolidar la tendencia ascendente.",
            "opcional": False,
            "duracion_min": 0,
        },
    ]

    dias = []
    for item in template:
        d_date = monday + timedelta(days=item["dia_idx"])
        d_str = d_date.isoformat()
        acts_today = completed_by_date.get(d_str, [])
        is_race_day = (
            carrera_obj
            and carrera_obj.get("activo")
            and carrera_obj.get("fecha", "")[:10] == d_str
        )
        entry = {
            "dia": day_names[item["dia_idx"]],
            "fecha": d_str,
            "es_hoy": d_date == today,
            "tipo": "Carrera Objetivo" if is_race_day else item["tipo"],
            "titulo": f"🏁 {carrera_obj['nombre']} ({carrera_obj['distancia_km']} km)" if is_race_day else item["titulo"],
            "detalle": "¡Día de competición! Disfruta todo el trabajo acumulado." if is_race_day else item["detalle"],
            "opcional": False if is_race_day else item["opcional"],
            "duracion_min": item["duracion_min"],
            "completado": len(acts_today) > 0,
            "garmin_actividades": [a.get("nombre") for a in acts_today],
        }
        dias.append(entry)

    return {
        "semana_inicio": monday.isoformat(),
        "semana_fin": (monday + timedelta(days=6)).isoformat(),
        "objetivo_km_carrera": base_weekly_km,
        "metrics": metrics,
        "carrera_objetivo": carrera_obj,
        "dias": dias,
    }


@app.get("/api/carrera-objetivo")
async def get_carrera_objetivo():
    state_data = _load_plan_state()
    history = await get_intervals_history()
    carrera_obj = state_data.get("carrera_objetivo")
    metrics = _calcular_fase_y_tendencia(history, carrera_obj)
    return {
        "carrera_objetivo": carrera_obj,
        "metrics": metrics,
    }


@app.post("/api/carrera-objetivo")
async def post_carrera_objetivo(payload: CarreraObjetivoPayload):
    state_data = _load_plan_state()
    if not payload.activo or not payload.nombre.strip() or not payload.fecha.strip():
        state_data["carrera_objetivo"] = None
    else:
        state_data["carrera_objetivo"] = {
            "nombre": payload.nombre.strip(),
            "fecha": payload.fecha.strip()[:10],
            "distancia_km": payload.distancia_km,
            "activo": True,
        }
    _save_plan_state(state_data)
    history = await get_intervals_history()
    plan = _construir_plan_semanal(history, state_data.get("carrera_objetivo"))
    state_data["plan_semanal"] = plan
    _save_plan_state(state_data)
    return {"status": "ok", "carrera_objetivo": state_data["carrera_objetivo"], "plan": plan}


@app.get("/api/plan-semanal")
async def get_plan_semanal():
    state_data = _load_plan_state()
    history = await get_intervals_history()
    plan = _construir_plan_semanal(history, state_data.get("carrera_objetivo"))
    return plan


# ============================================================
# FASE 1-4: ACTIVITIES FEED, DETAIL STREAMS, SUMMIT ANALYTICS & GEAR
# ============================================================
@app.get("/api/activities")
async def api_list_activities(limit: int = 30):
    acts = database.get_all_activities(limit=limit)
    if not acts and garmin_client.is_garmin_connected():
        fresh = garmin_client.get_garmin_history(limit=limit)
        if fresh:
            database.upsert_activities(fresh)
            # Fetch polylines for top 5 so minimaps render immediately
            for a in fresh[:5]:
                eid = str(a.get("id") or "")
                if eid:
                    det = garmin_client.get_garmin_activity_details(eid)
                    if det.get("polyline") or det.get("splits"):
                        database.save_activity_stream(
                            eid,
                            det.get("polyline"),
                            det.get("splits", []),
                            det.get("hr_zones", []),
                            det.get("chart_series", {}),
                            det.get("elevation_gain", 0),
                        )
            acts = database.get_all_activities(limit=limit)
    return {"status": "ok", "activities": acts}


@app.get("/api/activities/{external_id}")
async def api_activity_detail(external_id: str):
    detail = database.get_activity_detail(external_id)
    if not detail:
        raise HTTPException(status_code=404, detail="Actividad no encontrada")
    if (not detail.get("splits") and not detail.get("polyline")) and garmin_client.is_garmin_connected():
        det = garmin_client.get_garmin_activity_details(external_id)
        if det.get("polyline") or det.get("splits"):
            database.save_activity_stream(
                external_id,
                det.get("polyline"),
                det.get("splits", []),
                det.get("hr_zones", []),
                det.get("chart_series", {}),
                det.get("elevation_gain", 0),
            )
            detail = database.get_activity_detail(external_id)
    return detail


@app.get("/api/analytics/summit")
async def api_summit_analytics():
    from datetime import date, datetime, timedelta
    acts = database.get_all_activities(limit=100)
    if not acts and garmin_client.is_garmin_connected():
        fresh = garmin_client.get_garmin_history(limit=30)
        if fresh:
            database.upsert_activities(fresh)
            acts = database.get_all_activities(limit=100)

    today = date.today()
    # 1. Training Log (last 84 days = 12 weeks)
    start_84 = today - timedelta(days=83)
    daily_load: dict = {}
    for a in acts:
        d_str = (a.get("start_date") or "")[:10]
        if not d_str:
            continue
        daily_load.setdefault(d_str, []).append({
            "sport_type": a.get("sport_type", "Carrera"),
            "km": float(a.get("distance_km") or 0),
            "min": float(a.get("duration_min") or 0),
            "name": a.get("name", ""),
        })

    training_log = []
    for i in range(84):
        d = start_84 + timedelta(days=i)
        ds = d.isoformat()
        entries = daily_load.get(ds, [])
        training_log.append({
            "date": ds,
            "weekday": d.weekday(),
            "entries": entries,
            "total_km": round(sum(e["km"] for e in entries), 1),
            "total_min": round(sum(e["min"] for e in entries)),
        })

    # 2. Fitness & Freshness 90-day curve (Banister EWMA CTL/ATL/TSB)
    ctl, atl = 18.0, 18.0
    fitness_curve = []
    start_90 = today - timedelta(days=89)
    for i in range(90):
        d = start_90 + timedelta(days=i)
        ds = d.isoformat()
        entries = daily_load.get(ds, [])
        # Approximate TSS from duration & intensity
        day_tss = sum(e["min"] * (1.25 if e["sport_type"] == "Carrera" else 0.9 if e["sport_type"] == "Ciclismo" else 0.7) for e in entries)
        ctl = ctl + (day_tss - ctl) / 42.0
        atl = atl + (day_tss - atl) / 7.0
        tsb = ctl - atl
        fitness_curve.append({
            "date": ds,
            "ctl": round(ctl, 1),
            "atl": round(atl, 1),
            "tsb": round(tsb, 1),
        })

    prs = database.get_personal_records()
    return {
        "training_log": training_log,
        "fitness_curve": fitness_curve,
        "personal_records": prs,
    }


class GearCreatePayload(BaseModel):
    name: str
    gear_type: str = "shoes"
    brand: str = ""
    initial_km: float = 0.0
    alert_km: float = 650.0


@app.get("/api/gear")
async def api_get_gear():
    return {"gear": database.get_gear_list()}


@app.post("/api/gear")
async def api_add_gear(payload: GearCreatePayload):
    gear = database.add_or_update_gear(
        payload.name, payload.gear_type, payload.brand, payload.initial_km, payload.alert_km
    )
    return {"status": "ok", "gear": gear}


# Create static folder if it doesn't exist
os.makedirs("static", exist_ok=True)

# Mount static files to serve the PWA frontend
app.mount("/", StaticFiles(directory="static", html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    # Run the server on port 8000
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)

