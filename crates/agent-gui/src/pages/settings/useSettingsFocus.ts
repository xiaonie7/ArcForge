import { useLayoutEffect, useRef } from "react";

/** Keep the mounted chat out of keyboard navigation while settings cover it. */
export function useSettingsFocus(open: boolean) {
  const backgroundRef = useRef<HTMLDivElement>(null);
  const settingsSurfaceRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const background = backgroundRef.current;
    const surface = settingsSurfaceRef.current;
    if (!open || !background || !surface) return;

    const previousFocus = document.activeElement;
    const wasInert = background.inert;
    // Move focus before making the old surface inert. Portaled settings dialogs
    // and the native window controls remain available outside the chat subtree.
    (surface.querySelector<HTMLElement>("h1") ?? surface).focus({ preventScroll: true });
    background.inert = true;

    return () => {
      background.inert = wasInert;
      if (!background.isConnected) return;
      if (
        previousFocus instanceof HTMLElement &&
        previousFocus !== document.body &&
        previousFocus !== document.documentElement &&
        previousFocus.isConnected
      ) {
        previousFocus.focus({ preventScroll: true });
        if (document.activeElement === previousFocus) return;
      }
      // The original trigger may have disappeared after opening another chat.
      background.focus({ preventScroll: true });
    };
  }, [open]);

  return { backgroundRef, settingsSurfaceRef };
}
