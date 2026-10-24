import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Config, HealthStatus, Taxonomy } from './config.ts';
import { outPath, rawUrl } from './config.ts';
import type { Channel, Stream } from './catalog.ts';
import type { HealthStore, MediaInfo, VantageHealth } from './health.ts';
import { effectiveStatus, isSuccess } from './health.ts';
import { isPortuguese } from './validate.ts';
import { serializeM3u, type M3uDocument, type M3uEntry } from './m3u.ts';
import { info } from './log.ts';

const STATUS_RANK: Record<HealthStatus, number> = {
  WORKING: 0,
  UNSTABLE: 1,
  TIMEOUT: 2,
  UNKNOWN: 3,
  OFFLINE: 4,
  UNSUPPORTED: 5,
  GEO_BLOCKED: 6,
  AUTH_REQUIRED: 7,
};

export interface StreamView {
  stream: Stream;
  /** Status por ponto de observacao. Runner dos EUA e maquina no Brasil divergem. */
  byVantage: Record<string, { status: HealthStatus; checkedAt: string; http: number | null; reason: string | null }>;
  bestStatus: HealthStatus;
  bestVantage: string | null;
  media: MediaInfo | null;
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  /** Elegivel para as playlists validadas: funcionou em algum vantage e nao esgotou as falhas. */
  eligible: boolean;
  verifiedPortugueseAudio: boolean;
}

export interface ChannelView {
  channel: Channel;
  streams: StreamView[];
  best: StreamView | null;
  alternatives: StreamView[];
  bestStatus: HealthStatus;
  eligible: boolean;
  hasEpg: boolean;
  epgProgrammes: number;
  section: string;
}

function viewStream(cfg: Config, s: Stream, store: HealthStore): StreamView {
  const entry = store.streams[s.key];
  const byVantage: StreamView['byVantage'] = {};
  let bestStatus: HealthStatus = 'UNKNOWN';
  let bestVantage: string | null = null;
  let media: MediaInfo | null = null;
  let consecutiveFailures = 0;
  let lastSuccessAt: string | null = null;
  let eligible = false;

  for (const [vantage, v] of Object.entries(entry?.vantages ?? {})) {
    const vh = v as VantageHealth;
    const eff = effectiveStatus(cfg, vh);
    byVantage[vantage] = {
      status: eff,
      checkedAt: vh.checkedAt,
      http: vh.http,
      reason: vh.reason,
    };
    if (STATUS_RANK[eff] < STATUS_RANK[bestStatus]) {
      bestStatus = eff;
      bestVantage = vantage;
    }
    if (vh.media) media ??= vh.media;
    if (vh.lastSuccessAt && (!lastSuccessAt || vh.lastSuccessAt > lastSuccessAt)) {
      lastSuccessAt = vh.lastSuccessAt;
    }
    if (isSuccess(eff) && vh.consecutiveFailures < cfg.validation.dropAfterFailures) {
      eligible = true;
    }
    consecutiveFailures = Math.max(consecutiveFailures, vh.consecutiveFailures);
  }

  return {
    stream: s,
    byVantage,
    bestStatus,
    bestVantage,
    media,
    consecutiveFailures,
    lastSuccessAt,
    eligible,
    verifiedPortugueseAudio: Boolean(media?.audioLanguages.some(isPortuguese)),
  };
}

function heightOf(v: StreamView): number {
  return v.media?.height ?? 0;
}

function compareStreams(a: StreamView, b: StreamView): number {
  const r = STATUS_RANK[a.bestStatus] - STATUS_RANK[b.bestStatus];
  if (r !== 0) return r;
  // Audio PT-BR comprovado vem antes. Metadado declarado nao conta aqui.
  if (a.verifiedPortugueseAudio !== b.verifiedPortugueseAudio) {
    return a.verifiedPortugueseAudio ? -1 : 1;
  }
  const h = heightOf(b) - heightOf(a);
  if (h !== 0) return h;
  return a.consecutiveFailures - b.consecutiveFailures;
}

export function buildViews(
  cfg: Config,
  tax: Taxonomy,
  channels: Channel[],
  store: HealthStore,
  epgIndex: Map<string, number>,
): ChannelView[] {
  const labelOfGroup = new Map(tax.countryGroups.map((g) => [g.code, g]));
  const labelOfCategory = new Map(tax.categories.map((c) => [c.code, c.label]));

  const views: ChannelView[] = [];
  for (const ch of channels) {
    if (cfg.filters.excludeNsfw && ch.isNsfw) continue;
    if (cfg.filters.excludeClosedChannels && ch.closed) continue;

    const streams = ch.streams.map((s) => viewStream(cfg, s, store)).sort(compareStreams);
    const best = streams[0] ?? null;
    const group = labelOfGroup.get(ch.countryGroup);
    const country = group ? `${group.flag} ${group.label}` : ch.countryGroup;
    const category = labelOfCategory.get(ch.primaryCategory) ?? ch.primaryCategory;
    const programmes = ch.tvgId ? epgIndex.get(ch.tvgId) ?? 0 : 0;

    views.push({
      channel: ch,
      streams,
      best,
      alternatives: streams.slice(1),
      bestStatus: best?.bestStatus ?? 'UNKNOWN',
      eligible: streams.some((s) => s.eligible),
      hasEpg: programmes > 0,
      epgProgrammes: programmes,
      section: `${country}${tax.sectionSeparator}${category}`,
    });
  }
  return views;
}

/** Ordena para a playlist unica: pais, categoria, idioma prioritario, nome. */
export function sortForPlaylist(tax: Taxonomy, views: ChannelView[]): ChannelView[] {
  const countryIdx = new Map(tax.countryOrder.map((c, i) => [c, i]));
  const catIdx = new Map(tax.categoryOrder.map((c, i) => [c, i]));
  const langIdx = new Map(tax.languagePriority.map((l, i) => [l, i]));
  const big = 9999;

  return [...views].sort((a, b) => {
    const ca = countryIdx.get(a.channel.countryGroup) ?? big;
    const cb = countryIdx.get(b.channel.countryGroup) ?? big;
    if (ca !== cb) return ca - cb;
    const ka = catIdx.get(a.channel.primaryCategory) ?? big;
    const kb = catIdx.get(b.channel.primaryCategory) ?? big;
    if (ka !== kb) return ka - kb;
    const la = Math.min(...a.channel.declaredLanguages.map((l) => langIdx.get(l) ?? big), big);
    const lb = Math.min(...b.channel.declaredLanguages.map((l) => langIdx.get(l) ?? big), big);
    if (la !== lb) return la - lb;
    return a.channel.name.localeCompare(b.channel.name, 'pt-BR');
  });
}

function entryFor(
  v: ChannelView,
  sv: StreamView,
  opts: { includeHealth: boolean },
): M3uEntry {
  const ch = v.channel;
  const attrs: Record<string, string> = {};
  if (ch.tvgId) attrs['tvg-id'] = ch.tvgId;
  attrs['tvg-name'] = ch.name;
  if (ch.logo) attrs['tvg-logo'] = ch.logo;
  if (ch.declaredLanguages.length) attrs['tvg-language'] = ch.declaredLanguages.join(';');
  if (ch.countryCode) attrs['tvg-country'] = ch.countryCode;
  attrs['group-title'] = v.section;
  if (opts.includeHealth) {
    attrs['x-health'] = sv.bestStatus;
    if (sv.bestVantage) attrs['x-health-vantage'] = sv.bestVantage;
  }

  // #EXTGRP ajuda clientes antigos do Kodi; group-title cobre TiviMate/Smarters/VLC.
  const directives = [`#EXTGRP:${v.section}`];
  const existing = sv.stream.m3uDirectives;
  for (const d of existing) if (!d.startsWith('#EXTGRP')) directives.push(d);
  const hasUa = existing.some((d) => d.toLowerCase().includes('http-user-agent'));
  const hasRef = existing.some((d) => d.toLowerCase().includes('http-referrer'));
  if (sv.stream.userAgent && !hasUa) {
    directives.push(`#EXTVLCOPT:http-user-agent=${sv.stream.userAgent}`);
  }
  if (sv.stream.referrer && !hasRef) {
    directives.push(`#EXTVLCOPT:http-referrer=${sv.stream.referrer}`);
  }

  return { attrs, name: ch.name, duration: '-1', directives, url: sv.stream.url };
}

export interface PlaylistSpec {
  file: string;
  title: string;
  /** undefined: usa o melhor stream elegivel. 'all': todo stream, inclusive sem verificacao. */
  mode: 'validated' | 'all';
  filter?: (v: ChannelView) => boolean;
}

export function playlistSpecs(cfg: Config): PlaylistSpec[] {
  return [
    { file: cfg.output.mainPlaylist, title: 'Main (all sections, validated)', mode: 'validated' },
    {
      file: 'playlist-br.m3u',
      title: 'Brazil',
      mode: 'validated',
      filter: (v) => v.channel.countryGroup === 'BR',
    },
    {
      file: 'playlist-pt.m3u',
      title: 'Portuguese (PT + Portuguese-speaking)',
      mode: 'validated',
      filter: (v) =>
        v.channel.countryGroup === 'PT' || v.channel.declaredLanguages.includes('por'),
    },
    {
      file: 'playlist-movies.m3u',
      title: 'Movies',
      mode: 'validated',
      filter: (v) => v.channel.categoryCodes.includes('movies'),
    },
    {
      file: 'playlist-series.m3u',
      title: 'Series (TV shows)',
      mode: 'validated',
      filter: (v) => v.channel.categoryCodes.includes('series'),
    },
    {
      file: 'playlist-sports.m3u',
      title: 'Sports',
      mode: 'validated',
      filter: (v) => v.channel.categoryCodes.includes('sports'),
    },
    {
      file: 'playlist-international.m3u',
      title: 'International (everything outside Brazil)',
      mode: 'validated',
      filter: (v) => v.channel.countryGroup !== 'BR',
    },
    { file: 'playlist-all.m3u', title: 'Everything, including unverified and unavailable', mode: 'all' },
  ];
}

export interface WrittenPlaylist {
  file: string;
  title: string;
  channels: number;
  entries: number;
  sections: number;
}

export function writePlaylists(
  cfg: Config,
  tax: Taxonomy,
  views: ChannelView[],
  includeUnclassifiedInMain: boolean,
): WrittenPlaylist[] {
  const epgUrl = rawUrl(cfg, cfg.output.epgFile);
  const sorted = sortForPlaylist(tax, views);
  const written: WrittenPlaylist[] = [];

  for (const spec of playlistSpecs(cfg)) {
    const isAll = spec.mode === 'all';
    let pick = sorted;
    if (!isAll) {
      pick = pick.filter((v) => v.eligible);
      if (!includeUnclassifiedInMain) pick = pick.filter((v) => v.channel.classified);
    }
    if (spec.filter) pick = pick.filter(spec.filter);

    const entries: M3uEntry[] = [];
    for (const v of pick) {
      if (isAll) {
        for (const sv of v.streams) entries.push(entryFor(v, sv, { includeHealth: true }));
      } else {
        const chosen = v.streams.find((s) => s.eligible);
        if (chosen) entries.push(entryFor(v, chosen, { includeHealth: false }));
      }
    }

    const doc: M3uDocument = {
      // url-tvg e o nome que TiviMate/Smarters leem; x-tvg-url cobre os outros.
      header: { 'url-tvg': epgUrl, 'x-tvg-url': epgUrl },
      entries,
    };
    const p = outPath(cfg, spec.file);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, serializeM3u(doc));
    const sections = new Set(entries.map((e) => e.attrs['group-title'])).size;
    written.push({
      file: spec.file,
      title: spec.title,
      channels: pick.length,
      entries: entries.length,
      sections,
    });
    info(`${spec.file}: ${entries.length} entradas, ${pick.length} canais, ${sections} secoes`);
  }
  return written;
}

/**
 * Recorte compacto para o painel. O metadados completo passa de dezenas de MB e
 * nao cabe numa pagina; aqui vao so os campos que o painel filtra.
 */
export function writeDashboardData(
  cfg: Config,
  tax: Taxonomy,
  views: ChannelView[],
  summary: unknown,
): number {
  const p = outPath(cfg, 'docs/dashboard-data.json');
  mkdirSync(dirname(p), { recursive: true });
  const groupLabel = new Map(tax.countryGroups.map((g) => [g.code, `${g.flag} ${g.label}`]));
  const catLabel = new Map(tax.categories.map((c) => [c.code, c.label]));
  const rows = sortForPlaylist(tax, views)
    .filter((v) => v.eligible && v.channel.classified)
    .map((v) => ({
      n: v.channel.name,
      g: groupLabel.get(v.channel.countryGroup) ?? v.channel.countryGroup,
      gc: v.channel.countryGroup,
      c: catLabel.get(v.channel.primaryCategory) ?? v.channel.primaryCategory,
      s: v.bestStatus,
      e: v.epgProgrammes,
      r: v.best?.media?.resolution ?? null,
      pt: v.streams.some((x) => x.verifiedPortugueseAudio),
      alt: v.streams.length - 1,
      logo: v.channel.logo,
    }));
  writeFileSync(
    p,
    JSON.stringify({ generatedAt: new Date().toISOString(), summary, channels: rows }) + '\n',
  );
  return rows.length;
}

/** Metadados completos por canal, com as URLs alternativas e a evidencia da validacao. */
export function writeMetadata(cfg: Config, views: ChannelView[]): number {
  const p = outPath(cfg, cfg.output.metadataFile);
  mkdirSync(dirname(p), { recursive: true });
  const payload = {
    generatedAt: new Date().toISOString(),
    vantagesSeen: [...new Set(views.flatMap((v) => v.streams.flatMap((s) => Object.keys(s.byVantage))))],
    channels: views
      .map((v) => ({
        id: v.channel.id,
        tvgId: v.channel.tvgId,
        name: v.channel.name,
        classified: v.channel.classified,
        country: v.channel.countryCode,
        countryGroup: v.channel.countryGroup,
        countryGroupReason: v.channel.countryGroupReason,
        section: v.section,
        primaryCategory: v.channel.primaryCategory,
        categories: v.channel.categoryCodes,
        sourceCategories: v.channel.sourceCategories,
        declaredLanguages: v.channel.declaredLanguages,
        timezones: v.channel.timezones,
        logo: v.channel.logo,
        website: v.channel.website,
        declaredFormat: v.channel.format,
        epg: { hasGuide: v.hasEpg, programmes: v.epgProgrammes, sites: v.channel.guideSites },
        health: v.bestStatus,
        eligible: v.eligible,
        streams: v.streams.map((s, i) => ({
          key: s.stream.key,
          url: s.stream.url,
          role: i === 0 ? 'primary' : 'alternative',
          sources: s.stream.sources,
          declaredQuality: s.stream.quality,
          userAgent: s.stream.userAgent,
          referrer: s.stream.referrer,
          health: s.bestStatus,
          byVantage: s.byVantage,
          lastSuccessAt: s.lastSuccessAt,
          consecutiveFailures: s.consecutiveFailures,
          media: s.media,
          verifiedPortugueseAudio: s.verifiedPortugueseAudio,
        })),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
  writeFileSync(p, JSON.stringify(payload, null, 1) + '\n');
  return payload.channels.length;
}
