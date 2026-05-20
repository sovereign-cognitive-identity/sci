/**
 * MCPServerManagerContext
 *
 * Hosts a single shared instance of `useMCPServerManager` so that every
 * consumer in the tree shares the same React-Query observer instead of each
 * one registering its own.
 *
 * Provider is mounted at TWO levels:
 *   1. App.jsx root (conversationId=null) — covers sidebar, tool dropdowns,
 *      landing page, and anything outside ChatView. Always present.
 *   2. ChatView (conversationId=activeId) — overrides #1 for components
 *      inside a conversation so they get the per-conversation scope.
 *
 * Because the root provider is always present, `useMCPServerManagerContext`
 * never needs a hook-based fallback. The previous fallback called
 * `useMCPServerManager` + `useMCPServersQuery` unconditionally in every
 * consumer, creating one React-Query observer per component
 * (ToolCallGroup, MCPTool, sidebar items…) — that was the source of the
 * re-render cascade that caused the send-button lag.
 */

import React, { createContext, useContext, useMemo } from 'react';
import { useMCPServersQuery } from '~/data-provider';
import { useMCPServerManager } from '~/hooks/MCP/useMCPServerManager';

type MCPServerManagerContextType = {
  mcpServerManager: ReturnType<typeof useMCPServerManager>;
  /** Icon map derived from the shared server list — zero extra observers */
  mcpIconMap: Map<string, string>;
};

const MCPServerManagerContext = createContext<MCPServerManagerContextType | undefined>(undefined);

/** Static empty shell — returned when accessed outside any provider (tests, Storybook). */
const EMPTY_CONTEXT: MCPServerManagerContextType = {
  mcpServerManager: {} as ReturnType<typeof useMCPServerManager>,
  mcpIconMap: new Map(),
};

export function useMCPServerManagerContext(): MCPServerManagerContextType {
  return useContext(MCPServerManagerContext) ?? EMPTY_CONTEXT;
}

interface Props {
  children: React.ReactNode;
  conversationId?: string | null;
  storageContextKey?: string;
}

export function MCPServerManagerProvider({ children, conversationId, storageContextKey }: Props) {
  const mcpServerManager = useMCPServerManager({ conversationId, storageContextKey });

  const { data: servers } = useMCPServersQuery({ staleTime: Infinity });

  const mcpIconMap = useMemo(() => {
    const map = new Map<string, string>();
    if (!servers) return map;
    for (const [serverName, config] of Object.entries(servers)) {
      if (config.iconPath) {
        map.set(serverName, config.iconPath);
      }
    }
    return map;
  }, [servers]);

  const value = useMemo(
    () => ({ mcpServerManager, mcpIconMap }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mcpServerManager, mcpIconMap],
  );

  return (
    <MCPServerManagerContext.Provider value={value}>
      {children}
    </MCPServerManagerContext.Provider>
  );
}
