//! Unit tests for the storage layer.
//!
//! Embeddings are synthesized as 768-dim vectors (filled deterministically
//! from a tiny seed) — the embedding model lives in a separate crate
//! (SCI-130). What we're testing here is the *storage and recall* shape:
//! schema applies, CRUD works, brute-force cosine returns the right
//! ranking, RRF merges across types, etc.

use super::*;

/// Deterministic synthetic embeddings: dim coordinates set from the
/// hash of (seed, index). Nearly orthogonal between distinct seeds,
/// identical for identical seeds. Good enough to exercise the cosine
/// math without dragging in a real embedder.
fn synth_embedding(seed: u64) -> Vec<f32> {
    let mut v = Vec::with_capacity(EMBEDDING_DIM);
    let mut x = seed.wrapping_mul(2_862_933_555_777_941_757);
    for i in 0..EMBEDDING_DIM {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        let coord = ((x.wrapping_add(i as u64) as u32) as f32 / u32::MAX as f32) - 0.5;
        v.push(coord);
    }
    v
}

fn open() -> LocalAdapter {
    LocalAdapter::open_in_memory().expect("in-mem adapter")
}

#[test]
fn schema_applies_and_seeds_default_profiles() {
    let a = open();
    let names: Vec<String> = a.list_profiles().unwrap().into_iter().map(|p| p.name).collect();
    assert!(names.contains(&"work".to_string()));
    assert!(names.contains(&"personal".to_string()));
}

#[test]
fn get_profile_returns_none_for_unknown() {
    let a = open();
    assert!(a.get_profile("nonexistent").unwrap().is_none());
}

#[test]
fn create_profile_is_idempotent() {
    let a = open();
    let p1 = a.create_profile("dogfood").unwrap();
    let p2 = a.create_profile("dogfood").unwrap();
    assert_eq!(p1.id, p2.id);
}

#[test]
fn rejects_wrong_dim_embedding() {
    let a = open();
    let work = a.get_profile("work").unwrap().unwrap();
    let bad: Vec<f32> = vec![0.0; 100]; // way off from EMBEDDING_DIM
    let r = a.store_episodic(&StoreEpisodicInput {
        profile_id: &work.id,
        content:    "test",
        embedding:  &bad,
        source:     None,
        agent_id:   None,
        metadata:   Default::default(),
    });
    assert!(matches!(r, Err(MemoryError::EmbeddingDim { .. })));
}

#[test]
fn store_episodic_then_recall_finds_it() {
    let a = open();
    let work = a.get_profile("work").unwrap().unwrap();
    let emb  = synth_embedding(42);

    a.store_episodic(&StoreEpisodicInput {
        profile_id: &work.id,
        content:    "Casey ships sci tomorrow",
        embedding:  &emb,
        source:     Some("test"),
        agent_id:   None,
        metadata:   Default::default(),
    })
    .unwrap();

    // Recall with the same embedding — should be a near-perfect cosine = 1.0.
    let hits = a
        .recall(&RecallQuery {
            query_embedding: &emb,
            query:           "ships",
            profile_id:      &work.id,
            limit:           5,
            types:           &[RecallType::Episodic],
        })
        .unwrap();

    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].kind, RecallType::Episodic);
    assert_eq!(hits[0].content, "Casey ships sci tomorrow");
}

#[test]
fn recall_ranks_close_embeddings_above_far_ones() {
    let a = open();
    let work = a.get_profile("work").unwrap().unwrap();
    let target = synth_embedding(1);
    let near   = synth_embedding(1); // identical seed → identical vector
    let far    = synth_embedding(99);

    a.store_episodic(&StoreEpisodicInput {
        profile_id: &work.id,
        content:    "near",
        embedding:  &near,
        source:     None,
        agent_id:   None,
        metadata:   Default::default(),
    })
    .unwrap();
    a.store_episodic(&StoreEpisodicInput {
        profile_id: &work.id,
        content:    "far",
        embedding:  &far,
        source:     None,
        agent_id:   None,
        metadata:   Default::default(),
    })
    .unwrap();

    let hits = a
        .recall(&RecallQuery {
            query_embedding: &target,
            query:           "",
            profile_id:      &work.id,
            limit:           10,
            types:           &[RecallType::Episodic],
        })
        .unwrap();

    assert_eq!(hits.len(), 2);
    assert_eq!(hits[0].content, "near", "near vector should rank first");
}

#[test]
fn recall_filters_by_profile() {
    let a = open();
    let work     = a.get_profile("work").unwrap().unwrap();
    let personal = a.get_profile("personal").unwrap().unwrap();
    let emb      = synth_embedding(7);

    a.store_episodic(&StoreEpisodicInput {
        profile_id: &work.id,
        content:    "work memory",
        embedding:  &emb,
        source:     None,
        agent_id:   None,
        metadata:   Default::default(),
    })
    .unwrap();
    a.store_episodic(&StoreEpisodicInput {
        profile_id: &personal.id,
        content:    "personal memory",
        embedding:  &emb,
        source:     None,
        agent_id:   None,
        metadata:   Default::default(),
    })
    .unwrap();

    // Recall via the work profile should only return the work row.
    let work_hits = a
        .recall(&RecallQuery {
            query_embedding: &emb,
            query:           "",
            profile_id:      &work.id,
            limit:           10,
            types:           &[RecallType::Episodic],
        })
        .unwrap();
    assert_eq!(work_hits.len(), 1);
    assert_eq!(work_hits[0].content, "work memory");
}

#[test]
fn recall_merges_across_memory_types() {
    let a = open();
    let work = a.get_profile("work").unwrap().unwrap();
    let emb  = synth_embedding(3);

    a.store_episodic(&StoreEpisodicInput {
        profile_id: &work.id,
        content:    "ep",
        embedding:  &emb,
        source:     None,
        agent_id:   None,
        metadata:   Default::default(),
    })
    .unwrap();
    a.store_semantic(&StoreSemanticInput {
        profile_id: &work.id,
        content:    "sem",
        embedding:  &emb,
        category:   None,
        confidence: None,
        metadata:   Default::default(),
    })
    .unwrap();
    a.store_identity_fact(&StoreIdentityInput {
        content:    "id",
        embedding:  &emb,
        category:   None,
        confidence: None,
        metadata:   Default::default(),
    })
    .unwrap();

    // Empty types slice → search all three classes.
    let hits = a
        .recall(&RecallQuery {
            query_embedding: &emb,
            query:           "",
            profile_id:      &work.id,
            limit:           10,
            types:           &[],
        })
        .unwrap();
    assert_eq!(hits.len(), 3);
    let kinds: std::collections::HashSet<_> = hits.iter().map(|h| h.kind).collect();
    assert!(kinds.contains(&RecallType::Episodic));
    assert!(kinds.contains(&RecallType::Semantic));
    assert!(kinds.contains(&RecallType::Identity));
}

#[test]
fn keyword_boost_breaks_score_ties() {
    let a = open();
    let work = a.get_profile("work").unwrap().unwrap();

    // Two stored memories with identical embeddings — the only thing
    // separating their scores will be the keyword boost.
    let emb = synth_embedding(11);
    a.store_episodic(&StoreEpisodicInput {
        profile_id: &work.id,
        content:    "this row mentions Threadline by name",
        embedding:  &emb,
        source:     None,
        agent_id:   None,
        metadata:   Default::default(),
    })
    .unwrap();
    a.store_episodic(&StoreEpisodicInput {
        profile_id: &work.id,
        content:    "this row says nothing of interest",
        embedding:  &emb,
        source:     None,
        agent_id:   None,
        metadata:   Default::default(),
    })
    .unwrap();

    let hits = a
        .recall(&RecallQuery {
            query_embedding: &emb,
            query:           "Threadline",
            profile_id:      &work.id,
            limit:           10,
            types:           &[RecallType::Episodic],
        })
        .unwrap();
    // Order can be either way before the boost; the boosted one must
    // be first.
    assert_eq!(hits[0].content, "this row mentions Threadline by name");
}

#[test]
fn stats_count_what_was_stored() {
    let a = open();
    let work = a.get_profile("work").unwrap().unwrap();
    let emb  = synth_embedding(5);

    a.store_episodic(&StoreEpisodicInput {
        profile_id: &work.id,
        content:    "a",
        embedding:  &emb,
        source:     None,
        agent_id:   None,
        metadata:   Default::default(),
    })
    .unwrap();
    a.store_semantic(&StoreSemanticInput {
        profile_id: &work.id,
        content:    "b",
        embedding:  &emb,
        category:   None,
        confidence: None,
        metadata:   Default::default(),
    })
    .unwrap();

    let s = a.get_stats().unwrap();
    assert_eq!(s.episodic, 1);
    assert_eq!(s.semantic, 1);
    assert_eq!(s.identity, 0);
    assert_eq!(s.embeddings, 2);
    assert_eq!(s.backend, "sqlite-mem");
}

#[test]
fn query_identity_facts_filters_by_category() {
    let a = open();
    let emb = synth_embedding(13);
    a.store_identity_fact(&StoreIdentityInput {
        content:    "Casey works on Sci",
        embedding:  &emb,
        category:   Some("project"),
        confidence: Some(0.9),
        metadata:   Default::default(),
    })
    .unwrap();
    a.store_identity_fact(&StoreIdentityInput {
        content:    "Casey lives in Tulsa",
        embedding:  &emb,
        category:   Some("location"),
        confidence: Some(0.95),
        metadata:   Default::default(),
    })
    .unwrap();

    let projects = a.query_identity_facts(Some("project"), 10).unwrap();
    assert_eq!(projects.len(), 1);
    assert_eq!(projects[0].content, "Casey works on Sci");

    let all = a.query_identity_facts(None, 10).unwrap();
    assert_eq!(all.len(), 2);
    // Sorted by confidence DESC — location (0.95) before project (0.9).
    assert_eq!(all[0].content, "Casey lives in Tulsa");
}

#[test]
fn opens_persistent_db_and_reopens_with_state() {
    let dir  = tempfile::tempdir().unwrap();
    let path = dir.path().join("sci.db");
    let emb  = synth_embedding(21);

    {
        let a = LocalAdapter::open(&path).unwrap();
        let work = a.get_profile("work").unwrap().unwrap();
        a.store_episodic(&StoreEpisodicInput {
            profile_id: &work.id,
            content:    "persists across reopens",
            embedding:  &emb,
            source:     None,
            agent_id:   None,
            metadata:   Default::default(),
        })
        .unwrap();
        a.close().unwrap();
    }

    let a = LocalAdapter::open(&path).unwrap();
    assert_eq!(a.get_stats().unwrap().episodic, 1);
    let work = a.get_profile("work").unwrap().unwrap();
    let hits = a
        .recall(&RecallQuery {
            query_embedding: &emb,
            query:           "",
            profile_id:      &work.id,
            limit:           5,
            types:           &[RecallType::Episodic],
        })
        .unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].content, "persists across reopens");
}
