import { useMemo, useState } from "react";
import { parseReceiptVision, queueExpense } from "../lib/api";
import { humanizeError } from "../lib/errors";
import { formatMoney, localDateString, participantName } from "../lib/finance";
import { computeLineItemShares, lineItemTotal, loadItemPreferenceHistory, recordLineItemAssignment, suggestAssigneesForLabel, type LineItem } from "../lib/lineItems";
import { parseReceiptText } from "../lib/receiptParse";
import type { Participant } from "../types";

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

type Props = {
  contextId: string;
  memberIds: string[];
  participants: Participant[];
  deviceParticipantId: string;
  online: boolean;
  refresh: () => Promise<void>;
  requestSync: () => void;
  setStatus: (message: string) => void;
};

// OCR runs entirely on-device via tesseract.js (WASM), lazily imported so the
// ~2MB worker/wasm payload only loads when this panel is actually used.
// Everything after OCR is deterministic parsing/assignment the user reviews
// and edits before anything reaches the ledger — assist-only per
// docs/capture-foundation-home-dup.md.
export default function ReceiptCapturePanel({
  contextId,
  memberIds,
  participants,
  deviceParticipantId,
  online,
  refresh,
  requestSync,
  setStatus,
}: Props) {
  const [open, setOpen] = useState(false);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrError, setOcrError] = useState<string | null>(null);
  const [merchant, setMerchant] = useState("");
  const [date, setDate] = useState(() => localDateString(new Date()));
  const [items, setItems] = useState<LineItem[]>([]);
  const [payerId, setPayerId] = useState(deviceParticipantId);
  const [preferenceHistory, setPreferenceHistory] = useState<
    Awaited<ReturnType<typeof loadItemPreferenceHistory>>
  >([]);
  const [saveBusy, setSaveBusy] = useState(false);
  const [useAiVision, setUseAiVision] = useState(false);

  const total = useMemo(() => lineItemTotal(items), [items]);
  const shares = useMemo(() => computeLineItemShares(items, memberIds), [items, memberIds]);

  if (!open) {
    return (
      <article className="panel">
        <div className="panel-header">
          <h2>Scan a receipt</h2>
          <button className="secondary compact" onClick={() => setOpen(true)}>
            Open
          </button>
        </div>
      </article>
    );
  }

  async function handleFile(file: File) {
    setOcrBusy(true);
    setOcrError(null);
    try {
      if (useAiVision) {
        const imageBase64 = await fileToBase64(file);
        const draft = await parseReceiptVision(imageBase64);
        setMerchant(draft.merchant ?? "");
        if (draft.date) {
          setDate(draft.date);
        }
        setItems(
          draft.items.map((item, index) => ({
            id: `vision-${index}`,
            label: item.label,
            amountPaise: item.amountPaise,
            assignedTo: [],
          })),
        );
      } else {
        const { recognize } = await import("tesseract.js");
        const result = await recognize(file, "eng");
        const parsed = parseReceiptText(result.data.text);
        setMerchant(parsed.merchant ?? "");
        if (parsed.date) {
          setDate(parsed.date);
        }
        setItems(parsed.items);
      }
      setPreferenceHistory(await loadItemPreferenceHistory());
    } catch (cause) {
      setOcrError(humanizeError(cause));
    } finally {
      setOcrBusy(false);
    }
  }

  function toggleAssignee(itemId: string, memberId: string) {
    setItems((current) =>
      current.map((item) => {
        if (item.id !== itemId) return item;
        const assignedTo = item.assignedTo.includes(memberId)
          ? item.assignedTo.filter((id) => id !== memberId)
          : [...item.assignedTo, memberId];
        return { ...item, assignedTo };
      }),
    );
  }

  function applySuggestion(itemId: string) {
    const item = items.find((row) => row.id === itemId);
    if (!item) return;
    const suggestion = suggestAssigneesForLabel(preferenceHistory, item.label, memberIds);
    if (!suggestion) return;
    setItems((current) =>
      current.map((row) => (row.id === itemId ? { ...row, assignedTo: suggestion.participantIds } : row)),
    );
  }

  function updateItemField(itemId: string, field: "label" | "amount", value: string) {
    setItems((current) =>
      current.map((item) => {
        if (item.id !== itemId) return item;
        if (field === "label") {
          return { ...item, label: value };
        }
        const paise = Math.round(Number(value.replace(/[^0-9.]/g, "")) * 100) || 0;
        return { ...item, amountPaise: paise };
      }),
    );
  }

  async function handleSave() {
    if (items.length === 0 || total <= 0) {
      setOcrError("Add at least one line item with an amount.");
      return;
    }
    setSaveBusy(true);
    try {
      await queueExpense({
        contextId,
        payerId,
        description: merchant.trim() || "Receipt",
        amountPaise: total,
        participantIds: memberIds,
        customShares: shares,
        effectiveDate: date,
      });
      await recordLineItemAssignment(items);
      await refresh();
      requestSync();
      setStatus(online ? "Receipt saved — syncing now." : "Receipt saved offline — will sync when back online.");
      setItems([]);
      setMerchant("");
      setOpen(false);
    } catch (cause) {
      setOcrError(humanizeError(cause));
    } finally {
      setSaveBusy(false);
    }
  }

  return (
    <article className="panel">
      <div className="panel-header">
        <h2>Scan a receipt</h2>
        <button className="secondary compact" onClick={() => setOpen(false)}>
          Close
        </button>
      </div>
      <label className="toggle-inline" title="Sends the photo to a cloud model instead of parsing it on-device">
        <input type="checkbox" checked={useAiVision} onChange={(event) => setUseAiVision(event.target.checked)} />
        <span>Use AI vision (opt-in — sends photo to a cloud model)</span>
      </label>
      <div className="form-actions wide">
        <input
          type="file"
          accept="image/*"
          capture="environment"
          disabled={ocrBusy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) {
              void handleFile(file);
            }
            event.target.value = "";
          }}
        />
      </div>
      {ocrBusy ? <p className="status">Reading receipt…</p> : null}
      {ocrError ? <p className="status error-text">{ocrError}</p> : null}
      {items.length > 0 ? (
        <>
          <label className="wide">
            Merchant
            <input value={merchant} onChange={(event) => setMerchant(event.target.value)} />
          </label>
          <label>
            Date
            <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </label>
          <label>
            Paid by
            <select value={payerId} onChange={(event) => setPayerId(event.target.value)}>
              {memberIds.map((memberId) => (
                <option key={memberId} value={memberId}>
                  {participantName(participants, memberId)}
                  {memberId === deviceParticipantId ? " (me)" : ""}
                </option>
              ))}
            </select>
          </label>
          <div className="split-list wide">
            {items.map((item) => {
              const suggestion = suggestAssigneesForLabel(preferenceHistory, item.label, memberIds);
              return (
                <div className="split-row" key={item.id} style={{ flexWrap: "wrap" }}>
                  <input
                    value={item.label}
                    onChange={(event) => updateItemField(item.id, "label", event.target.value)}
                    style={{ flex: "1 1 auto" }}
                  />
                  <input
                    className="split-amount"
                    inputMode="decimal"
                    value={(item.amountPaise / 100).toFixed(2)}
                    onChange={(event) => updateItemField(item.id, "amount", event.target.value)}
                  />
                  {memberIds.map((memberId) => (
                    <label className="toggle-inline" key={memberId}>
                      <input
                        type="checkbox"
                        checked={item.assignedTo.includes(memberId)}
                        onChange={() => toggleAssignee(item.id, memberId)}
                      />
                      <span>{participantName(participants, memberId)}</span>
                    </label>
                  ))}
                  {suggestion && suggestion.participantIds.some((id) => !item.assignedTo.includes(id)) ? (
                    <button type="button" className="secondary compact" onClick={() => applySuggestion(item.id)}>
                      {suggestion.reason}
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
          <div className="hint-card wide">
            <span>Total: {formatMoney(total)}</span>
            <span>
              {memberIds
                .map((memberId) => `${participantName(participants, memberId)}: ${formatMoney(shares[memberId] ?? 0)}`)
                .join(" · ")}
            </span>
          </div>
          <div className="form-actions wide">
            <button className="primary" disabled={saveBusy || !online} onClick={handleSave}>
              {saveBusy ? "Saving…" : "Save expense"}
            </button>
          </div>
        </>
      ) : null}
    </article>
  );
}
