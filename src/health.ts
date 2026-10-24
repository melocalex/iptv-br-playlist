import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Config, HealthStatus } from './config.ts';
import { outPath } from './config.ts';
import { info, warn } from './log.ts';

export interface MediaInfo {
  container: string | null;
  videoCodec: string | null;
  width: number | null;
  height: number | null;
  resolution: string | null;
  fps: number | null;
  audioCodec: string | null;
  audioChannels: number | null;
  /** Idiomas de audio detectados pelo ffprobe (tag 'language' da faixa). */
  audioLanguages: string[];
  subtitleTracks: { language: string | null; codec: string }[];
  /**
   * HLS entrega legenda em playlist de variante que o ffprobe nao abre por padrao.
   * Quando false, ausencia de faixa NAO e prova de ausencia de legenda.
   */
  subtitleDetectionReliable: boolean;
}

export interface VantageHealth {
  status: HealthStatus;
  checkedAt: string;
  http: number | null;
  reason: string | null;
  evidence: string | null;
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  history: HealthStatus[];
  media: MediaInfo | null;
}

export interface StreamHealth {
  url: string;
  channelId: string | null;
  vantages: Record<string, VantageHealth>;
}

export interface HealthStore {
  version: number;
  updatedAt: string | null;
  streams: Record<string, StreamHealth>;
}

export const SUCCESS_STATUSES: HealthStatus[] = ['WORKING', 'UNSTABLE'];

export function isSuccess(s: HealthStatus): boolean {
  return SUCCESS_STATUSES.includes(s);
}

export function loadHealth(cfg: Config): HealthStore {
  const p = outPath(cfg, cfg.output.healthFile);
  if (!existsSync(p)) return { version: 1, updatedAt: null, streams: {} };
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as HealthStore;
    if (!parsed.streams) throw new Error('sem campo streams');
    info(`health carregado: ${Object.keys(parsed.streams).length} streams`);
    return parsed;
  } catch (err) {
    warn(`health invalido em ${p}, comecando vazio: ${(err as Error).message}`);
    return { version: 1, updatedAt: null, streams: {} };
  }
}

export function saveHealth(cfg: Config, store: HealthStore): void {
  const p = outPath(cfg, cfg.output.healthFile);
  mkdirSync(dirname(p), { recursive: true });
  store.updatedAt = new Date().toISOString();
  // Chaves ordenadas: diff do git fica estavel entre execucoes.
  const ordered: Record<string, StreamHealth> = {};
  for (const k of Object.keys(store.streams).sort()) ordered[k] = store.streams[k]!;
  store.streams = ordered;
  writeFileSync(p, JSON.stringify(store, null, 1) + '\n');
}

/** Grava um resultado de checagem, atualizando historico e contagem de falhas. */
export function record(
  cfg: Config,
  store: HealthStore,
  key: string,
  url: string,
  channelId: string | null,
  vantage: string,
  result: {
    status: HealthStatus;
    http: number | null;
    reason: string | null;
    evidence: string | null;
    media: MediaInfo | null;
  },
): VantageHealth {
  let entry = store.streams[key];
  if (!entry) {
    entry = { url, channelId, vantages: {} };
    store.streams[key] = entry;
  }
  entry.url = url;
  entry.channelId = channelId;
  const prev = entry.vantages[vantage];
  const now = new Date().toISOString();
  const ok = isSuccess(result.status);
  const history = [...(prev?.history ?? []), result.status].slice(-cfg.validation.historyWindow);

  const next: VantageHealth = {
    status: result.status,
    checkedAt: now,
    http: result.http,
    reason: result.reason,
    evidence: result.evidence,
    consecutiveFailures: ok ? 0 : (prev?.consecutiveFailures ?? 0) + 1,
    lastSuccessAt: ok ? now : prev?.lastSuccessAt ?? null,
    // Media valida nunca e sobrescrita por resultado sem media.
    media: result.media ?? prev?.media ?? null,
    history,
  };
  entry.vantages[vantage] = next;
  return next;
}

/** Status efetivo considerando o historico: sucesso que oscila vira UNSTABLE. */
export function effectiveStatus(cfg: Config, v: VantageHealth): HealthStatus {
  if (!isSuccess(v.status)) return v.status;
  const window = v.history.slice(-cfg.validation.historyWindow);
  if (window.length < 2) return v.status;
  const failures = window.filter((s) => !isSuccess(s)).length;
  return failures >= cfg.validation.unstableMinMixed ? 'UNSTABLE' : 'WORKING';
}

/** Decide se o stream precisa de nova checagem agora (validacao incremental). */
export function needsCheck(cfg: Config, v: VantageHealth | undefined, now = Date.now()): boolean {
  if (!v) return true;
  const hours = cfg.validation.recheckHours[v.status] ?? 0;
  if (hours <= 0) return true;
  const age = now - Date.parse(v.checkedAt);
  return age >= hours * 3600_000;
}
