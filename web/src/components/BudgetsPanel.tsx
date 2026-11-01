import { FormEvent, useEffect, useState } from "react";
import { clearBudgetTarget, computeBudgetProgress, getBudgetTargets, setBudgetTarget, type BudgetTargets } from "../lib/budgets";
import { formatMoneyIn } from "../lib/currencies";
import { parseAmountToPaise } from "../lib/finance";
import type { LedgerEntry } from "../types";

type Props = {
  contextId: string;
  entries: LedgerEntry[];
  currency: string;
};

// Budget targets are stored purely on-device (IndexedDB meta, never synced)
// and progress is informational only — nothing here blocks or alters a save.
export default function BudgetsPanel({ contextId, entries, currency }: Props) {
  const [targets, setTargets] = useState<BudgetTargets>({});
  const [category, setCategory] = useState("");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void getBudgetTargets(contextId).then(setTargets);
  }, [contextId]);

  const progress = computeBudgetProgress(entries, targets);

  async function handleAdd(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const paise = parseAmountToPaise(amount);
    if (!category.trim()) {
      setError("Pick a category.");
      return;
    }
    if (paise === null || paise <= 0) {
      setError("Enter a valid monthly target.");
      return;
    }
    const updated = await setBudgetTarget(contextId, category.trim(), paise);
    setTargets(updated);
    setCategory("");
    setAmount("");
  }

  async function handleRemove(cat: string) {
    setTargets(await clearBudgetTarget(contextId, cat));
  }

  return (
    <article className="panel">
      <div className="panel-header">
        <h2>Budgets</h2>
        <span>Informational only</span>
      </div>
      {progress.length === 0 ? (
        <div className="info-strip">
          <span>No budgets set. Targets are local to this device and never block a save.</span>
        </div>
      ) : (
        <div className="balance-list">
          {progress.map((row) => (
            <div className="balance-row" key={row.category} style={{ flexDirection: "column", alignItems: "stretch" }}>
              <span style={{ display: "flex", justifyContent: "space-between" }}>
                <span>
                  {row.category} {row.fraction > 1 ? <strong className="error-text">over budget</strong> : null}
                </span>
                <span>
                  {formatMoneyIn(currency, row.spentPaise)} / {formatMoneyIn(currency, row.targetPaise)}
                </span>
              </span>
              <span
                style={{
                  display: "block",
                  height: 6,
                  borderRadius: 3,
                  background: "currentColor",
                  opacity: 0.35,
                  width: `${Math.min(100, row.fraction * 100)}%`,
                }}
              />
              <button className="secondary compact" onClick={() => handleRemove(row.category)}>
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
      <form className="entry-form" onSubmit={handleAdd} style={{ marginTop: 12 }}>
        <label>
          Category
          <input value={category} onChange={(event) => setCategory(event.target.value)} placeholder="groceries" />
        </label>
        <label>
          Monthly target (₹)
          <input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="6000" />
        </label>
        {error ? <span className="error-text wide">{error}</span> : null}
        <div className="form-actions wide">
          <button type="submit" className="secondary">
            Set budget
          </button>
        </div>
      </form>
    </article>
  );
}
