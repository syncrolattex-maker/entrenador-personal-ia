"""
strava_client.py — Complementary Strava integration for AaronFit.
Role: Provides GPS polylines, route geometry, and activity discovery as a secondary
source to Garmin Connect. Never overrides Garmin physiological metrics.
"""
import json
import os
import time
from typing import Any, Dict, List, Optional
import requests


def decode_polyline(encoded: str) -> List[List[float]]:
    """Decodes a Google-encoded Strava polyline string into [[lat, lon], ...]."""
    if not encoded:
        return []
    coords: List[List[float]] = []
    index, lat, lng = 0, 0, 0
    length = len(encoded)
    while index < length:
        for is_lng in (False, True):
            shift, result = 0, 0
            while index < length:
                b = ord(encoded[index]) - 63
                index += 1
                result |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            delta = ~(result >> 1) if (result & 1) else (result >> 1)
            if is_lng:
                lng += delta
            else:
                lat += delta
        coords.append([round(lat * 1e-5, 6), round(lng * 1e-5, 6)])
    return coords


def _map_strava_sport(sport_type: str) -> str:
    st = (sport_type or "").lower()
    if any(k in st for k in ("run", "trail")):
        return "Carrera"
    if any(k in st for k in ("ride", "cycl", "bike", "gravel", "mtb")):
        return "Ciclismo"
    if any(k in st for k in ("weight", "strength", "workout", "crossfit")):
        return "Fuerza"
    if "walk" in st or "hike" in st:
        return "Caminata"
    if "swim" in st:
        return "Natación"
    return sport_type or "Entrenamiento"


def is_strava_configured() -> bool:
    return bool(os.getenv("STRAVA_CLIENT_ID") and os.getenv("STRAVA_CLIENT_SECRET"))


def _get_strava_access_token() -> Optional[str]:
    client_id = os.getenv("STRAVA_CLIENT_ID", "").strip()
    client_secret = os.getenv("STRAVA_CLIENT_SECRET", "").strip()
    if not client_id or not client_secret:
        return None
    try:
        import database
        raw = database.get_setting("strava_oauth_json")
        if not raw:
            return None
        tok = json.loads(raw)
        now = time.time()
        if tok.get("access_token") and now < float(tok.get("expires_at") or 0) - 60:
            return tok["access_token"]
        refresh_tok = tok.get("refresh_token")
        if not refresh_tok:
            return None
        resp = requests.post(
            "https://www.strava.com/oauth/token",
            data={
                "client_id": client_id,
                "client_secret": client_secret,
                "grant_type": "refresh_token",
                "refresh_token": refresh_tok,
            },
            timeout=12,
        )
        if resp.status_code == 200:
            new_tok = resp.json()
            database.set_setting("strava_oauth_json", json.dumps(new_tok))
            return new_tok.get("access_token")
    except Exception as e:
        print(f"[Strava] Token refresh error: {e}")
    return None


def get_strava_activities(per_page: int = 30, page: int = 1) -> List[Dict[str, Any]]:
    """Fetches Strava activities and normalizes them with GPS polylines (complementary source)."""
    token = _get_strava_access_token()
    if not token:
        return []
    try:
        resp = requests.get(
            "https://www.strava.com/api/v3/athlete/activities",
            headers={"Authorization": f"Bearer {token}"},
            params={"per_page": per_page, "page": page},
            timeout=12,
        )
        if resp.status_code != 200:
            return []
        raw_list = resp.json() or []
        out: List[Dict[str, Any]] = []
        for a in raw_list:
            sid = str(a.get("id") or "")
            if not sid:
                continue
            poly_enc = ((a.get("map") or {}).get("summary_polyline") or "").strip()
            poly = decode_polyline(poly_enc) if poly_enc else None
            dist_km = round(float(a.get("distance") or 0) / 1000.0, 2)
            dur_min = round(float(a.get("moving_time") or a.get("elapsed_time") or 0) / 60.0, 1)
            mapped = _map_strava_sport(a.get("sport_type") or a.get("type") or "")
            start_local = (a.get("start_date_local") or a.get("start_date") or "")[:10]
            out.append({
                "id": f"strava_{sid}",
                "strava_id": sid,
                "fecha": start_local,
                "timezone": a.get("timezone") or "Europe/Madrid",
                "tipo": mapped,
                "nombre": a.get("name") or mapped,
                "duracion_min": dur_min,
                "moving_duration_min": round(float(a.get("moving_time") or 0) / 60.0, 2),
                "elapsed_duration_min": round(float(a.get("elapsed_time") or 0) / 60.0, 2),
                "distancia_km": dist_km if dist_km > 0 else None,
                "desnivel_m": round(float(a.get("total_elevation_gain") or 0)),
                "frecuencia_cardiaca_media": round(a["average_heartrate"]) if a.get("average_heartrate") else None,
                "frecuencia_cardiaca_max": round(a["max_heartrate"]) if a.get("max_heartrate") else None,
                "polyline": poly,
                "device_name": a.get("device_name") or "Strava",
                "raw_payload": a,
                "fuente": "Strava",
            })
        return out
    except Exception as e:
        print(f"[Strava] Fetch activities error: {e}")
        return []


def get_strava_activity_laps(strava_id: str) -> List[Dict[str, Any]]:
    """Fetches laps for a specific Strava activity ID via /api/v3/activities/{id}/laps."""
    token = _get_strava_access_token()
    if not token or not strava_id:
        return []
    sid = str(strava_id).replace("strava_", "")
    try:
        resp = requests.get(
            f"https://www.strava.com/api/v3/activities/{sid}/laps",
            headers={"Authorization": f"Bearer {token}"},
            timeout=10,
        )
        if resp.status_code != 200:
            return []
        raw_laps = resp.json() or []
        out: List[Dict[str, Any]] = []
        for i, lap in enumerate(raw_laps):
            dur = float(lap.get("moving_time") or lap.get("elapsed_time") or 0)
            dist = float(lap.get("distance") or 0)
            spd = float(lap["average_speed"]) if lap.get("average_speed") else (dist / dur if dur > 0 and dist > 0 else None)
            pace_s = round(1000.0 / spd) if (spd and spd > 0.4) else None
            cad = lap.get("average_cadence")
            out.append({
                "index": int(lap.get("lap_index") or (i + 1)),
                "intent": None,
                "duration_sec": round(dur, 1),
                "distance_m": round(dist, 1),
                "avg_speed_mps": round(spd, 3) if spd else None,
                "pace_sec": pace_s,
                "avg_hr": round(float(lap["average_heartrate"])) if lap.get("average_heartrate") else None,
                "max_hr": round(float(lap["max_heartrate"])) if lap.get("max_heartrate") else None,
                "cadence": round(float(cad) * 2) if (cad and float(cad) < 115) else (round(float(cad)) if cad else None),
                "avg_power_w": round(float(lap["average_watts"]), 1) if lap.get("average_watts") else None,
                "elevation_gain_m": round(float(lap.get("total_elevation_gain") or 0), 1),
                "elevation_loss_m": 0.0,
                "source": "laps_strava",
            })
        if out:
            print(f"[Strava Laps] Loaded {len(out)} laps from Strava activity {sid}")
        return out
    except Exception as e:
        print(f"[Strava Laps] Error fetching laps for {sid}: {e}")
        return []


def find_matching_strava_laps(start_date: str, sport_type: str, distance_km: float) -> List[Dict[str, Any]]:
    """Finds an equivalent Strava activity on the same date/sport (±10% distance) and returns its laps."""
    acts = get_strava_activities(per_page=30, page=1)
    if not acts:
        return []
    target_date = (start_date or "")[:10]
    for a in acts:
        if (a.get("fecha") or "")[:10] != target_date:
            continue
        if a.get("tipo") != sport_type:
            continue
        a_dist = float(a.get("distancia_km") or 0)
        if distance_km > 0 and a_dist > 0:
            if abs(a_dist - distance_km) / max(0.1, distance_km) > 0.12:
                continue
        laps = get_strava_activity_laps(a.get("strava_id") or "")
        if laps:
            return laps
    return []
