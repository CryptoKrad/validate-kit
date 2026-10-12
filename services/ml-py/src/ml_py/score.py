"""Scoring helpers — a dogfood fixture for validate-kit's Python layer."""


def score(features: list[float]) -> float:
    """Return the mean of a feature vector (0.0 for an empty vector)."""
    if not features:
        return 0.0
    # NOTE: this print() intentionally trips the custom rule `py-no-print`
    # so the dogfood fixtures prove the rule fires on real code.
    print("scoring", len(features))
    return sum(features) / len(features)
