/**
 * RFC 7807 problem+json. The catalogue is docs/05-api.md §7, and it is a closed
 * set on purpose: an error code a caller cannot look up is a support ticket.
 *
 * `type` is a relative URI. RFC 7807 permits that, and the alternative — an
 * absolute one — needs a configured public base URL whose only job is to make a
 * string absolute. A knob that exists for cosmetics is a knob that will be wrong
 * in one environment.
 */

export const PROBLEMS = {
  MALFORMED_JSON: { status: 400, title: 'Malformed JSON' },
  UNAUTHENTICATED: { status: 401, title: 'Unauthenticated' },
  FORBIDDEN: { status: 403, title: 'Forbidden' },
  NOT_FOUND: { status: 404, title: 'Not found' },
  APPLICATION_NOT_FOUND: { status: 404, title: 'Application not found' },
  IDEMPOTENT_REQUEST_IN_PROGRESS: { status: 409, title: 'Request already in progress' },
  REVIEW_ALREADY_CLOSED: { status: 409, title: 'Review already closed' },
  VALIDATION_FAILED: { status: 422, title: 'Validation failed' },
  IDEMPOTENCY_KEY_REUSED: { status: 422, title: 'Idempotency key reused' },
  UNKNOWN_PRODUCT: { status: 422, title: 'Unknown product' },
  CONSENT_REQUIRED: { status: 422, title: 'Consent required' },
  CONSENT_STALE: { status: 422, title: 'Consent attestation is stale' },
  RATE_LIMITED: { status: 429, title: 'Rate limited' },
  INTERNAL_ERROR: { status: 500, title: 'Internal error' },
  DATABASE_UNAVAILABLE: { status: 503, title: 'Database unavailable' },
} as const;

export type ProblemCode = keyof typeof PROBLEMS;

export interface FieldError {
  readonly path: string;
  readonly message: string;
}

export class AppError extends Error {
  constructor(
    readonly code: ProblemCode,
    readonly detail: string,
    readonly fieldErrors?: readonly FieldError[],
  ) {
    super(detail);
    this.name = 'AppError';
  }

  get status(): number {
    return PROBLEMS[this.code].status;
  }
}

const SLUG = /_/g;

export const toProblem = (
  error: AppError,
  correlationId: string,
): Record<string, unknown> => {
  const { status, title } = PROBLEMS[error.code];
  return {
    type: `/problems/${error.code.toLowerCase().replace(SLUG, '-')}`,
    title,
    status,
    detail: error.detail,
    code: error.code,
    ...(error.fieldErrors ? { errors: error.fieldErrors } : {}),
    correlationId,
  };
};
