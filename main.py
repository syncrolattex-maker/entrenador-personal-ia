from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Literal, Optional
import os
import json
import httpx
from dotenv import load_dotenv
from google import genai
from google.genai import types

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

# Simulated in-memory database with history support
db = {
    "dias_sin_entrenar": 0,
    "ultimo_entreno": "Ninguno",
    "siguiente_bloque": "Fuerza",  # Alternates between Fuerza and Carrera
    "historial_entrenamientos": []
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


# --- Helpers ---

async def get_intervals_history() -> List[dict]:
    """
    Fetches the last 10 days of real activities from Intervals.icu API.
    Used by Gemini to decide and adapt the workout of the day.
    """
    api_key = os.getenv("INTERVALS_API_KEY")
    athlete_id = os.getenv("INTERVALS_ATHLETE_ID", "").strip()
    
    if athlete_id.lower().startswith("i"):
        athlete_id = athlete_id[1:]
        
    if (not api_key or api_key == "YOUR_INTERVALS_API_KEY" or 
        not athlete_id or athlete_id == "YOUR_INTERVALS_ATHLETE_ID" or not athlete_id):
        print("Warning: Intervals credentials missing for history fetch. Using local db.")
        return []
        
    from datetime import datetime, timedelta
    oldest = (datetime.now() - timedelta(days=10)).strftime("%Y-%m-%d")
    newest = datetime.now().strftime("%Y-%m-%d")
    
    url = f"https://intervals.icu/api/v1/athlete/0/activities"
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
                    tipo_mapeado = "Fuerza" if t in ["WeightTraining", "Strength"] else "Carrera" if t in ["Run"] else t
                    history.append({
                        "tipo": tipo_mapeado,
                        "nombre": act.get("name", ""),
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
    Also formats a plain-text structured description so that Watchletic can parse and sync it to Apple Watch.
    """
    api_key = os.getenv("INTERVALS_API_KEY")
    athlete_id = os.getenv("INTERVALS_ATHLETE_ID", "").strip()
    
    if athlete_id.lower().startswith("i"):
        athlete_id = athlete_id[1:]
    
    if (not api_key or api_key == "YOUR_INTERVALS_API_KEY" or 
        not athlete_id or athlete_id == "YOUR_INTERVALS_ATHLETE_ID" or not athlete_id):
        print("Warning: INTERVALS_API_KEY or INTERVALS_ATHLETE_ID is not configured. Skipping Intervals.icu sync.")
        return False

    from datetime import datetime
    today_date = datetime.now().strftime("%Y-%m-%dT08:00:00")
    
    headers = {
        "Content-Type": "application/json"
    }
    
    # 1. Map to JSON steps for Intervals
    # 2. Build plain-text structured description for Watchletic parser
    steps = []
    desc_lines = [
        "Entrenamiento de carrera estructurado generado por tu Entrenador IA.",
        "Se sincroniza automáticamente con Apple Watch mediante Watchletic.",
        ""
    ]
    
    # Group by Warmup, Work and Cooldown headers
    warmup_steps = []
    work_steps = []
    cooldown_steps = []
    
    for p in phases:
        icu_type = "Active"
        
        if p.type == "WARMUP":
            icu_type = "Warmup"
            warmup_steps.append(p)
        elif p.type == "COOLDOWN":
            icu_type = "Cooldown"
            cooldown_steps.append(p)
        else:
            work_steps.append(p)
            
        steps.append({
            "type": icu_type,
            "duration_value": p.duration_seconds,
            "duration_type": "DURATION_SECS",
            "name": p.name
        })
    
    # Add plain text workout blocks
    if warmup_steps:
        desc_lines.append("Warmup")
        for p in warmup_steps:
            mins = p.duration_seconds // 60
            desc_lines.append(f"- {p.name} {mins}m 55-65% HR")
        desc_lines.append("")
        
    if work_steps:
        desc_lines.append("Main Set")
        # Check if it looks like interval reps
        # (e.g. 5x (90s fast + 60s walk) or similar)
        # If it is one single workout block, write it down directly
        for p in work_steps:
            mins = p.duration_seconds // 60
            secs = p.duration_seconds % 60
            dur_str = f"{mins}m"
            if secs > 0:
                dur_str += f"{secs}s"
            # High intensity check
            hr_range = "80-85% HR" if "interval" in p.name.lower() or "rápido" in p.name.lower() or "fartlek" in p.name.lower() else "65-75% HR"
            desc_lines.append(f"- {p.name} {dur_str} {hr_range}")
        desc_lines.append("")
        
    if cooldown_steps:
        desc_lines.append("Cooldown")
        for p in cooldown_steps:
            mins = p.duration_seconds // 60
            desc_lines.append(f"- {p.name} {mins}m 50-60% HR")
            
    payload = {
        "category": "WORKOUT",
        "type": "Run",
        "name": "Carrera de Hoy (IA Flow)",
        "start_date_local": today_date,
        "description": "\n".join(desc_lines),
        "workout": {
            "steps": steps
        }
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

async def generar_rutina_mock(tipo: str, mensaje_warning: str = None) -> dict:
    """
    Generates a localized offline mock routine with fatigue adaptation support.
    Conforms to the new unified RutinaResponse schema.
    """
    is_fatigued = False
    last_workout = next((x for x in reversed(db["historial_entrenamientos"]) if x.get("completado")), None)
    if last_workout:
        if last_workout.get("esfuerzo_subjetivo") == "agotador" or (last_workout.get("frecuencia_cardiaca_media") or 0) > 165:
            is_fatigued = True

    explicacion = f"Hemos generado esta sesión de {tipo} en modo offline debido a un problema con la API de Gemini."
    
    if tipo == "Fuerza":
        ejercicios = [
            {"nombre": "Sentadillas Goblet", "series": 4, "repeticiones": "12", "descripcion": "Baja lentamente empujando el suelo con talones. Trabaja glúteos y piernas."},
            {"nombre": "Hip Thrust con banda", "series": 4, "repeticiones": "15", "descripcion": "Eleva cadera contrayendo fuertemente los glúteos arriba. Enfocado en zona posterior."},
            {"nombre": "Zancadas Búlgaras", "series": 3, "repeticiones": "10 por pierna", "descripcion": "Un pie en banco o silla detrás de ti, flexiona rodilla bajando cadera. Enfoque cuádriceps y glúteos."},
            {"nombre": "Patada de Glúteo en cuadrupedia", "series": 3, "repeticiones": "15 por pierna", "descripcion": "En 4 apoyos, empuja talón al techo activando glúteo. Mantén espalda neutra."},
            {"nombre": "Core: Plancha con rotación", "series": 3, "repeticiones": "45 seg", "descripcion": "En apoyo de antebrazos, rota cadera suavemente lado a lado manteniendo abdomen tenso."}
        ]
        
        msg_adapt = None
        if is_fatigued:
            for ex in ejercicios:
                ex["series"] = max(2, ex["series"] - 1)
            msg_adapt = "Notamos cansancio acumulado. Bajamos volumen de series para favorecer la recuperación celular."

        return {
            "tipo_sesion": "Fuerza",
            "explicacion_tipo": explicacion,
            "ejercicios": ejercicios,
            "mensaje_adaptacion": msg_adapt,
            "mensaje": mensaje_warning
        }
    else:
        phases = [
            {"name": "Calentamiento: Trote suave", "duration_seconds": 300, "type": "WARMUP"},
            {"name": "Rodamiento Continuo Aeróbico", "duration_seconds": 1800, "type": "WORK"},
            {"name": "Enfriamiento: Caminata ligera", "duration_seconds": 300, "type": "COOLDOWN"}
        ]
        
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

    activity_type = "WeightTraining" if payload.tipo == "Fuerza" else "Run"
    name = f"{'💪 Fuerza' if payload.tipo == 'Fuerza' else '🏃 Carrera'} — Entrenador IA"

    description_lines = ["Sesión generada y guiada por tu Entrenador Personal IA."]
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

@app.get("/recomendacion-hoy")
async def get_recomendacion_hoy():

    """
    Generates today's personalized recommendation for Verónica (43, 1.77m, 59kg, Alcàsser)
    evaluating her actual activity history from Intervals.icu.
    """
    global cached_recommendation_data
    from datetime import date
    today_str = date.today().isoformat()
    if cached_recommendation_data["date"] == today_str and cached_recommendation_data["data"] is not None:
        print("[Cache Server] Returning cached recommendation for today.")
        return cached_recommendation_data["data"]

    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        return {
            "recomendacion": "Fuerza",
            "razon": "Hola Verónica. IA local offline. Te recomendamos Fuerza para mantener el balance semanal.",
            "explicacion_semanal": "Modo offline."
        }
        
    try:
        real_history = await get_intervals_history()

        client = genai.Client(api_key=api_key)
        
        system_instruction = (
            "Eres el entrenador personal y coach de fitness de **Verónica**, una atleta de 43 años, "
            "de Alcàsser (Valencia), que mide 1.77 m y pesa 59 kg (cuerpo atlético y magro, extremidades largas).\n\n"
            "INSTRUCCIONES DE PLANIFICACIÓN:\n"
            "1. Dirígete a ella de forma cálida, profesional y motivadora llamándola siempre por su nombre ('Verónica').\n"
            "2. Examina el historial de actividades de los últimos 10 días provisto (de su reloj e Intervals.icu):\n"
            "   - Fuerza: Meta ideal de 2 a 3 veces por semana, con alta intensidad.\n"
            "   - Carrera: Meta de 1 a 2 veces por semana. Máximo 1 sesión de alta intensidad (intervalos/fartleks) a la semana. Las demás deben ser rodamientos suaves (aeróbicos continuos).\n"
            "   - Descanso: Fundamental para asimilar el esfuerzo. Debe descansar 1 o 2 días completos.\n"
            "3. Explica de forma motivadora y científica (biomecánica o fisiológicamente, ej. asimilación de cargas, supercompensación) tu decisión.\n"
            "4. Ten en cuenta el clima cálido/húmedo mediterráneo de Alcàsser para aconsejar sobre hidratación o momento del día si corre hoy.\n"
            "5. Devuelve un JSON estrictamente según el esquema RecomendacionResponse."
        )
        
        historial_str = ""
        if real_history:
            historial_str = "Historial de entrenamientos reales (últimos 10 días de Intervals.icu):\n"
            for log in real_history:
                dist_str = f", Distancia: {log['distancia_km']} km" if log['distancia_km'] else ""
                fc_str = f", FC Media: {log['frecuencia_cardiaca_media']} ppm" if log['frecuencia_cardiaca_media'] else ""
                historial_str += f"- Fecha {log['fecha']}: {log['tipo']} ({log['nombre']}). Duración: {log['duracion_minutos']} min{dist_str}{fc_str}\n"
        else:
            historial_str = "No hay historial disponible. Recomienda Fuerza para reactivar."

        prompt = f"""
        Último entreno local trackeado: {db['ultimo_entreno']}.
        Días acumulados sin entrenar: {db['dias_sin_entrenar']}.
        {historial_str}
        
        Genera la recomendación inteligente de hoy para Verónica.
        """
        
        # Determine the last completed workout to display to Verónica
        ultimo_entreno_detalles = None
        if real_history:
            # Sort real history to get the newest
            sorted_history = sorted(real_history, key=lambda x: x["fecha"], reverse=True)
            newest = sorted_history[0]
            ultimo_entreno_detalles = {
                "tipo": newest["tipo"],
                "nombre": newest["nombre"],
                "fecha": newest["fecha"],
                "duracion_minutos": newest["duracion_minutos"],
                "frecuencia_cardiaca_media": newest["frecuencia_cardiaca_media"],
                "calorias_activas": newest["calorias_activas"],
                "distancia_km": newest["distancia_km"],
                "descripcion": newest["descripcion"]
            }
        else:
            if db["historial_entrenamientos"]:
                newest = next((x for x in reversed(db["historial_entrenamientos"]) if x.get("completado")), None)
                if newest:
                    ultimo_entreno_detalles = {
                        "tipo": newest["tipo"],
                        "nombre": newest["tipo"],
                        "fecha": newest.get("fecha", "Ayer"),
                        "duracion_minutos": newest.get("duracion_minutos", 0.0),
                        "frecuencia_cardiaca_media": newest.get("frecuencia_cardiaca_media"),
                        "calorias_activas": newest.get("calorias_activas"),
                        "distancia_km": newest.get("distancia_km"),
                        "descripcion": ""
                    }

        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=prompt,
            config=types.GenerateContentConfig(
                system_instruction=system_instruction,
                response_mime_type="application/json",
                response_schema=GeminiRecomendacionResponse,
                temperature=0.7,
            )
        )
        
        rec_data = json.loads(response.text)
        rec_data["ultimo_entreno_detalles"] = ultimo_entreno_detalles
        
        # Save to server-side cache
        cached_recommendation_data["date"] = today_str
        cached_recommendation_data["data"] = rec_data
        
        return rec_data

        
    except Exception as e:
        print("Gemini recommendation error:", e)
        # Fallback details
        ultimo_entreno_detalles = None
        if db["historial_entrenamientos"]:
            newest = next((x for x in reversed(db["historial_entrenamientos"]) if x.get("completado")), None)
            if newest:
                ultimo_entreno_detalles = {
                    "tipo": newest["tipo"],
                    "nombre": newest["tipo"],
                    "fecha": newest.get("fecha", "Ayer"),
                    "duracion_minutos": newest.get("duracion_minutos", 0.0),
                    "frecuencia_cardiaca_media": newest.get("frecuencia_cardiaca_media"),
                    "calorias_activas": newest.get("calorias_activas"),
                    "distancia_km": newest.get("distancia_km"),
                    "descripcion": ""
                }
        return {
            "recomendacion": "Fuerza",
            "razon": f"Error conectando con la IA: {str(e)}",
            "explicacion_semanal": "No se pudo obtener el análisis semanal debido a un error de conexión.",
            "ultimo_entreno_detalles": ultimo_entreno_detalles
        }



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
            "Eres el entrenador personal experto de **Verónica**, una atleta de 43 años, de Alcàsser (Valencia), "
            "que mide 1.77 m y pesa 59 kg (cuerpo atlético, extremidades largas, excelente palanca). "
            "Ella busca rutinas intensas, retadoras y de mayor duración.\n\n"
            f"Tu tarea hoy es generar la sesión detallada para el tipo seleccionado: '{payload.tipo}'.\n\n"
            "INSTRUCCIONES DE MATERIALES Y ENFOQUE DE FUERZA:\n"
            "Verónica solo dispone de **bandas de resistencia (cintas)** y **mancuernas de 5 kg (pesas de 5 kg)**.\n"
            "Los entrenamientos de fuerza deben ser de **Cuerpo Completo (Full-Body)** combinando empujes, tracciones, tren inferior, piernas/glúteos y core.\n\n"
            "INSTRUCCIONES DE ESTRUCTURA Y VOLUMEN:\n"
            "Dirígete a ella por su nombre ('Verónica') en las explicaciones y adaptaciones.\n"
            "1. Si el tipo es 'Fuerza':\n"
            "   - Genera una rutina exigente de Cuerpo Completo (Full-Body) de entre 45 y 60 minutos de duración.\n"
            "   - Diseña entre 5 y 6 ejercicios exigentes, especificando 4 o 5 series de 15-20 repeticiones (el rango de repeticiones debe ser alto, ej: '15-20', dado que las pesas son de 5 kg y buscamos intensidad metabólica y muscular).\n"
            "   - Utiliza ejercicios que aprovechen al máximo las pesas de 5 kg y las cintas para generar intensidad mediante movimientos unilaterales y tensión constante: Zancadas búlgaras con mancuernas, Peso muerto rumano a una pierna con mancuernas, Sentadillas goblet lentas con mancuerna de 5 kg, Remo unilateral con mancuerna, Flexiones con pausa abajo, y Press militar con banda de resistencia.\n"
            "   - Incluye a veces un ejercicio de core estático por tiempo (p.ej. Plancha Isométrica de 45-60 segundos), usando la palabra 'seg' o 'segundos' en la propiedad repeticiones (ej. '45 seg').\n"
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
        
        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=prompt,
            config=types.GenerateContentConfig(
                system_instruction=system_instruction,
                response_mime_type="application/json",
                response_schema=RutinaResponse,
                temperature=0.7,
            )
        )
        
        workout = json.loads(response.text)
        return workout
        
    except Exception as e:
        print("Gemini generation error:", e)
        return await generar_rutina_mock(payload.tipo, f"Error conectando con la IA: {str(e)}")

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
            "2. Contexto físico y Materiales: Tiene 43 años, mide 1.77m y pesa 59kg. Para entrenar en casa dispone únicamente de **bandas de resistencia (cintas)** y **mancuernas de 5 kg (pesas de 5 kg)**. Sus rutinas de Fuerza son siempre de **Cuerpo Completo (Full-Body)**. Tenlo muy en cuenta al proponer ejercicios, técnica y adaptaciones.\n"
            "3. Contexto geográfico y clima: Alcàsser (Valencia) tiene inviernos suaves pero veranos calurosos y muy húmedos. Si te pregunta por correr o entrenar con calor, menciónalo y dale consejos de hidratación y horarios.\n"
            "4. Análisis de Datos: Tienes acceso a su historial reciente de Intervals.icu y su reloj. Úsalo para justificar científicamente tus respuestas (ej. 'Vi que en tu carrera de ayer tu pulso medio fue de 158 ppm...', 'Llevas 2 sesiones de fuerza esta semana...').\n"
            "5. Peticiones de Adaptación: Si Verónica te dice que está cansada, que le duele alguna zona (ej. lumbares, rodillas, tendones) o que tiene poco tiempo, adáptale el enfoque del día. Explícale qué modificaciones hacer en los ejercicios usando sus cintas y mancuernas de 5 kg de forma segura.\n"
            "6. Concisión: Mantén tus respuestas relativamente cortas y al grano (máximo 3-4 párrafos) para que se lean cómodamente en una pantalla de móvil."
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
        
        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=contents,
            config=types.GenerateContentConfig(
                system_instruction=system_instruction + "\n\n" + intro_prompt,
                temperature=0.7,
            )
        )
        
        return {"respuesta": response.text}
        
    except Exception as e:
        print("Chat Coach error:", e)
        return {"respuesta": f"Lo siento Verónica, he tenido un problema de conexión: {str(e)}"}


# Create static folder if it doesn't exist
os.makedirs("static", exist_ok=True)

# Mount static files to serve the PWA frontend
app.mount("/", StaticFiles(directory="static", html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    # Run the server on port 8000
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)

