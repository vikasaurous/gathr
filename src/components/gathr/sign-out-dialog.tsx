import * as React from "react";
import { useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { signOut } from "@/lib/auth/client";

interface SignOutDialogProps {
  /** Trigger element to open the modal (optional if controlled) */
  trigger?: React.ReactNode;
  /** Controlled open state (optional) */
  open?: boolean;
  /** Controlled open change callback (optional) */
  onOpenChange?: (open: boolean) => void;
}

/**
 * GATHR — Premium Sign-Out Confirmation Dialog.
 *
 * Provides a calm, editorial confirmation modal before terminating the user session.
 * Features:
 * - Instrument Serif headline with Geist Sans body typography.
 * - Deep ink confirmation button with restrained secondary button.
 * - Disables actions and displays loading state during session invalidation.
 * - Cleans client query cache and router context on success.
 * - Displays actionable error without signing out if the request fails.
 * - Full Radix AlertDialog keyboard navigation (Escape, Enter, Tab) and accessibility.
 */
export function SignOutDialog({
  trigger,
  open: controlledOpen,
  onOpenChange: setControlledOpen,
}: SignOutDialogProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const router = useRouter();
  const queryClient = useQueryClient();

  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled ? controlledOpen : internalOpen;

  function handleOpenChange(nextOpen: boolean) {
    if (loading) return; // Prevent closing while logout is inflight
    if (!nextOpen) {
      setError(null);
    }
    if (isControlled) {
      setControlledOpen?.(nextOpen);
    } else {
      setInternalOpen(nextOpen);
    }
  }

  async function handleConfirmSignOut() {
    if (loading) return;
    setLoading(true);
    setError(null);

    try {
      const res = await signOut();
      if (res?.error) {
        setError(res.error.message || "Failed to sign out. Please try again.");
        setLoading(false);
        return;
      }

      // Clear client-side query and router caches without re-running /app's guard after sign-out
      try {
        queryClient.clear();
      } catch {
        // QueryClient clear fallback
      }
      router.clearCache?.();

      // Close modal and navigate directly to login
      handleOpenChange(false);
      await router.navigate({ to: "/login", replace: true });
    } catch (err) {
      console.error("[SignOutDialog] Error signing out:", err);
      setError("An unexpected error occurred while signing out. Please try again.");
      setLoading(false);
    }
  }

  return (
    <AlertDialog open={isOpen} onOpenChange={handleOpenChange}>
      {trigger && <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>}

      <AlertDialogContent
        className="w-[92vw] max-w-[420px] rounded-xl border border-border bg-surface p-6 shadow-sheet sm:rounded-xl"
        onEscapeKeyDown={(e) => {
          if (loading) e.preventDefault();
        }}
      >
        <AlertDialogHeader className="space-y-3 text-left">
          <AlertDialogTitle className="font-serif text-[28px] font-normal leading-tight text-foreground">
            Leaving so <em>soon?</em>
          </AlertDialogTitle>
          <AlertDialogDescription className="text-[14px] leading-relaxed text-foreground/80">
            Are you sure you want to sign out of your GATHR workspace?
          </AlertDialogDescription>
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            Your documents and workspace data will remain safely stored.
          </p>
        </AlertDialogHeader>

        {error && (
          <div
            role="alert"
            className="rounded-md bg-destructive/10 px-3.5 py-2.5 text-[12.5px] text-destructive"
          >
            {error}
          </div>
        )}

        <AlertDialogFooter className="mt-4 flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:space-x-2">
          <AlertDialogCancel
            disabled={loading}
            className="mt-0 h-9 rounded-md border-border bg-surface text-[13px] font-medium text-foreground hover:bg-secondary hover:text-foreground"
          >
            Stay signed in
          </AlertDialogCancel>

          <Button
            type="button"
            variant="ink"
            disabled={loading}
            onClick={handleConfirmSignOut}
            className="h-9 px-4 text-[13px] font-medium"
          >
            {loading ? (
              <span className="flex items-center gap-1.5">
                <Loader2 className="size-3.5 animate-spin" />
                Signing out…
              </span>
            ) : (
              "Sign out"
            )}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
