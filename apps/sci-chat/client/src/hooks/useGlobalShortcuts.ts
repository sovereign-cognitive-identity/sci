import { useEffect, useCallback, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { QueryKeys } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import { getAllContentText } from '~/utils';
import { useNewConvo, useNavigateToConvo } from '~/hooks';
import { mainTextareaId } from '~/common';

/**
 * Global keyboard shortcuts for Sci Chat.
 *
 *   Cmd/Ctrl + N          → New conversation
 *   Cmd/Ctrl + /          → Focus chat textarea
 *   Cmd/Ctrl + L          → Clear chat input
 *   Cmd/Ctrl + Shift + C  → Copy last assistant response
 *   Cmd/Ctrl + [          → Navigate to previous conversation
 *   Cmd/Ctrl + ]          → Navigate to next conversation
 *   ?  (outside inputs)   → Toggle shortcut reference dialog
 *
 * Not handled here (already handled elsewhere):
 *   Cmd/Ctrl + Enter      → Send  (useTextarea)
 *   Escape                → Close dialogs (per-component)
 */
export function useGlobalShortcuts({
  conversationId,
  setValue,
  onToggleHelp,
}: {
  conversationId: string | undefined;
  /** react-hook-form setValue for the 'text' field */
  setValue: (field: 'text', value: string) => void;
  onToggleHelp: () => void;
}) {
  const queryClient = useQueryClient();
  const { newConversation } = useNewConvo();
  const { navigateToConvo } = useNavigateToConvo();

  // Stable refs so the handler closure never goes stale
  const newConvoRef = useRef(newConversation);
  newConvoRef.current = newConversation;
  const navigateRef = useRef(navigateToConvo);
  navigateRef.current = navigateToConvo;
  const conversationIdRef = useRef(conversationId);
  conversationIdRef.current = conversationId;
  const setValueRef = useRef(setValue);
  setValueRef.current = setValue;
  const onToggleHelpRef = useRef(onToggleHelp);
  onToggleHelpRef.current = onToggleHelp;

  const handler = useCallback(
    (e: KeyboardEvent) => {
      const isMac = /mac/i.test(navigator.platform);
      const mod = isMac ? e.metaKey : e.ctrlKey;
      const target = e.target as HTMLElement;
      const tag = target?.tagName?.toLowerCase();
      const inInput = tag === 'textarea' || tag === 'input' || target?.isContentEditable;

      // ── Cmd/Ctrl + N → new conversation ─────────────────────────────────
      if (mod && !e.shiftKey && !e.altKey && e.key === 'n') {
        e.preventDefault();
        newConvoRef.current();
        return;
      }

      // ── Cmd/Ctrl + / → focus textarea ───────────────────────────────────
      if (mod && e.key === '/') {
        e.preventDefault();
        const el = document.getElementById(mainTextareaId) as HTMLTextAreaElement | null;
        el?.focus();
        return;
      }

      // ── Cmd/Ctrl + L → clear input ──────────────────────────────────────
      if (mod && !e.shiftKey && e.key === 'l') {
        e.preventDefault();
        setValueRef.current('text', '');
        const el = document.getElementById(mainTextareaId) as HTMLTextAreaElement | null;
        el?.focus();
        return;
      }

      // ── Cmd/Ctrl + Shift + C → copy last assistant response ─────────────
      if (mod && e.shiftKey && e.key === 'C') {
        e.preventDefault();
        const convoId = conversationIdRef.current;
        if (!convoId) return;
        const messages = queryClient.getQueryData<TMessage[]>([QueryKeys.messages, convoId]);
        if (!messages?.length) return;
        for (let i = messages.length - 1; i >= 0; i--) {
          if (!messages[i].isCreatedByUser) {
            const text = getAllContentText(messages[i]);
            if (text) navigator.clipboard.writeText(text).catch(() => undefined);
            break;
          }
        }
        return;
      }

      // ── Cmd/Ctrl + [ / ] → navigate conversation history ────────────────
      if (mod && !e.shiftKey && (e.key === '[' || e.key === ']')) {
        e.preventDefault();
        const pages = queryClient.getQueryData<{ pages: { conversations: { conversationId: string }[] }[] }>(
          [QueryKeys.allConversations],
        );
        const allConvos = pages?.pages?.flatMap((p) => p.conversations) ?? [];
        if (!allConvos.length) return;
        const currentIdx = allConvos.findIndex(
          (c) => c.conversationId === conversationIdRef.current,
        );
        if (e.key === '[') {
          // previous (older — higher index in the sorted-by-recent list)
          const target = allConvos[currentIdx + 1];
          if (target) navigateRef.current(target as Parameters<typeof navigateRef.current>[0]);
        } else {
          // next (newer — lower index)
          const target = allConvos[currentIdx - 1];
          if (target) navigateRef.current(target as Parameters<typeof navigateRef.current>[0]);
        }
        return;
      }

      // ── ? → shortcut help (only outside input fields) ───────────────────
      if (!inInput && !mod && e.key === '?') {
        e.preventDefault();
        onToggleHelpRef.current();
        return;
      }
    },
    [queryClient],
  );

  useEffect(() => {
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [handler]);
}

/** Manage open state for the shortcut help dialog. */
export function useShortcutHelpState() {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((v) => !v), []);
  const close = useCallback(() => setOpen(false), []);
  return { open, toggle, close };
}
