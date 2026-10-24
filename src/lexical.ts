/**
 * Indice lexical BM25, escrito a mao e sem dependencia.
 *
 * O corpus tem ~12 mil canais e ~6 mil programas: cabe inteiro na memoria e e
 * indexado em milissegundos. Banco vetorial aqui custaria mais, responderia mais
 * devagar e, pior para a pesquisa, nao seria depuravel — num indice de termos da
 * para apontar exatamente qual palavra trouxe qual canal. Se a medicao de
 * recuperacao mostrar que isso nao basta, o numero justifica trocar; antes dela,
 * nao.
 */

export interface TokenizeOptions {
  minLength: number;
  stopwords: Set<string>;
}

/** Minuscula e sem acento: 'Notícia' e 'noticia' sao o mesmo termo. */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export function tokenize(text: string, opts: TokenizeOptions): string[] {
  const out: string[] = [];
  for (const raw of fold(text).split(/[^a-z0-9]+/)) {
    if (raw.length < opts.minLength) continue;
    if (opts.stopwords.has(raw)) continue;
    out.push(raw);
  }
  return out;
}

export interface IndexField {
  text: string;
  /** Peso do campo: nome do canal pesa mais que a lista de idiomas. */
  weight: number;
}

export interface IndexDoc {
  id: string;
  fields: IndexField[];
}

export interface LexicalIndex {
  ids: string[];
  /** Comprimento ponderado de cada documento, usado na normalizacao do BM25. */
  lengths: number[];
  avgLength: number;
  postings: Map<string, { doc: number; tf: number }[]>;
}

export function buildIndex(docs: IndexDoc[], opts: TokenizeOptions): LexicalIndex {
  const ids: string[] = [];
  const lengths: number[] = [];
  const postings = new Map<string, { doc: number; tf: number }[]>();

  docs.forEach((doc, i) => {
    ids.push(doc.id);
    const tf = new Map<string, number>();
    let length = 0;
    for (const field of doc.fields) {
      for (const term of tokenize(field.text, opts)) {
        tf.set(term, (tf.get(term) ?? 0) + field.weight);
        length += field.weight;
      }
    }
    lengths.push(length);
    for (const [term, n] of tf) {
      const list = postings.get(term);
      if (list) list.push({ doc: i, tf: n });
      else postings.set(term, [{ doc: i, tf: n }]);
    }
  });

  const total = lengths.reduce((a, b) => a + b, 0);
  return { ids, lengths, avgLength: ids.length ? total / ids.length : 0, postings };
}

export interface SearchOptions {
  k1: number;
  b: number;
  /** Restringe a busca a esses ids. Vazio ou ausente: busca em tudo. */
  allow?: Set<string>;
}

export interface SearchHit {
  id: string;
  score: number;
}

export function searchIndex(
  index: LexicalIndex,
  queryTerms: string[],
  opts: SearchOptions,
): SearchHit[] {
  const n = index.ids.length;
  if (n === 0 || queryTerms.length === 0) return [];
  const scores = new Map<number, number>();

  for (const term of new Set(queryTerms)) {
    const list = index.postings.get(term);
    if (!list) continue;
    const df = list.length;
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
    for (const { doc, tf } of list) {
      const id = index.ids[doc];
      if (opts.allow && (id === undefined || !opts.allow.has(id))) continue;
      const dl = index.lengths[doc] ?? 0;
      const norm = tf + opts.k1 * (1 - opts.b + (opts.b * dl) / (index.avgLength || 1));
      const add = (idf * (tf * (opts.k1 + 1))) / (norm || 1);
      scores.set(doc, (scores.get(doc) ?? 0) + add);
    }
  }

  const hits: SearchHit[] = [];
  for (const [doc, score] of scores) {
    const id = index.ids[doc];
    if (id !== undefined) hits.push({ id, score });
  }
  // Empate resolvido pelo id: a ordem precisa ser estavel para a avaliacao pontuar.
  hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return hits;
}
