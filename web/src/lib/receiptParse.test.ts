import { describe, expect, it } from "vitest";
import { parseReceiptText } from "./receiptParse";

const SAMPLE = `Big Bazaar
12/07/2026
Paneer 200g          180.00
Milk 1L               60.00
Bread                 40.00
Subtotal             280.00
GST                     5.00
Total                285.00
`;

describe("parseReceiptText", () => {
  it("extracts merchant, date, total, and line items", () => {
    const parsed = parseReceiptText(SAMPLE);
    expect(parsed.merchant).toBe("Big Bazaar");
    expect(parsed.date).toBe("2026-07-12");
    expect(parsed.totalPaise).toBe(28500);
    expect(parsed.items.map((item) => item.label)).toEqual(["Paneer 200g", "Milk 1L", "Bread"]);
    expect(parsed.items.map((item) => item.amountPaise)).toEqual([18000, 6000, 4000]);
  });

  it("excludes subtotal/tax/total lines from items", () => {
    const parsed = parseReceiptText(SAMPLE);
    expect(parsed.items.some((item) => /subtotal|gst|total/i.test(item.label))).toBe(false);
  });

  it("handles text with no recognizable total gracefully", () => {
    const parsed = parseReceiptText("Random shop\njust some text");
    expect(parsed.totalPaise).toBeNull();
    expect(parsed.items).toEqual([]);
  });
});
