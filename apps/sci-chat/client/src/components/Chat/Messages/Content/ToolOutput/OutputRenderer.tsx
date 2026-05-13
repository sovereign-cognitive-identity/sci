import { useState, useMemo, useCallback, useContext } from 'react';
import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued';
import { ThemeContext, isDark } from '@librechat/client';
import copy from 'copy-to-clipboard';
import CopyButton from '~/components/Messages/Content/CopyButton';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

interface ContentBlock {
  type?: string;
  text?: string;
}

const ERROR_PREFIX = /^Error:\s*(\[.*?\]\s*)*tool call failed:\s*/i;
const ERROR_INNER = /^Error\s+\w+ing to endpoint\s*\(HTTP \d+\):\s*/i;

function cleanError(text: string): string {
  let cleaned = text.replace(ERROR_PREFIX, '').trim();
  cleaned = cleaned.replace(ERROR_INNER, '').trim();
  if (cleaned.endsWith('Please fix your mistakes.')) {
    cleaned = cleaned.slice(0, -'Please fix your mistakes.'.length).trim();
  }
  return cleaned;
}

export function isError(text: string): boolean {
  return ERROR_PREFIX.test(text) || text.startsWith('Error processing tool');
}

function isStructuredText(text: string): boolean {
  return text.includes('\n') || text.includes('{') || text.includes(':');
}

function isDiff(text: string): boolean {
  const lines = text.split('\n').slice(0, 10);
  const markers = lines.filter(
    (l) =>
      l.startsWith('---') ||
      l.startsWith('+++') ||
      l.startsWith('@@') ||
      l.startsWith('diff '),
  );
  return markers.length >= 2;
}

/**
 * Parses a unified diff string into { oldText, newText } suitable for react-diff-viewer-continued.
 * Strips the --- / +++ header lines and reconstructs both sides from +/- lines.
 */
function parseUnifiedDiff(diff: string): { oldText: string; newText: string; filename: string } {
  const lines = diff.split('\n');
  const oldLines: string[] = [];
  const newLines: string[] = [];
  let filename = '';

  for (const line of lines) {
    if (line.startsWith('--- ')) {
      // Extract filename from "--- a/path/to/file"
      const match = line.match(/^---\s+(?:a\/)?(.+)/);
      if (match && match[1] && match[1] !== '/dev/null') {
        filename = match[1];
      }
      continue;
    }
    if (line.startsWith('+++ ')) {
      if (!filename) {
        const match = line.match(/^\+\+\+\s+(?:b\/)?(.+)/);
        if (match && match[1] && match[1] !== '/dev/null') {
          filename = match[1];
        }
      }
      continue;
    }
    if (line.startsWith('@@')) {
      // Keep hunk boundary as a context line on both sides so line numbers align
      continue;
    }
    if (line.startsWith('diff ') || line.startsWith('index ')) {
      continue;
    }
    if (line.startsWith('-')) {
      oldLines.push(line.slice(1));
    } else if (line.startsWith('+')) {
      newLines.push(line.slice(1));
    } else {
      // Context line — present on both sides
      const content = line.startsWith(' ') ? line.slice(1) : line;
      oldLines.push(content);
      newLines.push(content);
    }
  }

  return { oldText: oldLines.join('\n'), newText: newLines.join('\n'), filename };
}

interface ExtractedText {
  text: string;
  rawError: string;
  error: boolean;
  /** When true, `text` contains raw JSON that should be rendered as a highlighted code block. */
  isJson: boolean;
}

function extractText(raw: string): ExtractedText {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { text: '', rawError: '', error: false, isJson: false };
  }

  if (isError(trimmed)) {
    return { text: cleanError(trimmed), rawError: trimmed, error: true, isJson: false };
  }

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);

      if (Array.isArray(parsed)) {
        const textBlocks = parsed.filter(
          (b: ContentBlock) => typeof b === 'object' && b !== null && typeof b.text === 'string',
        );
        if (textBlocks.length > 0) {
          const joined = (textBlocks as ContentBlock[])
            .map((b) => b.text)
            .join('\n')
            .trim();
          if (isError(joined)) {
            return { text: cleanError(joined), rawError: joined, error: true, isJson: false };
          }
          return { text: joined, rawError: '', error: false, isJson: false };
        }
      }

      // Render structured JSON as a highlighted code block
      return {
        text: JSON.stringify(parsed, null, 2),
        rawError: '',
        error: false,
        isJson: true,
      };
    } catch {
      // Not JSON
    }
  }

  return { text: trimmed, rawError: '', error: false, isJson: false };
}

const TRUNCATE_LINES = 20;
const VISIBLE_LINES = 15;

interface OutputRendererProps {
  text: string;
}

export default function OutputRenderer({ text }: OutputRendererProps) {
  const localize = useLocalize();
  const { theme } = useContext(ThemeContext);
  const useDarkTheme = isDark(theme);

  const { text: displayText, rawError, error, isJson } = useMemo(() => extractText(text), [text]);
  const [isExpanded, setIsExpanded] = useState(false);
  const [showErrorDetails, setShowErrorDetails] = useState(false);
  const [isCopied, setIsCopied] = useState(false);

  const handleCopy = useCallback(() => {
    setIsCopied(true);
    copy(displayText, { format: 'text/plain' });
    setTimeout(() => setIsCopied(false), 3000);
  }, [displayText]);

  const isDiffOutput = useMemo(
    () => !error && !isJson && isDiff(displayText),
    [error, isJson, displayText],
  );

  const parsedDiff = useMemo(
    () => (isDiffOutput ? parseUnifiedDiff(displayText) : null),
    [isDiffOutput, displayText],
  );

  if (!displayText) {
    return null;
  }

  const lines = displayText.split('\n');
  const needsTruncation = !isDiffOutput && lines.length > TRUNCATE_LINES;
  const visibleText =
    needsTruncation && !isExpanded ? lines.slice(0, VISIBLE_LINES).join('\n') : displayText;
  const structured = !isJson && isStructuredText(displayText);

  return (
    <div className="relative">
      {isJson ? (
        <pre className="max-h-[300px] overflow-auto rounded text-xs">
          <code className="hljs language-json !whitespace-pre-wrap !break-words">{visibleText}</code>
        </pre>
      ) : isDiffOutput && parsedDiff ? (
        <div className="max-h-[400px] overflow-auto rounded text-xs [&_pre]:!text-xs [&_td]:!py-0">
          <ReactDiffViewer
            oldValue={parsedDiff.oldText}
            newValue={parsedDiff.newText}
            splitView={false}
            compareMethod={DiffMethod.WORDS}
            useDarkTheme={useDarkTheme}
            hideLineNumbers={false}
            showDiffOnly={true}
            extraLinesSurroundingDiff={2}
            disableWorker={true}
            leftTitle={parsedDiff.filename || undefined}
            styles={{
              variables: {
                dark: {
                  diffViewerBackground: 'transparent',
                  diffViewerColor: 'inherit',
                  addedBackground: 'rgba(34,197,94,0.12)',
                  addedColor: 'rgb(134,239,172)',
                  removedBackground: 'rgba(239,68,68,0.12)',
                  removedColor: 'rgb(252,165,165)',
                  wordAddedBackground: 'rgba(34,197,94,0.3)',
                  wordRemovedBackground: 'rgba(239,68,68,0.3)',
                  addedGutterBackground: 'rgba(34,197,94,0.08)',
                  removedGutterBackground: 'rgba(239,68,68,0.08)',
                  gutterBackground: 'transparent',
                  gutterBackgroundDark: 'transparent',
                  codeFoldBackground: 'transparent',
                  emptyLineBackground: 'transparent',
                  gutterColor: 'rgba(156,163,175,0.5)',
                  addedGutterColor: 'rgb(134,239,172)',
                  removedGutterColor: 'rgb(252,165,165)',
                },
                light: {
                  diffViewerBackground: 'transparent',
                  diffViewerColor: 'inherit',
                  addedBackground: 'rgba(34,197,94,0.08)',
                  addedColor: 'rgb(21,128,61)',
                  removedBackground: 'rgba(239,68,68,0.08)',
                  removedColor: 'rgb(185,28,28)',
                  wordAddedBackground: 'rgba(34,197,94,0.25)',
                  wordRemovedBackground: 'rgba(239,68,68,0.25)',
                  addedGutterBackground: 'rgba(34,197,94,0.05)',
                  removedGutterBackground: 'rgba(239,68,68,0.05)',
                  gutterBackground: 'transparent',
                  gutterBackgroundDark: 'transparent',
                  codeFoldBackground: 'transparent',
                  emptyLineBackground: 'transparent',
                  gutterColor: 'rgba(107,114,128,0.6)',
                  addedGutterColor: 'rgb(21,128,61)',
                  removedGutterColor: 'rgb(185,28,28)',
                },
              },
            }}
          />
        </div>
      ) : (
        <pre
          className={cn(
            'max-h-[300px] overflow-auto whitespace-pre-wrap break-words text-xs',
            error && 'font-mono text-red-600 dark:text-red-400',
            !error && structured && 'font-mono text-text-secondary',
            !error && !structured && 'font-sans text-sm text-text-primary',
          )}
        >
          {visibleText}
        </pre>
      )}
      <div className="absolute bottom-0 right-0">
        <CopyButton
          isCopied={isCopied}
          onClick={handleCopy}
          iconOnly
          label={localize('com_ui_copy')}
        />
      </div>
      {needsTruncation && (
        <button
          type="button"
          className="mt-1 text-xs text-text-secondary underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-heavy"
          onClick={() => setIsExpanded((prev) => !prev)}
        >
          {isExpanded ? localize('com_ui_show_less') : localize('com_ui_show_more')}
        </button>
      )}
      {error && rawError && rawError !== displayText && (
        <button
          type="button"
          className="mt-1 block text-xs text-text-secondary underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-heavy"
          onClick={() => setShowErrorDetails((prev) => !prev)}
        >
          {localize('com_ui_details')}
        </button>
      )}
      {showErrorDetails && rawError && (
        <pre className="mt-2 max-h-[200px] overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-red-600 dark:text-red-400">
          {rawError}
        </pre>
      )}
    </div>
  );
}
