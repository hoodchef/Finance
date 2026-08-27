/**
 * Local model access, for turning a sentence into a portfolio.
 * =============================================================================
 * Ollama specifically, and local specifically. This product's whole proposition
 * is that a user's income, province and net worth never leave their machine;
 * posting any of it to a hosted model would break the one property nothing
 * else in the codebase breaks.
 *
 * SCOPE: input only. The model turns language into a STRUCTURED REQUEST, which
 * is then validated by exactly the same code that validates a typed request or
 * a shared link. It never produces a number that reaches a result, and it never
 * writes prose about one.
 *
 * That boundary is the entire safety argument. A model that hallucinates an
 * allocation produces something the user sees on screen before anything runs,
 * or something `parsePortfolio` rejects. A model that narrates a backtest
 * produces plausible sentences with nothing behind them, and no validator can
 * catch it — which is why this file has no path to one.
 */

export class OllamaUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OllamaUnavailableError';
  }
}

/** Default host. Overridable for a non-standard port or a container. */
function host(): string {
  return (process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
}

/** Model to ask. Small instruction-tuned models are adequate for extraction. */
function model(): string {
  return process.env.OLLAMA_MODEL ?? 'llama3.2';
}

async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await fn(ac.signal);
  } finally {
    clearTimeout(timer);
  }
}

export interface OllamaStatus {
  available: boolean;
  host: string;
  model: string;
  /** Models the daemon actually has pulled. */
  models: string[];
  /** Set when the configured model is not among them. */
  warning: string | null;
}

/**
 * Whether a local daemon is answering, and whether it has the model.
 *
 * A short timeout: this runs to decide whether to show a UI at all, and a
 * feature that is off should cost nothing to discover.
 */
export async function ollamaStatus(): Promise<OllamaStatus> {
  const base = host();
  const wanted = model();
  try {
    const res = await withTimeout(
      (signal) => fetch(`${base}/api/tags`, { signal }),
      1500,
    );
    if (!res.ok) {
      return { available: false, host: base, model: wanted, models: [], warning: null };
    }
    const body = (await res.json()) as { models?: Array<{ name?: string }> };
    const models = (body.models ?? []).map((m) => m.name ?? '').filter(Boolean);
    // Ollama reports "llama3.2:latest"; a bare name should still match.
    const has = models.some((m) => m === wanted || m.split(':')[0] === wanted.split(':')[0]);
    return {
      available: true,
      host: base,
      model: wanted,
      models,
      warning: has
        ? null
        : `Ollama is running but does not have "${wanted}". Run: ollama pull ${wanted}`,
    };
  } catch {
    return { available: false, host: base, model: wanted, models: [], warning: null };
  }
}

/**
 * The instruction.
 *
 * Deliberately narrow. The model is asked for a small object and told the
 * shape; it is not asked to reason about markets, and nothing it says outside
 * the JSON is read. Every field is re-validated downstream, so the prompt is a
 * convenience rather than a control.
 */
const SYSTEM = `You convert a description of an investment portfolio into JSON.

Return ONLY a JSON object with this shape:
{
  "name": "short portfolio name",
  "positions": [{"symbol": "TICKER", "weight": 60}],
  "start": "YYYY-MM-DD" or null,
  "end": "YYYY-MM-DD" or null,
  "rebalance": "never" | "monthly" | "quarterly" | "semiannual" | "annual" | null,
  "initialInvestment": number or null,
  "notes": "anything you were unsure about, or empty string"
}

Rules:
- Use real exchange tickers. Canadian listings end in .TO (e.g. XEQT.TO, VFV.TO).
- Weights are percentages and should total 100.
- If the user does not mention something, use null. Do not guess dates or amounts.
- If you are unsure about a ticker, still give your best guess and say so in "notes".
- Output nothing except the JSON object.`;

export interface RawProposal {
  name?: unknown;
  positions?: unknown;
  start?: unknown;
  end?: unknown;
  rebalance?: unknown;
  initialInvestment?: unknown;
  notes?: unknown;
}

/**
 * Asks the model for a portfolio and returns its raw, unvalidated answer.
 *
 * Returning it raw is intentional: the caller validates. Doing any coercion
 * here would create a second, weaker validator alongside the real one.
 */
export async function proposePortfolio(request: string): Promise<RawProposal> {
  const base = host();
  const text = request.trim().slice(0, 1000);
  if (!text) throw new OllamaUnavailableError('Nothing to interpret.');

  let res: Response;
  try {
    res = await withTimeout(
      (signal) =>
        fetch(`${base}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal,
          body: JSON.stringify({
            model: model(),
            stream: false,
            // Ollama's JSON mode constrains decoding, which removes most of
            // the "here is your JSON:" preamble problem.
            format: 'json',
            options: { temperature: 0 },
            messages: [
              { role: 'system', content: SYSTEM },
              { role: 'user', content: text },
            ],
          }),
        }),
      60_000,
    );
  } catch {
    throw new OllamaUnavailableError(
      'No local model answered. Start Ollama and try again — nothing is sent anywhere else.',
    );
  }

  if (!res.ok) {
    throw new OllamaUnavailableError(`The local model returned HTTP ${res.status}.`);
  }

  const body = (await res.json()) as { message?: { content?: string } };
  const content = body.message?.content ?? '';
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as RawProposal;
  } catch {
    throw new OllamaUnavailableError(
      'The local model did not return usable JSON. A smaller model may struggle with this; ' +
        'try a larger one, or enter the portfolio directly.',
    );
  }
}
