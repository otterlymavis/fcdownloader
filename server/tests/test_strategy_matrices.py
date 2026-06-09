from __future__ import annotations

import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import test_all_strategies as strategies


def test_strategy_matrices_match_sources():
    check = strategies.validate_strategy_matrices_against_sources()
    assert check == {
        "app_missing": [],
        "app_extra": [],
        "backend_missing": [],
        "backend_extra": [],
        "entry_errors": [],
        "source_app_missing": [],
        "source_app_stale": [],
        "source_backend_missing": [],
        "source_backend_unexpected": [],
    }


def test_strategy_matrices_have_real_url_shapes():
    assert not strategies.validate_matrix_entries(
        "app", strategies.APP_DOWNLOAD_STRATEGIES
    )
    assert not strategies.validate_matrix_entries(
        "backend", strategies.BACKEND_EXTRACTION_STRATEGIES
    )
