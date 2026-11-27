"""
scripts/verify_garmin_wellness.py — Real 1-day Garmin Wellness & PostgreSQL verification script (Phase 5.1).

Usage:
  python scripts/verify_garmin_wellness.py [YYYY-MM-DD]

Checks:
  1. Garmin Personal API token exchange (POST /personalapitoken-service/personal-api/personal-api-key/token)
     or garth OAuth session without printing or logging any secret/token.
  2. Real 1-day query for Sleep, Steps/Summary, HRV, Body Battery, and Stress.
  3. Normalization via wellness_engine.normalize_garmin_daily_bundle.
  4. Idempotent UPSERT into active database (PostgreSQL if DATABASE_URL set, else SQLite) and read-back.
"""
import os
import sys
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

try:
    from dotenv import load_dotenv
    load_dotenv(ROOT / ".env")
except Exception:
    pass

import database
import garmin_client
import wellness_engine


def main() -> int:
    target_date = sys.argv[1][:10] if len(sys.argv) > 1 else (date.today() - timedelta(days=1)).isoformat()
    pg_active = database.is_postgres_active()
    has_personal_key = bool(garmin_client.get_saved_personal_key())
    has_garth = garmin_client._get_garth_client() is not None

    print("=== AARONFIT — VERIFICACIÓN REAL GARMIN WELLNESS (1 DÍA) ===")
    print(f"Fecha consultada       : {target_date}")
    print(f"Motor BD activo        : {'PostgreSQL (DATABASE_URL)' if pg_active else 'SQLite local (fallback)'}")
    print(f"Personal API Key conf. : {'SÍ' if has_personal_key else 'NO'}")
    print(f"Sesión garth OAuth     : {'SÍ' if has_garth else 'NO'}")

    if not has_personal_key and not has_garth:
        print("\n[LIMITACIÓN] No hay credenciales Garmin (GARMIN_PERSONAL_API_KEY ni tokens OAuth) en este entorno.")
        print("Configura tu .env local y vuelve a ejecutar este script para validar contra tu cuenta real.")
        return 2

    raw_bundle = garmin_client.fetch_garmin_daily_wellness_raw(target_date)
    print(f"\nMétodo autenticación   : {raw_bundle.get('auth_method')}")
    print(f"Endpoints utilizados   : {raw_bundle.get('endpoints_used')}")
    print(f"Errores reportados     : {raw_bundle.get('errors')}")

    normalized = wellness_engine.normalize_garmin_daily_bundle(raw_bundle, target_date=target_date)
    print("\n--- Datos normalizados ---")
    print(f"day_status             : {normalized.get('day_status')}")
    print(f"Sueño (seg / score)    : {normalized.get('sleep_total_sec')} s / score={normalized.get('sleep_score')}")
    print(f"Pasos / Objetivo       : {normalized.get('steps')} / {normalized.get('step_goal')}")
    print(f"HRV noche / Estado     : {normalized.get('hrv_last_night')} ms / {normalized.get('hrv_status')}")
    print(f"FC Reposo / Estrés med : {normalized.get('resting_hr')} ppm / {normalized.get('stress_avg')}")
    print(f"Body Battery máx/rec   : {normalized.get('body_battery_max')} / +{normalized.get('body_battery_charged')}")
    print(f"SpO2 / Respiración     : {normalized.get('spo2_avg')}% / {normalized.get('respiration_avg')} rpm")

    database.upsert_daily_wellness([normalized])
    saved = database.get_daily_wellness(normalized["date"])
    print(f"\nPersistencia y lectura : {'OK' if saved else 'ERROR'} (date={saved.get('date') if saved else None}, status={saved.get('day_status') if saved else None})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
