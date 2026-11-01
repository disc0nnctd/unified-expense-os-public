import { formatMoneyIn, partitionByCurrency } from "./currencies";
import { deriveBalances, participantName } from "./finance";
import type { ContextRecord, LedgerEntry, Membership, Participant } from "../types";

// Compact, model-readable snapshot of the ledger for the assistant's agent
// mode (unified-expense-os-5kp). The model gets real visibility — contexts,
// members, recent entries with short refs, and balances — so conversations
// like "split the last pizza with Gunjan" can resolve against actual data.
//
// Two rules keep this safe with small models:
// - Every number the model might quote (totals, balances) is PRECOMPUTED
//   here; the instructions tell it to quote, never to compute.
// - Entries are addressed by short refs (e1, e2, …) that map back to real
//   entry ids ONLY on this device; the model never sees or invents ids.

export type LedgerDigest = {
  text: string;
  refToEntryId: Record<string, string>;
  contextIdByName: Record<string, string>;
};

const MAX_ENTRIES = 15;

export function buildLedgerDigest(deps: {
  contexts: ContextRecord[];
  memberships: Membership[];
  participants: Participant[];
  entries: LedgerEntry[];
  deviceParticipantId: string;
}): LedgerDigest {
  const { contexts, memberships, participants, entries, deviceParticipantId } = deps;
  const lines: string[] = [];
  const refToEntryId: Record<string, string> = {};
  const contextIdByName: Record<string, string> = {};
  const contextName = (contextId: string): string =>
    contexts.find((context) => context.contextId === contextId)?.name ?? "?";
  const nameOf = (participantId: string): string =>
    participantId === deviceParticipantId ? "You" : participantName(participants, participantId);

  lines.push("CONTEXTS (name · type · members):");
  for (const context of contexts) {
    if (context.archivedAt || context.closedAt) {
      continue;
    }
    contextIdByName[context.name.toLowerCase()] = context.contextId;
    const memberNames = memberships
      .filter((membership) => membership.contextId === context.contextId && !membership.leftAt)
      .map((membership) => nameOf(membership.participantId));
    lines.push(`- ${context.name} · ${context.type} · members: ${memberNames.join(", ") || "(none)"}`);
  }

  // Member lists above only cover people who are in a group. Someone known to
  // this device but in none of them was invisible, so a name like "Ara" read
  // as a restaurant rather than a person the user already knows.
  lines.push("PEOPLE (everyone this device knows · groups they're in):");
  const activeContextIds = new Set(
    contexts.filter((context) => !context.archivedAt && !context.closedAt).map((context) => context.contextId),
  );
  for (const participant of participants) {
    const groups = memberships
      .filter(
        (membership) =>
          membership.participantId === participant.participantId &&
          !membership.leftAt &&
          activeContextIds.has(membership.contextId),
      )
      .map((membership) => contextName(membership.contextId));
    lines.push(
      `- ${nameOf(participant.participantId)}${groups.length > 0 ? ` · ${groups.join(", ")}` : " · not in any group yet"}`,
    );
  }

  lines.push("BALANCES (precomputed — quote, never recompute):");
  let anyBalance = false;
  for (const context of contexts) {
    if (context.type !== "shared" || context.archivedAt || context.closedAt) {
      continue;
    }
    const contextEntries = entries.filter((entry) => entry.contextId === context.contextId);
    if (contextEntries.length === 0) {
      continue;
    }
    const { primaryEntries, primaryCurrency } = partitionByCurrency(contextEntries);
    const rows = deriveBalances(
      primaryEntries,
      participants,
      memberships.filter((membership) => membership.contextId === context.contextId),
    ).filter((row) => row.netBalance !== 0);
    anyBalance = true;
    if (rows.length === 0) {
      lines.push(`- ${context.name}: all settled`);
      continue;
    }
    const fragments = rows.map((row) =>
      row.netBalance < 0
        ? `${nameOf(row.participantId)} owes ${formatMoneyIn(primaryCurrency, -row.netBalance)}`
        : `${nameOf(row.participantId)} is owed ${formatMoneyIn(primaryCurrency, row.netBalance)}`,
    );
    lines.push(`- ${context.name}: ${fragments.join(", ")}`);
  }
  if (!anyBalance) {
    lines.push("- (no shared entries yet)");
  }

  lines.push(`RECENT ENTRIES (newest first, refs e1..e${MAX_ENTRIES}; amounts are display values):`);
  const recent = entries
    .filter((entry) => entry.type === "expense" && !entry.voidedAt && entry.syncState !== "rejected")
    .sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : -1))
    .slice(0, MAX_ENTRIES);
  recent.forEach((entry, index) => {
    const ref = `e${index + 1}`;
    refToEntryId[ref] = entry.entryId;
    const split = entry.allocations
      .map((allocation) => `${nameOf(allocation.participantId)} ${formatMoneyIn(entry.currency ?? "INR", allocation.shareAmount)}`)
      .join(" + ");
    lines.push(
      `[${ref}] ${entry.effectiveDate} “${entry.description ?? "(no description)"}” ` +
        `${formatMoneyIn(entry.currency ?? "INR", entry.totalAmount)} in ${contextName(entry.contextId)} · ` +
        `paid by ${nameOf(entry.payerId)} · split: ${split}`,
    );
  });
  if (recent.length === 0) {
    lines.push("(no entries yet)");
  }

  return { text: lines.join("\n"), refToEntryId, contextIdByName };
}
