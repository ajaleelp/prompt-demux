"""HTTP wrapper around the query complexity classifier.

Run:
    venv/bin/python server.py            # port 8010
    venv/bin/uvicorn server:app --port 8010

Endpoints:
    GET  /health    -> {"status": "ok", "variant": "fp32"}
    POST /classify  -> {"query": "..."}  => tier/confidence/raw_scores/latency
"""

import os
from pathlib import Path
from typing import Optional

from fastapi import FastAPI
from pydantic import BaseModel

from classifier import QueryComplexityClassifier

MODEL_DIR = Path(__file__).parent / "model"
QUANTIZED = os.environ.get("CLASSIFIER_QUANTIZED", "0") == "1"
HOST = os.environ.get("CLASSIFIER_HOST", "127.0.0.1")
PORT = int(os.environ.get("CLASSIFIER_PORT", "8010"))

app = FastAPI(title="query-complexity-classifier")
_clf: Optional[QueryComplexityClassifier] = None


def get_classifier() -> QueryComplexityClassifier:
    global _clf
    if _clf is None:
        _clf = QueryComplexityClassifier(str(MODEL_DIR), quantized=QUANTIZED)
    return _clf


class ClassifyRequest(BaseModel):
    query: str


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "variant": "int8" if QUANTIZED else "fp32"}


@app.post("/classify")
def classify(req: ClassifyRequest) -> dict:
    return get_classifier().classify(req.query)


if __name__ == "__main__":
    import uvicorn

    get_classifier()
    uvicorn.run(app, host=HOST, port=PORT)
