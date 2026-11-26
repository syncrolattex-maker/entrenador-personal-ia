import os
import re
import json
import time
import requests
from datetime import datetime, date, timedelta
from pathlib import Path
from typing import Optional, Dict, List, Any

try:
    import garth
    HAS_GARTH = True
except ImportError:
    garth = None  # type: ignore
    HAS_GARTH = False

try:
    from garminconnect import Garmin
    HAS_GARMINCONNECT = True
except ImportError:
    Garmin = None  # type: ignore
    HAS_GARMINCONNECT = False

TOKEN_DIR = (
    Path("/tmp/.garmin_tokens")
    if os.getenv("VERCEL")
    else Path(__file__).parent / ".garmin_tokens"
)
PERSONAL_KEY_FILE = (
    Path("/tmp/.garmin_personal_key")
    if os.getenv("VERCEL")
    else Path(__file__).parent / "data" / ".garmin_personal_key"
)
PERSONAL_API_BASE = "https://personal.connectapi.garmin.com"

# Temporary in-memory store for pending MFA login flows and Personal API token cache
_pending_mfa: Dict[str, Any] = {}
_personal_token_cache: Dict[str, Any] = {"token": None, "expires_at": 0.0}


def get_saved_personal_key() -> str:
    key = os.getenv("GARMIN_PERSONAL_API_KEY", "").strip()
    if key:
        return key
    try:
        import database
        db_key = database.get_setting("garmin_personal_key")
        if db_key:
            return db_key.strip()
    except Exception:
        pass
    try:
        if PERSONAL_KEY_FILE.exists():
            return PERSONAL_KEY_FILE.read_text(encoding="utf-8").strip()
    except Exception:
        pass
    return ""


def save_personal_key(api_key: str) -> None:
    clean = (api_key or "").strip()
    os.environ["GARMIN_PERSONAL_API_KEY"] = clean
    _personal_token_cache["token"] = None
    _personal_token_cache["expires_at"] = 0.0
    try:
        import database
        database.set_setting("garmin_personal_key", clean)
        database.set_setting("garmin_jwt_cache", "")
    except Exception as e:
        print(f"[Garmin] Could not persist personal key to DB: {e}")
    try:
        PERSONAL_KEY_FILE.parent.mkdir(parents=True, exist_ok=True)
        PERSONAL_KEY_FILE.write_text(clean, encoding="utf-8")
    except Exception as e:
        print(f"[Garmin] Could not persist personal key to file: {e}")


def _get_personal_api_token() -> Optional[str]:
    """Exchanges GARMIN_PERSONAL_API_KEY (GCDC_...) for a short-lived Bearer JWT token, cached in memory & DB."""
    api_key = get_saved_personal_key()
    if not api_key:
        return None

    now = time.time()
    if _personal_token_cache["token"] and now < _personal_token_cache["expires_at"] - 120:
        return _personal_token_cache["token"]

    # Check persistent DB cache (avoids POST token exchange on every Vercel cold start)
    try:
        import database
        cached_raw = database.get_setting("garmin_jwt_cache")
        if cached_raw:
            cached = json.loads(cached_raw)
            c_token = cached.get("token")
            c_exp = float(cached.get("expires_at") or 0.0)
            if c_token and now < c_exp - 120:
                _personal_token_cache["token"] = c_token
                _personal_token_cache["expires_at"] = c_exp
                return c_token
    except Exception as e:
        print(f"[Garmin Personal API] DB JWT cache read error: {e}")

    try:
        resp = requests.post(
            f"{PERSONAL_API_BASE}/personalapitoken-service/personal-api/personal-api-key/token",
            headers={"Authorization": f"ApiKey {api_key}"},
            timeout=10,
        )
        if resp.status_code == 200:
            token = resp.text.strip().strip('"')
            expires_at = now + 12 * 3600
            _personal_token_cache["token"] = token
            # Tokens are valid up to 24h; refresh proactively every 12h
            _personal_token_cache["expires_at"] = expires_at
            try:
                import database
                database.set_setting("garmin_jwt_cache", json.dumps({"token": token, "expires_at": expires_at}))
            except Exception as db_err:
                print(f"[Garmin Personal API] DB JWT cache write error: {db_err}")
            return token
        print(f"[Garmin Personal API] Token exchange failed: {resp.status_code} {resp.text[:200]}")
    except Exception as e:
        print(f"[Garmin Personal API] Token exchange exception: {e}")
    return None


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


def _save_tokens_to_db() -> None:
    """Persists OAuth token JSON files from TOKEN_DIR into database app_settings (survives serverless restarts)."""
    try:
        import database
        payload = {}
        for f in TOKEN_DIR.glob("*.json"):
            payload[f.name] = f.read_text(encoding="utf-8")
        if payload:
            database.set_setting("garmin_oauth_tokens_json", json.dumps(payload))
    except Exception as e:
        print(f"[Garmin] Save tokens to DB warning: {e}")


def _restore_tokens_from_db() -> bool:
    """Restores OAuth token JSON files into TOKEN_DIR from database app_settings if missing locally."""
    try:
        if any(TOKEN_DIR.glob("*.json")):
            return True
        import database
        raw = database.get_setting("garmin_oauth_tokens_json")
        if not raw:
            return False
        payload = json.loads(raw)
        if not isinstance(payload, dict) or not payload:
            return False
        TOKEN_DIR.mkdir(parents=True, exist_ok=True)
        for fname, content in payload.items():
            if isinstance(fname, str) and fname.endswith(".json") and isinstance(content, str):
                (TOKEN_DIR / Path(fname).name).write_text(content, encoding="utf-8")
        return any(TOKEN_DIR.glob("*.json"))
    except Exception as e:
        print(f"[Garmin] Restore tokens from DB warning: {e}")
        return False


def has_garmin_write_session() -> bool:
    """True when OAuth tokens (or email/password env) exist for uploading & scheduling workouts."""
    if _restore_tokens_from_db():
        return True
    return bool(os.getenv("GARMIN_EMAIL", "").strip() and os.getenv("GARMIN_PASSWORD", "").strip())


def _save_garth_dumps_to_db(dumps_str: str) -> None:
    try:
        import database
        if dumps_str:
            database.set_setting("garmin_oauth_tokens_json", dumps_str)
    except Exception as e:
        print(f"[Garmin] Save garth dumps to DB warning: {e}")


def _get_garth_client() -> Optional[Any]:
    """Returns an authenticated garth.Client using DB/disk OAuth tokens or env credentials (pure Python, Vercel-safe)."""
    if not HAS_GARTH:
        return None
    TOKEN_DIR.mkdir(parents=True, exist_ok=True)
    # 1. Try restoring garth dumps or JSON files from DB
    try:
        import database
        raw = database.get_setting("garmin_oauth_tokens_json")
        if raw:
            client = garth.Client()
            try:
                # Try garth.dumps() format first
                client.loads(raw)
                return client
            except Exception:
                # Fallback: dict of {filename: content}
                payload = json.loads(raw)
                if isinstance(payload, dict) and payload:
                    for fname, content in payload.items():
                        if isinstance(fname, str) and fname.endswith(".json") and isinstance(content, str):
                            (TOKEN_DIR / Path(fname).name).write_text(content, encoding="utf-8")
    except Exception as e:
        print(f"[Garmin] Garth DB restore warning: {e}")

    if any(TOKEN_DIR.glob("*.json")):
        try:
            client = garth.Client()
            client.load(str(TOKEN_DIR))
            return client
        except Exception as e:
            print(f"[Garmin] Garth disk token load failed: {e}")

    # 2. Fallback to GARMIN_EMAIL & GARMIN_PASSWORD env vars
    email = os.getenv("GARMIN_EMAIL", "").strip()
    password = os.getenv("GARMIN_PASSWORD", "").strip()
    if email and password:
        try:
            client = garth.Client()
            res_type, client_state = client.login(email, password, return_on_mfa=True)
            if res_type == "needs_mfa":
                _pending_mfa["client"] = client
                _pending_mfa["state"] = client_state
                _pending_mfa["mode"] = "garth"
                return None
            client.dump(str(TOKEN_DIR))
            _save_garth_dumps_to_db(client.dumps())
            return client
        except Exception as e:
            print(f"[Garmin] Garth env credential login failed: {e}")
    return None


def get_garmin_client() -> Optional[Any]:
    """Returns an authenticated Garmin client using saved tokens or .env credentials."""
    if not HAS_GARMINCONNECT:
        return None
    TOKEN_DIR.mkdir(parents=True, exist_ok=True)
    _restore_tokens_from_db()
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
        _save_tokens_to_db()
        return client
    except Exception as e:
        print(f"[Garmin] Credential login error: {e}")
        return None


def start_garmin_login(email: str, password: str) -> Dict[str, Any]:
    """Starts a Garmin Connect login flow using garth (pure Python) or garminconnect. Supports 2FA/MFA."""
    if HAS_GARTH:
        TOKEN_DIR.mkdir(parents=True, exist_ok=True)
        try:
            client = garth.Client()
            res_type, client_state = client.login(email, password, return_on_mfa=True)
            if res_type == "needs_mfa":
                _pending_mfa["client"] = client
                _pending_mfa["state"] = client_state
                _pending_mfa["mode"] = "garth"
                return {"status": "needs_mfa", "message": "Introduce el código 2FA enviado por Garmin."}
            client.dump(str(TOKEN_DIR))
            _save_garth_dumps_to_db(client.dumps())
            return {"status": "connected", "message": "Garmin Connect vinculado correctamente."}
        except Exception as e:
            err_msg = str(e)
            if "401" in err_msg:
                return {
                    "status": "error",
                    "message": "Garmin SSO devolvió 401 Unauthorized (verifica tu email/contraseña o bloqueó la IP de Vercel). Usa 'Importar Token OAuth' debajo.",
                }
            return {"status": "error", "message": f"Error de login Garmin: {err_msg}"}

    if not HAS_GARMINCONNECT:
        return {"status": "error", "message": "Instala garth o usa GARMIN_PERSONAL_API_KEY (GCDC_...)."}
    TOKEN_DIR.mkdir(parents=True, exist_ok=True)
    try:
        client = Garmin(email=email, password=password, return_on_mfa=True)
        res_type, client_state = client.login()
        if res_type == "needs_mfa":
            _pending_mfa["client"] = client
            _pending_mfa["state"] = client_state
            _pending_mfa["mode"] = "garminconnect"
            return {"status": "needs_mfa", "message": "Introduce el código 2FA enviado por Garmin."}
        client.garth.dump(str(TOKEN_DIR))
        _save_tokens_to_db()
        return {"status": "connected", "message": "Garmin Connect vinculado correctamente."}
    except Exception as e:
        return {"status": "error", "message": f"Error de login Garmin: {str(e)}"}


def complete_garmin_mfa(mfa_code: str) -> Dict[str, Any]:
    """Completes a pending Garmin MFA login and persists OAuth tokens."""
    client = _pending_mfa.get("client")
    state = _pending_mfa.get("state")
    mode = _pending_mfa.get("mode", "garminconnect")
    if not client or not state:
        return {"status": "error", "message": "No hay sesión MFA pendiente."}
    try:
        client.resume_login(state, mfa_code.strip())
        TOKEN_DIR.mkdir(parents=True, exist_ok=True)
        if mode == "garth":
            client.dump(str(TOKEN_DIR))
            _save_garth_dumps_to_db(client.dumps())
        else:
            client.garth.dump(str(TOKEN_DIR))
            _save_tokens_to_db()
        _pending_mfa.clear()
        return {"status": "connected", "message": "Garmin Connect autenticado y tokens guardados."}
    except Exception as e:
        return {"status": "error", "message": f"Código MFA inválido o expirado: {str(e)}"}


def import_garth_tokens(token_str: str) -> Dict[str, Any]:
    """Validates and persists a garth.dumps() token string (generated locally) into DB."""
    if not HAS_GARTH:
        return {"status": "error", "message": "garth no está instalado en el servidor."}
    clean = (token_str or "").strip()
    if not clean:
        return {"status": "error", "message": "Pega el token OAuth exportado."}
    try:
        client = garth.Client()
        client.loads(clean)
        TOKEN_DIR.mkdir(parents=True, exist_ok=True)
        client.dump(str(TOKEN_DIR))
        _save_garth_dumps_to_db(client.dumps())
        return {"status": "connected", "message": "Tokens OAuth de Garmin importados y guardados."}
    except Exception as e:
        return {"status": "error", "message": f"Token OAuth inválido: {str(e)}"}


def is_garmin_connected() -> bool:
    return bool(get_saved_personal_key()) or has_garmin_write_session()


def get_garmin_history(limit: int = 30, start: int = 0) -> List[dict]:
    """Fetches and normalizes activities from Garmin Connect (Personal API or garminconnect) with pagination support."""
    raw_activities = []

    # 1. Try Official Garmin Personal API (GCDC_ key)
    bearer = _get_personal_api_token()
    if bearer:
        try:
            r = requests.get(
                f"{PERSONAL_API_BASE}/activitylist-service/activities/search/activities",
                params={"limit": limit, "start": start},
                headers={"Authorization": f"Bearer {bearer}"},
                timeout=12,
            )
            if r.status_code == 200:
                raw_activities = r.json()
            else:
                print(f"[Garmin Personal API] Activities fetch returned {r.status_code}")
        except Exception as e:
            print(f"[Garmin Personal API] Error fetching activities: {e}")

    # 2. Fallback to garminconnect OAuth session if needed
    if not raw_activities:
        client = get_garmin_client()
        if not client:
            return []
        try:
            raw_activities = client.get_activities(start, limit)
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

        cad_val = act.get("averageRunningCadenceInStepsPerMinute") or act.get("averageBikingCadenceInRevPerMinute")
        if cad_val and act.get("averageRunningCadenceInStepsPerMinute") and cad_val < 115:
            cad_val = cad_val * 2
        temp_val = act.get("averageTemperature")
        if temp_val is None and act.get("minTemperature") is not None and act.get("maxTemperature") is not None:
            temp_val = round((act.get("minTemperature") + act.get("maxTemperature")) / 2.0, 1)
        elif temp_val is None:
            temp_val = act.get("minTemperature") if act.get("minTemperature") is not None else act.get("maxTemperature")

        normalized.append({
            "id": str(act.get("activityId", "")),
            "fecha": fecha,
            "start_local": start_local,
            "timezone": act.get("timeZoneId") or "Europe/Madrid",
            "tipo": mapped_type,
            "tipo_garmin": type_key,
            "nombre": act.get("activityName") or mapped_type,
            "duracion_min": duracion_min,
            "distancia_km": distancia_km if distancia_km > 0 else None,
            "desnivel_m": round(act.get("elevationGain") or 0),
            "desnivel_negativo_m": round(act.get("elevationLoss") or 0),
            "frecuencia_cardiaca_media": round(avg_hr) if avg_hr else None,
            "frecuencia_cardiaca_max": round(max_hr) if max_hr else None,
            "calorias": round(calories) if calories else None,
            "ritmo_medio": ritmo_str,
            "efecto_aerobico": act.get("aerobicTrainingEffect"),
            "efecto_anaerobico": act.get("anaerobicTrainingEffect"),
            "cadencia_media": round(cad_val) if cad_val else None,
            "avg_cadence": round(cad_val) if cad_val else None,
            "moving_duration_min": round((act.get("movingDuration") or duration_sec or 0) / 60.0, 2),
            "elapsed_duration_min": round((act.get("elapsedDuration") or duration_sec or 0) / 60.0, 2),
            "avg_temp_c": temp_val,
            "device_name": act.get("deviceName") or "Garmin Connect",
            "avg_power_w": act.get("avgPower") or act.get("averagePower"),
            "raw_payload": act,
            "fuente": "Garmin Connect",
        })

    return normalized


def sync_garmin_incremental(known_ids: set, batch_size: int = 30, max_batches: int = 4, backfill: bool = False) -> List[dict]:
    """
    Incremental batched sync from Garmin Connect.
    Stops early once a batch contains only known activities (unless backfill=True).
    """
    collected: List[dict] = []
    for b in range(max_batches):
        batch = get_garmin_history(limit=batch_size, start=b * batch_size)
        if not batch:
            break
        collected.extend(batch)
        new_in_batch = [a for a in batch if str(a.get("id") or "") not in known_ids]
        if not backfill and len(new_in_batch) == 0:
            break
        if len(batch) < batch_size:
            break
    return collected


def get_garmin_wellness(target_date: Optional[str] = None) -> Dict[str, Any]:
    """Fetches daily physiological metrics (Sleep, HRV, Body Battery, Resting HR, Training Readiness)."""
    if not target_date:
        target_date = date.today().isoformat()

    wellness: Dict[str, Any] = {"fecha": target_date, "fuente": "Garmin Connect"}

    bearer = _get_personal_api_token()
    if bearer:
        headers = {"Authorization": f"Bearer {bearer}"}
        try:
            r = requests.get(
                f"{PERSONAL_API_BASE}/wellness-service/wellness/bodyBattery/reports/daily",
                params={"startDate": target_date, "endDate": target_date},
                headers=headers,
                timeout=10,
            )
            if r.status_code == 200:
                bb_list = r.json()
                if isinstance(bb_list, list) and bb_list:
                    bb = bb_list[0]
                    wellness["body_battery_charged"] = bb.get("charged")
                    wellness["body_battery_drained"] = bb.get("drained")
        except Exception as e:
            print(f"[Garmin Personal API] Body Battery error: {e}")

        try:
            r = requests.get(
                f"{PERSONAL_API_BASE}/hrv-service/hrv/{target_date}",
                headers=headers,
                timeout=10,
            )
            if r.status_code == 200 and r.text:
                hrv = r.json()
                summary = hrv.get("hrvSummary") or {}
                wellness["hrv_ultima_noche"] = summary.get("lastNightAvg")
                wellness["hrv_media_semanal"] = summary.get("weeklyAvg")
                wellness["hrv_estado"] = summary.get("status")
        except Exception as e:
            print(f"[Garmin Personal API] HRV error: {e}")

        return wellness

    client = get_garmin_client()
    if not client:
        return {}

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
    if get_saved_personal_key():
        return {
            "nombre": "Aarón",
            "edad": 43,
            "altura_cm": 183,
            "peso_kg": 93.0,
            "fuente": "Garmin Personal API",
        }

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


def workout_to_fit_steps(workout: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Converts an AaronFit Fuerza or Carrera workout dict into Garmin FIT step dicts."""
    tipo = workout.get("tipo_sesion", "Carrera")
    steps: List[Dict[str, Any]] = []

    if tipo in ("Carrera", "Ciclismo", "Bici", "Carrera Objetivo"):
        for p in workout.get("phases", []):
            dur_s = int(p.get("duration_seconds") or 300)
            steps.append({
                "name": p.get("name", "Fase Carrera")[:30],
                "duration_type": 0,          # time
                "duration_value": dur_s * 1000,
                "target_type": 2,            # open
                "target_low": 0,
                "target_high": 0,
            })
    else:
        for ex in workout.get("ejercicios", []):
            series = int(ex.get("series") or 3)
            reps_raw = str(ex.get("repeticiones") or "15")
            digits = "".join(c for c in reps_raw if c.isdigit())
            reps_num = int(digits) if digits else 15
            is_time = "seg" in reps_raw.lower() or "min" in reps_raw.lower()
            for s_idx in range(series):
                steps.append({
                    "name": f"{ex.get('nombre', 'Ejercicio')[:24]} S{s_idx + 1}",
                    "duration_type": 0 if is_time else 29,  # 0=time, 29=reps
                    "duration_value": (reps_num * 1000) if is_time else reps_num,
                    "target_type": 2,
                    "target_low": 0,
                    "target_high": 0,
                })
                if s_idx < series - 1:
                    steps.append({
                        "name": "Descanso",
                        "duration_type": 0,
                        "duration_value": 45000,
                        "target_type": 2,
                        "target_low": 0,
                        "target_high": 0,
                    })

    if not steps:
        steps.append({"name": "Entrenamiento AaronFit", "duration_type": 5, "duration_value": 0, "target_type": 2})
    return steps


def _parse_garmin_target(phase: Dict[str, Any], is_run: bool, is_bike: bool) -> Dict[str, Any]:
    """Converts phase target_pace (e.g. '4:45 - 5:00' or '180-210 W') into Garmin targetType + targetValueOne/Two."""
    import re
    tp = str(phase.get("target_pace") or "")
    if is_run:
        matches = re.findall(r"(\d+):(\d{2})", tp)
        if len(matches) >= 2:
            sec1 = int(matches[0][0]) * 60 + int(matches[0][1])
            sec2 = int(matches[1][0]) * 60 + int(matches[1][1])
            fast_sec, slow_sec = min(sec1, sec2), max(sec1, sec2)
            if fast_sec > 0 and slow_sec > 0:
                return {
                    "targetType": {"workoutTargetTypeId": 6, "workoutTargetTypeKey": "pace.zone"},
                    "targetValueOne": round(1000.0 / slow_sec, 3),   # m/s slower bound
                    "targetValueTwo": round(1000.0 / fast_sec, 3),   # m/s faster bound
                }
    elif is_bike:
        m_w = re.search(r"(\d+)\s*-\s*(\d+)\s*W", tp, re.IGNORECASE)
        if m_w:
            return {
                "targetType": {"workoutTargetTypeId": 2, "workoutTargetTypeKey": "power.zone"},
                "targetValueOne": float(m_w.group(1)),
                "targetValueTwo": float(m_w.group(2)),
            }
    return {"targetType": {"workoutTargetTypeId": 1, "workoutTargetTypeKey": "no.target"}}


def _infer_phase_type(phase: Dict[str, Any]) -> str:
    raw = (phase.get("type") or "").upper().strip()
    if raw in ("WARMUP", "COOLDOWN", "REST", "RECOVERY", "WORK", "INTERVAL"):
        return "REST" if raw == "RECOVERY" else raw
    name_l = (phase.get("name") or "").lower()
    if any(k in name_l for k in ["calentamiento", "warmup", "warm-up", "inicio controlado"]):
        return "WARMUP"
    if any(k in name_l for k in ["enfriamiento", "cooldown", "cool-down", "vuelta a la calma", "soltar piernas"]):
        return "COOLDOWN"
    if any(k in name_l for k in ["recuperación", "recuperacion", "rest", "trote suave"]):
        return "REST"
    return "WORK"


def _build_garmin_connect_workout_json(workout: Dict[str, Any]) -> Dict[str, Any]:
    """Builds Garmin Connect workout JSON payload with proper Warmup/Repeat/Rest/Cooldown & Pace/Power targets."""
    tipo = workout.get("tipo_sesion", "Carrera")
    is_run = tipo in ("Carrera", "Carrera Objetivo")
    is_bike = tipo in ("Ciclismo", "Bici")
    is_cardio = is_run or is_bike
    sport_key = "running" if is_run else "cycling" if is_bike else "strength_training"
    sport_id = 1 if is_run else 2 if is_bike else 5

    workout_steps = []
    order = 1

    if is_cardio:
        phases = workout.get("phases", [])
        # Build step DTO helper
        def _make_step(p: Dict[str, Any], s_order: int, forced_type: Optional[str] = None) -> Dict[str, Any]:
            pt = forced_type or _infer_phase_type(p)
            step_type_id = 1 if pt == "WARMUP" else 2 if pt == "COOLDOWN" else 4 if pt == "REST" else 3
            step_type_key = "warmup" if pt == "WARMUP" else "cooldown" if pt == "COOLDOWN" else "recovery" if pt == "REST" else "interval"
            tgt = _parse_garmin_target(p, is_run=is_run, is_bike=is_bike)
            step = {
                "type": "ExecutableStepDTO",
                "stepOrder": s_order,
                "stepType": {"stepTypeId": step_type_id, "stepTypeKey": step_type_key},
                "endCondition": {"conditionTypeId": 2, "conditionTypeKey": "time"},
                "endConditionValue": float(p.get("duration_seconds") or 300),
                "targetType": tgt["targetType"],
                "description": p.get("name", "Fase"),
            }
            if "targetValueOne" in tgt:
                step["targetValueOne"] = tgt["targetValueOne"]
                step["targetValueTwo"] = tgt["targetValueTwo"]
            return step

        # Group repeated WORK + REST pairs into a clean Garmin RepeatGroupDTO when applicable
        i = 0
        while i < len(phases):
            pt = _infer_phase_type(phases[i])
            if pt == "WORK" and i + 1 < len(phases) and _infer_phase_type(phases[i + 1]) == "REST":
                # Count consecutive WORK+REST pairs
                pairs = []
                j = i
                while j + 1 < len(phases) and _infer_phase_type(phases[j]) == "WORK" and _infer_phase_type(phases[j + 1]) == "REST":
                    pairs.append((phases[j], phases[j + 1]))
                    j += 2
                if len(pairs) >= 2:
                    work_p, rest_p = pairs[0]
                    work_step = _make_step(work_p, 1, "WORK")
                    work_step["description"] = re.sub(r"\s*\d+/\d+$", "", work_step["description"]).strip()
                    rest_step = _make_step(rest_p, 2, "REST")
                    rest_step["description"] = re.sub(r"\s*\d+/\d+$", "", rest_step["description"]).strip()
                    workout_steps.append({
                        "type": "RepeatGroupDTO",
                        "stepOrder": order,
                        "numberOfIterations": len(pairs),
                        "smartRepeat": False,
                        "stepType": {"stepTypeId": 6, "stepTypeKey": "repeat"},
                        "workoutSteps": [work_step, rest_step],
                    })
                    order += 1
                    i = j
                    continue
            workout_steps.append(_make_step(phases[i], order))
            order += 1
            i += 1
    else:
        for ex in workout.get("ejercicios", []):
            series = int(ex.get("series") or 3)
            reps_raw = str(ex.get("repeticiones") or "15")
            digits = "".join(c for c in reps_raw if c.isdigit())
            reps_num = int(digits) if digits else 15
            is_time = "seg" in reps_raw.lower()
            workout_steps.append({
                "type": "RepeatGroupDTO",
                "stepOrder": order,
                "numberOfIterations": series,
                "smartRepeat": False,
                "stepType": {"stepTypeId": 6, "stepTypeKey": "repeat"},
                "workoutSteps": [
                    {
                        "type": "ExecutableStepDTO",
                        "stepOrder": 1,
                        "stepType": {"stepTypeId": 3, "stepTypeKey": "interval"},
                        "endCondition": {
                            "conditionTypeId": 2 if is_time else 10,
                            "conditionTypeKey": "time" if is_time else "reps",
                        },
                        "endConditionValue": float(reps_num),
                        "targetType": {"workoutTargetTypeId": 1, "workoutTargetTypeKey": "no.target"},
                        "description": ex.get("nombre", "Ejercicio"),
                    },
                    {
                        "type": "ExecutableStepDTO",
                        "stepOrder": 2,
                        "stepType": {"stepTypeId": 4, "stepTypeKey": "rest"},
                        "endCondition": {"conditionTypeId": 2, "conditionTypeKey": "time"},
                        "endConditionValue": float(ex.get("descanso_seg") or 45),
                        "targetType": {"workoutTargetTypeId": 1, "workoutTargetTypeKey": "no.target"},
                        "description": "Descanso",
                    },
                ],
            })
            order += 1

    title = (workout.get("titulo") or "").strip()
    target_date = str(workout.get("fecha") or date.today().isoformat())[:10]
    w_name = f"AaronFit — {title}" if title else f"AaronFit — {tipo} ({target_date})"

    return {
        "workoutName": w_name[:120],
        "sportType": {"sportTypeId": sport_id, "sportTypeKey": sport_key},
        "workoutSegments": [
            {
                "segmentOrder": 1,
                "sportType": {"sportTypeId": sport_id, "sportTypeKey": sport_key},
                "workoutSteps": workout_steps,
            }
        ],
    }


def send_workout_to_garmin_watch(workout: Dict[str, Any]) -> Dict[str, Any]:
    """
    Uploads and schedules the workout to Garmin Connect and pushes it to the watch
    when an OAuth session is active (via garth or garminconnect). Otherwise returns needs_garmin_login.
    """
    payload = _build_garmin_connect_workout_json(workout)
    target_date = str(workout.get("fecha") or date.today().isoformat())[:10]

    # 1. Pure Python garth OAuth client (works on Vercel serverless)
    g_client = _get_garth_client()
    if g_client:
        try:
            uploaded = g_client.connectapi("/workout-service/workout", method="POST", json=payload)
            workout_id = uploaded.get("workoutId") if isinstance(uploaded, dict) else None
            if workout_id:
                try:
                    g_client.connectapi(
                        f"/workout-service/schedule/{workout_id}",
                        method="POST",
                        json={"date": target_date},
                    )
                except Exception as sched_err:
                    print(f"[Garmin Garth] Schedule workout warning: {sched_err}")
                return {
                    "status": "sent",
                    "method": "garmin_direct",
                    "workout_id": workout_id,
                    "scheduled_date": target_date,
                    "message": f"¡Entrenamiento enviado y programado en tu reloj Garmin ({target_date})!",
                }
            return {
                "status": "error",
                "method": "garmin_direct",
                "message": f"Garmin Connect no devolvió workoutId al subir la sesión ({uploaded}).",
            }
        except Exception as e:
            print(f"[Garmin Garth] Direct workout upload failed: {e}")
            return {
                "status": "error",
                "method": "garmin_direct",
                "message": f"Error al subir/programar en Garmin Connect: {str(e)}",
            }

    # 2. Fallback to garminconnect if installed
    client = get_garmin_client()
    if client:
        try:
            uploaded = client.upload_workout(payload)
            workout_id = uploaded.get("workoutId") if isinstance(uploaded, dict) else None
            if workout_id:
                try:
                    client.schedule_workout(workout_id, target_date)
                except Exception as sched_err:
                    print(f"[Garmin] Schedule workout warning: {sched_err}")
                try:
                    client.send_scheduled_workouts_to_devices()
                except Exception as push_err:
                    print(f"[Garmin] Push to device warning: {push_err}")
                return {
                    "status": "sent",
                    "method": "garmin_direct",
                    "workout_id": workout_id,
                    "scheduled_date": target_date,
                    "message": f"¡Entrenamiento enviado y programado en tu reloj Garmin ({target_date})!",
                }
            return {
                "status": "error",
                "method": "garmin_direct",
                "message": f"Garmin Connect no devolvió workoutId al subir la sesión ({uploaded}).",
            }
        except Exception as e:
            print(f"[Garmin] Direct workout upload failed: {e}")
            return {
                "status": "error",
                "method": "garmin_direct",
                "message": f"Error al subir/programar en Garmin Connect: {str(e)}",
            }

    return {
        "status": "needs_garmin_login",
        "method": "garmin_oauth_required",
        "message": "Para enviar sesiones automáticamente al reloj Garmin, vincula tu email y contraseña en Perfil → Garmin Connect (la clave GCDC_ es de solo lectura).",
    }


def _fmt_pace_str(sec: float) -> str:
    s_int = max(1, int(round(sec)))
    return f"{s_int // 60}:{s_int % 60:02d} /km"


def calculate_gap_sec(pace_sec: float, grade_pct: float) -> int:
    """
    Calculates Grade Adjusted Pace (GAP) in sec/km using Minetti's energetic cost factor:
    uphill: 1 + 0.033*g + 0.0018*g^2; downhill: smooth adjustment.
    """
    if not pace_sec or pace_sec <= 0:
        return 0
    g = max(-30.0, min(30.0, float(grade_pct or 0.0)))
    if g >= 0:
        cost = 1.0 + 0.033 * g + 0.0018 * (g ** 2)
    else:
        cost = max(0.65, 1.0 + 0.018 * g + 0.0007 * (g ** 2))
    return max(120, int(round(pace_sec / cost)))


def _normalize_garmin_laps(raw_data: Any) -> List[Dict[str, Any]]:
    lap_dtos: List[Dict[str, Any]] = []
    if isinstance(raw_data, dict):
        lap_dtos = raw_data.get("lapDTOs") or raw_data.get("laps") or []
    elif isinstance(raw_data, list):
        lap_dtos = raw_data
    out: List[Dict[str, Any]] = []
    for i, lap in enumerate(lap_dtos):
        if not isinstance(lap, dict):
            continue
        dur = float(lap.get("duration") or lap.get("movingDuration") or lap.get("elapsedDuration") or 0)
        dist = float(lap.get("distance") or 0)
        spd = float(lap["averageSpeed"]) if lap.get("averageSpeed") is not None else (dist / dur if dur > 0 and dist > 0 else None)
        pace_s = round(1000.0 / spd) if (spd and spd > 0.4) else None
        cad = lap.get("averageRunCadence") or lap.get("averageBikeCadence") or lap.get("averageCadence")
        if cad is not None:
            cad_f = float(cad)
            if "averageRunCadence" in lap and 0 < cad_f < 115:
                cad_f *= 2
            cad_val = round(cad_f)
        else:
            cad_val = None
        pwr = lap.get("averagePower")
        out.append({
            "index": int(lap.get("lapIndex") or (i + 1)),
            "intent": lap.get("intensityType") or lap.get("wktStepType") or None,
            "duration_sec": round(dur, 1),
            "distance_m": round(dist, 1),
            "avg_speed_mps": round(spd, 3) if spd else None,
            "pace_sec": pace_s,
            "avg_hr": round(float(lap["averageHR"])) if lap.get("averageHR") else None,
            "max_hr": round(float(lap["maxHR"])) if lap.get("maxHR") else None,
            "cadence": cad_val,
            "avg_power_w": round(float(pwr), 1) if pwr is not None else None,
            "elevation_gain_m": round(float(lap.get("elevationGain") or 0), 1),
            "elevation_loss_m": round(float(lap.get("elevationLoss") or 0), 1),
            "source": "laps_garmin",
        })
    return out


def get_garmin_activity_laps(activity_id: str) -> List[Dict[str, Any]]:
    """
    Hypothesis-tested Garmin laps fetch: tries Personal API /splits first, then garth OAuth /splits.
    Returns [] cleanly if unavailable so caller falls back to Strava laps or stream detection.
    """
    bearer = _get_personal_api_token()
    if bearer:
        try:
            r = requests.get(
                f"{PERSONAL_API_BASE}/activity-service/activity/{activity_id}/splits",
                headers={"Authorization": f"Bearer {bearer}"},
                timeout=10,
            )
            if r.status_code == 200:
                laps = _normalize_garmin_laps(r.json())
                if laps:
                    print(f"[Garmin Laps] Loaded {len(laps)} laps via Personal API /splits for {activity_id}")
                    return laps
        except Exception as e:
            print(f"[Garmin Laps] Personal API /splits not available for {activity_id}: {e}")

    client = _get_garth_client()
    if client is not None:
        try:
            raw = client.connectapi(f"/activity-service/activity/{activity_id}/splits")
            laps = _normalize_garmin_laps(raw)
            if laps:
                print(f"[Garmin Laps] Loaded {len(laps)} laps via garth OAuth /splits for {activity_id}")
                return laps
        except Exception as e:
            print(f"[Garmin Laps] Garth /splits not available for {activity_id}: {e}")

    return []


def get_garmin_activity_details(activity_id: str, max_chart_size: int = 1500) -> Dict[str, Any]:
    """
    Fetches GPS polyline, time-series metrics (testing maxChartSize=1500 with fallback to 180),
    and laps from Garmin API. Includes directPower, speed_mps, cadence, and downsamples if >2000 pts.
    """
    bearer = _get_personal_api_token()
    if not bearer:
        return {"polyline": [], "splits": [], "hr_zones": [], "chart_series": {}, "laps": []}

    data = None
    for chart_sz in (max_chart_size, 180) if max_chart_size != 180 else (180,):
        try:
            r = requests.get(
                f"{PERSONAL_API_BASE}/activity-service/activity/{activity_id}/details",
                params={"maxChartSize": chart_sz, "maxPolylineSize": 400},
                headers={"Authorization": f"Bearer {bearer}"},
                timeout=14,
            )
            if r.status_code == 200:
                candidate = r.json()
                if candidate and (candidate.get("activityDetailMetrics") or candidate.get("geoPolylineDTO")):
                    data = candidate
                    print(f"[Garmin Details] Loaded details for {activity_id} with maxChartSize={chart_sz}")
                    break
        except Exception as e:
            print(f"[Garmin Details] Error fetching {activity_id} (maxChartSize={chart_sz}): {e}")

    if not data:
        return {"polyline": [], "splits": [], "hr_zones": [], "chart_series": {}, "laps": []}

    # 1. Polyline [lat, lon]
    raw_poly = (data.get("geoPolylineDTO") or {}).get("polyline") or []
    polyline = [
        [pt["lat"], pt["lon"]]
        for pt in raw_poly
        if pt.get("lat") is not None and pt.get("lon") is not None
    ]

    # 2. Metric descriptors map (use explicit None checks so index 0 is never skipped)
    desc = {d["key"]: d["metricsIndex"] for d in data.get("metricDescriptors", []) if "key" in d}

    def _first_idx(*keys):
        for k in keys:
            if k in desc and desc[k] is not None:
                return desc[k]
        return None

    idx_dist = _first_idx("sumDistance")
    idx_time = _first_idx("sumElapsedDuration", "sumDuration")
    idx_hr = _first_idx("directHeartRate")
    idx_elev = _first_idx("directElevation")
    idx_spd = _first_idx("directSpeed")
    idx_cad = _first_idx("directDoubleCadence", "directRunCadence", "directBikeCadence", "directCadence")
    is_run_cad_single = ("directDoubleCadence" not in desc) and ("directRunCadence" in desc)
    idx_temp = _first_idx("directAirTemperature", "directTemperature", "directBodyTemperature")
    idx_pwr = _first_idx("directPower", "avgPower")

    rows = data.get("activityDetailMetrics") or []
    chart_dist, chart_elev, chart_hr, chart_pace, chart_time, chart_cad, chart_temp = [], [], [], [], [], [], []
    chart_power, chart_speed = [], []
    hr_counts = [0, 0, 0, 0, 0]  # Z1..Z5

    # Splits accumulator per 1000m
    splits = []
    current_km = 1
    split_start_t = 0.0
    split_hrs = []
    split_elev_start = None
    prev_elev = None
    total_elev_gain = 0.0
    last_d_m = 0.0
    last_t_s = 0.0
    last_el = None

    for row in rows:
        m = row.get("metrics") or []
        d_m = m[idx_dist] if idx_dist is not None and idx_dist < len(m) else None
        t_s = m[idx_time] if idx_time is not None and idx_time < len(m) else None
        hr = m[idx_hr] if idx_hr is not None and idx_hr < len(m) else None
        el = m[idx_elev] if idx_elev is not None and idx_elev < len(m) else None
        spd = m[idx_spd] if idx_spd is not None and idx_spd < len(m) else None
        cad = m[idx_cad] if idx_cad is not None and idx_cad < len(m) else None
        temp = m[idx_temp] if idx_temp is not None and idx_temp < len(m) else None
        pwr = m[idx_pwr] if idx_pwr is not None and idx_pwr < len(m) else None

        if d_m is not None:
            last_d_m = float(d_m)
        if t_s is not None:
            last_t_s = float(t_s)
        if el is not None:
            last_el = el

        if el is not None:
            if prev_elev is not None and el > prev_elev:
                total_elev_gain += (el - prev_elev)
            prev_elev = el
            if split_elev_start is None:
                split_elev_start = el

        if hr is not None and hr > 40:
            if hr < 125: hr_counts[0] += 1
            elif hr < 145: hr_counts[1] += 1
            elif hr < 160: hr_counts[2] += 1
            elif hr < 175: hr_counts[3] += 1
            else: hr_counts[4] += 1
            split_hrs.append(hr)

        if d_m is not None:
            chart_dist.append(round(d_m / 1000.0, 3))
            chart_elev.append(round(el, 1) if el is not None else None)
            chart_hr.append(round(hr) if hr is not None else None)
            pace_s = round(1000.0 / spd) if (spd and spd > 0.4) else None
            chart_pace.append(pace_s)
            chart_speed.append(round(float(spd), 2) if spd is not None else None)
            chart_time.append(round(t_s, 1) if t_s is not None else None)
            if cad is not None and is_run_cad_single and 0 < cad < 115:
                cad = cad * 2
            chart_cad.append(round(cad) if cad is not None else None)
            chart_temp.append(round(temp, 1) if temp is not None else None)
            chart_power.append(round(float(pwr), 1) if pwr is not None else None)

            if t_s is not None and d_m >= current_km * 1000.0:
                seg_t = max(1.0, t_s - split_start_t)
                pace_min = int(seg_t // 60)
                pace_sec = int(seg_t % 60)
                avg_hr = round(sum(split_hrs) / len(split_hrs)) if split_hrs else None
                elev_diff = round((el - split_elev_start), 1) if (el is not None and split_elev_start is not None) else 0
                grade_pct = (elev_diff / 1000.0) * 100.0
                gap_s = calculate_gap_sec(seg_t, grade_pct)
                splits.append({
                    "km": current_km,
                    "pace_sec": round(seg_t),
                    "pace_str": f"{pace_min}:{pace_sec:02d} /km",
                    "gap_sec": gap_s,
                    "gap_str": _fmt_pace_str(gap_s),
                    "avg_hr": avg_hr,
                    "elev_diff": elev_diff,
                })
                current_km += 1
                split_start_t = t_s
                split_hrs = []
                split_elev_start = el

    # Last fractional split if >= 50 m remains after last full km
    rem_m = last_d_m - (current_km - 1) * 1000.0
    if rem_m >= 50.0 and last_t_s > split_start_t:
        seg_t = max(1.0, last_t_s - split_start_t)
        pace_per_km = seg_t / (rem_m / 1000.0)
        pace_min = int(pace_per_km // 60)
        pace_sec = int(pace_per_km % 60)
        avg_hr = round(sum(split_hrs) / len(split_hrs)) if split_hrs else None
        elev_diff = round((last_el - split_elev_start), 1) if (last_el is not None and split_elev_start is not None) else 0
        grade_pct = (elev_diff / max(50.0, rem_m)) * 100.0
        gap_s = calculate_gap_sec(pace_per_km, grade_pct)
        splits.append({
            "km": round(rem_m / 1000.0, 2),
            "pace_sec": round(pace_per_km),
            "pace_str": f"{pace_min}:{pace_sec:02d} /km",
            "gap_sec": gap_s,
            "gap_str": _fmt_pace_str(gap_s),
            "avg_hr": avg_hr,
            "elev_diff": elev_diff,
            "is_partial": True,
        })

    total_hr_samples = sum(hr_counts) or 1
    zone_names = [
        ("Z1 Recuperación", "<125 ppm", "#64748B"),
        ("Z2 Aeróbica", "125–145 ppm", "#00AEEF"),
        ("Z3 Tempo", "145–160 ppm", "#00E676"),
        ("Z4 Umbral", "160–175 ppm", "#FF9800"),
        ("Z5 Máxima", ">175 ppm", "#FF1744"),
    ]
    hr_zones = [
        {
            "zone": zone_names[i][0],
            "range": zone_names[i][1],
            "color": zone_names[i][2],
            "pct": round((hr_counts[i] / total_hr_samples) * 100),
        }
        for i in range(5)
    ]

    # Downsample chart series if > 2000 points to protect DB size
    n_pts = len(chart_dist)
    if n_pts > 2000:
        idxs = [round(i * (n_pts - 1) / 1999) for i in range(2000)]
        def _sub(arr):
            return [arr[k] for k in idxs] if len(arr) == n_pts else arr
        chart_dist = _sub(chart_dist)
        chart_elev = _sub(chart_elev)
        chart_hr = _sub(chart_hr)
        chart_pace = _sub(chart_pace)
        chart_speed = _sub(chart_speed)
        chart_time = _sub(chart_time)
        chart_cad = _sub(chart_cad)
        chart_temp = _sub(chart_temp)
        chart_power = _sub(chart_power)

    laps = get_garmin_activity_laps(activity_id)

    return {
        "polyline": polyline,
        "splits": splits,
        "hr_zones": hr_zones,
        "laps": laps,
        "elevation_gain": round(total_elev_gain),
        "chart_series": {
            "dist_km": chart_dist,
            "elevation_m": chart_elev,
            "hr": chart_hr,
            "pace_sec": chart_pace,
            "speed_mps": chart_speed,
            "time_sec": chart_time,
            "cadence": chart_cad,
            "temp_c": chart_temp,
            "power_w": chart_power,
        },
    }
