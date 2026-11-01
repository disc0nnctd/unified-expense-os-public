// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { Participant } from "../types";
import SplitEditor, {
  computeSplit,
  initSplitState,
  splitStateFromDraft,
  type SplitState,
} from "./SplitEditor";

const participants: Participant[] = [
  { participantId: "p-me", displayName: "Divyansh" },
  { participantId: "p-isha", displayName: "Isha" },
];
const memberIds = ["p-me", "p-isha"];

afterEach(cleanup);

describe("computeSplit", () => {
  it("equal mode needs no custom shares", () => {
    const result = computeSplit(initSplitState("equal", memberIds), 45000, "p-me", memberIds);
    expect(result).toEqual({ ok: true });
  });

  it("shares mode converts weights to paise allocations summing to the total", () => {
    const state = splitStateFromDraft(memberIds, { mode: "shares", weights: { "p-me": 2, "p-isha": 1 } });
    const result = computeSplit(state, 45000, "p-me", memberIds);
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.customShares).toBeDefined();
    const sum = Object.values(result.customShares!).reduce((total, share) => total + share, 0);
    expect(sum).toBe(45000);
    expect(result.customShares!["p-me"]).toBeGreaterThan(result.customShares!["p-isha"]);
  });

  it("rejects shares mode when the payer has no weight", () => {
    const state = splitStateFromDraft(memberIds, { mode: "shares", weights: { "p-isha": 1 } });
    const result = computeSplit(state, 45000, "p-me", memberIds);
    expect(result.ok).toBe(false);
  });

  it("custom mode enforces exact paise sum (the server invariant, client-side)", () => {
    const good = splitStateFromDraft(memberIds, {
      mode: "custom",
      amountsPaise: { "p-me": 30000, "p-isha": 15000 },
    });
    expect(computeSplit(good, 45000, "p-me", memberIds)).toEqual({
      ok: true,
      customShares: { "p-me": 30000, "p-isha": 15000 },
    });

    const short = splitStateFromDraft(memberIds, {
      mode: "custom",
      amountsPaise: { "p-me": 30000, "p-isha": 10000 },
    });
    const result = computeSplit(short, 45000, "p-me", memberIds);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("short");
    }
  });
});

function Harness({ initial }: { initial?: SplitState }) {
  const [state, setState] = useState<SplitState>(initial ?? initSplitState("equal", memberIds));
  return (
    <SplitEditor
      memberIds={memberIds}
      participants={participants}
      deviceParticipantId="p-me"
      payerId="p-me"
      amountPaise={45000}
      state={state}
      onChange={setState}
    />
  );
}

describe("SplitEditor component", () => {
  it("shows the equal-split hint by default", () => {
    render(<Harness />);
    expect(screen.getByText(/Split equally:/)).toBeTruthy();
  });

  it("switches to shares mode and previews per-member amounts", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("radio", { name: "By shares" }));
    const weightInput = screen.getByLabelText("Share weight for Isha") as HTMLInputElement;
    expect(weightInput.value).toBe("1");
    fireEvent.change(weightInput, { target: { value: "2" } });
    // 45000 paise at 1:2 → me ₹150, Isha ₹300 (payer absorbs remainder).
    expect(screen.getByText("₹300")).toBeTruthy();
    expect(screen.getByText("₹150")).toBeTruthy();
  });

  it("switches to custom mode and shows the remaining indicator", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("radio", { name: "Custom split" }));
    fireEvent.change(screen.getByLabelText("Share for Divyansh"), { target: { value: "300" } });
    expect(screen.getByText(/₹150 left to assign\./)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Share for Isha"), { target: { value: "150" } });
    expect(screen.getByText("Shares match the total.")).toBeTruthy();
  });

  it("renders a proposed draft split (voice/chat path)", () => {
    render(
      <Harness
        initial={splitStateFromDraft(memberIds, { mode: "shares", weights: { "p-me": 2, "p-isha": 1 } })}
      />,
    );
    const meInput = screen.getByLabelText("Share weight for Divyansh") as HTMLInputElement;
    expect(meInput.value).toBe("2");
  });
});
