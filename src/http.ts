import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { ROOT, type Config } from './config.ts';
import { info, warn } from './log.ts';

const CACHE_DIR = resolve(ROOT, 'cache');

interface CacheMeta {
  etag?: string;
  lastModified?: string;
  fetchedAt: string;
  url: string;
}

function keyOf(url: string): string {
  return createHash('sha1').update(url).digest('hex').slice(0, 16);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Erro de rede/HTTP com a evidencia que a classificacao usa. */
export class HttpProbeError extends Error {
  kind: 'timeout' | 'network' | 'http';
  status?: number;
  headers?: Record<string, string>;
  bodySnippet?: string;

  constructor(
    message: string,
    kind: 'timeout' | 'network' | 'http',
    status?: number,
    headers?: Record<string, string>,
    bodySnippet?: string,
  ) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.headers = headers;
    this.bodySnippet = bodySnippet;
  }
}

function headerMap(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}

export function errorCodeOf(err: unknown): string {
  const e = err as { cause?: { code?: string }; code?: string; name?: string };
  return e?.cause?.code ?? e?.code ?? e?.name ?? 'UNKNOWN';
}

/**
 * GET com timeout, retentativa em falha transitoria e GET condicional em cache de disco.
 * Devolve o corpo como Buffer; descomprime .gz transparentemente.
 */
export async function fetchCached(
  c: Config,
  url: string,
  opts: { gunzip?: boolean; force?: boolean } = {},
): Promise<{ body: Buffer; fromCache: boolean }> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const key = keyOf(url);
  const bodyPath = resolve(CACHE_DIR, `${key}.body`);
  const metaPath = resolve(CACHE_DIR, `${key}.json`);
  let meta: CacheMeta | null = null;
  if (!opts.force && existsSync(metaPath) && existsSync(bodyPath)) {
    try {
      meta = JSON.parse(readFileSync(metaPath, 'utf8')) as CacheMeta;
    } catch {
      meta = null;
    }
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt <= c.http.retries; attempt++) {
    if (attempt > 0) await sleep(c.http.retryBackoffMs * attempt);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), c.http.readTimeoutMs);
    try {
      const headers: Record<string, string> = { 'user-agent': c.http.userAgent };
      if (meta?.etag) headers['if-none-match'] = meta.etag;
      if (meta?.lastModified) headers['if-modified-since'] = meta.lastModified;
      const res = await fetch(url, { headers, signal: ac.signal, redirect: 'follow' });
      if (res.status === 304 && meta) {
        info(`cache 304 ${url}`);
        const raw = readFileSync(bodyPath);
        return { body: maybeGunzip(raw, url, opts.gunzip), fromCache: true };
      }
      if (!res.ok) {
        throw new HttpProbeError(
          `HTTP ${res.status} em ${url}`,
          'http',
          res.status,
          headerMap(res.headers),
        );
      }
      const raw = Buffer.from(await res.arrayBuffer());
      writeFileSync(bodyPath, raw);
      const next: CacheMeta = { fetchedAt: new Date().toISOString(), url };
      const etag = res.headers.get('etag');
      const lm = res.headers.get('last-modified');
      if (etag) next.etag = etag;
      if (lm) next.lastModified = lm;
      writeFileSync(metaPath, JSON.stringify(next, null, 2));
      return { body: maybeGunzip(raw, url, opts.gunzip), fromCache: false };
    } catch (err) {
      lastErr = err;
      const transient =
        err instanceof HttpProbeError
          ? err.kind !== 'http' || (err.status ?? 0) >= 500
          : true;
      if (!transient || attempt === c.http.retries) break;
      warn(`tentativa ${attempt + 1} falhou em ${url}: ${errorCodeOf(err)}`);
    } finally {
      clearTimeout(timer);
    }
  }
  // Cache velho e melhor que nada quando a fonte caiu: evita playlist vazia por falha de rede.
  if (meta && existsSync(bodyPath)) {
    warn(`usando cache de ${meta.fetchedAt} para ${url} (fonte indisponivel agora)`);
    return { body: maybeGunzip(readFileSync(bodyPath), url, opts.gunzip), fromCache: true };
  }
  throw lastErr;
}

function maybeGunzip(raw: Buffer, url: string, want?: boolean): Buffer {
  const isGz = raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b;
  if (want === false) return raw;
  if (!isGz && !url.endsWith('.gz')) return raw;
  if (!isGz) return raw;
  return gunzipSync(raw);
}

export async function fetchJson<T>(c: Config, url: string, force = false): Promise<T> {
  const { body } = await fetchCached(c, url, { force });
  return JSON.parse(body.toString('utf8')) as T;
}

export async function fetchText(c: Config, url: string, force = false): Promise<string> {
  const { body } = await fetchCached(c, url, { force });
  return body.toString('utf8');
}

/**
 * Pre-checagem HTTP do stream. Nao baixa o conteudo: pede os primeiros bytes
 * so para colher status, cabecalhos e trecho do corpo de erro, que e a evidencia
 * usada para classificar AUTH_REQUIRED / GEO_BLOCKED sem adivinhar.
 */
export async function probeHttp(
  c: Config,
  url: string,
  extra: { userAgent?: string | null; referrer?: string | null },
): Promise<{
  status: number;
  finalUrl: string;
  headers: Record<string, string>;
  bodySnippet: string;
}> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), c.validation.connectTimeoutMs);
  try {
    const headers: Record<string, string> = {
      'user-agent': extra.userAgent || c.http.userAgent,
      range: 'bytes=0-2047',
    };
    if (extra.referrer) headers['referer'] = extra.referrer;
    const res = await fetch(url, { headers, signal: ac.signal, redirect: 'follow' });
    let snippet = '';
    if (!res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      snippet = buf.subarray(0, c.http.errorBodySnippetBytes).toString('utf8');
    } else {
      // Fecha o corpo sem ler tudo: nao queremos baixar o stream.
      await res.body?.cancel().catch(() => {});
    }
    return {
      status: res.status,
      finalUrl: res.url || url,
      headers: headerMap(res.headers),
      bodySnippet: snippet,
    };
  } finally {
    clearTimeout(timer);
  }
}
