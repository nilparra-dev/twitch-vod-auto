import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { StatusBadge } from "./Badge";

describe("StatusBadge", () => {
  it("traduce estados conocidos al español", () => {
    render(<StatusBadge status="uploaded" />);
    expect(screen.getByText("Subido")).toBeInTheDocument();
  });

  it("muestra el estado crudo si es desconocido", () => {
    render(<StatusBadge status="weirdstate" />);
    expect(screen.getByText("weirdstate")).toBeInTheDocument();
  });
});
