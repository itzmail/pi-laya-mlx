"""Laya local decision daemon for pi auto-router.

Architecture:
  Uses Laya's mmBERT Multilingual Encoder to produce dense sentence embeddings,
  then computes cosine similarity against canonical anchor exemplars from anchors.json
  (Semantic Exemplar KNN).

Endpoints:
  GET  /health          -> {"ok": true, "ready": bool}
  POST /predict         -> {"answers": {...}, "latency_ms": float}
  POST /reload-anchors  -> {"ok": true, "reloaded_ms": float, "counts": {...}}
  GET  /logs            -> {"logs": [...]}
  POST /corrections     -> {"ok": true, "total": int}
"""

from datetime import datetime, timezone
import json
import os
import sys
import time
from typing import Dict, List

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
import numpy as np

PORT = int(os.environ.get("LAYA_PORT", "4141"))
MODEL_ID = os.environ.get("LAYA_MODEL", "aac6fef/laya-multilingual-mlx")
BASE_DIR = os.path.dirname(__file__)
LOG_PATH = os.path.join(BASE_DIR, "predictions.jsonl")
CORRECTIONS_PATH = os.path.join(BASE_DIR, "corrections.jsonl")
ANCHORS_PATH = os.path.join(BASE_DIR, "anchors.json")

app = FastAPI(title="Laya MLX Local Daemon")
agent = None
embed_fn = None
load_error = None
anchor_mat: Dict[str, np.ndarray] = {}
current_anchors: Dict[str, List[str]] = {}


def _load_anchors_file() -> Dict[str, List[str]]:
    if os.path.exists(ANCHORS_PATH):
        try:
            with open(ANCHORS_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            print(f"[laya-server] error reading anchors.json: {e}", file=sys.stderr)
    return {}


def _init_anchors():
    global anchor_mat, current_anchors
    t0 = time.perf_counter()
    anchors = _load_anchors_file()
    if not anchors:
        print("[laya-server] warning: anchors.json is empty or missing!", file=sys.stderr)
        return 0.0

    mat = {}
    for cat, texts in anchors.items():
        if texts:
            vecs = embed_fn(texts)  # (N, D)
            norms = np.linalg.norm(vecs, axis=1, keepdims=True) + 1e-9
            mat[cat] = vecs / norms
        else:
            mat[cat] = np.zeros((0, 768), dtype=np.float32)

    anchor_mat = mat
    current_anchors = anchors
    ms = (time.perf_counter() - t0) * 1000
    print(f"[laya-server] computed {sum(len(v) for v in anchors.values())} anchor embeddings across {len(anchors)} categories in {ms:.1f}ms", flush=True)
    return ms


@app.on_event("startup")
def _load_model():
    global agent, embed_fn, load_error
    t0 = time.perf_counter()
    try:
        import laya_mlx as laya
        agent = laya.load(MODEL_ID, dtype="float16")
        embed_fn = laya.embed_fn_from_agent(agent)
        _init_anchors()
        # Warmup query
        embed_fn(["warmup query"])
        ms = (time.perf_counter() - t0) * 1000
        print(f"[laya-server] model and encoder ready in {ms:.0f} ms: {MODEL_ID}", flush=True)
    except Exception as e:  # noqa: BLE001
        agent = None
        embed_fn = None
        load_error = str(e)
        print(f"[laya-server] model load FAILED: {e}", file=sys.stderr, flush=True)


@app.get("/health")
def health():
    return {
        "ok": agent is not None and embed_fn is not None,
        "model": MODEL_ID,
        "engine": "laya-multilingual-embeddings-knn",
        "anchors_count": {k: len(v) for k, v in current_anchors.items()},
        "error": load_error,
    }


@app.post("/reload-anchors")
def reload_anchors():
    """Hot-reload anchor embeddings from anchors.json in <100ms without restarting the server."""
    if embed_fn is None:
        return JSONResponse({"error": "model not loaded", "detail": load_error}, status_code=503)
    ms = _init_anchors()
    return {
        "ok": True,
        "reloaded_ms": round(ms, 2),
        "counts": {k: len(v) for k, v in current_anchors.items()},
    }


@app.get("/logs")
def get_logs(limit: int = 15):
    """Return the most recent prediction logs."""
    if not os.path.exists(LOG_PATH):
        return {"logs": []}
    try:
        with open(LOG_PATH, "r", encoding="utf-8") as f:
            lines = f.readlines()
        recent = [json.loads(line.strip()) for line in lines[-limit:] if line.strip()]
        return {"logs": recent}
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": str(e)}, status_code=500)


@app.post("/corrections")
async def record_correction(req: Request):
    """Save a user correction/flag for offline tuning."""
    try:
        body = json.loads(await req.body())
    except Exception as e:
        return JSONResponse({"error": f"bad json: {e}"}, status_code=400)

    prompt = body.get("prompt", "").strip()
    target = body.get("target", "").strip()
    if not prompt or not target:
        return JSONResponse({"error": "prompt and target required"}, status_code=400)

    entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "prompt": prompt,
        "target": target,
        "was": body.get("was"),
    }
    try:
        with open(CORRECTIONS_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception as e:
        return JSONResponse({"error": f"write failed: {e}"}, status_code=500)

    return {"ok": True, "recorded": entry}


def _log_prediction(entry: dict):
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception as e:
        print(f"[laya-server] log error: {e}", file=sys.stderr)


def _classify_intent(prompt: str) -> dict:
    pv = embed_fn([prompt])  # (1, D)
    pv = pv / (np.linalg.norm(pv, axis=1, keepdims=True) + 1e-9)

    cat_scores: Dict[str, float] = {}
    for cat, mat in anchor_mat.items():
        if mat.shape[0] == 0:
            cat_scores[cat] = 0.0
            continue
        sims = np.dot(mat, pv.T).flatten()  # (N,)
        top3 = np.sort(sims)[-3:]
        cat_scores[cat] = float(np.mean(top3))

    # Softmax normalization with temperature scaling (T=0.05)
    scores_arr = np.array(list(cat_scores.values()))
    exp_scores = np.exp((scores_arr - np.max(scores_arr)) / 0.05)
    probs_arr = exp_scores / np.sum(exp_scores)

    prob_dict = {cat: round(float(p), 4) for cat, p in zip(cat_scores.keys(), probs_arr)}
    top_cat = max(cat_scores, key=cat_scores.get)

    return {
        "type": "choice",
        "choice": top_cat,
        "confidence": prob_dict[top_cat],
        "probabilities": prob_dict,
        "raw_cosine": {k: round(v, 4) for k, v in cat_scores.items()},
    }


@app.post("/predict")
async def predict(req: Request):
    if agent is None or embed_fn is None:
        return JSONResponse({"error": "model not loaded", "detail": load_error}, status_code=503)
    try:
        body = json.loads(await req.body())
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": f"bad json: {e}"}, status_code=400)

    state = body.get("state", "")
    if not state.strip():
        return JSONResponse({"error": "state required"}, status_code=400)

    t0 = time.perf_counter()
    try:
        classification = _classify_intent(state)
        answers = {"task_category": classification}
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": f"predict failed: {e}"}, status_code=500)
    ms = (time.perf_counter() - t0) * 1000

    # Structured evaluation logging
    entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "prompt": state,
        "choice": classification["choice"],
        "confidence": classification["confidence"],
        "probabilities": classification["probabilities"],
        "raw_cosine": classification["raw_cosine"],
        "latency_ms": round(ms, 2),
    }
    _log_prediction(entry)

    return {"answers": answers, "latency_ms": round(ms, 2)}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
