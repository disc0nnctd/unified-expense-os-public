import { FormEvent, useState } from "react";
import { answerBalanceQuestion, answerQuestion } from "../lib/qa";
import type { ContextRecord, LedgerEntry, Membership, Participant } from "../types";

type Props = {
  entries: LedgerEntry[];
  participants: Participant[];
  memberships: Membership[];
  contexts: ContextRecord[];
  deviceParticipantId: string;
};

// Deliberately not an LLM: answers are computed by the same deterministic
// finance.ts functions the Reports tab uses (see lib/qa.ts). Unrecognized
// phrasing says so plainly instead of guessing.
export default function LedgerQaPanel({ entries, participants, memberships, contexts, deviceParticipantId }: Props) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [asked, setAsked] = useState(false);

  function handleAsk(event: FormEvent) {
    event.preventDefault();
    setAsked(true);
    const balanceAnswer = answerBalanceQuestion(question, contexts, memberships, entries, participants, deviceParticipantId);
    if (balanceAnswer) {
      setAnswer(balanceAnswer.text);
      return;
    }
    const reportAnswer = answerQuestion(question, entries, participants, memberships);
    setAnswer(reportAnswer?.text ?? null);
  }

  return (
    <article className="panel">
      <div className="panel-header">
        <h2>Ask your ledger</h2>
        <span>Deterministic, not AI-guessed</span>
      </div>
      <form className="entry-form" onSubmit={handleAsk}>
        <label className="wide">
          Question
          <input
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="How much did we spend on groceries this month?"
          />
        </label>
        <div className="form-actions wide">
          <button type="submit" className="secondary" disabled={!question.trim()}>
            Ask
          </button>
        </div>
      </form>
      {asked ? (
        <div className="info-strip">
          <span>{answer ?? "I can't answer that yet — try a spend, category, member, or owed/owe question."}</span>
        </div>
      ) : null}
    </article>
  );
}
