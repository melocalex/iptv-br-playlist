import { createHash } from 'node:crypto';
import { fetchJson, fetchText } from './http.ts';
import { parseM3u } from './m3u.ts';
import type { Config, Sources, Taxonomy } from './config.ts';
import { info, warn } from './log.ts';

export interface ApiChannel {
  id: string;
  name: string;
  alt_names: string[];
  network: string | null;
  owners: string[];
  country: string | null;
  categories: string[];
  is_nsfw: boolean;
  launched: string | null;
  closed: string | null;
  replaced_by: string | null;
  website: string | null;
}

export interface ApiFeed {
  channel: string;
  id: string;
  name: string;
  is_main: boolean;
  broadcast_area: string[];
  timezones: string[];
  languages: string[];
  format: string | null;
}

export interface ApiStream {
  channel: string | null;
  feed: string | null;
  title: string | null;
  url: string;
  quality: string | null;
  labels: string[];
  user_agent: string | null;
  referrer: string | null;
}

export interface ApiGuide {
  channel: string;
  feed: string | null;
  site: string;
  site_id: string;
  site_name: string;
  lang: string;
}

export interface Stream {
  key: string;
  url: string;
  channelId: string | null;
  feedId: string | null;
  tvgId: string | null;
  quality: string | null;
  userAgent: string | null;
  referrer: string | null;
  sources: string[];
  m3uAttrs: Record<string, string>;
  m3uDirectives: string[];
}

export interface Channel {
  id: string;
  tvgId: string | null;
  name: string;
  classified: boolean;
  countryCode: string | null;
  countryGroup: string;
  countryGroupReason: string;
  sourceCategories: string[];
  categoryCodes: string[];
  primaryCategory: string;
  declaredLanguages: string[];
  timezones: string[];
  logo: string | null;
  website: string | null;
  format: string | null;
  isNsfw: boolean;
  closed: string | null;
  guideSites: string[];
  streams: Stream[];
}

export interface Catalog {
  channels: Channel[];
  /** Fontes efetivamente baixadas e fontes puladas por redundancia. */
  sourceReport: {
    fetched: { id: string; url: string; entries: number }[];
    skippedRedundant: { id: string; url: string; coveredBy: string; verified: boolean; missing: number }[];
    failed: { id: string; url: string; reason: string }[];
  };
  counts: { apiStreams: number; m3uEntries: number; uniqueUrls: number; duplicateUrls: number };
}

function streamKey(url: string): string {
  return createHash('sha1').update(url).digest('hex').slice(0, 16);
}

function tvgIdOf(channel: string | null, feed: string | null): string | null {
  if (!channel) return null;
  return feed ? `${channel}@${feed}` : channel;
}

/** Resolve o grupo de pais. Area de transmissao do feed tem precedencia sobre o pais de
 *  origem do canal, porque um feed dedicado (ex.: '...@Brazil' com broadcast_area c/BR)
 *  e o que de fato chega ao espectador. Toda a tabela vem de config/taxonomy.json. */
function resolveCountryGroup(
  tax: Taxonomy,
  cfg: Config,
  channel: ApiChannel | undefined,
  feed: ApiFeed | undefined,
): { group: string; reason: string; countryCode: string | null } {
  const byCountry = new Map<string, string>();
  for (const g of tax.countryGroups) for (const cc of g.countries) byCountry.set(cc, g.code);

  const areas = feed?.broadcast_area ?? [];
  const countries = areas.filter((a) => a.startsWith('c/')).map((a) => a.slice(2));
  const uniqueCountries = [...new Set(countries)];

  if (uniqueCountries.length === 1) {
    const cc = uniqueCountries[0]!;
    const g = byCountry.get(cc);
    if (g) return { group: g, reason: `feed.broadcast_area=c/${cc}`, countryCode: cc };
  }
  if (areas.some((a) => cfg.classification.internationalAreas.includes(a))) {
    return { group: 'INT', reason: `feed.broadcast_area=${areas.join(',')}`, countryCode: null };
  }
  if (uniqueCountries.length >= cfg.classification.internationalMinCountries) {
    return {
      group: 'INT',
      reason: `feed.broadcast_area cobre ${uniqueCountries.length} paises`,
      countryCode: null,
    };
  }
  if (uniqueCountries.length >= 1) {
    const cc = uniqueCountries[0]!;
    const g = byCountry.get(cc);
    if (g) return { group: g, reason: `feed.broadcast_area=c/${cc}`, countryCode: cc };
  }
  if (channel?.country) {
    const g = byCountry.get(channel.country);
    if (g) return { group: g, reason: `channel.country=${channel.country}`, countryCode: channel.country };
    return { group: 'OTHER', reason: `channel.country=${channel.country}`, countryCode: channel.country };
  }
  return { group: 'OTHER', reason: 'sem pais na fonte', countryCode: null };
}

function resolveCategories(
  tax: Taxonomy,
  sourceCategories: string[],
): { codes: string[]; primary: string } {
  const codes = new Set<string>();
  for (const def of tax.categories) {
    if (def.from.some((f) => sourceCategories.includes(f))) codes.add(def.code);
  }
  const ordered = tax.categoryOrder.filter((c) => codes.has(c));
  const primary = ordered[0] ?? tax.fallbackCategory;
  return { codes: ordered.length ? ordered : [primary], primary };
}

export async function buildCatalog(
  cfg: Config,
  sources: Sources,
  tax: Taxonomy,
  opts: { force?: boolean; verifyRedundancy?: boolean } = {},
): Promise<Catalog> {
  const base = sources.api.baseUrl;
  const f = sources.api.files;
  const url = (name: string) => `${base}/${f[name]}`;

  info('baixando metadados da API iptv-org');
  const [channels, feeds, streams, guides] = await Promise.all([
    fetchJson<ApiChannel[]>(cfg, url('channels'), opts.force),
    fetchJson<ApiFeed[]>(cfg, url('feeds'), opts.force),
    fetchJson<ApiStream[]>(cfg, url('streams'), opts.force),
    fetchJson<ApiGuide[]>(cfg, url('guides'), opts.force),
  ]);
  info(
    `API: ${channels.length} canais, ${feeds.length} feeds, ${streams.length} streams, ${guides.length} linhas de guia`,
  );

  const channelById = new Map(channels.map((c) => [c.id, c]));
  const feedByKey = new Map(feeds.map((x) => [`${x.channel}@${x.id}`, x]));
  const mainFeedByChannel = new Map<string, ApiFeed>();
  for (const x of feeds) if (x.is_main) mainFeedByChannel.set(x.channel, x);

  const guideSitesByTvgId = new Map<string, Set<string>>();
  for (const g of guides) {
    const id = tvgIdOf(g.channel, g.feed);
    if (!id) continue;
    let set = guideSitesByTvgId.get(id);
    if (!set) {
      set = new Set();
      guideSitesByTvgId.set(id, set);
    }
    set.add(g.site);
  }

  // --- streams por URL unica -------------------------------------------------
  const byUrl = new Map<string, Stream>();
  let duplicateUrls = 0;

  const addStream = (s: Partial<Stream> & { url: string; sourceId: string }): void => {
    const existing = byUrl.get(s.url);
    if (existing) {
      duplicateUrls++;
      if (!existing.sources.includes(s.sourceId)) existing.sources.push(s.sourceId);
      existing.channelId ??= s.channelId ?? null;
      existing.feedId ??= s.feedId ?? null;
      existing.tvgId ??= s.tvgId ?? null;
      existing.quality ??= s.quality ?? null;
      existing.userAgent ??= s.userAgent ?? null;
      existing.referrer ??= s.referrer ?? null;
      if (s.m3uAttrs) existing.m3uAttrs = { ...s.m3uAttrs, ...existing.m3uAttrs };
      if (s.m3uDirectives?.length && !existing.m3uDirectives.length) {
        existing.m3uDirectives = s.m3uDirectives;
      }
      return;
    }
    byUrl.set(s.url, {
      key: streamKey(s.url),
      url: s.url,
      channelId: s.channelId ?? null,
      feedId: s.feedId ?? null,
      tvgId: s.tvgId ?? null,
      quality: s.quality ?? null,
      userAgent: s.userAgent ?? null,
      referrer: s.referrer ?? null,
      sources: [s.sourceId],
      m3uAttrs: s.m3uAttrs ?? {},
      m3uDirectives: s.m3uDirectives ?? [],
    });
  };

  for (const s of streams) {
    addStream({
      url: s.url,
      channelId: s.channel,
      feedId: s.feed,
      tvgId: tvgIdOf(s.channel, s.feed),
      quality: s.quality,
      userAgent: s.user_agent,
      referrer: s.referrer,
      sourceId: 'iptv-org-api:streams',
    });
  }
  const apiStreamCount = byUrl.size;

  // --- fontes M3U -----------------------------------------------------------
  const report: Catalog['sourceReport'] = { fetched: [], skippedRedundant: [], failed: [] };
  const enabled = sources.playlists.filter((p) => p.enabled);
  const masters = enabled.filter((p) => p.master);
  const masterUrlSets = new Map<string, Set<string>>();
  let m3uEntries = 0;

  for (const src of [...masters, ...enabled.filter((p) => !p.master)]) {
    const redundant = Boolean(src.coveredBy) && masters.some((m) => m.id === src.coveredBy);
    // Fonte redundante so e baixada quando pedimos prova da redundancia.
    if (redundant && !opts.verifyRedundancy) {
      report.skippedRedundant.push({
        id: src.id,
        url: src.url,
        coveredBy: src.coveredBy!,
        verified: false,
        missing: -1,
      });
      continue;
    }
    let text: string;
    try {
      text = await fetchText(cfg, src.url, opts.force);
    } catch (err) {
      warn(`fonte ${src.id} falhou: ${(err as Error).message}`);
      report.failed.push({ id: src.id, url: src.url, reason: (err as Error).message });
      continue;
    }
    const doc = parseM3u(text);
    m3uEntries += doc.entries.length;

    if (redundant) {
      const masterSet = masterUrlSets.get(src.coveredBy!) ?? new Set<string>();
      const missing = doc.entries.filter((e) => !masterSet.has(e.url)).length;
      report.skippedRedundant.push({
        id: src.id,
        url: src.url,
        coveredBy: src.coveredBy!,
        verified: true,
        missing,
      });
      if (missing === 0) continue;
      warn(`fonte ${src.id}: ${missing} entradas ausentes da master ${src.coveredBy}`);
    } else {
      report.fetched.push({ id: src.id, url: src.url, entries: doc.entries.length });
      if (src.master) masterUrlSets.set(src.id, new Set(doc.entries.map((e) => e.url)));
    }

    for (const e of doc.entries) {
      const tvgId = e.attrs['tvg-id'] || null;
      const [chan, feed] = tvgId ? splitTvgId(tvgId) : [null, null];
      addStream({
        url: e.url,
        channelId: chan,
        feedId: feed,
        tvgId,
        sourceId: src.id,
        m3uAttrs: e.attrs,
        m3uDirectives: e.directives,
      });
    }
  }

  // --- agrupa streams em canais --------------------------------------------
  const byChannel = new Map<string, Stream[]>();
  for (const s of byUrl.values()) {
    const id = s.channelId ?? `unclassified:${s.key}`;
    const list = byChannel.get(id);
    if (list) list.push(s);
    else byChannel.set(id, [s]);
  }

  const out: Channel[] = [];
  for (const [id, chStreams] of byChannel) {
    const api = channelById.get(id);
    const classified = Boolean(api);
    const feedId = chStreams.find((s) => s.feedId)?.feedId ?? null;
    const feed =
      (feedId ? feedByKey.get(`${id}@${feedId}`) : undefined) ?? mainFeedByChannel.get(id);

    const sourceCategories = (api?.categories ?? []).filter(
      (c) => !tax.excludeSourceCategories.includes(c),
    );
    const excludedBySource = (api?.categories ?? []).some((c) =>
      tax.excludeSourceCategories.includes(c),
    );
    const { codes, primary } = resolveCategories(tax, sourceCategories);
    const geo = resolveCountryGroup(tax, cfg, api, feed);
    const tvgId = chStreams.find((s) => s.tvgId)?.tvgId ?? null;

    const logoFrom = chStreams.find((s) => s.m3uAttrs['tvg-logo'])?.m3uAttrs['tvg-logo'] ?? null;
    const nameFromM3u = chStreams
      .map((s) => s.m3uAttrs['tvg-name'])
      .find((n): n is string => Boolean(n));

    out.push({
      id,
      tvgId,
      // Nome original preservado: API primeiro, depois tvg-name da M3U, nunca inventado.
      name: api?.name ?? nameFromM3u ?? chStreams[0]?.m3uAttrs['tvg-name'] ?? id,
      classified,
      countryCode: geo.countryCode,
      countryGroup: geo.group,
      countryGroupReason: geo.reason,
      sourceCategories,
      categoryCodes: codes,
      primaryCategory: primary,
      declaredLanguages: feed?.languages ?? [],
      timezones: feed?.timezones ?? [],
      logo: logoFrom,
      website: api?.website ?? null,
      format: feed?.format ?? null,
      isNsfw: Boolean(api?.is_nsfw) || excludedBySource,
      closed: api?.closed ?? null,
      guideSites: [...(tvgId ? guideSitesByTvgId.get(tvgId) ?? [] : [])],
      streams: chStreams,
    });
  }

  return {
    channels: out,
    sourceReport: report,
    counts: {
      apiStreams: apiStreamCount,
      m3uEntries,
      uniqueUrls: byUrl.size,
      duplicateUrls,
    },
  };
}

export function splitTvgId(tvgId: string): [string, string | null] {
  const at = tvgId.indexOf('@');
  if (at === -1) return [tvgId, null];
  return [tvgId.slice(0, at), tvgId.slice(at + 1)];
}
