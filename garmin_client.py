import os
import json
from datetime import datetime, date, timedelta
from pathlib import Path
from typing import Optional, Dict, List, Any

from garminconnect import (
    Garmin,
    GarminConnectAuthenticationError,
    GarminConnectConnectionError,
    GarminConnectTooManyRequestsError,
)

TOKEN_DIR = Path(__file__).parent / ".garmin_tokens"

# Temporary in-memory store for pending MFA login flows
_pending_mfa: Dict[str, Any] = {}


def _map_garmin_type(type_key: str) -> str:
    tk = (type_key or "").lower()
    if any(k in tk for k in ["run", "running", "trail", "track", "treadmill"]):
        return "Carrera"
    if any(k in tk for k in ["strength", "weight", "hiit", "crossfit", "functional", "fitness_equipment"]):
        return "Fuerza"
    if any(k in tk for k in ["yoga", "pilates", "stretch", "mobility"]):
        return "Yoga"
    if any(k in tk for k in ["cycl", "bike", "biking", "peloton", "virtual_ride"]):
        return "Ciclismo"
    if any(k in tk for k in ["walk", "hiking"]):
        return "Caminata"
    if any(k in tk for k in ["swim"]):
        return "Natación"
    return type_key.replace("_", " ").title() if type_key else "Entrenamiento"


def get_garmin_client() -> Optional[Garmin]:
    """Returns an authenticated Garmin client using saved tokens or .env credentials."""
    TOKEN_DIR.mkdir(parents=True, exist_ok=True)
    token_files = list(TOKEN_DIR.glob("*.json"))

    # 1. Try existing tokens first (no password or MFA needed)
    if token_files:
        try:
            client = Garmin()
            client.login(str(TOKEN_DIR))
            return client
        except Exception as e:
            print(f"[Garmin] Saved token login failed, trying credentials: {e}")

    # 2. Fallback to GARMIN_EMAIL & GARMIN_PASSWORD from .env
    email = os.getenv("GARMIN_EMAIL", "").strip()
    password = os.getenv("GARMIN_PASSWORD", "").strip()
    if not email or not password:
        return None

    try:
        client = Garmin(email=email, password=password, return_on_mfa=True)
        res_type, client_state = client.login()
        if res_type == "needs_mfa":
            _pending_mfa["client"] = client
            _pending_mfa["state"] = client_state
            print("[Garmin] MFA required. Submit code via /api/garmin/mfa.")
            return None
        client.garth.dump(str(TOKEN_DIR))
        return client
    except Exception as e:
        print(f"[Garmin] Credential login error: {e}")
        return None


def start_garmin_login(email: str, password: str) -> Dict[str, Any]:
    """Starts a Garmin Connect login flow. Supports 2FA/MFA."""
    TOKEN_DIR.mkdir(parents=True, exist_ok=True)
    try:
        client = Garmin(email=email, password=password, return_on_mfa=True)
        res_type, client_state = client.login()
        if res_type == "needs_mfa":
            _pending_mfa["client"] = client
            _pending_mfa["state"] = client_state
            return {"status": "needs_mfa", "message": "Introduce el código 2FA enviado por Garmin."}
        client.garth.dump(str(TOKEN_DIR))
        return {"status": "connected", "message": "Garmin Connect vinculado correctamente."}
    except Exception as e:
        return {"status": "error", "message": f"Error de login Garmin: {str(e)}"}


def complete_garmin_mfa(mfa_code: str) -> Dict[str, Any]:
    """Completes a pending Garmin MFA login and persists OAuth tokens."""
    client = _pending_mfa.get("client")
    state = _pending_mfa.get("state")
    if not client or not state:
        return {"status": "error", "message": "No hay sesión MFA pendiente."}
    try:
        client.resume_login(state, mfa_code.strip())
        TOKEN_DIR.mkdir(parents=True, exist_ok=True)
        client.garth.dump(str(TOKEN_DIR))
        _pending_mfa.clear()
        return {"status": "connected", "message": "Garmin Connect autenticado y tokens guardados."}
    except Exception as e:
        return {"status": "error", "message": f"Código MFA inválido o expirado: {str(e)}"}


def is_garmin_connected() -> bool:
    return any(TOKEN_DIR.glob("*.json"))


def get_garmin_history(limit: int = 30) -> List[dict]:
    """Fetches and normalizes recent activities from Garmin Connect."""
    client = get_garmin_client()
    if not client:
        return []

    try:
        raw_activities = client.get_activities(0, limit)
    except Exception as e:
        print(f"[Garmin] Error fetching activities: {e}")
        return []

    normalized = []
    for act in raw_activities:
        act_type_info = act.get("activityType", {}) or {}
        type_key = act_type_info.get("typeKey", "")
        mapped_type = _map_garmin_type(type_key)

        start_local = act.get("startTimeLocal") or act.get("startTimeGMT") or ""
        fecha = start_local.split(" ")[0].split("T")[0] if start_local else ""

        duration_sec = act.get("duration") or act.get("movingDuration") or 0
        duracion_min = round(duration_sec / 60)

        dist_m = act.get("distance") or 0
        distancia_km = round(dist_m / 1000, 2) if dist_m > 0 else 0

        avg_hr = act.get("averageHR")
        max_hr = act.get("maxHR")
        calories = act.get("calories")
        avg_speed = act.get("averageSpeed")  # m/s

        ritmo_str = None
        if avg_speed and avg_speed > 0 and mapped_type == "Carrera":
            sec_per_km = 1000.0 / avg_speed
            m_pace = int(sec_per_km // 60)
            s_pace = int(sec_per_km % 60)
            ritmo_str = f"{m_pace}:{s_pace:02d} min/km"

        normalized.append({
            "id": str(act.get("activityId", "")),
            "fecha": fecha,
            "tipo": mapped_type,
            "tipo_garmin": type_key,
            "nombre": act.get("activityName") or mapped_type,
            "duracion_min": duracion_min,
            "distancia_km": distancia_km if distancia_km > 0 else None,
            "frecuencia_cardiaca_media": round(avg_hr) if avg_hr else None,
            "frecuencia_cardiaca_max": round(max_hr) if max_hr else None,
            "calorias": round(calories) if calories else None,
            "ritmo_medio": ritmo_str,
            "efecto_aerobico": act.get("aerobicTrainingEffect"),
            "efecto_anaerobico": act.get("anaerobicTrainingEffect"),
            "cadencia_media": act.get("averageRunningCadenceInStepsPerMinute"),
            "fuente": "Garmin Connect",
        })

    return normalized


def get_garmin_wellness(target_date: Optional[str] = None) -> Dict[str, Any]:
    """Fetches daily physiological metrics (Sleep, HRV, Body Battery, Resting HR, Training Readiness)."""
    client = get_garmin_client()
    if not client:
        return {}

    if not target_date:
        target_date = date.today().isoformat()

    wellness: Dict[str, Any] = {"fecha": target_date, "fuente": "Garmin Connect"}

    try:
        stats = client.get_stats(target_date)
        if isinstance(stats, dict):
            wellness["fc_reposo"] = stats.get("restingHeartRate")
            wellness["pasos"] = stats.get("totalSteps")
            wellness["estres_medio"] = stats.get("averageStressLevel")
            wellness["body_battery_actual"] = stats.get("bodyBatteryMostRecentValue")
            wellness["body_battery_max"] = stats.get("bodyBatteryHighestValue")
            wellness["body_battery_min"] = stats.get("bodyBatteryLowestValue")
    except Exception as e:
        print(f"[Garmin] Stats fetch error: {e}")

    try:
        readiness = client.get_training_readiness(target_date)
        if isinstance(readiness, list) and readiness:
            latest = readiness[-1]
            wellness["garmin_readiness_score"] = latest.get("score")
            wellness["garmin_readiness_level"] = latest.get("level")
        elif isinstance(readiness, dict):
            wellness["garmin_readiness_score"] = readiness.get("score")
            wellness["garmin_readiness_level"] = readiness.get("level")
    except Exception as e:
        print(f"[Garmin] Training readiness fetch error: {e}")

    try:
        hrv = client.get_hrv_data(target_date)
        if isinstance(hrv, dict):
            summary = hrv.get("hrvSummary") or {}
            wellness["hrv_ultima_noche"] = summary.get("lastNightAvg")
            wellness["hrv_media_semanal"] = summary.get("weeklyAvg")
            wellness["hrv_estado"] = summary.get("status")
    except Exception as e:
        print(f"[Garmin] HRV fetch error: {e}")

    try:
        sleep = client.get_sleep_data(target_date)
        if isinstance(sleep, dict):
            daily_sleep = sleep.get("dailySleepDTO") or {}
            sleep_sec = daily_sleep.get("sleepTimeSeconds") or 0
            if sleep_sec > 0:
                wellness["sueno_horas"] = round(sleep_sec / 3600, 1)
            scores = daily_sleep.get("sleepScores") or {}
            overall = scores.get("overall") or {}
            wellness["sueno_puntuacion"] = overall.get("value")
    except Exception as e:
        print(f"[Garmin] Sleep fetch error: {e}")

    return wellness


def get_garmin_athlete_profile() -> Dict[str, Any]:
    """Fetches user profile & body metrics from Garmin Connect."""
    client = get_garmin_client()
    if not client:
        return {}

    profile: Dict[str, Any] = {}
    try:
        full_name = client.get_full_name()
        if full_name:
            profile["nombre"] = full_name
    except Exception:
        pass

    try:
        user_profile = client.get_user_profile()
        if isinstance(user_profile, dict):
            user_data = user_profile.get("userData") or {}
            if user_data.get("weight"):
                profile["peso_kg"] = round(user_data["weight"] / 1000, 1)
            if user_data.get("height"):
                profile["altura_cm"] = round(user_data["height"])
            if user_data.get("vo2MaxRunning"):
                profile["vo2max_carrera"] = user_data["vo2MaxRunning"]
            if user_data.get("birthDate"):
                profile["fecha_nacimiento"] = user_data["birthDate"]
    except Exception as e:
        print(f"[Garmin] User profile fetch error: {e}")

    return profile
