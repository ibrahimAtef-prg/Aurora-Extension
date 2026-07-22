"""
metric_semantics.py — Metric Semantic Registry (SINGLE SOURCE OF TRUTH)

Central registry for all metric metadata ensuring:
- Explicit semantic meaning
- Direction consistency (higher_is_riskier)
- Normalized ranges [0.0, 1.0] or [0.0, 100.0]
- Interpretability without guessing
- FAIL-FAST validation (no clamping, no silent correction)

RULES:
- Every metric MUST have metadata
- higher_is_riskier=True: higher value = worse outcome
- higher_is_riskier=False: higher value = better outcome
- All metrics must pass through enforce_metric()
- NO clamping, NO silent fixes, NO fallbacks
"""

from __future__ import annotations

import math
from typing import Any, Dict, TypedDict


class MetricMeta(TypedDict):
    name: str
    range: list
    higher_is_riskier: bool
    meaning: str
    interpretation: Dict[str, str]


METADATA_REGISTRY: Dict[str, MetricMeta] = {
    "privacy_score": {
        "name": "privacy_score",
        "range": [0.0, 1.0],
        "higher_is_riskier": False,
        "meaning": "Composite measure of dataset privacy preservation. Higher values indicate better privacy protection against inference attacks.",
        "interpretation": {
            "low": "Privacy is compromised — high duplication, low fidelity, or attack vulnerability detected",
            "high": "Strong privacy preservation — synthetic data is both private and faithful to original",
        },
    },
    "duplicates_rate": {
        "name": "duplicates_rate",
        "range": [0.0, 1.0],
        "higher_is_riskier": True,
        "meaning": "Proportion of synthetic rows that exactly match original training rows. Direct privacy leak indicator.",
        "interpretation": {
            "low": "No exact duplicates — synthetic data does not memorize training rows",
            "high": "High duplication — synthetic data leaks exact training records",
        },
    },
    "membership_proximity_risk_score": {
        "name": "membership_proximity_risk_score",
        "range": [0.0, 1.0],
        "higher_is_riskier": True,
        "meaning": "Risk score derived from membership inference analysis. Measures how distinguishable synthetic rows are from originals. 0.5 = random (ideal), higher = more distinguishable (risky).",
        "interpretation": {
            "low": "Synthetic rows are indistinguishable from originals — potential reconstruction risk",
            "high": "Synthetic rows are easily distinguishable — may indicate distribution drift or poor fidelity",
        },
    },
    "statistical_drift_score": {
        "name": "statistical_drift_score",
        "range": [0.0, 1.0],
        "higher_is_riskier": True,
        "meaning": "Average JS-divergence between original and synthetic distributions. Measures distributional fidelity.",
        "interpretation": {
            "low": "Synthetic distribution closely matches original — high fidelity",
            "high": "Significant distribution divergence — synthetic data may not generalize",
        },
    },
    "reidentification_risk": {
        "name": "reidentification_risk",
        "range": [0.0, 1.0],
        "higher_is_riskier": True,
        "meaning": "Per-column probability of re-identifying individuals based on uniqueness and entropy.",
        "interpretation": {
            "low": "Column values are common — low re-identification risk",
            "high": "Column values are unique — high re-identification potential",
        },
    },
    "sensitivity_score": {
        "name": "sensitivity_score",
        "range": [0.0, 1.0],
        "higher_is_riskier": True,
        "meaning": "Composite column sensitivity combining PII presence, re-identification risk, drift, and correlation.",
        "interpretation": {
            "low": "Column is non-sensitive — minimal privacy concern",
            "high": "Column is highly sensitive — requires strong protection",
        },
    },
    "dataset_risk_score": {
        "name": "dataset_risk_score",
        "range": [0.0, 100.0],
        "higher_is_riskier": True,
        "meaning": "Composite risk score (0-100) combining privacy posture, attack vulnerability, duplication, and drift.",
        "interpretation": {
            "low": "Dataset is low-risk — suitable for sharing with standard controls",
            "high": "Dataset is high-risk — requires significant anonymization or access restrictions",
        },
    },
    "dataset_intelligence_risk": {
        "name": "dataset_intelligence_risk",
        "range": [0.0, 100.0],
        "higher_is_riskier": True,
        "meaning": "Holistic risk score (0-100) incorporating re-identification, PII density, outliers, and privacy score.",
        "interpretation": {
            "low": "Dataset passes multiple risk dimensions — safe for controlled release",
            "high": "Dataset fails multiple risk checks — high priority for remediation",
        },
    },
    "statistical_reliability_score": {
        "name": "statistical_reliability_score",
        "range": [0.0, 1.0],
        "higher_is_riskier": False,
        "meaning": "Confidence in computed metrics based on dataset size. Larger datasets yield more reliable statistics.",
        "interpretation": {
            "low": "Small dataset — metrics may be unstable or misleading",
            "high": "Sufficient data size — metrics are statistically reliable",
        },
    },
    "membership_attack_success": {
        "name": "membership_attack_success",
        "range": [0.0, 1.0],
        "higher_is_riskier": True,
        "meaning": "Normalized attack success rate derived from membership proximity analysis. 0 = random guess, 1 = perfect attack.",
        "interpretation": {
            "low": "Attack success is near zero — membership is protected",
            "high": "Attack success is high — membership can be inferred",
        },
    },
    "reconstruction_risk": {
        "name": "reconstruction_risk",
        "range": [0.0, 1.0],
        "higher_is_riskier": True,
        "meaning": "Risk that original records can be reconstructed from synthetic data due to excessive similarity.",
        "interpretation": {
            "low": "Synthetic data is sufficiently different — reconstruction unlikely",
            "high": "Synthetic data is too similar — reconstruction attack may succeed",
        },
    },
    "nearest_neighbor_leakage": {
        "name": "nearest_neighbor_leakage",
        "range": [0.0, 1.0],
        "higher_is_riskier": True,
        "meaning": "Proximity leakage risk based on drift. Low drift means synthetic rows cluster near originals.",
        "interpretation": {
            "low": "Synthetic rows are distant from originals — low leakage",
            "high": "Synthetic rows cluster near originals — high proximity leakage",
        },
    },
    "outlier_risk_score": {
        "name": "outlier_risk_score",
        "range": [0.0, 1.0],
        "higher_is_riskier": True,
        "meaning": "Exposure risk from extreme outlier values that may identify individuals in sparse regions.",
        "interpretation": {
            "low": "No significant outliers — values fall within expected ranges",
            "high": "Extreme outliers present — individuals in sparse regions may be exposed",
        },
    },
    "pii_density": {
        "name": "pii_density",
        "range": [0.0, 1.0],
        "higher_is_riskier": True,
        "meaning": "Proportion of columns containing personally identifiable information.",
        "interpretation": {
            "low": "Few or no PII columns — minimal regulatory burden",
            "high": "Many PII columns — significant privacy and compliance requirements",
        },
    },
    "column_drift": {
        "name": "column_drift",
        "range": [0.0, 1.0],
        "higher_is_riskier": True,
        "meaning": "Per-column JS-divergence measuring distribution shift between original and synthetic.",
        "interpretation": {
            "low": "Column distribution preserved — synthetic matches original",
            "high": "Column distribution shifted — synthetic diverges from original",
        },
    },
    "duplicates_risk": {
        "name": "duplicates_risk",
        "range": [0.0, 1.0],
        "higher_is_riskier": True,
        "meaning": "Direct duplication risk component — proportion of exact row copies.",
        "interpretation": {
            "low": "No duplicates — synthetic data is novel",
            "high": "High duplication — training data leaked directly",
        },
    },
    "mi_attack_risk": {
        "name": "mi_attack_risk",
        "range": [0.0, 1.0],
        "higher_is_riskier": True,
        "meaning": "Membership inference attack vulnerability derived from membership proximity deviation from 0.5.",
        "interpretation": {
            "low": "MI attack is not effective — membership protected",
            "high": "MI attack may succeed — membership vulnerable",
        },
    },
    "distance_similarity_risk": {
        "name": "distance_similarity_risk",
        "range": [0.0, 1.0],
        "higher_is_riskier": True,
        "meaning": "Risk from excessive similarity (membership proximity < 0.5) indicating potential reconstruction.",
        "interpretation": {
            "low": "Safe distance maintained — no reconstruction risk",
            "high": "Too similar to originals — reconstruction attack viable",
        },
    },
    "distribution_drift_risk": {
        "name": "distribution_drift_risk",
        "range": [0.0, 1.0],
        "higher_is_riskier": True,
        "meaning": "Overall distribution drift risk — average JS-divergence across all columns.",
        "interpretation": {
            "low": "Distributions match — synthetic data is faithful",
            "high": "Distributions diverge — synthetic may not generalize",
        },
    },
    "acceptance_rate": {
        "name": "acceptance_rate",
        "range": [0.0, 1.0],
        "higher_is_riskier": False,
        "meaning": "Proportion of generated rows that passed all validation checks.",
        "interpretation": {
            "low": "Many rows rejected — generation quality issues or strict constraints",
            "high": "Most rows accepted — generation quality is good",
        },
    },
    "rejection_rate": {
        "name": "rejection_rate",
        "range": [0.0, 1.0],
        "higher_is_riskier": True,
        "meaning": "Proportion of generated rows that failed validation checks.",
        "interpretation": {
            "low": "Few rows rejected — generation quality is good",
            "high": "Many rows rejected — generation quality issues or strict constraints",
        },
    },
}


def get_metric_meta(name: str) -> MetricMeta:
    """
    Get metric metadata from central registry.
    
    FAIL-FAST: Raises ValueError if metric not registered.
    """
    if name not in METADATA_REGISTRY:
        raise ValueError(f"Unknown metric: '{name}'. All metrics must be registered in METADATA_REGISTRY.")
    return METADATA_REGISTRY[name]


EPS = 1e-9


def validate_metric_value(name: str, value: float) -> float:
    """
    Validate metric value is finite and within bounds.
    
    FAIL-FAST for real errors, tolerant for floating-point precision noise.
    
    Raises ValueError on:
    - Non-finite values (NaN, Inf)
    - Values outside [min-EPS, max+EPS] (true errors)
    
    Snaps to bounds if within epsilon (precision noise).
    
    NO SILENT LARGE CORRECTIONS.
    """
    if not isinstance(value, (int, float)):
        raise TypeError(f"{name}: value must be numeric, got {type(value)}")
    
    if math.isnan(value) or math.isinf(value):
        raise ValueError(f"{name}: non-finite value {value}")
    
    meta = get_metric_meta(name)
    min_v, max_v = meta["range"]
    
    if value < min_v - EPS or value > max_v + EPS:
        raise ValueError(f"{name}: out-of-range value {value} (valid range: [{min_v}, {max_v}])")
    
    if value < min_v:
        value = min_v
    elif value > max_v:
        value = max_v
    
    return float(value)


def normalize_metric_direction(name: str, value: float) -> float:
    """
    Normalize metric direction so higher always means riskier.
    
    For metrics where higher_is_riskier=False, inverts the value.
    
    MUST be called AFTER validate_metric_value().
    """
    meta = get_metric_meta(name)
    if not meta["higher_is_riskier"]:
        value = 1.0 - value
        min_v, max_v = meta["range"]
        if not (min_v <= value <= max_v):
            raise ValueError(f"{name}: direction normalization produced out-of-range value {value}")
    return value


def enforce_metric(name: str, value: float) -> Dict[str, Any]:
    """
    MANDATORY enforcement pipeline for ALL metric outputs.
    
    Pipeline:
    1. Preserve raw_value (original computed value, NO information loss)
    2. validate_metric_value() - FAIL-FAST bounds check (epsilon-tolerant)
    3. normalize_metric_direction() - Ensure consistent direction
    4. Attach metadata with explicit normalization flag
    
    Returns: {
        "raw_value": float,  # Original computed value (preserved)
        "value": float,       # Direction-normalized value
        "normalized": True,   # Explicit marker
        "meta": MetricMeta
    }
    
    NO BYPASS ALLOWED.
    NO INFORMATION LOSS.
    """
    raw_value = value
    validated = validate_metric_value(name, value)
    normalized_value = normalize_metric_direction(name, validated)
    meta = get_metric_meta(name)
    
    return {
        "raw_value": round(float(raw_value), 6),
        "value": round(float(normalized_value), 6),
        "normalized": True,
        "meta": meta,
    }
