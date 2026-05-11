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
        // Web platform DOM / browser APIs (SCI-197 — model emits these
        // verbatim when writing code; if any get tokenized they corrupt
        // generated source files).
        "FileSystem", "FileSystemEntry", "FileSystemFileEntry",
        "FileSystemDirectoryEntry", "FileSystemDirectoryReader",
        "FileSystemHandle", "FileSystemFileHandle", "FileSystemDirectoryHandle",
        "DataTransfer", "DataTransferItem", "DataTransferItemList",
        "DragEvent", "MouseEvent", "KeyboardEvent", "PointerEvent",
        "FocusEvent", "InputEvent", "WheelEvent", "TouchEvent",
        "CustomEvent", "AbortController", "AbortSignal", "AbortError",
        "FileReader", "FileList", "BlobPart", "FormData",
        "URLSearchParams", "TextEncoder", "TextDecoder",
        "ReadableStream", "WritableStream", "TransformStream",
        "ReadableStreamDefaultReader", "WritableStreamDefaultWriter",
        "WebSocket", "EventSource", "EventTarget", "MessageChannel", "MessagePort",
        "ServiceWorker", "SharedWorker", "BroadcastChannel",
        "IntersectionObserver", "MutationObserver", "ResizeObserver",
        "PerformanceObserver", "PerformanceEntry",
        "HTMLElement", "HTMLDivElement", "HTMLInputElement", "HTMLFormElement",
        "HTMLTextAreaElement", "HTMLButtonElement", "HTMLAnchorElement",
        "HTMLImageElement", "HTMLCanvasElement", "HTMLSelectElement",
        "HTMLOptionElement", "HTMLScriptElement", "HTMLStyleElement",
        "HTMLLinkElement", "HTMLMetaElement", "HTMLBodyElement",
        "HTMLHeadElement", "HTMLTitleElement", "HTMLLabelElement",
        "HTMLSpanElement", "HTMLParagraphElement", "HTMLTableElement",
        "NodeList", "DOMRect", "DOMTokenList", "DOMException",
        "ShadowRoot", "DocumentFragment",
        "CSSStyleDeclaration", "CSSStyleSheet", "CSSRule",
        "IDBDatabase", "IDBObjectStore", "IDBTransaction", "IDBKeyRange", "IDBCursor",
        "CryptoKey", "SubtleCrypto",
        "AudioContext", "AudioBuffer", "AudioNode", "AudioBufferSourceNode",
        "MediaStream", "MediaStreamTrack", "MediaRecorder",
        "RTCPeerConnection", "RTCDataChannel", "RTCSessionDescription",
        "WebGLRenderingContext", "WebGL2RenderingContext",
        "CanvasRenderingContext2D", "OffscreenCanvas",
        // JS/TS standard library identifiers commonly typed in code.
        "Promise", "Array", "Object", "Symbol", "Iterator", "AsyncIterator",
        "Generator", "AsyncGenerator", "WeakMap", "WeakSet", "WeakRef",
        "ArrayBuffer", "SharedArrayBuffer", "DataView",
        "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array",
        "Int32Array", "Uint32Array", "Float32Array", "Float64Array",
        "BigInt64Array", "BigUint64Array", "BigInt",
        "RegExp", "TypeError", "RangeError", "SyntaxError", "ReferenceError",
        "EvalError", "URIError", "AggregateError",
        // Node.js stdlib types.
        "EventEmitter", "Buffer", "BufferEncoding", "NodeJS",
        "ChildProcess", "Readable", "Writable", "Duplex", "PassThrough",
        // React common types — model writes these constantly.
        "ReactNode", "ReactElement", "ReactPortal", "ReactFragment",
        "PropsWithChildren", "PropsWithRef", "FunctionComponent",
        "ComponentType", "ComponentProps", "ComponentClass",
        "ForwardRefRenderFunction", "ForwardedRef", "LegacyRef",
        "MutableRefObject", "RefObject", "RefCallback",
        "SyntheticEvent", "ChangeEvent", "FormEvent",
        "CSSProperties", "HTMLProps", "HTMLAttributes", "InputHTMLAttributes",
        "ButtonHTMLAttributes", "TextareaHTMLAttributes", "AnchorHTMLAttributes",
        "ImgHTMLAttributes", "FormHTMLAttributes", "LabelHTMLAttributes",
        "SelectHTMLAttributes", "OptionHTMLAttributes", "DetailedHTMLProps",
        "AriaAttributes", "AriaRole",
        "SetStateAction", "Dispatch", "DispatchWithoutAction",
        "EffectCallback", "DependencyList",
        // Common Rust std/core types.
        "HashMap", "HashSet", "BTreeMap", "BTreeSet", "VecDeque",
        "BinaryHeap", "LinkedList",
        "PathBuf", "OsString", "OsStr", "CString", "CStr",
        "PhantomData", "PhantomPinned", "ManuallyDrop",
        "UnsafeCell", "RefCell", "OnceCell", "LazyCell", "OnceLock", "LazyLock",
        "AtomicBool", "AtomicI8", "AtomicI16", "AtomicI32", "AtomicI64",
        "AtomicU8", "AtomicU16", "AtomicU32", "AtomicU64", "AtomicUsize", "AtomicIsize",
        "NonNull", "NonZeroI8", "NonZeroI16", "NonZeroI32", "NonZeroI64",
        "NonZeroU8", "NonZeroU16", "NonZeroU32", "NonZeroU64", "NonZeroUsize",
        "TcpStream", "TcpListener", "UdpSocket", "SocketAddr",
        "BufReader", "BufWriter", "BufRead", "AsyncRead", "AsyncWrite",
        "JoinHandle", "JoinSet", "ThreadId",
        "SystemTime", "Instant", "Duration", "UNIX_EPOCH",
        // Common error / result names.
        "BoxError", "DynError", "AnyhowError",
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
