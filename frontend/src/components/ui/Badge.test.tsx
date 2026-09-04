import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { StatusBadge } from "./Badge";

describe("StatusBadge", () => {
  it("formats known statuses", () => {
    render(<StatusBadge status="uploaded" />);
    expect(screen.getByText("Uploaded")).toBeInTheDocument();
  });

  it("shows the raw value for an unknown status", () => {
    render(<StatusBadge status="weirdstate" />);
    expect(screen.getByText("weirdstate")).toBeInTheDocument();
  });
});
