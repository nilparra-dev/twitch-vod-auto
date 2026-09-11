import { useEffect, useState } from "react";

/**
 * Theater mode owns the body scroll lock and the Escape shortcut, so the
 * player component does not touch the document directly.
 */
export function useTheaterMode(): [boolean, (value: boolean) => void] {
  const [theater, setTheater] = useState(false);

  useEffect(() => {
    if (!theater) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setTheater(false);
    };
    document.addEventListener("keydown", escape);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener("keydown", escape);
    };
  }, [theater]);

  return [theater, setTheater];
}
