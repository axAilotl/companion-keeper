import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { MemoryEntry } from "@gptdataexport/shared";
import { LoreSplitView } from "@/components/LoreSplitView";

const sampleMemories: MemoryEntry[] = [
  { id: "memory-1", keys: ["routine", "night"], content: "Nightly check-in and grounding." },
  { id: "memory-2", keys: ["projects", "workflow"], content: "Shared workflow for long builds." },
];

describe("LoreSplitView", () => {
  it("renders active memory content and switches entries", () => {
    let active = "memory-1";
    const setActive = (id: string): void => {
      active = id;
    };

    const { rerender } = render(
      <LoreSplitView
        memories={sampleMemories}
        activeMemoryId={active}
        onSelectMemory={setActive}
      />,
    );

    expect(screen.getByText("Nightly check-in and grounding.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /projects/i }));
    rerender(
      <LoreSplitView
        memories={sampleMemories}
        activeMemoryId={active}
        onSelectMemory={setActive}
      />,
    );

    expect(screen.getByText("Shared workflow for long builds.")).toBeInTheDocument();
  });
});
