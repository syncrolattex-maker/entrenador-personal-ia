"""
perf_monitor.py — Lightweight request-scoped performance instrumentation (Phase 5.3).
Tracks timings in milliseconds per request without logging tokens, passwords, or PII.
"""
import contextvars
import json
import time
import uuid
from contextlib import contextmanager
from typing import Any, Dict, Optional

_PERF_CTX: contextvars.ContextVar[Optional[Dict[str, Any]]] = contextvars.ContextVar(
    "aaronfit_perf_ctx", default=None
)


def start_request_perf(endpoint: str, method: str = "GET") -> Dict[str, Any]:
    ctx: Dict[str, Any] = {
        "request_id": uuid.uuid4().hex[:8],
        "endpoint": endpoint,
        "method": method,
        "start_ts": time.perf_counter(),
        "db_connect_ms": 0.0,
        "db_connect_count": 0,
        "db_reused_count": 0,
        "sql_ms": 0.0,
        "sql_count": 0,
        "analytics_ms": 0.0,
        "garmin_ms": 0.0,
        "gemini_ms": 0.0,
        "serialize_ms": 0.0,
        "cache_hit": False,
    }
    _PERF_CTX.set(ctx)
    return ctx


def get_perf_ctx() -> Optional[Dict[str, Any]]:
    return _PERF_CTX.get()


def add_metric(key: str, duration_ms: float, count_key: Optional[str] = None) -> None:
    ctx = _PERF_CTX.get()
    if ctx is None:
        return
    ctx[key] = float(ctx.get(key, 0.0)) + float(duration_ms)
    if count_key:
        ctx[count_key] = int(ctx.get(count_key, 0)) + 1


def inc_counter(key: str, delta: int = 1) -> None:
    ctx = _PERF_CTX.get()
    if ctx is None:
        return
    ctx[key] = int(ctx.get(key, 0)) + delta


def mark_cache_hit(hit: bool = True) -> None:
    ctx = _PERF_CTX.get()
    if ctx is not None:
        ctx["cache_hit"] = bool(hit)


@contextmanager
def measure_stage(metric_key: str, count_key: Optional[str] = None):
    t0 = time.perf_counter()
    try:
        yield
    finally:
        dt_ms = (time.perf_counter() - t0) * 1000.0
        add_metric(metric_key, dt_ms, count_key=count_key)


def finish_request_perf(status_code: int = 200) -> Optional[Dict[str, Any]]:
    ctx = _PERF_CTX.get()
    if ctx is None:
        return None
    total_ms = (time.perf_counter() - ctx["start_ts"]) * 1000.0
    summary = {
        "request_id": ctx["request_id"],
        "method": ctx["method"],
        "endpoint": ctx["endpoint"],
        "status": status_code,
        "total_ms": round(total_ms, 2),
        "db_connect_ms": round(ctx["db_connect_ms"], 2),
        "db_connect_count": ctx["db_connect_count"],
        "db_reused_count": ctx["db_reused_count"],
        "sql_ms": round(ctx["sql_ms"], 2),
        "sql_count": ctx["sql_count"],
        "analytics_ms": round(ctx["analytics_ms"], 2),
        "garmin_ms": round(ctx["garmin_ms"], 2),
        "gemini_ms": round(ctx["gemini_ms"], 2),
        "serialize_ms": round(ctx["serialize_ms"], 2),
        "cache_hit": ctx["cache_hit"],
    }
    _PERF_CTX.set(None)
    return summary


def format_server_timing(summary: Dict[str, Any]) -> str:
    parts = [
        f"total;dur={summary.get('total_ms', 0)}",
        f"db_conn;dur={summary.get('db_connect_ms', 0)}",
        f"sql;dur={summary.get('sql_ms', 0)}",
    ]
    if summary.get("analytics_ms"):
        parts.append(f"analytics;dur={summary['analytics_ms']}")
    if summary.get("garmin_ms"):
        parts.append(f"garmin;dur={summary['garmin_ms']}")
    if summary.get("gemini_ms"):
        parts.append(f"gemini;dur={summary['gemini_ms']}")
    return ", ".join(parts)


def log_perf_summary(summary: Optional[Dict[str, Any]]) -> None:
    if not summary:
        return
    try:
        print(f"[PERF] {json.dumps(summary, ensure_ascii=False)}")
    except Exception:
        pass
