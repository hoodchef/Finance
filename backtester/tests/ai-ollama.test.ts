import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OllamaUnavailableError, ollamaStatus, proposePortfolio } from '../src/lib/ai/ollama';

/**
 * The client, against a stubbed daemon.
 *
 * Ollama is not installed on the machine this was written on, so the live path
 * is UNVERIFIED and the README says so. What is verified is every branch the
 * client takes: absence, a daemon without the model, a refusal, and the three
 * ways a small model returns something that is not the JSON it was asked for.
 */

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
  vi.restoreAllMocks();
  delete process.env.OLLAMA_MODEL;
});

function stub(handler: (url: string, init?: RequestInit) => unknown) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = handler(url, init);
    if (body instanceof Error) throw body;
    return {
      ok: true,
      status: 200,
      json: async () => body,
    } as Response;
  }) as typeof fetch;
}

describe('detecting a local daemon', () => {
  it('reports unavailable when nothing answers', async () => {
    stub(() => new Error('ECONNREFUSED'));
    const status = await ollamaStatus();
    // The feature has to disappear silently, not error. Most users run no
    // daemon and should never learn this exists.
    expect(status.available).toBe(false);
    expect(status.warning).toBeNull();
  });

  it('reports available when the model is present', async () => {
    process.env.OLLAMA_MODEL = 'llama3.2';
    stub(() => ({ models: [{ name: 'llama3.2:latest' }, { name: 'qwen2.5:7b' }] }));
    const status = await ollamaStatus();
    expect(status.available).toBe(true);
    // Ollama reports a tag; a bare configured name must still match.
    expect(status.warning).toBeNull();
    expect(status.models).toContain('qwen2.5:7b');
  });

  it('warns, with the command to fix it, when the model is missing', async () => {
    process.env.OLLAMA_MODEL = 'llama3.2';
    stub(() => ({ models: [{ name: 'mistral:latest' }] }));
    const status = await ollamaStatus();
    expect(status.available).toBe(true);
    expect(status.warning).toMatch(/ollama pull llama3\.2/);
  });
});

describe('asking for a portfolio', () => {
  const reply = (content: string) => ({ message: { content } });

  it('returns the parsed object', async () => {
    stub(() => reply(JSON.stringify({ name: 'X', positions: [{ symbol: 'SPY', weight: 100 }] })));
    const out = await proposePortfolio('all in on the S&P');
    expect(out.name).toBe('X');
    expect(Array.isArray(out.positions)).toBe(true);
  });

  it('sends the request to the local host and nowhere else', async () => {
    const seen: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return { ok: true, status: 200, json: async () => reply('{"positions":[]}') } as Response;
    }) as typeof fetch;
    await proposePortfolio('anything');
    // The entire privacy argument for this feature.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^http:\/\/127\.0\.0\.1:11434\//);
  });

  it('refuses prose instead of JSON', async () => {
    // What a small model does when it ignores the format instruction.
    stub(() => reply('Sure! Here is a nice balanced portfolio for you.'));
    await expect(proposePortfolio('something')).rejects.toThrow(OllamaUnavailableError);
    await expect(proposePortfolio('something')).rejects.toThrow(/usable JSON/);
  });

  it('refuses a bare array where an object was required', async () => {
    stub(() => reply('[{"symbol":"SPY","weight":100}]'));
    await expect(proposePortfolio('something')).rejects.toThrow(/usable JSON/);
  });

  it('refuses an empty answer', async () => {
    stub(() => reply(''));
    await expect(proposePortfolio('something')).rejects.toThrow(/usable JSON/);
  });

  it('says the daemon is not running rather than blaming the server', async () => {
    stub(() => new Error('ECONNREFUSED'));
    await expect(proposePortfolio('something')).rejects.toThrow(/No local model answered/);
    // And reassures on the point that matters.
    await expect(proposePortfolio('something')).rejects.toThrow(/nothing is sent anywhere else/);
  });

  it('refuses an empty request without calling out at all', async () => {
    const spy = vi.fn();
    globalThis.fetch = spy as unknown as typeof fetch;
    await expect(proposePortfolio('   ')).rejects.toThrow(OllamaUnavailableError);
    expect(spy).not.toHaveBeenCalled();
  });
});
