/**
 * GATHR — Google One Tap prompt component.
 *
 * - Skips if the user is already authenticated.
 * - Fires once per mount (ref guard survives React Strict Mode double-invocation).
 * - Cancels Google's prompt when the component unmounts.
 * - Redirects to /app on success (callbackURL handles it; fallback checks a fresh session).
 * - On failure / dismiss / skip, leaves all existing auth options intact.
 *
 * Keep this client-only. Never import the auth server module here.
 */
import { useEffect, useRef } from "react";
import { useRouter } from "@tanstack/react-router";
import { authClient } from "@/lib/auth/client";

type GoogleWindow = {
  google?: { accounts?: { id?: { cancel?: () => void } } };
};

function cancelGoogleOneTap() {
  try {
    (window as unknown as GoogleWindow).google?.accounts?.id?.cancel?.();
  } catch {
    // Never let cleanup throw.
  }
}

export function GoogleOneTapPrompt() {
  const { data: session, isPending } = authClient.useSession();
  const router = useRouter();
  const startedRef = useRef(false);
  const mountedRef = useRef(false);

  // Lifecycle: track mount state and cancel the prompt on real unmount.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Deferred so a Strict Mode remount (synchronous) doesn't cancel the prompt.
      setTimeout(() => {
        if (!mountedRef.current) cancelGoogleOneTap();
      }, 0);
    };
  }, []);

  useEffect(() => {
    if (isPending || session) return;
    if (startedRef.current) return;
    startedRef.current = true;

    async function triggerOneTap() {
      try {
        await authClient.oneTap({
          callbackURL: "/app",
          onPromptNotification: (notification) => {
            if (notification.isNotDisplayed?.()) {
              console.info(
                "Google One Tap: not displayed —",
                notification.getNotDisplayedReason?.(),
              );
            } else if (notification.isSkippedMoment?.()) {
              console.info("Google One Tap: skipped —", notification.getSkippedReason?.());
            } else if (notification.isDismissedMoment?.()) {
              console.info("Google One Tap: dismissed —", notification.getDismissedReason?.());
            }
          },
        });

        // Fallback: callbackURL normally navigates. If it didn't, check a FRESH session.
        const fresh = await authClient.getSession();
        if (mountedRef.current && fresh?.data) {
          await router.navigate({ to: "/app", replace: true });
        }
      } catch (err) {
        if (import.meta.env.DEV) {
          console.warn("Google One Tap: flow error (non-fatal):", err);
        }
      }
    }

    void triggerOneTap();
  }, [isPending, session, router]);

  return null;
}
