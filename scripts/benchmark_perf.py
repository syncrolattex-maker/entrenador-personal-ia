"""
scripts/benchmark_perf.py — Production/Local performance benchmark using Server-Timing headers.
Usage:
    python scripts/benchmark_perf.py [BASE_URL]
Default BASE_URL: https://entrenador-personal-ia-six.vercel.app
"""
import statistics
import sys
import time
import requests

BASE_URL = (sys.argv[1] if len(sys.argv) > 1 else "https://entrenador-personal-ia-six.vercel.app").rstrip("/")

ENDPOINTS = [
    "/api/dashboard/summary",
    "/api/garmin/status",
    "/api/activities?limit=15&offset=0",
    "/api/wellness/today",
    "/api/wellness/history?days=28",
    "/api/analytics/summit",
    "/api/analytics/overview?days=730",
    "/api/analytics/ai-interpretation?days=730",
    "/recomendacion-hoy",
]


def run_benchmark(runs: int = 5) -> None:
    print(f"Benchmarking {BASE_URL} ({runs} runs per endpoint)...\n")
    for ep in ENDPOINTS:
        times = []
        sizes = []
        timings = []
        vercel_ids = set()
        statuses = set()
        for i in range(runs):
            t0 = time.perf_counter()
            try:
                r = requests.get(f"{BASE_URL}{ep}", timeout=30)
                dt = (time.perf_counter() - t0) * 1000.0
                times.append(dt)
                sizes.append(len(r.content))
                statuses.add(r.status_code)
                if "x-vercel-id" in r.headers:
                    vercel_ids.add(r.headers["x-vercel-id"].split("-")[0])
                if i in (0, 1):
                    timings.append(f"run{i+1}: {r.headers.get('Server-Timing', 'n/a')}")
            except Exception as exc:
                dt = (time.perf_counter() - t0) * 1000.0
                times.append(dt)
                statuses.add(type(exc).__name__)

        p50 = statistics.median(times)
        p95 = sorted(times)[min(len(times) - 1, int(0.95 * len(times)))]
        mean = statistics.mean(times)
        sz = sizes[0] if sizes else 0
        print(
            f"{ep:42s} | status={list(statuses)} | 1st={times[0]:7.1f}ms | "
            f"P50={p50:7.1f}ms | P95={p95:7.1f}ms | Mean={mean:7.1f}ms | {sz:6d} B"
        )
        for t in timings:
            print(f"   Server-Timing ({t})")
        if vercel_ids:
            print(f"   Vercel POP/Region: {', '.join(sorted(vercel_ids))}")


if __name__ == "__main__":
    run_benchmark()
