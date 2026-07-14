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
        target_hr = "65-75% HR"
        
        if p.type == "WARMUP":
            icu_type = "Warmup"
            target_hr = "55-65% HR"
            warmup_steps.append(p)
        elif p.type == "COOLDOWN":
            icu_type = "Cooldown"
            target_hr = "50-60% HR"
            cooldown_steps.append(p)
        else:
            target_hr = "80-85% HR"
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
            desc_lines.append(f"- {p.name} {dur_str} 80-85% HR")
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

async def generar_rutina_mock(mensaje_warning: str = None) -> dict:
    """
    Generates a localized offline mock routine with fatigue adaptation support.
    Conforms to the new unified RutinaResponse schema.
    """
    is_fatigued = False
    last_workout = next((x for x in reversed(db["historial_entrenamientos"]) if x.get("completado")), None)
    if last_workout:
        if last_workout.get("esfuerzo_subjetivo") == "agotador" or (last_workout.get("frecuencia_cardiaca_media") or 0) > 165:
            is_fatigued = True

    tipo_sesion = db["siguiente_bloque"]
    explicacion = "Hemos alternado al bloque correspondiente según el plan de tonificación y balance semanal."
    
    if tipo_sesion == "Fuerza":
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
            {"name": "Intervalos: 5x (90s rápido + 60s caminata)", "duration_seconds": 750, "type": "WORK"},
            {"name": "Enfriamiento: Caminata ligera", "duration_seconds": 300, "type": "COOLDOWN"}
        ]
        
        msg_adapt = None
        if is_fatigued:
            phases[1]["name"] = "Trote continuo y suave regenerativo"
            phases[1]["duration_seconds"] = 600
            msg_adapt = "Hoy rebajamos la intensidad a trote suave continuo sin intervalos por fatiga previa."

        # Sync event in mock mode if keys are present
        enviado = False
        if os.getenv("INTERVALS_API_KEY") and os.getenv("INTERVALS_API_KEY") != "YOUR_INTERVALS_API_KEY":
            phases_objs = [FaseCarrera(**p) for p in phases]
            enviado = await enviar_a_intervals(phases_objs)

        return {
            "tipo_sesion": "Carrera",
            "explicacion_tipo": explicacion,
            "phases": phases,
            "mensaje_adaptacion": msg_adapt,
            "enviado_al_reloj": enviado,
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
    # Update in-memory db
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

    # Register real activity in Intervals.icu
    registrado = await registrar_en_intervals(payload)

    return {
        "status": "ok",
        "registrado_en_intervals": registrado,
        "db": db
    }

@app.get("/rutina-hoy")
async def get_rutina_hoy():
    """
    Generates today's personalized workout using Gemini 1.5 Flash (high free limits),
    deciding dynamically between Strength (Fuerza) and Running (Carrera) based on the athlete's real
    Intervals.icu activity history.
    """
    api_key = os.getenv("GEMINI_API_KEY")
    
    if not api_key:
        print("Warning: GEMINI_API_KEY is empty. Serving mock workout data.")
        return await generar_rutina_mock()
        
    try:
        # Fetch real history from Intervals.icu
        real_history = await get_intervals_history()
        
        client = genai.Client(api_key=api_key)
        
        system_instruction = (
            "Eres el entrenador personal experto de una mujer con nivel físico avanzado y con alta tolerancia al esfuerzo (acostumbrada a entrenamientos intensivos, no se fatiga con facilidad). "
            "Ella quiere una rutina retadora, de alta intensidad y con sesiones más largas. Tu tarea principal hoy es DECIDIR si hoy le corresponde una sesión de 'Fuerza' o de 'Carrera' y estructurarla.\n\n"
            "INSTRUCCIONES DE DECISIÓN:\n"
            "Analiza el historial de actividades reales de los últimos 10 días provisto en el prompt (proviene de su reloj/intervals.icu).\n"
            "1. Distribución Semanal: La meta ideal es realizar entre 2 y 3 sesiones de Fuerza de alta intensidad (enfocadas en tren inferior/glúteos y glúteo medio) y de 1 a 2 sesiones de Carrera por semana, con al menos 1-2 días completos de descanso.\n"
            "2. Evita sesgar: Si el historial muestra que hizo Fuerza ayer, hoy dale Carrera (o viceversa si corresponde) para equilibrar la semana.\n"
            "3. En el campo 'explicacion_tipo' explica breve y amistosamente por qué elegiste esta sesión hoy.\n\n"
            "INSTRUCCIÓN DE INTENSIDAD Y DURACIÓN:\n"
            "- Las sesiones de Fuerza deben ser exigentes y durar entre 45 y 60 minutos. Estructura entre 5 y 6 ejercicios exigentes de tren inferior/glúteo (con 4-5 series de 10-15 repeticiones pesadas). Utiliza ejercicios demandantes como Zancadas Búlgaras con peso, Peso Muerto Rumano unilateral, Hip Thrust pesado con banda de resistencia y Sentadillas Goblet profundas. Incluye a veces ejercicios de core con contracción por tiempo (ej: Plancha Isométrica de 45-60 segundos, especificando '45 seg' o '60 seg' en las repeticiones).\n"
            "- Los descansos entre series en Fuerza son de MÁXIMO 45 segundos.\n"
            "- Las sesiones de Carrera deben ser dosificadas inteligentemente para prevenir lesiones:\n"
            "  * Las sesiones de alta intensidad (Intervalos de velocidad o Fartleks) se limitarán a un **MÁXIMO de UNA VEZ por semana (cada 7 días)**. Debes examinar el historial del prompt. Si en los últimos 7 días ya figura una sesión de intervalos o fartlek, el entrenamiento de carrera de hoy **DEBE SER obligatoriamente un 'Rodamiento Suave'** (trote continuo a ritmo cómodo y sostenido en zona aeróbica pura, p.ej. 30-40 minutos al 60-70% de FC, Zona 2).\n"
            "  * Si no hay ninguna sesión de intensidad de running en los últimos 7 días, puedes estructurar un entrenamiento exigente de intervalos (ej: 6-8 series de 90s rápido + 45s de recuperación activa trotando) o un Fartlek dinámico.\n\n"
            "INSTRUCCIÓN DE ADAPTACIÓN INTELIGENTE:\n"
            "Solo si el historial muestra datos de fatiga extrema o pulsaciones medias anormalmente elevadas, baja un poco la intensidad. Si viene de varios días sin entrenar, no la culpes y dale una sesión intensa para reactivarla con fuerza.\n\n"
            "INSTRUCCIÓN DE DESCRIPCIONES DE EJERCICIO:\n"
            "Para cada ejercicio de Fuerza, debes obligatoriamente rellenar el campo 'descripcion' con 1-2 frases claras y simples explicando la postura de inicio, el movimiento y qué músculo siente trabajar. Sé empático, descriptivo y evita tecnicismos complicados.\n\n"
            "Toda la respuesta debe ser estrictamente en JSON y seguir el esquema de RutinaResponse."
        )
        
        historial_str = ""
        if real_history:
            historial_str = "Historial de entrenamientos reales (últimos 10 días de Intervals.icu):\n"
            for log in real_history:
                dist_str = f", Distancia: {log['distancia_km']} km" if log['distancia_km'] else ""
                fc_str = f", FC Media: {log['frecuencia_cardiaca_media']} ppm" if log['frecuencia_cardiaca_media'] else ""
                desc_str = f", Notas: {log['descripcion']}" if log['descripcion'] else ""
                historial_str += (
                    f"- Fecha {log['fecha']}: {log['tipo']} ({log['nombre']}). "
                    f"Duración: {log['duracion_minutos']} min{dist_str}{fc_str}{desc_str}\n"
                )
        else:
            # Fallback to local DB history if Intervals.icu query returned empty
            if db["historial_entrenamientos"]:
                historial_str = "Historial de entrenamientos locales:\n"
                for log in db["historial_entrenamientos"][-5:]:
                    if log.get("completado"):
                        historial_str += (
                            f"- {log['tipo']} (Completado): Duración: {log.get('duracion_minutos')} min, "
                            f"Esfuerzo: {log.get('esfuerzo_subjetivo')}\n"
                        )
            else:
                historial_str = "No hay historial de entrenamientos registrado todavía."

        prompt = f"""
        Días sin entrenar acumulados: {db['dias_sin_entrenar']}.
        Último entrenamiento en base local: {db['ultimo_entreno']}.
        
        {historial_str}
        
        Decide dinámicamente si hoy corresponde 'Fuerza' o 'Carrera' y diseña la sesión personalizada.
        """
        
        # Switch model to gemini-flash-latest (1.5 Flash) for high free tier limits (1500 RPD)
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
        
        # If Carrera is chosen, sync structured event (Watchletic syntax)
        if workout.get("tipo_sesion") == "Carrera":
            phases = [FaseCarrera(**p) for p in workout.get("phases", [])]
            enviado = await enviar_a_intervals(phases)
            workout["enviado_al_reloj"] = enviado

        # Update local db tracking just in case
        db["siguiente_bloque"] = "Carrera" if workout.get("tipo_sesion") == "Fuerza" else "Fuerza"

        return workout

    except Exception as e:
        err_msg = str(e)
        print(f"Gemini API Error: {err_msg}. Falling back to mock workout.")
        short_err = "cuota agotada" if "RESOURCE_EXHAUSTED" in err_msg else "error de conexión"
        return await generar_rutina_mock(
            mensaje_warning=f"Nota: Tu clave de Gemini está temporalmente inactiva o sin cuota ({short_err}). Usando rutina local de recuperación."
        )

# Create static folder if it doesn't exist
os.makedirs("static", exist_ok=True)

# Mount static files to serve the PWA frontend
app.mount("/", StaticFiles(directory="static", html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    # Run the server on port 8000
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
