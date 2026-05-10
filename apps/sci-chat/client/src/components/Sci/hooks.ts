/**
 * React Query + EventSource hooks for the Sci flight recorder.
 *
 * - `useAuditTurns`     — list query, refetched on event
 * - `useAuditTurn`      — single-turn query (lazy, by id)
 * - `useHelperStatus`   — polled every 5s for the header chip
 * - `useAuditEvents`    — SSE subscription, fires callback per event
 */

import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  createProfile,
  eventsUrl,
  getActiveProfile,
  getAuditTurn,
  getStatus,
  listAuditTurns,
  listProfiles,
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
