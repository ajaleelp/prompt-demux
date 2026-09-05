"""Benchmark + sanity-check the classifier on fp32 vs int8 ONNX variants."""

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from classifier import QueryComplexityClassifier

MODEL_DIR = Path(__file__).parent.parent / "model"

SAMPLES = [
    # EASY
    "Hello",
    "What time is it?",
    "Explain this error briefly",
    # MEDIUM
    "Write a function to parse JSON",
    "Explain closures in JavaScript",
    # HARD
    "Design a microservices architecture",
    "Implement a distributed consensus algorithm",
    "Refactor this legacy monolith into event-driven services with exactly-once guarantees",
]


def bench(quantized: bool):
    variant = "int8-quantized" if quantized else "fp32"
    print(f"\n=== {variant} ===")
    clf = QueryComplexityClassifier(str(MODEL_DIR), quantized=quantized, warmup=True)

    for q in SAMPLES:
        r = clf.classify(q)
        print(
            f"[{r['tier']:<6}] conf={r['confidence']:.3f} "
            f"scores={ {k: round(v, 2) for k, v in r['raw_scores'].items()} } "
            f"{r['latency_ms']:.0f}ms | {q[:60]}"
        )

    times = []
    for _ in range(10):
        t0 = time.perf_counter()
        clf.classify("Write a thread-safe LRU cache with expiry support")
        times.append((time.perf_counter() - t0) * 1000)
    times.sort()
    print(
        f"latency over 10 runs -> min {times[0]:.0f}ms / "
        f"median {times[len(times)//2]:.0f}ms / max {times[-1]:.0f}ms"
    )


if __name__ == "__main__":
    bench(quantized=True)
    bench(quantized=False)
