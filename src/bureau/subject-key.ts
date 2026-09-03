import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonicaliseNationalId } from '../domain/identifier.js';

/**
 * The pseudonym everything downstream is keyed on.
 *
 * WHY A KEYED HMAC AND NOT A PLAIN HASH. The space of US national identifiers
 * is small enough to enumerate: nine digits is a billion candidates, and a
 * plain SHA-256 of every one of them is minutes of work on a laptop. A leaked
 * database of unkeyed hashes is a leaked database of identifiers. The pepper
 * lives only in the platform's secret store and never in the image, so the same
 * table without it is inert.
 *
 * WHY THE PEPPER HAS NO DEFAULT. A defaulted secret is a shared secret: every
 * deployment would derive the same subject key from the same identifier, and
 * the keying would protect nothing. `src/config.ts` refuses to start without it
 * and names the variable.
 *
 * ROTATION IS A MIGRATION, NOT A CONFIG CHANGE. A new pepper makes previously
 * stored subject keys unlinkable to newly derived ones: reuse stops finding
 * existing reports and every applicant is pulled again. That is a data
 * migration with a re-derivation step, and it cannot be done without the
 * identifiers — which we deliberately do not store. The honest consequence is
 * that this pepper is effectively permanent, and it is recorded as such rather
 * than described as rotatable.
 */

/** 64 lowercase hex characters, which is what `applications.subject_key` is declared as. */
export type SubjectKey = string;

export const deriveSubjectKey = (nationalId: string, pepper: string): SubjectKey => {
  const canonical = canonicaliseNationalId(nationalId);
  if (canonical.length === 0) {
    // Deriving a key from the empty string would make every applicant with an
    // unusable identifier the same person, and they would share one credit file.
    throw new RangeError('nationalId canonicalises to nothing');
  }
  return createHmac('sha256', pepper).update(canonical, 'utf8').digest('hex');
};

/** Constant-time, because a subject key is a secret-adjacent value and comparison timing leaks prefixes. */
export const subjectKeysMatch = (a: SubjectKey, b: SubjectKey): boolean => {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
};

/** The claim key for one pull. Scoped by provider: two bureaux are two enquiries, not one. */
export const pullKey = (subjectKey: SubjectKey, provider: string): string => `${subjectKey}:${provider}`;
