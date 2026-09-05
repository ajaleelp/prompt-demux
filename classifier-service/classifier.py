"""Local query complexity classifier for OpenCode model routing.

Runs a ModernBERT-base fine-tune (ONNX) fully offline on CPU.
Model: anasnassar/llm-query-complexity-classifier (via its ONNX export).
Labels LOW / MEDIUM / HIGH are normalized to EASY / MEDIUM / HARD.
"""

import json
import time
from pathlib import Path
from typing import Dict, Optional

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

LABEL_MAP = {"LOW": "EASY", "MEDIUM": "MEDIUM", "HIGH": "HARD"}

DEFAULT_MODEL_MAPPING: Dict[str, Dict[str, str]] = {
    "EASY": {"providerID": "opencode", "modelID": "glm-5.3-flash"},
    "MEDIUM": {"providerID": "opencode", "modelID": "deepseek-v4-pro"},
    "HARD": {"providerID": "opencode", "modelID": "kimi-k3"},
}


class QueryComplexityClassifier:
    """Classifies natural-language queries into EASY / MEDIUM / HARD tiers."""

    def __init__(
        self,
        model_dir: str,
        quantized: bool = False,
        max_length: int = 512,
        intra_op_threads: Optional[int] = None,
        model_mapping: Optional[Dict[str, Dict[str, str]]] = None,
        warmup: bool = True,
    ):
        self.model_dir = Path(model_dir)
        self.max_length = max_length
        self.model_mapping = model_mapping or DEFAULT_MODEL_MAPPING

        onnx_path = (
            self.model_dir / "onnx" / "model_quantized.onnx"
            if quantized
            else self.model_dir / "onnx" / "model.onnx"
        )
        if not onnx_path.exists():
            raise FileNotFoundError(f"ONNX model not found: {onnx_path}")

        so = ort.SessionOptions()
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        if intra_op_threads:
            so.intra_op_num_threads = intra_op_threads
            so.inter_op_num_threads = 1

        self.session = ort.InferenceSession(
            str(onnx_path), sess_options=so, providers=["CPUExecutionProvider"]
        )
        self.input_names = {i.name for i in self.session.get_inputs()}

        self.tokenizer = Tokenizer.from_file(str(self.model_dir / "tokenizer.json"))
        self.tokenizer.enable_truncation(max_length=max_length)
        self.tokenizer.no_padding()

        self._id2label = {0: "LOW", 1: "MEDIUM", 2: "HIGH"}
        try:
            with open(self.model_dir / "config.json") as f:
                cfg = json.load(f)
            self._id2label = {int(k): v for k, v in cfg["id2label"].items()}
        except (OSError, KeyError, ValueError):
            pass

        if warmup:
            self.classify("warmup")

    def classify(self, query: str) -> dict:
        """Classify one query.

        Returns:
            {
              'tier': 'EASY' | 'MEDIUM' | 'HARD',
              'label': raw model label ('LOW' | 'MEDIUM' | 'HIGH'),
              'confidence': float,
              'raw_scores': {'EASY': .., 'MEDIUM': .., 'HARD': ..},
              'latency_ms': float,
            }
        """
        start = time.perf_counter()

        encoded = self.tokenizer.encode(query)
        feed = {
            "input_ids": np.array([encoded.ids], dtype=np.int64),
            "attention_mask": np.array([encoded.attention_mask], dtype=np.int64),
        }
        feed = {k: v for k, v in feed.items() if k in self.input_names}

        logits = self.session.run(None, feed)[0][0]
        probs = _softmax(logits)

        scores = {
            LABEL_MAP.get(self._id2label[i], self._id2label[i]): float(probs[i])
            for i in range(len(probs))
        }
        best_idx = int(np.argmax(probs))
        raw_label = self._id2label[best_idx]

        return {
            "tier": LABEL_MAP.get(raw_label, raw_label),
            "label": raw_label,
            "confidence": float(probs[best_idx]),
            "raw_scores": scores,
            "latency_ms": (time.perf_counter() - start) * 1000.0,
        }

    def get_model_for_complexity(self, tier: str) -> dict:
        """Map a complexity tier to a provider/model pair."""
        return self.model_mapping[tier]


def _softmax(x: np.ndarray) -> np.ndarray:
    e = np.exp(x - np.max(x))
    return e / e.sum()
