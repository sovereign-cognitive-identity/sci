import { createContext, useContext } from 'react';
import type { Dispatch, SetStateAction } from 'react';

export interface InspectorControls {
  open: boolean;
  /** Pixel width when open; 0 when closed. */
  width: number;
  setOpen: Dispatch<SetStateAction<boolean>>;
  setWidth: Dispatch<SetStateAction<number>>;
}

/**
 * Single context carrying both state and setters.
 * Provider lives in App.jsx, above RouterProvider.
 * Consumers: InspectorPanel (setters), ChatView (state only).
 */
export const InspectorContext = createContext<InspectorControls>({
  open: false,
  width: 0,
  setOpen: () => undefined,
  setWidth: () => undefined,
});

export function useInspector() {
  return useContext(InspectorContext);
}

/** Alias — InspectorPanel uses this name for clarity. */
export const useInspectorControls = useInspector;
