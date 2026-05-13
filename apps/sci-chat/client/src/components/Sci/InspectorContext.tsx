import { createContext, useContext } from 'react';

export interface InspectorState {
  open: boolean;
  width: number;
}

export const InspectorContext = createContext<InspectorState>({ open: false, width: 0 });

export function useInspector() {
  return useContext(InspectorContext);
}
