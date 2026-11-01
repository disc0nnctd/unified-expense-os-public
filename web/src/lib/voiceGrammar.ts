import { localDateString, parseAmountToPaise } from "./finance";
import { detectCurrency } from "./currencies";
import { emptyDraft, type ExpenseDraft } from "./expenseDraft";

// Deterministic spoken-expense grammar (unified-expense-os-mi5). Turns a
// speech transcript (or typed chat message) like
//   "add 450 dinner in Flat split equally with Isha"
//   "create an expense 900 groceries, Isha paid, split 2 to 1 between Isha and me"
//   "movie tickets I pay 300 Ravi pays 150"
// into an ExpenseDraft. Names stay strings; resolution happens in
// expenseDraft.ts. This is the first tier — when it can't parse, callers may
// escalate to the on-device or server LLM, which returns the same shape.
// Nothing here writes anywhere: drafts only prefill a form the user reviews.

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90,
};
const SCALES: Record<string, number> = { hundred: 100, thousand: 1000, k: 1000, lakh: 100000 };

// "four hundred fifty" → 450, "fifteen hundred" → 1500, "two and a half
// thousand" → 2500. Returns null when the words aren't a clean number.
export function spokenWordsToNumber(phrase: string): number | null {
  const words = phrase.toLowerCase().replace(/-/g, " ").split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return null;
  }
  let total = 0;
  let current = 0;
  let sawAny = false;
  let half = false;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (word === "and" || word === "a" || word === "an") {
      continue;
    }
    if (word === "half") {
      half = true;
      continue;
    }
    if (word in UNITS) {
      current += UNITS[word];
      sawAny = true;
    } else if (word in TENS) {
      current += TENS[word];
      sawAny = true;
    } else if (word in SCALES) {
      const scale = SCALES[word];
      const base = current === 0 ? 1 : current;
      current = (base + (half ? 0.5 : 0)) * scale;
      half = false;
      total += current;
      current = 0;
      sawAny = true;
    } else {
      return null;
    }
  }
  if (!sawAny) {
    return null;
  }
  return total + current + (half ? 0.5 : 0);
}

const CATEGORY_KEYWORDS: [RegExp, string][] = [
  [/\b(grocer(y|ies)|vegetables|sabzi|supermarket)\b/, "groceries"],
  [/\brent\b/, "rent"],
  [/\b(electricity|wifi|internet|water bill|gas bill|utilit(y|ies)|broadband)\b/, "utilities"],
  [/\b(dinner|lunch|breakfast|restaurant|food|swiggy|zomato|pizza|coffee|snacks?)\b/, "dining"],
  [/\b(uber|ola|cab|taxi|auto|fuel|petrol|diesel|metro|bus|train|flight)\b/, "transport"],
  [/\b(movie|netflix|concert|game|entertainment|show)\b/, "entertainment"],
];

const NAME_TOKEN = "[a-z][a-z]+";
// A person mention inside a name list: any word (incl. "i"/"me") bounded so
// alternation can't half-match inside a longer name ("i" inside "isha").
const PERSON = "[a-z]+";
const FILLER = /\b(please|kindly|umm?|uh|like)\b/g;

function stripCommandPreamble(text: string): string {
  return text
    .replace(/^(?:hey\s+)?(?:add|create|log|record|make|new)\s+(?:a\s+|an\s+|new\s+)?(?:expense|transaction|entry)?\s*(?:for|of)?\s*/i, "")
    .trim();
}

function extractDate(text: string, now: Date): { text: string; date: string | null } {
  const day = 24 * 60 * 60 * 1000;
  if (/\bday before yesterday\b/i.test(text)) {
    return { text: text.replace(/\b(?:from |on )?(?:the )?day before yesterday\b/i, " "), date: localDateString(new Date(now.getTime() - 2 * day)) };
  }
  if (/\byesterday\b/i.test(text)) {
    return { text: text.replace(/\b(?:from |on )?yesterday\b/i, " "), date: localDateString(new Date(now.getTime() - day)) };
  }
  if (/\btoday\b/i.test(text)) {
    return { text: text.replace(/\b(?:from |on )?today\b/i, " "), date: localDateString(now) };
  }
  return { text, date: null };
}

// Trailing "in <name>" / "in the <name> context/group/trip" names the target
// context. Only the trailing clause is treated as a context to avoid eating
// phrases like "in the restaurant".
function extractContextHint(text: string): { text: string; hint: string | null } {
  const match = text.match(new RegExp(`\\bin (?:the )?((?:${NAME_TOKEN}|\\d)(?:[a-z0-9 ]{0,28}?))(?:\\s+(?:context|group|trip))?\\s*[.,!?]?$`, "i"));
  if (!match) {
    return { text, hint: null };
  }
  return { text: text.slice(0, match.index).trim(), hint: match[1].trim() };
}

function listNames(fragment: string): string[] {
  return fragment
    .split(/\s*(?:,|and|&)\s*/i)
    .map((part) => part.trim())
    .filter((part) => part && /^[a-z]+$/i.test(part.replace(/\s+/g, "")));
}

type SplitParse = Pick<ExpenseDraft, "splitMode" | "participantNames" | "shares" | "amountsPaise"> & {
  remaining: string;
  impliedTotalPaise: number | null;
};

function parseSplit(text: string): SplitParse {
  let remaining = text;
  const none: SplitParse = {
    splitMode: null,
    participantNames: [],
    shares: null,
    amountsPaise: null,
    remaining,
    impliedTotalPaise: null,
  };

  // "I pay 300 [and] Isha pays 150" → custom exact amounts. Two or more
  // name-pays-amount pairs make a custom split; their sum implies the total.
  const payPairs = [...remaining.matchAll(new RegExp(`\\b(${PERSON})\\s+pa(?:ys|id|y)\\s+(?:₹|rs\\.?\\s*)?(\\d+(?:[.]\\d{1,2})?)\\b`, "gi"))];
  if (payPairs.length >= 2) {
    const amountsPaise: Record<string, number> = {};
    let total = 0;
    for (const pair of payPairs) {
      const paise = parseAmountToPaise(pair[2]);
      if (paise === null) {
        continue;
      }
      const name = pair[1].toLowerCase() === "i" ? "me" : pair[1];
      amountsPaise[name] = (amountsPaise[name] ?? 0) + paise;
      total += paise;
      remaining = remaining.replace(pair[0], " ");
    }
    if (Object.keys(amountsPaise).length >= 2) {
      return {
        splitMode: "custom",
        participantNames: Object.keys(amountsPaise),
        shares: null,
        amountsPaise,
        remaining,
        impliedTotalPaise: total,
      };
    }
  }

  // Ratio splits: "split [it] [in the ratio] 2 to 1 between me and Isha",
  // "2:1 with Isha and Ravi". Requires an explicit split/ratio cue so a bare
  // "2 to 1" elsewhere isn't misread.
  const ratioMatch = remaining.match(
    new RegExp(
      `\\b(?:split(?:ting)?(?: it)?(?: in)?(?: the)?(?: ratio(?: of)?)?|ratio(?: of)?)\\s+(\\d+)\\s*(?:to|:|is to)\\s*(\\d+)(?:\\s*(?:to|:)\\s*(\\d+))?` +
        `(?:\\s+(?:between|among|with)\\s+(${PERSON}(?:\\s*(?:,|and|&)\\s*${PERSON})*)\\b)?`,
      "i",
    ),
  );
  if (ratioMatch) {
    const weights = [ratioMatch[1], ratioMatch[2], ratioMatch[3]]
      .filter((value): value is string => value !== undefined)
      .map(Number);
    const names = ratioMatch[4] ? listNames(ratioMatch[4]) : [];
    remaining = remaining.replace(ratioMatch[0], " ");
    if (names.length === weights.length) {
      const shares: Record<string, number> = {};
      names.forEach((name, index) => {
        shares[name.toLowerCase() === "i" ? "me" : name] = weights[index];
      });
      return { splitMode: "shares", participantNames: Object.keys(shares), shares, amountsPaise: null, remaining, impliedTotalPaise: null };
    }
    // Ratio heard but names missing/mismatched — mode only; user assigns below.
    return { splitMode: "shares", participantNames: names, shares: null, amountsPaise: null, remaining, impliedTotalPaise: null };
  }

  // "split equally/evenly [between me and Isha]", "split with Isha", "fifty fifty".
  const equalMatch = remaining.match(
    new RegExp(
      `\\b(?:split(?:ting)?(?: it)?(?:\\s+(?:equally|evenly|equal|fifty fifty|50 50))?|(?:equally|evenly|fifty fifty))` +
        `(?:\\s+(?:between|among|with)\\s+(${PERSON}(?:\\s*(?:,|and|&)\\s*${PERSON})*)\\b)?`,
      "i",
    ),
  );
  const equalCue = !!equalMatch && /split|equally|evenly|fifty fifty/i.test(equalMatch[0]);
  let equalNames: string[] = [];
  if (equalCue && equalMatch) {
    equalNames = equalMatch[1]
      ? listNames(equalMatch[1]).map((name) => (name.toLowerCase() === "i" ? "me" : name))
      : [];
    remaining = remaining.replace(equalMatch[0], " ");
  }

  // "with Isha [and Ravi]" — names the split partners even when the split
  // cue appeared earlier in the sentence ("split 2500 spent on GPU with
  // Gunjan"), or stands alone as an equal-split request. The clause may sit
  // mid-sentence ("split 500 with Gunjan and Rynaa for pizza"): the name
  // list ends at a description connective (for/on/at/from) or the sentence
  // end, so trailing description words never get read as people.
  const withMatch = remaining.match(
    new RegExp(
      `\\bwith\\s+((?:${NAME_TOKEN})(?:\\s*(?:,|and|&)\\s*(?:${NAME_TOKEN}))*)(?=\\s+(?:for|on|at|from)\\b|\\s*[.,!?]*\\s*$)`,
      "i",
    ),
  );
  if (withMatch && equalNames.length === 0) {
    const names = listNames(withMatch[1]);
    if (names.length > 0) {
      remaining = remaining.replace(withMatch[0], " ");
      equalNames = ["me", ...names];
      if (!equalCue) {
        return {
          splitMode: "equal",
          participantNames: equalNames,
          shares: null,
          amountsPaise: null,
          remaining,
          impliedTotalPaise: null,
        };
      }
    }
  }

  if (equalCue) {
    if (/unevenly|unequal/i.test(text)) {
      return { splitMode: "custom", participantNames: equalNames, shares: null, amountsPaise: null, remaining, impliedTotalPaise: null };
    }
    return { splitMode: "equal", participantNames: equalNames, shares: null, amountsPaise: null, remaining, impliedTotalPaise: null };
  }

  return { ...none, remaining };
}

function extractPayer(text: string): { text: string; payerName: string | null } {
  const byMatch = text.match(new RegExp(`\\bpaid by\\s+(i|me|${NAME_TOKEN})\\b`, "i"));
  if (byMatch) {
    return {
      text: text.replace(byMatch[0], " "),
      payerName: byMatch[1].toLowerCase() === "i" ? "me" : byMatch[1],
    };
  }
  // "<name> paid …". Multi-person "X paid 300, Y paid 150" was already
  // consumed as a custom split before this runs, so a surviving "paid" names
  // the payer; any trailing amount stays in place for extractAmount.
  const paidMatch = text.match(new RegExp(`\\b(i|me|${NAME_TOKEN})\\s+paid\\b`, "i"));
  if (paidMatch) {
    return {
      text: text.replace(new RegExp(`\\b${paidMatch[1]}\\s+paid(?:\\s+for\\b(?!\\s*(?:₹|rs|\\d)))?(?:\\s+it\\b)?`, "i"), " "),
      payerName: paidMatch[1].toLowerCase() === "i" ? "me" : paidMatch[1],
    };
  }
  return { text, payerName: null };
}

function extractAmount(text: string): { text: string; amountPaise: number | null; currency: string | null } {
  // Currency-marked digits: "₹450", "$25", "rs 450", "450 rupees",
  // "2500 dollars", "usd 20". The marker both anchors the amount and
  // identifies the currency (lib/currencies.ts detectCurrency).
  const marked =
    text.match(/(₹|\$|€|£|rs\.?|inr|usd|eur|gbp)\s*(\d+(?:[.]\d{1,2})?)/i) ??
    text.match(/(\d+(?:[.]\d{1,2})?)\s*(rupees?|rs\.?|dollars?|euros?|pounds?|quid|bucks?|inr|usd|eur|gbp)/i);
  if (marked) {
    const digits = /^\d/.test(marked[1]) ? marked[1] : marked[2];
    const markerWord = /^\d/.test(marked[1]) ? marked[2] : marked[1];
    const paise = parseAmountToPaise(digits);
    if (paise !== null) {
      return { text: text.replace(marked[0], " "), amountPaise: paise, currency: detectCurrency(markerWord) };
    }
  }
  // "1.2k" / "2k" shorthand.
  const kMatch = text.match(/\b(\d+(?:\.\d+)?)k\b/i);
  if (kMatch) {
    return {
      text: text.replace(kMatch[0], " "),
      amountPaise: Math.round(Number(kMatch[1]) * 1000 * 100),
      currency: null,
    };
  }
  // Bare number (speech recognizers emit digits for numbers).
  const bare = text.match(/(?:^|\s)(\d{1,7}(?:[.]\d{1,2})?)(?=\s|$|[.,!?])/);
  if (bare) {
    const paise = parseAmountToPaise(bare[1]);
    if (paise !== null && paise > 0) {
      return { text: text.replace(bare[0], " "), amountPaise: paise, currency: null };
    }
  }
  // Spoken words ("four hundred fifty rupees", "twenty dollars").
  const wordsMatch = text.match(
    /\b((?:(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|lakh|and|a|an|half)\s+)*(?:hundred|thousand|lakh|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety))\s*(rupees?|rs|dollars?|euros?|pounds?)?\b/i,
  );
  if (wordsMatch) {
    const value = spokenWordsToNumber(wordsMatch[1]);
    // Reject trivial single-unit words ("one", "a") as amounts.
    if (value !== null && value >= 10) {
      return {
        text: text.replace(wordsMatch[0], " "),
        amountPaise: Math.round(value * 100),
        currency: wordsMatch[2] ? detectCurrency(wordsMatch[2]) : null,
      };
    }
  }
  return { text, amountPaise: null, currency: null };
}

function detectCategory(text: string): string | null {
  for (const [pattern, category] of CATEGORY_KEYWORDS) {
    if (pattern.test(text)) {
      return category;
    }
  }
  return null;
}

export function parseSpokenExpense(transcript: string, now = new Date()): ExpenseDraft | null {
  let working = transcript.trim().toLowerCase().replace(FILLER, " ").replace(/\s+/g, " ");
  if (!working) {
    return null;
  }
  working = stripCommandPreamble(working);

  const dated = extractDate(working, now);
  working = dated.text;
  const contexted = extractContextHint(working);
  working = contexted.text;

  const split = parseSplit(working);
  working = split.remaining;

  const payer = extractPayer(working);
  working = payer.text;

  const amount = extractAmount(working);
  working = amount.text;

  const amountPaise = amount.amountPaise ?? split.impliedTotalPaise;
  const category = detectCategory(transcript.toLowerCase());

  // Whatever survives extraction is the description. Strip filler words only
  // from the edges so interior phrases ("dinner for the team") keep sense.
  let description = working.replace(/[.,!?]+/g, " ").replace(/\s+/g, " ").trim();
  const edgeFiller =
    /^(?:for|the|it|an?|split|and|on|of|spent|paid|bought|got)\s+|\s+(?:for|the|it|an?|split|and|on|of|spent|paid|bought|got)$/i;
  while (edgeFiller.test(description)) {
    description = description.replace(edgeFiller, "").trim();
  }

  if (amountPaise === null && !description) {
    return null;
  }

  const draft: ExpenseDraft = {
    ...emptyDraft(),
    description: description ? description.charAt(0).toUpperCase() + description.slice(1) : category,
    amountPaise,
    category,
    payerName: payer.payerName,
    splitMode: split.splitMode,
    participantNames: split.participantNames,
    shares: split.shares,
    amountsPaise: split.amountsPaise,
    contextHint: contexted.hint,
    effectiveDate: dated.date,
    currency: amount.currency,
    confidence: amountPaise !== null ? (split.splitMode ? "high" : "medium") : "low",
  };
  return draft;
}
