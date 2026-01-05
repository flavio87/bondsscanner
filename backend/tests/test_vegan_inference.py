from app.llm_queue import _infer_vegan_friendly


def test_vegan_inference_meat_processing():
    result = _infer_vegan_friendly(
        "Bell Food Group",
        "Industry sector: Food, meat processing and slaughtering.",
    )
    assert result is False


def test_vegan_inference_food_sector():
    result = _infer_vegan_friendly(
        "Barry Callebaut",
        "Industry sector: Food, luxury goods.",
    )
    assert result is False


def test_vegan_inference_pharma():
    result = _infer_vegan_friendly(
        "Roche Holding AG",
        "Global pharmaceutical and biotechnology company.",
    )
    assert result is False


def test_vegan_inference_transport():
    result = _infer_vegan_friendly(
        "AMAG AG",
        "Industry sector: Transport and automotive services.",
    )
    assert result is True


def test_vegan_inference_bank():
    result = _infer_vegan_friendly(
        "UBS Group AG",
        "Issuer sector: Financial services and banking.",
    )
    assert result is True


def test_vegan_inference_unknown():
    result = _infer_vegan_friendly("Unknown", "No extra context provided.")
    assert result is None
