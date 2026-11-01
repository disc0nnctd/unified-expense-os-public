import { getMeta, setMeta } from "./localDb";
import type { LedgerEntry } from "../types";

// Budgets are informational only — computed on-device from the synced
// ledger, with targets stored locally per-context (never synced, never
// blocking a save). Nothing here can prevent an expense from being added.
export type BudgetTargets = Record<string, number>; // category -> monthly paise target

function metaKey(contextId: string): string {
  return `budgetTargets:${contextId}`;
}

export async function getBudgetTargets(contextId: string): Promise<BudgetTargets> {
  return (await getMeta<BudgetTargets>(metaKey(contextId))) ?? {};
}

export async function setBudgetTarget(contextId: string, category: string, amountPaise: number): Promise<BudgetTargets> {
  const current = await getBudgetTargets(contextId);
  const updated = { ...current, [category]: amountPaise };
  await setMeta(metaKey(contextId), updated);
  return updated;
}

export async function clearBudgetTarget(contextId: string, category: string): Promise<BudgetTargets> {
  const current = await getBudgetTargets(contextId);
  const { [category]: _removed, ...rest } = current;
  await setMeta(metaKey(contextId), rest);
  return rest;
}

export type BudgetProgress = {
  category: string;
  targetPaise: number;
  spentPaise: number;
  fraction: number; // spent/target, uncapped so overage is visible
};

export function computeBudgetProgress(
  entries: LedgerEntry[],
  targets: BudgetTargets,
  now = new Date(),
): BudgetProgress[] {
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const spentByCategory = new Map<string, number>();
  for (const entry of entries) {
    if (entry.type !== "expense" || entry.syncState === "rejected" || entry.voidedAt) {
      continue;
    }
    if (!entry.effectiveDate.startsWith(month)) {
      continue;
    }
    const category = entry.category?.trim() || "uncategorized";
    spentByCategory.set(category, (spentByCategory.get(category) ?? 0) + entry.totalAmount);
  }

  return Object.entries(targets)
    .filter(([, targetPaise]) => targetPaise > 0)
    .map(([category, targetPaise]) => {
      const spentPaise = spentByCategory.get(category) ?? 0;
      return { category, targetPaise, spentPaise, fraction: spentPaise / targetPaise };
    })
    .sort((left, right) => right.fraction - left.fraction);
}
