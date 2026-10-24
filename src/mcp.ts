/**
 * Servidor MCP sobre stdio, em JSON-RPC 2.0 delimitado por linha.
 *
 * Sem dependencia: o protocolo usado aqui e so `initialize`, `tools/list` e
 * `tools/call`. O stdout e canal do protocolo, logo todo log vai para o stderr
 * (veja `sendLogsToStderr`).
 *
 * As ferramentas devolvem evidencia, nunca conclusao: status, ponto de observacao e
 * `checkedAt` por canal, e veredito explicito de grade. Quem consome e um modelo, e
 * a instrucao de fundamentacao viaja junto da resposta.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, type Config, type RagConfig, type Taxonomy } from './config.ts';
import type { Corpus } from './corpus.ts';
import { planQuery, type Query } from './plan.ts';
import { availabilityOf, programmeOf, retrieve } from './retrieve.ts';
import { buildEvidence } from './ask.ts';

const PROTOCOL_VERSION = '2025-06-18';

const GROUNDING_RULE =
  'Cite cada canal pelo tvgId e pela observacao que o sustenta (status, pontoDeObservacao, ' +
  'checkedAt). Veredito diferente de CONFIRMED_HERE nao garante que abre de onde a pessoa ' +
  'esta. Veredito de grade diferente de ON_AIR significa que o que esta passando e ' +
  'desconhecido: diga isso em vez de descrever programacao.';

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

function version(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function str(params: Record<string, unknown>, key: string): string | undefined {
  const v = params[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function list(params: Record<string, unknown>, key: string): string[] {
  const v = params[key];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string' && v.trim()) return [v.trim()];
  return [];
}

function flag(params: Record<string, unknown>, key: string): boolean | undefined {
  const v = params[key];
  return typeof v === 'boolean' ? v : undefined;
}

function num(params: Record<string, unknown>, key: string): number | undefined {
  const v = params[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Consulta montada a partir dos argumentos da ferramenta, sem passar pelo lexico. */
function explicitQuery(
  rag: RagConfig,
  params: Record<string, unknown>,
  vantage: string,
): Query {
  const texto = str(params, 'texto') ?? '';
  const limite = num(params, 'limite') ?? rag.retrieval.defaultLimit;
  return {
    question: texto || '(consulta estruturada)',
    text: texto,
    terms: texto
      ? texto
          .normalize('NFD')
          .replace(/[̀-ͯ]/g, '')
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter((t) => t.length >= rag.retrieval.minTokenLength)
      : [],
    countryGroups: list(params, 'grupoPais').map((s) => s.toUpperCase()),
    categories: list(params, 'categoria'),
    languages: list(params, 'idioma'),
    requireGuide: flag(params, 'comGradeApenas') ?? false,
    temporalNow: false,
    availabilityIntent: true,
    requireAvailable: flag(params, 'exigirEvidencia') ?? true,
    vantage,
    limit: Math.min(Math.max(limite, 1), rag.retrieval.maxLimit),
    tvgIds: list(params, 'tvgId'),
    matched: [],
  };
}

export interface ToolContext {
  cfg: Config;
  rag: RagConfig;
  tax: Taxonomy;
  corpus: Corpus;
  now: () => number;
}

function toolDefinitions() {
  return [
    {
      name: 'search_channels',
      description:
        'Busca canais de TV ao vivo no corpus medido e devolve, por canal, a evidencia de ' +
        'disponibilidade (status, ponto de observacao, checkedAt) e o veredito de grade. ' +
        'Use `pergunta` para mandar a frase do usuario em portugues e deixar o filtro ser ' +
        'extraido dela, ou os campos estruturados para controlar o filtro.',
      inputSchema: {
        type: 'object',
        properties: {
          pergunta: { type: 'string', description: 'Pergunta em linguagem natural.' },
          texto: { type: 'string', description: 'Texto livre para busca lexical (nome do canal, titulo de programa).' },
          grupoPais: {
            type: 'array',
            items: { type: 'string' },
            description: 'Grupos de pais: BR, PT, LATAM, ES, US, UK, INT, OTHER.',
          },
          categoria: {
            type: 'array',
            items: { type: 'string' },
            description: 'Categorias: news, sports, movies, series, documentary, kids, animation, entertainment, music, education, culture, variety, general.',
          },
          idioma: {
            type: 'array',
            items: { type: 'string' },
            description: 'Codigos ISO 639-3 declarados pela fonte: por, spa, eng, ...',
          },
          comGradeApenas: {
            type: 'boolean',
            description: 'Quando true, a pergunta e tratada como pergunta de grade e a abstencao aparece se nada estiver no ar.',
          },
          exigirEvidencia: {
            type: 'boolean',
            description: 'Quando true (padrao), descarta canal com evidencia vencida, recusada ou ausente.',
          },
          vantage: {
            type: 'string',
            description: 'Ponto de observacao de quem pergunta (local-br, github-us). Padrao: o do config.',
          },
          limite: { type: 'number', description: 'Maximo de canais na resposta.' },
        },
      },
    },
    {
      name: 'channel_evidence',
      description:
        'Evidencia completa de um canal por tvg-id (canal@feed): toda observacao por ponto de ' +
        'observacao, com status, HTTP, motivo e checkedAt, mais midia medida e veredito de frescor.',
      inputSchema: {
        type: 'object',
        properties: {
          tvgId: { type: 'string', description: 'Identidade estavel, formato canal@feed (ex.: Globo.br@SD).' },
          vantage: { type: 'string', description: 'Ponto de observacao de quem pergunta.' },
        },
        required: ['tvgId'],
      },
    },
    {
      name: 'now_playing',
      description:
        'O que esta no ar agora, segundo a grade publicada. Sem tvgId, lista os canais com ' +
        'programa no ar dentro do filtro. A grade cobre uma fracao do catalogo: a resposta diz ' +
        'quantos canais ficaram sem grade em vez de omitir o buraco.',
      inputSchema: {
        type: 'object',
        properties: {
          tvgId: { type: 'string', description: 'Um canal especifico (canal@feed).' },
          grupoPais: { type: 'array', items: { type: 'string' } },
          categoria: { type: 'array', items: { type: 'string' } },
          idioma: { type: 'array', items: { type: 'string' } },
          vantage: { type: 'string' },
          limite: { type: 'number' },
        },
      },
    },
    {
      name: 'corpus_stats',
      description:
        'Numeros medidos do corpus: canais indexados, cobertura de grade, pontos de observacao ' +
        'e distribuicao de status por ponto. Use antes de generalizar sobre o catalogo.',
      inputSchema: { type: 'object', properties: {} },
    },
  ];
}

function callTool(ctx: ToolContext, name: string, params: Record<string, unknown>): unknown {
  const vantage = str(params, 'vantage') ?? ctx.cfg.vantage;
  const now = ctx.now();

  if (name === 'search_channels') {
    const pergunta = str(params, 'pergunta');
    const query = pergunta
      ? planQuery(ctx.rag, ctx.tax, pergunta, { vantage, limit: num(params, 'limite') })
      : explicitQuery(ctx.rag, params, vantage);
    const result = retrieve(ctx.rag, ctx.corpus, query, now);
    return { instrucaoDeFundamentacao: GROUNDING_RULE, ...buildEvidence(ctx.rag, result) };
  }

  if (name === 'channel_evidence') {
    const tvgId = str(params, 'tvgId');
    if (!tvgId) throw new Error('tvgId e obrigatorio');
    const channel = ctx.corpus.byTvgId.get(tvgId);
    if (!channel) {
      const excluded = ctx.corpus.rejected.get(tvgId);
      if (excluded) {
        return {
          instrucaoDeFundamentacao: GROUNDING_RULE,
          tvgId,
          encontrado: false,
          noIndice: false,
          motivo: excluded.eligible
            ? 'canal sem metadado de classificacao na fonte: fica fora das playlists validadas'
            : 'canal checado e nunca confirmado em nenhum ponto de observacao',
          evidenciaDaExclusao: {
            nome: excluded.name,
            grupoPais: excluded.countryGroup,
            classificado: excluded.classified,
            elegivel: excluded.eligible,
            status: excluded.health,
            observacoes: excluded.observations,
          },
        };
      }
      return {
        instrucaoDeFundamentacao: GROUNDING_RULE,
        tvgId,
        encontrado: false,
        noIndice: false,
        motivo:
          'tvg-id desconhecido no corpus. O indice tem canais classificados e elegiveis ' +
          `(${ctx.corpus.stats.channelsIndexed}) e guarda a evidencia de ` +
          `${ctx.corpus.stats.channelsRejected} canais excluidos.`,
      };
    }
    return {
      instrucaoDeFundamentacao: GROUNDING_RULE,
      encontrado: true,
      tvgId,
      nome: channel.name,
      grupoPais: channel.countryGroup,
      motivoDoGrupo: channel.countryGroupReason,
      secao: channel.section,
      categorias: channel.categories,
      idiomasDeclarados: channel.declaredLanguages,
      fusos: channel.timezones,
      site: channel.website,
      disponibilidade: availabilityOf(ctx.rag, channel, vantage, now),
      grade: programmeOf(ctx.rag, ctx.corpus, channel, now),
      streams: channel.streams.map((s) => ({
        chave: s.key,
        url: s.url,
        papel: s.role,
        status: s.status,
        porPontoDeObservacao: s.byVantage,
        ultimoSucessoEm: s.lastSuccessAt,
        falhasConsecutivas: s.consecutiveFailures,
        resolucao: s.resolution,
        idiomasDeAudio: s.audioLanguages,
        faixasDeLegenda: s.subtitleTracks,
        deteccaoDeLegendaConfiavel: s.subtitleDetectionReliable,
      })),
    };
  }

  if (name === 'now_playing') {
    const tvgId = str(params, 'tvgId');
    if (tvgId) {
      const channel = ctx.corpus.byTvgId.get(tvgId);
      if (!channel) return { tvgId, encontrado: false, motivo: 'tvg-id fora do corpus indexado' };
      return {
        instrucaoDeFundamentacao: GROUNDING_RULE,
        tvgId,
        nome: channel.name,
        grade: programmeOf(ctx.rag, ctx.corpus, channel, now),
        disponibilidade: availabilityOf(ctx.rag, channel, vantage, now),
      };
    }
    const query: Query = { ...explicitQuery(ctx.rag, params, vantage), requireGuide: true, temporalNow: true };
    const result = retrieve(ctx.rag, ctx.corpus, query, now);
    return { instrucaoDeFundamentacao: GROUNDING_RULE, ...buildEvidence(ctx.rag, result) };
  }

  if (name === 'corpus_stats') {
    return { instrucaoDeFundamentacao: GROUNDING_RULE, ...ctx.corpus.stats };
  }

  throw new Error(`ferramenta desconhecida: ${name}`);
}

export interface RpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

/** Trata uma mensagem JSON-RPC. Devolve null quando e notificacao (sem resposta). */
export function handleMessage(ctx: ToolContext, raw: string): RpcResponse | null {
  let req: JsonRpcRequest;
  try {
    req = JSON.parse(raw) as JsonRpcRequest;
  } catch {
    return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON invalido' } };
  }
  const id = req.id ?? null;
  const isNotification = req.id === undefined || req.id === null;
  const params = (req.params ?? {}) as Record<string, unknown>;

  try {
    switch (req.method) {
      case 'initialize': {
        const asked = typeof params['protocolVersion'] === 'string' ? params['protocolVersion'] : null;
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: asked ?? PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: 'iptv-br-playlist', version: version() },
          },
        };
      }
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: toolDefinitions() } };
      case 'tools/call': {
        const name = str(params, 'name');
        if (!name) throw new Error('name e obrigatorio');
        const args = (params['arguments'] ?? {}) as Record<string, unknown>;
        try {
          const payload = callTool(ctx, name, args);
          return {
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: JSON.stringify(payload, null, 1) }] },
          };
        } catch (err) {
          // Falha de ferramenta volta como resultado com isError, nao como erro de protocolo.
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: `erro: ${(err as Error).message}` }],
              isError: true,
            },
          };
        }
      }
      default:
        if (isNotification) return null;
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `metodo nao suportado: ${req.method ?? '(vazio)'}` },
        };
    }
  } catch (err) {
    if (isNotification) return null;
    return { jsonrpc: '2.0', id, error: { code: -32603, message: (err as Error).message } };
  }
}

export async function serveMcp(
  cfg: Config,
  rag: RagConfig,
  tax: Taxonomy,
  corpus: Corpus,
): Promise<void> {
  const ctx: ToolContext = { cfg, rag, tax, corpus, now: () => Date.now() };
  process.stdin.setEncoding('utf8');
  let buffer = '';

  await new Promise<void>((done) => {
    process.stdin.on('data', (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          const response = handleMessage(ctx, line);
          if (response) process.stdout.write(JSON.stringify(response) + '\n');
        }
        newline = buffer.indexOf('\n');
      }
    });
    process.stdin.on('end', () => done());
    process.stdin.on('close', () => done());
  });
}
