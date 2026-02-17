#!/usr/bin/env python3
"""Backward-compatible shim — all logic lives in toolkit.fidelity."""

from toolkit.fidelity import (  # noqa: F401
    FidelityConfig,
    compare_profiles,
    run_fidelity_evaluation,
    style_profile,
)
