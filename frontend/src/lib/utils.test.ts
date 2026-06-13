import { describe, expect, it } from "vitest";

import { cn, formatBytes } from "./utils";

describe("formatBytes", () => {
  it("muestra guion para valores vacíos o cero", () => {
    expect(formatBytes(0)).toBe("—");
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(undefined)).toBe("—");
  });

  it("formatea MB y GB", () => {
    expect(formatBytes(512)).toBe("512 MB");
    expect(formatBytes(2048)).toBe("2.00 GB");
  });
});

describe("cn", () => {
  it("combina y deduplica clases de tailwind", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
  });

  it("descarta clases condicionales falsas", () => {
    const withFlag = (active: boolean) => cn("text-fg", active && "hidden", "font-medium");
    expect(withFlag(false)).toBe("text-fg font-medium");
    expect(withFlag(true)).toBe("text-fg hidden font-medium");
  });
});
