/**
 * Carrega o corpus publicado para recuperacao.
 *
 * Nada e gerado aqui: o pipeline ja publica `data/channels.json`, as fatias de
 * `docs/epg/` e o `status.json`. Esta camada apenas le esses arquivos, descarta o
 * que nao tem identidade estavel (`tvg-id`) e monta os indices em memoria.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { HealthStatus, RagConfig, Taxonomy } from './config.ts';
import { ROOT } from './config.ts';
import { buildIndex, type IndexDoc, type LexicalIndex, type TokenizeOptions } from './lexical.ts';

export interface StreamDoc {
  key: string;
  url: string;
  role: string;
  status: HealthStatus;
  byVantage: Record<
    string,
    { status: HealthStatus; checkedAt: string; http: number | null; reason: string | null }
  >;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  resolution: string | null;
  audioLanguages: string[];
  subtitleTracks: number;
  subtitleDetectionReliable: boolean | null;
  verifiedPortugueseAudio: boolean;
}

export interface ChannelDoc {
  tvgId: string;
  id: string;
  name: string;
  countryCode: string | null;
  countryGroup: string;
  countryGroupLabel: string;
  countryGroupReason: string | null;
  section: string;
  primaryCategory: string;
  categories: string[];
  categoryLabels: string[];
  declaredLanguages: string[];
  timezones: string[];
  logo: string | null;
  website: string | null;
  hasGuide: boolean;
  guideProgrammes: number;
  streams: StreamDoc[];
}

export interface GuideProgramme {
  start: number;
  end: number;
  title: string;
  desc: string;
  categories: string[];
}

export interface GuideSlice {
  tvgId: string;
  name: string;
  generatedAt: string;
  horizonHours: number;
  programmes: GuideProgramme[];
}

/**
 * Canal com tvg-id que ficou fora do indice, com a evidencia da exclusao.
 *
 * Existe para a pergunta "o canal X funciona?" ter resposta medida tambem quando a
 * resposta e nao. Sem isso o sistema diria apenas "nao conheco esse canal", que e
 * uma afirmacao diferente e pior.
 */
export interface RejectedChannel {
  tvgId: string;
  name: string;
  countryGroup: string;
  classified: boolean;
  eligible: boolean;
  health: HealthStatus;
  observations: {
    vantage: string;
    status: HealthStatus;
    checkedAt: string;
    http: number | null;
    reason: string | null;
  }[];
}

export interface CorpusStats {
  /** Quando o pipeline gerou os metadados que estao sendo lidos. */
  channelsGeneratedAt: string;
  guideGeneratedAt: string | null;
  channelsIndexed: number;
  /** Canais com tvg-id que ficaram fora do indice por nao serem elegiveis ou classificados. */
  channelsRejected: number;
  channelsWithGuide: number;
  guideCoveragePercent: number;
  programmesInGuide: number;
  vantagesSeen: string[];
  byCountryGroup: Record<string, number>;
  byCategory: Record<string, number>;
  /** Vem do status.json publicado, quando existe. Agregado por ponto de observacao. */
  streamsByVantageAndStatus: Record<string, Record<string, number>>;
}

export interface Corpus {
  channels: ChannelDoc[];
  byTvgId: Map<string, ChannelDoc>;
  rejected: Map<string, RejectedChannel>;
  guide: Map<string, GuideSlice>;
  stats: CorpusStats;
  channelIndex: LexicalIndex;
  programmeIndex: LexicalIndex;
  /** id do indice de programas -> canal e posicao dentro da fatia. */
  programmeRef: Map<string, { tvgId: string; position: number }>;
}

interface MetadataStream {
  key: string;
  url: string;
  role: string;
  health: HealthStatus;
  byVantage: StreamDoc['byVantage'];
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  media: {
    resolution: string | null;
    audioLanguages: string[];
    subtitleTracks: { language: string | null; codec: string }[];
    subtitleDetectionReliable: boolean;
  } | null;
  verifiedPortugueseAudio: boolean;
}

interface MetadataChannel {
  id: string;
  tvgId: string | null;
  name: string;
  classified: boolean;
  country: string | null;
  countryGroup: string;
  countryGroupReason: string | null;
  section: string;
  primaryCategory: string;
  categories: string[];
  declaredLanguages: string[];
  timezones: string[];
  logo: string | null;
  website: string | null;
  epg: { hasGuide: boolean; programmes: number };
  eligible: boolean;
  streams: MetadataStream[];
}

interface MetadataFile {
  generatedAt: string;
  vantagesSeen: string[];
  channels: MetadataChannel[];
}

interface SliceIndexFile {
  generatedAt: string;
  horizonHours: number;
  channels: number;
  programmes: number;
  items: { id: string; name: string; file: string; count: number }[];
}

export function tokenizeOptions(rag: RagConfig): TokenizeOptions {
  return {
    minLength: rag.retrieval.minTokenLength,
    stopwords: new Set(rag.lexicon.stopwords),
  };
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function loadGuide(rag: RagConfig): { slices: Map<string, GuideSlice>; generatedAt: string | null } {
  const dir = resolve(ROOT, rag.corpus.epgSliceDir);
  const slices = new Map<string, GuideSlice>();
  const indexPath = resolve(dir, 'index.json');
  if (!existsSync(indexPath)) return { slices, generatedAt: null };

  const index = readJson<SliceIndexFile>(indexPath);
  // So os arquivos listados no indice, e so os que casam o padrao publicado: o
  // diretorio e servido pelo Pages e nao se le nada que nao esteja declarado.
  const declared = new Set(index.items.map((i) => i.file));
  const present = new Set(readdirSync(dir).filter((f) => /^[A-Za-z0-9._-]+\.json$/.test(f)));

  for (const item of index.items) {
    if (!declared.has(item.file) || !present.has(item.file)) continue;
    const slice = readJson<{
      id: string;
      name: string;
      programmes: { s: number; e: number; t: string; d: string; c: string[] }[];
      generatedAt: string;
      horizonHours: number;
    }>(resolve(dir, item.file));
    slices.set(slice.id, {
      tvgId: slice.id,
      name: slice.name,
      generatedAt: slice.generatedAt,
      horizonHours: slice.horizonHours,
      programmes: slice.programmes.map((p) => ({
        start: p.s,
        end: p.e,
        title: p.t,
        desc: p.d,
        categories: p.c,
      })),
    });
  }
  return { slices, generatedAt: index.generatedAt };
}

/** Observacao mais recente por ponto de observacao, entre todos os streams do canal. */
function latestByVantage(streams: MetadataStream[]): RejectedChannel['observations'] {
  const latest = new Map<string, RejectedChannel['observations'][number]>();
  for (const s of streams) {
    for (const [vantage, v] of Object.entries(s.byVantage)) {
      const current = latest.get(vantage);
      if (!current || v.checkedAt > current.checkedAt) {
        latest.set(vantage, {
          vantage,
          status: v.status,
          checkedAt: v.checkedAt,
          http: v.http,
          reason: v.reason,
        });
      }
    }
  }
  return [...latest.values()].sort((a, b) => a.vantage.localeCompare(b.vantage));
}

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

export function loadCorpus(rag: RagConfig, tax: Taxonomy): Corpus {
  const metaPath = resolve(ROOT, rag.corpus.channelsFile);
  if (!existsSync(metaPath)) {
    throw new Error(
      `${rag.corpus.channelsFile} nao existe. Rode o pipeline (\`npm run all\`) ou baixe o arquivo publicado.`,
    );
  }
  const meta = readJson<MetadataFile>(metaPath);
  const groupLabel = new Map(tax.countryGroups.map((g) => [g.code, g.label]));
  const catLabel = new Map(tax.categories.map((c) => [c.code, c.label]));

  const channels: ChannelDoc[] = [];
  const rejected = new Map<string, RejectedChannel>();
  for (const c of meta.channels) {
    // Sem tvg-id nao ha identidade estavel para casar playlist, metadado e guia.
    if (!c.tvgId) continue;
    const classifiedOk = !rag.corpus.requireClassified || c.classified;
    const eligibleOk = !rag.corpus.requireEligible || c.eligible;
    if (!classifiedOk || !eligibleOk) {
      rejected.set(c.tvgId, {
        tvgId: c.tvgId,
        name: c.name,
        countryGroup: c.countryGroup,
        classified: c.classified,
        eligible: c.eligible,
        health: c.streams[0]?.health ?? 'UNKNOWN',
        observations: latestByVantage(c.streams),
      });
      continue;
    }

    channels.push({
      tvgId: c.tvgId,
      id: c.id,
      name: c.name,
      countryCode: c.country,
      countryGroup: c.countryGroup,
      countryGroupLabel: groupLabel.get(c.countryGroup) ?? c.countryGroup,
      countryGroupReason: c.countryGroupReason,
      section: c.section,
      primaryCategory: c.primaryCategory,
      categories: c.categories,
      categoryLabels: c.categories.map((x) => catLabel.get(x) ?? x),
      declaredLanguages: c.declaredLanguages,
      timezones: c.timezones,
      logo: c.logo,
      website: c.website,
      hasGuide: c.epg.hasGuide,
      guideProgrammes: c.epg.programmes,
      streams: c.streams.map((s) => ({
        key: s.key,
        url: s.url,
        role: s.role,
        status: s.health,
        byVantage: s.byVantage,
        lastSuccessAt: s.lastSuccessAt,
        consecutiveFailures: s.consecutiveFailures,
        resolution: s.media?.resolution ?? null,
        audioLanguages: s.media?.audioLanguages ?? [],
        subtitleTracks: s.media?.subtitleTracks.length ?? 0,
        subtitleDetectionReliable: s.media ? s.media.subtitleDetectionReliable : null,
        verifiedPortugueseAudio: s.verifiedPortugueseAudio,
      })),
    });
  }

  const { slices, generatedAt: guideGeneratedAt } = loadGuide(rag);
  const opts = tokenizeOptions(rag);
  const w = rag.retrieval.fieldWeights;

  const channelDocs: IndexDoc[] = channels.map((c) => ({
    id: c.tvgId,
    fields: [
      { text: c.name, weight: w['name'] ?? 1 },
      { text: c.section, weight: w['section'] ?? 1 },
      { text: c.categoryLabels.concat(c.categories).join(' '), weight: w['category'] ?? 1 },
      { text: c.declaredLanguages.join(' '), weight: w['language'] ?? 1 },
      {
        text: [c.countryGroupLabel, c.countryGroup, c.countryCode ?? ''].join(' '),
        weight: w['country'] ?? 1,
      },
      { text: c.tvgId.replace(/[.@]/g, ' '), weight: w['tvgId'] ?? 1 },
    ],
  }));

  const programmeDocs: IndexDoc[] = [];
  const programmeRef = new Map<string, { tvgId: string; position: number }>();
  let programmesInGuide = 0;
  for (const slice of slices.values()) {
    slice.programmes.forEach((p, position) => {
      const id = `${slice.tvgId}#${position}`;
      programmeRef.set(id, { tvgId: slice.tvgId, position });
      programmeDocs.push({
        id,
        fields: [
          { text: p.title, weight: w['programmeTitle'] ?? 1 },
          { text: p.desc, weight: w['programmeDesc'] ?? 1 },
          { text: p.categories.join(' '), weight: w['programmeCategory'] ?? 1 },
        ],
      });
      programmesInGuide++;
    });
  }

  const withGuide = channels.filter((c) => slices.has(c.tvgId)).length;
  const statusPath = resolve(ROOT, rag.corpus.statusFile);
  let streamsByVantageAndStatus: Record<string, Record<string, number>> = {};
  if (existsSync(statusPath)) {
    const status = readJson<{
      validation?: { streamsByVantageAndStatus?: Record<string, Record<string, number>> };
    }>(statusPath);
    streamsByVantageAndStatus = status.validation?.streamsByVantageAndStatus ?? {};
  }

  const stats: CorpusStats = {
    channelsGeneratedAt: meta.generatedAt,
    guideGeneratedAt,
    channelsIndexed: channels.length,
    channelsRejected: rejected.size,
    channelsWithGuide: withGuide,
    // Medido sobre o que foi de fato indexado, nunca arredondado para cima.
    guideCoveragePercent: channels.length
      ? Number(((withGuide / channels.length) * 100).toFixed(2))
      : 0,
    programmesInGuide,
    vantagesSeen: meta.vantagesSeen,
    byCountryGroup: countBy(channels.map((c) => c.countryGroup)),
    byCategory: countBy(channels.map((c) => c.primaryCategory)),
    streamsByVantageAndStatus,
  };

  return {
    channels,
    byTvgId: new Map(channels.map((c) => [c.tvgId, c])),
    rejected,
    guide: slices,
    stats,
    channelIndex: buildIndex(channelDocs, opts),
    programmeIndex: buildIndex(programmeDocs, opts),
    programmeRef,
  };
}
