import React, { useState, useEffect, useRef } from 'react';

interface HastText {
  type: 'text';
  value: string;
}

interface HastElement {
  type: 'element';
  tagName: string;
  properties?: { className?: string[] };
  children?: HastNode[];
}

type HastNode = HastText | HastElement;

function hastToReact(nodes: HastNode[]): React.ReactNode[] {
  return nodes.map((node, i) => {
    if (node.type === 'text') {
      return node.value;
    }
    return React.createElement(
      node.tagName,
      { key: i, className: node.properties?.className?.join(' ') },
      node.children ? hastToReact(node.children) : undefined,
    );
  });
}

type LowlightModule = typeof import('lowlight');

let lowlightPromise: Promise<LowlightModule> | null = null;
let lowlightModule: LowlightModule | null = null;

function loadLowlight(): Promise<LowlightModule> {
  if (lowlightModule) {
    return Promise.resolve(lowlightModule);
  }
  if (!lowlightPromise) {
    lowlightPromise = import('lowlight').then((mod) => {
      lowlightModule = mod;
      return mod;
    });
  }
  return lowlightPromise;
}

function highlightCode(mod: LowlightModule, code: string, lang: string): React.ReactNode[] {
  if (lang === 'plaintext') {
    return [code];
  }
  try {
    const tree = mod.lowlight.registered(lang)
      ? mod.lowlight.highlight(lang, code)
      : mod.lowlight.highlightAuto(code);
    return hastToReact(tree.children as HastNode[]);
  } catch {
    return [code];
  }
}

export default function useLazyHighlight(
  code: string | undefined,
  lang: string,
): React.ReactNode[] | null {
  const [highlighted, setHighlighted] = useState<React.ReactNode[] | null>(() => {
    if (!code || !lowlightModule) {
      return null;
    }
    return highlightCode(lowlightModule, code, lang);
  });
  const prevKey = useRef('');

  useEffect(() => {
    const key = `${lang}\0${code ?? ''}`;
    if (key === prevKey.current) {
      return;
    }
    prevKey.current = key;

    if (!code) {
      setHighlighted(null);
      return;
    }

    // Debounce: during streaming the code prop changes on every token, which
    // forces a full lowlight re-parse + thousands of new DOM nodes each time.
    // That's O(N²) total work for an N-token code block — the root cause of
    // the 8-second UpdateLayoutTree calls visible in the performance trace.
    //
    // By debouncing 300ms we skip highlighting while the code is changing
    // rapidly (streaming) and apply it once in a single pass after it settles.
    // The block shows as plain text during streaming and lights up when done.
    const DEBOUNCE_MS = 300;
    let cancelled = false;
    const timer = setTimeout(() => {
      if (lowlightModule) {
        if (!cancelled) setHighlighted(highlightCode(lowlightModule, code, lang));
      } else {
        loadLowlight()
          .then((mod) => { if (!cancelled) setHighlighted(highlightCode(mod, code, lang)); })
          .catch(() => { if (!cancelled) setHighlighted([code]); });
      }
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [code, lang]);

  return highlighted;
}
