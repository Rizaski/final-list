/**
 * Ballot-box sequence: a row label per voter within a box, not a global unique ID.
 * Sort/compare as text; use natural numeric order when values are digit strings (e.g. 47…582).
 */

/** Trimmed string for display/sort; empty if missing. */
export function ballotSequenceText(seq) {
  if (seq == null || seq === "") return "";
  return String(seq).trim();
}

/**
 * Display / stored value for ballot sequence: CSV cell or `voter.sequence` (string).
 * Pass a voter-like object `{ sequence }` or a raw cell value from CSV import.
 * Missing/empty → "" (never auto-filled with a row index).
 */
export function sequenceAsImportedFromCsv(valueOrVoter) {
  const value =
    valueOrVoter != null &&
    typeof valueOrVoter === "object" &&
    Object.prototype.hasOwnProperty.call(valueOrVoter, "sequence")
      ? valueOrVoter.sequence
      : valueOrVoter;
  if (value == null) return "";
  return String(value);
}

/**
 * Sort order for ballot seq columns: string compare with numeric collation so "2" &lt; "10".
 * Non-digit strings sort among themselves before/after numbers per locale rules.
 */
export function compareBallotSequence(seqA, seqB) {
  const a = ballotSequenceText(seqA);
  const b = ballotSequenceText(seqB);
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/**
 * Order voters by stored ballot sequence (same value as sequenceAsImportedFromCsv), then name.
 */
export function compareVotersByBallotSequenceThenName(a, b) {
  const c = compareBallotSequence(a?.sequence, b?.sequence);
  if (c !== 0) return c;
  return String(a?.fullName || "").localeCompare(String(b?.fullName || ""), "en");
}

/**
 * Order by ballot box, then sequence, then name — use when grouping or sorting by box.
 */
export function compareVotersByBallotBoxThenSequenceThenName(a, b) {
  const boxA = String(a?.ballotBox || "Unassigned").trim();
  const boxB = String(b?.ballotBox || "Unassigned").trim();
  const boxCmp = boxA.localeCompare(boxB, "en");
  if (boxCmp !== 0) return boxCmp;
  return compareVotersByBallotSequenceThenName(a, b);
}

