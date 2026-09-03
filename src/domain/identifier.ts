/**
 * Canonicalisation of the national identifier.
 *
 * A domain rule rather than an infrastructure detail: the statement "900-55-0142,
 * 900 55 0142 and 900550142 are one subject" is a claim about people, not about
 * storage. Both the subject-key derivation and the mock bureau's catalogue key
 * on the result, and they must agree or the deduplication the brief singled out
 * is defeated by a hyphen — three spellings, three subject keys, three pulls,
 * three marks on one credit file.
 *
 * Pure by necessity: no clock, no crypto, no config. The HMAC that turns this
 * into a subject key needs `node:crypto` and therefore lives in infrastructure.
 */
export const canonicaliseNationalId = (raw: string): string =>
  raw.replace(/[^0-9a-zA-Z]/g, '').toUpperCase();

/**
 * An identifier that canonicalises to nothing carries no subject at all. The
 * caller decides what to do about it; returning `''` and letting a subject key
 * be derived from the empty string would make every such applicant the same
 * person.
 */
export const isCanonicalisable = (raw: string): boolean => canonicaliseNationalId(raw).length > 0;
