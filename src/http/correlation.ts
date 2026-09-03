import { ulid } from 'ulid';

/**
 * A caller may supply its own correlation id so one trace spans both systems —
 * but the value lands in log lines, so it is accepted only if it cannot forge
 * one. Anything outside this shape is replaced rather than rejected: a bad
 * header is not worth failing a loan application over.
 *
 * ULID rather than UUID because these are read in log output, and a
 * lexicographically sortable id sorts by time for free.
 */
const ACCEPTABLE = /^[A-Za-z0-9_-]{8,64}$/;

export const CORRELATION_HEADER = 'x-correlation-id';

export const correlationIdFrom = (header: string | string[] | undefined): string => {
  const candidate = Array.isArray(header) ? header[0] : header;
  return candidate !== undefined && ACCEPTABLE.test(candidate) ? candidate : ulid();
};
