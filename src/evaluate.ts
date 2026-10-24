/**
 * Avaliacao do planejador, da recuperacao e da abstencao.
 *
 * O conjunto fica em `config/eval.json`. Cada pergunta declara o que se espera do
 * plano (filtros extraidos), da recuperacao (quem tem de aparecer e quem nao pode) e
 * da abstencao. O resultado e uma fracao medida de verificacoes aprovadas, nao uma
 * impressao.
 *
 * A pontuacao depende do instante: evidencia vence e a janela da grade e curta. Por
 * isso o relatorio grava o `now` usado e o comando aceita `--now=` para reproduzir.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, type Config, type RagConfig, type Taxonomy } from './config.ts';
import type { Corpus } from './corpus.ts';
import { planQuery } from './plan.ts';
import { retrieve, type RetrievalResult } from './retrieve.ts';

export interface EvalExpect {
  categorias?: string[];
  idiomas?: string[];
  gruposDePais?: string[];
  exigeGrade?: boolean;
  temporalAgora?: boolean;
  minCandidatos?: number;
  maxCandidatos?: number;
  deveConter?: string[];
  naoDeveConter?: string[];
  abstencoes?: ('availability' | 'programme')[];
  /** Veredito de disponibilidade admissivel para TODO candidato retornado. */
  disponibilidadeEm?: string[];
  /** Veredito de grade admissivel para TODO candidato retornado. */
  gradeEm?: string[];
  /** Veredito de disponibilidade exigido para canais especificos. */
  vereditoPorCanal?: Record<string, string>;
}

export interface EvalCase {
  id: string;
  pergunta: string;
  porque: string;
  vantage?: string;
  /** Desloca o instante da avaliacao para medir o decaimento da evidencia. */
  horasNoFuturo?: number;
  espera: EvalExpect;
}

export interface EvalSet {
  comment?: string[];
  /** Piso de acerto de verificacoes que o teste automatizado exige. */
  minimoDeAcertoPercent: number;
  casos: EvalCase[];
}

export interface Check {
  nome: string;
  ok: boolean;
  detalhe: string;
}

export interface CaseResult {
  id: string;
  pergunta: string;
  porque: string;
  /** Instante usado neste caso, ja com o deslocamento de `horasNoFuturo`. */
  nowDoCaso: string;
  aprovado: boolean;
  verificacoes: Check[];
  candidatos: {
    tvgId: string;
    nome: string;
    disponibilidade: string;
    grade: string;
    pontoDeObservacao: string | null;
  }[];
  abstencoes: string[];
}

export interface EvalReport {
  geradoEm: string;
  nowUsado: string;
  corpus: {
    metadadosGeradosEm: string;
    gradeGeradaEm: string | null;
    canaisIndexados: number;
    canaisComGrade: number;
    coberturaDaGradePercent: number;
  };
  casos: CaseResult[];
  totais: {
    casos: number;
    casosAprovados: number;
    verificacoes: number;
    verificacoesAprovadas: number;
    acertoDeCasosPercent: number;
    acertoDeVerificacoesPercent: number;
  };
}

export function loadEvalSet(path = 'config/eval.json'): EvalSet {
  return JSON.parse(readFileSync(resolve(ROOT, path), 'utf8')) as EvalSet;
}

function sameSet(actual: string[], expected: string[]): boolean {
  const a = [...new Set(actual)].sort();
  const b = [...new Set(expected)].sort();
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function checkCase(
  rag: RagConfig,
  tax: Taxonomy,
  corpus: Corpus,
  cfg: Config,
  c: EvalCase,
  now: number,
): CaseResult {
  const query = planQuery(rag, tax, c.pergunta, { vantage: c.vantage ?? cfg.vantage });
  const at = now + (c.horasNoFuturo ?? 0) * 3_600_000;
  const result: RetrievalResult = retrieve(rag, corpus, query, at);
  const e = c.espera;
  const checks: Check[] = [];
  const ids = result.candidates.map((x) => x.channel.tvgId);

  const plano: [string, string[] | undefined, string[]][] = [
    ['plano.categorias', e.categorias, query.categories],
    ['plano.idiomas', e.idiomas, query.languages],
    ['plano.gruposDePais', e.gruposDePais, query.countryGroups],
  ];
  for (const [nome, expected, actual] of plano) {
    if (expected === undefined) continue;
    const ok = sameSet(actual, expected);
    checks.push({ nome, ok, detalhe: `esperado [${expected}], obtido [${actual}]` });
  }
  if (e.exigeGrade !== undefined) {
    checks.push({
      nome: 'plano.exigeGrade',
      ok: query.requireGuide === e.exigeGrade,
      detalhe: `esperado ${e.exigeGrade}, obtido ${query.requireGuide}`,
    });
  }
  if (e.temporalAgora !== undefined) {
    checks.push({
      nome: 'plano.temporalAgora',
      ok: query.temporalNow === e.temporalAgora,
      detalhe: `esperado ${e.temporalAgora}, obtido ${query.temporalNow}`,
    });
  }
  if (e.minCandidatos !== undefined) {
    checks.push({
      nome: 'recuperacao.minCandidatos',
      ok: ids.length >= e.minCandidatos,
      detalhe: `esperado >= ${e.minCandidatos}, obtido ${ids.length}`,
    });
  }
  if (e.maxCandidatos !== undefined) {
    checks.push({
      nome: 'recuperacao.maxCandidatos',
      ok: ids.length <= e.maxCandidatos,
      detalhe: `esperado <= ${e.maxCandidatos}, obtido ${ids.length}`,
    });
  }
  if (e.deveConter) {
    const missing = e.deveConter.filter((id) => !ids.includes(id));
    checks.push({
      nome: 'recuperacao.deveConter',
      ok: missing.length === 0,
      detalhe: missing.length ? `faltou [${missing}]` : 'todos presentes',
    });
  }
  if (e.naoDeveConter) {
    const present = e.naoDeveConter.filter((id) => ids.includes(id));
    checks.push({
      nome: 'recuperacao.naoDeveConter',
      ok: present.length === 0,
      detalhe: present.length ? `apareceu [${present}]` : 'nenhum apareceu',
    });
  }
  if (e.abstencoes) {
    const kinds = result.abstentions.map((a) => a.kind);
    checks.push({
      nome: 'abstencao',
      ok: sameSet(kinds, e.abstencoes),
      detalhe: `esperado [${e.abstencoes}], obtido [${kinds}]`,
    });
  }
  if (e.disponibilidadeEm) {
    const bad = result.candidates
      .filter((x) => !e.disponibilidadeEm!.includes(x.availability.verdict))
      .map((x) => `${x.channel.tvgId}=${x.availability.verdict}`);
    checks.push({
      nome: 'evidencia.disponibilidade',
      ok: bad.length === 0,
      detalhe: bad.length ? `fora do esperado: ${bad.join(', ')}` : `todos em [${e.disponibilidadeEm}]`,
    });
  }
  if (e.gradeEm) {
    const bad = result.candidates
      .filter((x) => !e.gradeEm!.includes(x.programme.verdict))
      .map((x) => `${x.channel.tvgId}=${x.programme.verdict}`);
    checks.push({
      nome: 'evidencia.grade',
      ok: bad.length === 0,
      detalhe: bad.length ? `fora do esperado: ${bad.join(', ')}` : `todos em [${e.gradeEm}]`,
    });
  }

  if (e.vereditoPorCanal) {
    for (const [tvgId, expected] of Object.entries(e.vereditoPorCanal)) {
      const found = result.candidates.find((x) => x.channel.tvgId === tvgId);
      checks.push({
        nome: `evidencia.veredito[${tvgId}]`,
        ok: found?.availability.verdict === expected,
        detalhe: `esperado ${expected}, obtido ${found?.availability.verdict ?? '(nao recuperado)'}`,
      });
    }
  }

  return {
    id: c.id,
    pergunta: c.pergunta,
    porque: c.porque,
    nowDoCaso: new Date(at).toISOString(),
    aprovado: checks.every((x) => x.ok),
    verificacoes: checks,
    candidatos: result.candidates.map((x) => ({
      tvgId: x.channel.tvgId,
      nome: x.channel.name,
      disponibilidade: x.availability.verdict,
      grade: x.programme.verdict,
      pontoDeObservacao: x.availability.vantage,
    })),
    abstencoes: result.abstentions.map((a) => `${a.kind}: ${a.reason}`),
  };
}

export function runEval(
  cfg: Config,
  rag: RagConfig,
  tax: Taxonomy,
  corpus: Corpus,
  set: EvalSet,
  now: number,
): EvalReport {
  const casos = set.casos.map((c) => checkCase(rag, tax, corpus, cfg, c, now));
  const verificacoes = casos.reduce((n, c) => n + c.verificacoes.length, 0);
  const verificacoesAprovadas = casos.reduce(
    (n, c) => n + c.verificacoes.filter((x) => x.ok).length,
    0,
  );
  const casosAprovados = casos.filter((c) => c.aprovado).length;
  const pct = (part: number, total: number) =>
    total === 0 ? 0 : Number(((part / total) * 100).toFixed(2));

  return {
    geradoEm: new Date().toISOString(),
    nowUsado: new Date(now).toISOString(),
    corpus: {
      metadadosGeradosEm: corpus.stats.channelsGeneratedAt,
      gradeGeradaEm: corpus.stats.guideGeneratedAt,
      canaisIndexados: corpus.stats.channelsIndexed,
      canaisComGrade: corpus.stats.channelsWithGuide,
      coberturaDaGradePercent: corpus.stats.guideCoveragePercent,
    },
    casos,
    totais: {
      casos: casos.length,
      casosAprovados,
      verificacoes,
      verificacoesAprovadas,
      acertoDeCasosPercent: pct(casosAprovados, casos.length),
      acertoDeVerificacoesPercent: pct(verificacoesAprovadas, verificacoes),
    },
  };
}

export function formatReport(report: EvalReport): string {
  const lines: string[] = [];
  for (const c of report.casos) {
    lines.push(`${c.aprovado ? 'OK  ' : 'FALHA'} ${c.id}: ${c.pergunta}`);
    for (const v of c.verificacoes) {
      if (!v.ok) lines.push(`      ${v.nome}: ${v.detalhe}`);
    }
  }
  const t = report.totais;
  lines.push('');
  lines.push(`now usado: ${report.nowUsado}`);
  lines.push(
    `casos: ${t.casosAprovados}/${t.casos} (${t.acertoDeCasosPercent}%) | ` +
      `verificacoes: ${t.verificacoesAprovadas}/${t.verificacoes} (${t.acertoDeVerificacoesPercent}%)`,
  );
  return lines.join('\n');
}
