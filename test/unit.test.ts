import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseM3u, serializeM3u, isSafeStreamUrl } from '../src/m3u.ts';
import {
  parseXmltvTime,
  formatXmltvTime,
  extractProgrammes,
  extractGuideChannels,
  escapeXml,
  unescapeXml,
} from '../src/epg.ts';
import { resolutionLabel, isPortuguese } from '../src/validate.ts';
import { effectiveStatus, needsCheck, type VantageHealth } from '../src/health.ts';
import { splitTvgId } from '../src/catalog.ts';
import { load } from '../src/config.ts';

const { config } = load();

test('parseM3u preserva atributos, diretivas e nome com virgula', () => {
  const text = [
    '#EXTM3U x-tvg-url="https://exemplo/epg.xml.gz"',
    '#EXTINF:-1 tvg-id="Globo.br@SD" tvg-logo="https://l/g.png" group-title="General;News",Globo, SP (1080p)',
    '#EXTVLCOPT:http-user-agent=Agente/1.0',
    'https://exemplo/globo.m3u8',
  ].join('\n');
  const doc = parseM3u(text);
  assert.equal(doc.header['x-tvg-url'], 'https://exemplo/epg.xml.gz');
  assert.equal(doc.entries.length, 1);
  const e = doc.entries[0]!;
  assert.equal(e.attrs['tvg-id'], 'Globo.br@SD');
  assert.equal(e.attrs['group-title'], 'General;News');
  // Nome tem virgula: o corte e na PRIMEIRA virgula fora de aspas.
  assert.equal(e.name, 'Globo, SP (1080p)');
  assert.deepEqual(e.directives, ['#EXTVLCOPT:http-user-agent=Agente/1.0']);
  assert.equal(e.url, 'https://exemplo/globo.m3u8');
});

test('serializeM3u gera cabecalho e entrada relegiveis', () => {
  const out = serializeM3u({
    header: { 'url-tvg': 'https://e/epg.xml.gz' },
    entries: [
      {
        attrs: { 'tvg-id': 'A.br@SD', 'group-title': 'Brasil - Geral' },
        name: 'Canal A',
        duration: '-1',
        directives: ['#EXTGRP:Brasil - Geral'],
        url: 'https://e/a.m3u8',
      },
    ],
  });
  assert.match(out, /^#EXTM3U url-tvg="https:\/\/e\/epg\.xml\.gz"\n/);
  assert.match(out, /#EXTINF:-1 tvg-id="A\.br@SD" group-title="Brasil - Geral",Canal A\n/);
  const again = parseM3u(out);
  assert.equal(again.entries[0]!.url, 'https://e/a.m3u8');
  assert.equal(again.entries[0]!.attrs['tvg-id'], 'A.br@SD');
});

test('parseM3u nao corta no separador dentro de atributo com virgula', () => {
  const doc = parseM3u(
    '#EXTM3U\n#EXTINF:-1 tvg-id="X.br@SD" group-title="Filmes,Series",Canal X\nhttps://e/x.m3u8\n',
  );
  const e = doc.entries[0]!;
  assert.equal(e.attrs['group-title'], 'Filmes,Series');
  assert.equal(e.name, 'Canal X');
});

test('parseM3u aceita #EXTINF sem atributo nenhum', () => {
  const doc = parseM3u('#EXTM3U\n#EXTINF:-1,Canal Simples\nhttps://e/s.m3u8\n');
  assert.equal(doc.entries.length, 1);
  assert.equal(doc.entries[0]!.name, 'Canal Simples');
  assert.deepEqual(doc.entries[0]!.attrs, {});
});

test('parseM3u ignora #EXTINF sem URL (entrada truncada no fim do arquivo)', () => {
  const doc = parseM3u('#EXTM3U\n#EXTINF:-1 tvg-id="A.br@SD",A\nhttps://e/a.m3u8\n#EXTINF:-1,B\n');
  assert.equal(doc.entries.length, 1, 'a entrada sem URL nao entra');
  assert.equal(doc.entries[0]!.name, 'A');
});

test('serializeM3u nao deixa o upstream injetar linha na playlist', () => {
  // channels.json do iptv-org e editavel por terceiros: um nome com \n viraria
  // diretiva ou URL de stream nova no arquivo publicado.
  const out = serializeM3u({
    header: {},
    entries: [
      {
        attrs: { 'tvg-id': 'X.br@SD', 'group-title': 'Brasil\n#EXTINF:-1,Falso' },
        name: 'Canal\n#EXTINF:-1,Injetado\nhttp://mau.exemplo/evil.m3u8',
        duration: '-1',
        directives: ['#EXTVLCOPT:http-user-agent=A', '#EXTINF:-1,NaoPermitido', '#RANDOM:x'],
        url: 'https://bom.exemplo/x.m3u8',
      },
    ],
  });
  const lines = out.trim().split('\n');
  assert.equal(lines.length, 4, `esperado cabecalho + EXTINF + 1 diretiva + URL, veio:\n${out}`);
  assert.equal(lines[0], '#EXTM3U');
  assert.match(lines[1]!, /^#EXTINF:-1 /);
  assert.equal(lines[2], '#EXTVLCOPT:http-user-agent=A', 'diretiva fora da lista permitida cai');
  assert.equal(lines[3], 'https://bom.exemplo/x.m3u8');
  // O texto injetado sobra como parte do nome, achatado na MESMA linha. Isso e inofensivo:
  // o que nao pode e virar linha nova. Logo: nenhuma linha extra, nenhuma URL extra.
  assert.ok(!lines.some((l) => l.startsWith('http://mau.exemplo')), 'URL injetada nao virou linha');
  assert.equal(lines.filter((l) => l.startsWith('#EXTINF:')).length, 1, 'so um #EXTINF');
  // Reparsear o resultado tem de dar exatamente uma entrada, com a URL boa.
  const again = parseM3u(out);
  assert.equal(again.entries.length, 1);
  assert.equal(again.entries[0]!.url, 'https://bom.exemplo/x.m3u8');
});

test('serializeM3u descarta entrada com URL que nao e http(s)', () => {
  const mk = (url: string) => ({
    header: {},
    entries: [{ attrs: {}, name: 'C', duration: '-1', directives: [], url }],
  });
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/plain,x', 'nao-url']) {
    assert.equal(parseM3u(serializeM3u(mk(bad))).entries.length, 0, `${bad} deveria cair`);
  }
  assert.equal(parseM3u(serializeM3u(mk('http://e/a.m3u8'))).entries.length, 1);
});

test('isSafeStreamUrl aceita so http(s) sem espaco', () => {
  assert.equal(isSafeStreamUrl('https://e/a.m3u8?t=1'), true);
  assert.equal(isSafeStreamUrl('http://1.2.3.4:8080/x'), true);
  assert.equal(isSafeStreamUrl('rtmp://e/a'), false);
  assert.equal(isSafeStreamUrl('https://e/a b.m3u8'), false);
  assert.equal(isSafeStreamUrl('https://e/a\nb'), false);
  assert.equal(isSafeStreamUrl(''), false);
});

test('splitTvgId separa canal e feed', () => {
  assert.deepEqual(splitTvgId('Globo.br@SD'), ['Globo.br', 'SD']);
  assert.deepEqual(splitTvgId('AELatinAmerica.us@Brazil'), ['AELatinAmerica.us', 'Brazil']);
  assert.deepEqual(splitTvgId('SemFeed.br'), ['SemFeed.br', null]);
});

test('parseXmltvTime aceita offset e recusa data invalida', () => {
  assert.equal(parseXmltvTime('20261024120000 +0000'), Date.UTC(2026, 9, 24, 12, 0, 0));
  // -0300 significa que 09:00 local e 12:00 UTC.
  assert.equal(parseXmltvTime('20261024090000 -0300'), Date.UTC(2026, 9, 24, 12, 0, 0));
  assert.equal(parseXmltvTime('20261024120000'), Date.UTC(2026, 9, 24, 12, 0, 0));
  assert.equal(parseXmltvTime('20261324120000 +0000'), null, 'mes 13 e invalido');
  assert.equal(parseXmltvTime('2026102412'), null, 'curto demais');
  assert.equal(parseXmltvTime('nao-e-data'), null);
});

test('formatXmltvTime produz timestamp XMLTV canonico', () => {
  assert.equal(formatXmltvTime(Date.UTC(2026, 9, 24, 12, 5, 9)), '20261024120509 +0000');
  const round = parseXmltvTime(formatXmltvTime(Date.UTC(2026, 0, 1, 0, 0, 0)));
  assert.equal(round, Date.UTC(2026, 0, 1, 0, 0, 0));
});

test('extractProgrammes e extractGuideChannels leem XMLTV real', () => {
  const xml = `<?xml version="1.0"?><tv>
<channel id="Globo.br@SD"><display-name>Globo</display-name></channel>
<programme start="20261024120000 +0000" stop="20261024130000 +0000" channel="Globo.br@SD"><title>Jornal</title></programme>
<programme start="20261024130000 +0000" channel="Globo.br@SD"><title>Novela</title></programme>
</tv>`;
  const chans = extractGuideChannels(xml);
  assert.equal(chans.size, 1);
  assert.match(chans.get('Globo.br@SD')!, /display-name/);
  const progs = extractProgrammes(xml);
  assert.equal(progs.length, 2);
  assert.equal(progs[0]!.channel, 'Globo.br@SD');
  assert.equal(progs[1]!.stop, '', 'programa sem stop e aceito e tratado depois');
});

test('escapeXml protege os caracteres que quebram XMLTV', () => {
  assert.equal(escapeXml('A & B <c> "d"'), 'A &amp; B &lt;c&gt; &quot;d&quot;');
});

test('unescapeXml evita o escape duplo em nome vindo cru do XML', () => {
  // sites/*.channels.xml do grabber tras 'A&amp;E'; sem decodificar, o guia
  // publicado saia com 'A&amp;amp;E' no display-name.
  assert.equal(unescapeXml('A&amp;E'), 'A&E');
  assert.equal(escapeXml(unescapeXml('A&amp;E')), 'A&amp;E', 'round-trip estavel');
  assert.equal(unescapeXml('&lt;b&gt; &quot;x&quot; &apos;y&apos;'), '<b> "x" \'y\'');
  assert.equal(unescapeXml('&#65;&#x42;'), 'AB');
  // &amp; e desfeito por ultimo: '&amp;lt;' tem de virar '&lt;', nao '<'.
  assert.equal(unescapeXml('&amp;lt;'), '&lt;');
});

test('resolutionLabel usa a escada de config, nunca numero chumbado', () => {
  assert.equal(resolutionLabel(1080), '1080p');
  assert.equal(resolutionLabel(1079), '720p');
  assert.equal(resolutionLabel(2160), '2160p');
  assert.equal(resolutionLabel(100), 'baixa');
  assert.equal(resolutionLabel(0), null);
  assert.equal(resolutionLabel(null), null);
});

test('isPortuguese reconhece as variantes da fonte e recusa o resto', () => {
  for (const c of ['por', 'pt', 'pt-BR', 'PT_BR', 'ptb']) {
    assert.equal(isPortuguese(c), true, `${c} deveria contar como portugues`);
  }
  for (const c of ['spa', 'eng', 'und', '', null, undefined]) {
    assert.equal(isPortuguese(c as string | null), false, `${String(c)} nao e portugues`);
  }
});

function vh(partial: Partial<VantageHealth>): VantageHealth {
  return {
    status: 'WORKING',
    checkedAt: new Date().toISOString(),
    http: 200,
    reason: null,
    evidence: null,
    consecutiveFailures: 0,
    lastSuccessAt: new Date().toISOString(),
    history: ['WORKING'],
    media: null,
    ...partial,
  };
}

test('effectiveStatus rebaixa sucesso que oscila para UNSTABLE', () => {
  assert.equal(effectiveStatus(config, vh({ history: ['WORKING', 'WORKING'] })), 'WORKING');
  assert.equal(effectiveStatus(config, vh({ history: ['OFFLINE', 'WORKING'] })), 'UNSTABLE');
  // Falha nao e promovida por historico: segue sendo falha.
  assert.equal(
    effectiveStatus(config, vh({ status: 'OFFLINE', history: ['WORKING', 'OFFLINE'] })),
    'OFFLINE',
  );
});

test('needsCheck respeita a carencia por status', () => {
  assert.equal(needsCheck(config, undefined), true, 'nunca checado sempre checa');
  const now = Date.now();
  const fresh = vh({ status: 'WORKING', checkedAt: new Date(now - 3600_000).toISOString() });
  assert.equal(needsCheck(config, fresh, now), false, 'WORKING de 1h nao recheca');
  const old = vh({
    status: 'WORKING',
    checkedAt: new Date(now - (config.validation.recheckHours['WORKING']! + 1) * 3600_000).toISOString(),
  });
  assert.equal(needsCheck(config, old, now), true);
  // GEO_BLOCKED tem carencia longa justamente para nao insistir em algo que nao muda rapido.
  const geo = vh({ status: 'GEO_BLOCKED', checkedAt: new Date(now - 24 * 3600_000).toISOString() });
  assert.equal(needsCheck(config, geo, now), false);
});
