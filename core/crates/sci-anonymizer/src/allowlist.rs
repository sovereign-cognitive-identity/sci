//! Tech-name allowlist — words that are case-sensitive proper nouns but don't
//! reveal user identity (languages, frameworks, common SaaS).
//!
//! Mirrors `TECH_ALLOWLIST` in packages/core/src/anonymizer.ts. Keeping the
//! set in one place — and matching exactly — is what lets the parity
//! fixtures pass byte-for-byte during the cutover. Adding to this list
//! goes through both implementations until the TS one is retired.

use once_cell::sync::Lazy;
use std::collections::HashSet;

pub static TECH_ALLOWLIST: Lazy<HashSet<&'static str>> = Lazy::new(|| {
    [
        // Languages
        "TypeScript", "JavaScript", "Python", "Swift", "Kotlin", "Rust", "Go",
        "Java", "Ruby", "Bash", "Shell", "SQL", "HTML", "CSS", "JSON", "YAML",
        "Markdown",
        // Frameworks / tools
        "GitHub", "Docker", "Postgres", "PostgreSQL", "Redis", "MongoDB", "MySQL",
        "React", "NextJS", "Node", "NodeJS", "Vite", "Webpack", "Tailwind",
        "Parcel", "Xcode", "VSCode", "Homebrew", "Nix",
        // Platforms / OS
        "iOS", "macOS", "Ubuntu", "Linux", "Android", "Windows", "Sonoma",
        "Sequoia", "MacBook", "iPhone", "iPad", "AppleWatch", "Silicon", "Intel",
        // Common cloud/SaaS that everyone uses
        "Apple", "Google", "Microsoft", "Amazon", "Meta", "Netflix", "Spotify",
        "Dropbox", "iCloud", "Drive", "Gmail",
        "Discord", "Slack", "Notion", "Obsidian", "Jira", "Linear",
        "YouTube", "LinkedIn", "Twitter", "Reddit",
        // AI tools (generic)
        "Claude", "ChatGPT", "Copilot", "Cursor", "Gemini", "OpenAI", "Anthropic",
        "Ollama", "LLMs", "Llama", "Sonnet", "Haiku",
        // Protocols / acronyms
        "MCP", "RRF", "NER", "HNSW", "GIN", "SSO", "APIs", "WiFi", "VPN", "VPNs",
        "IPsec", "EMEA", "APAC", "HVAC",
        // Generic product nouns / roles
        "Director", "Manager", "Engineer", "Product", "Corporate", "Strategy",
        "Management", "Marketing", "Design", "Finance", "Operations",
        "FinTech", "SaaS", "PaaS", "IaaS", "B2B", "B2C", "API",
        // Common CLI commands
        "ssh", "curl", "node", "grep", "tail", "kill", "launchctl", "brew", "git",
        "npm", "ping", "cat", "ls", "rm", "cp", "mv", "sudo", "chmod", "chown",
        // Hardware identifiers
        "MBP", "M1", "M2", "M3", "M4",
        // Time
        "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
        "January", "February", "March", "April", "June", "July", "August",
        "September", "October", "November", "December",
        // Common English words that get capitalised mid-sentence
        "English", "Weather", "Storm", "Phase", "Code", "Push", "Hand", "Chip",
        "Store", "Cloud", "Vault", "Volumes", "Library", "Logs", "Users",
        "Maine", "Coon", "Ford", "Sync", "Drive", "Finder", "Bonjour",
    ]
    .into_iter()
    .collect()
});

/// Exact-match check used by the regex CamelCase + custom-entity passes.
/// Case-sensitive on purpose — `"Slack"` is allowlisted, `"SLACK"` isn't,
/// because `SLACK` mid-sentence is more likely a project name than the
/// well-known SaaS.
pub fn is_allowlisted(s: &str) -> bool {
    TECH_ALLOWLIST.contains(s)
}
