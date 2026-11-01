import { describe, expect, it } from "vitest";
import { computeLineItemShares, lineItemTotal, suggestAssigneesForLabel, type LineItem } from "./lineItems";

describe("computeLineItemShares", () => {
  it("splits an assigned item only among its assignees", () => {
    const items: LineItem[] = [{ id: "1", label: "Paneer", amountPaise: 1000, assignedTo: ["alice"] }];
    const shares = computeLineItemShares(items, ["alice", "bob"]);
    expect(shares).toEqual({ alice: 1000, bob: 0 });
  });

  it("falls back to all members for unassigned items", () => {
    const items: LineItem[] = [{ id: "1", label: "Delivery fee", amountPaise: 100, assignedTo: [] }];
    const shares = computeLineItemShares(items, ["alice", "bob"]);
    expect(shares.alice + shares.bob).toBe(100);
  });

  it("never loses or gains paise across many odd-amount items", () => {
    const items: LineItem[] = [
      { id: "1", label: "A", amountPaise: 101, assignedTo: ["alice", "bob", "charlie"] },
      { id: "2", label: "B", amountPaise: 250, assignedTo: ["alice", "bob"] },
      { id: "3", label: "C", amountPaise: 33, assignedTo: [] },
    ];
    const memberIds = ["alice", "bob", "charlie"];
    const shares = computeLineItemShares(items, memberIds);
    const total = Object.values(shares).reduce((sum, value) => sum + value, 0);
    expect(total).toBe(lineItemTotal(items));
  });
});

describe("suggestAssigneesForLabel", () => {
  it("suggests members whose historical inclusion rate is at least half of the max", () => {
    const history = [
      { label: "paneer", participantId: "alice", count: 4 },
      { label: "paneer", participantId: "bob", count: 1 },
    ];
    const suggestion = suggestAssigneesForLabel(history, "Paneer", ["alice", "bob"]);
    expect(suggestion?.participantIds).toEqual(["alice"]);
  });

  it("returns null with no history for the label", () => {
    expect(suggestAssigneesForLabel([], "Paneer", ["alice"])).toBeNull();
  });
});
