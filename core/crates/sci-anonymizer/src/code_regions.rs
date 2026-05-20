//! SCI-198 — locate markdown code regions in input text.
//!
//! Single-pass byte scan that returns the inclusive byte ranges of
//! code spans the user wrote in their prompt: triple-backtick fences,
//! triple-tilde fences, and inline single-backtick spans. Callers
//! (the CamelCase and NER extractors) use these ranges to suppress
//! their tokenization passes inside code — the SCI-198 fix for the
//! placeholder-leak bug.
//!
//! Markdown's fence rules are subtle. We implement a deliberately
//! conservative subset that matches CommonMark closely enough for
//! prompt-anonymization purposes; it is NOT a full markdown parser
//! and is not intended to be. The misses we accept on purpose:
//!
//!   - Indented code blocks (4-space) are NOT detected. They're
//!     ambiguous with regular indented prose and the false-positive
//!     rate would suppress real tokenization. Use a fence if you
//!     want the protection.
//!   - Nested fences (a triple-backtick block whose body contains
//!     another triple-backtick line) close on the FIRST matching
//!     fence. Real CommonMark requires the closing fence to match
//!     length and char; we match char only. Acceptable for v1.
//!   - HTML `<code>…</code>` is not recognized. Markdown convention
//!     in our prompts is backticks; HTML in a prompt is unusual.
//!
//! The catches we DO get right:
//!
//!   - Triple-backtick blocks with or without info-string language
//!     tag (```` ```rust ````, ```` ``` ````).
//!   - Triple-tilde blocks (```` ~~~ ````).
//!   - Inline single-backtick spans (`` `foo` ``).
//!   - Inline spans must be balanced within a line; an unclosed `
//!     does NOT suppress the rest of the document.
//!   - Escaped backticks (`` \` ``) do not open/close spans.
//!   - Backticks inside an open fenced block are literal — they
//!     don't open a nested inline span.
//!
//! Output is a `Vec<Range<usize>>` of half-open byte ranges
//! (`start..end`) in source order, non-overlapping. The fences
//! themselves are INCLUDED in each range — that way callers don't
//! accidentally match a CamelCase identifier in the info string
//! (e.g. ```` ```TypeScript ```` → `TypeScript` is in-range, so
//! safe by construction even though our allowlist also covers it).

use std::ops::Range;

/// Locate code regions in `text`. Returns half-open byte ranges,
/// non-overlapping, sorted by start position. Each range INCLUDES the
/// surrounding fence characters / backticks.
///
/// Pure function — no allocation aside from the result vec; single
/// pass through `text.as_bytes()`. O(n) in input length.
pub fn extract_code_regions(text: &str) -> Vec<Range<usize>> {
    let bytes = text.as_bytes();
    let mut regions: Vec<Range<usize>> = Vec::new();
    let mut i = 0usize;
    let n = bytes.len();

    while i < n {
        // ── Fenced block ────────────────────────────────────────────
        //
        // A line that starts (after up to 3 leading spaces) with
        // three or more identical fence chars (` or ~) opens a code
        // block. Close on the next line that starts (similarly) with
        // three or more of the same char.
        //
        // We detect "line start" by being at offset 0 or having the
        // previous byte be \n.
        let at_line_start = i == 0 || bytes[i.saturating_sub(1)] == b'\n';
        if at_line_start {
            if let Some((fence_char, fence_len, after_indent)) = fence_open(bytes, i) {
                // Scan forward to the end of this opening line (to
                // include the info string).
                let mut j = after_indent + fence_len;
                while j < n && bytes[j] != b'\n' {
                    j += 1;
                }
                // j now points at \n or n.
                let block_start = i;
                let body_start = if j < n { j + 1 } else { n };

                // Scan for closing fence. Walk line by line.
                let mut k = body_start;
                let mut block_end = n; // default: EOF closes
                'closer: while k < n {
                    // Skip up to 3 leading spaces.
                    let mut indent = 0usize;
                    while indent < 3 && k + indent < n && bytes[k + indent] == b' ' {
                        indent += 1;
                    }
                    let line_content_start = k + indent;
                    // Count run of fence_char.
                    let mut run = 0usize;
                    while line_content_start + run < n
                        && bytes[line_content_start + run] == fence_char
                    {
                        run += 1;
                    }
                    if run >= fence_len {
                        // After the run, the line must be blank or
                        // whitespace-only — CommonMark requires
                        // nothing but spaces after the closing fence.
                        // We're permissive: allow anything; the line
                        // closes here either way.
                        let close_line_end = {
                            let mut m = line_content_start + run;
                            while m < n && bytes[m] != b'\n' {
                                m += 1;
                            }
                            if m < n { m + 1 } else { n }
                        };
                        block_end = close_line_end;
                        break 'closer;
                    }
                    // Advance to next line.
                    while k < n && bytes[k] != b'\n' {
                        k += 1;
                    }
                    if k < n {
                        k += 1; // skip the \n
                    }
                }
                regions.push(block_start..block_end);
                i = block_end;
                continue;
            }
        }

        // ── Inline backtick span ────────────────────────────────────
        //
        // Single backtick opens; the next unescaped backtick on the
        // SAME LINE closes. If no closer on this line, the backtick
        // is literal — we don't suppress anything.
        if bytes[i] == b'`' {
            // Walk forward looking for closer on this line.
            let mut j = i + 1;
            let mut closed_at: Option<usize> = None;
            while j < n && bytes[j] != b'\n' {
                if bytes[j] == b'`' {
                    // Check this backtick isn't escaped. We treat a
                    // single preceding backslash as escape; double
                    // backslash means the backslash itself is
                    // escaped (and the backtick is live).
                    let mut backslashes = 0usize;
                    let mut k = j;
                    while k > i + 1 && bytes[k - 1] == b'\\' {
                        backslashes += 1;
                        k -= 1;
                    }
                    if backslashes % 2 == 0 {
                        closed_at = Some(j);
                        break;
                    }
                }
                j += 1;
            }
            if let Some(end) = closed_at {
                regions.push(i..end + 1);
                i = end + 1;
                continue;
            }
        }

        // ── Default: advance one byte ───────────────────────────────
        // Walk in char-aware steps so UTF-8 stays intact. For our
        // ASCII-anchored scan this is just `i += 1` in practice, but
        // we keep the guard so a multi-byte char at position i
        // doesn't desync the next iteration.
        let step = utf8_step(bytes, i);
        i += step;
    }

    regions
}

/// Returns `Some((fence_char, fence_len, after_indent))` if position
/// `i` starts a line that opens a fenced code block. `after_indent`
/// is the byte offset where the fence run begins (past any leading
/// spaces).
fn fence_open(bytes: &[u8], i: usize) -> Option<(u8, usize, usize)> {
    let n = bytes.len();
    // Up to 3 leading spaces.
    let mut indent = 0usize;
    while indent < 3 && i + indent < n && bytes[i + indent] == b' ' {
        indent += 1;
    }
    let p = i + indent;
    if p >= n {
        return None;
    }
    let ch = bytes[p];
    if ch != b'`' && ch != b'~' {
        return None;
    }
    let mut run = 0usize;
    while p + run < n && bytes[p + run] == ch {
        run += 1;
    }
    if run < 3 {
        return None;
    }
    // For backtick fences, the info string must NOT contain
    // another backtick (CommonMark §119). We're permissive — we
    // allow it; the closing fence is what really matters. In
    // practice nobody writes ```foo`bar in a prompt.
    Some((ch, run, p))
}

/// Returns the byte length of the UTF-8 code-point starting at
/// `bytes[i]`. Defaults to 1 if `i >= len` or the byte isn't a valid
/// UTF-8 start (defensive — we'd only hit this on malformed input).
fn utf8_step(bytes: &[u8], i: usize) -> usize {
    if i >= bytes.len() {
        return 1;
    }
    let b = bytes[i];
    if b < 0x80 {
        1
    } else if b < 0xC0 {
        1 // continuation byte at start of step — malformed; resync 1 byte
    } else if b < 0xE0 {
        2
    } else if b < 0xF0 {
        3
    } else {
        4
    }
}

/// True if byte offset `pos` falls within any code region.
///
/// `regions` is assumed sorted by start (which `extract_code_regions`
/// guarantees) so we can stop scanning once a region's start is past
/// `pos`. Linear in worst case; in practice prompts have a handful of
/// fences max, so binary search isn't worth the complexity.
pub fn is_in_code_region(pos: usize, regions: &[Range<usize>]) -> bool {
    for r in regions {
        if r.start > pos {
            return false;
        }
        if r.contains(&pos) {
            return true;
        }
    }
    false
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn slice<'a>(text: &'a str, regions: &[Range<usize>]) -> Vec<&'a str> {
        regions.iter().map(|r| &text[r.clone()]).collect()
    }

    #[test]
    fn no_code_returns_empty() {
        assert!(extract_code_regions("Just prose, no code here.").is_empty());
    }

    #[test]
    fn inline_backtick_span() {
        let text = "Use `FooBar` in your handler.";
        let regions = extract_code_regions(text);
        assert_eq!(slice(text, &regions), vec!["`FooBar`"]);
    }

    #[test]
    fn unclosed_inline_backtick_is_literal() {
        let text = "Cost: `$5 each";
        let regions = extract_code_regions(text);
        assert!(regions.is_empty(), "unclosed inline must not suppress: {regions:?}");
    }

    #[test]
    fn multiple_inline_spans_on_one_line() {
        let text = "Call `foo` and then `bar` to finish.";
        let regions = extract_code_regions(text);
        assert_eq!(slice(text, &regions), vec!["`foo`", "`bar`"]);
    }

    #[test]
    fn inline_does_not_cross_newlines() {
        let text = "Open `foo\nthen bar` close";
        let regions = extract_code_regions(text);
        // The ` before foo never closes on its line. The ` before
        // close opens but never closes on its line either. Both
        // literal.
        assert!(regions.is_empty(), "newline must terminate inline scan: {regions:?}");
    }

    #[test]
    fn fenced_backtick_block() {
        let text = "Before.\n```\ncode here\n```\nAfter.\n";
        let regions = extract_code_regions(text);
        assert_eq!(regions.len(), 1);
        let captured = &text[regions[0].clone()];
        assert!(captured.contains("code here"));
        assert!(captured.contains("```"));
    }

    #[test]
    fn fenced_with_info_string() {
        let text = "```rust\nlet x = 1;\n```\n";
        let regions = extract_code_regions(text);
        assert_eq!(regions.len(), 1);
        let captured = &text[regions[0].clone()];
        assert!(captured.starts_with("```rust"));
        assert!(captured.ends_with("```\n"));
    }

    #[test]
    fn tilde_fenced_block() {
        let text = "~~~\nfoo\n~~~\n";
        let regions = extract_code_regions(text);
        assert_eq!(regions.len(), 1);
    }

    #[test]
    fn fenced_block_without_closer_runs_to_eof() {
        let text = "Before.\n```\nno closer ever";
        let regions = extract_code_regions(text);
        assert_eq!(regions.len(), 1);
        let r = &regions[0];
        assert_eq!(r.end, text.len());
    }

    #[test]
    fn is_in_code_region_works() {
        // Inline span + fenced block — fenced block requires the
        // opening ``` to start a line, so we use \n``` to put it on
        // its own line. Layout:
        //   0: 'a' 1:'b' 2:' ' 3:'`' 4:'c' 5:'d' 6:'`' 7:' ' 8:'e' 9:'f' 10:'\n'
        //   11:'`' 12:'`' 13:'`' 14:'\n' 15:'g' 16:'h' 17:'\n' 18:'`' 19:'`' 20:'`' 21:'\n'
        //   22:'i' 23:'j'
        let text = "ab `cd` ef\n```\ngh\n```\nij";
        let regions = extract_code_regions(text);
        assert!(!is_in_code_region(0, &regions));         // 'a'
        assert!(!is_in_code_region(2, &regions));         // space
        assert!(is_in_code_region(3, &regions));          // opening ` of inline
        assert!(is_in_code_region(4, &regions));          // 'c'
        assert!(is_in_code_region(5, &regions));          // 'd'
        assert!(is_in_code_region(6, &regions));          // closing `
        assert!(!is_in_code_region(7, &regions));         // space after
        assert!(!is_in_code_region(8, &regions));         // 'e'
        assert!(!is_in_code_region(9, &regions));         // 'f'
        assert!(is_in_code_region(11, &regions));         // opening fence
        assert!(is_in_code_region(15, &regions));         // 'g' inside fence
        assert!(is_in_code_region(16, &regions));         // 'h' inside fence
        assert!(is_in_code_region(20, &regions));         // closing fence
        assert!(!is_in_code_region(22, &regions));        // 'i' after fence
        assert!(!is_in_code_region(23, &regions));        // 'j' after fence
    }

    #[test]
    fn escaped_backtick_does_not_close() {
        // The middle backtick is escaped — closer must be the second non-escaped one.
        let text = r"Open `foo \` bar` close";
        let regions = extract_code_regions(text);
        assert_eq!(regions.len(), 1);
        let captured = &text[regions[0].clone()];
        assert_eq!(captured, r"`foo \` bar`");
    }

    #[test]
    fn fenced_block_excludes_prose_before_and_after() {
        let text = "Hello FooBar.\n```\nFooBar\n```\nMore FooBar.\n";
        let regions = extract_code_regions(text);
        assert_eq!(regions.len(), 1);
        // The leading "Hello FooBar." must not be in any region.
        for pos in 0..14 {
            assert!(
                !is_in_code_region(pos, &regions),
                "pos {pos} (prose before fence) wrongly flagged in-code",
            );
        }
        // The trailing "More FooBar." must not be in any region either.
        let trail_start = text.find("More").unwrap();
        for pos in trail_start..text.len() {
            assert!(
                !is_in_code_region(pos, &regions),
                "pos {pos} (prose after fence) wrongly flagged in-code",
            );
        }
    }

    #[test]
    fn regions_are_sorted_and_non_overlapping() {
        let text = "`a` and `b` then ```\nc\n``` and `d`";
        let regions = extract_code_regions(text);
        for w in regions.windows(2) {
            assert!(w[0].end <= w[1].start, "regions overlap or unordered: {regions:?}");
        }
    }
}
