import { describe, expect, it } from "vitest";
import { buildLocalIntentPrompt, draftFromLlm, isQuestionShaped, parseIntentJson, parseNavigation } from "./assistant";
import type { ContextRecord } from "../types";

const contexts: ContextRecord[] = [
  {
    contextId: "c-flat",
    name: "Flat",
    type: "shared",
    ownerParticipantId: "p-me",
    createdAt: "2026-01-01",
    defaultSplit: "equal",
    allowSimplifiedDebts: true,
  },
  {
    contextId: "c-goa",
    name: "Goa Trip",
    type: "shared",
    ownerParticipantId: "p-me",
    createdAt: "2026-06-01",
    defaultSplit: "equal",
    allowSimplifiedDebts: true,
  },
];

describe("parseNavigation", () => {
  it("opens a context by fuzzy name", () => {
    expect(parseNavigation("open flat", contexts)).toEqual({ kind: "context", contextId: "c-flat", tab: undefined });
    expect(parseNavigation("go to goa", contexts)).toEqual({ kind: "context", contextId: "c-goa", tab: undefined });
  });

  it("routes to a specific tab", () => {
    expect(parseNavigation("open flat balances", contexts)).toEqual({
      kind: "context",
      contextId: "c-flat",
      tab: "balances",
    });
    expect(parseNavigation("show goa trip reports", contexts)).toEqual({
      kind: "context",
      contextId: "c-goa",
      tab: "reports",
    });
  });

  it("handles settings and home", () => {
    expect(parseNavigation("go to settings", contexts)).toEqual({ kind: "settings" });
    expect(parseNavigation("open home", contexts)).toEqual({ kind: "home" });
  });

  it("returns null for non-navigation or unknown targets", () => {
    expect(parseNavigation("how much did we spend", contexts)).toBeNull();
    expect(parseNavigation("open narnia", contexts)).toBeNull();
    expect(parseNavigation("450 dinner split equally", contexts)).toBeNull();
  });
});

describe("parseIntentJson", () => {
  it("parses a clean draft_expense intent", () => {
    const parsed = parseIntentJson(
      '{"intent":"draft_expense","draft":{"description":"Dinner","amount_paise":45000,"category":"dining","participants":[],"payer":"Isha","split_mode":"equal","shares":null,"amounts_paise":null,"context_hint":null,"date":null},"query":null,"clarify_question":null,"reply":null}',
    );
    expect(parsed.intent).toBe("draft_expense");
    expect(parsed.draft?.amount_paise).toBe(45000);
  });

  it("extracts JSON embedded in chatter", () => {
    const parsed = parseIntentJson('Sure! Here you go: {"intent":"none","reply":"hello"} hope that helps');
    expect(parsed.intent).toBe("none");
    expect(parsed.reply).toBe("hello");
  });

  it("degrades any garbage to clarify, never throws", () => {
    expect(parseIntentJson("total nonsense").intent).toBe("clarify");
    expect(parseIntentJson("{broken json").intent).toBe("clarify");
    expect(parseIntentJson('{"intent":"rm_rf_everything"}').intent).toBe("clarify");
    expect(parseIntentJson("").intent).toBe("clarify");
  });

  it("strips drafts from non-draft intents and queries from non-query intents", () => {
    const parsed = parseIntentJson(
      '{"intent":"none","draft":{"description":"sneaky","amount_paise":1},"query":{"metric":"total_spend"}}',
    );
    expect(parsed.draft).toBeNull();
    expect(parsed.query).toBeNull();
  });
});

describe("draftFromLlm", () => {
  it("maps the server draft shape onto the client ExpenseDraft", () => {
    const draft = draftFromLlm({
      description: "Dinner",
      amount_paise: 45000,
      category: "dining",
      participants: ["Isha"],
      payer: "Isha",
      split_mode: "shares",
      shares: { Isha: 2, me: 1 },
      amounts_paise: null,
      context_hint: "Flat",
      date: "2026-07-21",
    });
    expect(draft.amountPaise).toBe(45000);
    expect(draft.payerName).toBe("Isha");
    expect(draft.splitMode).toBe("shares");
    expect(draft.shares).toEqual({ Isha: 2, me: 1 });
    expect(draft.effectiveDate).toBe("2026-07-21");
  });

  it("tolerates the legacy minimal shape", () => {
    const draft = draftFromLlm({ description: null, amount_paise: null, category: null, participants: [] });
    expect(draft.amountPaise).toBeNull();
    expect(draft.splitMode).toBeNull();
  });
});

describe("buildLocalIntentPrompt", () => {
  it("includes the closed vocabulary, names, and recent turns only", () => {
    const prompt = buildLocalIntentPrompt(
      [
        { role: "user", content: "old turn 1" },
        { role: "user", content: "old turn 2" },
        { role: "user", content: "t3" },
        { role: "assistant", content: "t4" },
        { role: "user", content: "t5" },
        { role: "assistant", content: "t6" },
        { role: "user", content: "how much on groceries?" },
      ],
      ["Divyansh", "Isha"],
      ["groceries"],
    );
    expect(prompt).toContain("query_ledger");
    expect(prompt).toContain("never compute totals or balances yourself");
    expect(prompt).toContain("Divyansh, Isha");
    expect(prompt).toContain("how much on groceries?");
    // Only the last 6 turns are included.
    expect(prompt).not.toContain("old turn 1");
  });
});

describe("isQuestionShaped", () => {
  // The AI-first fallback used to skip this guard, so with every model tier
  // down a spoken question became a draft expense (unified-expense-os-evb).
  it("treats wh-questions as questions even without a question mark", () => {
    // Voice transcripts almost never carry punctuation.
    expect(isQuestionShaped("did we spend 450 on pizza")).toBe(true);
    expect(isQuestionShaped("how much did the pizza cost")).toBe(true);
    expect(isQuestionShaped("who owes me money")).toBe(true);
  });

  it("treats a trailing question mark as a question", () => {
    expect(isQuestionShaped("450 on pizza?")).toBe(true);
  });

  it("leaves plain capture phrasing alone", () => {
    expect(isQuestionShaped("450 dinner split equally")).toBe(false);
    expect(isQuestionShaped("paid 300 for cab")).toBe(false);
  });
});
