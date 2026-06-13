"""Type stubs for sci_anonymizer — PyO3 bindings for entity anonymization."""

from enum import Enum
from typing import Optional, List

# Session format version constant
SESSION_FORMAT_VERSION: int

class EntityType(Enum):
    """Classification of detected entity types.

    Variants:
        Person: Named person
        Place: Named location/geography
        Org: Named organization
        Project: Project or product name
        Email: Email address
        Phone: Phone number
        Url: URL or web address
        Handle: Social media handle
        Secret: API key, password, or credential
        IpAddress: IP address (v4 or v6)
    """

    Person: EntityType
    Place: EntityType
    Org: EntityType
    Project: EntityType
    Email: EntityType
    Phone: EntityType
    Url: EntityType
    Handle: EntityType
    Secret: EntityType
    IpAddress: EntityType

    @staticmethod
    def token_prefix(entity_type: EntityType) -> str:
        """Get the token prefix for this entity type.

        Examples:
            token_prefix(EntityType.Person) -> "PERSON_"
            token_prefix(EntityType.Email) -> "EMAIL_"
        """
        ...

class Entity:
    """A detected entity span with its text and type."""

    text: str
    entity_type: EntityType

    def __init__(self, text: str, entity_type: EntityType) -> None:
        """Create a new Entity.

        Args:
            text: The entity text (e.g., "casey@example.com")
            entity_type: The classification of the entity
        """
        ...

class TokenMap:
    """Bidirectional entity ↔ token mapping.

    Used to track which tokens correspond to which entities,
    enabling reversible anonymization (anonymize → infer → deanonymize).
    """

    def __new__(cls) -> TokenMap:
        """Create a new empty TokenMap."""
        ...

    def __len__(self) -> int:
        """Get the number of entities in this map."""
        ...

    def to_session_json(self) -> str:
        """Serialize this map into a versioned JSON string.

        Returns:
            A JSON string with version envelope (version + token map data).

        Raises:
            ValueError: If serialization fails.
        """
        ...

    @staticmethod
    def from_session_json(json_str: str) -> TokenMap:
        """Parse a versioned JSON string back into a TokenMap.

        Args:
            json_str: A JSON string previously created by to_session_json().

        Returns:
            The deserialized TokenMap.

        Raises:
            ValueError: If JSON is malformed or the version is unsupported
                (version > SESSION_FORMAT_VERSION).
        """
        ...

class AnonymizeResult:
    """Result of anonymization operations."""

    text: str
    """The masked text with entities replaced by tokens."""

    token_map: TokenMap
    """The updated TokenMap (forward and reverse mappings)."""

    entity_count: int
    """Number of entities detected and masked."""

    entities: List[Entity]
    """List of detected entities."""

def anonymize(
    text: str,
    existing: Optional[TokenMap] = None,
) -> AnonymizeResult:
    """Detect entities in text and replace them with stable placeholder tokens.

    Uses the built-in detectors (regex for emails/URLs/phones, CamelCase heuristics).

    Args:
        text: The input string to anonymize.
        existing: Optional TokenMap to extend so the same entity keeps the same
                 token across turns. None starts a fresh session.

    Returns:
        AnonymizeResult with masked text, updated token_map, entity_count,
        and detected entities.

    Example:
        >>> result = anonymize("Email casey@example.com about the Acme deal")
        >>> print(result.text)
        Email EMAIL_1 about the PROJECT_1 deal
        >>> # Send result.text to LLM, then:
        >>> restored = deanonymize(model_reply, result.token_map)
    """
    ...

def anonymize_with_custom(
    text: str,
    existing: Optional[TokenMap] = None,
    custom_entities: Optional[List[Entity]] = None,
) -> AnonymizeResult:
    """Anonymize with caller-supplied custom entities in addition to built-in detectors.

    Args:
        text: The input string to anonymize.
        existing: Optional TokenMap to extend. None starts a fresh session.
        custom_entities: List of Entity objects to mask in addition to detected ones.
                        Useful for domain-specific terms (e.g., internal project codes).

    Returns:
        AnonymizeResult with masked text, updated token_map, entity_count,
        and detected entities (including custom ones).
    """
    ...

def deanonymize(text: str, token_map: TokenMap) -> str:
    """Reverse substitution: replace placeholder tokens with real entities.

    The inverse of anonymize(). For round-trip fidelity:
    deanonymize(anonymize(text).text, map) == text

    Args:
        text: The masked text containing placeholder tokens (e.g., "EMAIL_1").
        token_map: The TokenMap from the anonymize() call.

    Returns:
        The restored text with real entities in place of tokens.

    Example:
        >>> result = anonymize("Email casey@example.com")
        >>> masked = result.text
        >>> restored = deanonymize(masked, result.token_map)
        >>> assert restored == "Email casey@example.com"
    """
    ...

def build_token_map(
    entities: List[Entity],
    existing: Optional[TokenMap] = None,
) -> TokenMap:
    """Build or extend a TokenMap from detected entities with deterministic numbering.

    Lower-level building block used internally by anonymize(). Call this if you
    want to construct a token map from entities you've extracted yourself.

    Args:
        entities: List of Entity objects.
        existing: Optional TokenMap to extend. None starts fresh.

    Returns:
        The resulting TokenMap with numbering per entity type
        (e.g., PERSON_1, PERSON_2, EMAIL_1, etc.).
    """
    ...

def apply_token_map(text: str, token_map: TokenMap) -> str:
    """Apply a TokenMap's forward substitutions to text (entity → token).

    Lower-level building block used internally by anonymize(). Call this if you
    want to apply a token map after building it separately.

    Args:
        text: The original text containing real entities.
        token_map: The TokenMap to apply.

    Returns:
        Text with entities replaced by tokens (case-insensitive, word-boundary safe).
    """
    ...

def get_tech_allowlist() -> List[str]:
    """Get the tech allowlist as a list of allowlisted terms.

    These are case-sensitive proper nouns (frameworks, languages, SaaS names)
    that should not be masked during anonymization.

    Returns:
        A list of strings representing the tech allowlist.

    Example:
        >>> allowlist = get_tech_allowlist()
        >>> "Python" in allowlist
        True
    """
    ...
