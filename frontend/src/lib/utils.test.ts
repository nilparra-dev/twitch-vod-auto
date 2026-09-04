import { describe, expect, it } from "vitest";

import { cn, formatBytes } from "./utils";

describe("formatBytes", () => {
  it("shows a dash for empty or zero values", () => {
    expect(formatBytes(0)).toBe("-");
    expect(formatBytes(null)).toBe("-");
    expect(formatBytes(undefined)).toBe("-");
  });

  it("formatea MB y GB", () => {
    expect(formatBytes(512)).toBe("512 MB");
    expect(formatBytes(2048)).toBe("2.00 GB");
  });
});

describe("cn", () => {
  it("merges and deduplicates Tailwind classes", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
  });

  it("descarta clases condicionales falsas", () => {
    const withFlag = (active: boolean) => cn("text-fg", active && "hidden", "font-medium");
    expect(withFlag(false)).toBe("text-fg font-medium");
    expect(withFlag(true)).toBe("text-fg hidden font-medium");
  });
});
