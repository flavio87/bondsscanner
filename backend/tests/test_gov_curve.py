from fastapi.testclient import TestClient

from app.main import app


def test_gov_curve_endpoint(monkeypatch):
    monkeypatch.setattr("app.main.start_worker", lambda: None)

    def fake_fetch_government_bonds(currency="CHF", country="CH"):
        return [
            {"MaturityDate": 20270101, "YieldToWorst": 1.5},
            {"MaturityDate": 20290101, "YieldToWorst": 2.0},
        ]

    def fake_extract_curve_points(bonds):
        return [
            {
                "years": 2.0,
                "yield": 1.5,
                "valor_id": "CH123",
                "isin": "CH000",
                "short_name": "Gov 2Y",
                "maturity": 20270101,
                "issuer": "Swiss Confederation",
                "source": "YieldToWorst",
            },
            {
                "years": 4.0,
                "yield": 2.0,
                "valor_id": "CH456",
                "isin": "CH111",
                "short_name": "Gov 4Y",
                "maturity": 20290101,
                "issuer": "Swiss Confederation",
                "source": "YieldToWorst",
            },
        ]

    monkeypatch.setattr("app.main.fetch_government_bonds", fake_fetch_government_bonds)
    def fake_build_fits(points):
        return {
            "spline": [{"years": 2.0, "yield": 1.5}, {"years": 4.0, "yield": 2.0}],
            "nelson_siegel": [{"years": 2.0, "yield": 1.4}, {"years": 4.0, "yield": 2.1}],
            "meta": {"excluded_outliers": 0, "used_points": len(points), "total_points": len(points)},
        }

    monkeypatch.setattr("app.main.extract_curve_points_with_meta", fake_extract_curve_points)
    monkeypatch.setattr("app.main.build_gov_curve_fits", fake_build_fits)

    client = TestClient(app)
    response = client.get("/api/bonds/gov-curve?currency=CHF&country=CH")
    assert response.status_code == 200
    payload = response.json()
    assert payload["count"] == 2
    assert payload["points"] == [
        {
            "years": 2.0,
            "yield": 1.5,
            "valor_id": "CH123",
            "isin": "CH000",
            "short_name": "Gov 2Y",
            "maturity": 20270101,
            "issuer": "Swiss Confederation",
            "source": "YieldToWorst",
        },
        {
            "years": 4.0,
            "yield": 2.0,
            "valor_id": "CH456",
            "isin": "CH111",
            "short_name": "Gov 4Y",
            "maturity": 20290101,
            "issuer": "Swiss Confederation",
            "source": "YieldToWorst",
        },
    ]
    assert payload["fits"]["spline"]
    assert payload["fits"]["nelson_siegel"]
