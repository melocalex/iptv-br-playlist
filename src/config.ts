import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export type HealthStatus =
  | 'WORKING'
  | 'UNSTABLE'
  | 'OFFLINE'
  | 'TIMEOUT'
  | 'GEO_BLOCKED'
  | 'AUTH_REQUIRED'
  | 'UNSUPPORTED'
  | 'UNKNOWN';

export const ALL_STATUSES: HealthStatus[] = [
  'WORKING',
  'UNSTABLE',
  'OFFLINE',
  'TIMEOUT',
  'GEO_BLOCKED',
  'AUTH_REQUIRED',
  'UNSUPPORTED',
  'UNKNOWN',
];

export interface Config {
  repo: { owner: string; name: string; branch: string };
  vantage: string;
  http: {
    connectTimeoutMs: number;
    readTimeoutMs: number;
    retries: number;
    retryBackoffMs: number;
    userAgent: string;
    errorBodySnippetBytes: number;
    /** Teto do corpo baixado e do conteudo descomprimido: fonte publica nao e confiavel. */
    maxDownloadBytes: number;
    maxDecompressedBytes: number;
  };
  validation: {
    concurrency: number;
    connectTimeoutMs: number;
    probeTimeoutMs: number;
    attemptsPerStream: number;
    retryBackoffMs: number;
    maxChecksPerRun: number;
    dropAfterFailures: number;
    historyWindow: number;
    unstableMinMixed: number;
    ffprobePath: string;
    analyzeDurationUs: number;
    probeSizeBytes: number;
    priorityCountryGroups: string[];
    recheckHours: Record<string, number>;
  };
  epg: {
    enabled: boolean;
    days: number;
    maxConnections: number;
    requestTimeoutMs: number;
    grabTimeoutMs: number;
    grabberRepo: string;
    grabberRef: string;
    grabberDir: string;
    maxChannelsPerSite: number;
    programmeHorizonHours: number;
    /** Janela das fatias por canal. Curta de proposito: e uma grade de TV, nao um arquivo. */
    sliceHorizonHours: number;
    sliceDescMaxChars: number;
    maxSliceFiles: number;
  };
  filters: { excludeNsfw: boolean; excludeClosedChannels: boolean };
  classification: { internationalAreas: string[]; internationalMinCountries: number };
  output: {
    dir: string;
    epgFile: string;
    mainPlaylist: string;
    statusJson: string;
    statusMarkdown: string;
    metadataFile: string;
    healthFile: string;
    epgCoverageFile: string;
    /** Indice tvg-id -> numero de programas, para a etapa de build rodar sem o grabber. */
    epgIndexFile: string;
    /** Diretorio das fatias por canal, servido tambem pelo GitHub Pages. */
    epgSliceDir: string;
    validationReportFile: string;
  };
}

export interface CountryGroup {
  code: string;
  label: string;
  flag: string;
  countries: string[];
}

export interface CategoryDef {
  code: string;
  label: string;
  from: string[];
}

export interface Taxonomy {
  countryGroups: CountryGroup[];
  countryOrder: string[];
  languagePriority: string[];
  categories: CategoryDef[];
  categoryOrder: string[];
  fallbackCategory: string;
  excludeSourceCategories: string[];
  sectionSeparator: string;
}

export interface M3uSource {
  id: string;
  kind: 'm3u';
  enabled: boolean;
  url: string;
  master?: boolean;
  coveredBy?: string;
  note?: string;
}

export interface Sources {
  api: {
    kind: 'iptv-org-api';
    enabled: boolean;
    baseUrl: string;
    files: Record<string, string>;
  };
  playlists: M3uSource[];
}

export interface EpgConfig {
  grabberSites: { site: string; enabled: boolean; note?: string }[];
  publishedGuides: {
    id: string;
    enabled: boolean;
    url: string;
    /** 'iptv-org': ids ja sao canal@feed, casamento exato. 'foreign': exige idMap. */
    idFormat: 'iptv-org' | 'foreign';
    idMap: Record<string, string> | null;
    note?: string;
  }[];
}

function readJson<T>(relPath: string): T {
  return JSON.parse(readFileSync(resolve(ROOT, relPath), 'utf8')) as T;
}

/**
 * Sobrescreve qualquer chave de config via variavel de ambiente.
 * Caminho da chave em maiuscula, com _ como separador: IPTV_VALIDATION_CONCURRENCY.
 * Tipo do valor original decide a conversao, para nao transformar numero em string.
 */
function applyEnvOverrides(node: unknown, prefix: string, applied: string[]): void {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
  for (const [key, current] of Object.entries(node as Record<string, unknown>)) {
    const envName = `${prefix}_${key.toUpperCase()}`;
    if (current !== null && typeof current === 'object' && !Array.isArray(current)) {
      applyEnvOverrides(current, envName, applied);
      continue;
    }
    const raw = process.env[envName];
    if (raw === undefined || raw === '') continue;
    const target = node as Record<string, unknown>;
    if (typeof current === 'number') {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`${envName} nao e numero: ${raw}`);
      target[key] = n;
    } else if (typeof current === 'boolean') {
      target[key] = raw === 'true' || raw === '1';
    } else if (Array.isArray(current)) {
      target[key] = raw.split(',').map((s) => s.trim()).filter(Boolean);
    } else {
      target[key] = raw;
    }
    applied.push(envName);
  }
}

let cached: {
  config: Config;
  taxonomy: Taxonomy;
  sources: Sources;
  epg: EpgConfig;
  envApplied: string[];
} | null = null;

export function load() {
  if (cached) return cached;
  const config = readJson<Config>('config/config.json');
  const envApplied: string[] = [];
  applyEnvOverrides(config, 'IPTV', envApplied);
  cached = {
    config,
    taxonomy: readJson<Taxonomy>('config/taxonomy.json'),
    sources: readJson<Sources>('config/sources.json'),
    epg: readJson<EpgConfig>('config/epg.json'),
    envApplied,
  };
  return cached;
}

export function rawUrl(c: Config, file: string): string {
  return `https://raw.githubusercontent.com/${c.repo.owner}/${c.repo.name}/${c.repo.branch}/${file}`;
}

export function outPath(c: Config, file: string): string {
  return resolve(ROOT, c.output.dir, file);
}
