/**
 * React Query + EventSource hooks for the Sci flight recorder.
 *
 * - `useAuditTurns`     — list query, refetched on event
 * - `useAuditTurn`      — single-turn query (lazy, by id)
 * - `useHelperStatus`   — polled every 5s for the header chip
 * - `useAuditEvents`    — SSE subscription, fires callback per event
 */

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

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

export function useAuditTurns(limit = 50) {
  return useQuery({
    queryKey: [...QK_TURNS, limit],
    queryFn:  () => listAuditTurns(limit),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
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
  onEvent?: (event: HelperEvent) => void,
) {
  const queryClient = useQueryClient();
  const onEventRef  = useRef(onEvent);
  useEffect(() => { onEventRef.current = onEvent; }, [onEvent]);

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
          queryClient.invalidateQueries({ queryKey: QK_TURNS });
        }
      } catch {
        // Ignore unparseable events. Helper guarantees JSON but a
        // future helper version may add a non-JSON keep-alive line.
      }
    };
    src.onerror = () => {
      // EventSource auto-reconnects; we just log for diagnosability.
      // Don't toast — a transient blip during helper restart is normal.
    };
    return () => src.close();
  }, [enabled, queryClient]);
}
