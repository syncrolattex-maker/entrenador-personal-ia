#!/usr/bin/env python3
"""
scripts/backfill_garmin.py — Controlled, idempotent, resumable Garmin historical backfill.
Fetches activities in batches of 50 with retries and rate-limit pauses,
validates and deduplicates into PostgreSQL, and updates daily_summaries.
Does NOT download full GPS streams unnecessarily.
"""
from dotenv import load_dotenv
load_dotenv()

import json
import sys
import time
from pathlib import Path
from typing import Dict, Any, List

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import database
import garmin_client


def _fetch_batch_with_retry(limit: int, start: int, max_retries: int = 3) -> List[dict]:
    for attempt in range(max_retries):
        try:
            batch = garmin_client.get_garmin_history(limit=limit, start=start)
            return batch
        except Exception as e:
            wait_s = 2 ** (attempt + 1)
            print(f"[Backfill] Retry {attempt + 1}/{max_retries} at start={start} after error: {e} (wait {wait_s}s)")
            time.sleep(wait_s)
    return []


def run_backfill(batch_size: int = 50, max_batches: int = 10, reset_cursor: bool = False) -> Dict[str, Any]:
    if not database.is_postgres_active():
        raise RuntimeError("PostgreSQL is not active. Aborting backfill to avoid SQLite fallback.")
    if not garmin_client.is_garmin_connected():
        raise RuntimeError("Garmin Connect is not connected.")

    database.init_db()

    state_raw = database.get_setting("garmin_backfill_state")
    state = json.loads(state_raw) if (state_raw and not reset_cursor) else {}
    start_offset = int(state.get("next_offset") or 0)

    conn = database._get_conn()
    cur = conn.cursor()
    cur.execute("SELECT external_id FROM activities")
    existing_before = {str(r[0]) for r in cur.fetchall()}
    conn.close()

    total_fetched = 0
    total_inserted = 0
    total_duplicates = 0
    total_discarded = 0
    errors: List[str] = []

    current_offset = start_offset
    for b in range(max_batches):
        print(f"[Backfill] Fetching batch {b + 1}/{max_batches} (start={current_offset}, limit={batch_size})...")
        batch = _fetch_batch_with_retry(limit=batch_size, start=current_offset)
        if not batch:
            print(f"[Backfill] Empty batch at start={current_offset}; historical end reached.")
            break

        total_fetched += len(batch)
        valid_batch = [a for a in batch if a.get("id") and a.get("fecha")]
        total_discarded += len(batch) - len(valid_batch)

        try:
            ins = database.upsert_activities(valid_batch)
            total_inserted += ins
            total_duplicates += max(0, len(valid_batch) - ins)
        except Exception as e:
            err_msg = f"Batch start={current_offset} upsert error: {e}"
            print(f"[Backfill] ERROR: {err_msg}")
            errors.append(err_msg)

        current_offset += len(batch)
        database.set_setting(
            "garmin_backfill_state",
            json.dumps({
                "next_offset": current_offset,
                "last_run_fetched": total_fetched,
                "last_run_inserted": total_inserted,
                "completed": len(batch) < batch_size,
            }),
        )

        if len(batch) < batch_size:
            print("[Backfill] Reached end of available Garmin history.")
            break
        time.sleep(1.0)

    # Ensure daily_summaries is 100% synchronized
    ds_days = database.rebuild_daily_summaries()
    health = database.get_data_health_report()

    report = {
        "started_from_offset": start_offset,
        "next_offset": current_offset,
        "existing_before": len(existing_before),
        "fetched": total_fetched,
        "inserted_new": total_inserted,
        "duplicates_or_updated": total_duplicates,
        "discarded_invalid": total_discarded,
        "errors": errors,
        "health_after": health,
        "daily_summaries_rebuilt_days": ds_days,
    }
    return report


if __name__ == "__main__":
    reset = "--reset" in sys.argv
    rep = run_backfill(batch_size=50, max_batches=10, reset_cursor=reset)
    print("BACKFILL_REPORT:", json.dumps(rep, ensure_ascii=False, indent=2))
