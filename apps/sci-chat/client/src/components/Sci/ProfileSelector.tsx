/**
 * Identity profile selector. Renders in the InspectorPanel header.
 *
 * Single-select dropdown over the helper's profile list, plus an
 * inline "+ New profile…" form. Changing the selection POSTs to
 * /sci/active_profile; the new profile takes effect on the next
 * model turn.
 *
 * Color dot per profile is deterministic from the profile name so
 * the same profile shows the same color across all UI surfaces.
 */

import { useEffect, useRef, useState } from 'react';

import { useActiveProfile, useCreateProfile, useProfiles, useSetActiveProfile } from './hooks';

interface Props {
  enabled: boolean;
}

/// 8-color palette. Stable per-profile by hashing the name into a
/// bucket. Same name → same color across mounts. Tailwind-class names
/// kept as static strings so PurgeCSS keeps them in the bundle.
const COLOR_CLASSES = [
  'bg-rose-500',
  'bg-amber-500',
  'bg-emerald-500',
  'bg-cyan-500',
  'bg-blue-500',
  'bg-violet-500',
  'bg-fuchsia-500',
  'bg-lime-500',
] as const;

function colorFor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return COLOR_CLASSES[Math.abs(hash) % COLOR_CLASSES.length];
}

export default function ProfileSelector({ enabled }: Props) {
  const profiles = useProfiles(enabled);
  const active   = useActiveProfile(enabled);
  const setActive = useSetActiveProfile();
  const create    = useCreateProfile();

  const [open, setOpen]           = useState(false);
  const [creating, setCreating]   = useState(false);
  const [draftName, setDraftName] = useState('');
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Close menu on outside click.
  useEffect(() => {
    if (!open) return;
    const onDoc = (ev: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(ev.target as Node)) {
        setOpen(false);
        setCreating(false);
        setDraftName('');
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const activeName = active.data?.name ?? 'work';
  const activeDot  = colorFor(activeName);

  const handlePick = (name: string) => {
    setActive.mutate(name);
    setOpen(false);
    setCreating(false);
    setDraftName('');
  };

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    const name = draftName.trim();
    if (!name) return;
    create.mutate(name, {
      onSuccess: (profile) => {
        setActive.mutate(profile.name);
        setOpen(false);
        setCreating(false);
        setDraftName('');
      },
    });
  };

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((x) => !x)}
        className="
          flex items-center gap-1.5 rounded-md border border-border-medium
          bg-surface-secondary px-2 py-0.5 text-[11px]
          text-text-primary hover:bg-surface-tertiary
        "
        title="Identity profile (recall + storage scope)"
      >
        <span className={`inline-block h-2 w-2 rounded-full ${activeDot}`} aria-hidden />
        <span className="font-medium">{activeName}</span>
        <span aria-hidden className="text-text-secondary">▾</span>
      </button>

      {open && (
        <div
          role="listbox"
          className="
            absolute right-0 top-full z-50 mt-1 min-w-[180px]
            rounded-md border border-border-medium bg-surface-primary py-1
            text-xs text-text-primary shadow-lg
          "
        >
          {profiles.isLoading && (
            <div className="px-3 py-1 text-text-secondary">Loading…</div>
          )}
          {profiles.isError && (
            <div className="px-3 py-1 text-red-500">Failed to load profiles</div>
          )}
          {profiles.data?.map((p) => {
            const isActive = p.name === activeName;
            return (
              <button
                type="button"
                role="option"
                aria-selected={isActive}
                key={p.id}
                onClick={() => handlePick(p.name)}
                className={`
                  flex w-full items-center gap-2 px-3 py-1 text-left
                  hover:bg-surface-secondary
                  ${isActive ? 'font-semibold' : ''}
                `}
              >
                <span
                  className={`inline-block h-2 w-2 rounded-full ${colorFor(p.name)}`}
                  aria-hidden
                />
                <span className="flex-1 truncate">{p.name}</span>
                {isActive && <span aria-hidden className="text-text-secondary">✓</span>}
              </button>
            );
          })}

          <div className="my-1 border-t border-border-medium" />

          {creating ? (
            <form onSubmit={handleCreate} className="px-2 py-1">
              <input
                autoFocus
                type="text"
                placeholder="profile name"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                className="
                  w-full rounded border border-border-medium bg-surface-secondary
                  px-2 py-1 text-xs text-text-primary outline-none
                  focus:border-blue-500
                "
              />
              {create.isError && (
                <p className="mt-1 text-[10px] text-red-500">
                  {String(create.error)}
                </p>
              )}
              <div className="mt-1 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => { setCreating(false); setDraftName(''); }}
                  className="text-text-secondary hover:text-text-primary"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!draftName.trim() || create.isLoading}
                  className="
                    rounded bg-blue-500 px-2 py-0.5 text-white
                    disabled:opacity-50
                  "
                >
                  {create.isLoading ? 'Creating…' : 'Create'}
                </button>
              </div>
            </form>
          ) : (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="
                flex w-full items-center gap-2 px-3 py-1 text-left
                text-text-secondary hover:bg-surface-secondary hover:text-text-primary
              "
            >
              <span aria-hidden>+</span>
              <span>New profile…</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
