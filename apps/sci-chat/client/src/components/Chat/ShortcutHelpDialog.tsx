import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { memo } from 'react';

interface ShortcutRow {
  keys: string[];
  label: string;
}

const isMac =
  typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);

const mod = isMac ? '⌘' : 'Ctrl';

const SHORTCUTS: { section: string; rows: ShortcutRow[] }[] = [
  {
    section: 'Navigation',
    rows: [
      { keys: [mod, 'N'], label: 'New conversation' },
      { keys: [mod, '['], label: 'Previous conversation' },
      { keys: [mod, ']'], label: 'Next conversation' },
    ],
  },
  {
    section: 'Input',
    rows: [
      { keys: [mod, 'Enter'], label: 'Send message' },
      { keys: [mod, '/'], label: 'Focus chat input' },
      { keys: [mod, 'L'], label: 'Clear chat input' },
    ],
  },
  {
    section: 'Messages',
    rows: [
      { keys: [mod, '⇧', 'C'], label: 'Copy last assistant response' },
    ],
  },
  {
    section: 'Help',
    rows: [
      { keys: ['?'], label: 'Show this dialog' },
      { keys: ['Esc'], label: 'Close dialog / cancel' },
    ],
  },
];

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="inline-flex min-w-[1.6rem] items-center justify-center rounded border border-border-medium bg-surface-tertiary px-1.5 py-0.5 font-mono text-xs text-text-secondary shadow-sm">
      {children}
    </kbd>
  );
}

interface ShortcutHelpDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function ShortcutHelpDialog({ open, onOpenChange }: ShortcutHelpDialogProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[200] bg-black/40 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content className="fixed left-1/2 top-1/2 z-[201] w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border-light bg-surface-primary p-6 shadow-xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
          <div className="mb-5 flex items-center justify-between">
            <DialogPrimitive.Title className="text-base font-semibold text-text-primary">
              Keyboard shortcuts
            </DialogPrimitive.Title>
            <DialogPrimitive.Close className="rounded p-1 text-text-secondary transition-colors hover:bg-surface-tertiary hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <X size={16} />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          </div>

          <div className="space-y-5">
            {SHORTCUTS.map(({ section, rows }) => (
              <div key={section}>
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-text-secondary">
                  {section}
                </p>
                <div className="space-y-2">
                  {rows.map(({ keys, label }) => (
                    <div
                      key={label}
                      className="flex items-center justify-between gap-4"
                    >
                      <span className="text-sm text-text-primary">{label}</span>
                      <span className="flex shrink-0 items-center gap-1">
                        {keys.map((k) => (
                          <Kbd key={k}>{k}</Kbd>
                        ))}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export default memo(ShortcutHelpDialog);
