"""Accuracy benchmark: how much quality do we lose going lighter?

Compares, on a labeled 3-class set:
  - fp32 ModernBERT (571MB)   - current / reference
  - int8 ModernBERT (144MB)   - the "lighter upgrade"
  - heuristic baseline        - zero-cost fallback (for reference on how
                                badly a pure-heuristic-only version would do)

Reports exact-match accuracy, per-tier precision/recall, confidence deltas,
and where the lighter options flip a label vs fp32 (the real cost: a user's
prompt getting dialed to a wrong effort tier).
"""

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "opencode-plugin" / "src"))

from classifier import QueryComplexityClassifier

MODEL_DIR = Path(__file__).parent.parent / "model"

# Ground truth: (query, expected tier)
LABELED = [
    # --- EASY ---
    ("Hello", "EASY"),
    ("thanks!", "EASY"),
    ("What time is it?", "EASY"),
    ("ok", "EASY"),
    ("Explain this error briefly", "EASY"),
    ("summarize this in one line", "EASY"),
    ("continue", "EASY"),
    ("what does this function do?", "EASY"),
    ("rename this variable", "EASY"),
    ("looks good, ship it", "EASY"),
    # --- MEDIUM ---
    ("Write a function to parse JSON", "MEDIUM"),
    ("Explain closures in JavaScript", "MEDIUM"),
    ("Add error handling to this HTTP client", "MEDIUM"),
    ("Refactor this function to use async/await", "MEDIUM"),
    ("Write a SQL query with a join", "MEDIUM"),
    ("Fix this TypeScript type error", "MEDIUM"),
    ("Add tests for the login module", "MEDIUM"),
    ("Optimize this database query", "MEDIUM"),
    ("Implement a simple caching layer", "MEDIUM"),
    ("What does this regex do?", "MEDIUM"),
    # --- HARD ---
    ("Design a microservices architecture", "HARD"),
    ("Implement a distributed consensus algorithm", "HARD"),
    ("Refactor this legacy monolith into event-driven services with exactly-once guarantees", "HARD"),
    ("Design a system that scales to 10M concurrent users", "HARD"),
    ("Implement a Byzantine-fault-tolerance protocol", "HARD"),
    ("Build a distributed transaction coordinator", "HARD"),
    ("Design a low-latency trading system with replay", "HARD"),
    ("Implement vector-clock based conflict resolution", "HARD"),
    ("Design a consensus protocol that tolerates partial partitions", "HARD"),
    ("Build an eventually-consistent system across regions", "HARD"),
]

TIERS = ["EASY", "MEDIUM", "HARD"]


def run(clf) -> tuple:
    """Return (predictions: list of tier, confidences: dict tier->list, times)."""
    preds, confs, times = [], {t: [] for t in TIERS}, []
    for q, truth in LABELED:
        t0 = time.perf_counter()
        r = clf.classify(q)
        times.append((time.perf_counter() - t0) * 1000)
        preds.append(r["tier"])
        confs[truth].append(r["confidence"])
    return preds, confs, times


def report(name, preds, confs, times):
    exact = sum(1 for (_, t), p in zip(LABELED, preds) if t == p)
    acc = exact / len(LABELED) * 100
    print(f"\n### {name}")
    print(f"  accuracy (exact tier match): {acc:.1f}% ({exact}/{len(LABELED)})")
    print(f"  median latency: {sorted(times)[len(times)//2]:.0f}ms  (first/total)")

    # confusion matrix
    print("  confusion (rows=truth, cols=pred):")
    print("    ", "".join(f"{t:>9}" for t in TIERS))
    for t in TIERS:
        row = [sum(1 for (_, truth), p in zip(LABELED, preds) if truth == t and p == c) for c in TIERS]
        print(f"    {t:>4}", "".join(f"{n:>9}" for n in row))

    # precision/recall per tier
    for t in TIERS:
        tp = sum(1 for (_, truth), p in zip(LABELED, preds) if truth == t and p == t)
        fp = sum(1 for (_, truth), p in zip(LABELED, preds) if truth != t and p == t)
        fn = sum(1 for (_, truth), p in zip(LABELED, preds) if truth == t and p != t)
        prec = tp / (tp + fp) * 100 if tp + fp else 0
        rec = tp / (tp + fn) * 100 if tp + fn else 0
        print(f"    {t}: prec {prec:4.0f}%  rec {rec:4.0f}%  (n={sum(1 for _,tr in LABELED if tr==t)})")

    return acc


def heuristic_tier(q: str) -> str:
    """Cheap stand-in for the plugin's zero-cost heuristic fallback."""
    ql = q.lower().strip()
    short_greet = len(q) <= 40 and any(
        g in ql for g in ["hello", "thanks", "ok", "hi ", "continue", "it?", "ok", "ship it"]
    )
    if short_greet:
        return "EASY"
    long_complex = len(q) > 60 and any(
        w in q for w in ["consensus", "microservices", "distributed", "architecture", "fault", "scale", "Byzantine"]
    )
    if long_complex:
        return "HARD"
    return "MEDIUM"


if __name__ == "__main__":
    print("=" * 60)
    print("ACCURACY BENCHMARK: fp32 vs int8 vs heuristic")
    print(f"labeled set: {len(LABELED)} queries")
    print("=" * 60)

    results = {}

    for quantized, label in [(False, "fp32 ModernBERT (571MB)"), (True, "int8 ModernBERT (144MB)")]:
        clf = QueryComplexityClassifier(str(MODEL_DIR), quantized=quantized, warmup=True)
        preds, confs, times = run(clf)
        acc = report(label, preds, confs, times)
        results[label] = {"acc": acc, "preds": preds}

    # heuristic baseline
    h_preds = [heuristic_tier(q) for q, _ in LABELED]
    h_confs = {t: [1.0] * sum(1 for _, tr in LABELED if tr == t) for t in TIERS}
    h_times = [0.0] * len(LABELED)
    acc_h = report("heuristic (0MB, 0ms)", h_preds, h_confs, h_times)
    results["heuristic (0MB, 0ms)"] = {"acc": acc_h, "preds": h_preds}

    print("\n" + "=" * 60)
    print("FLIP ANALYSIS (vs fp32 reference) — where the lighter option changes the dial")
    print("=" * 60)
    fp = results["fp32 ModernBERT (571MB)"]["preds"]
    for label in ["int8 ModernBERT (144MB)", "heuristic (0MB, 0ms)"]:
        p = results[label]["preds"]
        flips = [(q, truth, fp[i], p[i]) for i, (q, truth) in enumerate(LABELED) if fp[i] != p[i]]
        # net worse: fp32 got it right, this option is now wrong
        net_worse = [f for f in flips if f[2] == f[1] and f[3] != f[1]]
        # net fix: fp32 got it wrong, this option is now right
        corrections = [f for f in flips if f[2] != f[1] and f[3] == f[1]]
        print(f"\n{label}: {len(flips)} flips vs fp32 "
              f"(net worse {len(net_worse)}, net fixes {len(corrections)})")
        for q, truth, f, pr in net_worse:
            print(f"    ERROR  truth={truth:<7} fp32={f:<7} this={pr}    | {q[:70]}")
        if corrections:
            for q, truth, f, pr in corrections:
                print(f"    FIX    truth={truth:<7} fp32={f:<7} this={pr}    | {q[:70]}")