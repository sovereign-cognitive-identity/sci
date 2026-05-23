/**
 * Project working-directory selector. Renders in the InspectorPanel
 * header alongside the ProfileSelector.
 *
 * Sets a global "active project" on the helper; when present, the
 * helper injects a "Working directory: <path>" hint into every
 * subsequent turn's system prompt so the model defaults filesystem-
 * tool paths to that directory and accepts relative path references.
 *
 * v1 input: paste-a-path. A real filesystem picker (File System
 * Access API) is a future polish (Chrome-only, requires per-folder
 * grant — not worth it before dogfood validates the feature).
 *
 * Auto-profile bind: when a project is set, we automatically switch
 * (and create if needed) to a profile named after the project's leaf
 * directory. So setting `~/src/cognitive-os/sci/apps/sci-chat`
 * activates a profile called `sci-chat`. This is the "memory follows
 * the project" affordance — chats about sci-chat go into the sci-chat
 * memory pool, separate from work or personal. The behavior is on
 * by default; SCI-163 will surface a settings toggle.
 */

import { useEffect, useRef, useState } from 'react';

import {
  useActiveProfile,
  useActiveProject,
  useCreateProfile,
  useSetActiveProfile,
  useSetActiveProject,
} from './hooks';

interface Props {
  enabled: boolean;
}

const LS_RECENT_KEY = 'sci.recent_projects';
const RECENT_LIMIT  = 5;

function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(LS_RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function pushRecent(path: string): string[] {
  const prev = readRecent().filter((p) => p !== path);
  const next = [path, ...prev].slice(0, RECENT_LIMIT);
  try {
    localStorage.setItem(LS_RECENT_KEY, JSON.stringify(next));
  } catch { /* ignore */ }
  return next;
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

export default function ProjectSelector({ enabled }: Props) {
  const project    = useActiveProject(enabled);
  const setProject = useSetActiveProject();

  // Profile auto-bind: when project changes, switch to a profile named
  // after the basename. Create-then-switch via the create + set hooks.
  const activeProfile  = useActiveProfile(enabled);
  const setProfile     = useSetActiveProfile();
  const createProfile  = useCreateProfile();

  const [open, setOpen]       = useState(false);
  const [draft, setDraft]     = useState('');
  const [recents, setRecents] = useState<string[]>(() => readRecent());
  const wrapperRef            = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (ev: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(ev.target as Node)) {
        setOpen(false);
        setDraft('');
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const currentPath = project.data?.path ?? null;
  const currentName = currentPath ? basename(currentPath) : null;

  const applyProject = async (path: string | null) => {
    await setProject.mutateAsync(path);
    if (path) {
      setRecents(pushRecent(path));
      // Auto-bind: create + switch to a profile of the same basename.
      const target = basename(path);
      if (target && target !== activeProfile.data?.name) {
        try {
          await createProfile.mutateAsync(target);
          await setProfile.mutateAsync(target);
        } catch {
          // Best-effort. Profile creation is idempotent server-side
          // but a transient failure shouldn't block project setting.
        }
      }
    }
    setOpen(false);
    setDraft('');
  };

  const handleSetFromInput = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed) return;
    void applyProject(trimmed);
  };

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((x) => !x)}
        className="
          flex items-center gap-1.5 rounded-md border border-border-medium
          bg-surface-secondary px-2 py-0.5 text-[11px]
          text-text-primary hover:bg-surface-tertiary
        "
        title="Project working directory (folder-scoped session)"
      >
        <span aria-hidden>📁</span>
        <span className="font-medium max-w-[120px] truncate">
          {currentName ?? 'Set project…'}
        </span>
        <span aria-hidden className="text-text-secondary">▾</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Project picker"
          className="
            absolute right-0 top-full z-50 mt-1 w-[300px]
            rounded-md border border-border-medium bg-surface-primary p-2
            text-xs text-text-primary shadow-lg
          "
        >
          {currentPath && (
            <div className="mb-2">
              <div className="text-text-secondary">Active</div>
              <div className="break-all font-mono text-[11px]">{currentPath}</div>
              <button
                type="button"
                onClick={() => void applyProject(null)}
                className="
                  mt-1 text-[11px] text-text-secondary
                  hover:text-text-primary underline-offset-2 hover:underline
                "
              >
                Clear project
              </button>
            </div>
          )}

          <form onSubmit={handleSetFromInput}>
            <label className="block">
              <span className="text-text-secondary">Set project path</span>
              <input
                autoFocus
                type="text"
                placeholder="/Users/you/src/your-project"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                className="
                  mt-1 w-full rounded border border-border-medium bg-surface-secondary
                  px-2 py-1 font-mono text-[11px] outline-none
                  focus:border-blue-500
                "
              />
            </label>
            {setProject.isError && (
              <p className="mt-1 text-[10px] text-red-500">
                {String(setProject.error)}
              </p>
            )}
            <div className="mt-1 flex justify-end">
              <button
                type="submit"
                disabled={!draft.trim() || setProject.isLoading}
                className="
                  rounded bg-blue-500 px-2 py-0.5 text-white
                  disabled:opacity-50
                "
              >
                {setProject.isLoading ? 'Setting…' : 'Set'}
              </button>
            </div>
          </form>

          {recents.length > 0 && (
            <div className="mt-2 border-t border-border-medium pt-2">
              <div className="mb-1 text-text-secondary">Recent</div>
              <ul className="space-y-0.5">
                {recents.map((p) => (
                  <li key={p}>
                    <button
                      type="button"
                      onClick={() => void applyProject(p)}
                      className="
                        flex w-full items-center gap-1 truncate rounded
                        px-1 py-0.5 text-left font-mono text-[11px]
                        hover:bg-surface-secondary
                      "
                      title={p}
                    >
                      <span aria-hidden>📁</span>
                      <span className="truncate">{basename(p)}</span>
                      <span className="ml-auto truncate text-[10px] text-text-secondary">
                        {p.replace(/^\/Users\/[^/]+\//, '~/')}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p className="mt-2 text-[10px] text-text-secondary">
            Setting a project injects a working-directory hint into every
            turn's system prompt and auto-switches your profile to{' '}
            <span className="font-mono">{currentName ?? '<basename>'}</span>{' '}
            for memory isolation.
          </p>
        </div>
      )}
    </div>
  );
}
