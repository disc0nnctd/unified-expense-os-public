from __future__ import annotations

from .schemas import CaptureSuggestion


RULES = [
    (("rent",), ("shared", "rent", True, "high")),
    (("wifi", "broadband", "internet"), ("shared", "wifi", True, "high")),
    (("electricity", "power"), ("shared", "utilities", True, "high")),
    (("grocery", "groceries", "supermarket"), ("shared", "groceries", False, "medium")),
    (("recharge", "mobile"), ("personal", "mobile-bill", False, "medium")),
]


def classify_capture(text: str) -> CaptureSuggestion:
    lowered = text.lower()
    context_hint = None
    if any(token in lowered for token in ("flat", "home", "house", "household", "roommate", "roommates")):
        context_hint = "shared-household"
    elif any(token in lowered for token in ("trip", "meetup", "party")):
        context_hint = "shared-event"
    elif any(token in lowered for token in ("me", "personal", "my")):
        context_hint = "personal"

    for keywords, result in RULES:
        if any(keyword in lowered for keyword in keywords):
            default_context, category, recurring, confidence = result
            return CaptureSuggestion(
                context_hint=context_hint or default_context,
                category_hint=category,
                recurring_candidate=recurring,
                confidence=confidence,
            )

    return CaptureSuggestion(
        context_hint=context_hint,
        category_hint=None,
        recurring_candidate=False,
        confidence="low",
    )
