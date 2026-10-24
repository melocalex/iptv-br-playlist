import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { load, outPath, type Config, type RagConfig, type Taxonomy } from './config.ts';
import { buildCatalog, type Catalog, type Channel } from './catalog.ts';
import { fetchJson } from './http.ts';
import { loadHealth, saveHealth } from './health.ts';
import { validateCatalog, type ValidationRunReport } from './validate.ts';
import {
  buildEpg,
  writeCoverage,
  writeIndex,
  readIndex,
  verifyEpgArtifacts,
  writeEpgSlices,
  type EpgResult,
} from './epg.ts';
import { buildViews, writePlaylists, writeMetadata, writeDashboardData, type ChannelView } from './build.ts';
import { buildStatus, writeStatus } from './report.ts';
import { loadCorpus } from './corpus.ts';
import { ask } from './ask.ts';
import { serveMcp } from './mcp.ts';
import { loadEvalSet, runEval, formatReport } from './evaluate.ts';
import { info, warn, error, sendLogsToStderr } from './log.ts';

interface Args {
  cmd: string;
  force: boolean;
  limit: number | undefined;
  only: string | undefined;
  verifyRedundancy: boolean;
  skipEpg: boolean;
  /** Argumentos posicionais: a pergunta de `ask`. */
  rest: string[];
  json: boolean;
  noModel: boolean;
  vantage: string | undefined;
  now: string | undefined;
  out: string | undefined;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    cmd: argv[0] ?? 'all',
    force: false,
    limit: undefined,
    only: undefined,
    verifyRedundancy: false,
    skipEpg: false,
    rest: [],
    json: false,
    noModel: false,
    vantage: undefined,
    now: undefined,
    out: undefined,
  };
  for (const a of argv.slice(1)) {
    if (a === '--force') out.force = true;
    else if (a === '--verify-redundancy') out.verifyRedundancy = true;
    else if (a === '--skip-epg') out.skipEpg = true;
    else if (a === '--json') out.json = true;
    else if (a === '--no-model') out.noModel = true;
    else if (a.startsWith('--limit=')) out.limit = Number(a.slice('--limit='.length));
    else if (a.startsWith('--only=')) out.only = a.slice('--only='.length);
    else if (a.startsWith('--vantage=')) out.vantage = a.slice('--vantage='.length);
    else if (a.startsWith('--now=')) out.now = a.slice('--now='.length);
    else if (a.startsWith('--out=')) out.out = a.slice('--out='.length);
    else if (!a.startsWith('--')) out.rest.push(a);
    else throw new Error(`argumento desconhecido: ${a}`);
  }
  return out;
}

/** Comandos da camada de recuperacao: nao tocam a fonte, nao precisam de ffprobe nem de rede. */
const RAG_COMMANDS = new Set(['ask', 'mcp', 'rag-eval']);

function parseNow(value: string | undefined): number {
  if (!value) return Date.now();
  const at = Date.parse(value);
  if (Number.isNaN(at)) throw new Error(`--now nao e uma data ISO valida: ${value}`);
  return at;
}

async function runRag(cfg: Config, rag: RagConfig, tax: Taxonomy, args: Args): Promise<void> {
  const corpus = loadCorpus(rag, tax);
  info(
    `corpus: ${corpus.stats.channelsIndexed} canais indexados, ` +
      `${corpus.stats.channelsWithGuide} com grade (${corpus.stats.guideCoveragePercent}%), ` +
      `${corpus.stats.programmesInGuide} programas na janela`,
  );

  if (args.cmd === 'mcp') {
    info('servidor MCP em stdio; aguardando JSON-RPC');
    await serveMcp(cfg, rag, tax, corpus);
    return;
  }

  if (args.cmd === 'rag-eval') {
    const report = runEval(cfg, rag, tax, corpus, loadEvalSet(), parseNow(args.now));
    const file = args.out ?? 'data/rag-eval.json';
    const path = outPath(cfg, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(report, null, 1) + '\n');
    if (args.json) console.log(JSON.stringify(report, null, 1));
    else console.log(formatReport(report));
    info(`relatorio em ${file}`);
    if (report.totais.casosAprovados < report.totais.casos) {
      throw new Error(
        `${report.totais.casos - report.totais.casosAprovados} caso(s) de avaliacao falharam`,
      );
    }
    return;
  }

  const question = args.rest.join(' ').trim();
  if (!question) throw new Error('uso: node src/cli.ts ask "sua pergunta"');
  const result = await ask(cfg, rag, tax, corpus, question, {
    vantage: args.vantage,
    limit: args.limit,
    useModel: !args.noModel,
    now: parseNow(args.now),
  });
  if (args.json) {
    console.log(JSON.stringify(result, null, 1));
    return;
  }
  if (result.failure) warn(result.failure);
  if (result.groundingViolations.length) {
    for (const v of result.groundingViolations) warn(v);
  }
  console.log('');
  console.log(result.answer);
  console.log('');
  info(
    `fonte do texto: ${result.source}${result.model ? ` (${result.model})` : ''} | ` +
      `candidatos: ${result.retrieval.candidates.length} | ` +
      `abstencoes: ${result.retrieval.abstentions.map((a) => a.kind).join(',') || 'nenhuma'}`,
  );
}

/** Comandos que de fato chamam o ffprobe. Os outros nao exigem ffmpeg instalado. */
const NEEDS_FFPROBE = new Set(['check', 'validate', 'all']);

/** Checagens de inicializacao. Config invalida falha agora, nao no meio da execucao. */
async function bootCheck(
  cfg: Config,
  tax: Taxonomy,
  baseUrl: string,
  files: Record<string, string>,
  cmd: string,
) {
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

  // So os comandos que validam stream precisam do ffprobe. As etapas de EPG e de
  // build rodam em jobs que nao instalam ffmpeg, e exigir o binario ali so quebra.
  if (NEEDS_FFPROBE.has(cmd)) {
    const ff = spawnSync(v.ffprobePath, ['-version'], { encoding: 'utf8' });
    if (ff.status !== 0) {
      problems.push(
        `ffprobe nao executou em '${v.ffprobePath}' (${ff.error?.message ?? ff.status}). ` +
          'Instale o ffmpeg ou ajuste IPTV_VALIDATION_FFPROBEPATH.',
      );
    } else {
      info(`ffprobe ok: ${ff.stdout.split('\n')[0]}`);
    }
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
  wantedTotal: number,
): string[] {
  const out: string[] = [];
  const vantages = [...new Set(views.flatMap((v) => v.streams.flatMap((s) => Object.keys(s.byVantage))))];
  const never = views.filter((v) => v.streams.every((s) => s.bestStatus === 'UNKNOWN')).length;

  if (vantages.length === 1) {
    out.push(
      `Validation came from a single observation point (\`${vantages[0]}\`). A channel marked ` +
        'unavailable here may work from another country, and the reverse is also true. ' +
        'Run with a different `IPTV_VANTAGE` to compare.',
    );
  } else if (vantages.length > 1) {
    out.push(
      `Results from ${vantages.length} observation points (${vantages.join(', ')}) are reported ` +
        'separately and **do not add up**: the same stream can be WORKING at one and ' +
        'GEO_BLOCKED at another.',
    );
  }
  if (never > 0) {
    out.push(
      `${never} channels have never been checked. The per-run cap is ` +
        `\`validation.maxChecksPerRun\` = ${cfg.validation.maxChecksPerRun}; coverage grows each round.`,
    );
  }
  const withoutGuide = Math.max(0, wantedTotal - epg.channelsInGuide);
  out.push(
    `Measured guide coverage: ${epg.channelsInGuide} of ${wantedTotal} channels in the main ` +
      `playlist (${withoutGuide} without a guide). Measured, with no rounding up.`,
  );
  if (epg.sources.length === 0 && epg.channelsInGuide > 0) {
    out.push(
      'The guide was not rebuilt in this run: the EPG data comes from the index generated at ' +
        `${epg.generatedAt}. A channel that entered the playlist after that has not been ` +
        'requested from any guide source yet, so it shows as uncovered until the next full run.',
    );
  }
  const failedEpg = epg.sources.filter((s) => !s.ok);
  if (failedEpg.length) {
    out.push(
      `Guide sources that produced nothing in this run: ${failedEpg
        .map((s) => `${s.id} (${s.note ?? 'no reason recorded'})`)
        .join('; ')}.`,
    );
  }
  const unreliableSubs = views.filter((v) =>
    v.streams.some((s) => s.media && !s.media.subtitleDetectionReliable),
  ).length;
  if (unreliableSubs > 0) {
    out.push(
      `${unreliableSubs} channels are served over HLS. ffprobe does not open the subtitle ` +
        'variant playlist, so **absence of a subtitle track does not prove absence of ' +
        'subtitles** on those channels.',
    );
  }
  out.push(
    'No playlist performs automatic failover. Alternative streams are kept in ' +
      `\`${cfg.output.metadataFile}\`, but switching streams is up to the player: the project ` +
      'neither implements nor has tested failover, so it does not claim one exists.',
  );
  out.push(
    'Nothing here circumvents DRM, authentication, paywalls or geoblocking. `GEO_BLOCKED` is ' +
      'only a diagnostic label, based on HTTP 451 or explicit text in the response.',
  );
  if (catalog.sourceReport.failed.length) {
    out.push(
      `Sources that failed to download: ${catalog.sourceReport.failed
        .map((f) => `${f.id} (${f.reason})`)
        .join('; ')}.`,
    );
  }
  const unclassified = catalog.channels.filter((c) => !c.classified).length;
  if (unclassified > 0) {
    out.push(
      `${unclassified} streams have no channel metadata in the source. They stay out of the ` +
        'validated playlists and appear only in `playlist-all.m3u`, because classifying by ' +
        'channel name would be guessing.',
    );
  }
  const checked = runs.reduce((n, r) => n + r.checked, 0);
  if (runs.length && checked < runs.reduce((n, r) => n + r.eligible, 0)) {
    out.push(
      `This run checked ${checked} streams out of ${runs.reduce((n, r) => n + r.eligible, 0)} ` +
        'eligible. The rest keep the status from the previous round.',
    );
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // O MCP usa o stdout para o protocolo: o log tem de sair pelo stderr desde a primeira linha.
  if (args.cmd === 'mcp') sendLogsToStderr();
  const { config: cfg, taxonomy, sources, epg: epgCfg, rag, envApplied } = load();
  if (envApplied.length) info(`config sobrescrita por env: ${envApplied.join(', ')}`);
  info(`comando: ${args.cmd} | vantage: ${cfg.vantage} | repo: ${cfg.repo.owner}/${cfg.repo.name}`);

  // A camada de recuperacao le o que ja foi publicado: sem rede, sem ffprobe, sem boot check.
  if (RAG_COMMANDS.has(args.cmd)) {
    await runRag(cfg, rag, taxonomy, args);
    return;
  }

  await bootCheck(cfg, taxonomy, sources.api.baseUrl, sources.api.files, args.cmd);
  if (args.cmd === 'check') return;

  // Reconfere os arquivos de EPG que chegaram da job isolada antes de publicar.
  if (args.cmd === 'verify-epg') {
    const problems = verifyEpgArtifacts(cfg);
    if (problems.length) {
      for (const p of problems) error(p);
      throw new Error(`${problems.length} problema(s) nos arquivos de EPG; nao publique`);
    }
    info('arquivos de EPG verificados');
    return;
  }

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
    writeIndex(cfg, epgResult);
  }
  // Cobertura e sempre regravada aqui, nunca copiada da etapa anterior: assim o
  // arquivo publicado sai da job que ja verificou o indice.
  writeCoverage(cfg, epgResult, wanted.size);
  if (args.cmd === 'epg') return;

  views = buildViews(cfg, taxonomy, catalog.channels, store, epgResult.index);
  const written = writePlaylists(cfg, taxonomy, views, false);
  const metaCount = writeMetadata(cfg, views);
  info(`metadados: ${metaCount} canais em ${cfg.output.metadataFile}`);

  // Fatias por canal, geradas aqui a partir do guia ja verificado.
  const slices = writeEpgSlices(
    cfg,
    views
      .filter((v) => v.eligible && v.channel.classified && v.channel.tvgId)
      .map((v) => ({ tvgId: v.channel.tvgId, name: v.channel.name, logo: v.channel.logo })),
  );

  const status = buildStatus(
    cfg,
    taxonomy,
    catalog,
    views,
    epgResult,
    runs,
    written,
    limitations(cfg, catalog, views, epgResult, runs, wanted.size),
    wanted.size,
    slices,
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
