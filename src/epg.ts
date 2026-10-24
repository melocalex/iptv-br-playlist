import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { ROOT, outPath, type Config, type EpgConfig } from './config.ts';
import { fetchCached } from './http.ts';
import type { Channel } from './catalog.ts';
import { info, warn, error } from './log.ts';

export interface Programme {
  channel: string;
  start: string;
  stop: string;
  xml: string;
}

export interface EpgResult {
  /** tvg-id -> numero de programas no guia final. */
  index: Map<string, number>;
  channelsInGuide: number;
  programmes: number;
  horizonHours: number;
  generatedAt: string;
  sources: {
    id: string;
    kind: 'grabber' | 'published';
    ok: boolean;
    requestedChannels: number;
    channelsWithProgrammes: number;
    programmes: number;
    note: string | null;
  }[];
  /** Canais da playlist que ficaram sem grade. Publicado como lacuna medida. */
  missing: { tvgId: string; name: string; countryGroup: string; guideSites: string[] }[];
  dropped: {
    duplicates: number;
    outOfHorizon: number;
    invalidTimestamp: number;
    unknownChannel: number;
    malformed: number;
  };
}

const XMLTV_TS = /^(\d{14})(\s*[+-]\d{4})?$/;

/** Converte timestamp XMLTV para epoch ms. Devolve null quando nao for valido. */
export function parseXmltvTime(s: string): number | null {
  const m = XMLTV_TS.exec(s.trim());
  if (!m) return null;
  const d = m[1]!;
  const year = Number(d.slice(0, 4));
  const month = Number(d.slice(4, 6));
  const day = Number(d.slice(6, 8));
  const hour = Number(d.slice(8, 10));
  const min = Number(d.slice(10, 12));
  const sec = Number(d.slice(12, 14));
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || min > 59 || sec > 59) {
    return null;
  }
  const offset = m[2]?.trim();
  let offsetMinutes = 0;
  if (offset) {
    const sign = offset[0] === '-' ? -1 : 1;
    offsetMinutes = sign * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(3, 5)));
  }
  return Date.UTC(year, month - 1, day, hour, min, sec) - offsetMinutes * 60_000;
}

/** Normaliza para o formato XMLTV canonico: 'YYYYMMDDHHMMSS +0000'. */
export function formatXmltvTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())} +0000`
  );
}

function attrOf(tag: string, name: string): string | null {
  const m = new RegExp(`${name}="([^"]*)"`).exec(tag);
  return m?.[1] ?? null;
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Desfaz as entidades do texto lido cru de um XML. Sem isso, um nome como 'A&amp;E'
 * passaria por escapeXml e sairia 'A&amp;amp;E' no guia publicado.
 */
export function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

/**
 * Extrai blocos <programme> de um XMLTV. XMLTV e gerado por maquina e muito regular,
 * por isso a varredura por bloco e suficiente e evita carregar um DOM de dezenas de MB.
 */
export function extractProgrammes(xml: string): { channel: string; start: string; stop: string; inner: string }[] {
  const out: { channel: string; start: string; stop: string; inner: string }[] = [];
  const re = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/g;
  for (const m of xml.matchAll(re)) {
    const tag = m[1] ?? '';
    const channel = attrOf(tag, 'channel');
    const start = attrOf(tag, 'start');
    const stop = attrOf(tag, 'stop');
    if (!channel || !start) continue;
    out.push({ channel, start, stop: stop ?? '', inner: m[2] ?? '' });
  }
  return out;
}

/**
 * Elementos filhos que reemitimos, com os atributos que cada um conserva.
 * O que nao esta aqui e descartado: perde-se <credits>, <rating> e <star-rating>,
 * que sao aninhados. A spec pede titulo, descricao, inicio e fim, e esses ficam.
 */
const PROGRAMME_CHILDREN: Record<string, string[]> = {
  title: ['lang'],
  'sub-title': ['lang'],
  desc: ['lang'],
  category: ['lang'],
  country: ['lang'],
  language: ['lang'],
  'orig-language': ['lang'],
  date: [],
  'episode-num': ['system'],
  length: ['units'],
  icon: ['src'],
};

const CHANNEL_CHILDREN: Record<string, string[]> = {
  'display-name': ['lang'],
  icon: ['src'],
  url: [],
};

function attrValue(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}="([^"]*)"`, 'i').exec(tag);
  return m?.[1] ?? null;
}

function safeIconSrc(v: string): string | null {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:' ? v : null;
  } catch {
    return null;
  }
}

/**
 * Reconstroi os filhos de um bloco XMLTV a partir dos valores extraidos, reescapando
 * tudo, em vez de copiar o conteudo cru da fonte.
 *
 * Copiar cru exigiria confiar que a fonte emite XML bem formado, e nenhuma denylist
 * de padroes perigosos resolve isso: '<title>sem fechar' ou '</programme >' passariam
 * por qualquer regex de bloqueio e sairiam no guia publicado, quebrando o player de
 * quem consome. Reconstruindo, o arquivo final e bem formado por construcao.
 */
export function rebuildChildren(inner: string, allowed: Record<string, string[]>): string {
  const out: string[] = [];
  for (const [name, attrs] of Object.entries(allowed)) {
    const paired = new RegExp(`<${name}\\b([^>]*)>([\\s\\S]*?)</${name}\\s*>`, 'gi');
    const selfClosing = new RegExp(`<${name}\\b([^>]*?)/>`, 'gi');
    const emit = (tag: string, text: string | null): void => {
      const parts: string[] = [];
      for (const a of attrs) {
        const raw = attrValue(tag, a);
        if (raw === null) continue;
        const value = unescapeXml(raw);
        if (a === 'src') {
          const safe = safeIconSrc(value);
          if (!safe) return;
          parts.push(`src="${escapeXml(safe)}"`);
          continue;
        }
        parts.push(`${a}="${escapeXml(value)}"`);
      }
      const head = `${name}${parts.length ? ' ' + parts.join(' ') : ''}`;
      if (text === null) {
        out.push(`<${head} />`);
        return;
      }
      // Texto cru da fonte: decodifica e reescapa, para nao gerar escape duplo
      // nem deixar passar '<' solto.
      const clean = escapeXml(unescapeXml(text.replace(/<[^>]*>/g, '').trim()));
      if (!clean) return;
      out.push(`<${head}>${clean}</${name}>`);
    };
    for (const m of inner.matchAll(paired)) emit(m[1] ?? '', m[2] ?? '');
    for (const m of inner.matchAll(selfClosing)) emit(m[1] ?? '', null);
  }
  return out.join('');
}

/** Checagem de boa formacao suficiente para XMLTV: tags pareadas e nada solto. */
export function isBalancedXml(xml: string): boolean {
  const stack: string[] = [];
  const re = /<(\/?)([A-Za-z][\w:-]*)\b([^>]*?)(\/?)>/g;
  let consumed = 0;
  for (const m of xml.matchAll(re)) {
    const between = xml.slice(consumed, m.index);
    if (between.includes('<')) return false;
    consumed = m.index + m[0].length;
    const closing = m[1] === '/';
    const name = m[2]!;
    const self = m[4] === '/';
    if (self) continue;
    if (closing) {
      if (stack.pop() !== name) return false;
    } else {
      stack.push(name);
    }
  }
  return stack.length === 0 && !xml.slice(consumed).includes('<');
}

export function extractGuideChannels(xml: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /<channel\b([^>]*)>([\s\S]*?)<\/channel>/g;
  for (const m of xml.matchAll(re)) {
    const id = attrOf(m[1] ?? '', 'id');
    if (id) out.set(id, m[2] ?? '');
  }
  return out;
}

interface SiteChannelRow {
  site: string;
  siteId: string;
  lang: string;
  xmltvId: string;
  name: string;
}

/** Le os sites/<site>/*.channels.xml do grabber e devolve as linhas com xmltv_id preenchido. */
function readSiteChannels(grabberDir: string, site: string): SiteChannelRow[] {
  const dir = resolve(grabberDir, 'sites', site);
  if (!existsSync(dir)) return [];
  const rows: SiteChannelRow[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.channels.xml')) continue;
    const xml = readFileSync(resolve(dir, file), 'utf8');
    const re = /<channel\b([^>]*)>([\s\S]*?)<\/channel>/g;
    for (const m of xml.matchAll(re)) {
      const tag = m[1] ?? '';
      const xmltvId = attrOf(tag, 'xmltv_id');
      const siteId = attrOf(tag, 'site_id');
      if (!xmltvId || !siteId) continue;
      rows.push({
        site: attrOf(tag, 'site') ?? site,
        siteId,
        lang: attrOf(tag, 'lang') ?? 'en',
        xmltvId,
        // Texto cru do XML: decodifica aqui, porque e reescapado na escrita.
        name: unescapeXml((m[2] ?? '').trim()),
      });
    }
  }
  return rows;
}

function run(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.killed || child.kill('SIGKILL'), 5000);
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr, timedOut });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolvePromise({ code: -1, stdout, stderr: stderr + String(err), timedOut });
    });
  });
}

async function ensureGrabber(cfg: Config): Promise<string | null> {
  const dir = resolve(ROOT, cfg.epg.grabberDir);
  const ref = cfg.epg.grabberRef;
  const isSha = /^[0-9a-f]{40}$/i.test(ref);
  if (!isSha) {
    // Ref movel significa executar codigo de terceiro que pode mudar entre execucoes.
    warn(`epg.grabberRef '${ref}' nao e um commit SHA: o codigo do grabber pode mudar sem aviso`);
  }
  // O diretorio pode vir do cache do Actions, ou seja, de fora desta execucao.
  // Entao o pin e conferido SEMPRE, nao so no clone: HEAD igual ao SHA e arvore limpa.
  // Qualquer divergencia descarta o diretorio e refaz do zero.
  if (existsSync(resolve(dir, 'package.json'))) {
    const head = await run('git', ['rev-parse', 'HEAD'], dir, 60_000);
    const dirty = await run('git', ['status', '--porcelain'], dir, 60_000);
    const got = head.stdout.trim();
    const modified = dirty.stdout.trim();
    const mismatch = isSha && got.toLowerCase() !== ref.toLowerCase();
    if (head.code !== 0 || mismatch || modified !== '') {
      warn(
        `grabber em cache rejeitado (HEAD=${got || 'desconhecido'}, ref=${ref}` +
          `${modified ? `, ${modified.split('\n').length} arquivo(s) alterado(s)` : ''}); refazendo`,
      );
      rmSync(dir, { recursive: true, force: true });
    } else {
      info(`grabber em cache aceito: HEAD ${got}, arvore limpa`);
    }
  }

  if (!existsSync(resolve(dir, 'package.json'))) {
    info(`clonando grabber ${cfg.epg.grabberRepo} em ${cfg.epg.grabberDir} (ref ${ref})`);
    mkdirSync(dirname(dir), { recursive: true });
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    // SHA fixo nao da para passar em 'clone -b'; busca rasa do commit exato.
    const steps: string[][] = isSha
      ? [
          ['init', '-q'],
          ['remote', 'add', 'origin', cfg.epg.grabberRepo],
          ['fetch', '-q', '--depth', '1', 'origin', ref],
          ['checkout', '-q', 'FETCH_HEAD'],
        ]
      : [['clone', '--depth', '1', '-b', ref, cfg.epg.grabberRepo, '.']];
    for (const args of steps) {
      const r = await run('git', args, dir, cfg.epg.grabTimeoutMs);
      if (r.code !== 0) {
        error(`grabber: 'git ${args[0]}' falhou: ${r.stderr.slice(0, 400)}`);
        return null;
      }
    }
    const head = await run('git', ['rev-parse', 'HEAD'], dir, 60_000);
    const got = head.stdout.trim();
    if (isSha && got.toLowerCase() !== ref.toLowerCase()) {
      error(`grabber: HEAD ${got} nao e o ref fixado ${ref}`);
      return null;
    }
    info(`grabber em ${got}`);
  }
  if (!existsSync(resolve(dir, 'node_modules'))) {
    info('instalando dependencias do grabber (uma vez)');
    const inst = await run(
      'npm',
      ['install', '--omit=dev', '--no-audit', '--no-fund'],
      dir,
      cfg.epg.grabTimeoutMs,
    );
    if (inst.code !== 0) {
      error(`npm install do grabber falhou: ${inst.stderr.slice(0, 600)}`);
      return null;
    }
  }
  return dir;
}

export async function buildEpg(
  cfg: Config,
  epgCfg: EpgConfig,
  channels: Channel[],
  wanted: Set<string>,
): Promise<EpgResult> {
  const generatedAt = new Date().toISOString();
  const sources: EpgResult['sources'] = [];
  const byChannel = new Map<string, Channel>();
  for (const ch of channels) if (ch.tvgId) byChannel.set(ch.tvgId, ch);

  const guideChannels = new Map<string, string>();
  const programmes = new Map<string, Programme>();
  const dropped = { duplicates: 0, outOfHorizon: 0, invalidTimestamp: 0, unknownChannel: 0, malformed: 0 };
  const now = Date.now();
  const horizonEnd = now + cfg.epg.programmeHorizonHours * 3600_000;

  const ingest = (xml: string, sourceId: string): { chans: number; progs: number } => {
    for (const [id, inner] of extractGuideChannels(xml)) {
      if (wanted.has(id) && !guideChannels.has(id)) guideChannels.set(id, inner);
    }
    let progs = 0;
    const touched = new Set<string>();
    for (const p of extractProgrammes(xml)) {
      if (!wanted.has(p.channel)) {
        dropped.unknownChannel++;
        continue;
      }
      const children = rebuildChildren(p.inner, PROGRAMME_CHILDREN);
      if (!children) {
        // Nada reaproveitavel: sem titulo nem descricao nao ha grade para publicar.
        dropped.malformed++;
        continue;
      }
      const startMs = parseXmltvTime(p.start);
      const stopMs = p.stop ? parseXmltvTime(p.stop) : null;
      if (startMs === null) {
        dropped.invalidTimestamp++;
        continue;
      }
      // Grade passada nao serve e so infla o arquivo; horizonte vem da config.
      const endMs = stopMs ?? startMs;
      if (endMs < now || startMs > horizonEnd) {
        dropped.outOfHorizon++;
        continue;
      }
      const start = formatXmltvTime(startMs);
      const stop = stopMs === null ? start : formatXmltvTime(stopMs);
      const key = `${p.channel}|${start}|${stop}`;
      if (programmes.has(key)) {
        dropped.duplicates++;
        continue;
      }
      programmes.set(key, {
        channel: p.channel,
        start,
        stop,
        xml:
          `  <programme start="${start}" stop="${stop}" channel="${escapeXml(p.channel)}">` +
          `${children}</programme>`,
      });
      touched.add(p.channel);
      progs++;
    }
    return { chans: touched.size, progs };
  };

  // --- caminho primario: grabber do iptv-org -------------------------------
  if (cfg.epg.enabled) {
    const dir = await ensureGrabber(cfg);
    if (!dir) {
      sources.push({
        id: 'iptv-org-grabber',
        kind: 'grabber',
        ok: false,
        requestedChannels: 0,
        channelsWithProgrammes: 0,
        programmes: 0,
        note: 'grabber indisponivel (clone ou install falhou)',
      });
    } else {
      const tmpDir = resolve(ROOT, 'tmp', 'epg');
      mkdirSync(tmpDir, { recursive: true });
      for (const site of epgCfg.grabberSites.filter((s) => s.enabled)) {
        const rows = readSiteChannels(dir, site.site).filter((r) => wanted.has(r.xmltvId));
        const unique = new Map(rows.map((r) => [`${r.xmltvId}|${r.siteId}`, r]));
        const slice = [...unique.values()].slice(0, cfg.epg.maxChannelsPerSite);
        if (slice.length === 0) {
          sources.push({
            id: site.site,
            kind: 'grabber',
            ok: true,
            requestedChannels: 0,
            channelsWithProgrammes: 0,
            programmes: 0,
            note: 'nenhum canal da playlist coberto por este site',
          });
          continue;
        }
        const chanFile = resolve(tmpDir, `${site.site}.channels.xml`);
        writeFileSync(
          chanFile,
          '<?xml version="1.0" encoding="UTF-8"?>\n<channels>\n' +
            slice
              .map(
                (r) =>
                  `  <channel site="${escapeXml(r.site)}" lang="${escapeXml(r.lang)}" ` +
                  `xmltv_id="${escapeXml(r.xmltvId)}" site_id="${escapeXml(r.siteId)}">` +
                  `${escapeXml(r.name)}</channel>`,
              )
              .join('\n') +
            '\n</channels>\n',
        );
        const outFile = resolve(tmpDir, `${site.site}.guide.xml`);
        rmSync(outFile, { force: true });
        info(`grabbing ${site.site}: ${slice.length} canais, ${cfg.epg.days} dia(s)`);
        const r = await run(
          'npm',
          [
            'run',
            'grab',
            '---',
            `--channels=${chanFile}`,
            `--output=${outFile}`,
            `--maxConnections=${cfg.epg.maxConnections}`,
            `--days=${cfg.epg.days}`,
            `--timeout=${cfg.epg.requestTimeoutMs}`,
          ],
          dir,
          cfg.epg.grabTimeoutMs,
        );
        if (!existsSync(outFile)) {
          warn(`grab de ${site.site} nao gerou arquivo (code=${r.code}, timeout=${r.timedOut})`);
          sources.push({
            id: site.site,
            kind: 'grabber',
            ok: false,
            requestedChannels: slice.length,
            channelsWithProgrammes: 0,
            programmes: 0,
            note: r.timedOut
              ? 'estourou grabTimeoutMs'
              : (r.stderr || r.stdout).slice(-300).replace(/\s+/g, ' ').trim() || 'sem saida',
          });
          continue;
        }
        const got = ingest(readFileSync(outFile, 'utf8'), site.site);
        info(`${site.site}: ${got.progs} programas em ${got.chans} canais`);
        sources.push({
          id: site.site,
          kind: 'grabber',
          ok: true,
          requestedChannels: slice.length,
          channelsWithProgrammes: got.chans,
          programmes: got.progs,
          note: null,
        });
      }
    }
  }

  // --- guias publicados, so os verificados e com mapeamento explicito ------
  for (const g of epgCfg.publishedGuides.filter((x) => x.enabled)) {
    if (g.idFormat === 'foreign' && !g.idMap) {
      sources.push({
        id: g.id,
        kind: 'published',
        ok: false,
        requestedChannels: 0,
        channelsWithProgrammes: 0,
        programmes: 0,
        note: 'idFormat foreign sem idMap explicito: casar id seria adivinhacao, fonte ignorada',
      });
      continue;
    }
    try {
      const { body } = await fetchCached(cfg, g.url, { force: true });
      let xml = body.toString('utf8');
      if (!/<tv[\s>]/.test(xml)) throw new Error('resposta nao e XMLTV');
      if (g.idMap) {
        for (const [from, to] of Object.entries(g.idMap)) {
          xml = xml.replaceAll(`"${from}"`, `"${to}"`);
        }
      }
      const got = ingest(xml, g.id);
      sources.push({
        id: g.id,
        kind: 'published',
        ok: true,
        requestedChannels: g.idMap ? Object.keys(g.idMap).length : -1,
        channelsWithProgrammes: got.chans,
        programmes: got.progs,
        note: null,
      });
    } catch (err) {
      sources.push({
        id: g.id,
        kind: 'published',
        ok: false,
        requestedChannels: 0,
        channelsWithProgrammes: 0,
        programmes: 0,
        note: (err as Error).message.slice(0, 200),
      });
    }
  }

  // --- escreve XMLTV -------------------------------------------------------
  const index = new Map<string, number>();
  for (const p of programmes.values()) index.set(p.channel, (index.get(p.channel) ?? 0) + 1);

  const ordered = [...programmes.values()].sort(
    (a, b) => a.channel.localeCompare(b.channel) || a.start.localeCompare(b.start),
  );
  const chanIds = [...new Set(ordered.map((p) => p.channel))].sort();

  const parts: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE tv SYSTEM "xmltv.dtd">',
    `<tv generator-info-name="iptv-br-playlist" generator-info-url="https://github.com/${cfg.repo.owner}/${cfg.repo.name}" date="${formatXmltvTime(now).slice(0, 14)}">`,
  ];
  for (const id of chanIds) {
    const ch = byChannel.get(id);
    const inner = guideChannels.get(id);
    // Mesma regra do <programme>: reconstroi, nao copia cru da fonte.
    const rebuilt = inner ? rebuildChildren(inner, CHANNEL_CHILDREN) : '';
    if (rebuilt) {
      parts.push(`  <channel id="${escapeXml(id)}">${rebuilt}</channel>`);
      continue;
    }
    const lang = ch?.declaredLanguages[0] ?? 'pt';
    const name = escapeXml(ch?.name ?? id);
    const icon = ch?.logo ? `<icon src="${escapeXml(ch.logo)}" />` : '';
    parts.push(
      `  <channel id="${escapeXml(id)}"><display-name lang="${escapeXml(lang)}">${name}</display-name>${icon}</channel>`,
    );
  }
  for (const p of ordered) parts.push(p.xml);
  parts.push('</tv>', '');

  const p = outPath(cfg, cfg.output.epgFile);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, gzipSync(Buffer.from(parts.join('\n'), 'utf8'), { level: 9 }));
  info(`${cfg.output.epgFile}: ${chanIds.length} canais, ${ordered.length} programas`);

  const missing = [...wanted]
    .filter((id) => !index.has(id))
    .map((id) => {
      const ch = byChannel.get(id);
      return {
        tvgId: id,
        name: ch?.name ?? id,
        countryGroup: ch?.countryGroup ?? 'OTHER',
        guideSites: ch?.guideSites ?? [],
      };
    })
    .sort((a, b) => a.countryGroup.localeCompare(b.countryGroup) || a.name.localeCompare(b.name));

  return {
    index,
    channelsInGuide: chanIds.length,
    programmes: ordered.length,
    horizonHours: cfg.epg.programmeHorizonHours,
    generatedAt,
    sources,
    missing,
    dropped,
  };
}

/**
 * Resultado do EPG em arquivo, para a etapa de build nao precisar do grabber.
 * E o que permite rodar o grabber numa job isolada, sem permissao de escrita.
 */
export function writeIndex(cfg: Config, result: EpgResult): void {
  const p = outPath(cfg, cfg.output.epgIndexFile);
  mkdirSync(dirname(p), { recursive: true });
  const programmes: Record<string, number> = {};
  for (const k of [...result.index.keys()].sort()) programmes[k] = result.index.get(k)!;
  writeFileSync(
    p,
    JSON.stringify(
      {
        generatedAt: result.generatedAt,
        horizonHours: result.horizonHours,
        channelsInGuide: result.channelsInGuide,
        programmes: result.programmes,
        sources: result.sources,
        dropped: result.dropped,
        missing: result.missing,
        byChannel: programmes,
      },
      null,
      1,
    ) + '\n',
  );
}

/** Le o indice gravado por uma execucao anterior de `epg`. Null quando nao existe. */
export function readIndex(cfg: Config): EpgResult | null {
  const p = outPath(cfg, cfg.output.epgIndexFile);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as {
      generatedAt: string;
      horizonHours: number;
      channelsInGuide: number;
      programmes: number;
      sources: EpgResult['sources'];
      dropped: EpgResult['dropped'];
      missing: EpgResult['missing'];
      byChannel: Record<string, number>;
    };
    return {
      index: new Map(Object.entries(raw.byChannel ?? {})),
      channelsInGuide: raw.channelsInGuide ?? 0,
      programmes: raw.programmes ?? 0,
      horizonHours: raw.horizonHours ?? 0,
      generatedAt: raw.generatedAt,
      sources: raw.sources ?? [],
      missing: raw.missing ?? [],
      dropped: raw.dropped ?? { duplicates: 0, outOfHorizon: 0, invalidTimestamp: 0, unknownChannel: 0, malformed: 0 },
    };
  } catch (err) {
    warn(`indice de EPG invalido em ${p}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Reconfere os arquivos de EPG antes de publicar.
 *
 * Eles sao produzidos numa job onde codigo de terceiro roda (o grabber e o
 * postinstall dele). Mesmo tendo sido escritos pelo nosso codigo, chegam aqui como
 * artifact de um workspace nao confiavel: a job que publica valida de novo em vez
 * de confiar na etapa anterior. Devolve a lista de problemas; vazia significa ok.
 */
export function verifyEpgArtifacts(cfg: Config): string[] {
  const problems: string[] = [];

  const gz = outPath(cfg, cfg.output.epgFile);
  if (!existsSync(gz)) {
    problems.push(`${cfg.output.epgFile} nao existe`);
  } else {
    try {
      const raw = readFileSync(gz);
      if (!(raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b)) {
        problems.push(`${cfg.output.epgFile} nao e gzip`);
      } else {
        const xml = gunzipSync(raw, { maxOutputLength: cfg.http.maxDecompressedBytes }).toString('utf8');
        if (!/^\s*<\?xml/.test(xml)) problems.push('XMLTV sem declaracao <?xml');
        if (!/<tv[\s>]/.test(xml)) problems.push('XMLTV sem elemento raiz <tv>');
        if (!/<\/tv>\s*$/.test(xml)) problems.push('XMLTV nao termina em </tv>');
        // Boa formacao de verdade, nao ausencia de padrao suspeito.
        const body = xml.replace(/<\?xml[\s\S]*?\?>/g, '').replace(/<!DOCTYPE[^>]*>/g, '');
        if (!isBalancedXml(body)) problems.push('XMLTV nao esta balanceado');
        const progs = extractProgrammes(xml);
        const semTempo = progs.filter((p) => parseXmltvTime(p.start) === null);
        if (semTempo.length) {
          problems.push(`${semTempo.length} programa(s) com timestamp XMLTV invalido`);
        }
        const ids = new Set(extractGuideChannels(xml).keys());
        const orfaos = progs.filter((p) => !ids.has(p.channel));
        if (orfaos.length) {
          problems.push(`${orfaos.length} programa(s) para canal sem <channel> declarado`);
        }
        info(`verificacao do guia: ${ids.size} canais, ${progs.length} programas`);
      }
    } catch (err) {
      problems.push(`${cfg.output.epgFile} nao pode ser lido: ${(err as Error).message}`);
    }
  }

  const idxPath = outPath(cfg, cfg.output.epgIndexFile);
  if (existsSync(idxPath)) {
    try {
      const raw: unknown = JSON.parse(readFileSync(idxPath, 'utf8'));
      const obj = raw as Record<string, unknown>;
      const byChannel = obj['byChannel'];
      if (typeof byChannel !== 'object' || byChannel === null || Array.isArray(byChannel)) {
        problems.push('epg-index: byChannel nao e objeto');
      } else {
        const entries = Object.entries(byChannel as Record<string, unknown>);
        if (entries.length > 100_000) problems.push(`epg-index: ${entries.length} canais, acima do teto`);
        for (const [k, v] of entries) {
          if (k.length > 200 || /[\r\n<>"]/.test(k)) {
            problems.push(`epg-index: chave invalida '${k.slice(0, 40)}'`);
            break;
          }
          if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
            problems.push(`epg-index: valor invalido em '${k.slice(0, 40)}'`);
            break;
          }
        }
      }
      for (const field of ['channelsInGuide', 'programmes', 'horizonHours']) {
        const v = obj[field];
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
          problems.push(`epg-index: ${field} invalido`);
        }
      }
    } catch (err) {
      problems.push(`epg-index ilegivel: ${(err as Error).message}`);
    }
  }

  return problems;
}

export function writeCoverage(cfg: Config, result: EpgResult, wantedTotal: number): void {
  const p = outPath(cfg, cfg.output.epgCoverageFile);
  mkdirSync(dirname(p), { recursive: true });
  const covered = result.channelsInGuide;
  writeFileSync(
    p,
    JSON.stringify(
      {
        generatedAt: result.generatedAt,
        horizonHours: result.horizonHours,
        channelsRequested: wantedTotal,
        channelsWithGuide: covered,
        coveragePercent: wantedTotal ? Number(((covered / wantedTotal) * 100).toFixed(2)) : 0,
        programmes: result.programmes,
        sources: result.sources,
        dropped: result.dropped,
        missingChannels: result.missing,
      },
      null,
      1,
    ) + '\n',
  );
}
