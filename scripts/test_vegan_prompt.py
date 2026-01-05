from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import sys
from typing import Iterable

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.app.settings import load_env
from backend.app.llm_client import call_llm


PROMPT_TEMPLATE = """You are classifying whether a company is vegan friendly.

Return JSON with keys: summary_md, vegan_friendly, vegan_explanation, esg_summary.

Rules:
- vegan_friendly = false if the company:
  * produces/sells animal-derived food products (meat, dairy, eggs, leather),
  * runs animal agriculture or slaughter/processing,
  * performs or commissions animal testing (including pharmaceuticals/biotech).
- vegan_friendly = true only if there is clear evidence the company does NOT do any of the above.
- For banks, software, construction, and other non-animal industries: default to true unless context indicates involvement in animal testing or animal-derived products.
- For pharma/biotech: default to false unless explicit evidence of no animal testing exists.
- If the context is insufficient, set vegan_friendly = null and say what’s missing.
- If you are unsure, you MAY browse to verify; only browse when needed.

Summary must be exactly one sentence.
Use provided context first; browse only if needed.

Issuer: {issuer_name}
Context:
{context_block}
"""


@dataclass
class TestCase:
    issuer: str
    context: str


def build_prompt(case: TestCase) -> str:
    return PROMPT_TEMPLATE.format(issuer_name=case.issuer, context_block=case.context)


def run_tests(cases: Iterable[TestCase]) -> None:
    load_env()
    for case in cases:
        prompt = build_prompt(case)
        response = call_llm(prompt)
        print("=" * 88)
        print(f"Issuer: {case.issuer}")
        print(f"Provider: {response.get('provider')} | Model: {response.get('model')}")
        print(response.get("text"))
        print()


if __name__ == "__main__":
    tests = [
        TestCase("UBS Group AG", "Global banking and wealth management services."),
        TestCase("Roche Holding AG", "Global pharmaceutical and biotechnology company."),
        TestCase("Bell Food Group", "Meat processing and packaged meat products."),
        TestCase("Novartis AG", "Pharmaceutical company focused on medicines."),
        TestCase("Nestle SA", "Food and beverage company; includes dairy products."),
        TestCase("Logitech International SA", "Consumer electronics and software accessories."),
        TestCase("ABB Ltd", "Industrial automation and electrification technologies."),
        TestCase("Zurich Insurance Group", "Insurance and financial services."),
    ]
    run_tests(tests)
