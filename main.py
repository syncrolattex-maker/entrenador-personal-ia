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

class RecomendacionResponse(BaseModel):
    recomendacion: Literal["Fuerza", "Carrera", "Descanso"]
    razon: str
    explicacion_semanal: str

class GenerarEntrenamientoPayload(BaseModel):
    tipo: Literal["Fuerza", "Carrera"]

class SincronizarCarreraPayload(BaseModel):
    phases: List[FaseCarrera]

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
    Generates a simple, lightweight recommendation for today's session (Fuerza, Carrera, or Descanso)
    by evaluating the actual activity history from Intervals.icu.
    """
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        return {
            "recomendacion": "Fuerza",
            "razon": "IA local offline. Te recomendamos Fuerza para mantener el balance semanal.",
            "explicacion_semanal": "Modo offline."
        }
        
    try:
        real_history = await get_intervals_history()
        client = genai.Client(api_key=api_key)
        
        system_instruction = (
            "Eres el entrenador personal de una atleta avanzada. Tu tarea de hoy es únicamente RECOMENDAR "
            "cuál debe ser su sesión de hoy: 'Fuerza', 'Carrera' o 'Descanso'.\n\n"
            "INSTRUCCIONES DE PLANIFICACIÓN:\n"
            "Examina el historial de actividades de los últimos 10 días provisto (de su reloj e Intervals.icu):\n"
            "- Fuerza: Meta ideal de 2 a 3 veces por semana, con alta intensidad.\n"
            "- Carrera: Meta de 1 a 2 veces por semana. Máximo 1 sesión de alta intensidad (intervalos/fartleks) a la semana. Las demás deben ser rodamientos suaves (aeróbicos continuos).\n"
            "- Descanso: Fundamental para asimilar el esfuerzo. Debe descansar 1 o 2 días completos.\n\n"
            "Analiza si entrenó ayer y el tipo de entrenamiento para aconsejar lo que corresponde hoy. "
            "Devuelve un JSON estrictamente según el esquema RecomendacionResponse. Sé claro, profesional y motivador."
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
        
        Genera la recomendación inteligente de hoy.
        """
        
        response = client.models.generate_content(
            model="gemini-flash-latest",
            contents=prompt,
            config=types.GenerateContentConfig(
                system_instruction=system_instruction,
                response_mime_type="application/json",
                response_schema=RecomendacionResponse,
                temperature=0.7,
            )
        )
        
        return json.loads(response.text)
        
    except Exception as e:
        print("Gemini recommendation error:", e)
        return {
            "recomendacion": "Fuerza",
            "razon": "Error conectando con la IA. Te aconsejamos Fuerza para el día de hoy.",
            "explicacion_semanal": "No se pudo obtener el análisis semanal debido a un error de conexión."
        }

@app.post("/generar-entrenamiento")
async def post_generar_entrenamiento(payload: GenerarEntrenamientoPayload):
    """
    Generates a detailed workout routine (exercises for Strength, or phases for Running)
    adapted in volume and intensity based on the Intervals.icu history.
    """
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        return await generar_rutina_mock(payload.tipo, "Modo local offline.")
        
    try:
        real_history = await get_intervals_history()
        client = genai.Client(api_key=api_key)
        
        system_instruction = (
            "Eres el entrenador personal experto de una mujer con nivel físico avanzado y alta tolerancia al esfuerzo. "
            "Ella busca rutinas intensas, retadoras y de mayor duración.\n\n"
            f"Tu tarea hoy es generar la sesión detallada para el tipo seleccionado: '{payload.tipo}'.\n\n"
            "INSTRUCCIONES DE ESTRUCTURA Y VOLUMEN:\n"
            "1. Si el tipo es 'Fuerza':\n"
            "   - Genera una rutina exigente enfocada en tren inferior, piernas y glúteos de entre 45 y 60 minutos de duración.\n"
            "   - Diseña entre 5 y 6 ejercicios, especificando 4 o 5 series de 10-15 repeticiones pesadas.\n"
            "   - Utiliza ejercicios potentes como Zancadas Búlgaras, Peso Muerto Rumano unilateral, Hip Thrust pesado con banda de resistencia y Sentadillas Goblet profundas.\n"
            "   - Incluye a veces un ejercicio de core estático por tiempo (p.ej. Plancha Isométrica de 45-60 segundos), usando la palabra 'seg' o 'segundos' en la propiedad repeticiones (ej. '45 seg').\n"
            "   - Rellena obligatoriamente una 'descripcion' corta y clara sobre la ejecución para cada ejercicio.\n"
            "2. Si el tipo es 'Carrera':\n"
            "   - Analiza en el historial de los últimos 7 días si YA figura una carrera de alta intensidad (Intervalos de velocidad o Fartlek). Si ya figura una carrera intensa en los últimos 7 días, DEBES generar un 'Rodamiento Suave' (trote continuo a ritmo cómodo en Zona 2 de 30-40 minutos de duración).\n"
            "   - Si NO figura ninguna carrera de intensidad en los últimos 7 días, diseña un entrenamiento exigente de intervalos (ej: Calentamiento 5m + 6-8 series de 90s rápido/45s andar + Enfriamiento 5m) o un Fartlek dinámico.\n\n"
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
        
        Genera la sesión adaptada y detallada de {payload.tipo}.
        """
        
        response = client.models.generate_content(
            model="gemini-flash-latest",
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

# Create static folder if it doesn't exist
os.makedirs("static", exist_ok=True)

# Mount static files to serve the PWA frontend
app.mount("/", StaticFiles(directory="static", html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    # Run the server on port 8000
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
