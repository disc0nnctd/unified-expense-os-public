import { FormEvent, useMemo, useState } from "react";
import { createRecurringTemplate, generateDueEntries, updateRecurringTemplate } from "../lib/api";
import { detectRecurringCandidates } from "../lib/capture";
import { humanizeError } from "../lib/errors";
import { formatMoney, parseAmountToPaise, participantName } from "../lib/finance";
import type { LedgerEntry, Participant, RecurringTemplate } from "../types";

type Props = {
  contextId: string;
  templates: RecurringTemplate[];
  entries: LedgerEntry[];
  memberIds: string[];
  participants: Participant[];
  deviceParticipantId: string;
  online: boolean;
  refresh: () => Promise<void>;
  setStatus: (message: string) => void;
};

function formatDay(value: string): string {
  return new Date(value).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

export default function RecurringPanel({
  contextId,
  templates,
  entries,
  memberIds,
  participants,
  deviceParticipantId,
  online,
  refresh,
  setStatus,
}: Props) {
  const [templateDescription, setTemplateDescription] = useState("");
  const [templateAmount, setTemplateAmount] = useState("");
  const [templateDay, setTemplateDay] = useState("1");
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [generatePayerId, setGeneratePayerId] = useState(deviceParticipantId);
  const [generatingTemplateId, setGeneratingTemplateId] = useState<string | null>(null);
  const [creatingCandidateKey, setCreatingCandidateKey] = useState<string | null>(null);
  const [dismissedCandidates, setDismissedCandidates] = useState<Set<string>>(new Set());
  const [togglingTemplateId, setTogglingTemplateId] = useState<string | null>(null);
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [editDescription, setEditDescription] = useState("");
  const [editAmount, setEditAmount] = useState("");
  const [editAnchorDay, setEditAnchorDay] = useState("1");
  const [editError, setEditError] = useState<string | null>(null);

  const existingDescriptions = new Set(templates.map((template) => template.description.trim().toLowerCase()));
  const candidates = useMemo(() => detectRecurringCandidates(entries), [entries]);
  const visibleCandidates = candidates.filter(
    (candidate) =>
      !existingDescriptions.has(candidate.description.trim().toLowerCase()) &&
      !dismissedCandidates.has(`${candidate.description}|${candidate.payerId}`),
  );

  async function handleMakeTemplate(candidate: (typeof candidates)[number]) {
    const key = `${candidate.description}|${candidate.payerId}`;
    setCreatingCandidateKey(key);
    try {
      await createRecurringTemplate({
        contextId,
        description: candidate.description,
        amountPaise: candidate.amountPaise,
        anchorDay: candidate.anchorDay,
      });
      await refresh();
      setStatus(`Recurring template created for "${candidate.description}".`);
    } catch (cause) {
      setStatus(humanizeError(cause));
    } finally {
      setCreatingCandidateKey(null);
    }
  }

  async function handleCreateTemplate(event: FormEvent) {
    event.preventDefault();
    setTemplateError(null);
    const paise = parseAmountToPaise(templateAmount);
    const day = Number(templateDay);
    if (!templateDescription.trim()) {
      setTemplateError("Add a description, e.g. Rent.");
      return;
    }
    if (paise === null || paise <= 0) {
      setTemplateError("Enter a valid amount.");
      return;
    }
    if (!Number.isInteger(day) || day < 1 || day > 31) {
      setTemplateError("Day of month must be 1–31.");
      return;
    }
    try {
      await createRecurringTemplate({
        contextId,
        description: templateDescription.trim(),
        amountPaise: paise,
        anchorDay: day,
      });
      await refresh();
      setTemplateDescription("");
      setTemplateAmount("");
      setStatus("Recurring template saved.");
    } catch (cause) {
      setTemplateError(humanizeError(cause));
    }
  }

  async function handleGenerate(templateId: string) {
    setGeneratingTemplateId(templateId);
    try {
      const created = await generateDueEntries(templateId, generatePayerId);
      await refresh();
      setStatus(
        created > 0
          ? `Generated ${created} due ${created === 1 ? "entry" : "entries"}.`
          : "Nothing due yet for this template.",
      );
    } catch (cause) {
      setStatus(humanizeError(cause));
    } finally {
      setGeneratingTemplateId(null);
    }
  }

  async function handleTogglePause(template: RecurringTemplate) {
    setTogglingTemplateId(template.templateId);
    try {
      await updateRecurringTemplate(
        template.templateId,
        { active: !template.active },
        template.version,
      );
      await refresh();
      setStatus(template.active ? "Template paused." : "Template resumed.");
    } catch (cause) {
      setStatus(humanizeError(cause));
    } finally {
      setTogglingTemplateId(null);
    }
  }

  function startEdit(template: RecurringTemplate) {
    setEditingTemplateId(template.templateId);
    setEditDescription(template.description);
    setEditAmount((template.amount / 100).toString());
    setEditAnchorDay(template.anchorDay.toString());
    setEditError(null);
  }

  function cancelEdit() {
    setEditingTemplateId(null);
  }

  async function handleSaveEdit(template: RecurringTemplate) {
    setEditError(null);
    const paise = parseAmountToPaise(editAmount);
    const day = Number(editAnchorDay);
    if (!editDescription.trim()) {
      setEditError("Add a description, e.g. Rent.");
      return;
    }
    if (paise === null || paise <= 0) {
      setEditError("Enter a valid amount.");
      return;
    }
    if (!Number.isInteger(day) || day < 1 || day > 31) {
      setEditError("Day of month must be 1–31.");
      return;
    }
    try {
      await updateRecurringTemplate(
        template.templateId,
        { description: editDescription.trim(), amountPaise: paise, anchorDay: day },
        template.version,
      );
      setEditingTemplateId(null);
      await refresh();
      setStatus("Recurring template updated.");
    } catch (cause) {
      setEditError(humanizeError(cause));
    }
  }

  return (
    <article className="panel">
      <div className="panel-header">
        <h2>Recurring</h2>
        <span>Monthly obligations</span>
      </div>
      {visibleCandidates.length > 0 ? (
        <ul className="history-list">
          {visibleCandidates.map((candidate) => {
            const key = `${candidate.description}|${candidate.payerId}`;
            return (
              <li key={key}>
                <span>
                  "{candidate.description}" looks recurring — {formatMoney(candidate.amountPaise)} around day{" "}
                  {candidate.anchorDay}, seen {candidate.occurrences} times.
                </span>
                <span className="form-actions">
                  <button
                    className="secondary compact"
                    disabled={!online || creatingCandidateKey !== null}
                    onClick={() => handleMakeTemplate(candidate)}
                  >
                    {creatingCandidateKey === key ? "Creating…" : "Make this a template"}
                  </button>
                  <button
                    className="secondary compact"
                    onClick={() => setDismissedCandidates((current) => new Set(current).add(key))}
                  >
                    Dismiss
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {templates.length > 0 ? (
        <>
          <label className="generate-payer">
            Payer for generated entries
            <select value={generatePayerId} onChange={(event) => setGeneratePayerId(event.target.value)}>
              {memberIds.map((memberId) => (
                <option key={memberId} value={memberId}>
                  {participantName(participants, memberId)}
                  {memberId === deviceParticipantId ? " (me)" : ""}
                </option>
              ))}
            </select>
          </label>
          <ul className="entry-list">
            {templates.map((template) => (
              <li key={template.templateId}>
                {editingTemplateId === template.templateId ? (
                  <div className="inline-edit-form wide">
                    <label>
                      Description
                      <input value={editDescription} onChange={(event) => setEditDescription(event.target.value)} />
                    </label>
                    <label>
                      Amount (₹)
                      <input value={editAmount} onChange={(event) => setEditAmount(event.target.value)} />
                    </label>
                    <label>
                      Day of month
                      <input
                        inputMode="numeric"
                        value={editAnchorDay}
                        onChange={(event) => setEditAnchorDay(event.target.value)}
                      />
                    </label>
                    {editError ? <span className="error-text wide">{editError}</span> : null}
                    <span className="row-actions">
                      <button className="primary compact" onClick={() => handleSaveEdit(template)}>
                        Save
                      </button>
                      <button className="secondary compact" onClick={cancelEdit}>
                        Cancel
                      </button>
                    </span>
                  </div>
                ) : (
                  <>
                    <div>
                      <strong>{template.description}</strong>
                      {!template.active ? <span className="type-chip">Paused</span> : null}
                      <span>
                        Day {template.anchorDay} monthly
                        {template.active ? ` · next due ${formatDay(template.nextDueDate)}` : null}
                      </span>
                    </div>
                    <span className="entry-amount">
                      {formatMoney(template.amount)}
                      {template.active ? (
                        <button
                          className="secondary compact"
                          disabled={!online || generatingTemplateId !== null}
                          onClick={() => handleGenerate(template.templateId)}
                        >
                          {generatingTemplateId === template.templateId ? "Generating…" : "Generate due"}
                        </button>
                      ) : null}
                      <button
                        className="secondary compact"
                        disabled={!online}
                        onClick={() => startEdit(template)}
                      >
                        Edit
                      </button>
                      <button
                        className="secondary compact"
                        disabled={!online || togglingTemplateId !== null}
                        onClick={() => handleTogglePause(template)}
                      >
                        {togglingTemplateId === template.templateId
                          ? "Saving…"
                          : template.active
                            ? "Pause"
                            : "Resume"}
                      </button>
                    </span>
                  </>
                )}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <div className="info-strip">
          <span>No recurring obligations yet. Rent and utilities belong here.</span>
        </div>
      )}
      <form className="entry-form recurring-form" onSubmit={handleCreateTemplate}>
        <label>
          Description
          <input
            value={templateDescription}
            onChange={(event) => setTemplateDescription(event.target.value)}
            placeholder="Rent"
          />
        </label>
        <label>
          Amount (₹)
          <input
            inputMode="decimal"
            value={templateAmount}
            onChange={(event) => setTemplateAmount(event.target.value)}
            placeholder="30000"
          />
        </label>
        <label>
          Day of month
          <input
            inputMode="numeric"
            value={templateDay}
            onChange={(event) => setTemplateDay(event.target.value)}
          />
        </label>
        {templateError ? <span className="error-text wide">{templateError}</span> : null}
        <div className="form-actions wide">
          <button type="submit" className="secondary" disabled={!online}>
            Add recurring
          </button>
        </div>
      </form>
    </article>
  );
}
