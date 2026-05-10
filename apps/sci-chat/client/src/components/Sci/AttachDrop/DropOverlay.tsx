/**
 * Fullscreen drop overlay that fades in while the user is dragging
 * a payload that we'd accept. Pointer-events-none so the underlying
 * page still receives the drop event we listen for.
 *
 * Style intentionally mirrors LibreChat's existing DragDropOverlay
 * so a user toggling between the two paths (RAG upload vs Sci
 * snapshot) doesn't see jarring visual differences. Color is a
 * different accent tint to make the routing distinction visible at
 * a glance.
 */

interface DropOverlayProps {
  active: boolean;
  caption: string;
}

export default function DropOverlay({ active, caption }: DropOverlayProps) {
  return (
    <div
      aria-hidden={!active}
      className={`
        pointer-events-none fixed inset-0 z-[9997] flex flex-col items-center
        justify-center transition-opacity duration-150
        ${active ? 'visible opacity-100' : 'invisible opacity-0'}
      `}
      style={{ backgroundColor: 'rgba(59, 130, 246, 0.18)' }}
    >
      <div className="flex flex-col items-center rounded-2xl border-2 border-dashed border-blue-400 bg-surface-primary/90 px-10 py-8 shadow-2xl">
        <div className="text-3xl">📎</div>
        <h3 className="mt-2 text-base font-semibold text-text-primary">
          Attach as Sci snapshot
        </h3>
        <p className="mt-1 text-xs text-text-secondary">{caption}</p>
      </div>
    </div>
  );
}
