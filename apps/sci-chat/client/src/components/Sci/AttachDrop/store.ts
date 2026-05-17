/**
 * Recoil store for SCI-166 attached file chips.
 *
 * The chip set is global (single chat surface, single user). Atom
 * value is the array of currently-attached files; the "pinned"
 * flag controls whether chips clear after send.
 *
 * Why Recoil and not Jotai/Zustand: LibreChat already wires Recoil
 * at the root (the Sci inspector also uses it for nothing — it
 * leans on React Query — but other parts of LibreChat do). One
 * fewer dependency to add.
 */

import { atom } from 'recoil';

import type { AttachedFile } from './types';

export const attachedFilesAtom = atom<AttachedFile[]>({
  key:     'sci.attachDrop.files',
  default: [],
});

/**
 * When true, chips survive a send and stay attached for the next
 * message in the same thread. Resets to false on conversation
 * change (handled by the mount component).
 */
export const pinnedAtom = atom<boolean>({
  key:     'sci.attachDrop.pinned',
  default: false,
});
