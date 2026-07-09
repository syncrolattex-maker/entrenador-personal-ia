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

class FuerzaResponse(BaseModel):
    tipo_sesion: Literal["Fuerza"]
    ejercicios: List[Ejercicio]
    mensaje_adaptacion: Optional[str] = None

class FaseCarrera(BaseModel):
    name: str
    duration_seconds: int
    type: Literal["WARMUP", "WORK", "COOLDOWN"]

class CarreraResponse(BaseModel):
    tipo_sesion: Literal["Carrera"]
    phases: List[FaseCarrera]
    mensaje_adaptacion: Optional[str] = None

# --- Helpers ---

async def enviar_a_intervals(phases: List[FaseCarrera]):
    """
    Sends structured workout phases to Intervals.icu API to sync with Apple Watch.
    """
    api_key = os.getenv("INTERVALS_API_KEY")
    athlete_id = os.getenv("INTERVALS_ATHLETE_ID", "").strip()
    
    # Strip leading "i" if present (e.g. i636518 -> 636518)
    if athlete_id.lower().startswith("i"):
        athlete_id = athlete_id[1:]
    
    if (not api_key or api_key == "YOUR_INTERVALS_API_KEY" or 
        not athlete_id or athlete_id == "YOUR_INTERVALS_ATHLETE_ID" or not athlete_id):
        print("Warning: INTERVALS_API_KEY or INTERVALS_ATHLETE_ID is not configured. Skipping Intervals.icu sync.")
        return False

    # Get local current date in YYYY-MM-DDT08:00:00 format
    from datetime import datetime
    today_date = datetime.now().strftime("%Y-%m-%dT08:00:00")
    
    headers = {
        "Content-Type": "application/json"
    }
    
    # Map pydantic phases to Intervals.icu steps format
    steps = []
    for p in phases:
        icu_type = "Active"
        if p.type == "WARMUP":
            icu_type = "Warmup"
        elif p.type == "COOLDOWN":
            icu_type = "Cooldown"
        elif p.type == "REST" or p.type == "RECOVERY":
            icu_type = "Recovery"
            
        steps.append({
            "type": icu_type,
            "duration_value": p.duration_seconds,
            "duration_type": "DURATION_SECS",
            "name": p.name
        })
        
    payload = {
        "category": "WORKOUT",
        "type": "Run",
        "name": "Carrera de Hoy (IA Flow)",
        "start_date_local": today_date,
        "description": "Entrenamiento de carrera generado dinámicamente por tu entrenador IA.",
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

async def generar_rutina_mock(mensaje_warning: str = None):
    """
    Generates a localized offline mock routine with fatigue adaptation support.
    Useful as a fallback when Gemini keys are missing or rate-limited.
    """
    # Simple simulated adaptation for mock mode:
    # If the last workout was marked as "agotador" or average heart rate was high (>165)
    is_fatigued = False
    last_workout = next((x for x in reversed(db["historial_entrenamientos"]) if x.get("completado")), None)
    if last_workout:
        if last_workout.get("esfuerzo_subjetivo") == "agotador" or (last_workout.get("frecuencia_cardiaca_media") or 0) > 165:
            is_fatigued = True

    if db["siguiente_bloque"] == "Fuerza":
        ejercicios = [
            {"nombre": "Sentadillas Goblet", "series": 4, "repediticiones": "12"},
            {"nombre": "Hip Thrust con banda", "series": 4, "repediticiones": "15"},
            {"nombre": "Zancadas Búlgaras (Piel de Melocotón)", "series": 3, "repediticiones": "10 por pierna"},
            {"nombre": "Patada de Glúteo en cuadrupedia", "series": 3, "repediticiones": "15 por pierna"},
            {"nombre": "Core: Plancha con rotación", "series": 3, "repediticiones": "45 seg"}
        ]
        ejercicios_parsed = []
        for ex in ejercicios:
            ejercicios_parsed.append({
                "nombre": ex["nombre"],
                "series": ex["series"],
                "repeticiones": ex["repediticiones"]
            })
        
        msg_adapt = None
        if is_fatigued:
            for ex in ejercicios_parsed:
                ex["series"] = max(2, ex["series"] - 1)
            msg_adapt = "He notado fatiga en tu sesión anterior (esfuerzo agotador o pulso alto). Hoy bajamos el volumen de series para recuperarte sin perder tono."

        return {
            "tipo_sesion": "Fuerza",
            "ejercicios": ejercicios_parsed,
            "mensaje_adaptacion": msg_adapt,
            "mensaje": mensaje_warning or "Usando rutina local de prueba (Introduce tu GEMINI_API_KEY en el archivo .env para conectar con la IA)."
        }
    else:
        phases = [
            {"name": "Calentamiento: Trote suave articulaciones", "duration_seconds": 300, "type": "WARMUP"},
            {"name": "Bloque de Trabajo: 5x (90s rápido + 60s caminata)", "duration_seconds": 750, "type": "WORK"},
            {"name": "Enfriamiento: Caminata ligera y estiramientos", "duration_seconds": 300, "type": "COOLDOWN"}
        ]
        msg_adapt = None
        if is_fatigued:
            phases[1]["name"] = "Bloque Suave: 4x (60s trote + 60s caminata)"
            phases[1]["duration_seconds"] = 480
            msg_adapt = "Sesión regenerativa hoy. He reducido la duración y la cantidad de intervalos debido al cansancio acumulado."

        # Attempt to sync with Intervals.icu in mock mode if keys are present
        enviado = False
        if os.getenv("INTERVALS_API_KEY") and os.getenv("INTERVALS_API_KEY") != "YOUR_INTERVALS_API_KEY":
            phases_objs = [FaseCarrera(**p) for p in phases]
            enviado = await enviar_a_intervals(phases_objs)

        return {
            "tipo_sesion": "Carrera",
            "phases": phases,
            "mensaje_adaptacion": msg_adapt,
            "enviado_al_reloj": enviado,
            "mensaje": mensaje_warning or "Usando rutina local de prueba (Introduce tu GEMINI_API_KEY en el archivo .env para conectar con la IA)."
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

    url = f"https://intervals.icu/api/v1/athlete/{athlete_id}/activities"
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
    Generates today's personalized workout using Gemini 2.5 Flash,
    adapting intensity based on performance history.
    """
    api_key = os.getenv("GEMINI_API_KEY")
    
    if not api_key:
        print("Warning: GEMINI_API_KEY is empty. Serving mock workout data.")
        return await generar_rutina_mock()
        
    try:
        client = genai.Client(api_key=api_key)
        
        system_instruction = (
            "Eres el entrenador personal de una mujer de nivel intermedio cuyo objetivo es reducir celulitis y mejorar su tono muscular. "
            "NUNCA utilices un tono punitivo o de culpa si lleva días sin entrenar; en su lugar, adapta suavemente la intensidad para que la rutina sea retadora pero 100% realizable.\n\n"
            "INSTRUCCIÓN DE ADAPTACIÓN INTELIGENTE:\n"
            "Analiza el historial de entrenamientos recientes proporcionado en el prompt. "
            "Si observas indicios de cansancio (ej. esfuerzo subjetivo 'agotador' en su última sesión, o frecuencia cardíaca media > 160 lpm), reconfigura la rutina reduciendo la carga (menos series, menos repeticiones, ritmos de carrera más suaves, descansos más largos).\n"
            "Si por el contrario ves que reportó esfuerzo 'facil' de forma continua, sube ligeramente la intensidad.\n"
            "En caso de realizar una adaptación (por fatiga o progresión), DEBES escribir un mensaje breve, empático y explicativo en el campo 'mensaje_adaptacion' (ej: 'Hoy bajamos series porque tu última sesión fue muy intensa, cuidemos tus glúteos sin sobreentrenar').\n"
            "Toda la respuesta debe ser estrictamente en JSON."
        )
        
        historial_str = ""
        if db["historial_entrenamientos"]:
            historial_str = "Historial de entrenamientos recientes:\n"
            for log in db["historial_entrenamientos"][-5:]:
                if log.get("completado"):
                    historial_str += (
                        f"- {log['tipo']} (Completado): Duración: {log.get('duracion_minutos')} min, "
                        f"Pulsaciones medias: {log.get('frecuencia_cardiaca_media')} lpm, "
                        f"Calorías: {log.get('calorias_activas')} kcal, "
                        f"Esfuerzo: {log.get('esfuerzo_subjetivo')}\n"
                    )
                else:
                    historial_str += f"- Descanso (No entrenó). Días sin entrenar acumulados: {log.get('dias_sin_entrenar_acumulados')}\n"
        else:
            historial_str = "No hay historial de entrenamientos registrado aún."

        prompt = f"""
        Lleva {db['dias_sin_entrenar']} días sin entrenar.
        Último entrenamiento completado: {db['ultimo_entreno']}.
        Hoy toca: {db['siguiente_bloque']}.
        
        {historial_str}
        
        Genera la sesión personalizada de hoy, adaptando la intensidad de manera inteligente en función de la fatiga o progresión reflejada en el historial.
        """
        
        schema = FuerzaResponse if db["siguiente_bloque"] == "Fuerza" else CarreraResponse
        
        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=prompt,
            config=types.GenerateContentConfig(
                system_instruction=system_instruction,
                response_mime_type="application/json",
                response_schema=schema,
                temperature=0.7,
            )
        )
        
        workout = json.loads(response.text)
        
        if workout.get("tipo_sesion") == "Carrera":
            phases = [FaseCarrera(**p) for p in workout.get("phases", [])]
            enviado = await enviar_a_intervals(phases)
            workout["enviado_al_reloj"] = enviado

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
