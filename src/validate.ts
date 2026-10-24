import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, type Config, type HealthStatus } from './config.ts';
import { probeHttp, errorCodeOf } from './http.ts';
import type { MediaInfo, HealthStore } from './health.ts';
import { record, needsCheck } from './health.ts';
import type { Channel, Stream } from './catalog.ts';
import { info, progress, warn } from './log.ts';

interface Evidence {
  geoPatterns: string[];
  authPatterns: string[];
  ffprobeAuthPatterns: string[];
  ffprobeNotFoundPatterns: string[];
  ffprobeTimeoutPatterns: string[];
  resolutionLadder: { minHeight: number; label: string }[];
  portugueseAudioCodes: string[];
  hlsUrlPatterns: string[];
  transientStatuses: HealthStatus[];
}

export const evidence: Evidence = JSON.parse(
  readFileSync(resolve(ROOT, 'config/evidence.json'), 'utf8'),
) as Evidence;

const rx = (patterns: string[]) => patterns.map((p) => new RegExp(p, 'i'));
const GEO = rx(evidence.geoPatterns);
const AUTH = rx(evidence.authPatterns);
const FF_AUTH = rx(evidence.ffprobeAuthPatterns);
const FF_404 = rx(evidence.ffprobeNotFoundPatterns);
const FF_TIMEOUT = rx(evidence.ffprobeTimeoutPatterns);
const HLS = rx(evidence.hlsUrlPatterns);

function firstMatch(res: RegExp[], text: string): string | null {
  for (const r of res) {
    const m = r.exec(text);
    if (m) return m[0];
  }
  return null;
}

export function resolutionLabel(height: number | null): string | null {
  if (!height || height <= 0) return null;
  for (const step of evidence.resolutionLadder) {
    if (height >= step.minHeight) return step.label;
  }
  return null;
}

export function isPortuguese(code: string | null | undefined): boolean {
  if (!code) return false;
  return evidence.portugueseAudioCodes.includes(code.toLowerCase().replace(/_/g, '-'));
}

export interface CheckResult {
  status: HealthStatus;
  http: number | null;
  reason: string | null;
  evidence: string | null;
  media: MediaInfo | null;
}

interface FfStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  channels?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  tags?: Record<string, string>;
}

function parseFps(s: string | undefined): number | null {
  if (!s) return null;
  const [a, b] = s.split('/');
  const num = Number(a);
  const den = Number(b ?? 1);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
  const v = num / den;
  return Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : null;
}

function runFfprobe(
  cfg: Config,
  url: string,
  s: { userAgent: string | null; referrer: string | null },
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  const args = [
    '-v', 'error',
    '-hide_banner',
    '-of', 'json',
    '-show_format',
    '-show_streams',
    '-rw_timeout', String(cfg.validation.probeTimeoutMs * 1000),
    '-analyzeduration', String(cfg.validation.analyzeDurationUs),
    '-probesize', String(cfg.validation.probeSizeBytes),
    '-user_agent', s.userAgent || cfg.http.userAgent,
  ];
  if (s.referrer) args.push('-headers', `Referer: ${s.referrer}\r\n`);
  args.push('-i', url);

  return new Promise((resolvePromise) => {
    const child = spawn(cfg.validation.ffprobePath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const kill = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.killed || child.kill('SIGKILL'), 2000);
    }, cfg.validation.probeTimeoutMs);

    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    const done = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(kill);
      resolvePromise({ code, stdout, stderr, timedOut });
    };
    child.on('close', done);
    child.on('error', (err) => {
      stderr += String(err);
      done(-1);
    });
  });
}

/** Uma tentativa de checagem: pre-checagem HTTP e, se passar, ffprobe. */
async function attempt(cfg: Config, s: Stream): Promise<CheckResult> {
  // --- etapa 1: HTTP -------------------------------------------------------
  let http: number | null = null;
  let errBody = '';
  let headerBlob = '';
  try {
    const p = await probeHttp(cfg, s.url, { userAgent: s.userAgent, referrer: s.referrer });
    http = p.status;
    errBody = p.bodySnippet;
    headerBlob = Object.entries(p.headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');
  } catch (err) {
    const code = errorCodeOf(err);
    if (code === 'AbortError' || code === 'TimeoutError' || code === 'ETIMEDOUT') {
      return { status: 'TIMEOUT', http: null, reason: 'connect_timeout', evidence: code, media: null };
    }
    return { status: 'OFFLINE', http: null, reason: `net:${code}`, evidence: code, media: null };
  }

  if (http >= 400) {
    const blob = `${headerBlob}\n${errBody}`;
    const geoHit = firstMatch(GEO, blob);
    const authHit = firstMatch(AUTH, blob);
    const hasWwwAuth = /^www-authenticate:/im.test(headerBlob);
    const snip = errBody.slice(0, 200).replace(/\s+/g, ' ').trim();

    if (http === 451) {
      return { status: 'GEO_BLOCKED', http, reason: 'http_451', evidence: snip || 'HTTP 451', media: null };
    }
    if (geoHit) {
      return { status: 'GEO_BLOCKED', http, reason: `geo_text`, evidence: geoHit, media: null };
    }
    if (http === 401 || hasWwwAuth) {
      return {
        status: 'AUTH_REQUIRED',
        http,
        reason: http === 401 ? 'http_401' : 'www_authenticate',
        evidence: snip || 'WWW-Authenticate',
        media: null,
      };
    }
    if (authHit && http === 403) {
      return { status: 'AUTH_REQUIRED', http, reason: 'auth_text', evidence: authHit, media: null };
    }
    // Recusa comprovada, motivo nao comprovado. Nao chamamos de geo-bloqueio sem prova.
    return { status: 'OFFLINE', http, reason: `http_${http}`, evidence: snip || null, media: null };
  }

  // --- etapa 2: ffprobe ----------------------------------------------------
  const ff = await runFfprobe(cfg, s.url, s);
  if (ff.timedOut) {
    return { status: 'TIMEOUT', http, reason: 'probe_timeout', evidence: null, media: null };
  }
  if (ff.code !== 0) {
    const err = ff.stderr.slice(0, 300).replace(/\s+/g, ' ').trim();
    if (firstMatch(FF_TIMEOUT, err)) {
      return { status: 'TIMEOUT', http, reason: 'probe_timeout', evidence: err, media: null };
    }
    if (firstMatch(FF_AUTH, err)) {
      return { status: 'AUTH_REQUIRED', http, reason: 'ffprobe_auth', evidence: err, media: null };
    }
    if (firstMatch(FF_404, err)) {
      return { status: 'OFFLINE', http, reason: 'ffprobe_unreachable', evidence: err, media: null };
    }
    return { status: 'UNSUPPORTED', http, reason: 'ffprobe_failed', evidence: err, media: null };
  }

  let parsed: { streams?: FfStream[]; format?: { format_name?: string } };
  try {
    parsed = JSON.parse(ff.stdout) as typeof parsed;
  } catch {
    return {
      status: 'UNSUPPORTED',
      http,
      reason: 'ffprobe_output_invalido',
      evidence: ff.stdout.slice(0, 200),
      media: null,
    };
  }

  const all = parsed.streams ?? [];
  const video = all.find((x) => x.codec_type === 'video');
  const audio = all.find((x) => x.codec_type === 'audio');
  const subs = all.filter((x) => x.codec_type === 'subtitle');

  if (!video && !audio) {
    return { status: 'UNSUPPORTED', http, reason: 'nenhuma_faixa_tocavel', evidence: null, media: null };
  }

  const audioLanguages = [
    ...new Set(
      all
        .filter((x) => x.codec_type === 'audio')
        .map((x) => x.tags?.['language'])
        .filter((l): l is string => Boolean(l) && l !== 'und'),
    ),
  ];

  const media: MediaInfo = {
    container: parsed.format?.format_name ?? null,
    videoCodec: video?.codec_name ?? null,
    width: video?.width ?? null,
    height: video?.height ?? null,
    resolution: resolutionLabel(video?.height ?? null),
    fps: parseFps(video?.avg_frame_rate ?? video?.r_frame_rate),
    audioCodec: audio?.codec_name ?? null,
    audioChannels: audio?.channels ?? null,
    audioLanguages,
    subtitleTracks: subs.map((x) => ({
      language: x.tags?.['language'] ?? null,
      codec: x.codec_name ?? 'desconhecido',
    })),
    subtitleDetectionReliable: !HLS.some((r) => r.test(s.url)),
  };

  return { status: 'WORKING', http, reason: null, evidence: null, media };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Checa um stream com retentativa em falha transitoria; oscilacao vira UNSTABLE. */
export async function checkStream(cfg: Config, s: Stream): Promise<CheckResult> {
  let last: CheckResult | null = null;
  let sawSuccess = false;
  let sawFailure = false;

  for (let i = 0; i < Math.max(1, cfg.validation.attemptsPerStream); i++) {
    if (i > 0) await sleep(cfg.validation.retryBackoffMs);
    const r = await attempt(cfg, s);
    last = r;
    if (r.status === 'WORKING') {
      sawSuccess = true;
      break;
    }
    sawFailure = true;
    if (!evidence.transientStatuses.includes(r.status)) break;
  }

  const result = last!;
  // Sucesso apos falha transitoria na mesma execucao: instavel, nao "funcionando".
  if (sawSuccess && sawFailure) return { ...result, status: 'UNSTABLE', reason: 'oscilou_na_execucao' };
  return result;
}

export interface ValidationRunReport {
  vantage: string;
  startedAt: string;
  finishedAt: string;
  totalStreams: number;
  eligible: number;
  checked: number;
  skippedFresh: number;
  byStatus: Record<string, number>;
}

/** Fila com limite de concorrencia. */
async function runPool<T>(items: T[], limit: number, worker: (item: T, i: number) => Promise<void>) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i]!, i);
    }
  });
  await Promise.all(runners);
}

export async function validateCatalog(
  cfg: Config,
  channels: Channel[],
  store: HealthStore,
  opts: { limit?: number; only?: (c: Channel) => boolean } = {},
): Promise<ValidationRunReport> {
  const vantage = cfg.vantage;
  const startedAt = new Date().toISOString();
  const priority = new Set(cfg.validation.priorityCountryGroups);

  type Job = {
    stream: Stream;
    channel: Channel;
    prioritized: boolean;
    classified: boolean;
    lastCheck: number;
  };
  const jobs: Job[] = [];
  let totalStreams = 0;
  let skippedFresh = 0;

  for (const ch of channels) {
    if (opts.only && !opts.only(ch)) continue;
    for (const s of ch.streams) {
      totalStreams++;
      const v = store.streams[s.key]?.vantages[vantage];
      if (!needsCheck(cfg, v)) {
        skippedFresh++;
        continue;
      }
      jobs.push({
        stream: s,
        channel: ch,
        prioritized: priority.has(ch.countryGroup),
        classified: ch.classified,
        lastCheck: v ? Date.parse(v.checkedAt) : 0,
      });
    }
  }

  // Ordem do orcamento: grupo prioritario, depois canal COM metadado, depois o
  // nunca checado / mais antigo.
  //
  // O criterio do meio nao e cosmetico. Stream sem metadado de canal na fonte nunca
  // entra nas playlists validadas (classificar pelo nome seria adivinhacao), e eles
  // aparecem cedo em streams.json. Sem este desempate, o teto de maxChecksPerRun era
  // gasto quase todo neles: numa execucao de 1400 checagens, 855 dos 1183 streams
  // aprovados eram nao classificados, ou seja, trabalho que nao vira canal publicado.
  jobs.sort((a, b) => {
    if (a.prioritized !== b.prioritized) return a.prioritized ? -1 : 1;
    if (a.classified !== b.classified) return a.classified ? -1 : 1;
    return a.lastCheck - b.lastCheck;
  });

  const cap = opts.limit ?? cfg.validation.maxChecksPerRun;
  const slice = cap > 0 ? jobs.slice(0, cap) : jobs;
  info(
    `validacao [${vantage}]: ${totalStreams} streams, ${jobs.length} elegiveis, ` +
      `${skippedFresh} ainda frescos, ${slice.length} nesta execucao, concorrencia ${cfg.validation.concurrency}`,
  );

  const byStatus: Record<string, number> = {};
  let done = 0;
  await runPool(slice, cfg.validation.concurrency, async (job) => {
    try {
      const r = await checkStream(cfg, job.stream);
      record(cfg, store, job.stream.key, job.stream.url, job.channel.id, vantage, r);
      byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    } catch (err) {
      warn(`erro inesperado em ${job.stream.url}: ${(err as Error).message}`);
      record(cfg, store, job.stream.key, job.stream.url, job.channel.id, vantage, {
        status: 'UNKNOWN',
        http: null,
        reason: 'erro_interno',
        evidence: (err as Error).message.slice(0, 200),
        media: null,
      });
      byStatus['UNKNOWN'] = (byStatus['UNKNOWN'] ?? 0) + 1;
    }
    progress(++done, slice.length, `validando [${vantage}]`);
  });

  return {
    vantage,
    startedAt,
    finishedAt: new Date().toISOString(),
    totalStreams,
    eligible: jobs.length,
    checked: slice.length,
    skippedFresh,
    byStatus,
  };
}
