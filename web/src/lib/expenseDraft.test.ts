import { describe, expect, it } from "vitest";
import {
  applyDraftToNames,
  describedWith,
  emptyDraft,
  findKnownPeople,
  resolveContextName,
  resolveName,
  withoutName,
} from "./expenseDraft";
import type { ContextRecord, Membership, Participant } from "../types";

const participants: Participant[] = [
  { participantId: "p-me", displayName: "Divyansh" },
  { participantId: "p-isha", displayName: "Isha" },
  { participantId: "p-ravi", displayName: "Ravi" },
  { participantId: "p-gone", displayName: "Departed" },
];
const memberIds = ["p-me", "p-isha", "p-ravi"];

describe("resolveName", () => {
  it("maps self words to the device participant", () => {
    expect(resolveName("me", participants, memberIds, "p-me")).toBe("p-me");
    expect(resolveName("I", participants, memberIds, "p-me")).toBe("p-me");
  });

  it("matches exact and prefix names case-insensitively", () => {
    expect(resolveName("isha", participants, memberIds, "p-me")).toBe("p-isha");
    expect(resolveName("rav", participants, memberIds, "p-me")).toBe("p-ravi");
  });

  it("never matches non-members", () => {
    expect(resolveName("Departed", participants, memberIds, "p-me")).toBeNull();
  });

  it("returns null on no match rather than guessing", () => {
    expect(resolveName("zorro", participants, memberIds, "p-me")).toBeNull();
  });
});

describe("resolveContextName", () => {
  const contexts = [
    { contextId: "c-flat", name: "Flat" },
    { contextId: "c-goa", name: "Goa Trip" },
    { contextId: "c-old", name: "Old Flat", archivedAt: "2026-01-01" },
  ] as ContextRecord[];

  it("matches exact, prefix, and substring uniquely", () => {
    expect(resolveContextName("flat", contexts)).toBe("c-flat");
    expect(resolveContextName("goa", contexts)).toBe("c-goa");
    expect(resolveContextName("trip", contexts)).toBe("c-goa");
  });

  it("never matches archived contexts and never guesses on ambiguity", () => {
    expect(resolveContextName("old flat", contexts)).toBeNull();
    expect(resolveContextName("nowhere", contexts)).toBeNull();
  });
});

describe("applyDraftToNames", () => {
  it("resolves payer and equal-subset split into unit share weights", () => {
    const resolved = applyDraftToNames(
      {
        ...emptyDraft(),
        payerName: "isha",
        splitMode: "equal",
        participantNames: ["me", "isha"],
      },
      participants,
      memberIds,
      "p-me",
    );
    expect(resolved.payerId).toBe("p-isha");
    expect(resolved.split).toEqual({ mode: "shares", weights: { "p-me": 1, "p-isha": 1 } });
    expect(resolved.warnings).toEqual([]);
  });

  it("keeps plain equal mode when everyone (or no one) is named", () => {
    const resolved = applyDraftToNames(
      { ...emptyDraft(), splitMode: "equal", participantNames: [] },
      participants,
      memberIds,
      "p-me",
    );
    expect(resolved.split).toEqual({ mode: "equal" });
  });

  it("resolves ratio shares by name", () => {
    const resolved = applyDraftToNames(
      { ...emptyDraft(), splitMode: "shares", shares: { me: 2, ravi: 1 }, participantNames: ["me", "ravi"] },
      participants,
      memberIds,
      "p-me",
    );
    expect(resolved.split).toEqual({ mode: "shares", weights: { "p-me": 2, "p-ravi": 1 } });
  });

  it("resolves custom paise amounts by name", () => {
    const resolved = applyDraftToNames(
      {
        ...emptyDraft(),
        splitMode: "custom",
        amountsPaise: { me: 30000, isha: 15000 },
        participantNames: ["me", "isha"],
      },
      participants,
      memberIds,
      "p-me",
    );
    expect(resolved.split).toEqual({ mode: "custom", amountsPaise: { "p-me": 30000, "p-isha": 15000 } });
  });

  it("drops the split and warns when a name cannot be resolved", () => {
    const resolved = applyDraftToNames(
      { ...emptyDraft(), splitMode: "shares", shares: { me: 2, zorro: 1 }, participantNames: ["me", "zorro"] },
      participants,
      memberIds,
      "p-me",
    );
    expect(resolved.split).toBeNull();
    expect(resolved.warnings.some((warning) => warning.includes("zorro"))).toBe(true);
  });

  it("reports unresolved names once each so the UI can offer ghost-member creation", () => {
    const resolved = applyDraftToNames(
      {
        ...emptyDraft(),
        splitMode: "equal",
        participantNames: ["me", "gunjan"],
        payerName: "gunjan",
      },
      participants,
      memberIds,
      "p-me",
    );
    expect(resolved.unresolvedNames).toEqual(["gunjan"]);
  });

  it("warns on an unresolvable payer instead of guessing", () => {
    const resolved = applyDraftToNames(
      { ...emptyDraft(), payerName: "zorro" },
      participants,
      memberIds,
      "p-me",
    );
    expect(resolved.payerId).toBeNull();
    expect(resolved.warnings.length).toBe(1);
  });
});

describe("findKnownPeople", () => {
  const withAra: Participant[] = [...participants, { participantId: "p-ara", displayName: "Ara" }];
  const contexts: ContextRecord[] = [
    {
      contextId: "ctx-trip",
      name: "Trip",
      type: "shared",
      ownerParticipantId: "p-me",
      createdAt: "2026-01-01T00:00:00.000Z",
      defaultSplit: "equal",
      allowSimplifiedDebts: false,
    },
  ];
  const memberships: Membership[] = [
    {
      membershipId: "m-ara",
      contextId: "ctx-trip",
      participantId: "p-ara",
      joinedAt: "2026-01-01T00:00:00.000Z",
      defaultShare: "equal",
      allowSimplifyForMe: true,
    },
  ];

  it("finds a same-named person from another context, with where they are known from", () => {
    const found = findKnownPeople("Ara", withAra, memberIds, memberships, contexts);
    expect(found).toHaveLength(1);
    expect(found[0].participantId).toBe("p-ara");
    expect(found[0].contextNames).toEqual(["Trip"]);
  });

  it("ignores people who are already members here", () => {
    expect(findKnownPeople("Isha", withAra, memberIds, memberships, contexts)).toEqual([]);
  });

  it("returns nobody for a genuinely new name", () => {
    expect(findKnownPeople("Zoya", withAra, memberIds, memberships, contexts)).toEqual([]);
  });
});

describe("withoutName / describedWith", () => {
  it("drops the name from an equal split", () => {
    const draft = { ...emptyDraft(), splitMode: "equal" as const, participantNames: ["me", "Ara"] };
    expect(withoutName(draft, "ara").participantNames).toEqual(["me"]);
  });

  it("drops it from weights and clears the payer when it was the payer", () => {
    const draft = {
      ...emptyDraft(),
      splitMode: "shares" as const,
      shares: { me: 1, Ara: 2 },
      payerName: "Ara",
    };
    const next = withoutName(draft, "Ara");
    expect(next.shares).toEqual({ me: 1 });
    expect(next.payerName).toBeNull();
  });

  it("falls back to equal rather than an empty operand list meaning everyone", () => {
    const draft = { ...emptyDraft(), splitMode: "custom" as const, amountsPaise: { Ara: 20000 } };
    const next = withoutName(draft, "Ara");
    expect(next.amountsPaise).toBeNull();
    expect(next.splitMode).toBe("equal");
  });

  it("folds the name into the description, only once", () => {
    expect(describedWith("pizza", "Ara")).toBe("pizza — Ara");
    expect(describedWith("pizza at ara", "Ara")).toBe("pizza at ara");
    expect(describedWith("", "Ara")).toBe("Ara");
  });
});
