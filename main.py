from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Literal, Optional, Any
import os
import json
import httpx
from dotenv import load_dotenv
from google import genai
from google.genai import types
import exercisedb
import musclewiki

load_dotenv()

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
    tipo_sesion: Literal["Fuerza", "Carrera"]
    explicacion_tipo: str  # Why the AI selected Strength or Running today
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
    tipo: Literal["Fuerza", "Carrera"]

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
    Fetches the last 14 days of real activities from Intervals.icu API.
    Used by Gemini to decide and adapt the workout of the day.
    """
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

async def enrich_routine_data(routine: Any) -> Any:
    """Enriches strength exercises in a routine dictionary or model with ExerciseDB metadata."""
    if not routine:
        return routine
        
    routine_dict = routine if isinstance(routine, dict) else routine.dict()
    
    if routine_dict.get("tipo_sesion") == "Fuerza" and routine_dict.get("ejercicios"):
        enriched_list = []
        for ex in routine_dict["ejercicios"]:
            ex_item = ex if isinstance(ex, dict) else ex.dict() if hasattr(ex, "dict") else dict(ex)
            ex_name = ex_item.get("nombre", "")
            if ex_name:
                details = await exercisedb.get_enriched_exercise_details(ex_name)
                ex_item["gif_url"] = details.get("gif_url")
                ex_item["equipment"] = details.get("equipment")
                ex_item["target_muscle"] = details.get("target_muscle")
                ex_item["secondary_muscles"] = details.get("secondary_muscles")
                ex_item["instructions"] = details.get("instructions")
                ex_item["tips"] = details.get("tips")
            enriched_list.append(ex_item)
        routine_dict["ejercicios"] = enriched_list
        
    return routine_dict if isinstance(routine, dict) else routine_dict


async def generar_rutina_mock(tipo: str, mensaje_warning: str = None) -> dict:
    """
    Generates a localized mock routine with dynamic daily rotation and fatigue adaptation.
    Conforms to the RutinaResponse schema.
    """
    from datetime import datetime
    day_seed = datetime.now().timetuple().tm_yday
    
    is_fatigued = False
    last_workout = next((x for x in reversed(db["historial_entrenamientos"]) if x.get("completado")), None)
    if last_workout:
        if last_workout.get("esfuerzo_subjetivo") == "agotador" or (last_workout.get("frecuencia_cardiaca_media") or 0) > 165:
            is_fatigued = True

    explicacion = f"Sesión de {tipo} diseñada con periodización variada y retadora para Verónica."
    
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
    else:
        carrera_templates = [
            [
                {"name": "Calentamiento: Trote suave y movilidad", "duration_seconds": 300, "type": "WARMUP"},
                {"name": "Rodamiento Continuo Aeróbico Zona 2", "duration_seconds": 2100, "type": "WORK"},
                {"name": "Enfriamiento: Caminata y estiramientos", "duration_seconds": 300, "type": "COOLDOWN"}
            ],
            [
                {"name": "Calentamiento: Trote paulatino", "duration_seconds": 300, "type": "WARMUP"},
                {"name": "Rodamiento Suave de Asimilación", "duration_seconds": 1800, "type": "WORK"},
                {"name": "Enfriamiento: Caminata ligera", "duration_seconds": 300, "type": "COOLDOWN"}
            ]
        ]
        phases = carrera_templates[day_seed % len(carrera_templates)]
        
        msg_adapt = None
        if is_fatigued:
            phases[1]["duration_seconds"] = 1200
            msg_adapt = "Reducimos la duración del rodamiento por fatiga previa detectada."

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

    name = f"{'💪 Fuerza' if payload.tipo == 'Fuerza' else '🏃 Carrera'} — Verofit AI"

    description_lines = ["Sesión generada y guiada por Verofit — Entrenador Personal IA."]

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
def get_estado_db():
    """Helper endpoint to check current database status from frontend"""
    return db

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
        
        db["historial_entrenamientos"].append({
            "tipo": payload.tipo,
            "completado": True,
            "duracion_minutos": payload.duracion_minutos,
            "frecuencia_cardiaca_media": payload.frecuencia_cardiaca_media,
            "calorias_activas": payload.calorias_activas,
            "distancia_km": payload.distancia_km,
            "esfuerzo_subjetivo": payload.esfuerzo_subjetivo,
            "fecha": "Hoy"
        })
    else:
        db["dias_sin_entrenar"] += 1
        db["historial_entrenamientos"].append({
            "tipo": payload.tipo,
            "completado": False,
            "dias_sin_entrenar_acumulados": db["dias_sin_entrenar"],
            "fecha": "Hoy"
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
        "fecha": "Hoy"
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
    rapid_key = os.getenv("RAPIDAPI_KEY", "894945d817msh8622b11c7f9f712p171acajsnb3339e41c2f6")
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

@app.get("/api/musclewiki/{category}")
async def get_musclewiki_exercises(category: str):
    """
    Official MuscleWiki API Proxy Endpoint.
    Uses MuscleWiki X-API-Key: mw_DlcYcuEWMjyww9sFtjX8JFmb5hNylJRNNLxcpNBUnXM.
    Fetches exercises, HD video loops, and step-by-step biomechanical form cues.
    Falls back gracefully to Kaggle Catalog + Kinetic SVG Engine if restricted/offline.
    """
    mw_key = os.getenv("MUSCLEWIKI_API_KEY", "mw_DlcYcuEWMjyww9sFtjX8JFmb5hNylJRNNLxcpNBUnXM")
    url = "https://api.musclewiki.com/exercises"
    headers = {
        "X-API-Key": mw_key
    }
    params = {
        "category": category.lower().strip()
    }

    try:
        async with httpx.AsyncClient() as client:
            res = await client.get(url, headers=headers, params=params, timeout=5.0)
            if res.status_code == 200:
                data = res.json()
                return {"status": "ok", "source": "MuscleWikiAPI", "category": category, "data": data}
            else:
                print(f"[MuscleWiki Proxy] Status {res.status_code}: {res.text[:180]}")
    except Exception as e:
        print(f"[MuscleWiki Proxy Exception]: {e}")

    # Fallback to local catalog
    clean_cat = category.lower().strip()
    filtered = [ex for ex in GYM_EXERCISE_CATALOG if clean_cat in ex["target_muscle"].lower() or clean_cat in ex["grupo"].lower()]
    if not filtered:
        filtered = GYM_EXERCISE_CATALOG

    return {
        "status": "ok",
        "source": "LocalKaggleCatalog",
        "category": category,
        "data": filtered
    }



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

async def generar_analisis_plan_b(real_history: List[dict], db: dict) -> dict:
    """
    Autonomous Athletic Diagnostic & Recommendation Engine (Plan B).
    Evaluates Verónica's real Intervals.icu history according to sports science directives
    without consuming Gemini API tokens.
    """
    from datetime import datetime
    
    ultimo_detalles = None
    last_type = db.get("ultimo_entreno", "")
    days_inactive = db.get("dias_sin_entrenar", 0)
    
    fuerza_count_7d = 0
    carrera_count_7d = 0
    has_quality_run_7d = False
    trained_yesterday = False
    
    if real_history:
        sorted_history = sorted(real_history, key=lambda x: x["fecha"], reverse=True)
        ultimo_detalles = sorted_history[0]
        last_type = ultimo_detalles.get("tipo", last_type)
        
        today_date = datetime.now().date()
        monday_date = today_date - timedelta(days=today_date.weekday())
        monday_str = monday_date.strftime("%Y-%m-%d")
        
        try:
            last_date = datetime.strptime(ultimo_detalles["fecha"], "%Y-%m-%d").date()
            diff_days = (today_date - last_date).days
            days_inactive = max(0, diff_days)
            if diff_days == 1:
                trained_yesterday = True
        except Exception:
            pass
            
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

    # Apply Athletic Directives for Verónica (43a, 1.77m, 59kg, 5kg dumbbells, bands, Alcàsser)
    rec_tipo = "Fuerza"
    razon = ""
    explicacion_semanal = f"Esta semana (Lunes-Domingo): {fuerza_count_7d}/3 Fuerza • {carrera_count_7d}/2 Carrera."

    if days_inactive >= 2:
        if last_type == "Fuerza":
            rec_tipo = "Carrera"
            razon = f"¡Hola Verónica! Llevas {days_inactive} días de reposo. Para reactivar tu sistema cardiovascular y favorecer la quema de grasas sin sobrecargar las articulaciones, hoy Verofit te recomienda una sesión de Carrera Aeróbica en Zona 2."
        else:
            rec_tipo = "Fuerza"
            razon = f"¡Hola Verónica! Tras {days_inactive} días de recuperación muscular, es el momento idóneo para estimular la densidad muscular con una sesión de Fuerza Full-Body con tus mancuernas de 5kg y cintas."
    elif trained_yesterday:
        if last_type == "Fuerza":
            rec_tipo = "Carrera"
            razon = "¡Hola Verónica! Como ayer completaste un bloque de Fuerza Full-Body, hoy alternamos con Carrera Aeróbica continua en Zona 2. Esto acelera el riego sanguíneo y oxigena la musculatura en fase de recuperación."
        else:
            rec_tipo = "Fuerza"
            razon = "¡Hola Verónica! Tras la sesión de Carrera de ayer, hoy cambiamos el estímulo hacia Fuerza Full-Body. Las mancuernas de 5kg y cintas te permiten trabajar la fuerza-resistencia muscular sin impacto articular."
    else:
        if fuerza_count_7d <= carrera_count_7d:
            rec_tipo = "Fuerza"
            razon = "¡Hola Verónica! Para mantener el balance semanal ideal de 2 a 3 sesiones de Fuerza, hoy prescribimos un entrenamiento de Fuerza Full-Body (Cuerpo Completo) de 45 minutos."
        else:
            rec_tipo = "Carrera"
            razon = "¡Hola Verónica! Para complementar tus bloques de musculación con trabajo cardiovascular de base, hoy Verofit te recomienda una sesión de Carrera aeróbica suave en Zona 2."

    return {
        "recomendacion": rec_tipo,
        "razon": razon,
        "explicacion_semanal": explicacion_semanal,
        "ultimo_entreno_detalles": ultimo_detalles,
        "historial_real": real_history
    }

@app.get("/recomendacion-hoy")
async def get_recomendacion_hoy():
    """
    Generates today's personalized recommendation for Verónica (43, 1.77m, 59kg, Alcàsser)
    evaluating her actual activity history from Intervals.icu via Plan B engine.
    """
    global cached_recommendation_data
    from datetime import date
    today_str = date.today().isoformat()
    if cached_recommendation_data["date"] == today_str and cached_recommendation_data["data"] is not None:
        print("[Cache Server] Returning cached recommendation for today.")
        return cached_recommendation_data["data"]

    try:
        real_history = await get_intervals_history()
        # PLAN B ENGINE: Fast, reliable, 0 token consumption!
        rec_data = await generar_analisis_plan_b(real_history, db)
        
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
    adapted in volume and intensity based on the Intervals.icu history for Verónica.
    """
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        return await generar_rutina_mock(payload.tipo, "Modo local offline.")
        
    try:
        real_history = await get_intervals_history()
        client = genai.Client(api_key=api_key)
        
        system_instruction = (
            "Eres la Coach IA de **Verofit**, la aplicación de entrenamiento personal exclusiva de **Verónica**, una atleta de 43 años, de Alcàsser (Valencia), "
            "que mide 1.77 m y pesa 59 kg (cuerpo atlético, extremidades largas, excelente palanca). "

            "Ella busca rutinas intensas, retadoras y de mayor duración.\n\n"
            f"Tu tarea hoy es generar la sesión detallada para el tipo seleccionado: '{payload.tipo}'.\n\n"
            "INSTRUCCIONES DE MATERIALES Y ENFOQUE DE FUERZA:\n"
            "Verónica solo dispone de **bandas de resistencia (cintas)** y **mancuernas de 5 kg (pesas de 5 kg)**.\n"
            "Los entrenamientos de fuerza deben ser de **Cuerpo Completo (Full-Body)** combinando empujes, tracciones, tren inferior, piernas/glúteos y core.\n\n"
            "INSTRUCCIONES DE ESTRUCTURA Y VOLUMEN:\n"
            "Dirígete a ella por su nombre ('Verónica') en las explicaciones y adaptaciones.\n"
            "1. Si el tipo es 'Fuerza':\n"
            "   - REGLA DE VARIEDAD Y DIVERSIFICACIÓN: NUNCA repitas la misma rutina o combinación exacta que la última sesión. Alterna entre enfoques de fuerza (Enfoque A: Predominio de cadera y glúteo con Peso muerto rumano unilateral y Hip thrust; Enfoque B: Cuádriceps y empujes con Sentadilla sumo isométrica y Press militar; Enfoque C: Tracciones y unilaterales con Zancadas caminadas y Remos con cinta).\n"
            "   - Genera una rutina exigente de Cuerpo Completo (Full-Body) de entre 45 y 60 minutos de duración.\n"
            "   - Diseña entre 5 y 6 ejercicios exigentes, especificando 4 o 5 series de 15-22 repeticiones (el rango de repeticiones debe ser alto dada la carga de 5 kg).\n"
            "   - Incluye siempre un ejercicio de core estático o dinámico por tiempo (ej. Plancha isométrica, Bicho muerto, o Escaladores de 45-60 segundos).\n"
            "   - Rellena obligatoriamente una 'descripcion' corta y clara sobre la ejecución para cada ejercicio detallando el tempo (ej: 'bajada en 3 segundos') y el uso de las cintas o pesas de 5 kg.\n"

            "2. Si el tipo es 'Carrera':\n"
            "   - REGLA DE ORO DE CARRERA (EVITAR LESIONES): Los entrenamientos de calidad (Fartleks, series o intervalos de velocidad) son de alta carga de intensidad y fatiga acumulada. Se permite ÚNICAMENTE una (1) sesión de calidad a la semana (últimos 7 días). Todos los demás entrenamientos de carrera de la semana deben ser obligatoriamente de **Rodamiento Suave** (running a ritmo sostenido y cómodo en Zona 2, trote continuo de 35 a 45 minutos de duración, a ritmo conversacional).\n"
            "   - Analiza rigurosamente el historial de los últimos 7 días. Si ya figura cualquier carrera que contenga en su nombre o descripción las palabras 'fartlek', 'intervalos', 'series', 'velocidad', 'cuestas', o ritmos altos (o si hay una sesión de carrera que no esté marcada explícitamente como rodamiento suave/regenerativo), DEBES generar obligatoriamente un **Rodamiento Suave**.\n"
            "   - Solo si NO figura ningún entrenamiento de calidad en los últimos 7 días del historial, diseña un entrenamiento exigente de intervalos (ej: Calentamiento 5m + 6-8 series de 90s rápido/45s andar + Enfriamiento 5m) o un Fartlek dinámico.\n\n"
            "INSTRUCCIÓN DE ADAPTACIÓN INTELIGENTE:\n"
            "Dosifica las cargas (menos series o ritmos más lentos) solo si el historial revela fatiga extrema o pulsaciones anormalmente elevadas. De lo contrario, genera una sesión altamente retadora.\n\n"
            "Devuelve un JSON estrictamente compatible con RutinaResponse."
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
        Días sin entrenar: {db['dias_sin_entrenar']}.
        {historial_str}
        
        Genera la sesión adaptada y detallada de {payload.tipo} para Verónica.
        """
        
        workout = await generate_gemini_content_with_retry(
            client=client,
            contents=prompt,
            system_instruction=system_instruction,
            response_schema=RutinaResponse,
            temperature=0.85
        )
        return await enrich_routine_data(workout)
        
    except Exception as e:
        print("Gemini generation error:", e)
        return await generar_rutina_mock(payload.tipo, "Modo de respaldo activo por alta demanda de red.")


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
    Handles interactive messaging with the AI Coach (Verónica's personalized trainer).
    Provides context-aware athletic guidance and dynamically adapts recommendations.
    """
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        return {"respuesta": "Hola Verónica. En este momento el modo chat de IA está desconectado. ¿En qué puedo ayudarte con tu rutina local?"}
        
    try:
        real_history = await get_intervals_history()
        client = genai.Client(api_key=api_key)
        
        system_instruction = (
            "Eres el Coach y Entrenador de Fitness personal de **Verónica**, una atleta de 43 años, "
            "de Alcàsser (Valencia), que mide 1.77 m y pesa 59 kg (cuerpo atlético y magro, de raza blanca).\n\n"
            "DIRECTRICES DE PERSONALIDAD Y COACHING:\n"
            "1. Tono: Súper cercano, motivador, profesional y empático. Dirígete a ella siempre como 'Verónica'.\n"
            "2. Contexto físico y Materiales: Tiene 43 años, mide 1.77m y pesa 59kg. Para entrenar en casa dispone únicamente de **bandas de resistencia (cintas)** y **mancuernas de 5 kg (pesas de 5 kg)**. Sus rutinas de Fuerza son siempre de **Cuerpo Completo (Full-Body)**.\n"
            "3. REGLA DE RECONFIGURACIÓN DE ENTRENAMIENTO EN TIEMPO REAL (COHERENCIA TOTAL EN LA APP):\n"
            "   - Si Verónica en su mensaje te pide cambiar, adaptar, acortar, personalizar o reconfigurar su entrenamiento de hoy (por ejemplo: pedir ejercicios distintos, cambiar de fuerza a carrera o viceversa, pedir una rutina de 20 minutos, enfocarse en glúteos/core, o reportar fatiga/molestias musculares), DEBES RECONFIGURAR SU ENTRENAMIENTO.\n"
            "   - En ese caso, establece 'tiene_cambio_rutina': true y rellena el objeto 'rutina_actualizada' con la sesión completa ajustada (tipo_sesion: 'Fuerza' o 'Carrera', explicacion_tipo, ejercicios para Fuerza o phases para Carrera, mensaje_adaptacion).\n"
            "   - Si el mensaje es una simple duda o conversación sin intención de cambiar la sesión del día, establece 'tiene_cambio_rutina': false y 'rutina_actualizada': null.\n"
            "4. Concisión: Mantén tu 'respuesta' escrita de forma cercana (máximo 2-3 párrafos) explicando las razones del ajuste y animándola."
        )

        
        historial_str = ""
        if real_history:
            historial_str = "Historial de entrenamientos de Verónica (últimos 10 días de su reloj):\n"
            for log in real_history:
                dist_str = f", Distancia: {log['distancia_km']} km" if log['distancia_km'] else ""
                fc_str = f", FC Media: {log['frecuencia_cardiaca_media']} ppm" if log['frecuencia_cardiaca_media'] else ""
                historial_str += f"- {log['fecha']}: {log['tipo']} ({log['nombre']}). {log['duracion_minutos']} min{dist_str}{fc_str}\n"
        else:
            historial_str = "No hay historial disponible todavía en Intervals.icu."

        contents = []
        
        intro_prompt = f"""
        Perfil del atleta:
        - Nombre: Verónica
        - Edad: 43 años
        - Ubicación: Alcàsser (Valencia)
        - Estatura: 1.77 m | Peso: 59 kg (Cuerpo atlético)
        - Historial físico real:
        {historial_str}
        """
        
        for msg in payload.historial:
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
            "respuesta": "¡Hola Verónica! En este momento los servidores centrales están experimentando una alta demanda puntual. No te preocupes: para tu entrenamiento de hoy mantenemos el enfoque planeado con tus pesas de 5kg y cintas. ¡Escríbeme en unos segundos para continuar!",
            "tiene_cambio_rutina": False,
            "rutina_actualizada": None
        }


@app.get("/api/ejercicios")
async def get_ejercicios_catalog():
    """Endpoint returning full ExerciseDB strength catalog with GIFs & technique details"""
    return {
        "status": "ok",
        "ejercicios": exercisedb.get_all_fallback_exercises()
    }


@app.get("/api/musclewiki/categorias")
async def get_musclewiki_categories_endpoint():
    """Returns MuscleWiki muscle group categories"""
    return {
        "status": "ok",
        "categorias": musclewiki.MUSCLEWIKI_CATEGORIES
    }


@app.get("/api/musclewiki/ejercicios")
async def get_musclewiki_ejercicios_endpoint(categoria: Optional[str] = "all"):
    """Returns MuscleWiki exercises filtered by muscle category"""
    ejercicios = musclewiki.get_musclewiki_exercises_by_category(categoria)
    return {
        "status": "ok",
        "categoria": categoria,
        "ejercicios": ejercicios
    }




# Create static folder if it doesn't exist
os.makedirs("static", exist_ok=True)

# Mount static files to serve the PWA frontend
app.mount("/", StaticFiles(directory="static", html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    # Run the server on port 8000
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)

