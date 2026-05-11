//! Token map plumbing: types + build / apply / deanonymize.
//!
//! TS reference: packages/core/src/anonymizer.ts §"Token substitution"
//! through §"Public API".

use crate::regex_extract::{extract_camelcase_entities, extract_regex_entities};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// Entity classifications. Names mirror the TS `EntityType` literal union
/// exactly so wire-format messages and serialized fixtures travel
/// unchanged across the language boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum EntityType {
    Person,
    Place,
    Org,
    Project,
    Email,
    Phone,
    Url,
    Handle,
}

impl EntityType {
    /// Token prefix used in `[PERSON_1]`, `[URL_3]`, etc. The TS
    /// implementation builds these from the literal type name; we do the
    /// same so token strings round-trip across the boundary identically.
    pub fn token_prefix(self) -> &'static str {
        match self {
            EntityType::Person  => "PERSON",
            EntityType::Place   => "PLACE",
            EntityType::Org     => "ORG",
            EntityType::Project => "PROJECT",
            EntityType::Email   => "EMAIL",
            EntityType::Phone   => "PHONE",
            EntityType::Url     => "URL",
            EntityType::Handle  => "HANDLE",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entity {
    pub text: String,
    #[serde(rename = "type")]
    pub entity_type: EntityType,
}

/// Bidirectional entity ↔ token map. Mirrors the TS `TokenMap` shape
/// (forward + reverse). Both directions are needed: forward to mask
/// outbound prompts, reverse to deanonymize streamed responses.
///
/// Insertion order matters for deterministic numbering — `forward`
/// uses an `IndexMap`-shaped invariant where the *first* time we see
/// an entity decides its token. We use plain `HashMap` for storage and
/// rely on the Vec-of-keys we maintain for ordering during builds.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TokenMap {
    pub forward: HashMap<String, String>,
    pub reverse: HashMap<String, String>,
}

impl TokenMap {
    pub fn new() -> Self { Self::default() }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnonymizeResult {
    pub text: String,
    #[serde(rename = "tokenMap")]
    pub token_map: TokenMap,
    #[serde(rename = "entityCount")]
    pub entity_count: usize,
    pub detected: Vec<Entity>,
}

// ── Build ──────────────────────────────────────────────────────────────────
//
// Counter rule: we recover `[TYPE_N]` numbering from the existing token
// map's reverse keys before assigning new tokens. That way an existing
// session map keeps numbering monotonically (same as TS) when a follow-up
// call brings in new entities.

pub fn build_token_map(entities: &[Entity], existing: Option<TokenMap>) -> TokenMap {
    let mut map = existing.unwrap_or_default();

    // Reconstruct counters from any tokens already in `reverse`.
    let counter_re = regex::Regex::new(r"\[([A-Z]+)_(\d+)\]").unwrap();
    let mut counters: HashMap<String, u32> = HashMap::new();
    for token in map.reverse.keys() {
        if let Some(c) = counter_re.captures(token) {
            let prefix = c[1].to_string();
            let n: u32 = c[2].parse().unwrap_or(0);
            let entry = counters.entry(prefix).or_insert(0);
            if n > *entry { *entry = n; }
        }
    }

    for entity in entities {
        if map.forward.contains_key(&entity.text) {
            continue;
        }

        // TS does case-insensitive de-dup against existing forward keys —
        // if "Casey" already maps to PERSON_1 and a new call has "casey",
        // both should land on the same token.
        let lower = entity.text.to_lowercase();
        let existing_token = map
            .forward
            .iter()
            .find(|(k, _)| k.to_lowercase() == lower)
            .map(|(_, v)| v.clone());
        if let Some(t) = existing_token {
            map.forward.insert(entity.text.clone(), t);
            continue;
        }

        let prefix = entity.entity_type.token_prefix();
        let n = counters.get(prefix).copied().unwrap_or(0) + 1;
        counters.insert(prefix.to_string(), n);

        let token = format!("[{prefix}_{n}]");
        map.forward.insert(entity.text.clone(), token.clone());
        map.reverse.insert(token, entity.text.clone());
    }

    map
}

// ── Apply ──────────────────────────────────────────────────────────────────
//
// TS uses a JS RegExp with case-insensitive replacement bounded by
// `(?<![\w@/])` … `(?![\w])`. That lookbehind prevents replacing inside
// emails (`@example.com`), file paths (`src/Casey/notes.md`), and other
// adjacent-word cases. Rust's `regex` lacks lookbehind, so we do the
// same by:
//
//   1. Compiling the entity name into a pattern with
//      `(?i)\b<escaped>\b` for the trailing boundary
//   2. Doing the leading-char check by hand in a custom replace loop:
//      reject the match if the byte before it is `[A-Za-z0-9_@/]`.
//
// `\b` in `regex` covers the trailing-word case (no `\w` immediately
// after); the manual check covers leading.

pub fn apply_token_map(text: &str, token_map: &TokenMap) -> String {
    // Sort entries by entity length, descending — the TS code does this
    // so longer names ("Casey Zandbergen") replace before shorter ones
    // ("Casey") and we don't end up with "[PERSON_2] Zandbergen".
    let mut entries: Vec<(&String, &String)> = token_map.forward.iter().collect();
    // Descending length: longer entities replace first so "Casey Zandbergen"
    // becomes [PERSON_1] before "Casey" gets a shot.
    entries.sort_by_key(|(k, _)| std::cmp::Reverse(k.len()));

    let mut result = text.to_string();
    for (entity, token) in entries {
        let escaped = regex::escape(entity);
        // (?i) — case insensitive, matching the TS RegExp `gi` flag.
        // `\b` at the end gives the trailing word boundary; leading
        // boundary is enforced manually below.
        let pat = format!(r"(?i){escaped}\b");
        let re = match regex::Regex::new(&pat) {
            Ok(r) => r,
            Err(_) => continue, // pathologically bad entity names — skip
        };

        // Walk the matches manually so we can inspect the byte before
        // each one. `Regex::replace_all` doesn't expose enough context.
        let mut out = String::with_capacity(result.len());
        let mut last = 0usize;
        for m in re.find_iter(&result) {
            let start = m.start();
            let prev_ok = if start == 0 {
                true
            } else {
                // Walk back to a UTF-8 char boundary before reading the byte.
                let mut p = start - 1;
                while !result.is_char_boundary(p) && p > 0 { p -= 1; }
                let b = result.as_bytes()[p];
                !(b.is_ascii_alphanumeric() || b == b'_' || b == b'@' || b == b'/')
            };
            if !prev_ok {
                continue;
            }
            out.push_str(&result[last..start]);
            out.push_str(token);
            last = m.end();
        }
        out.push_str(&result[last..]);
        result = out;
    }
    result
}

// ── Deanonymize ────────────────────────────────────────────────────────────

static UNMAPPED_PLACEHOLDER_RE: once_cell::sync::Lazy<regex::Regex> =
    once_cell::sync::Lazy::new(|| {
        // Bracketed uppercase prefix + underscore + digits. Same
        // shape the build pass emits. Not anchored to a known
        // type-prefix list so new entity kinds don't slip past
        // the diagnostic.
        regex::Regex::new(r"\[([A-Z]+)_(\d+)\]").unwrap()
    });

static POISONED_ORIGINAL_RE: once_cell::sync::Lazy<regex::Regex> =
    once_cell::sync::Lazy::new(|| {
        // SCI-195: matches anonymizer placeholder shapes appearing
        // INSIDE a `reverse` map's `original` string — the smoking
        // gun of a poisoned row. We refuse to substitute these so
        // historical poison can't continue corrupting output.
        regex::Regex::new(r"\[[A-Z]+_\d+\]?").unwrap()
    });

pub fn deanonymize(text: &str, token_map: &TokenMap) -> String {
    // Sort tokens by length descending — same reason as apply: longer
    // tokens like `[PERSON_10]` need to swap before `[PERSON_1]` so the
    // latter doesn't claim a substring of the former.
    let mut tokens: Vec<&String> = token_map.reverse.keys().collect();
    tokens.sort_by_key(|t| std::cmp::Reverse(t.len()));

    let mut result = text.to_string();
    let mut poisoned_skipped: HashSet<String> = HashSet::new();
    for token in tokens {
        if let Some(entity) = token_map.reverse.get(token) {
            // SCI-195 defense: if the mapped `original` contains a
            // placeholder-shaped substring, it's a poisoned row —
            // substituting it would land literal `[TYPE_N]` text in
            // the deanonymized output. Skip + WARN.
            if POISONED_ORIGINAL_RE.is_match(entity) {
                if poisoned_skipped.insert(token.clone()) {
                    let preview: String = entity.chars().take(60).collect();
                    tracing::warn!(
                        target  = "sci_anonymizer::deanonymize",
                        token   = token.as_str(),
                        original_preview = preview.as_str(),
                        "deanonymize: skipping poisoned reverse-map entry (original contains placeholder syntax); SCI-195"
                    );
                }
                continue;
            }
            result = result.replace(token.as_str(), entity);
        }
    }

    // SCI-197 diagnostic: any [TYPE_N]-shaped placeholder still in
    // the output is either (a) a model-emitted token that wasn't in
    // this turn's map (the corruption-of-code failure mode that
    // SCI-197 tracks), or (b) the user talking about the anonymizer
    // itself. Either way we leave it verbatim — silently rewriting
    // unmapped tokens would be worse — but we log a WARN per
    // distinct token so the audit + tail tools surface the signal.
    let mut warned: HashSet<String> = HashSet::new();
    for cap in UNMAPPED_PLACEHOLDER_RE.captures_iter(&result) {
        let token = cap.get(0).unwrap().as_str();
        if warned.insert(token.to_string()) {
            tracing::warn!(
                target = "sci_anonymizer::deanonymize",
                token  = token,
                prefix = &cap[1],
                "deanonymize: model emitted unmapped placeholder token; leaving verbatim (SCI-197 if seen in generated code)"
            );
        }
    }

    result
}

// ── Public API ─────────────────────────────────────────────────────────────

/// Synchronous anonymize — regex + CamelCase only. NLP NER (PERSON /
/// PLACE / ORG via compromise.js in TS) is tracked as SCI-123; until
/// it lands, this function omits those classes. Custom entities loaded
/// from `identity_facts` are SCI-124 and should be passed in via
/// `extra_known` once `sci-memory` exposes that loader.
/// Anonymize a prompt with caller-supplied custom entities mixed in.
///
/// Use this when the caller has already loaded `identity_facts` from
/// the storage adapter and passed them through
/// `extract_entities_from_facts` — typically via the platform shell
/// or a request-time middleware. Custom entities are checked
/// **proactively**, so even single-cap project names like
/// `"Threadline"` (which the deterministic + NER passes can't catch
/// on their own) get masked. They take priority over the NER pass:
/// if a token is in the custom set, we tag it with the custom entity's
/// type (typically PROJECT or ORG) rather than letting NER tag it as
/// PERSON or PLACE.
///
/// Mirrors the role of `anonymizeAsync` in `packages/core/src/anonymizer.ts`,
/// minus the async loader piece — the loader call belongs to the
/// platform shell, this function is pure.
pub fn anonymize_with_custom(
    text:     &str,
    existing: Option<TokenMap>,
    custom:   &[Entity],
) -> AnonymizeResult {
    let regex_entities = extract_regex_entities(text);

    // Build the proactive-known set from regex + custom hits. NER
    // honors this — it won't tag a token as PERSON if the custom set
    // has it as a PROJECT/ORG.
    let regex_text_keys: HashSet<String> = regex_entities
        .iter()
        .chain(custom.iter())
        .map(|e| e.text.to_lowercase())
        .collect();

    // The NER pass: filter out anything regex/custom already claimed
    // (matches anonymize() below; just with a richer known-set).
    let nlp_entities: Vec<Entity> = crate::ner::extract_nlp_entities(text)
        .into_iter()
        .filter(|e| !regex_text_keys.contains(&e.text.to_lowercase()))
        .collect();

    // Custom entities only count if they actually appear in the
    // prompt — no point reserving tokens for entities the user hasn't
    // mentioned this turn. Match case-insensitively against the prompt.
    let lower_prompt = text.to_lowercase();
    let custom_present: Vec<Entity> = custom
        .iter()
        .filter(|e| lower_prompt.contains(&e.text.to_lowercase()))
        .cloned()
        .collect();

    // Extend the known-set for CamelCase pass.
    let known: HashSet<String> = regex_entities
        .iter()
        .chain(nlp_entities.iter())
        .chain(custom_present.iter())
        .map(|e| e.text.to_lowercase())
        .collect();
    let camel_entities = extract_camelcase_entities(text, &known);

    let mut all_entities = Vec::with_capacity(
        regex_entities.len()
            + nlp_entities.len()
            + custom_present.len()
            + camel_entities.len(),
    );
    all_entities.extend(regex_entities);
    all_entities.extend(nlp_entities);
    all_entities.extend(custom_present);
    all_entities.extend(camel_entities);

    let token_map = build_token_map(&all_entities, existing);
    let text_out = apply_token_map(text, &token_map);

    AnonymizeResult {
        entity_count: all_entities.len(),
        detected:     all_entities,
        token_map,
        text:         text_out,
    }
}

pub fn anonymize(text: &str, existing: Option<TokenMap>) -> AnonymizeResult {
    // Pass 1: deterministic regex (URLs, emails, phones, handles).
    let regex_entities = extract_regex_entities(text);

    // Pass 2 (SCI-123): lexicon + grammar NER for PERSON / PLACE / ORG.
    // Filter entities the regex pass already claimed by lower-case
    // surface — `bob@example.com` shouldn't also match a separate
    // PERSON for "bob" inside it. Single-word PERSON candidates whose
    // lowercase form already appears in the regex set get dropped.
    let regex_text_keys: HashSet<String> = regex_entities
        .iter()
        .map(|e| e.text.to_lowercase())
        .collect();
    let nlp_entities: Vec<crate::token_map::Entity> = crate::ner::extract_nlp_entities(text)
        .into_iter()
        .filter(|e| !regex_text_keys.contains(&e.text.to_lowercase()))
        .collect();

    // Pass 3 (custom entities) — gets merged in by `anonymize_with_custom`
    // when SCI-124 lands. The deterministic `anonymize` skips it.

    // Pass 4: CamelCase. Already filters known regex hits; extend the
    // known-set with NLP hits so we don't double-claim "OpenClaw" as
    // both PROJECT and PERSON.
    let known: HashSet<String> = regex_entities
        .iter()
        .chain(nlp_entities.iter())
        .map(|e| e.text.to_lowercase())
        .collect();
    let camel_entities = extract_camelcase_entities(text, &known);

    let mut all_entities =
        Vec::with_capacity(regex_entities.len() + nlp_entities.len() + camel_entities.len());
    all_entities.extend(regex_entities);
    all_entities.extend(nlp_entities);
    all_entities.extend(camel_entities);

    let token_map = build_token_map(&all_entities, existing);
    let text_out = apply_token_map(text, &token_map);

    AnonymizeResult {
        entity_count: all_entities.len(),
        detected: all_entities,
        token_map,
        text: text_out,
    }
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use indoc::indoc;

    #[test]
    fn masks_email_and_url() {
        let r = anonymize("contact me at casey@sci.com or https://sci.com/about", None);
        assert!(r.text.contains("[EMAIL_"));
        assert!(r.text.contains("[URL_"));
        assert!(!r.text.contains("casey@sci.com"));
        assert!(!r.text.contains("https://sci.com"));
    }

    #[test]
    fn masks_camelcase_project() {
        // CamelCase pass should catch `OpenClaw`. `MacBook` is in the
        // allowlist and must NOT be masked.
        let r = anonymize("OpenClaw runs on a MacBook", None);
        assert!(r.text.contains("[PROJECT_"));
        assert!(r.text.contains("MacBook"));
    }

    #[test]
    fn deanonymize_round_trips() {
        let original = "send to bob@example.com and visit https://example.com";
        let r = anonymize(original, None);
        let restored = deanonymize(&r.text, &r.token_map);
        assert_eq!(restored, original);
    }

    #[test]
    fn does_not_mask_inside_email_local_part() {
        // The `@` lookbehind in the bare-domain regex is the reason
        // `example.com` inside `bob@example.com` doesn't get a separate
        // [URL_] token. Manually enforcing this in the Rust port is the
        // whole reason `not_preceded_by` exists — make sure it actually
        // works.
        let r = anonymize("ping bob@example.com", None);
        // exactly one mask (the email); no separate URL token
        assert_eq!(r.entity_count, 1, "got: {:?}", r.detected);
    }

    #[test]
    fn token_numbering_is_stable_across_calls() {
        // First call seeds the map with [URL_1]; second call sees
        // a new domain and gets [URL_2], not a fresh [URL_1].
        let r1 = anonymize("see https://one.com", None);
        let r2 = anonymize("see https://two.com", Some(r1.token_map));
        assert!(r2.text.contains("[URL_2]"));
    }

    #[test]
    fn camelcase_skips_allowlisted_words() {
        // `LinkedIn` matches the CamelCase regex but is allowlisted —
        // shouldn't get a token.
        let r = anonymize("post on LinkedIn about it", None);
        assert_eq!(r.entity_count, 0, "got: {:?}", r.detected);
    }

    #[test]
    fn custom_entity_masks_singlecap_project() {
        // The whole point of SCI-124: "Threadline" — single-cap, not
        // a CamelCase compound, not in any lexicon, not allowlisted.
        // Without a custom hint, no pass would catch it. With a
        // hint, it gets PROJECT_1.
        let custom = vec![Entity {
            text:        "Threadline".to_string(),
            entity_type: EntityType::Project,
        }];
        let r = anonymize_with_custom(
            "We're shipping Threadline this week.",
            None,
            &custom,
        );
        assert!(r.text.contains("[PROJECT_1]"), "got: {:?}", r.text);
        assert!(!r.text.contains("Threadline"));
    }

    #[test]
    fn custom_entity_not_in_prompt_is_unused() {
        // Custom set includes Threadline, but the prompt doesn't
        // mention it. We shouldn't allocate a token for an entity
        // that never appears.
        let custom = vec![Entity {
            text:        "Threadline".to_string(),
            entity_type: EntityType::Project,
        }];
        let r = anonymize_with_custom("hello world", None, &custom);
        assert_eq!(r.entity_count, 0);
        assert!(!r.text.contains("PROJECT"));
    }

    #[test]
    fn custom_entity_preempts_ner_person_tag() {
        // "Casey" is in the first-name lexicon → would normally be
        // PERSON. With Casey in the custom set as PROJECT (silly but
        // tests the precedence), the custom tag wins.
        let custom = vec![Entity {
            text:        "Casey".to_string(),
            entity_type: EntityType::Project,
        }];
        let r = anonymize_with_custom("Casey works on this", None, &custom);
        // We expect PROJECT_1 not PERSON_1.
        assert!(r.text.contains("[PROJECT_1]"), "got: {:?}", r.text);
        assert!(!r.text.contains("[PERSON_"));
    }

    #[test]
    fn realistic_session_prompt() {
        // Mirrors the SCI-117 smoke test prompt that anonymized as
        // [URL_1]←sci.com  [PERSON_1]←Casey Zandbergen on the TS side.
        // SCI-123 added NLP NER, so we now match the TS behavior:
        // both sci.com (URL) and Casey Zandbergen (PERSON) get masked.
        let r = anonymize(
            indoc! {"
                Hi! My name is Casey Zandbergen and I work on Sci, a
                sovereign cognitive identity layer at sci.com. Reply
                with one short sentence acknowledging me by name.
            "},
            None,
        );
        let person_hits: Vec<_> = r
            .detected
            .iter()
            .filter(|e| e.entity_type == EntityType::Person)
            .map(|e| e.text.as_str())
            .collect();
        assert!(
            person_hits.contains(&"Casey Zandbergen"),
            "expected Casey Zandbergen to be tagged PERSON; got {:?}",
            r.detected,
        );
        assert!(r.text.contains("[URL_1]"), "URL_1 missing in: {:?}", r.text);
        assert!(r.text.contains("[PERSON_1]"), "PERSON_1 missing in: {:?}", r.text);
    }
}
