import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ALL_STATUSES, outPath, rawUrl, type Config, type HealthStatus, type Taxonomy } from './config.ts';
import type { ChannelView, WrittenPlaylist } from './build.ts';
import { playlistSpecs } from './build.ts';
import type { EpgResult } from './epg.ts';
import type { Catalog } from './catalog.ts';
import type { ValidationRunReport } from './validate.ts';
import { info } from './log.ts';

export interface StatusPayload {
  generatedAt: string;
  repo: { owner: string; name: string; branch: string };
  urls: Record<string, string>;
  discovery: {
    channelsDiscovered: number;
    streamsDiscovered: number;
    duplicateStreamUrlsCollapsed: number;
    unclassifiedChannels: number;
    sourcesFetched: Catalog['sourceReport']['fetched'];
    sourcesSkippedRedundant: Catalog['sourceReport']['skippedRedundant'];
    sourcesFailed: Catalog['sourceReport']['failed'];
  };
  validation: {
    lastRunByVantage: Record<string, { finishedAt: string; checked: number; eligible: number; skippedFresh: number }>;
    channelsByStatus: Record<string, number>;
    streamsByStatus: Record<string, number>;
    /**
     * Resultado por ponto de observacao. Runner do GitHub fica nos EUA e ve
     * disponibilidade diferente de quem esta no Brasil: os numeros NAO sao somaveis.
     */
    streamsByVantageAndStatus: Record<string, Record<string, number>>;
    channelsNeverChecked: number;
  };
  catalog: {
    validatedWorkingChannels: number;
    brazilianChannels: number;
    internationalChannels: number;
    byCountryGroup: Record<string, number>;
    byCategory: Record<string, number>;
    withEpgCoverage: number;
    withVerifiedPortugueseAudio: number;
    withVerifiedSubtitles: number;
    withSubtitleDetectionUnreliable: number;
    offlineChannels: number;
    unstableChannels: number;
    channelsWithAlternativeStreams: number;
  };
  epg: {
    channelsRequested: number;
    channelsWithGuide: number;
    coveragePercent: number;
    programmes: number;
    horizonHours: number;
    sources: EpgResult['sources'];
    dropped: EpgResult['dropped'];
    missingChannelsCount: number;
  };
  playlists: WrittenPlaylist[];
  limitations: string[];
}

function countBy<T>(items: T[], key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) {
    const k = key(i);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

export function buildStatus(
  cfg: Config,
  tax: Taxonomy,
  catalog: Catalog,
  views: ChannelView[],
  epg: EpgResult,
  runs: ValidationRunReport[],
  written: WrittenPlaylist[],
  limitations: string[],
): StatusPayload {
  const eligible = views.filter((v) => v.eligible);
  const catLabel = new Map(tax.categories.map((c) => [c.code, c.label]));

  const streamsByStatus: Record<string, number> = {};
  const streamsByVantageAndStatus: Record<string, Record<string, number>> = {};
  for (const s of ALL_STATUSES) streamsByStatus[s] = 0;
  for (const v of views) {
    for (const sv of v.streams) {
      streamsByStatus[sv.bestStatus] = (streamsByStatus[sv.bestStatus] ?? 0) + 1;
      for (const [vantage, r] of Object.entries(sv.byVantage)) {
        const row = (streamsByVantageAndStatus[vantage] ??= {});
        row[r.status] = (row[r.status] ?? 0) + 1;
      }
    }
  }

  const lastRunByVantage: StatusPayload['validation']['lastRunByVantage'] = {};
  for (const r of runs) {
    lastRunByVantage[r.vantage] = {
      finishedAt: r.finishedAt,
      checked: r.checked,
      eligible: r.eligible,
      skippedFresh: r.skippedFresh,
    };
  }

  const urls: Record<string, string> = { epg: rawUrl(cfg, cfg.output.epgFile) };
  for (const spec of playlistSpecs(cfg)) urls[spec.file] = rawUrl(cfg, spec.file);
  urls['status.json'] = rawUrl(cfg, cfg.output.statusJson);
  urls['metadata'] = rawUrl(cfg, cfg.output.metadataFile);

  return {
    generatedAt: new Date().toISOString(),
    repo: cfg.repo,
    urls,
    discovery: {
      channelsDiscovered: catalog.channels.length,
      streamsDiscovered: catalog.counts.uniqueUrls,
      duplicateStreamUrlsCollapsed: catalog.counts.duplicateUrls,
      unclassifiedChannels: catalog.channels.filter((c) => !c.classified).length,
      sourcesFetched: catalog.sourceReport.fetched,
      sourcesSkippedRedundant: catalog.sourceReport.skippedRedundant,
      sourcesFailed: catalog.sourceReport.failed,
    },
    validation: {
      lastRunByVantage,
      channelsByStatus: countBy(views, (v) => v.bestStatus),
      streamsByStatus,
      streamsByVantageAndStatus,
      channelsNeverChecked: views.filter((v) => v.streams.every((s) => s.bestStatus === 'UNKNOWN'))
        .length,
    },
    catalog: {
      validatedWorkingChannels: views.filter((v) => v.bestStatus === 'WORKING').length,
      brazilianChannels: eligible.filter((v) => v.channel.countryGroup === 'BR').length,
      internationalChannels: eligible.filter((v) => v.channel.countryGroup !== 'BR').length,
      byCountryGroup: countBy(eligible, (v) => v.channel.countryGroup),
      byCategory: countBy(
        eligible,
        (v) => catLabel.get(v.channel.primaryCategory) ?? v.channel.primaryCategory,
      ),
      withEpgCoverage: eligible.filter((v) => v.hasEpg).length,
      withVerifiedPortugueseAudio: eligible.filter((v) =>
        v.streams.some((s) => s.verifiedPortugueseAudio),
      ).length,
      withVerifiedSubtitles: eligible.filter((v) =>
        v.streams.some((s) => (s.media?.subtitleTracks.length ?? 0) > 0),
      ).length,
      withSubtitleDetectionUnreliable: eligible.filter((v) =>
        v.streams.some((s) => s.media && !s.media.subtitleDetectionReliable),
      ).length,
      offlineChannels: views.filter((v) => v.bestStatus === 'OFFLINE').length,
      unstableChannels: views.filter((v) => v.bestStatus === 'UNSTABLE').length,
      channelsWithAlternativeStreams: views.filter((v) => v.streams.length > 1).length,
    },
    epg: {
      channelsRequested: epg.index.size + epg.missing.length,
      channelsWithGuide: epg.channelsInGuide,
      coveragePercent:
        epg.index.size + epg.missing.length > 0
          ? Number(((epg.channelsInGuide / (epg.index.size + epg.missing.length)) * 100).toFixed(2))
          : 0,
      programmes: epg.programmes,
      horizonHours: epg.horizonHours,
      sources: epg.sources,
      dropped: epg.dropped,
      missingChannelsCount: epg.missing.length,
    },
    playlists: written,
    limitations,
  };
}

function table(rows: (string | number)[][]): string {
  if (rows.length === 0) return '';
  const head = rows[0]!;
  const sep = head.map(() => '---');
  return [head, sep, ...rows.slice(1)].map((r) => `| ${r.join(' | ')} |`).join('\n');
}

export function writeStatus(cfg: Config, s: StatusPayload): void {
  const jsonPath = outPath(cfg, cfg.output.statusJson);
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, JSON.stringify(s, null, 1) + '\n');

  const vantages = Object.keys(s.validation.streamsByVantageAndStatus).sort();
  const md: string[] = [];
  md.push('# Painel de status');
  md.push('');
  md.push(`Gerado em **${s.generatedAt}**.`);
  md.push('');
  md.push('## Descoberta');
  md.push('');
  md.push(
    table([
      ['Metrica', 'Valor'],
      ['Canais descobertos', s.discovery.channelsDiscovered],
      ['Streams descobertos (URLs unicas)', s.discovery.streamsDiscovered],
      ['URLs duplicadas colapsadas', s.discovery.duplicateStreamUrlsCollapsed],
      ['Canais sem metadado na fonte', s.discovery.unclassifiedChannels],
    ]),
  );
  md.push('');
  md.push('## Validacao');
  md.push('');
  md.push(
    'Validacao depende de onde o teste roda. O runner do GitHub Actions fica nos Estados Unidos ' +
      'e ve disponibilidade diferente de uma maquina no Brasil. **Os numeros por ponto de ' +
      'observacao nao sao somaveis.**',
  );
  md.push('');
  if (vantages.length === 0) {
    md.push('_Nenhuma validacao registrada ainda._');
  } else {
    md.push(
      table([
        ['Status', ...vantages],
        ...ALL_STATUSES.map((st) => [
          st,
          ...vantages.map((v) => s.validation.streamsByVantageAndStatus[v]?.[st] ?? 0),
        ]),
      ]),
    );
    md.push('');
    md.push(
      table([
        ['Ponto de observacao', 'Ultima execucao', 'Checados', 'Elegiveis', 'Frescos (pulados)'],
        ...Object.entries(s.validation.lastRunByVantage).map(([v, r]) => [
          v,
          r.finishedAt,
          r.checked,
          r.eligible,
          r.skippedFresh,
        ]),
      ]),
    );
  }
  md.push('');
  md.push('## Canais validados');
  md.push('');
  md.push(
    table([
      ['Metrica', 'Valor'],
      ['Canais funcionando (WORKING)', s.catalog.validatedWorkingChannels],
      ['Canais brasileiros validados', s.catalog.brazilianChannels],
      ['Canais internacionais validados', s.catalog.internationalChannels],
      ['Canais instaveis', s.catalog.unstableChannels],
      ['Canais offline', s.catalog.offlineChannels],
      ['Canais nunca checados', s.validation.channelsNeverChecked],
      ['Canais com stream alternativo guardado', s.catalog.channelsWithAlternativeStreams],
      ['Com cobertura de EPG', s.catalog.withEpgCoverage],
      ['Com audio em portugues **verificado**', s.catalog.withVerifiedPortugueseAudio],
      ['Com legenda **verificada**', s.catalog.withVerifiedSubtitles],
      ['Com deteccao de legenda nao confiavel (HLS)', s.catalog.withSubtitleDetectionUnreliable],
    ]),
  );
  md.push('');
  md.push('### Por grupo de pais');
  md.push('');
  md.push(
    table([
      ['Grupo', 'Canais validados'],
      ...Object.entries(s.catalog.byCountryGroup).sort((a, b) => b[1] - a[1]),
    ]),
  );
  md.push('');
  md.push('### Por categoria');
  md.push('');
  md.push(
    table([
      ['Categoria', 'Canais validados'],
      ...Object.entries(s.catalog.byCategory).sort((a, b) => b[1] - a[1]),
    ]),
  );
  md.push('');
  md.push('## EPG');
  md.push('');
  md.push(
    table([
      ['Metrica', 'Valor'],
      ['Canais pedidos ao EPG', s.epg.channelsRequested],
      ['Canais com grade', s.epg.channelsWithGuide],
      ['Cobertura medida', `${s.epg.coveragePercent}%`],
      ['Programas no guia', s.epg.programmes],
      ['Horizonte', `${s.epg.horizonHours} h`],
      ['Canais sem grade', s.epg.missingChannelsCount],
    ]),
  );
  md.push('');
  md.push(
    'Cobertura de EPG do iptv-org e parcial por natureza. O numero acima e o **medido**, ' +
      'sem arredondamento para cima. A lista completa de canais sem grade esta em ' +
      `\`${cfg.output.epgCoverageFile}\`.`,
  );
  md.push('');
  md.push('### Fontes de EPG');
  md.push('');
  md.push(
    table([
      ['Fonte', 'Tipo', 'OK', 'Canais pedidos', 'Canais com grade', 'Programas', 'Observacao'],
      ...s.epg.sources.map((x) => [
        x.id,
        x.kind,
        x.ok ? 'sim' : 'nao',
        x.requestedChannels < 0 ? 'n/a' : x.requestedChannels,
        x.channelsWithProgrammes,
        x.programmes,
        x.note ?? '-',
      ]),
    ]),
  );
  md.push('');
  md.push('## Playlists');
  md.push('');
  md.push(
    table([
      ['Arquivo', 'Conteudo', 'Canais', 'Entradas', 'Secoes'],
      ...s.playlists.map((p) => [`\`${p.file}\``, p.title, p.channels, p.entries, p.sections]),
    ]),
  );
  md.push('');
  md.push('## Limitacoes conhecidas');
  md.push('');
  for (const l of s.limitations) md.push(`- ${l}`);
  md.push('');

  const mdPath = outPath(cfg, cfg.output.statusMarkdown);
  writeFileSync(mdPath, md.join('\n'));
  info(`${cfg.output.statusJson} e ${cfg.output.statusMarkdown} escritos`);
}
