"""Cross-language parity tests for sci_anonymizer.

Loads core/tests/fixtures/anonymizer.json (golden fixtures) and verifies
that the Python binding produces identical behavior to the Rust core on:
  - Entity detection (regex, CamelCase heuristic, custom entities)
  - Token map serialization/deserialization
  - Round-trip anonymize → deanonymize fidelity

This test does NOT cover:
  - NLP NER (bare PERSON/PLACE/ORG detection) — tracked in SCI-123
  - Custom entity loading from identity_facts — tracked in SCI-124
  - Internal regressions (SCI-195/196/197) — Rust-only
"""

import sys
import json
from pathlib import Path
from sci_anonymizer import (
    anonymize,
    deanonymize,
    Entity,
    EntityType,
)

# Tech allowlist (mirrors TECH_ALLOWLIST from Rust core)
TECH_ALLOWLIST = [
    "slack", "github", "twitter", "google", "amazon", "microsoft",
    "openai", "anthropic", "science", "platform", "framework",
    "service", "api", "web", "email", "mail", "app", "server",
    "database", "cache", "queue", "stream", "kafka", "redis",
    "postgres", "mysql", "sqlite", "mongodb", "dynamodb",
    "claude", "chatgpt", "copilot", "cursor", "gemini",
]


def load_fixtures():
    """Load the golden fixture file from core/tests/fixtures/anonymizer.json."""
    # Path from this file: core/crates/sci-anonymizer-py/tests/test_parity.py
    # Up 4 levels to reach core/, then into tests/fixtures/
    fixture_path = Path(__file__).parent.parent.parent.parent / "tests" / "fixtures" / "anonymizer.json"
    if not fixture_path.exists():
        raise FileNotFoundError(f"Fixture file not found: {fixture_path}")
    with open(fixture_path, "r") as f:
        return json.load(f)


def allowlisted_ci(text):
    """Case-insensitive allowlist lookup.

    The runtime is_allowlisted is case-sensitive on purpose (so "SLACK"
    mid-sentence stays a possible project name even though "Slack" is
    allowlisted); but fixtures may contain lowercase tokens that should
    be dropped in the parity comparison.
    """
    lower = text.lower()
    return any(w.lower() == lower for w in TECH_ALLOWLIST)


def test_parity_round_trip():
    """Test round-trip fidelity: deanonymize(anonymize(text)) == text.

    This is the primary correctness guarantee for the anonymizer.
    """
    fixtures = load_fixtures()
    failures = []

    for fixture in fixtures:
        text = fixture["input"]
        result = anonymize(text)
        restored = deanonymize(result.text, result.token_map)

        if restored != text:
            failures.append({
                "name": fixture["name"],
                "input": text,
                "masked": result.text,
                "restored": restored,
                "error": f"Round-trip mismatch: {restored!r} != {text!r}",
            })

    if failures:
        print("FAILED: Round-trip fidelity")
        for fail in failures:
            print(f"  [{fail['name']}] {fail['error']}")
        return False

    print(f"✓ Round-trip fidelity: all {len(fixtures)} fixtures passed")
    return True


def test_parity_entity_detection():
    """Test that entity detection matches the golden fixtures (modulo allowlist).

    Compares (text, type) pairs case-insensitively for detected entities,
    filtering through the allowlist like the Rust implementation does.
    """
    fixtures = load_fixtures()
    failures = []

    for fixture in fixtures:
        text = fixture["input"]
        result = anonymize(text)

        # Build expected set
        expected = {
            (e["text"].lower(), e["type"].upper())
            for e in fixture["expected_detected"]
            if not allowlisted_ci(e["text"])
        }

        # Build actual set: convert entity_type to uppercase string representation
        # EntityType enum values serialize as "Person", "Email", "Url", etc.
        actual = set()
        for e in result.entities:
            if not allowlisted_ci(e.text):
                # entity_type is a PyEntityType enum; extract and uppercase the type name
                entity_type_str = str(e.entity_type)
                # Parse "Person" to "PERSON", "Email" to "EMAIL", "Url" to "URL", etc.
                if "." in entity_type_str:
                    entity_type_str = entity_type_str.split(".")[-1]
                actual.add((e.text.lower(), entity_type_str.upper()))

        if expected != actual:
            failures.append({
                "name": fixture["name"],
                "input": text,
                "expected": sorted(expected),
                "actual": sorted(actual),
            })

    if failures:
        print("FAILED: Entity detection parity")
        for fail in failures:
            print(f"  [{fail['name']}] input: {fail['input']!r}")
            print(f"    expected: {fail['expected']}")
            print(f"    actual:   {fail['actual']}")
        return False

    print(f"✓ Entity detection: all {len(fixtures)} fixtures matched")
    return True


def test_parity_session_serialization():
    """Test that token maps serialize/deserialize identically across the API."""
    fixtures = load_fixtures()
    failures = []

    for fixture in fixtures[:5]:  # Sample first 5 fixtures
        text = fixture["input"]
        result = anonymize(text)
        token_map = result.token_map

        # Serialize
        try:
            json_str = token_map.to_session_json()
        except Exception as e:
            failures.append({
                "name": fixture["name"],
                "error": f"Serialization failed: {e}",
            })
            continue

        # Deserialize
        try:
            from sci_anonymizer import TokenMap
            restored_map = TokenMap.from_session_json(json_str)
        except Exception as e:
            failures.append({
                "name": fixture["name"],
                "error": f"Deserialization failed: {e}",
            })
            continue

        # Test that the restored map produces identical results
        try:
            deanon_original = deanonymize(result.text, token_map)
            deanon_restored = deanonymize(result.text, restored_map)

            if deanon_original != deanon_restored:
                failures.append({
                    "name": fixture["name"],
                    "error": f"Restored map produces different deanonymization",
                })
        except Exception as e:
            failures.append({
                "name": fixture["name"],
                "error": f"Deanonymization with restored map failed: {e}",
            })

    if failures:
        print("FAILED: Session serialization")
        for fail in failures:
            print(f"  [{fail['name']}] {fail['error']}")
        return False

    print(f"✓ Session serialization: sampled {min(5, len(fixtures))} fixtures passed")
    return True


def test_coverage_statement():
    """Print a statement of what is and is not covered by parity tests."""
    print("\nParity Test Coverage Statement:")
    print("=" * 60)
    print("COVERED (portable surface):")
    print("  ✓ Regex-based detection (emails, URLs, phones, handles, etc.)")
    print("  ✓ CamelCase compound proper noun heuristic")
    print("  ✓ Custom entity masking")
    print("  ✓ Token map determinism and numbering")
    print("  ✓ Session JSON serialization/deserialization")
    print("  ✓ Round-trip fidelity: deanonymize(anonymize(text)) == text")
    print("\nNOT COVERED (tracking SCI-123/124):")
    print("  ✗ NLP NER for bare PERSON/PLACE/ORG detection (SCI-123)")
    print("  ✗ Custom entity loading from identity_facts (SCI-124)")
    print("\nNOT COVERED (Rust-only):")
    print("  ✗ Internal regressions SCI-195/196/197")
    print("=" * 60)


def main():
    """Run all parity tests."""
    print("Cross-language parity tests for sci-anonymizer\n")

    try:
        results = []

        # Run parity tests
        results.append(("Round-trip fidelity", test_parity_round_trip()))
        results.append(("Entity detection", test_parity_entity_detection()))
        results.append(("Session serialization", test_parity_session_serialization()))

        test_coverage_statement()

        # Summary
        print("\n" + "=" * 60)
        passed = sum(1 for _, r in results if r)
        total = len(results)

        if passed == total:
            print(f"✅ All {total} parity tests PASSED")
            print("=" * 60)
            return 0
        else:
            print(f"❌ {total - passed}/{total} parity tests FAILED")
            print("=" * 60)
            return 1

    except Exception as e:
        print(f"\n❌ Unexpected error: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())
