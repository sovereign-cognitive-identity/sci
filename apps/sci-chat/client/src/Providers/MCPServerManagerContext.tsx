/**
 * MCPServerManagerContext
 *
 * Hosts a single shared instance of `useMCPServerManager` so that every
 * consumer in the tree shares the same React-Query observer instead of each
 * one registering its own.
 *
 * Before this context existed, `useMCPServerManager` (and therefore
 * `useMCPServersQuery`) was called from at least 9 different components
 * simultaneously, producing 30+ React-Query observers on the
 * `["mcpServers"]` key.  Every cache invalidation (OAuth poll, server
 * reinit, etc.) triggered a re-render in ALL of those components at once.
 *
 * Additionally, `useMCPIconMap` was called inside per-message components
 * (`ToolCall`, `ToolCallGroup`), adding one observer per message bubble.
 * That path is now handled by the `mcpIconMap` value exposed here.
 *
 * Usage
 * -----
 * Wrap your component tree with <MCPServerManagerProvider> once (already
 * done inside BadgeRowProvider which sits above most chat UI).
 *
 * In any child:
 *   const { mcpServerManager, mcpIconMap } = useMCPServerManagerContext();
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

export function useMCPServerManagerContext(): MCPServerManagerContextType {
  const ctx = useContext(MCPServerManagerContext);
  if (!ctx) {
    throw new Error(
      'useMCPServerManagerContext must be used within MCPServerManagerProvider',
    );
  }
  return ctx;
}

interface Props {
  children: React.ReactNode;
  conversationId?: string | null;
  storageContextKey?: string;
}

export function MCPServerManagerProvider({ children, conversationId, storageContextKey }: Props) {
  // Single hook instance — all children share this one React-Query observer.
  const mcpServerManager = useMCPServerManager({ conversationId, storageContextKey });

  // Derive the icon map from the already-loaded server data.
  // Re-uses the same query data; does NOT register a second observer.
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
    // mcpServerManager reference is stable because useMCPServerManager
    // wraps all returned functions in useCallback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mcpServerManager, mcpIconMap],
  );

  return (
    <MCPServerManagerContext.Provider value={value}>
      {children}
    </MCPServerManagerContext.Provider>
  );
}
