import { describe, expect, it } from 'vitest';
import { testApp } from '../support/app.js';

const app = testApp();

describe('liveness', () => {
  it('answers 200 and touches nothing', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/live' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });
});

describe('correlation id', () => {
  it('is on every response', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/live' });
    expect(response.headers['x-correlation-id']).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });

  it('is echoed when the caller supplies a well-formed one', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-correlation-id': '01J9R4X8QK7M2V0T5S3B6N8WQE' },
    });
    expect(response.headers['x-correlation-id']).toBe('01J9R4X8QK7M2V0T5S3B6N8WQE');
  });

  it.each([
    ['too short', 'abc'],
    ['log-forging characters', 'ok\n2026-01-01 FATAL fabricated line'],
    ['absurdly long', 'a'.repeat(500)],
  ])('replaces a value with %s rather than trusting it', async (_label, supplied) => {
    const response = await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-correlation-id': supplied },
    });
    expect(response.headers['x-correlation-id']).not.toBe(supplied);
    expect(response.headers['x-correlation-id']).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});

describe('errors are problem+json, always', () => {
  it('returns 404 with the catalogue code for an unknown route', async () => {
    const response = await app.inject({ method: 'GET', url: '/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toMatchObject({
      type: '/problems/not-found',
      status: 404,
      code: 'NOT_FOUND',
    });
  });

  it('repeats the correlation id in the body, matching the header', async () => {
    const response = await app.inject({ method: 'GET', url: '/nope' });
    expect(response.json().correlationId).toBe(response.headers['x-correlation-id']);
  });

  it('never leaks internal detail on a 500', async () => {
    // The point of this test is the negative assertion. An error handler that
    // forwards `error.message` is the most common way a stack trace, a query or
    // a connection string reaches a caller.
    const secret = 'connection refused to postgres://user:hunter2@internal-host';
    const failing = testApp();
    failing.get('/__throws', async () => {
      throw new Error(secret);
    });

    const response = await failing.inject({ method: 'GET', url: '/__throws' });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ code: 'INTERNAL_ERROR', status: 500 });
    expect(response.payload).not.toContain('hunter2');
    expect(response.payload).not.toContain('postgres://');
    expect(response.json().correlationId).toBe(response.headers['x-correlation-id']);
  });
});
