export interface AgentConfig {
    /** localhost port the HTTPS_PROXY listener binds to. Default 8080. */
    proxyPort: number;
    /** Where Sci stores its CA + per-host leaf certs + token cache. Default ~/.sci/ */
    configDir: string;
    /** Where Sci stores `sci.db` (SQLite) + `sci.idx` (hnswlib) for memory.
     *  Default ~/.sci/memory/. Kept in its own subdir so the SQLite WAL files
     *  don't crowd the config dir. */
    memoryDir: string;
    /** Hostnames that get anonymized + memory-augmented. Anything else is a
     *  pure CONNECT tunnel. */
    aiHosts: Set<string>;
}
export declare function loadConfig(): AgentConfig;
