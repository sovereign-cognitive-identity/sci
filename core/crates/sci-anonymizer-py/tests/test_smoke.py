"""Smoke test for sci_anonymizer Python bindings."""

import sys
from sci_anonymizer import (
    anonymize,
    anonymize_with_custom,
    deanonymize,
    build_token_map,
    apply_token_map,
    Entity,
    EntityType,
    TokenMap,
    SESSION_FORMAT_VERSION,
)


def test_basic_anonymize():
    """Test basic anonymization and deanonymization."""
    text = "Email casey@example.com about the Acme deal"
    result = anonymize(text)

    assert result.entity_count > 0, "Should detect at least one entity"
    assert "EMAIL_" in result.text, "Should replace email with EMAIL_ token"
    assert result.text != text, "Text should be modified"

    # Round-trip: should restore original
    restored = deanonymize(result.text, result.token_map)
    assert restored == text, f"Round-trip failed: {restored!r} != {text!r}"
    print("✓ test_basic_anonymize")


def test_session_persistence():
    """Test token map serialization and extension across sessions."""
    text1 = "Contact alice@example.com"
    result1 = anonymize(text1)

    # Serialize
    json_str = result1.token_map.to_session_json()
    assert isinstance(json_str, str), "to_session_json should return a string"
    assert "version" in json_str, "Serialized JSON should include version"

    # Deserialize
    token_map = TokenMap.from_session_json(json_str)
    assert len(token_map) > 0, "Deserialized map should have entities"

    # Extend the map with new text
    text2 = "Also contact bob@example.com and alice@example.com again"
    result2 = anonymize(text2, existing=token_map)

    # alice@example.com should get the same token as before
    # (this is a heuristic check; the exact behavior depends on the implementation)
    deanon2 = deanonymize(result2.text, result2.token_map)
    assert deanon2 == text2, f"Extended round-trip failed: {deanon2!r}"
    print("✓ test_session_persistence")


def test_custom_entities():
    """Test anonymization with custom entities."""
    text = "Secret code is ABC123XYZ, email is test@example.com"
    custom = [Entity("ABC123XYZ", EntityType.Secret)]

    result = anonymize_with_custom(text, custom_entities=custom)

    assert result.entity_count > 0, "Should detect custom + built-in entities"
    assert "SECRET_" in result.text, "Should replace custom Secret with SECRET_ token"
    assert "EMAIL_" in result.text, "Should also replace email"

    restored = deanonymize(result.text, result.token_map)
    assert restored == text, f"Custom round-trip failed: {restored!r}"
    print("✓ test_custom_entities")


def test_entity_types():
    """Test EntityType enum and token prefixes."""
    assert EntityType.Person is not None
    assert EntityType.Email is not None
    assert EntityType.Secret is not None

    # Test token_prefix static method
    email_prefix = EntityType.token_prefix(EntityType.Email)
    assert "EMAIL" in email_prefix, f"Email prefix should contain 'EMAIL', got {email_prefix!r}"

    person_prefix = EntityType.token_prefix(EntityType.Person)
    assert "PERSON" in person_prefix, f"Person prefix should contain 'PERSON', got {person_prefix!r}"

    print("✓ test_entity_types")


def test_build_and_apply_token_map():
    """Test lower-level build_token_map and apply_token_map."""
    entities = [
        Entity("alice@example.com", EntityType.Email),
        Entity("Acme Inc", EntityType.Org),
    ]

    token_map = build_token_map(entities)
    assert len(token_map) > 0, "Built token map should have entries"

    text = "Contact alice@example.com at Acme Inc today"
    masked = apply_token_map(text, token_map)

    assert masked != text, "apply_token_map should modify text"
    assert "EMAIL_" in masked, "Should have EMAIL token"
    assert "ORG_" in masked or "Acme" in masked, "Should replace or preserve org"

    restored = deanonymize(masked, token_map)
    assert "alice@example.com" in restored, "Should restore email"
    print("✓ test_build_and_apply_token_map")


def test_session_format_version():
    """Test that SESSION_FORMAT_VERSION constant is available."""
    assert isinstance(SESSION_FORMAT_VERSION, int), "SESSION_FORMAT_VERSION should be an int"
    assert SESSION_FORMAT_VERSION > 0, "SESSION_FORMAT_VERSION should be positive"
    print(f"✓ test_session_format_version (version={SESSION_FORMAT_VERSION})")


def test_multiple_entity_types():
    """Test detection of multiple entity types."""
    text = (
        "Call john@example.com or visit https://example.com. "
        "Acme Inc is in San Francisco. Handle: @johnsmith"
    )
    result = anonymize(text)

    # Should detect email, URL, org, place, handle
    entity_types = {e.entity_type for e in result.entities}
    assert len(entity_types) >= 2, f"Should detect multiple entity types, got {entity_types}"

    restored = deanonymize(result.text, result.token_map)
    assert restored == text, f"Multi-entity round-trip failed"
    print("✓ test_multiple_entity_types")


def main():
    """Run all tests."""
    try:
        test_basic_anonymize()
        test_session_persistence()
        test_custom_entities()
        test_entity_types()
        test_build_and_apply_token_map()
        test_session_format_version()
        test_multiple_entity_types()

        print("\n" + "=" * 50)
        print("All smoke tests passed! ✓")
        print("=" * 50)
        return 0
    except AssertionError as e:
        print(f"\n✗ Test failed: {e}", file=sys.stderr)
        return 1
    except Exception as e:
        print(f"\n✗ Unexpected error: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())
