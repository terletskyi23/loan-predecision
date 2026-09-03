import { describe, expect, it } from 'vitest';
import { TOKENS, testApp } from '../support/app.js';

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('/metrics is not public', () => {
  it('refuses an unauthenticated request', async () => {
    const response = await (await testApp()).inject({ method: 'GET', url: '/metrics' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('refuses a malformed Authorization header', async () => {
    const response = await (await testApp()).inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Basic abc123' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('refuses an unknown token', async () => {
    const response = await (await testApp()).inject({
      method: 'GET',
      url: '/metrics',
      headers: bearer('not-a-real-token'),
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it.each([
    ['a submission token', TOKENS.submission],
    ['a reviewer token', TOKENS.reviewer],
  ])('answers 403, not 401, for %s', async (_label, token) => {
    // The distinction is worth keeping: 401 is "I do not know who you are",
    // 403 is "I know, and this is not yours". Telling an integrator their token
    // works but not here is more useful than a blanket 401 and leaks nothing
    // they do not already know.
    const response = await (await testApp()).inject({ method: 'GET', url: '/metrics', headers: bearer(token) });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('serves Prometheus text to an auditor', async () => {
    const response = await (await testApp()).inject({ method: 'GET', url: '/metrics', headers: bearer(TOKENS.auditor) });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.payload).toContain('http_requests_total');
    expect(response.payload).toContain('http_request_duration_seconds');
  });
});

describe('the counters actually move', () => {
  it('records a request by route rather than by URL', async () => {
    // The label is the route pattern. /v1/applications/{id} as a label value
    // would mint a new time series per application and make the metric useless
    // within a day.
    const app = await testApp();
    await app.inject({ method: 'GET', url: '/health/live' });

    const response = await app.inject({ method: 'GET', url: '/metrics', headers: bearer(TOKENS.auditor) });

    expect(response.payload).toMatch(/http_requests_total\{method="GET",route="\/health\/live",status="200"\} 1/);
  });

  it('counts 4xx and 5xx separately', async () => {
    // Mixed together, a buggy integrator's 422s drown a real outage — which is
    // also why the alert list in docs/06 excludes a raw error count.
    const app = await testApp();
    app.get('/__throws', async () => {
      throw new Error('boom');
    });

    await app.inject({ method: 'GET', url: '/nope' });
    await app.inject({ method: 'GET', url: '/__throws' });

    const response = await app.inject({ method: 'GET', url: '/metrics', headers: bearer(TOKENS.auditor) });

    expect(response.payload).toMatch(/http_errors_total\{class="4xx"\} 1/);
    expect(response.payload).toMatch(/http_errors_total\{class="5xx"\} 1/);
  });

  it('does not label unmatched routes with the URL a caller chose', async () => {
    // Otherwise a scanner probing /wp-admin, /.env and friends creates a time
    // series per probe and the metric becomes an attacker-controlled cardinality
    // bomb.
    const app = await testApp();
    await app.inject({ method: 'GET', url: '/.env' });
    await app.inject({ method: 'GET', url: '/wp-admin' });

    const response = await app.inject({ method: 'GET', url: '/metrics', headers: bearer(TOKENS.auditor) });

    expect(response.payload).not.toContain('.env');
    expect(response.payload).not.toContain('wp-admin');
    expect(response.payload).toMatch(/route="unmatched"/);
  });
});
