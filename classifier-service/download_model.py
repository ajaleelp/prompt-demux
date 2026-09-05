"""Download the query-complexity classifier (ONNX) from Hugging Face.

Files land in ./model/ and are verified by huggingface_hub against the
repo's SHA256 etags automatically (integrity check on every download).
"""

import os
import sys
from pathlib import Path

from huggingface_hub import hf_hub_download

REPO_ID = "mustafacolakoglu94/llm-query-complexity-classifier-onnx"

# fp32 (~600MB) + int8 (~150MB) variants, benchmarked side by side
FILES = [
    "onnx/model.onnx",
    "onnx/model_quantized.onnx",
    "tokenizer.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "config.json",
]

MODEL_DIR = Path(__file__).parent / "model"


def main() -> int:
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    for filename in FILES:
        print(f"Downloading {filename} ...")
        path = hf_hub_download(
            repo_id=REPO_ID,
            filename=filename,
            local_dir=MODEL_DIR,
        )
        size_mb = os.path.getsize(path) / 1_000_000
        print(f"  OK -> {path} ({size_mb:.1f} MB)")
    print("\nAll files downloaded and integrity-verified.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
