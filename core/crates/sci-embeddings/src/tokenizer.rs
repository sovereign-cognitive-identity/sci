//! Thin wrapper around the HuggingFace `tokenizers` crate so the rest of
//! the crate doesn't import it directly.
//!
//! BGE-base-en-v1.5 ships a BERT-style WordPiece tokenizer in
//! `tokenizer.json`; the `tokenizers` crate consumes that file directly.

use crate::error::{EmbeddingError, Result};
use std::path::Path;
use tokenizers::Tokenizer;

/// Output of a single tokenize() call. All three buffers have the same
/// length (the padded sequence length).
pub(crate) struct Encoded {
    pub input_ids:      Vec<i64>,
    pub attention_mask: Vec<i64>,
    pub token_type_ids: Vec<i64>,
    pub seq_len:        usize,
}

pub(crate) struct BgeTokenizer {
    inner: Tokenizer,
}

impl BgeTokenizer {
    pub fn from_file(path: &Path) -> Result<Self> {
        let inner = Tokenizer::from_file(path).map_err(|e| EmbeddingError::Tokenizer(e.to_string()))?;
        Ok(Self { inner })
    }

    /// Encode a single string. BGE-base-en-v1.5's `position_embeddings`
    /// matrix is shape `[512, hidden]` — feeding more than 512 input
    /// tokens crashes the ONNX runtime with a broadcast error in the
    /// embeddings/Add node:
    ///
    /// ```text
    /// axis == 1 || axis == largest was false.
    /// Attempting to broadcast an axis by a dimension other than 1.
    /// 512 by 4719
    /// ```
    ///
    /// We can't rely on `tokenizer.json` to enforce the cap — observed
    /// in the wild: an HF tokenizer config with truncation disabled
    /// produces 2.7k / 4.7k token sequences for long Claude Code
    /// prompts. Hence: explicit clamp at 512 in this function. We
    /// truncate the SUFFIX (lose the tail of the input) which is the
    /// standard BERT convention; the leading sentence and immediate
    /// context survive, which is what semantic similarity wants for
    /// a recall query anyway.
    const MAX_TOKENS: usize = 512;

    pub fn encode(&self, text: &str) -> Result<Encoded> {
        let enc = self.inner
            .encode(text, true)
            .map_err(|e| EmbeddingError::Tokenizer(e.to_string()))?;

        let mut input_ids:      Vec<i64> = enc.get_ids().iter().map(|&x| x as i64).collect();
        let mut attention_mask: Vec<i64> = enc.get_attention_mask().iter().map(|&x| x as i64).collect();
        let mut token_type_ids: Vec<i64> = enc.get_type_ids().iter().map(|&x| x as i64).collect();

        if input_ids.len() > Self::MAX_TOKENS {
            tracing::debug!(
                requested = input_ids.len(),
                clamped_to = Self::MAX_TOKENS,
                "truncating BGE input — exceeded model's position_embeddings limit",
            );
            input_ids.truncate(Self::MAX_TOKENS);
            attention_mask.truncate(Self::MAX_TOKENS);
            token_type_ids.truncate(Self::MAX_TOKENS);
            // BERT convention: keep the [CLS] at index 0; replace the
            // last token with [SEP] (id 102) so the model still sees a
            // proper sentence boundary. Defense-in-depth — embedding
            // quality of a truncated long input isn't great either way,
            // but the model crashes outright if there's no [SEP].
            *input_ids.last_mut().unwrap() = 102;
        }

        let seq_len = input_ids.len();
        Ok(Encoded { input_ids, attention_mask, token_type_ids, seq_len })
    }
}
