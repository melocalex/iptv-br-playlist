/** Leitura e escrita de M3U estendida, preservando todo atributo da fonte. */

export interface M3uEntry {
  /** Atributos do #EXTINF, na ordem em que apareceram. */
  attrs: Record<string, string>;
  /** Nome exibido: o texto depois da ultima virgula do #EXTINF. Preservado como veio. */
  name: string;
  /** Duracao declarada; o iptv-org usa -1. */
  duration: string;
  /** Diretivas entre o #EXTINF e a URL (#EXTVLCOPT, #EXTGRP, #KODIPROP...). */
  directives: string[];
  url: string;
}

export interface M3uDocument {
  /** Atributos do cabecalho #EXTM3U (ex.: url-tvg, x-tvg-url). */
  header: Record<string, string>;
  entries: M3uEntry[];
}

const ATTR_RE = /([A-Za-z0-9_-]+)="([^"]*)"/g;

/**
 * Posicao da virgula que separa atributos do nome exibido: a PRIMEIRA fora de aspas.
 * Nao da para usar a ultima: nome de canal pode ter virgula ("Globo, SP").
 * Nem a primeira qualquer: valor de atributo pode ter virgula (group-title="A,B").
 */
function splitIndex(body: string): number {
  let inQuotes = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ',' && !inQuotes) return i;
  }
  return -1;
}

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(ATTR_RE)) {
    const k = m[1];
    const v = m[2];
    if (k !== undefined && v !== undefined) out[k] = v;
  }
  return out;
}

export function parseM3u(text: string): M3uDocument {
  const lines = text.split(/\r?\n/);
  const doc: M3uDocument = { header: {}, entries: [] };
  let pending: Omit<M3uEntry, 'url'> | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') continue;

    if (line.startsWith('#EXTM3U')) {
      doc.header = { ...doc.header, ...parseAttrs(line) };
      continue;
    }

    if (line.startsWith('#EXTINF:')) {
      const body = line.slice('#EXTINF:'.length);
      const comma = splitIndex(body);
      const head = comma === -1 ? body : body.slice(0, comma);
      const name = comma === -1 ? '' : body.slice(comma + 1);
      const durMatch = /^\s*(-?[0-9.]+)/.exec(head);
      pending = {
        duration: durMatch?.[1] ?? '-1',
        attrs: parseAttrs(head),
        name,
        directives: [],
      };
      continue;
    }

    if (line.startsWith('#')) {
      if (pending) pending.directives.push(line);
      continue;
    }

    if (pending) {
      doc.entries.push({ ...pending, url: line });
      pending = null;
    }
  }
  return doc;
}

function attrString(attrs: Record<string, string>): string {
  return Object.entries(attrs)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}="${v.replace(/"/g, '')}"`)
    .join(' ');
}

export function serializeM3u(doc: M3uDocument): string {
  const out: string[] = [];
  const head = attrString(doc.header);
  out.push(head ? `#EXTM3U ${head}` : '#EXTM3U');
  for (const e of doc.entries) {
    const a = attrString(e.attrs);
    out.push(`#EXTINF:${e.duration}${a ? ' ' + a : ''},${e.name}`);
    for (const d of e.directives) out.push(d);
    out.push(e.url);
  }
  return out.join('\n') + '\n';
}
