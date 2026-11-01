import { describe, expect, it } from "vitest";
import {
  agentActionToTurn,
  buildAgentPrompt,
  buildAgentDigest,
  equalAllocations,
  executeAgentTool,
  parseAgentAction,
  parseAgentReply,
  runAgentLoop,
} from "./agent";
import type { AssistantDeps } from "./assistant";
import { EXPENSE_CATEGORIES } from "./expenseDraft";
import type { ContextRecord, LedgerEntry, Membership, Participant } from "../types";

const participants: Participant[] = [
  { participantId: "me", displayName: "Divyansh" },
  { participantId: "gunjan", displayName: "Gunjan" },
];

const contexts: ContextRecord[] = [
  {
    contextId: "ctx-flat",
    name: "Flat",
    type: "shared",
    ownerParticipantId: "me",
    createdAt: "2026-01-01T00:00:00.000Z",
    defaultSplit: "equal",
    allowSimplifiedDebts: false,
  },
];

const memberships: Membership[] = [
  { membershipId: "m1", contextId: "ctx-flat", participantId: "me", joinedAt: "2026-01-01T00:00:00.000Z", defaultShare: "equal", allowSimplifyForMe: true },
  { membershipId: "m2", contextId: "ctx-flat", participantId: "gunjan", joinedAt: "2026-01-01T00:00:00.000Z", defaultShare: "equal", allowSimplifyForMe: true },
];

const pizza: LedgerEntry = {
  entryId: "entry-pizza",
  contextId: "ctx-flat",
  type: "expense",
  recordedAt: "2026-07-22T10:00:00.000Z",
  effectiveDate: "2026-07-22",
  payerId: "me",
  totalAmount: 2000,
  currency: "USD",
  description: "Pizza",
  category: "dining",
  allocations: [{ participantId: "me", shareAmount: 2000, isPayer: true }],
  version: 1,
  hlc: "1-0-me",
  syncState: "committed",
};

const deps: AssistantDeps = {
  entries: [pizza],
  participants,
  memberships,
  contexts,
  deviceParticipantId: "me",
  serverLlmEnabled: true,
};

describe("buildAgentPrompt", () => {
  const digest = buildAgentDigest(deps);

  it("tells the model what day it is, so relative dates resolve", () => {
    const prompt = buildAgentPrompt([{ role: "user", content: "200 lunch yesterday" }], digest, new Date(2026, 7, 2));
    expect(prompt).toContain("TODAY: 2026-08-02 (Sunday)");
  });

  it("offers the category vocabulary the review card actually accepts", () => {
    const prompt = buildAgentPrompt([{ role: "user", content: "hi" }], digest, new Date(2026, 7, 2));
    for (const category of EXPENSE_CATEGORIES) {
      expect(prompt).toContain(category);
    }
  });

  it("names people the ledger knows, including anyone not in a group yet", () => {
    const loner = { participantId: "ara", displayName: "Ara" };
    const withLoner = buildAgentDigest({ ...deps, participants: [...participants, loner] });
    expect(withLoner.text).toContain("- Ara · not in any group yet");
    expect(withLoner.text).toContain("- Gunjan · Flat");
  });
});

describe("parseAgentAction", () => {
  it("accepts a valid resplit action", () => {
    const action = parseAgentAction('{"action":"resplit_expense","entry":"e1","participants":["You","Gunjan"],"mode":"equal"}');
    expect(action.action).toBe("resplit_expense");
  });

  it("degrades garbage and unknown actions to clarify", () => {
    expect(parseAgentAction("not json").action).toBe("clarify");
    expect(parseAgentAction('{"action":"drop_tables"}').action).toBe("clarify");
    expect(parseAgentAction('{"action":"resplit_expense"}').action).toBe("clarify");
  });
});

describe("equalAllocations", () => {
  it("sums exactly even with a remainder", () => {
    const rows = equalAllocations(1001, ["a", "b", "c"], "a");
    expect(rows.reduce((sum, row) => sum + row.shareAmount, 0)).toBe(1001);
    expect(rows[0].isPayer).toBe(true);
  });
});

describe("agentActionToTurn", () => {
  const digest = buildAgentDigest(deps);

  it("digest lists the entry with a ref, balances, and members", () => {
    expect(digest.text).toContain("[e1]");
    expect(digest.text).toContain("Pizza");
    expect(digest.refToEntryId.e1).toBe("entry-pizza");
  });

  it("turns a resplit action into a confirm card with exact allocations", () => {
    const turn = agentActionToTurn(
      { action: "resplit_expense", entry: "e1", participants: ["You", "Gunjan"], mode: "equal" },
      deps,
      digest,
    );
    expect(turn.kind).toBe("confirmResplit");
    if (turn.kind === "confirmResplit") {
      expect(turn.entryId).toBe("entry-pizza");
      expect(turn.allocations.reduce((sum, row) => sum + row.shareAmount, 0)).toBe(2000);
      expect(turn.allocations).toHaveLength(2);
    }
  });

  it("payer keeps a zero share when they're not among the sharers", () => {
    // "Gunjan owes me the entire amount": Gunjan carries the full total,
    // the payer stays in the allocations with share 0 (server requires the
    // payer to be present — a rejected sync otherwise, seen 2026-07-22).
    const turn = agentActionToTurn(
      { action: "resplit_expense", entry: "e1", participants: ["Gunjan"], mode: "equal" },
      deps,
      digest,
    );
    expect(turn.kind).toBe("confirmResplit");
    if (turn.kind === "confirmResplit") {
      const me = turn.allocations.find((row) => row.participantId === "me");
      const gunjan = turn.allocations.find((row) => row.participantId === "gunjan");
      expect(me?.shareAmount).toBe(0);
      expect(me?.isPayer).toBe(true);
      expect(gunjan?.shareAmount).toBe(2000);
      expect(turn.text).toContain("no share");
    }
  });

  it("asks to add an unknown participant instead of guessing", () => {
    const turn = agentActionToTurn(
      { action: "resplit_expense", entry: "e1", participants: ["Rynaa"], mode: "equal" },
      deps,
      digest,
    );
    expect(turn.kind).toBe("clarify");
  });

  it("maps void to a confirm card via the ref", () => {
    const turn = agentActionToTurn({ action: "void_expense", entry: "e1" }, deps, digest);
    expect(turn.kind).toBe("confirmVoid");
  });

  it("tolerates the bracketed/upper-case ref shapes models echo back", () => {
    expect(agentActionToTurn({ action: "void_expense", entry: "[e1]" }, deps, digest).kind).toBe("confirmVoid");
    expect(agentActionToTurn({ action: "void_expense", entry: "E1" }, deps, digest).kind).toBe("confirmVoid");
  });

  it("resolves a description handed back in place of a ref, when it is unambiguous", () => {
    expect(agentActionToTurn({ action: "void_expense", entry: "pizza" }, deps, digest).kind).toBe("confirmVoid");
  });

  it("offers a pick-list instead of dead-ending on an unresolvable ref", () => {
    const turn = agentActionToTurn({ action: "void_expense", entry: "e9" }, deps, digest);
    expect(turn.kind).toBe("showEntries");
    if (turn.kind === "showEntries") {
      expect(turn.entryIds).toEqual(["entry-pizza"]);
    }
  });

  it("with an empty ledger, points at drafting the expense instead", () => {
    const emptyDeps: AssistantDeps = { ...deps, entries: [] };
    const turn = agentActionToTurn({ action: "void_expense", entry: "e1" }, emptyDeps, buildAgentDigest(emptyDeps));
    expect(turn.kind).toBe("clarify");
    if (turn.kind === "clarify") {
      expect(turn.text).toContain("no entries yet");
    }
  });

  it("maps add_member through the context name", () => {
    const turn = agentActionToTurn({ action: "add_member", context: "Flat", name: "Rynaa" }, deps, digest);
    expect(turn.kind).toBe("confirmAddMember");
    if (turn.kind === "confirmAddMember") {
      expect(turn.contextId).toBe("ctx-flat");
    }
  });
});

describe("tools", () => {
  it("parses a tool request as a tool reply, everything else as an action", () => {
    expect(parseAgentReply('{"tool":"search_entries","text":"pizza","limit":5}').type).toBe("tool");
    expect(parseAgentReply('{"action":"answer","text":"hi"}').type).toBe("action");
    expect(parseAgentReply("garbage").type).toBe("action");
  });

  it("search_entries finds by text and assigns stable refs", () => {
    const digest = buildAgentDigest(deps);
    const result = executeAgentTool({ tool: "search_entries", text: "pizza", limit: 5 }, deps, digest);
    expect(result).toContain("Pizza");
    expect(result).toContain("[e1]"); // reuses the digest's existing ref
  });

  it("get_balances reports the shared context", () => {
    const digest = buildAgentDigest(deps);
    const result = executeAgentTool({ tool: "get_balances", context: null }, deps, digest);
    expect(result).toContain("Flat");
  });

  it("runAgentLoop feeds tool results back and returns the final action", async () => {
    const prompts: string[] = [];
    const responses = [
      '{"tool":"search_entries","text":"pizza","limit":5}',
      '{"action":"resplit_expense","entry":"e1","participants":["You","Gunjan"],"mode":"equal"}',
    ];
    const turn = await runAgentLoop(
      async (prompt) => {
        prompts.push(prompt);
        return responses.shift() ?? null;
      },
      [{ role: "user", content: "split the pizza with gunjan" }],
      deps,
    );
    expect(turn?.kind).toBe("confirmResplit");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("TOOL RESULT");
    expect(prompts[1]).toContain("Pizza");
  });

  it("tells the model an invented ref is bad so it can recover as a new expense", async () => {
    const prompts: string[] = [];
    const responses = [
      // "Split Rs. 200 with Ara" misread as re-splitting an entry that doesn't exist.
      '{"action":"resplit_expense","entry":"e3","participants":["You","Ara"],"mode":"equal"}',
      '{"action":"add_expense","description":"pizza","amount_paise":20000,"participants":["You","Ara"],"split_mode":"equal"}',
    ];
    const turn = await runAgentLoop(
      async (prompt) => {
        prompts.push(prompt);
        return responses.shift() ?? null;
      },
      [{ role: "user", content: "Split Rs. 200 with Ara" }],
      deps,
    );
    expect(turn?.kind).toBe("draft");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("ERROR: there is no entry");
  });

  it("caps runaway tool loops with a clarify", async () => {
    const turn = await runAgentLoop(
      async () => '{"tool":"get_balances","context":null}',
      [{ role: "user", content: "hmm" }],
      deps,
    );
    expect(turn?.kind).toBe("clarify");
  });
});

describe("remote tiers never see personal contexts", () => {
  const personalContext: ContextRecord = {
    contextId: "ctx-me",
    name: "Personal",
    type: "personal",
    ownerParticipantId: "me",
    createdAt: "2026-01-01T00:00:00.000Z",
    defaultSplit: "equal",
    allowSimplifiedDebts: false,
  };
  const therapy: LedgerEntry = {
    ...pizza,
    entryId: "entry-therapy",
    contextId: "ctx-me",
    description: "Therapy session",
    allocations: [{ participantId: "me", shareAmount: 2000, isPayer: true }],
  };
  const mixedDeps: AssistantDeps = {
    ...deps,
    contexts: [...contexts, personalContext],
    entries: [pizza, therapy],
    memberships: [
      ...memberships,
      {
        membershipId: "m3",
        contextId: "ctx-me",
        participantId: "me",
        joinedAt: "2026-01-01T00:00:00.000Z",
        defaultShare: "equal",
        allowSimplifyForMe: true,
      },
    ],
  };

  it("omits personal entries and context names from a remote prompt", async () => {
    let sentPrompt = "";
    await runAgentLoop(
      async (prompt) => {
        sentPrompt = prompt;
        return '{"action":"answer","text":"ok"}';
      },
      [{ role: "user", content: "what did we spend?" }],
      mixedDeps,
      { remote: true },
    );
    expect(sentPrompt).toContain("Pizza");
    expect(sentPrompt).not.toContain("Therapy session");
    expect(sentPrompt).not.toContain("Personal");
  });

  it("omits a person known only through a personal context from a remote prompt", async () => {
    const secret = { participantId: "p-secret", displayName: "Sanjana" };
    let sentPrompt = "";
    await runAgentLoop(
      async (prompt) => {
        sentPrompt = prompt;
        return '{"action":"answer","text":"ok"}';
      },
      [{ role: "user", content: "who do I know?" }],
      {
        ...mixedDeps,
        participants: [...mixedDeps.participants, secret],
        memberships: [
          ...mixedDeps.memberships,
          {
            membershipId: "m4",
            contextId: "ctx-me",
            participantId: "p-secret",
            joinedAt: "2026-01-01T00:00:00.000Z",
            defaultShare: "equal" as const,
            allowSimplifyForMe: true,
          },
        ],
      },
      { remote: true },
    );
    expect(sentPrompt).not.toContain("Sanjana");
    expect(sentPrompt).toContain("Gunjan");
  });

  it("keeps the full picture for on-device tiers", async () => {
    let sentPrompt = "";
    await runAgentLoop(
      async (prompt) => {
        sentPrompt = prompt;
        return '{"action":"answer","text":"ok"}';
      },
      [{ role: "user", content: "what did we spend?" }],
      mixedDeps,
    );
    expect(sentPrompt).toContain("Therapy session");
  });
});
