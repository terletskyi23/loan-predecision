/**
 * What the bureau said, in the shape `decide(...)` consumes.
 *
 * This type lives in the domain rather than in `src/bureau` on purpose: the
 * engine may import nothing (ADR-0008), so the contract has to be defined by
 * the consumer and implemented by the adapter, not the other way round.
 * `src/bureau/*` depends on this file; this file depends on nothing.
 *
 * docs/08-mock-bureau.md §2 and §3 are the authority.
 */

/** docs/08 §2. What the PROVIDER can fail with. */
export type BureauProviderFailure = 'TIMEOUT' | 'SERVER_ERROR' | 'RETRIES_EXHAUSTED';

/**
 * What the GATEWAY can report. `WAIT_EXPIRED` is not a provider failure — it is
 * what a losing request has to say when the winner of a pull claim did not
 * finish inside `BUREAU_WAIT_MS`. It is stored in
 * `pre_decisions.lookup_failure_cause` alongside the other three because replay
 * of a `BUREAU_UNAVAILABLE` referral needs it as an engine input (docs/04 §4).
 */
export type LookupFailureCause = BureauProviderFailure | 'WAIT_EXPIRED';

export type DelinquencyGrade = 'NONE' | 'DPD_30' | 'DPD_60' | 'DPD_90_PLUS' | 'CHARGE_OFF';

export interface SubjectMatch {
  readonly nameMatches: boolean;
  readonly dateOfBirthMatches: boolean;
}

/**
 * The attribute contract: everything the policy can reference, and nothing it
 * cannot.
 *
 * TWO KINDS OF ABSENCE, and conflating them is the defect this comment exists
 * to prevent:
 *
 *   `null`      — the bureau answered, and the event never happened.
 *                 `monthsSinceBankruptcy: null` means "no bankruptcy on file".
 *                 It is a fact, and D2 reads it as one.
 *
 *   `undefined` — the bureau did not supply the attribute at all. It is a gap
 *                 in OUR data, and D1 turns it into `BUREAU_DATA_INCOMPLETE`
 *                 rather than scoring it as zero, because scoring a gap
 *                 declines a person for a defect of ours (docs/03 §2).
 *
 * The scorecard inputs are therefore declared as required properties that may
 * be `undefined`, not as optional ones. A construction site must state what it
 * knows about each attribute; it cannot stay silent by omitting a key. Typing
 * them as always-present would make `BUREAU_DATA_INCOMPLETE` unreachable and
 * `docs/07-testing.md` §7 would fail on it.
 */
export interface BureauReport {
  readonly provider: string;
  readonly pulledAt: Date;

  readonly subjectMatch: SubjectMatch;

  /** D2 knockout: something is delinquent right now. */
  readonly hasActiveDelinquency: boolean;
  /** D2 knockout. `null` means none on file. */
  readonly monthsSinceBankruptcy: number | null;
  /** D2 knockout. `null` means none on file. */
  readonly monthsSinceChargeOff: number | null;

  /** Scorecard · payment history. The worst thing in 24 months, cured or not. */
  readonly worstDelinquencyLast24m: DelinquencyGrade | undefined;
  /** Scorecard · amounts owed. 0-100. */
  readonly revolvingUtilizationPct: number | undefined;
  /** Scorecard · history length, and the thin-file floor. */
  readonly oldestAccountAgeMonths: number | undefined;
  /** Scorecard · new credit. */
  readonly hardInquiriesLast6m: number | undefined;
  /** Scorecard · credit mix. Three cards is three accounts and one type. */
  readonly distinctAccountTypes: number | undefined;

  /** Thin file. Answers "is there a file to score", where the line above answers "is the mix informative". */
  readonly totalAccounts: number | undefined;
  /** Affordability. The bureau sees obligations the applicant may omit. */
  readonly monthlyObligationsMinor: number | undefined;
}

/**
 * Three outcomes, not two. "This person has no credit file" and "our vendor was
 * down" are different facts with different verdicts, different reason codes and
 * different follow-up — see docs/08 §2. Collapsing them tells a first-time
 * borrower that our vendor was down.
 */
export type BureauLookup =
  | { readonly outcome: 'FOUND'; readonly report: BureauReport }
  | { readonly outcome: 'NO_HIT'; readonly provider: string; readonly pulledAt: Date }
  | { readonly outcome: 'UNAVAILABLE'; readonly provider: string; readonly cause: LookupFailureCause };

/** What a provider can return. The gateway adds `WAIT_EXPIRED`; a provider never does. */
export type BureauProviderResult =
  | { readonly outcome: 'FOUND'; readonly report: BureauReport }
  | { readonly outcome: 'NO_HIT'; readonly provider: string; readonly pulledAt: Date }
  | { readonly outcome: 'UNAVAILABLE'; readonly provider: string; readonly cause: BureauProviderFailure };
