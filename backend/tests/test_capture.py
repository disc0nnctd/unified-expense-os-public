from app.capture import classify_capture


def test_capture_rules_detect_household_wifi():
    suggestion = classify_capture("Electricity and wifi bill for the house")
    assert suggestion.context_hint == "shared-household"
    assert suggestion.recurring_candidate is True
    assert suggestion.confidence == "high"


def test_capture_rules_fall_back_to_low_confidence():
    suggestion = classify_capture("Bought something random")
    assert suggestion.category_hint is None
    assert suggestion.confidence == "low"
