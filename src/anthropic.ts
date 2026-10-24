/**
 * Cliente minimo da Messages API, com fetch nativo e sem dependencia.
 *
 * A chave vem de `ANTHROPIC_API_KEY` no ambiente. Nao existe valor padrao no codigo
 * nem chave versionada: sem a variavel, a geracao nao roda e a resposta cai no
 * modo deterministico.
 */

import type { RagConfig } from './config.ts';

export interface MessageParam {
  role: 'user' | 'assistant';
  content: string;
}

export interface MessageResult {
  text: string;
  model: string;
  stopReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

interface ApiResponse {
  model: string;
  stop_reason: string | null;
  content: { type: string; text?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

export function apiKey(): string | null {
  const key = process.env['ANTHROPIC_API_KEY'];
  return key && key.trim() ? key.trim() : null;
}

export class AnthropicError extends Error {
  status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = 'AnthropicError';
    this.status = status;
  }
}

function retriable(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function createMessage(
  rag: RagConfig,
  args: { system: string; messages: MessageParam[] },
): Promise<MessageResult> {
  const key = apiKey();
  if (!key) throw new AnthropicError('ANTHROPIC_API_KEY nao esta definida no ambiente', null);

  const g = rag.generation;
  const url = `${g.baseUrl.replace(/\/+$/, '')}/v1/messages`;
  const body = JSON.stringify({
    model: g.model,
    max_tokens: g.maxTokens,
    temperature: g.temperature,
    system: args.system,
    messages: args.messages,
  });

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= g.retries; attempt++) {
    if (attempt > 0) await sleep(g.retryBackoffMs * attempt);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': g.apiVersion,
        },
        body,
        signal: AbortSignal.timeout(g.timeoutMs),
      });
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 500);
        const err = new AnthropicError(`HTTP ${res.status}: ${detail}`, res.status);
        if (retriable(res.status) && attempt < g.retries) {
          lastError = err;
          continue;
        }
        throw err;
      }
      const parsed = (await res.json()) as ApiResponse;
      const text = parsed.content
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text as string)
        .join('');
      return {
        text,
        model: parsed.model,
        stopReason: parsed.stop_reason,
        inputTokens: parsed.usage?.input_tokens ?? null,
        outputTokens: parsed.usage?.output_tokens ?? null,
      };
    } catch (err) {
      if (err instanceof AnthropicError && err.status !== null && !retriable(err.status)) throw err;
      lastError = err as Error;
    }
  }
  throw new AnthropicError(`geracao falhou: ${lastError?.message ?? 'motivo nao registrado'}`, null);
}
