/**
 * Traduz a pergunta em linguagem natural para uma consulta estruturada.
 *
 * E deterministico e offline de proposito: o filtro estrutural (pais, categoria,
 * idioma, ponto de observacao, janela de horario) e o que torna a recuperacao
 * depuravel e pontuavel. O modelo entra depois, para redigir a resposta sobre a
 * evidencia recuperada — nao para decidir o que recuperar.
 */

import type { RagConfig, Taxonomy } from './config.ts';
import { fold, tokenize } from './lexical.ts';
import { tokenizeOptions } from './corpus.ts';

export interface Query {
  question: string;
  /** Texto livre que sobrou depois de extrair os filtros; vai para o BM25. */
  text: string;
  terms: string[];
  countryGroups: string[];
  categories: string[];
  languages: string[];
  /** A pergunta e sobre a grade ('o que esta passando'), nao so sobre disponibilidade. */
  requireGuide: boolean;
  temporalNow: boolean;
  /** A pergunta e explicitamente sobre o stream abrir ('funciona?', 'esta no ar?'). */
  availabilityIntent: boolean;
  /** Exige evidencia valida de que o stream abre. Falso so quando a pergunta e de catalogo. */
  requireAvailable: boolean;
  vantage: string;
  limit: number;
  tvgIds: string[];
  /** Termos do lexico que casaram, para explicar por que o filtro ficou assim. */
  matched: string[];
}

export interface PlanDefaults {
  vantage: string;
  limit?: number;
  requireAvailable?: boolean;
}

const TVG_ID = /[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9._-]+/g;

/** Termo de uma palavra casa por token; frase casa por substring. */
function hit(folded: string, tokens: Set<string>, term: string): boolean {
  const t = fold(term).trim();
  if (!t) return false;
  return t.includes(' ') ? folded.includes(t) : tokens.has(t);
}

function matchGroup(
  folded: string,
  tokens: Set<string>,
  groups: Record<string, string[]>,
  matched: string[],
): string[] {
  const found: string[] = [];
  for (const [code, terms] of Object.entries(groups)) {
    for (const term of terms) {
      if (!hit(folded, tokens, term)) continue;
      found.push(code);
      matched.push(`${code}:${term}`);
      break;
    }
  }
  return found;
}

export function planQuery(
  rag: RagConfig,
  tax: Taxonomy,
  question: string,
  defaults: PlanDefaults,
): Query {
  const lex = rag.lexicon;
  const folded = fold(question);
  // Tokens crus (sem remover stopword) para o casamento do lexico: 'no ar' depende do 'no'.
  const rawTokens = new Set(folded.split(/[^a-z0-9]+/).filter(Boolean));
  const matched: string[] = [];

  const countryGroups = matchGroup(folded, rawTokens, lex.countryGroups, matched);
  const categories = matchGroup(folded, rawTokens, lex.categories, matched);
  const languages = matchGroup(folded, rawTokens, lex.languages, matched);

  // Termo de intencao tambem sai do texto livre: 'funciona' e pedido de evidencia,
  // nao nome de canal, e deixado no BM25 so traria ruido.
  const temporalNow = lex.temporalNow.some((t) => hit(folded, rawTokens, t));
  const requireGuide = lex.guideIntent.some((t) => hit(folded, rawTokens, t));
  const availabilityIntent = lex.availabilityIntent.some((t) => hit(folded, rawTokens, t));
  for (const t of lex.temporalNow) if (hit(folded, rawTokens, t)) matched.push(`agora:${t}`);
  for (const t of lex.guideIntent) if (hit(folded, rawTokens, t)) matched.push(`grade:${t}`);
  for (const t of lex.availabilityIntent) if (hit(folded, rawTokens, t)) matched.push(`evidencia:${t}`);
  for (const t of lex.vantageHere) if (hit(folded, rawTokens, t)) matched.push(`ponto:${t}`);

  // Grupos e categorias validos sao os da taxonomia; lexico fora dela e ignorado.
  const validGroups = new Set(tax.countryGroups.map((g) => g.code));
  const validCategories = new Set(tax.categories.map((c) => c.code));

  // O texto livre e o que sobra depois de tirar os termos que ja viraram filtro.
  const tvgIds = [...new Set(question.match(TVG_ID) ?? [])];
  let residual = folded;
  for (const term of matched) {
    const value = fold(term.slice(term.indexOf(':') + 1));
    residual = residual.split(value).join(' ');
  }
  // tvg-id citado e filtro exato: nao precisa voltar como texto livre.
  for (const id of tvgIds) residual = residual.split(fold(id)).join(' ');
  const terms = tokenize(residual, tokenizeOptions(rag));

  const limit = Math.min(
    Math.max(defaults.limit ?? rag.retrieval.defaultLimit, 1),
    rag.retrieval.maxLimit,
  );

  return {
    question,
    text: terms.join(' '),
    terms,
    countryGroups: countryGroups.filter((c) => validGroups.has(c)),
    categories: categories.filter((c) => validCategories.has(c)),
    languages,
    requireGuide,
    temporalNow,
    availabilityIntent,
    // Sem pedido explicito, assume-se que quem pergunta quer canal que abre: o modo
    // de falha a derrotar e recomendar com confianca um stream que nao toca.
    requireAvailable: defaults.requireAvailable ?? true,
    vantage: defaults.vantage,
    limit,
    tvgIds,
    matched,
  };
}
