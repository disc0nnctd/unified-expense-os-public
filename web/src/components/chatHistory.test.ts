import { describe, expect, it } from "vitest";
import { bubbleToMessage, type Bubble } from "./ChatPanel";
import { emptyDraft } from "../lib/expenseDraft";
import type { LedgerEntry } from "../types";

const pizza: LedgerEntry = {
  entryId: "entry-pizza",
  contextId: "ctx-flat",
  type: "expense",
  recordedAt: "2026-07-22T10:00:00.000Z",
  effectiveDate: "2026-07-22",
  payerId: "me",
  totalAmount: 20000,
  currency: "INR",
  description: "Pizza",
  category: "dining",
  allocations: [{ participantId: "me", shareAmount: 20000, isPayer: true }],
  version: 1,
  hlc: "1-0-me",
  syncState: "committed",
};

describe("bubbleToMessage", () => {
  it("keeps plain bubbles verbatim", () => {
    expect(bubbleToMessage({ id: 1, role: "user", text: "hi" }, [])).toEqual({ role: "user", content: "hi" });
  });

  it("carries an unresolved draft into the next turn so follow-ups have an antecedent", () => {
    const message = bubbleToMessage(
      {
        id: 2,
        role: "draft",
        draft: { ...emptyDraft(), description: "pizza", amountPaise: 20000, participantNames: ["You", "Ara"], splitMode: "equal" },
        note: "",
        initialContextId: null,
        resolved: null,
      },
      [],
    );
    expect(message?.role).toBe("assistant");
    expect(message?.content).toContain("pizza");
    expect(message?.content).toContain("₹200");
    expect(message?.content).toContain("Ara");
    expect(message?.content).toContain("Awaiting");
  });

  it("reports how a confirm card was resolved", () => {
    const bubble: Bubble = {
      id: 3,
      role: "confirmVoid",
      entryId: "entry-pizza",
      label: "“Pizza”",
      text: "Void “Pizza”?",
      resolved: "Voided — balances updated.",
    };
    expect(bubbleToMessage(bubble, [pizza])?.content).toBe("Void “Pizza”? Voided — balances updated.");
  });

  it("describes a pick-list by its entries, and drops one whose entries are gone", () => {
    expect(bubbleToMessage({ id: 4, role: "entryList", entryIds: ["entry-pizza"], text: "Pick one:" }, [pizza])?.content).toContain(
      "“Pizza” ₹200",
    );
    expect(bubbleToMessage({ id: 5, role: "entryList", entryIds: ["gone"], text: "Pick one:" }, [pizza])).toBeNull();
  });
});
