import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { policySchema, type Policy } from '../domain/policy.js';

/**
 * Loading a policy version from disk.
 *
 * ADR-0005 keeps the policy in git rather than in a table, and says the loader
 * sits behind an interface so that moving to a table later changes one adapter.
 * `PolicyStore` is that interface; `createFilePolicyStore` is the only
 * implementation v1 has.
 *
 * TWO CALLERS, AND THEY ASK DIFFERENT QUESTIONS. A submission asks for
 * `config.POLICY_VERSION` — today's rules. A replay asks for the version
 * recorded on the pre-decision it is reproducing, which may be years old
 * (docs/04 §4). That is the whole reason this takes a version rather than
 * reading one global file, and the reason old policy files are never deleted.
 */
export interface PolicyStore {
  get(version: string): Promise<Policy>;
}

export class PolicyLoadError extends Error {
  constructor(
    override readonly message: string,
    readonly version: string,
  ) {
    super(message);
    this.name = 'PolicyLoadError';
  }
}

/**
 * A version string becomes a path, and a version string can arrive from a
 * database row. `../../` in it would read a file outside the policy directory,
 * so the shape is checked before it is joined to anything. Cheap, and the kind
 * of thing that is only cheap before it is needed.
 */
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const describeIssues = (error: z.ZodError): string =>
  error.issues.map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`).join('\n');

/**
 * Policy files are immutable from the commit that introduces them
 * (docs/03 §6), so a parsed version is cached for the life of the process and
 * never re-read. If that rule were ever relaxed, this cache would be the thing
 * that makes the relaxation invisible — which is one more reason not to relax it.
 */
export const createFilePolicyStore = (directory: string): PolicyStore => {
  const cache = new Map<string, Policy>();

  return {
    async get(version: string): Promise<Policy> {
      const cached = cache.get(version);
      if (cached !== undefined) return cached;

      if (!VERSION_PATTERN.test(version)) {
        throw new PolicyLoadError(`"${version}" is not a valid policy version.`, version);
      }

      const path = join(directory, `${version}.json`);

      let raw: string;
      try {
        raw = await readFile(path, 'utf8');
      } catch {
        throw new PolicyLoadError(
          `No policy file at ${path}. Policy versions are append-only and never deleted: ` +
            'a missing one breaks every replay of every decision made under it (docs/03 §6).',
          version,
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        throw new PolicyLoadError(`${path} is not valid JSON: ${String(error)}`, version);
      }

      const result = policySchema.safeParse(parsed);
      if (!result.success) {
        throw new PolicyLoadError(`${path} is not a valid policy:\n${describeIssues(result.error)}`, version);
      }

      // The filename says which rules these are; the file says the same thing
      // again. When they disagree, a replay would load 2026.09.1.json, be handed
      // October's thresholds, and report September's version on the result — a
      // decision that reproduces "correctly" against the wrong rules. Nothing
      // downstream could detect that, so it is caught here.
      if (result.data.version !== version) {
        throw new PolicyLoadError(
          `${path} declares version "${result.data.version}". A file whose name and contents disagree ` +
            'makes replay load one set of rules while reporting another.',
          version,
        );
      }

      cache.set(version, result.data);
      return result.data;
    },
  };
};
