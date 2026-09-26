import { useRef } from "react";
import { useBlocker } from "@tanstack/react-router";
import { Button, Dialog } from "./ui";

/**
 * Leaving a form with changes asks first — a link, the Back button, or closing the tab. "Changes" is decided by the caller
 * (the form differs from the snapshot taken when it was loaded or last saved), not by any key press. `allowLeave()` lets the
 * next navigation through (after a successful save, when the form is about to be replaced by the invoice's page).
 */
export function useUnsavedGuard(dirty: boolean) {
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const bypass = useRef(false);
  const blocker = useBlocker({
    shouldBlockFn: () => dirtyRef.current && !bypass.current,
    enableBeforeUnload: () => dirtyRef.current && !bypass.current,
    withResolver: true,
  });
  return {
    blocked: blocker.status === "blocked",
    stay: () => blocker.reset?.(),
    leave: () => blocker.proceed?.(),
    allowLeave: () => {
      bypass.current = true;
    },
  };
}

export function UnsavedChangesDialog({ open, onStay, onLeave, noun = "invoice" }: { open: boolean; onStay: () => void; onLeave: () => void; noun?: string }) {
  return (
    <Dialog open={open} onClose={onStay} title="Leave without saving?" description={`You have changes on this ${noun} that have not been saved. If you leave now they are lost.`}>
      <div className="flex flex-wrap justify-end gap-2">
        <Button onClick={onStay} data-testid="stay">
          Keep editing
        </Button>
        <Button variant="danger" onClick={onLeave} data-testid="leave">
          Leave and lose changes
        </Button>
      </div>
    </Dialog>
  );
}
