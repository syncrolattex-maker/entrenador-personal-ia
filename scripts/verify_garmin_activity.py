"""
scripts/verify_garmin_activity.py — Verificador local de hipótesis de Garmin API.
Uso:
    python scripts/verify_garmin_activity.py <activity_id>

Prueba contra una actividad real de tu cuenta:
  (a) Si maxChartSize = 180 / 1000 / 1500 / 2000 devuelve más puntos en /details.
  (b) Si aparece 'directPower' (y qué descriptores existen) en metricDescriptors.
  (c) Si /activity-service/activity/{id}/splits devuelve vueltas (lapDTOs).

No imprime ni registra ninguna credencial, token ni dato personal identificable.
"""
import os
import sys
import requests

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dotenv import load_dotenv  # noqa: E402
load_dotenv(".env.local")
load_dotenv()

import garmin_client  # noqa: E402


def verify_activity(activity_id: str) -> str:
    bearer = garmin_client._get_personal_api_token()
    garth_client = garmin_client._get_garth_client()

    lines = [
        f"# Informe de Verificación Garmin API — Actividad `{activity_id}`",
        "",
        f"- **Token Personal API (`GCDC_`) disponible**: `{'Sí' if bearer else 'No'}`",
        f"- **Sesión OAuth (`garth`) disponible**: `{'Sí' if garth_client else 'No'}`",
        "",
        "## (a) Prueba de resolución `maxChartSize` en `/details`",
    ]

    descriptors_found = []

    if not bearer:
        lines.append("- ⚠️ No hay token de Personal API configurado en `.env` ni en BD para probar `/details`.")
    else:
        for sz in (180, 1000, 1500, 2000):
            try:
                r = requests.get(
                    f"{garmin_client.PERSONAL_API_BASE}/activity-service/activity/{activity_id}/details",
                    params={"maxChartSize": sz, "maxPolylineSize": 400},
                    headers={"Authorization": f"Bearer {bearer}"},
                    timeout=15,
                )
                if r.status_code == 200:
                    d = r.json() or {}
                    rows = d.get("activityDetailMetrics") or []
                    if not descriptors_found:
                        descriptors_found = [m.get("key") for m in (d.get("metricDescriptors") or []) if m.get("key")]
                    lines.append(f"- `maxChartSize={sz}` → HTTP `200` · **`{len(rows)}` puntos** devueltos.")
                else:
                    lines.append(f"- `maxChartSize={sz}` → HTTP `{r.status_code}`.")
            except Exception as e:
                lines.append(f"- `maxChartSize={sz}` → Error de red: `{type(e).__name__}`.")

    lines.extend([
        "",
        "## (b) Descriptores en `metricDescriptors` y presencia de `directPower`",
    ])
    if descriptors_found:
        has_pwr = "directPower" in descriptors_found or "avgPower" in descriptors_found
        lines.append(f"- **`directPower` presente**: `{'Sí' if has_pwr else 'No'}`")
        lines.append(f"- **Lista de descriptores ({len(descriptors_found)})**: `{', '.join(descriptors_found)}`")
    else:
        lines.append("- ⚠️ Sin descriptores disponibles.")

    lines.extend([
        "",
        "## (c) Prueba de vueltas (`/activity-service/activity/{id}/splits`)",
    ])
    if bearer:
        try:
            rs = requests.get(
                f"{garmin_client.PERSONAL_API_BASE}/activity-service/activity/{activity_id}/splits",
                headers={"Authorization": f"Bearer {bearer}"},
                timeout=12,
            )
            if rs.status_code == 200:
                laps = garmin_client._normalize_garmin_laps(rs.json())
                lines.append(f"- **Personal API `/splits`** → HTTP `200` · **`{len(laps)}` vueltas** normalizadas.")
                if laps:
                    sample_keys = [k for k, v in laps[0].items() if v is not None]
                    lines.append(f"  - Campos con datos en vuelta #1: `{', '.join(sample_keys)}`")
            else:
                lines.append(f"- **Personal API `/splits`** → HTTP `{rs.status_code}`.")
        except Exception as e:
            lines.append(f"- **Personal API `/splits`** → Error: `{type(e).__name__}`.")

    if garth_client is not None:
        try:
            raw = garth_client.connectapi(f"/activity-service/activity/{activity_id}/splits")
            laps = garmin_client._normalize_garmin_laps(raw)
            lines.append(f"- **Garth OAuth `/splits`** → OK · **`{len(laps)}` vueltas** normalizadas.")
        except Exception as e:
            lines.append(f"- **Garth OAuth `/splits`** → No disponible (`{type(e).__name__}`).")

    report = "\n".join(lines) + "\n"
    return report


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Uso: python scripts/verify_garmin_activity.py <activity_id>")
        sys.exit(1)
    act_id = sys.argv[1].strip()
    rep = verify_activity(act_id)
    print(rep)
