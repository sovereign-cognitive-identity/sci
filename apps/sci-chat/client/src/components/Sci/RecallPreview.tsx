/**
 * SCI-157: live recall preview of what memory will be injected into
 * the next turn's system prompt.
 *
 * Listens (via document-level event delegation) to whatever textarea
 * the user is typing into, debounces 300ms, and renders the top-N
 * recall hits the helper would surface for that draft text under the
 * currently-active profile.
 *
 * Read-only in v1: shows what *will* be injected. The "× to deny"
 * interactive piece needs helper-side deny-list plumbing — filed as a
 * follow-up so this ticket can ship the trust/transparency win
 * without waiting on the deny half.
 */

import { useActiveProfile, useDraftText, useRecallPreview } from './hooks';

interface Props {
  enabled: boolean;
}

const MAX_SNIPPET_CHARS = 120;

function snippet(content: string): string {
  const trimmed = content.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= MAX_SNIPPET_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_SNIPPET_CHARS - 1)}…`;
}

export default function RecallPreview({ enabled }: Props) {
  const draft   = useDraftText(enabled);
  const active  = useActiveProfile(enabled);
  const profile = active.data?.name ?? 'work';
  const recall  = useRecallPreview(draft, profile, enabled);

  // Hide entirely when the draft is too short for a meaningful recall.
  if (!enabled || draft.trim().length < 5) {
    return null;
  }

  const hits = recall.data ?? [];

  return (
    <section
      aria-label="Memory recall preview"
      className="
        mb-3 rounded-md border border-border-medium bg-surface-secondary
        p-2 text-xs text-text-primary
      "
    >
      <header className="mb-1 flex items-center justify-between gap-2">
        <span className="font-semibold">Recall preview</span>
        <span className="text-text-secondary">
          {recall.isFetching && 'searching…'}
          {!recall.isFetching && (
            hits.length === 0
              ? 'no relevant memories'
              : `${hits.length} ${hits.length === 1 ? 'memory' : 'memories'} on next turn`
          )}
        </span>
      </header>

      {recall.isError && (
        <p className="text-red-500">Recall failed: {String(recall.error)}</p>
      )}

      {hits.length > 0 && (
        <ul className="space-y-1">
          {hits.map((h) => (
            <li
              key={h.id}
              className="
                flex items-start gap-2 rounded
                border border-border-medium bg-surface-primary px-2 py-1
              "
            >
              <span
                aria-label={h.type}
                title={h.type}
                className="
                  mt-0.5 rounded bg-blue-500/15 px-1 py-0.5 text-[10px]
                  font-mono uppercase text-blue-400
                "
              >
                {h.type[0]}
              </span>
              <span className="flex-1 break-words">{snippet(h.content)}</span>
              <span
                className="ml-auto whitespace-nowrap text-[10px] text-text-secondary"
                title={`recall score ${h.score.toFixed(3)}`}
              >
                {h.score.toFixed(2)}
              </span>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-1 text-[10px] text-text-secondary">
        These will be injected into the next turn's system prompt under profile{' '}
        <span className="font-mono">{profile}</span>.
      </p>
    </section>
  );
}
