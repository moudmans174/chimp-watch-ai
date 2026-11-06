"""Camera-trap image classification.

The platform does not bundle model weights. Two backends are provided:

- ``manual``: no automated classification; every image is queued for expert review.
- ``http``: posts the image to an external inference service (e.g. a MegaDetector or a
  fine-tuned YOLO model served behind a GPU endpoint) that returns
  ``{"model_version": str, "detections": [{"label": str, "confidence": float, "bbox": [x, y, w, h]}]}``.

Model outputs are decision-support evidence only: detections are always stored with
``review_status = "needs_review"`` until a specialist confirms them (proposal §4).
"""
from __future__ import annotations

import logging

import httpx

from ..config import get_settings

log = logging.getLogger(__name__)


def classify(image: bytes, content_type: str) -> dict:
    s = get_settings()
    if s.classifier_backend == "http" and s.classifier_url:
        try:
            r = httpx.post(s.classifier_url, files={"file": ("image", image, content_type)}, timeout=30)
            r.raise_for_status()
            payload = r.json()
            dets = [d for d in payload.get("detections", []) if float(d.get("confidence", 0)) >= s.classifier_min_confidence]
            top = max(dets, key=lambda d: d["confidence"], default=None)
            return {
                "backend": "http",
                "model_version": payload.get("model_version", "unknown"),
                "detections": dets,
                "top_label": top["label"] if top else None,
                "top_confidence": top["confidence"] if top else None,
                "review_status": "needs_review",
            }
        except Exception as exc:  # inference failure must never block data capture
            log.warning("classifier call failed: %s", exc)
            return {"backend": "http", "error": "inference_unavailable", "detections": [], "review_status": "needs_review"}
    return {"backend": "manual", "detections": [], "review_status": "needs_review",
            "note": "No automated classifier configured; awaiting expert identification."}
