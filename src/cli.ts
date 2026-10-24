import { spawnSync } from 'node:child_process';
import { load, type Config, type Taxonomy } from './config.ts';
import { buildCatalog, type Catalog, type Channel } from './catalog.ts';
import { fetchJson } from './http.ts';
import { loadHealth, saveHealth } from './health.ts';
import { validateCatalog, type ValidationRunReport } from './validate.ts';
import { buildEpg, writeCoverage, writeIndex, readIndex, type EpgResult } from './epg.ts';
import { buildViews, writePlaylists, writeMetadata, writeDashboardData, type ChannelView } from './build.ts';
import { buildStatus, writeStatus } from './report.ts';
import { info, warn, error } from './log.ts';

interface Args {
  cmd: string;
  force: boolean;
  limit: number | undefined;
  only: string | undefined;
  verifyRedundancy: boolean;
  skipEpg: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    cmd: argv[0] ?? 'all',
    force: false,
    limit: undefined,
    only: undefined,
    verifyRedundancy: false,
    skipEpg: false,
  };
  for (const a of argv.slice(1)) {
    if (a === '--force') out.force = true;
    else if (a === '--verify-redundancy') out.verifyRedundancy = true;
    else if (a === '--skip-epg') out.skipEpg = true;
    else if (a.startsWith('--limit=')) out.limit = Number(a.slice('--limit='.length));
    else if (a.startsWith('--only=')) out.only = a.slice('--only='.length);
    else throw new Error(`argumento desconhecido: ${a}`);
  }
  return out;
}

/** Checagens de inicializacao. Config invalida falha agora, nao no meio da execucao. */
async function bootCheck(cfg: Config, tax: Taxonomy, baseUrl: string, files: Record<string, string>) {
  const problems: string[] = [];

  const v = cfg.validation;
  if (v.concurrency < 1) problems.push('validation.concurrency precisa ser >= 1');
  if (v.probeTimeoutMs < 1000) problems.push('validation.probeTimeoutMs precisa ser >= 1000');
  if (v.connectTimeoutMs < 500) problems.push('validation.connectTimeoutMs precisa ser >= 500');
  if (v.dropAfterFailures < 1) problems.push('validation.dropAfterFailures precisa ser >= 1');
  if (v.historyWindow < 2) problems.push('validation.historyWindow precisa ser >= 2');
  if (!cfg.vantage.trim()) problems.push('vantage nao pode ser vazio');
  if (!cfg.repo.owner.trim() || !cfg.repo.name.trim()) {
    problems.push('repo.owner e repo.name precisam estar preenchidos (entram no url-tvg)');
  }

  const ff = spawnSync(v.ffprobePath, ['-version'], { encoding: 'utf8' });
  if (ff.status !== 0) {
    problems.push(
      `ffprobe nao executou em '${v.ffprobePath}' (${ff.error?.message ?? ff.status}). ` +
        'Instale o ffmpeg ou ajuste IPTV_VALIDATION_FFPROBEPATH.',
    );
  } else {
    info(`ffprobe ok: ${ff.stdout.split('\n')[0]}`);
  }

  // A taxonomia precisa casar com os codigos reais da fonte, senao um grupo inteiro
  // silenciosamente fica vazio (foi o que aconteceu com GB no lugar de UK).
  try {
    const [countries, categories] = await Promise.all([
      fetchJson<{ code: string }[]>(cfg, `${baseUrl}/${files['countries']}`),
      fetchJson<{ id: string }[]>(cfg, `${baseUrl}/${files['categories']}`),
    ]);
    const validCountries = new Set(countries.map((c) => c.code));
    const validCategories = new Set(categories.map((c) => c.id));

    for (const g of tax.countryGroups) {
      for (const code of g.countries) {
        if (!validCountries.has(code)) {
          problems.push(`taxonomy: pais '${code}' do grupo ${g.code} nao existe em countries.json`);
        }
      }
    }
    const mapped = new Set<string>();
    for (const d of tax.categories) {
      for (const f of d.from) {
        if (!validCategories.has(f)) {
          problems.push(`taxonomy: categoria de origem '${f}' (${d.code}) nao existe em categories.json`);
        }
        mapped.add(f);
      }
    }
    for (const x of tax.excludeSourceCategories) {
      if (!validCategories.has(x)) problems.push(`taxonomy: excludeSourceCategories '${x}' nao existe`);
      mapped.add(x);
    }
    const unmapped = [...validCategories].filter((c) => !mapped.has(c));
    if (unmapped.length) {
      // Nao e erro fatal, mas cairia no fallback sem ninguem perceber.
      warn(`categorias da fonte sem mapeamento explicito (vao para '${tax.fallbackCategory}'): ${unmapped.join(', ')}`);
    }
    const groupCodes = new Set(tax.countryGroups.map((g) => g.code));
    for (const c of tax.countryOrder) {
      if (!groupCodes.has(c)) problems.push(`countryOrder cita grupo inexistente '${c}'`);
    }
    for (const g of groupCodes) {
      if (!tax.countryOrder.includes(g)) problems.push(`grupo '${g}' ficou fora de countryOrder`);
    }
    const catCodes = new Set(tax.categories.map((c) => c.code));
    for (const c of tax.categoryOrder) {
      if (!catCodes.has(c)) problems.push(`categoryOrder cita categoria inexistente '${c}'`);
    }
    for (const c of catCodes) {
      if (!tax.categoryOrder.includes(c)) problems.push(`categoria '${c}' ficou fora de categoryOrder`);
    }
    if (!catCodes.has(tax.fallbackCategory)) {
      problems.push(`fallbackCategory '${tax.fallbackCategory}' nao existe em categories`);
    }
  } catch (err) {
    warn(`boot check nao conseguiu validar a taxonomia contra a fonte: ${(err as Error).message}`);
  }

  if (problems.length) {
    for (const p of problems) error(p);
    throw new Error(`${problems.length} problema(s) de configuracao; nada foi gerado`);
  }
  info('boot check ok');
}

function onlyFilter(only: string | undefined): ((c: Channel) => boolean) | undefined {
  if (!only) return undefined;
  const groups = new Set(only.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean));
  return (c) => groups.has(c.countryGroup);
}

/** Limitacoes derivadas do que foi medido nesta execucao, nunca texto fixo. */
function limitations(
  cfg: Config,
  catalog: Catalog,
  views: ChannelView[],
  epg: EpgResult,
  runs: ValidationRunReport[],
): string[] {
  const out: string[] = [];
  const vantages = [...new Set(views.flatMap((v) => v.streams.flatMap((s) => Object.keys(s.byVantage))))];
  const never = views.filter((v) => v.streams.every((s) => s.bestStatus === 'UNKNOWN')).length;

  if (vantages.length === 1) {
    out.push(
      `Validacao feita de um unico ponto de observacao (\`${vantages[0]}\`). Um canal marcado ` +
        'como indisponivel aqui pode funcionar de outro pais, e o contrario tambem. ' +
        'Rode com `IPTV_VANTAGE` diferente para comparar.',
    );
  } else if (vantages.length > 1) {
    out.push(
      `Resultados de ${vantages.length} pontos de observacao (${vantages.join(', ')}) sao ` +
        'reportados separadamente e **nao somam**: o mesmo stream pode estar WORKING em um e ' +
        'GEO_BLOCKED em outro.',
    );
  }
  if (never > 0) {
    out.push(
      `${never} canais ainda nunca foram checados. O limite por execucao e ` +
        `\`validation.maxChecksPerRun\` = ${cfg.validation.maxChecksPerRun}; a cobertura cresce a cada rodada.`,
    );
  }
  out.push(
    `Cobertura de EPG medida: ${epg.channelsInGuide} de ${epg.channelsInGuide + epg.missing.length} ` +
      `canais da playlist principal (${epg.missing.length} sem grade). Numero medido, sem arredondar para cima.`,
  );
  const failedEpg = epg.sources.filter((s) => !s.ok);
  if (failedEpg.length) {
    out.push(
      `Fontes de EPG que nao renderam nesta execucao: ${failedEpg
        .map((s) => `${s.id} (${s.note ?? 'sem motivo registrado'})`)
        .join('; ')}.`,
    );
  }
  const unreliableSubs = views.filter((v) =>
    v.streams.some((s) => s.media && !s.media.subtitleDetectionReliable),
  ).length;
  if (unreliableSubs > 0) {
    out.push(
      `Em ${unreliableSubs} canais o stream e HLS. O ffprobe nao abre a playlist de variante de ` +
        'legenda, logo **ausencia de faixa de legenda nao prova ausencia de legenda** nesses canais.',
    );
  }
  out.push(
    'Nenhuma playlist faz failover automatico. Streams alternativos ficam guardados em ' +
      `\`${cfg.output.metadataFile}\`, mas trocar de stream depende do player: o projeto nao ` +
      'implementa nem testou failover, e por isso nao alega que exista.',
  );
  out.push(
    'Nada aqui contorna DRM, autenticacao, paywall ou geobloqueio. `GEO_BLOCKED` e apenas um ' +
      'rotulo de diagnostico, baseado em HTTP 451 ou em texto explicito da resposta.',
  );
  if (catalog.sourceReport.failed.length) {
    out.push(
      `Fontes que falharam no download: ${catalog.sourceReport.failed
        .map((f) => `${f.id} (${f.reason})`)
        .join('; ')}.`,
    );
  }
  const unclassified = catalog.channels.filter((c) => !c.classified).length;
  if (unclassified > 0) {
    out.push(
      `${unclassified} streams nao tem metadado de canal na fonte. Ficam fora das playlists ` +
        'validadas e aparecem apenas em `playlist-all.m3u`, porque classificar pelo nome do ' +
        'canal seria adivinhacao.',
    );
  }
  const checked = runs.reduce((n, r) => n + r.checked, 0);
  if (runs.length && checked < runs.reduce((n, r) => n + r.eligible, 0)) {
    out.push(
      `Nesta execucao foram checados ${checked} streams de ${runs.reduce((n, r) => n + r.eligible, 0)} ` +
        'elegiveis. O resto mantem o status da rodada anterior.',
    );
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { config: cfg, taxonomy, sources, epg: epgCfg, envApplied } = load();
  if (envApplied.length) info(`config sobrescrita por env: ${envApplied.join(', ')}`);
  info(`comando: ${args.cmd} | vantage: ${cfg.vantage} | repo: ${cfg.repo.owner}/${cfg.repo.name}`);

  await bootCheck(cfg, taxonomy, sources.api.baseUrl, sources.api.files);
  if (args.cmd === 'check') return;

  const catalog = await buildCatalog(cfg, sources, taxonomy, {
    force: args.force,
    verifyRedundancy: args.verifyRedundancy,
  });
  info(
    `catalogo: ${catalog.channels.length} canais, ${catalog.counts.uniqueUrls} streams unicos, ` +
      `${catalog.counts.duplicateUrls} URLs duplicadas colapsadas`,
  );
  if (args.cmd === 'sources') {
    console.log(JSON.stringify({ counts: catalog.counts, sourceReport: catalog.sourceReport }, null, 2));
    return;
  }

  const store = loadHealth(cfg);
  const runs: ValidationRunReport[] = [];

  if (args.cmd === 'validate' || args.cmd === 'all') {
    const r = await validateCatalog(cfg, catalog.channels, store, {
      limit: args.limit,
      only: onlyFilter(args.only),
    });
    runs.push(r);
    saveHealth(cfg, store);
    info(`validacao concluida: ${JSON.stringify(r.byStatus)}`);
    if (args.cmd === 'validate') return;
  }

  // Views sem EPG primeiro: precisamos saber quem entra na playlist antes de pedir grade.
  let views = buildViews(cfg, taxonomy, catalog.channels, store, new Map());
  const wanted = new Set(
    views.filter((v) => v.eligible && v.channel.classified && v.channel.tvgId).map((v) => v.channel.tvgId!),
  );

  let epgResult: EpgResult;
  if (args.skipEpg || args.cmd === 'build') {
    // Sem rodar o grabber: aproveita o indice de uma execucao anterior, se houver.
    // E assim que a etapa de EPG roda numa job isolada e so entrega o arquivo.
    const prior = readIndex(cfg);
    if (prior) {
      info(
        `EPG nao executado agora; usando indice de ${prior.generatedAt} ` +
          `(${prior.channelsInGuide} canais, ${prior.programmes} programas)`,
      );
      epgResult = prior;
    } else {
      info('EPG pulado e nenhum indice anterior encontrado: cobertura fica zerada');
      epgResult = {
        index: new Map(),
        channelsInGuide: 0,
        programmes: 0,
        horizonHours: cfg.epg.programmeHorizonHours,
        generatedAt: new Date().toISOString(),
        sources: [],
        missing: [...wanted].map((id) => ({ tvgId: id, name: id, countryGroup: 'OTHER', guideSites: [] })),
        dropped: { duplicates: 0, outOfHorizon: 0, invalidTimestamp: 0, unknownChannel: 0, malformed: 0 },
      };
    }
  } else {
    info(`EPG pedido para ${wanted.size} canais da playlist validada`);
    epgResult = await buildEpg(cfg, epgCfg, catalog.channels, wanted);
    writeCoverage(cfg, epgResult, wanted.size);
    writeIndex(cfg, epgResult);
  }
  if (args.cmd === 'epg') return;

  views = buildViews(cfg, taxonomy, catalog.channels, store, epgResult.index);
  const written = writePlaylists(cfg, taxonomy, views, false);
  const metaCount = writeMetadata(cfg, views);
  info(`metadados: ${metaCount} canais em ${cfg.output.metadataFile}`);

  const status = buildStatus(
    cfg,
    taxonomy,
    catalog,
    views,
    epgResult,
    runs,
    written,
    limitations(cfg, catalog, views, epgResult, runs),
  );
  writeStatus(cfg, status);

  const dashCount = writeDashboardData(cfg, taxonomy, views, {
    generatedAt: status.generatedAt,
    urls: status.urls,
    discovery: status.discovery.channelsDiscovered,
    streams: status.discovery.streamsDiscovered,
    catalog: status.catalog,
    epg: {
      channelsWithGuide: status.epg.channelsWithGuide,
      channelsRequested: status.epg.channelsRequested,
      coveragePercent: status.epg.coveragePercent,
      programmes: status.epg.programmes,
    },
    vantages: status.validation.streamsByVantageAndStatus,
    playlists: status.playlists,
    limitations: status.limitations,
  });
  info(`painel: ${dashCount} canais em docs/dashboard-data.json`);
  info('pronto');
}

main().catch((err) => {
  error((err as Error).message);
  process.exitCode = 1;
});
