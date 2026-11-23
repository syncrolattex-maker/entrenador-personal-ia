import os
import json
import sqlite3
from datetime import date
from pathlib import Path
from typing import List, Dict, Any, Optional

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


def init_db() -> None:
    """Creates the 4 core tables: activities, activity_streams, personal_records, gear."""
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
            polyline_json TEXT
        )
    """)

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


def _ph(conn) -> str:
    return "?" if isinstance(conn, sqlite3.Connection) else "%s"


def _rows_to_dicts(cur, rows) -> List[Dict[str, Any]]:
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, r)) for r in rows]


def upsert_activities(activities: List[Dict[str, Any]]) -> int:
    """Inserts new activities incrementally; returns count of newly inserted records."""
    init_db()
    conn = _get_conn()
    cur = conn.cursor()
    p = _ph(conn)
    inserted = 0

    for a in activities:
        ext_id = str(a.get("id") or a.get("external_id") or "")
        if not ext_id:
            continue

        cur.execute(f"SELECT id FROM activities WHERE external_id = {p}", (ext_id,))
        exists = cur.fetchone()
        if exists:
            continue

        cur.execute(
            f"""
            INSERT INTO activities
            (external_id, source, sport_type, name, start_date, distance_km, duration_min,
             elevation_gain, avg_hr, max_hr, calories, avg_pace_str, aerobic_te, polyline_json)
            VALUES ({','.join([p]*14)})
            """,
            (
                ext_id,
                a.get("fuente", "Garmin Connect"),
                a.get("tipo", "Carrera"),
                a.get("nombre", "Entrenamiento"),
                a.get("fecha", ""),
                float(a.get("distancia_km") or 0),
                float(a.get("duracion_min") or a.get("duracion_minutos") or 0),
                float(a.get("desnivel_m") or 0),
                a.get("frecuencia_cardiaca_media"),
                a.get("frecuencia_cardiaca_max"),
                a.get("calorias") or a.get("calorias_activas"),
                a.get("ritmo_medio"),
                a.get("efecto_aerobico"),
                json.dumps(a.get("polyline")) if a.get("polyline") else None,
            ),
        )
        inserted += 1

    conn.commit()
    conn.close()

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
) -> None:
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

    conn.commit()
    conn.close()


def get_all_activities(limit: int = 50) -> List[Dict[str, Any]]:
    init_db()
    conn = _get_conn()
    cur = conn.cursor()
    p = _ph(conn)
    cur.execute(f"SELECT * FROM activities ORDER BY start_date DESC LIMIT {p}", (limit,))
    rows = _rows_to_dicts(cur, cur.fetchall())
    conn.close()

    for r in rows:
        if r.get("polyline_json"):
            try:
                r["polyline"] = json.loads(r["polyline_json"])
            except Exception:
                r["polyline"] = []
        else:
            r["polyline"] = []
    return rows


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
    return act


def recalculate_gear_and_prs() -> None:
    """Recomputes active Gear km and Personal Records (1K, 5K, 10K, 21K, Bike) from DB."""
    conn = _get_conn()
    cur = conn.cursor()
    p = _ph(conn)

    cur.execute("SELECT * FROM activities")
    acts = _rows_to_dicts(cur, cur.fetchall())

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

    # Compute running PR estimates (for distances reached) & cycling max distance/elevation
    run_targets = [("1K", 1.0), ("5K", 5.0), ("10K", 10.0), ("21K", 21.1)]
    prs = []
    for label, target_km in run_targets:
        eligible = [a for a in acts if a["sport_type"] == "Carrera" and float(a["distance_km"] or 0) >= target_km and float(a["duration_min"] or 0) > 0]
        if eligible:
            # Fastest pace activity >= target_km
            best = min(eligible, key=lambda a: (float(a["duration_min"]) * 60.0) / float(a["distance_km"]))
            pace_sec = (float(best["duration_min"]) * 60.0) / float(best["distance_km"])
            est_sec = pace_sec * target_km
            m = int(est_sec // 60)
            s = int(est_sec % 60)
            h = m // 60
            val_str = f"{h}:{m%60:02d}:{s:02d}" if h > 0 else f"{m}:{s:02d}"
            prs.append((label, f"Mejor {label}", val_str, est_sec, best["external_id"], best["name"], best["start_date"]))

    bikes = [a for a in acts if a["sport_type"] == "Ciclismo" and float(a["distance_km"] or 0) > 0]
    if bikes:
        best_dist = max(bikes, key=lambda a: float(a["distance_km"] or 0))
        prs.append(("BIKE_DIST", "Mayor Distancia Bici", f"{best_dist['distance_km']} km", float(best_dist["distance_km"]), best_dist["external_id"], best_dist["name"], best_dist["start_date"]))
        best_speed = max(bikes, key=lambda a: (float(a["distance_km"]) / (float(a["duration_min"]) / 60.0)) if float(a["duration_min"] or 0) > 0 else 0)
        spd = float(best_speed["distance_km"]) / (float(best_speed["duration_min"]) / 60.0)
        prs.append(("BIKE_SPD", "Mejor Media Bici", f"{spd:.1f} km/h", spd, best_speed["external_id"], best_speed["name"], best_speed["start_date"]))

    for cat, lbl, val, sec, aid, aname, dt in prs:
        cur.execute(f"SELECT category FROM personal_records WHERE category = {p}", (cat,))
        if cur.fetchone():
            cur.execute(
                f"UPDATE personal_records SET label={p}, best_value={p}, best_seconds={p}, activity_id={p}, activity_name={p}, achieved_date={p} WHERE category={p}",
                (lbl, val, sec, aid, aname, dt, cat),
            )
        else:
            cur.execute(
                f"INSERT INTO personal_records (category, label, best_value, best_seconds, activity_id, activity_name, achieved_date) VALUES ({','.join([p]*7)})",
                (cat, lbl, val, sec, aid, aname, dt),
            )

    conn.commit()
    conn.close()


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
