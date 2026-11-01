import { describe, expect, it } from "vitest";
import { parseSpokenExpense, spokenWordsToNumber } from "./voiceGrammar";

describe("spokenWordsToNumber", () => {
  it("parses plain unit/tens combinations", () => {
    expect(spokenWordsToNumber("four hundred fifty")).toBe(450);
    expect(spokenWordsToNumber("ninety nine")).toBe(99);
    expect(spokenWordsToNumber("twelve")).toBe(12);
  });

  it("parses scale words including Indian usage", () => {
    expect(spokenWordsToNumber("fifteen hundred")).toBe(1500);
    expect(spokenWordsToNumber("two thousand")).toBe(2000);
    expect(spokenWordsToNumber("one lakh")).toBe(100000);
    expect(spokenWordsToNumber("two and a half thousand")).toBe(2500);
  });

  it("rejects non-number phrases", () => {
    expect(spokenWordsToNumber("dinner tonight")).toBeNull();
    expect(spokenWordsToNumber("")).toBeNull();
  });
});

describe("parseSpokenExpense", () => {
  it("parses the canonical voice phrase: amount + description + equal split", () => {
    const draft = parseSpokenExpense("add 450 dinner split equally");
    expect(draft).not.toBeNull();
    expect(draft?.amountPaise).toBe(45000);
    expect(draft?.splitMode).toBe("equal");
    expect(draft?.category).toBe("dining");
    expect(draft?.confidence).toBe("high");
  });

  it("parses currency-marked amounts", () => {
    expect(parseSpokenExpense("₹450 groceries")?.amountPaise).toBe(45000);
    expect(parseSpokenExpense("rs 120.50 auto")?.amountPaise).toBe(12050);
    expect(parseSpokenExpense("450 rupees dinner")?.amountPaise).toBe(45000);
    expect(parseSpokenExpense("paid 1.2k for the concert")?.amountPaise).toBe(120000);
  });

  it("parses spoken-word amounts", () => {
    const draft = parseSpokenExpense("add four hundred fifty rupees for groceries");
    expect(draft?.amountPaise).toBe(45000);
    expect(draft?.category).toBe("groceries");
  });

  it("captures equal split participants", () => {
    const draft = parseSpokenExpense("900 pizza split equally between me and Isha");
    expect(draft?.splitMode).toBe("equal");
    expect(draft?.participantNames).toEqual(["me", "isha"]);
  });

  it("captures ratio splits with names in order", () => {
    const draft = parseSpokenExpense("split 2 to 1 between me and Ravi, 600 for the cab");
    expect(draft?.splitMode).toBe("shares");
    expect(draft?.shares).toEqual({ me: 2, ravi: 1 });
    expect(draft?.amountPaise).toBe(60000);
  });

  it("keeps ratio mode without names when none are given", () => {
    const draft = parseSpokenExpense("450 dinner split 2 to 1");
    expect(draft?.splitMode).toBe("shares");
    expect(draft?.shares).toBeNull();
  });

  it("captures exact custom splits from name-pays-amount pairs", () => {
    const draft = parseSpokenExpense("movie tickets I pay 300 and Ravi pays 150");
    expect(draft?.splitMode).toBe("custom");
    expect(draft?.amountsPaise).toEqual({ me: 30000, ravi: 15000 });
    // Total implied from the parts.
    expect(draft?.amountPaise).toBe(45000);
  });

  it("captures the payer", () => {
    expect(parseSpokenExpense("450 dinner, Isha paid, split equally")?.payerName).toBe("isha");
    expect(parseSpokenExpense("450 dinner paid by Ravi")?.payerName).toBe("ravi");
    expect(parseSpokenExpense("I paid 450 for dinner")?.payerName).toBe("me");
  });

  it("captures a trailing context hint", () => {
    const draft = parseSpokenExpense("add 450 dinner split equally in Goa trip");
    expect(draft?.contextHint).toBe("goa");
  });

  it("captures relative dates", () => {
    const now = new Date("2026-07-22T12:00:00");
    expect(parseSpokenExpense("450 dinner yesterday", now)?.effectiveDate).toBe("2026-07-21");
    expect(parseSpokenExpense("450 dinner today", now)?.effectiveDate).toBe("2026-07-22");
  });

  it("treats 'unevenly' as a custom split request", () => {
    const draft = parseSpokenExpense("split 450 dinner unevenly");
    expect(draft?.splitMode).toBe("custom");
    expect(draft?.amountsPaise).toBeNull();
  });

  it("identifies currency from words and symbols, null when absent", () => {
    expect(parseSpokenExpense("2500 dollars for the GPU")?.currency).toBe("USD");
    expect(parseSpokenExpense("$25 lunch")?.currency).toBe("USD");
    expect(parseSpokenExpense("€40 museum tickets")?.currency).toBe("EUR");
    expect(parseSpokenExpense("20 pounds cab")?.currency).toBe("GBP");
    expect(parseSpokenExpense("450 rupees dinner")?.currency).toBe("INR");
    // Bare numbers stay currency-null so the review UI asks instead of guessing.
    expect(parseSpokenExpense("450 dinner split equally")?.currency).toBeNull();
  });

  it("parses a mid-sentence with-clause followed by the description", () => {
    const draft = parseSpokenExpense("Split Rs. 500 with Gunjan and Rynaa for Pizza");
    expect(draft?.amountPaise).toBe(50000);
    expect(draft?.currency).toBe("INR");
    expect(draft?.splitMode).toBe("equal");
    expect(draft?.participantNames).toEqual(["me", "gunjan", "rynaa"]);
    expect(draft?.description?.toLowerCase()).toBe("pizza");
    expect(draft?.category).toBe("dining");
  });

  it("parses the GPU-with-Gunjan shape: split cue early, partner named at the end", () => {
    const draft = parseSpokenExpense("Split 2500 dollars spent on GPU with Gunjan");
    expect(draft?.amountPaise).toBe(250000);
    expect(draft?.currency).toBe("USD");
    expect(draft?.splitMode).toBe("equal");
    expect(draft?.participantNames).toEqual(["me", "gunjan"]);
    expect(draft?.description?.toLowerCase()).toBe("gpu");
  });

  it("returns null for content-free input", () => {
    expect(parseSpokenExpense("")).toBeNull();
    expect(parseSpokenExpense("   ")).toBeNull();
  });

  it("still drafts (low confidence) with description but no amount", () => {
    const draft = parseSpokenExpense("dinner with the team");
    expect(draft).not.toBeNull();
    expect(draft?.amountPaise).toBeNull();
    expect(draft?.confidence).toBe("low");
  });
});
