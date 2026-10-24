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
import { gzipSync } from 'node:zlib';
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
  dropped: { duplicates: number; outOfHorizon: number; invalidTimestamp: number; unknownChannel: number };
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
        name: (m[2] ?? '').trim(),
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
  if (!existsSync(resolve(dir, 'package.json'))) {
    info(`clonando grabber ${cfg.epg.grabberRepo} (${cfg.epg.grabberRef}) em ${cfg.epg.grabberDir}`);
    mkdirSync(dirname(dir), { recursive: true });
    rmSync(dir, { recursive: true, force: true });
    const clone = await run(
      'git',
      ['clone', '--depth', '1', '-b', cfg.epg.grabberRef, cfg.epg.grabberRepo, dir],
      ROOT,
      cfg.epg.grabTimeoutMs,
    );
    if (clone.code !== 0) {
      error(`clone do grabber falhou: ${clone.stderr.slice(0, 400)}`);
      return null;
    }
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
  const dropped = { duplicates: 0, outOfHorizon: 0, invalidTimestamp: 0, unknownChannel: 0 };
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
          `${p.inner.trim()}</programme>`,
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
    if (inner && inner.trim()) {
      parts.push(`  <channel id="${escapeXml(id)}">${inner.trim()}</channel>`);
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
