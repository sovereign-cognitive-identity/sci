/**
 * React Query + EventSource hooks for the Sci flight recorder.
 *
 * - `useAuditTurns`     — list query, refetched on event
 * - `useAuditTurn`      — single-turn query (lazy, by id)
 * - `useHelperStatus`   — polled every 5s for the header chip
 * - `useAuditEvents`    — SSE subscription, fires callback per event
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { AuditTurn } from './types';

import {
  createProfile,
  eventsUrl,
  getActiveProfile,
  getAuditTurn,
  getStatus,
  listAuditTurns,
  listProfiles,
  previewRecall,
  setActiveProfile,
} from './api';
import type { HelperEvent } from './types';

const QK_TURNS    = ['sci', 'audit_turns'] as const;
const QK_STATUS   = ['sci', 'status'] as const;
const QK_PROFILES = ['sci', 'profiles'] as const;
const QK_ACTIVE   = ['sci', 'active_profile'] as const;
const QK_TURN     = (id: string) => ['sci', 'audit_turn', id] as const;

/**
 * SCI-157 dogfood found a stuck-loading bug when `useAuditTurns` was
 * implemented via React Query: the queryFn ran and resolved with data,
 * but the resulting state never reached the component. LibreChat is on
 * @tanstack/react-query v4 and there's evidently a subtle interaction
 * with our setup that keeps the larger queries orphaned. Switched to
 * a plain useEffect + useState + monotonic refetch-id pattern. We lose
 * React Query's caching for this query specifically (single-tab
 * single-user surface — no cross-component sharing benefit anyway).
 *
 * Profile filtering: when `profile` is provided, only audit turns for
 * that profile are returned. Strict isolation by default — switching
 * profile in the inspector header re-fetches the list scoped to that
 * profile so work-conversations don't leak into the personal view
 * and vice versa.
 *
 * Reload semantics:
 *   - Initial mount: fetches once.
 *   - `profile` changes: re-fetches scoped to the new profile.
 *   - Returned `refetch` function fires a fresh load (used by the
 *     SSE flow_completed event listener to live-update the panel).
 *   - In-flight stale completions are dropped via the monotonic id.
 */
export function useAuditTurns(limit = 50, profile?: string) {
  const [data, setData]           = useState<AuditTurn[] | null>(null);
  const [error, setError]         = useState<Error | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const reloadIdRef               = useRef(0);

  const refetch = useCallback(() => {
    reloadIdRef.current += 1;
    const id = reloadIdRef.current;
    setIsLoading(true);
    listAuditTurns(limit, profile)
      .then((rows) => {
        if (id !== reloadIdRef.current) return; // superseded by a newer reload
        setData(rows);
        setError(null);
        setIsLoading(false);
      })
      .catch((err) => {
        if (id !== reloadIdRef.current) return;
        setError(err as Error);
        setIsLoading(false);
      });
  }, [limit, profile]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { data, error, isLoading, refetch };
}

export function useAuditTurn(id: string | null) {
  return useQuery({
    queryKey: id ? QK_TURN(id) : ['sci', 'audit_turn', 'none'],
    queryFn:  () => getAuditTurn(id as string),
    enabled:  Boolean(id),
    staleTime: 60_000,
  });
}

export function useProfiles(enabled = true) {
  return useQuery({
    queryKey: QK_PROFILES,
    queryFn:  listProfiles,
    enabled,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useActiveProfile(enabled = true) {
  return useQuery({
    queryKey: QK_ACTIVE,
    queryFn:  getActiveProfile,
    enabled,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

/**
 * Set the helper's active profile and refresh both the active and
 * audit-turns queries so the UI updates immediately.
 */
export function useSetActiveProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => setActiveProfile(name),
    onSuccess:  () => {
      qc.invalidateQueries({ queryKey: QK_ACTIVE });
      qc.invalidateQueries({ queryKey: QK_TURNS });
    },
  });
}

export function useCreateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => createProfile(name),
    onSuccess:  () => qc.invalidateQueries({ queryKey: QK_PROFILES }),
  });
}

/**
 * SCI-157: track the live value of the chat input textarea via
 * document-level event delegation. This avoids modifying upstream
 * LibreChat input components — a global listener picks up any
 * textarea's input event and reports its value (debounced).
 *
 * Returns the debounced value of whichever textarea most recently
 * received input. Empty string on mount or after the textarea is
 * cleared.
 *
 * Caveat: assumes there's a single user-typed textarea on the page
 * at a time (LibreChat's chat input). If multiple textareas exist
 * (settings forms, modal dialogs), the most-recently-typed one
 * wins. Acceptable for v1 — recall preview is harmless on form
 * input.
 */
export function useDraftText(enabled: boolean, debounceMs = 300): string {
  const [value, setValue] = useState('');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled) {
      setValue('');
      return;
    }
    const onInput = (ev: Event) => {
      const target = ev.target as HTMLElement | null;
      if (!target || target.tagName !== 'TEXTAREA') return;
      const v = (target as HTMLTextAreaElement).value;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setValue(v), debounceMs);
    };
    document.addEventListener('input', onInput, true);
    return () => {
      document.removeEventListener('input', onInput, true);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [enabled, debounceMs]);

  return value;
}

/**
 * SCI-157: preview what memory recall would surface for the current
 * draft message. Disabled when query is too short to be meaningful
 * (matches the helper's STORE_MIN_CHARS floor) so we don't fire a
 * recall for every keystroke.
 *
 * staleTime is generous (60s) so as the user keeps typing the same
 * thought, we don't re-embed + re-recall on every fresh debounce.
 */
export function useRecallPreview(query: string, profile: string, enabled = true) {
  const trimmed = query.trim();
  return useQuery({
    queryKey: ['sci', 'recall_preview', profile, trimmed],
    queryFn:  () => previewRecall(trimmed, profile, 5),
    enabled:  enabled && trimmed.length >= 5 && !!profile,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useHelperStatus(enabled = true) {
  return useQuery({
    queryKey: QK_STATUS,
    queryFn:  getStatus,
    enabled,
    refetchInterval: 5_000,
    refetchOnWindowFocus: false,
  });
}

/**
 * Subscribe to `/sci/events` over SSE. Fires `onEvent` for every
 * parseable event. Auto-reconnects via the browser's native
 * EventSource retry. Closes the connection on unmount.
 *
 * The list query is invalidated on `flow_completed` so a new turn
 * appears in the inspector without manual refresh.
 */
export function useAuditEvents(
  enabled: boolean,
  onFlowCompleted?: () => void,
  onEvent?: (event: HelperEvent) => void,
) {
  const onEventRef     = useRef(onEvent);
  const onCompletedRef = useRef(onFlowCompleted);
  useEffect(() => { onEventRef.current = onEvent; }, [onEvent]);
  useEffect(() => { onCompletedRef.current = onFlowCompleted; }, [onFlowCompleted]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const src = new EventSource(eventsUrl());
    src.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data) as HelperEvent;
        onEventRef.current?.(event);
        if (event.type === 'flow_completed') {
          onCompletedRef.current?.();
        }
      } catch {
        // Ignore unparseable events.
      }
    };
    src.onerror = () => {
      // EventSource auto-reconnects; transient blips during helper
      // restart are normal and not surfaced to the user.
    };
    return () => src.close();
  }, [enabled]);
}
