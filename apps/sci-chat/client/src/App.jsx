import { useEffect, useMemo, useRef, useState } from 'react';
import { RecoilRoot } from 'recoil';
import { DndProvider } from 'react-dnd';
import { RouterProvider } from 'react-router-dom';
import * as RadixToast from '@radix-ui/react-toast';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { Toast, ThemeProvider, ToastProvider } from '@librechat/client';
import { QueryClient, QueryClientProvider, QueryCache } from '@tanstack/react-query';
import { ScreenshotProvider, useApiErrorBoundary } from './hooks';
import WakeLockManager from '~/components/System/WakeLockManager';
import { InspectorPanel as SciInspectorPanel, AttachDropMount as SciAttachDropMount, InspectorContext } from '~/components/Sci';
import { MCPServerManagerProvider } from '~/Providers/MCPServerManagerContext';
import { getThemeFromEnv } from './utils/getThemeFromEnv';
import { initializeFontSize } from '~/store/fontSize';
import { LiveAnnouncer } from '~/a11y';
import { router } from './routes';

const LS_OPEN_KEY  = 'sci.inspector.open';
const LS_WIDTH_KEY = 'sci.inspector.width';
const DEFAULT_WIDTH = 420;
const MIN_WIDTH     = 320;
const MAX_WIDTH     = 800;

const App = () => {
  const { setError } = useApiErrorBoundary();

  // Stable ref to setError so the QueryCache callback never goes stale.
  const setErrorRef = useRef(setError);
  setErrorRef.current = setError;

  // queryClient must be stable across renders — creating it inline would
  // recreate it on every state change (e.g. inspector open/close), nuking
  // all React Query caches and killing in-flight mutations like message sends.
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      queries: { networkMode: 'always' },
      mutations: { networkMode: 'always' },
    },
    queryCache: new QueryCache({
      onError: (error) => {
        if (error?.response?.status === 401) setErrorRef.current(error);
      },
    }),
  }));

  useEffect(() => { initializeFontSize(); }, []);

  const envTheme = getThemeFromEnv();

  const [open, setOpen]   = useState(() => {
    try { const v = localStorage.getItem(LS_OPEN_KEY); if (v === '1') return true; if (v === '0') return false; } catch {}
    return false;
  });
  const [width, setWidthRaw] = useState(() => {
    try { const v = localStorage.getItem(LS_WIDTH_KEY); const n = Number(v); if (Number.isFinite(n) && n > 0) return n; } catch {}
    return DEFAULT_WIDTH;
  });

  const setWidth = (updater) => setWidthRaw((prev) => {
    const next = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, typeof updater === 'function' ? updater(prev) : updater));
    try { localStorage.setItem(LS_WIDTH_KEY, String(next)); } catch {}
    return next;
  });

  const handleSetOpen = (updater) => setOpen((prev) => {
    const next = typeof updater === 'function' ? updater(prev) : updater;
    try { localStorage.setItem(LS_OPEN_KEY, next ? '1' : '0'); } catch {}
    return next;
  });

  // Memoize so context consumers only re-render when open/width actually change,
  // not on every App render triggered by unrelated state updates.
  const inspectorValue = useMemo(
    () => ({ open, width: open ? width : 0, setOpen: handleSetOpen, setWidth }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open, width],
  );

  return (
    <QueryClientProvider client={queryClient}>
      <RecoilRoot>
        <LiveAnnouncer>
          <ThemeProvider {...(envTheme && { initialTheme: 'system', themeRGB: envTheme })}>
            <RadixToast.Provider>
              <ToastProvider>
                <DndProvider backend={HTML5Backend}>
                  <MCPServerManagerProvider>
                  <InspectorContext.Provider value={inspectorValue}>
                    <RouterProvider router={router} />
                    <SciInspectorPanel />
                    <SciAttachDropMount />
                  </InspectorContext.Provider>
                  </MCPServerManagerProvider>
                  <WakeLockManager />
                  <ReactQueryDevtools initialIsOpen={false} position="top-right" />
                  <Toast />
                  <RadixToast.Viewport className="pointer-events-none fixed inset-0 z-[1000] mx-auto my-2 flex max-w-[560px] flex-col items-stretch justify-start md:pb-5" />
                </DndProvider>
              </ToastProvider>
            </RadixToast.Provider>
          </ThemeProvider>
        </LiveAnnouncer>
      </RecoilRoot>
    </QueryClientProvider>
  );
};

export default () => (
  <ScreenshotProvider>
    <App />
    <iframe src="assets/silence.mp3" allow="autoplay" id="audio" title="audio-silence" style={{ display: 'none' }} />
  </ScreenshotProvider>
);
