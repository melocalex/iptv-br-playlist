import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { load, type RagConfig } from '../src/config.ts';
import { fold, tokenize, buildIndex, searchIndex } from '../src/lexical.ts';
import {
  loadCorpus,
  tokenizeOptions,
  type ChannelDoc,
  type Corpus,
  type GuideSlice,
  type StreamDoc,
} from '../src/corpus.ts';
import { planQuery } from '../src/plan.ts';
import { availabilityOf, programmeOf, retrieve } from '../src/retrieve.ts';
import { buildEvidence, checkGrounding, renderGrounded } from '../src/ask.ts';
import { createMessage } from '../src/anthropic.ts';
import { handleMessage, type ToolContext } from '../src/mcp.ts';
import { loadEvalSet, runEval } from '../src/evaluate.ts';

const { config, taxonomy, rag } = load();

const HOUR = 3_600_000;
const NOW = Date.parse('2026-10-24T12:00:00.000Z');

function stream(partial: Partial<StreamDoc>): StreamDoc {
  return {
    key: 'k1',
    url: 'https://exemplo/stream.m3u8',
    role: 'primary',
    status: 'WORKING',
    byVantage: {},
    lastSuccessAt: null,
    consecutiveFailures: 0,
    resolution: '1080p',
    audioLanguages: ['por'],
    subtitleTracks: 0,
    subtitleDetectionReliable: false,
    verifiedPortugueseAudio: false,
    ...partial,
  };
}

function channel(partial: Partial<ChannelDoc>): ChannelDoc {
  return {
    tvgId: 'Teste.br@SD',
    id: 'Teste.br',
    name: 'Canal Teste',
    countryCode: 'BR',
    countryGroup: 'BR',
    countryGroupLabel: 'Brasil',
    countryGroupReason: 'feed.broadcast_area=c/BR',
    section: '🇧🇷 Brasil • Notícias',
    primaryCategory: 'news',
    categories: ['news'],
    categoryLabels: ['Notícias'],
    declaredLanguages: ['por'],
    timezones: ['America/Sao_Paulo'],
    logo: null,
    website: null,
    hasGuide: false,
    guideProgrammes: 0,
    streams: [stream({})],
    ...partial,
  };
}

/** Corpus sintetico: os testes de veredito nao devem depender do dado publicado. */
function corpusOf(channels: ChannelDoc[], guide: GuideSlice[] = []): Corpus {
  const opts = tokenizeOptions(rag);
  return {
    channels,
    byTvgId: new Map(channels.map((c) => [c.tvgId, c])),
    rejected: new Map(),
    guide: new Map(guide.map((g) => [g.tvgId, g])),
    stats: {
      channelsGeneratedAt: new Date(NOW).toISOString(),
      guideGeneratedAt: new Date(NOW).toISOString(),
      channelsIndexed: channels.length,
      channelsRejected: 0,
      channelsWithGuide: guide.length,
      guideCoveragePercent: channels.length
        ? Number(((guide.length / channels.length) * 100).toFixed(2))
        : 0,
      programmesInGuide: guide.reduce((n, g) => n + g.programmes.length, 0),
      vantagesSeen: ['local-br', 'github-us'],
      byCountryGroup: {},
      byCategory: {},
      streamsByVantageAndStatus: {},
    },
    channelIndex: buildIndex(
      channels.map((c) => ({ id: c.tvgId, fields: [{ text: c.name, weight: 4 }] })),
      opts,
    ),
    programmeIndex: buildIndex([], opts),
    programmeRef: new Map(),
  };
}

test('fold e tokenize normalizam acento e removem stopword', () => {
  assert.equal(fold('Notícia em Português'), 'noticia em portugues');
  const opts = { minLength: 2, stopwords: new Set(['de', 'em']) };
  assert.deepEqual(tokenize('Notícia de TV em Português', opts), ['noticia', 'tv', 'portugues']);
  // Token menor que o minimo sai fora.
  assert.deepEqual(tokenize('RTP 1', { minLength: 2, stopwords: new Set() }), ['rtp']);
});

test('BM25 respeita peso de campo e conjunto permitido', () => {
  const opts = { minLength: 2, stopwords: new Set<string>() };
  const index = buildIndex(
    [
      { id: 'a', fields: [{ text: 'jornal', weight: 4 }, { text: 'noticias gerais', weight: 1 }] },
      { id: 'b', fields: [{ text: 'esportes', weight: 4 }, { text: 'jornal esportivo', weight: 1 }] },
    ],
    opts,
  );
  const hits = searchIndex(index, ['jornal'], { k1: rag.retrieval.bm25K1, b: rag.retrieval.bm25B });
  assert.equal(hits[0]?.id, 'a', 'match no campo com peso maior vem antes');
  assert.equal(hits.length, 2);

  const restricted = searchIndex(index, ['jornal'], {
    k1: rag.retrieval.bm25K1,
    b: rag.retrieval.bm25B,
    allow: new Set(['b']),
  });
  assert.deepEqual(restricted.map((h) => h.id), ['b']);
  assert.deepEqual(searchIndex(index, [], { k1: 1.2, b: 0.75 }), []);
});

test('planQuery extrai categoria, idioma e janela temporal da pergunta', () => {
  const q = planQuery(rag, taxonomy, 'o que tem de notícia em português tocando agora', {
    vantage: 'local-br',
  });
  assert.deepEqual(q.categories, ['news']);
  assert.deepEqual(q.languages, ['por']);
  assert.deepEqual(q.countryGroups, []);
  assert.equal(q.requireGuide, true);
  assert.equal(q.temporalNow, true);
  assert.equal(q.text, '', 'termo que virou filtro nao sobra como texto livre');
});

test('planQuery separa idioma de pais e aceita tvg-id e ingles', () => {
  const pt = planQuery(rag, taxonomy, 'filme em português de Portugal', { vantage: 'local-br' });
  assert.deepEqual(pt.languages, ['por']);
  assert.deepEqual(pt.countryGroups, ['PT']);
  assert.deepEqual(pt.categories, ['movies']);

  const byId = planQuery(rag, taxonomy, 'o canal GloboNews.br@SD funciona?', {
    vantage: 'local-br',
  });
  assert.deepEqual(byId.tvgIds, ['GloboNews.br@SD']);
  assert.equal(byId.text, '', 'tvg-id nao volta como texto livre');

  const en = planQuery(rag, taxonomy, 'what news channels in english are on right now', {
    vantage: 'local-br',
  });
  assert.deepEqual(en.categories, ['news']);
  assert.deepEqual(en.languages, ['eng']);
  assert.equal(en.temporalNow, true);
});

test('veredito de disponibilidade distingue ponto de observacao e evidencia vencida', () => {
  const fresh = new Date(NOW - HOUR).toISOString();
  const old = new Date(NOW - 100 * HOUR).toISOString();

  const here = availabilityOf(
    rag,
    channel({
      streams: [
        stream({
          byVantage: { 'local-br': { status: 'WORKING', checkedAt: fresh, http: 200, reason: null } },
        }),
      ],
    }),
    'local-br',
    NOW,
  );
  assert.equal(here.verdict, 'CONFIRMED_HERE');
  assert.equal(here.vantage, 'local-br');

  const elsewhere = availabilityOf(
    rag,
    channel({
      streams: [
        stream({
          byVantage: { 'github-us': { status: 'WORKING', checkedAt: fresh, http: 200, reason: null } },
        }),
      ],
    }),
    'local-br',
    NOW,
  );
  assert.equal(elsewhere.verdict, 'CONFIRMED_ELSEWHERE');

  const stale = availabilityOf(
    rag,
    channel({
      streams: [
        stream({
          byVantage: { 'local-br': { status: 'WORKING', checkedAt: old, http: 200, reason: null } },
        }),
      ],
    }),
    'local-br',
    NOW,
  );
  assert.equal(stale.verdict, 'STALE');

  const refused = availabilityOf(
    rag,
    channel({
      streams: [
        stream({
          status: 'GEO_BLOCKED',
          byVantage: {
            'local-br': { status: 'GEO_BLOCKED', checkedAt: fresh, http: 451, reason: 'geo' },
          },
        }),
      ],
    }),
    'local-br',
    NOW,
  );
  assert.equal(refused.verdict, 'REFUSED');
  assert.equal(refused.http, 451);

  const never = availabilityOf(rag, channel({ streams: [stream({})] }), 'local-br', NOW);
  assert.equal(never.verdict, 'NEVER_CHECKED');
  assert.equal(never.url, 'https://exemplo/stream.m3u8', 'ainda devolve a URL conhecida');
});

test('veredito de grade cobre no ar, lacuna, janela vencida e ausencia', () => {
  const sec = Math.floor(NOW / 1000);
  const ch = channel({ tvgId: 'Com.br@SD', hasGuide: true });
  const slice = (programmes: GuideSlice['programmes'], generatedAt = new Date(NOW).toISOString()) => ({
    tvgId: 'Com.br@SD',
    name: 'Com grade',
    generatedAt,
    horizonHours: rag.freshness.guideStaleAfterHours,
    programmes,
  });

  const onAir = programmeOf(
    rag,
    corpusOf([ch], [slice([
      { start: sec - 600, end: sec + 600, title: 'Jornal', desc: 'd', categories: [] },
      { start: sec + 600, end: sec + 1200, title: 'Depois', desc: 'd', categories: [] },
    ])]),
    ch,
    NOW,
  );
  assert.equal(onAir.verdict, 'ON_AIR');
  assert.equal(onAir.current?.title, 'Jornal');
  assert.equal(onAir.next[0]?.title, 'Depois');

  const gap = programmeOf(
    rag,
    corpusOf([ch], [slice([{ start: sec + 7200, end: sec + 10800, title: 'Mais tarde', desc: '', categories: [] }])]),
    ch,
    NOW,
  );
  assert.equal(gap.verdict, 'GUIDE_GAP');

  const expired = programmeOf(
    rag,
    corpusOf([ch], [slice([{ start: sec - 10800, end: sec - 7200, title: 'Ja passou', desc: '', categories: [] }])]),
    ch,
    NOW,
  );
  assert.equal(expired.verdict, 'GUIDE_STALE');

  const none = programmeOf(rag, corpusOf([channel({})]), channel({}), NOW);
  assert.equal(none.verdict, 'NO_GUIDE');
  assert.equal(none.programmesInSlice, 0);
});

test('recuperacao se abstem quando a evidencia vence e quando o nome nao existe', () => {
  const old = new Date(NOW - 100 * HOUR).toISOString();
  const corpus = corpusOf([
    channel({
      tvgId: 'Velho.br@SD',
      name: 'Canal Velho',
      streams: [
        stream({
          byVantage: { 'local-br': { status: 'WORKING', checkedAt: old, http: 200, reason: null } },
        }),
      ],
    }),
  ]);

  const stale = retrieve(
    rag,
    corpus,
    planQuery(rag, taxonomy, 'tem notícia em português agora', { vantage: 'local-br' }),
    NOW,
  );
  assert.deepEqual(stale.candidates, []);
  // 'agora' sozinho e janela de disponibilidade, nao pedido de grade: so uma abstencao.
  assert.deepEqual(stale.abstentions.map((a) => a.kind), ['availability']);
  assert.equal(stale.counts.excludedStale, 1);
  assert.match(renderGrounded(stale), /Nao sei responder/);

  const unknownName = retrieve(
    rag,
    corpus,
    planQuery(rag, taxonomy, 'o que está passando no canal Zorblax', { vantage: 'local-br' }),
    NOW,
  );
  assert.deepEqual(unknownName.candidates, []);
  assert.match(
    unknownName.abstentions[0]?.reason ?? '',
    /nenhum canal do corpus casa/,
    'texto sem casamento e sem filtro estrutural nao devolve o catalogo inteiro',
  );
});

test('a redacao deterministica cita tvg-id, observacao e cobertura medida', () => {
  const fresh = new Date(NOW - HOUR).toISOString();
  const corpus = corpusOf([
    channel({
      streams: [
        stream({
          byVantage: { 'local-br': { status: 'WORKING', checkedAt: fresh, http: 200, reason: null } },
        }),
      ],
    }),
  ]);
  const result = retrieve(
    rag,
    corpus,
    planQuery(rag, taxonomy, 'tem notícia em português', { vantage: 'local-br' }),
    NOW,
  );
  const text = renderGrounded(result);
  assert.match(text, /Teste\.br@SD/);
  assert.match(text, /WORKING/);
  assert.match(text, new RegExp(fresh.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(text, /sem grade/);
  assert.match(text, /A grade cobre 0 dos 1 canais indexados/);
});

test('a conferencia de fundamentacao rejeita canal e URL fora da evidencia', () => {
  const fresh = new Date(NOW - HOUR).toISOString();
  const corpus = corpusOf([
    channel({
      streams: [
        stream({
          byVantage: { 'local-br': { status: 'WORKING', checkedAt: fresh, http: 200, reason: null } },
        }),
      ],
    }),
  ]);
  const result = retrieve(
    rag,
    corpus,
    planQuery(rag, taxonomy, 'tem notícia em português', { vantage: 'local-br' }),
    NOW,
  );
  const evidence = buildEvidence(rag, result);

  const ok = checkGrounding(
    'Teste.br@SD esta WORKING em local-br. URL: https://exemplo/stream.m3u8',
    evidence,
  );
  assert.equal(ok.ok, true);

  const invented = checkGrounding('Recomendo Globo.br@SD, que funciona.', evidence);
  assert.equal(invented.ok, false);
  assert.match(invented.offending.join(' '), /Globo\.br@SD/);

  const badUrl = checkGrounding('Use https://outro.exemplo/x.m3u8', evidence);
  assert.equal(badUrl.ok, false);
  assert.match(badUrl.offending.join(' '), /outro\.exemplo/);
});

test('cliente da Messages API: sucesso, retentativa e erro definitivo', async () => {
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    if (req.url !== '/v1/messages' || req.headers['x-api-key'] !== 'chave-de-teste') {
      res.writeHead(400).end('{"error":"requisicao inesperada"}');
      return;
    }
    if (hits === 1) {
      res.writeHead(500).end('{"error":"indisponivel"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        model: 'modelo-de-teste',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'resposta fundamentada' }],
        usage: { input_tokens: 10, output_tokens: 3 },
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;

  const local: RagConfig = {
    ...rag,
    generation: { ...rag.generation, baseUrl: `http://127.0.0.1:${port}`, retryBackoffMs: 1 },
  };
  process.env['ANTHROPIC_API_KEY'] = 'chave-de-teste';
  try {
    const result = await createMessage(local, {
      system: 'sistema',
      messages: [{ role: 'user', content: 'pergunta' }],
    });
    assert.equal(result.text, 'resposta fundamentada');
    assert.equal(result.model, 'modelo-de-teste');
    assert.equal(result.inputTokens, 10);
    assert.equal(hits, 2, 'HTTP 500 e retentado');

    process.env['ANTHROPIC_API_KEY'] = 'chave-errada';
    await assert.rejects(
      () => createMessage(local, { system: 's', messages: [{ role: 'user', content: 'p' }] }),
      /HTTP 400/,
    );
  } finally {
    delete process.env['ANTHROPIC_API_KEY'];
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('servidor MCP responde initialize, tools/list e tools/call', () => {
  const fresh = new Date(NOW - HOUR).toISOString();
  const corpus = corpusOf([
    channel({
      streams: [
        stream({
          byVantage: { 'local-br': { status: 'WORKING', checkedAt: fresh, http: 200, reason: null } },
        }),
      ],
    }),
  ]);
  corpus.rejected.set('Morto.br@SD', {
    tvgId: 'Morto.br@SD',
    name: 'Canal Morto',
    countryGroup: 'BR',
    classified: true,
    eligible: false,
    health: 'OFFLINE',
    observations: [
      { vantage: 'local-br', status: 'OFFLINE', checkedAt: fresh, http: 404, reason: 'http 404' },
    ],
  });
  const ctx: ToolContext = { cfg: config, rag, tax: taxonomy, corpus, now: () => NOW };

  const init = handleMessage(ctx, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }));
  assert.equal((init?.result as { serverInfo: { name: string } }).serverInfo.name, 'iptv-br-playlist');

  assert.equal(handleMessage(ctx, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })), null);

  const tools = handleMessage(ctx, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
  const names = (tools?.result as { tools: { name: string }[] }).tools.map((t) => t.name);
  assert.deepEqual(names, ['search_channels', 'channel_evidence', 'now_playing', 'corpus_stats']);

  const call = handleMessage(
    ctx,
    JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'search_channels', arguments: { pergunta: 'tem notícia em português' } },
    }),
  );
  const payload = JSON.parse(
    (call?.result as { content: { text: string }[] }).content[0]!.text,
  ) as { canais: { tvgId: string }[]; instrucaoDeFundamentacao: string };
  assert.deepEqual(payload.canais.map((c) => c.tvgId), ['Teste.br@SD']);
  assert.match(payload.instrucaoDeFundamentacao, /tvgId/);

  // Canal fora do indice responde com a evidencia da exclusao, nao com 'nao conheco'.
  const dead = handleMessage(
    ctx,
    JSON.stringify({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'channel_evidence', arguments: { tvgId: 'Morto.br@SD' } },
    }),
  );
  const deadPayload = JSON.parse(
    (dead?.result as { content: { text: string }[] }).content[0]!.text,
  ) as { encontrado: boolean; evidenciaDaExclusao: { status: string } };
  assert.equal(deadPayload.encontrado, false);
  assert.equal(deadPayload.evidenciaDaExclusao.status, 'OFFLINE');

  const unknown = handleMessage(ctx, JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'nada/disso' }));
  assert.equal(unknown?.error?.code, -32601);

  const broken = handleMessage(ctx, '{nao e json');
  assert.equal(broken?.error?.code, -32700);
});

test('o conjunto de avaliacao atinge o piso configurado sobre o corpus publicado', () => {
  const corpus = loadCorpus(rag, taxonomy);
  const set = loadEvalSet();
  // Instante fixo: o da geracao da grade publicada, para a nota nao depender do relogio.
  const at = Date.parse(corpus.stats.guideGeneratedAt ?? corpus.stats.channelsGeneratedAt);
  const report = runEval(config, rag, taxonomy, corpus, set, at);
  assert.ok(set.casos.length >= 12, 'o conjunto precisa de pelo menos uma duzia de perguntas');
  assert.ok(
    report.totais.acertoDeVerificacoesPercent >= set.minimoDeAcertoPercent,
    `acerto de ${report.totais.acertoDeVerificacoesPercent}% abaixo do piso de ` +
      `${set.minimoDeAcertoPercent}%: ` +
      report.casos
        .filter((c) => !c.aprovado)
        .map((c) => `${c.id} (${c.verificacoes.filter((v) => !v.ok).map((v) => v.nome).join(', ')})`)
        .join('; '),
  );
});
