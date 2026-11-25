import os
import json
import math
import sqlite3
from datetime import date
from pathlib import Path
from typing import List, Dict, Any, Optional, Tuple

DATABASE_URL = os.getenv("DATABASE_URL", "").strip()

LOCAL_DB_PATH = (
    Path("/tmp/aaronfit.db")
    if os.getenv("VERCEL")
    else Path(__file__).parent / "data" / "aaronfit.db"
)


def _use_postgres() -> bool:
    return bool(DATABASE_URL and DATABASE_URL.startswith(("postgres://", "postgresql://")))


def is_postgres_active() -> bool:
    if not _use_postgres():
        return False
    conn = _get_conn()
    active = not isinstance(conn, sqlite3.Connection)
    conn.close()
    return active


def _get_conn():
    if _use_postgres():
        try:
            import psycopg
            return psycopg.connect(DATABASE_URL)
        except ImportError:
            try:
                import psycopg2
                return psycopg2.connect(DATABASE_URL)
            except ImportError:
                print("[DB] psycopg/psycopg2 not installed, falling back to SQLite.")
    LOCAL_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(LOCAL_DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


_DB_INITIALIZED = False


def init_db() -> None:
    """Creates the 4 core tables: activities, activity_streams, personal_records, gear."""
    global _DB_INITIALIZED
    if _DB_INITIALIZED:
        return
    conn = _get_conn()
    cur = conn.cursor()
    is_pg = _use_postgres() and not isinstance(conn, sqlite3.Connection)
    id_col = "SERIAL PRIMARY KEY" if is_pg else "INTEGER PRIMARY KEY AUTOINCREMENT"

    cur.execute(f"""
        CREATE TABLE IF NOT EXISTS activities (
            id {id_col},
            external_id TEXT UNIQUE NOT NULL,
            source TEXT DEFAULT 'Garmin Connect',
            sport_type TEXT NOT NULL,
            name TEXT NOT NULL,
            start_date TEXT NOT NULL,
            distance_km REAL DEFAULT 0,
            duration_min REAL DEFAULT 0,
            elevation_gain REAL DEFAULT 0,
            avg_hr INTEGER,
            max_hr INTEGER,
            calories INTEGER,
            avg_pace_str TEXT,
            aerobic_te REAL,
            polyline_json TEXT,
            relative_effort REAL,
            rpe INTEGER,
            avg_power_w REAL,
            energy_kj REAL,
            intensity_pct REAL,
            vam_mh REAL,
            moving_duration_min REAL,
            elapsed_duration_min REAL,
            avg_cadence INTEGER,
            avg_temp_c REAL,
            device_name TEXT,
            gear_id INTEGER,
            description TEXT,
            private_notes TEXT
        )
    """)

    # Safe migrations for activities
    act_new_cols = [
        ("relative_effort", "REAL"),
        ("rpe", "INTEGER"),
        ("avg_power_w", "REAL"),
        ("energy_kj", "REAL"),
        ("intensity_pct", "REAL"),
        ("vam_mh", "REAL"),
        ("moving_duration_min", "REAL"),
        ("elapsed_duration_min", "REAL"),
        ("avg_cadence", "INTEGER"),
        ("avg_temp_c", "REAL"),
        ("device_name", "TEXT"),
        ("gear_id", "INTEGER"),
        ("description", "TEXT"),
        ("private_notes", "TEXT"),
        ("elevation_loss", "REAL"),
        ("timezone", "TEXT"),
        ("strava_id", "TEXT"),
        ("raw_payload_json", "TEXT"),
        ("data_quality_json", "TEXT"),
        ("updated_at", "TEXT"),
    ]
    try:
        if is_pg:
            for col_name, col_type in act_new_cols:
                cur.execute(f"ALTER TABLE activities ADD COLUMN IF NOT EXISTS {col_name} {col_type}")
        else:
            cur.execute("PRAGMA table_info(activities)")
            existing_act_cols = [r[1] for r in cur.fetchall()]
            for col_name, col_type in act_new_cols:
                if col_name not in existing_act_cols:
                    cur.execute(f"ALTER TABLE activities ADD COLUMN {col_name} {col_type}")
    except Exception as e:
        print(f"[DB] Activities migration note: {e}")

    cur.execute("""
        CREATE TABLE IF NOT EXISTS activity_streams (
            activity_id TEXT PRIMARY KEY,
            splits_json TEXT,
            hr_zones_json TEXT,
            chart_series_json TEXT
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS personal_records (
            category TEXT PRIMARY KEY,
            label TEXT NOT NULL,
            best_value TEXT NOT NULL,
            best_seconds REAL,
            activity_id TEXT,
            activity_name TEXT,
            achieved_date TEXT,
            is_official INTEGER DEFAULT 0
        )
    """)

    try:
        if is_pg:
            cur.execute("ALTER TABLE personal_records ADD COLUMN IF NOT EXISTS is_official INTEGER DEFAULT 0")
        else:
            cur.execute("PRAGMA table_info(personal_records)")
            pr_cols = [r[1] for r in cur.fetchall()]
            if "is_official" not in pr_cols:
                cur.execute("ALTER TABLE personal_records ADD COLUMN is_official INTEGER DEFAULT 0")
    except Exception as e:
        print(f"[DB] PR migration note: {e}")

    cur.execute(f"""
        CREATE TABLE IF NOT EXISTS segments (
            id {id_col},
            name TEXT NOT NULL,
            sport_type TEXT NOT NULL,
            start_lat REAL NOT NULL,
            start_lon REAL NOT NULL,
            end_lat REAL NOT NULL,
            end_lon REAL NOT NULL,
            distance_m REAL DEFAULT 0,
            elevation_gain REAL DEFAULT 0
        )
    """)

    cur.execute(f"""
        CREATE TABLE IF NOT EXISTS segment_efforts (
            id {id_col},
            segment_id INTEGER NOT NULL,
            activity_id TEXT NOT NULL,
            elapsed_sec REAL NOT NULL,
            avg_hr INTEGER,
            vam_mh REAL,
            achieved_date TEXT
        )
    """)

    cur.execute(f"""
        CREATE TABLE IF NOT EXISTS gear (
            id {id_col},
            name TEXT NOT NULL,
            gear_type TEXT NOT NULL,
            brand TEXT DEFAULT '',
            initial_km REAL DEFAULT 0,
            logged_km REAL DEFAULT 0,
            alert_km REAL DEFAULT 650,
            active INTEGER DEFAULT 1,
            created_at TEXT DEFAULT ''
        )
    """)

    # Safe migration if gear table already existed without created_at
    try:
        if is_pg:
            cur.execute("ALTER TABLE gear ADD COLUMN IF NOT EXISTS created_at TEXT DEFAULT ''")
        else:
            cur.execute("PRAGMA table_info(gear)")
            cols = [r[1] for r in cur.fetchall()]
            if "created_at" not in cols:
                cur.execute("ALTER TABLE gear ADD COLUMN created_at TEXT DEFAULT ''")
    except Exception as e:
        print(f"[DB] Gear migration note: {e}")

    cur.execute("""
        CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS daily_summaries (
            date TEXT PRIMARY KEY,
            run_km REAL DEFAULT 0,
            bike_km REAL DEFAULT 0,
            other_km REAL DEFAULT 0,
            total_min REAL DEFAULT 0,
            elevation_gain REAL DEFAULT 0,
            elevation_loss REAL DEFAULT 0,
            relative_effort REAL DEFAULT 0,
            activities_count INTEGER DEFAULT 0,
            sports_json TEXT,
            updated_at TEXT
        )
    """)

    # Performance indexes for paginated history, date-range analytics, and deduplication
    for idx_sql in [
        "CREATE INDEX IF NOT EXISTS idx_activities_start_date ON activities (start_date DESC)",
        "CREATE INDEX IF NOT EXISTS idx_activities_sport_date ON activities (sport_type, start_date DESC)",
        "CREATE INDEX IF NOT EXISTS idx_activities_source ON activities (source)",
        "CREATE INDEX IF NOT EXISTS idx_activities_strava_id ON activities (strava_id)",
        "CREATE INDEX IF NOT EXISTS idx_daily_summaries_date ON daily_summaries (date DESC)",
    ]:
        try:
            cur.execute(idx_sql)
        except Exception as idx_err:
            print(f"[DB] Index note: {idx_err}")

    # Seed default gear if empty
    cur.execute("SELECT COUNT(*) FROM gear")
    count = cur.fetchone()[0]
    if count == 0:
        ph = "%s" if is_pg else "?"
        cur.execute(
            f"INSERT INTO gear (name, gear_type, brand, initial_km, logged_km, alert_km, active) VALUES ({ph}, {ph}, {ph}, {ph}, {ph}, {ph}, {ph})",
            ("Zapatillas Running", "shoes", "Principal", 0.0, 0.0, 650.0, 1),
        )
        cur.execute(
            f"INSERT INTO gear (name, gear_type, brand, initial_km, logged_km, alert_km, active) VALUES ({ph}, {ph}, {ph}, {ph}, {ph}, {ph}, {ph})",
            ("Bici de Carretera", "bike", "Cadena / Cubiertas", 0.0, 0.0, 3000.0, 1),
        )

    conn.commit()
    conn.close()
    _DB_INITIALIZED = True


def _ph(conn) -> str:
    return "?" if isinstance(conn, sqlite3.Connection) else "%s"


def _rows_to_dicts(cur, rows) -> List[Dict[str, Any]]:
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, r)) for r in rows]


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in meters between two WGS84 coordinates."""
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2.0 * r * math.atan2(math.sqrt(a), math.sqrt(max(0.0, 1.0 - a)))


def compute_relative_effort(
    duration_min: float,
    hr_zones: Optional[List[Dict[str, Any]]] = None,
    rpe: Optional[int] = None,
    avg_hr: Optional[float] = None,
) -> Optional[float]:
    """Calculates Strava-style TRIMP Relative Effort from HR zones or RPE (1-10)."""
    dur = float(duration_min or 0)
    if dur <= 0:
        return None
    if hr_zones and sum(float(z.get("pct") or 0) for z in hr_zones) > 0:
        weights = [0.8, 1.3, 2.0, 3.2, 4.8]
        trimp = sum(
            dur * (float(z.get("pct") or 0) / 100.0) * weights[i]
            for i, z in enumerate(hr_zones[:5])
        )
        return round(trimp, 1)
    if rpe is not None and 1 <= int(rpe) <= 10:
        return round(dur * (int(rpe) ** 1.5) * 0.4, 1)
    if avg_hr is not None and float(avg_hr) > 40:
        hr = float(avg_hr)
        w = 0.8 if hr < 125 else 1.3 if hr < 145 else 2.0 if hr < 160 else 3.2 if hr < 175 else 4.8
        return round(dur * w, 1)
    return None


def _get_ftp_from_conn(cur, p: str) -> float:
    cur.execute(f"SELECT value FROM app_settings WHERE key = {p}", ("ftp",))
    row = cur.fetchone()
    if row and row[0]:
        try:
            return max(80.0, float(row[0]))
        except Exception:
            pass
    return 220.0


def compute_cycling_and_vam_metrics(
    sport_type: str,
    distance_km: float,
    duration_min: float,
    elevation_gain: float,
    chart_series: Optional[Dict[str, Any]] = None,
    ftp: float = 220.0,
    existing_power_w: Optional[float] = None,
) -> Dict[str, Optional[float]]:
    """Computes VAM (m/h) and cycling power (W), energy (kJ), intensity (% FTP)."""
    dur_min = float(duration_min or 0)
    dist_km = float(distance_km or 0)
    elev_m = float(elevation_gain or 0)

    vam_mh: Optional[float] = None
    if elev_m > 20 and dur_min > 0:
        vam_mh = round(elev_m / (dur_min / 60.0))

    avg_power_w: Optional[float] = float(existing_power_w) if existing_power_w and float(existing_power_w) > 0 else None
    energy_kj: Optional[float] = None
    intensity_pct: Optional[float] = None

    if sport_type == "Ciclismo" and dur_min > 0:
        if avg_power_w is None and dist_km > 0:
            # Basic cycling physics: total mass = 102 kg (93 kg athlete + 9 kg bike)
            m_total = 102.0
            g = 9.81
            crr = 0.005
            rho = 1.225
            cda = 0.36
            dur_sec = dur_min * 60.0
            samples_power = []

            if chart_series and len(chart_series.get("dist_km") or []) > 3:
                dists = chart_series.get("dist_km") or []
                elevs = chart_series.get("elevation_m") or []
                times = chart_series.get("time_sec") or []
                paces = chart_series.get("pace_sec") or []
                for i in range(1, len(dists)):
                    dd_m = (float(dists[i] or 0) - float(dists[i - 1] or 0)) * 1000.0
                    if dd_m <= 0.5:
                        continue
                    dt = None
                    if i < len(times) and times[i] is not None and times[i - 1] is not None:
                        dt = float(times[i]) - float(times[i - 1])
                    elif i < len(paces) and paces[i]:
                        dt = (dd_m / 1000.0) * float(paces[i])
                    if not dt or dt <= 0.2:
                        continue
                    v = min(25.0, dd_m / dt)
                    de = (float(elevs[i]) - float(elevs[i - 1])) if (i < len(elevs) and elevs[i] is not None and elevs[i - 1] is not None) else 0.0
                    grade = max(-0.15, min(0.25, de / dd_m))
                    p_inst = m_total * g * (crr + grade) * v + 0.5 * rho * cda * (v ** 3)
                    samples_power.append(max(0.0, p_inst))

            if samples_power:
                avg_power_w = round(max(40.0, sum(samples_power) / len(samples_power)), 1)
            else:
                v = (dist_km * 1000.0) / dur_sec
                grade = elev_m / (dist_km * 1000.0)
                p_est = m_total * g * (crr + grade) * v + 0.5 * rho * cda * (v ** 3)
                avg_power_w = round(max(40.0, p_est), 1)

        if avg_power_w is not None:
            dur_sec = dur_min * 60.0
            energy_kj = round((avg_power_w * dur_sec) / 1000.0)
            intensity_pct = round((avg_power_w / max(1.0, ftp)) * 100.0)

    return {
        "avg_power_w": avg_power_w,
        "energy_kj": energy_kj,
        "intensity_pct": intensity_pct,
        "vam_mh": vam_mh,
    }


def _detect_segments_in_conn(
    cur,
    p: str,
    external_id: str,
    sport_type: str,
    polyline: List[List[float]],
    duration_min: float,
    avg_hr: Optional[int],
    start_date: str,
    chart_series: Optional[Dict[str, Any]] = None,
) -> None:
    if not polyline or len(polyline) < 3:
        return
    cur.execute(f"SELECT * FROM segments WHERE sport_type = {p}", (sport_type,))
    segs = _rows_to_dicts(cur, cur.fetchall())
    if not segs:
        return

    times = (chart_series or {}).get("time_sec") or []
    total_sec = float(duration_min or 0) * 60.0

    for seg in segs:
        s_lat, s_lon = float(seg["start_lat"]), float(seg["start_lon"])
        e_lat, e_lon = float(seg["end_lat"]), float(seg["end_lon"])

        i_start = None
        for i, pt in enumerate(polyline):
            if len(pt) >= 2 and haversine_m(float(pt[0]), float(pt[1]), s_lat, s_lon) <= 35.0:
                i_start = i
                break
        if i_start is None:
            continue

        i_end = None
        for j in range(i_start + 1, len(polyline)):
            pt = polyline[j]
            if len(pt) >= 2 and haversine_m(float(pt[0]), float(pt[1]), e_lat, e_lon) <= 35.0:
                i_end = j
                break
        if i_end is None:
            continue

        elapsed_sec = 0.0
        if len(times) == len(polyline) and times[i_start] is not None and times[i_end] is not None:
            elapsed_sec = max(1.0, float(times[i_end]) - float(times[i_start]))
        elif total_sec > 0:
            frac = (i_end - i_start) / max(1, len(polyline) - 1)
            elapsed_sec = max(1.0, round(frac * total_sec, 1))
        else:
            continue

        seg_elev = float(seg.get("elevation_gain") or 0)
        vam = round(seg_elev / (elapsed_sec / 3600.0)) if seg_elev > 5 and elapsed_sec > 0 else None

        cur.execute(
            f"SELECT id FROM segment_efforts WHERE segment_id = {p} AND activity_id = {p}",
            (seg["id"], str(external_id)),
        )
        existing = cur.fetchone()
        if existing:
            cur.execute(
                f"UPDATE segment_efforts SET elapsed_sec = {p}, avg_hr = {p}, vam_mh = {p}, achieved_date = {p} WHERE id = {p}",
                (round(elapsed_sec, 1), avg_hr, vam, start_date, existing[0]),
            )
        else:
            cur.execute(
                f"INSERT INTO segment_efforts (segment_id, activity_id, elapsed_sec, avg_hr, vam_mh, achieved_date) VALUES ({','.join([p]*6)})",
                (seg["id"], str(external_id), round(elapsed_sec, 1), avg_hr, vam, start_date),
            )


def validate_activity_record(a: Dict[str, Any]) -> Dict[str, Any]:
    """Validates an incoming activity record, flagging anomalies and recording metric provenance."""
    from datetime import datetime, timezone
    anomalies: List[str] = []
    source = str(a.get("fuente") or a.get("source") or "Garmin Connect")
    is_garmin = "garmin" in source.lower()
    src_tag = "garmin_real" if is_garmin else "strava_geo" if "strava" in source.lower() else "manual"

    dist_km = float(a.get("distancia_km") or a.get("distance_km") or 0)
    dur_min = float(a.get("duracion_min") or a.get("duracion_minutos") or a.get("duration_min") or 0)
    avg_hr = a.get("frecuencia_cardiaca_media") if a.get("frecuencia_cardiaca_media") is not None else a.get("avg_hr")
    max_hr = a.get("frecuencia_cardiaca_max") if a.get("frecuencia_cardiaca_max") is not None else a.get("max_hr")
    sport = a.get("tipo") or a.get("sport_type") or "Carrera"

    if dist_km > 0 and dur_min <= 0:
        anomalies.append("distance_without_duration")
    if avg_hr is not None and (avg_hr < 35 or avg_hr > 230):
        anomalies.append("anomalous_avg_hr")
        avg_hr = None
    if max_hr is not None and (max_hr < 40 or max_hr > 240):
        anomalies.append("anomalous_max_hr")
        max_hr = None
    if sport == "Carrera" and dist_km > 0.2 and dur_min > 0:
        pace_sec = (dur_min * 60.0) / dist_km
        if pace_sec < 120 or pace_sec > 1500:
            anomalies.append("anomalous_avg_pace")
    if avg_hr is None and sport in ("Carrera", "Ciclismo"):
        anomalies.append("missing_hr")

    provenance = {
        "source": source,
        "distance": src_tag if dist_km > 0 else "unavailable",
        "duration": src_tag if dur_min > 0 else "unavailable",
        "hr": src_tag if avg_hr is not None else "unavailable",
        "elevation": src_tag if (a.get("desnivel_m") or a.get("elevation_gain")) else "unavailable",
        "cadence": src_tag if (a.get("cadencia_media") or a.get("avg_cadence")) else "unavailable",
        "power": src_tag if a.get("avg_power_w") else ("estimated" if sport == "Ciclismo" and dist_km > 0 else "unavailable"),
        "relative_effort": "calculated",
    }
    return {
        "anomalies": anomalies,
        "provenance": provenance,
        "validated_at": datetime.now(timezone.utc).isoformat(),
    }


def _find_duplicate_activity(cur, p: str, ext_id: str, strava_id: Optional[str], sport: str, fecha: str, dist_km: float, dur_min: float):
    """Detects duplicates by external_id, strava_id, or (sport + date + distance ±3% + duration ±5%)."""
    cur.execute(f"SELECT id, external_id, source, polyline_json, strava_id, avg_hr, max_hr, avg_cadence, avg_temp_c, elevation_loss, avg_power_w, device_name, raw_payload_json FROM activities WHERE external_id = {p}", (ext_id,))
    row = cur.fetchone()
    if row:
        return _rows_to_dicts(cur, [row])[0]
    if strava_id:
        cur.execute(f"SELECT id, external_id, source, polyline_json, strava_id, avg_hr, max_hr, avg_cadence, avg_temp_c, elevation_loss, avg_power_w, device_name, raw_payload_json FROM activities WHERE strava_id = {p}", (str(strava_id),))
        row = cur.fetchone()
        if row:
            return _rows_to_dicts(cur, [row])[0]
    d_day = (fecha or "")[:10]
    if d_day and dur_min > 1.0:
        cur.execute(
            f"SELECT id, external_id, source, polyline_json, strava_id, avg_hr, max_hr, avg_cadence, avg_temp_c, elevation_loss, avg_power_w, device_name, raw_payload_json, distance_km, duration_min FROM activities WHERE sport_type = {p} AND start_date LIKE {p}",
            (sport, f"{d_day}%"),
        )
        for cand in _rows_to_dicts(cur, cur.fetchall()):
            c_dist = float(cand.get("distance_km") or 0)
            c_dur = float(cand.get("duration_min") or 0)
            dur_ok = abs(c_dur - dur_min) <= max(2.0, dur_min * 0.05)
            dist_ok = (dist_km == 0 and c_dist == 0) or (max(dist_km, c_dist) > 0 and abs(c_dist - dist_km) <= max(0.25, max(dist_km, c_dist) * 0.03))
            if dur_ok and dist_ok:
                return cand
    return None


def rebuild_daily_summaries(date_from: Optional[str] = None) -> int:
    """Rebuilds precomputed daily_summaries rollups from real activities in DB."""
    from datetime import datetime, timezone
    init_db()
    conn = _get_conn()
    cur = conn.cursor()
    p = _ph(conn)

    if date_from:
        cur.execute(
            f"SELECT start_date, sport_type, distance_km, duration_min, elevation_gain, elevation_loss, relative_effort FROM activities WHERE start_date >= {p}",
            (date_from,),
        )
    else:
        cur.execute("SELECT start_date, sport_type, distance_km, duration_min, elevation_gain, elevation_loss, relative_effort FROM activities")

    rows = _rows_to_dicts(cur, cur.fetchall())
    by_day: Dict[str, Dict[str, Any]] = {}
    for r in rows:
        d_str = (r.get("start_date") or "")[:10]
        if not d_str or len(d_str) < 10:
            continue
        agg = by_day.setdefault(d_str, {
            "run_km": 0.0, "bike_km": 0.0, "other_km": 0.0,
            "total_min": 0.0, "elevation_gain": 0.0, "elevation_loss": 0.0,
            "relative_effort": 0.0, "count": 0, "sports": {},
        })
        st = r.get("sport_type") or "Otro"
        dist = float(r.get("distance_km") or 0)
        dur = float(r.get("duration_min") or 0)
        eg = float(r.get("elevation_gain") or 0)
        el = float(r.get("elevation_loss") or 0)
        re = float(r.get("relative_effort") or 0)
        if st == "Carrera":
            agg["run_km"] += dist
        elif st == "Ciclismo":
            agg["bike_km"] += dist
        else:
            agg["other_km"] += dist
        agg["total_min"] += dur
        agg["elevation_gain"] += eg
        agg["elevation_loss"] += el
        agg["relative_effort"] += re
        agg["count"] += 1
        agg["sports"][st] = agg["sports"].get(st, 0) + 1

    now_iso = datetime.now(timezone.utc).isoformat()
    for d_str, agg in by_day.items():
        cur.execute(f"DELETE FROM daily_summaries WHERE date = {p}", (d_str,))
        cur.execute(
            f"""
            INSERT INTO daily_summaries
            (date, run_km, bike_km, other_km, total_min, elevation_gain, elevation_loss, relative_effort, activities_count, sports_json, updated_at)
            VALUES ({','.join([p]*11)})
            """,
            (
                d_str,
                round(agg["run_km"], 2),
                round(agg["bike_km"], 2),
                round(agg["other_km"], 2),
                round(agg["total_min"], 1),
                round(agg["elevation_gain"], 1),
                round(agg["elevation_loss"], 1),
                round(agg["relative_effort"], 1),
                agg["count"],
                json.dumps(agg["sports"]),
                now_iso,
            ),
        )
    conn.commit()
    conn.close()
    return len(by_day)


def upsert_activities(activities: List[Dict[str, Any]]) -> int:
    """Inserts new activities incrementally and enriches existing ones without overwriting user notes or Garmin metrics with Strava."""
    from datetime import datetime, timezone
    init_db()
    conn = _get_conn()
    cur = conn.cursor()
    p = _ph(conn)
    ftp = _get_ftp_from_conn(cur, p)
    inserted = 0
    touched = 0
    now_iso = datetime.now(timezone.utc).isoformat()

    for a in activities:
        ext_id = str(a.get("id") or a.get("external_id") or "")
        if not ext_id:
            continue

        sport = a.get("tipo", "Carrera")
        fecha = a.get("fecha", "")
        dist_km = float(a.get("distancia_km") or 0)
        dur_min = float(a.get("duracion_min") or a.get("duracion_minutos") or 0)
        elev_m = float(a.get("desnivel_m") or 0)
        elev_loss = float(a.get("desnivel_negativo_m") or a.get("elevation_loss") or 0)
        avg_hr = a.get("frecuencia_cardiaca_media")
        poly = a.get("polyline")
        strava_id = str(a.get("strava_id") or (ext_id if "strava" in str(a.get("fuente", "")).lower() else "") or "") or None
        incoming_source = a.get("fuente", "Garmin Connect")
        quality = validate_activity_record(a)
        raw_json = json.dumps(a.get("raw_payload") or {k: v for k, v in a.items() if k != "polyline"})

        existing = _find_duplicate_activity(cur, p, ext_id, strava_id, sport, fecha, dist_km, dur_min)
        if existing:
            # Incremental enrichment: never overwrite Garmin physiological metrics with Strava
            is_incoming_strava = "strava" in incoming_source.lower()
            is_existing_garmin = "garmin" in str(existing.get("source") or "").lower()
            updates = []
            params = []
            if strava_id and not existing.get("strava_id"):
                updates.append(f"strava_id = {p}")
                params.append(strava_id)
            if poly and not existing.get("polyline_json"):
                updates.append(f"polyline_json = {p}")
                params.append(json.dumps(poly))
            if not (is_incoming_strava and is_existing_garmin):
                for col, val in [
                    ("avg_cadence", a.get("cadencia_media") or a.get("avg_cadence")),
                    ("avg_temp_c", a.get("avg_temp_c")),
                    ("elevation_loss", elev_loss if elev_loss > 0 else None),
                    ("avg_power_w", a.get("avg_power_w")),
                    ("device_name", a.get("device_name")),
                ]:
                    if val is not None and existing.get(col) is None:
                        updates.append(f"{col} = {p}")
                        params.append(val)
                if not existing.get("raw_payload_json"):
                    updates.append(f"raw_payload_json = {p}")
                    params.append(raw_json)
            if updates:
                if not (is_incoming_strava and is_existing_garmin):
                    updates.append(f"data_quality_json = {p}")
                    params.append(json.dumps(quality))
                updates.append(f"updated_at = {p}")
                params.append(now_iso)
                params.append(existing["id"])
                cur.execute(f"UPDATE activities SET {', '.join(updates)} WHERE id = {p}", tuple(params))
                touched += 1
            continue

        rel_effort = compute_relative_effort(dur_min, hr_zones=None, rpe=None, avg_hr=avg_hr)
        phys = compute_cycling_and_vam_metrics(
            sport, dist_km, dur_min, elev_m, chart_series=None, ftp=ftp, existing_power_w=a.get("avg_power_w")
        )

        cur.execute(
            f"""
            INSERT INTO activities
            (external_id, source, sport_type, name, start_date, distance_km, duration_min,
             elevation_gain, elevation_loss, avg_hr, max_hr, calories, avg_pace_str, aerobic_te, polyline_json,
             relative_effort, rpe, avg_power_w, energy_kj, intensity_pct, vam_mh,
             moving_duration_min, elapsed_duration_min, avg_cadence, avg_temp_c, device_name, gear_id,
             description, private_notes, timezone, strava_id, raw_payload_json, data_quality_json, updated_at)
            VALUES ({','.join([p]*34)})
            """,
            (
                ext_id,
                incoming_source,
                sport,
                a.get("nombre", "Entrenamiento"),
                fecha,
                dist_km,
                dur_min,
                elev_m,
                elev_loss,
                avg_hr,
                a.get("frecuencia_cardiaca_max"),
                a.get("calorias") or a.get("calorias_activas"),
                a.get("ritmo_medio"),
                a.get("efecto_aerobico"),
                json.dumps(poly) if poly else None,
                rel_effort,
                None,
                phys["avg_power_w"],
                phys["energy_kj"],
                phys["intensity_pct"],
                phys["vam_mh"],
                a.get("moving_duration_min") or dur_min,
                a.get("elapsed_duration_min") or dur_min,
                a.get("cadencia_media") or a.get("avg_cadence"),
                a.get("avg_temp_c"),
                a.get("device_name") or "Garmin Connect",
                a.get("gear_id"),
                a.get("description") or "",
                a.get("private_notes") or "",
                a.get("timezone") or "Europe/Madrid",
                strava_id,
                raw_json,
                json.dumps(quality),
                now_iso,
            ),
        )
        if poly:
            _detect_segments_in_conn(cur, p, ext_id, sport, poly, dur_min, avg_hr, fecha)
        inserted += 1

    conn.commit()
    conn.close()

    if inserted > 0 or touched > 0:
        rebuild_daily_summaries()
        if inserted > 0:
            recalculate_gear_and_prs()
    return inserted


def save_activity_stream(
    external_id: str,
    polyline: Optional[List[List[float]]],
    splits: List[Dict[str, Any]],
    hr_zones: List[Dict[str, Any]],
    chart_series: Dict[str, Any],
    elevation_gain: float = 0.0,
) -> Optional[Dict[str, Any]]:
    init_db()
    conn = _get_conn()
    cur = conn.cursor()
    p = _ph(conn)

    if polyline is not None:
        cur.execute(
            f"UPDATE activities SET polyline_json = {p}, elevation_gain = CASE WHEN elevation_gain = 0 THEN {p} ELSE elevation_gain END WHERE external_id = {p}",
            (json.dumps(polyline), float(elevation_gain or 0), str(external_id)),
        )

    cur.execute(f"SELECT activity_id FROM activity_streams WHERE activity_id = {p}", (str(external_id),))
    if cur.fetchone():
        cur.execute(
            f"UPDATE activity_streams SET splits_json = {p}, hr_zones_json = {p}, chart_series_json = {p} WHERE activity_id = {p}",
            (json.dumps(splits), json.dumps(hr_zones), json.dumps(chart_series), str(external_id)),
        )
    else:
        cur.execute(
            f"INSERT INTO activity_streams (activity_id, splits_json, hr_zones_json, chart_series_json) VALUES ({p}, {p}, {p}, {p})",
            (str(external_id), json.dumps(splits), json.dumps(hr_zones), json.dumps(chart_series)),
        )

    # Recompute physiological metrics with real streams + detect segments
    cur.execute(f"SELECT * FROM activities WHERE external_id = {p}", (str(external_id),))
    act_rows = _rows_to_dicts(cur, cur.fetchall())
    act_result: Optional[Dict[str, Any]] = None
    if act_rows:
        act = act_rows[0]
        ftp = _get_ftp_from_conn(cur, p)
        dur_min = float(act.get("duration_min") or 0)
        rel_effort = compute_relative_effort(dur_min, hr_zones=hr_zones, rpe=act.get("rpe"), avg_hr=act.get("avg_hr"))
        phys = compute_cycling_and_vam_metrics(
            act.get("sport_type", "Carrera"),
            float(act.get("distance_km") or 0),
            dur_min,
            float(act.get("elevation_gain") or elevation_gain or 0),
            chart_series=chart_series,
            ftp=ftp,
            existing_power_w=act.get("avg_power_w"),
        )
        cur.execute(
            f"UPDATE activities SET relative_effort={p}, avg_power_w={p}, energy_kj={p}, intensity_pct={p}, vam_mh={p} WHERE external_id={p}",
            (rel_effort, phys["avg_power_w"], phys["energy_kj"], phys["intensity_pct"], phys["vam_mh"], str(external_id)),
        )
        if polyline:
            _detect_segments_in_conn(
                cur, p, str(external_id), act.get("sport_type", "Carrera"),
                polyline, dur_min, act.get("avg_hr"), act.get("start_date", ""), chart_series=chart_series
            )

        cur.execute(
            f"""
            SELECT se.*, s.name AS segment_name, s.distance_m
            FROM segment_efforts se
            JOIN segments s ON s.id = se.segment_id
            WHERE se.activity_id = {p}
            ORDER BY se.elapsed_sec ASC
            """,
            (str(external_id),),
        )
        seg_efforts = _rows_to_dicts(cur, cur.fetchall())
        for se in seg_efforts:
            sec = int(round(float(se.get("elapsed_sec") or 0)))
            se["elapsed_str"] = f"{sec // 60}:{sec % 60:02d}"

        act["relative_effort"] = rel_effort
        act.update(phys)
        act["polyline"] = polyline if polyline is not None else (json.loads(act["polyline_json"]) if act.get("polyline_json") else [])
        act["splits"] = splits
        act["hr_zones"] = hr_zones
        act["chart_series"] = chart_series
        act["segment_efforts"] = seg_efforts
        act_result = act

    conn.commit()
    conn.close()
    recalculate_gear_and_prs()
    return act_result


_ACT_COLS_NO_POLY = (
    "id, external_id, source, sport_type, name, start_date, distance_km, duration_min, "
    "elevation_gain, elevation_loss, avg_hr, max_hr, calories, avg_pace_str, aerobic_te, relative_effort, "
    "rpe, avg_power_w, energy_kj, intensity_pct, vam_mh, moving_duration_min, "
    "elapsed_duration_min, avg_cadence, avg_temp_c, device_name, gear_id, description, private_notes, "
    "timezone, strava_id, data_quality_json"
)


def get_activities_paginated(
    limit: int = 20,
    offset: int = 0,
    sport_type: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    include_polyline: bool = True,
) -> Dict[str, Any]:
    """Optimized paginated query with optional sport/date filters; never loads activity_streams."""
    init_db()
    conn = _get_conn()
    cur = conn.cursor()
    p = _ph(conn)

    clauses = []
    params: List[Any] = []
    if sport_type and sport_type not in ("Todo", "all", ""):
        clauses.append(f"sport_type = {p}")
        params.append(sport_type)
    if date_from:
        clauses.append(f"start_date >= {p}")
        params.append(date_from[:10])
    if date_to:
        clauses.append(f"start_date <= {p}")
        params.append(f"{date_to[:10]}Z")

    where_sql = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    cur.execute(f"SELECT COUNT(*) FROM activities {where_sql}", tuple(params))
    total_count = int(cur.fetchone()[0] or 0)

    cols = f"{_ACT_COLS_NO_POLY}, polyline_json" if include_polyline else _ACT_COLS_NO_POLY
    cur.execute(
        f"SELECT {cols} FROM activities {where_sql} ORDER BY start_date DESC LIMIT {p} OFFSET {p}",
        tuple(params + [limit, offset]),
    )
    rows = _rows_to_dicts(cur, cur.fetchall())
    conn.close()

    for r in rows:
        if include_polyline and r.get("polyline_json"):
            try:
                r["polyline"] = json.loads(r["polyline_json"])
            except Exception:
                r["polyline"] = []
        else:
            r["polyline"] = []
        r.pop("polyline_json", None)

    return {
        "activities": rows,
        "total_count": total_count,
        "has_more": (offset + len(rows)) < total_count,
        "limit": limit,
        "offset": offset,
    }


def get_daily_summaries(date_from: Optional[str] = None, date_to: Optional[str] = None) -> List[Dict[str, Any]]:
    """Returns precomputed daily rollups; auto-seeds from activities if empty."""
    init_db()
    conn = _get_conn()
    cur = conn.cursor()
    p = _ph(conn)
    cur.execute("SELECT COUNT(*) FROM daily_summaries")
    cnt = int(cur.fetchone()[0] or 0)
    if cnt == 0:
        cur.execute("SELECT COUNT(*) FROM activities")
        if int(cur.fetchone()[0] or 0) > 0:
            conn.close()
            rebuild_daily_summaries()
            conn = _get_conn()
            cur = conn.cursor()

    clauses = []
    params: List[Any] = []
    if date_from:
        clauses.append(f"date >= {p}")
        params.append(date_from[:10])
    if date_to:
        clauses.append(f"date <= {p}")
        params.append(date_to[:10])
    where_sql = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    cur.execute(f"SELECT * FROM daily_summaries {where_sql} ORDER BY date ASC", tuple(params))
    rows = _rows_to_dicts(cur, cur.fetchall())
    conn.close()
    return rows


def get_data_health_report() -> Dict[str, Any]:
    """Returns data integrity, source distribution, cache coverage, and anomaly counts."""
    init_db()
    conn = _get_conn()
    cur = conn.cursor()
    cur.execute("SELECT COUNT(*) FROM activities")
    total = int(cur.fetchone()[0] or 0)
    cur.execute("SELECT source, COUNT(*) FROM activities GROUP BY source")
    by_source = {str(r[0] or "Desconocida"): int(r[1]) for r in cur.fetchall()}
    cur.execute("SELECT COUNT(*) FROM activity_streams")
    streams_cached = int(cur.fetchone()[0] or 0)
    cur.execute("SELECT COUNT(*) FROM daily_summaries")
    summaries_days = int(cur.fetchone()[0] or 0)
    cur.execute("SELECT MIN(start_date), MAX(start_date) FROM activities")
    min_d, max_d = cur.fetchone()
    cur.execute("SELECT data_quality_json FROM activities WHERE data_quality_json IS NOT NULL")
    anomaly_counts: Dict[str, int] = {}
    for (dq_raw,) in cur.fetchall():
        try:
            dq = json.loads(dq_raw)
            for anom in dq.get("anomalies", []):
                anomaly_counts[anom] = anomaly_counts.get(anom, 0) + 1
        except Exception:
            pass
    conn.close()
    return {
        "activities_total": total,
        "by_source": by_source,
        "streams_cached": streams_cached,
        "daily_summaries_days": summaries_days,
        "date_range": {"min": min_d, "max": max_d},
        "anomalies": anomaly_counts,
    }


def get_all_activities(limit: int = 50, include_polyline: bool = True) -> List[Dict[str, Any]]:
    return get_activities_paginated(limit=limit, offset=0, include_polyline=include_polyline)["activities"]


def get_streamed_activity_ids() -> set:
    """Returns set of external_ids that already have cached streams in activity_streams."""
    init_db()
    conn = _get_conn()
    cur = conn.cursor()
    cur.execute("SELECT activity_id FROM activity_streams")
    ids = {str(row[0]) for row in cur.fetchall() if row[0]}
    conn.close()
    return ids


def get_activity_detail(external_id: str) -> Optional[Dict[str, Any]]:
    init_db()
    conn = _get_conn()
    cur = conn.cursor()
    p = _ph(conn)
    cur.execute(f"SELECT * FROM activities WHERE external_id = {p}", (str(external_id),))
    act_rows = _rows_to_dicts(cur, cur.fetchall())
    if not act_rows:
        conn.close()
        return None
    act = act_rows[0]
    act["polyline"] = json.loads(act["polyline_json"]) if act.get("polyline_json") else []

    cur.execute(f"SELECT * FROM activity_streams WHERE activity_id = {p}", (str(external_id),))
    st_rows = _rows_to_dicts(cur, cur.fetchall())

    cur.execute(
        f"""
        SELECT se.*, s.name AS segment_name, s.distance_m
        FROM segment_efforts se
        JOIN segments s ON s.id = se.segment_id
        WHERE se.activity_id = {p}
        ORDER BY se.elapsed_sec ASC
        """,
        (str(external_id),),
    )
    seg_efforts = _rows_to_dicts(cur, cur.fetchall())
    for se in seg_efforts:
        sec = int(round(float(se.get("elapsed_sec") or 0)))
        se["elapsed_str"] = f"{sec // 60}:{sec % 60:02d}"
    act["segment_efforts"] = seg_efforts

    conn.close()

    if st_rows:
        st = st_rows[0]
        act["splits"] = json.loads(st["splits_json"]) if st.get("splits_json") else []
        act["hr_zones"] = json.loads(st["hr_zones_json"]) if st.get("hr_zones_json") else []
        act["chart_series"] = json.loads(st["chart_series_json"]) if st.get("chart_series_json") else {}
    else:
        act["splits"] = []
        act["hr_zones"] = []
        act["chart_series"] = {}

    # Lazy-fill physiological metrics for pre-existing activities
    if act.get("relative_effort") is None:
        act["relative_effort"] = compute_relative_effort(
            float(act.get("duration_min") or 0),
            hr_zones=act["hr_zones"] or None,
            rpe=act.get("rpe"),
            avg_hr=act.get("avg_hr"),
        )
    if act.get("vam_mh") is None or (act.get("sport_type") == "Ciclismo" and act.get("avg_power_w") is None):
        ftp_str = get_setting("ftp")
        ftp = float(ftp_str) if ftp_str else 220.0
        phys = compute_cycling_and_vam_metrics(
            act.get("sport_type", "Carrera"),
            float(act.get("distance_km") or 0),
            float(act.get("duration_min") or 0),
            float(act.get("elevation_gain") or 0),
            chart_series=act["chart_series"] or None,
            ftp=ftp,
            existing_power_w=act.get("avg_power_w"),
        )
        for k, v in phys.items():
            if act.get(k) is None:
                act[k] = v
    return act


def _sliding_window_best_time_sec(chart_series: Dict[str, Any], target_km: float) -> Optional[float]:
    """Finds fastest sliding window elapsed seconds for target_km in chart_series."""
    dists = chart_series.get("dist_km") or []
    if len(dists) < 4:
        return None
    times = chart_series.get("time_sec") or []
    paces = chart_series.get("pace_sec") or []

    # Reconstruct cumulative time if time_sec is missing or incomplete
    cum_t: List[float] = []
    if len(times) == len(dists) and all(t is not None for t in times):
        cum_t = [float(t) for t in times]
    else:
        t_acc = 0.0
        cum_t.append(0.0)
        for i in range(1, len(dists)):
            dd = max(0.0, float(dists[i] or 0) - float(dists[i - 1] or 0))
            pace = float(paces[i]) if (i < len(paces) and paces[i]) else 330.0
            t_acc += dd * pace
            cum_t.append(t_acc)

    d_arr = [float(d or 0) for d in dists]
    if d_arr[-1] < target_km:
        return None

    best_sec: Optional[float] = None
    left = 0
    for right in range(1, len(d_arr)):
        while left < right and (d_arr[right] - d_arr[left]) >= target_km:
            span_d = d_arr[right] - d_arr[left]
            span_t = cum_t[right] - cum_t[left]
            if span_d > 0 and span_t > 0:
                # Linearly normalize exact target_km segment
                est = span_t * (target_km / span_d)
                if est > target_km * 120.0:  # Sanity floor: faster than 2:00/km is GPS glitch
                    if best_sec is None or est < best_sec:
                        best_sec = est
            left += 1
    return best_sec


def recalculate_gear_and_prs() -> None:
    """Recomputes active Gear km and GPS Personal Records (sliding window 1K, 5K, 10K, 21K, Bike) from DB."""
    conn = _get_conn()
    cur = conn.cursor()
    p = _ph(conn)

    cur.execute("SELECT external_id, name, sport_type, distance_km, duration_min, start_date FROM activities")
    acts = _rows_to_dicts(cur, cur.fetchall())

    cur.execute("SELECT activity_id, chart_series_json FROM activity_streams")
    stream_rows = _rows_to_dicts(cur, cur.fetchall())
    streams_by_id: Dict[str, Dict[str, Any]] = {}
    for sr in stream_rows:
        if sr.get("chart_series_json"):
            try:
                streams_by_id[str(sr["activity_id"])] = json.loads(sr["chart_series_json"])
            except Exception:
                pass

    cur.execute("SELECT * FROM gear WHERE active = 1")
    active_gear = _rows_to_dicts(cur, cur.fetchall())

    for g in active_gear:
        target_sport = "Carrera" if g.get("gear_type") == "shoes" else "Ciclismo"
        created_dt = (g.get("created_at") or "").strip()[:10]
        km_sum = sum(
            float(a["distance_km"] or 0)
            for a in acts
            if a.get("sport_type") == target_sport
            and (not created_dt or (a.get("start_date") or "")[:10] >= created_dt)
        )
        cur.execute(f"UPDATE gear SET logged_km = {p} WHERE id = {p}", (round(km_sum, 1), g["id"]))

    # Compute running GPS PRs using sliding window when chart_series exists, else global pace
    run_targets = [("1K", 1.0), ("5K", 5.0), ("10K", 10.0), ("21K", 21.1)]
    prs = []
    for label, target_km in run_targets:
        eligible = [
            a for a in acts
            if a["sport_type"] == "Carrera"
            and float(a["distance_km"] or 0) >= target_km
            and float(a["duration_min"] or 0) > 0
        ]
        if eligible:
            best_act = None
            best_sec = None
            for a in eligible:
                cs = streams_by_id.get(str(a["external_id"]))
                win_sec = _sliding_window_best_time_sec(cs, target_km) if cs else None
                est_sec = win_sec if win_sec is not None else ((float(a["duration_min"]) * 60.0) / float(a["distance_km"])) * target_km
                if best_sec is None or est_sec < best_sec:
                    best_sec = est_sec
                    best_act = a
            if best_act and best_sec is not None:
                m = int(best_sec // 60)
                s = int(best_sec % 60)
                h = m // 60
                val_str = f"{h}:{m%60:02d}:{s:02d}" if h > 0 else f"{m}:{s:02d}"
                prs.append((label, f"Mejor {label}", val_str, round(best_sec, 1), best_act["external_id"], best_act["name"], best_act["start_date"]))

    bikes = [a for a in acts if a["sport_type"] == "Ciclismo" and float(a["distance_km"] or 0) > 0]
    if bikes:
        best_dist = max(bikes, key=lambda a: float(a["distance_km"] or 0))
        prs.append(("BIKE_DIST", "Mayor Distancia Bici", f"{best_dist['distance_km']} km", float(best_dist["distance_km"]), best_dist["external_id"], best_dist["name"], best_dist["start_date"]))
        best_speed = max(bikes, key=lambda a: (float(a["distance_km"]) / (float(a["duration_min"]) / 60.0)) if float(a["duration_min"] or 0) > 0 else 0)
        spd = float(best_speed["distance_km"]) / (float(best_speed["duration_min"]) / 60.0)
        prs.append(("BIKE_SPD", "Mejor Media Bici", f"{spd:.1f} km/h", round(spd, 2), best_speed["external_id"], best_speed["name"], best_speed["start_date"]))

    for cat, lbl, val, sec, aid, aname, dt in prs:
        cur.execute(f"SELECT category, COALESCE(is_official, 0) FROM personal_records WHERE category = {p}", (cat,))
        row = cur.fetchone()
        if row:
            if int(row[1] or 0) == 0:
                cur.execute(
                    f"UPDATE personal_records SET label={p}, best_value={p}, best_seconds={p}, activity_id={p}, activity_name={p}, achieved_date={p}, is_official=0 WHERE category={p}",
                    (lbl, val, sec, aid, aname, dt, cat),
                )
        else:
            cur.execute(
                f"INSERT INTO personal_records (category, label, best_value, best_seconds, activity_id, activity_name, achieved_date, is_official) VALUES ({','.join([p]*8)})",
                (cat, lbl, val, sec, aid, aname, dt, 0),
            )

    conn.commit()
    conn.close()


def update_activity_metadata(
    external_id: str,
    description: Optional[str] = None,
    private_notes: Optional[str] = None,
    gear_id: Optional[int] = None,
) -> Optional[Dict[str, Any]]:
    """Updates editable Strava-style activity metadata (description, private_notes, gear_id)."""
    init_db()
    conn = _get_conn()
    cur = conn.cursor()
    p = _ph(conn)

    sets = []
    vals: List[Any] = []
    if description is not None:
        sets.append(f"description = {p}")
        vals.append(description)
    if private_notes is not None:
        sets.append(f"private_notes = {p}")
        vals.append(private_notes)
    if gear_id is not None:
        sets.append(f"gear_id = {p}")
        vals.append(int(gear_id) if gear_id > 0 else None)

    if sets:
        vals.append(str(external_id))
        cur.execute(f"UPDATE activities SET {', '.join(sets)} WHERE external_id = {p}", tuple(vals))
        conn.commit()
    conn.close()
    return get_activity_detail(external_id)


def update_activity_rpe(external_id: str, rpe: int) -> Optional[Dict[str, Any]]:
    """Stores RPE (1-10) and recalculates relative_effort when HR zones are absent (or updates RPE)."""
    init_db()
    conn = _get_conn()
    cur = conn.cursor()
    p = _ph(conn)

    cur.execute(f"SELECT * FROM activities WHERE external_id = {p}", (str(external_id),))
    rows = _rows_to_dicts(cur, cur.fetchall())
    if not rows:
        conn.close()
        return None
    act = rows[0]

    cur.execute(f"SELECT hr_zones_json FROM activity_streams WHERE activity_id = {p}", (str(external_id),))
    st = cur.fetchone()
    hr_zones = json.loads(st[0]) if (st and st[0]) else None

    dur_min = float(act.get("duration_min") or 0)
    # Use RPE formula if no HR zones exist, or if user explicitly overrides via RPE when no HR stream
    if hr_zones and sum(float(z.get("pct") or 0) for z in hr_zones) > 0:
        rel_effort = compute_relative_effort(dur_min, hr_zones=hr_zones, rpe=rpe, avg_hr=act.get("avg_hr"))
    else:
        rel_effort = compute_relative_effort(dur_min, hr_zones=None, rpe=rpe, avg_hr=None)

    cur.execute(
        f"UPDATE activities SET rpe = {p}, relative_effort = {p} WHERE external_id = {p}",
        (int(rpe), rel_effort, str(external_id)),
    )
    conn.commit()
    conn.close()
    return {"external_id": external_id, "rpe": int(rpe), "relative_effort": rel_effort}


def upsert_official_pr(category: str, label: str, best_value: str, achieved_date: str = "") -> List[Dict[str, Any]]:
    """Creates or updates a manual Official Personal Record (is_official = 1)."""
    init_db()
    conn = _get_conn()
    cur = conn.cursor()
    p = _ph(conn)
    cat_key = f"OFFICIAL_{category.strip().upper().replace(' ', '_')}"
    dt = achieved_date.strip() or date.today().isoformat()

    cur.execute(f"SELECT category FROM personal_records WHERE category = {p}", (cat_key,))
    if cur.fetchone():
        cur.execute(
            f"UPDATE personal_records SET label={p}, best_value={p}, achieved_date={p}, is_official=1 WHERE category={p}",
            (label.strip(), best_value.strip(), dt, cat_key),
        )
    else:
        cur.execute(
            f"INSERT INTO personal_records (category, label, best_value, best_seconds, activity_id, activity_name, achieved_date, is_official) VALUES ({','.join([p]*8)})",
            (cat_key, label.strip(), best_value.strip(), None, "", "Marca Oficial", dt, 1),
        )
    conn.commit()
    conn.close()
    return get_personal_records()


def create_segment(
    name: str,
    sport_type: str,
    start_lat: float,
    start_lon: float,
    end_lat: float,
    end_lon: float,
    distance_m: float = 0.0,
    elevation_gain: float = 0.0,
) -> Dict[str, Any]:
    """Creates a custom segment and scans existing activities with polylines for efforts."""
    init_db()
    conn = _get_conn()
    cur = conn.cursor()
    p = _ph(conn)
    dist = float(distance_m or 0) or round(haversine_m(start_lat, start_lon, end_lat, end_lon), 1)

    cur.execute(
        f"INSERT INTO segments (name, sport_type, start_lat, start_lon, end_lat, end_lon, distance_m, elevation_gain) VALUES ({','.join([p]*8)})",
        (name.strip(), sport_type, float(start_lat), float(start_lon), float(end_lat), float(end_lon), dist, float(elevation_gain or 0)),
    )
    conn.commit()

    # Scan existing activities with polylines so historical efforts appear immediately
    cur.execute(f"SELECT * FROM activities WHERE sport_type = {p} AND polyline_json IS NOT NULL", (sport_type,))
    acts = _rows_to_dicts(cur, cur.fetchall())
    for a in acts:
        try:
            poly = json.loads(a["polyline_json"])
        except Exception:
            poly = []
        if poly:
            _detect_segments_in_conn(
                cur, p, a["external_id"], sport_type, poly,
                float(a.get("duration_min") or 0), a.get("avg_hr"), a.get("start_date", "")
            )
    conn.commit()
    conn.close()
    return {"status": "ok", "name": name.strip()}


def get_segments_with_efforts() -> List[Dict[str, Any]]:
    """Returns all saved segments along with their historical efforts sorted fastest-first."""
    init_db()
    conn = _get_conn()
    cur = conn.cursor()
    p = _ph(conn)
    cur.execute("SELECT * FROM segments ORDER BY id DESC")
    segs = _rows_to_dicts(cur, cur.fetchall())
    for seg in segs:
        cur.execute(
            f"""
            SELECT se.*, a.name AS activity_name
            FROM segment_efforts se
            LEFT JOIN activities a ON a.external_id = se.activity_id
            WHERE se.segment_id = {p}
            ORDER BY se.elapsed_sec ASC
            """,
            (seg["id"],),
        )
        efforts = _rows_to_dicts(cur, cur.fetchall())
        for e in efforts:
            sec = int(round(float(e.get("elapsed_sec") or 0)))
            m, s = sec // 60, sec % 60
            e["elapsed_str"] = f"{m}:{s:02d}"
        seg["efforts"] = efforts
        seg["best_effort"] = efforts[0] if efforts else None
    conn.close()
    return segs


def get_personal_records() -> List[Dict[str, Any]]:
    init_db()
    conn = _get_conn()
    cur = conn.cursor()
    cur.execute("SELECT * FROM personal_records")
    rows = _rows_to_dicts(cur, cur.fetchall())
    conn.close()
    return rows


def get_gear_list() -> List[Dict[str, Any]]:
    init_db()
    conn = _get_conn()
    cur = conn.cursor()
    cur.execute("SELECT * FROM gear ORDER BY id ASC")
    rows = _rows_to_dicts(cur, cur.fetchall())
    conn.close()
    for r in rows:
        r["total_km"] = round(float(r.get("initial_km") or 0) + float(r.get("logged_km") or 0), 1)
    return rows


def add_or_update_gear(name: str, gear_type: str, brand: str, initial_km: float, alert_km: float) -> List[Dict[str, Any]]:
    init_db()
    conn = _get_conn()
    cur = conn.cursor()
    p = _ph(conn)
    today_str = date.today().isoformat()
    cur.execute(
        f"INSERT INTO gear (name, gear_type, brand, initial_km, logged_km, alert_km, active, created_at) VALUES ({','.join([p]*8)})",
        (name, gear_type, brand, float(initial_km), 0.0, float(alert_km), 1, today_str),
    )
    conn.commit()
    conn.close()
    recalculate_gear_and_prs()
    return get_gear_list()


def get_setting(key: str) -> Optional[str]:
    init_db()
    conn = _get_conn()
    cur = conn.cursor()
    p = _ph(conn)
    cur.execute(f"SELECT value FROM app_settings WHERE key = {p}", (key,))
    row = cur.fetchone()
    conn.close()
    return row[0] if row else None


def set_setting(key: str, value: str) -> None:
    init_db()
    conn = _get_conn()
    cur = conn.cursor()
    p = _ph(conn)
    cur.execute(f"SELECT key FROM app_settings WHERE key = {p}", (key,))
    if cur.fetchone():
        cur.execute(f"UPDATE app_settings SET value = {p} WHERE key = {p}", (value, key))
    else:
        cur.execute(f"INSERT INTO app_settings (key, value) VALUES ({p}, {p})", (key, value))
    conn.commit()
    conn.close()
