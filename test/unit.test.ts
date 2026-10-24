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
  rebuildChildren,
  isBalancedXml,
  readIndex,
  sliceFileName,
  writeEpgSlices,
} from '../src/epg.ts';
import { gzipSync } from 'node:zlib';
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from '../src/config.ts';
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

const PROG = {
  title: ['lang'],
  desc: ['lang'],
  category: ['lang'],
  'episode-num': ['system'],
  icon: ['src'],
};

test('rebuildChildren reconstroi os filhos permitidos e reescapa', () => {
  const out = rebuildChildren(
    '<title lang="pt">Jornal &amp; Cia</title><desc lang="pt">Resumo</desc>' +
      '<category lang="pt">News</category><episode-num system="xmltv_ns">1.2.</episode-num>',
    PROG,
  );
  assert.match(out, /<title lang="pt">Jornal &amp; Cia<\/title>/);
  assert.match(out, /<desc lang="pt">Resumo<\/desc>/);
  assert.match(out, /<episode-num system="xmltv_ns">1\.2\.<\/episode-num>/);
  assert.ok(isBalancedXml(out), 'saida tem de ser balanceada');
});

test('rebuildChildren nao propaga estrutura estranha da fonte', () => {
  // Um denylist de regex deixaria passar tag sem fechar ou '</programme >'.
  // Reconstruindo, nada disso chega ao arquivo publicado.
  const out = rebuildChildren(
    '<title>ok</title></programme ><programme start="1"><title>falso</title>' +
      '<evil onload="x">y</evil><script>z</script><![CDATA[w]]>',
    PROG,
  );
  assert.ok(isBalancedXml(out));
  assert.ok(!out.includes('<evil'), 'elemento fora da lista nao sai');
  assert.ok(!out.includes('<script'));
  assert.ok(!out.includes('CDATA'));
  assert.ok(!/<\/?programme/.test(out), 'nao reabre nem fecha programme');
});

test('rebuildChildren aceita so icon com esquema http(s)', () => {
  assert.match(rebuildChildren('<icon src="https://e/a.png" />', PROG), /src="https:\/\/e\/a\.png"/);
  assert.equal(rebuildChildren('<icon src="javascript:alert(1)" />', PROG), '');
  assert.equal(rebuildChildren('<icon src="data:image/png;base64,x" />', PROG), '');
});

test('rebuildChildren devolve vazio quando nao sobra nada util', () => {
  assert.equal(rebuildChildren('<credits><actor>A</actor></credits>', PROG), '');
  assert.equal(rebuildChildren('<title>   </title>', PROG), '', 'titulo so com espaco nao conta');
  assert.equal(rebuildChildren('', PROG), '');
});

test('isBalancedXml separa documento bem formado de malformado', () => {
  assert.equal(isBalancedXml('<tv><channel id="a"><display-name>X</display-name></channel></tv>'), true);
  assert.equal(isBalancedXml('<tv><programme start="1"><title>x</title></programme></tv>'), true);
  assert.equal(isBalancedXml('<tv><icon src="u" /></tv>'), true);
  assert.equal(isBalancedXml('<tv><title>sem fechar</tv>'), false);
  assert.equal(isBalancedXml('<tv></channel></tv>'), false);
  assert.equal(isBalancedXml('<tv>'), false);
  assert.equal(isBalancedXml('<tv></tv><'), false, 'sobra de < solto');
});

test('unescapeXml nunca lanca com referencia numerica fora de faixa', () => {
  // A fonte e editavel por terceiros. String.fromCodePoint estoura RangeError
  // acima de 0x10FFFF, e isso derrubaria a montagem inteira do guia.
  for (const bad of ['&#99999999;', '&#x110000;', '&#1114112;', '&#0;', '&#xFFFFFFFF;', '&#8;']) {
    assert.doesNotThrow(() => unescapeXml(bad), `${bad} nao pode lancar`);
    assert.equal(unescapeXml(bad), '', `${bad} deveria ser descartado`);
  }
  // Code point valido continua funcionando, inclusive fora do BMP.
  assert.equal(unescapeXml('&#128512;'), '\u{1F600}');
  assert.equal(unescapeXml('&#x1F600;'), '\u{1F600}');
  assert.equal(unescapeXml('&#233;'), 'é');
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

test('readIndex reconstroi o indice a partir de primitivos validados', () => {
  // O arquivo vem de uma job onde codigo de terceiro rodou, e seus campos viram
  // texto no STATUS.md. Nada dele pode passar adiante sem reconstrucao.
  const rel = 'tmp/teste-epg-index.json';
  const abs = resolve(ROOT, rel);
  mkdirSync(resolve(ROOT, 'tmp'), { recursive: true });
  const original = config.output.epgIndexFile;
  config.output.epgIndexFile = rel;
  try {
    writeFileSync(
      abs,
      JSON.stringify({
        generatedAt: 'nao-e-data',
        horizonHours: -5,
        channelsInGuide: 1.9,
        programmes: 'muitos',
        byChannel: { 'Globo.br@SD': 12, 'ruim<>|': 3, 'Zero.br@SD': 0, 'Neg.br@SD': -4 },
        sources: [
          { id: 'mi.tv', kind: 'grabber', ok: true, programmes: 10, channelsWithProgrammes: 2, note: null },
          { id: 'mau|id\ncom quebra', kind: 'inventado', ok: 'sim', programmes: -1, note: '`x` <b>y</b>' },
          { id: '', kind: 'grabber' },
          'nem objeto',
        ],
        dropped: { duplicates: 3, inventado: 99, malformed: -2 },
        missing: [{ tvgId: 'X.br@SD', name: 'A|B', countryGroup: 'BR', guideSites: ['mi.tv', 7] }],
        campoExtra: { qualquer: 'coisa' },
      }),
    );

    const r = readIndex(config);
    assert.ok(r, 'deveria ler');
    // Numeros saneados.
    assert.equal(r!.horizonHours, 0, 'negativo vira 0');
    assert.equal(r!.channelsInGuide, 1, 'fracionario e truncado');
    assert.equal(r!.programmes, 0, 'string vira 0');
    assert.ok(!Number.isNaN(Date.parse(r!.generatedAt)), 'data invalida e substituida');
    // Indice: so chave limpa e contagem positiva.
    assert.deepEqual([...r!.index.entries()], [['Globo.br@SD', 12], ['ruim', 3]]);
    // Fontes: entrada sem id ou que nao e objeto cai; kind desconhecido vira 'published'.
    assert.equal(r!.sources.length, 2);
    assert.equal(r!.sources[0]!.id, 'mi.tv');
    assert.equal(r!.sources[1]!.kind, 'published');
    assert.equal(r!.sources[1]!.ok, false, "ok: 'sim' nao e true");
    assert.equal(r!.sources[1]!.programmes, 0);
    assert.ok(!/[|<>`\[\]\r\n]/.test(r!.sources[1]!.id), 'id sem caractere que quebre a tabela');
    assert.ok(!/[<>`]/.test(r!.sources[1]!.note ?? ''), 'note sem markup');
    // dropped: exatamente os cinco contadores.
    assert.deepEqual(Object.keys(r!.dropped).sort(), [
      'duplicates', 'invalidTimestamp', 'malformed', 'outOfHorizon', 'unknownChannel',
    ]);
    assert.equal(r!.dropped.duplicates, 3);
    assert.equal(r!.dropped.malformed, 0, 'negativo vira 0');
    // missing: texto saneado, guideSites so com string.
    assert.equal(r!.missing[0]!.name, 'AB');
    assert.deepEqual(r!.missing[0]!.guideSites, ['mi.tv']);
  } finally {
    config.output.epgIndexFile = original;
    rmSync(abs, { force: true });
  }
});

test('readIndex devolve null em JSON quebrado', () => {
  const rel = 'tmp/teste-epg-index-ruim.json';
  const abs = resolve(ROOT, rel);
  mkdirSync(resolve(ROOT, 'tmp'), { recursive: true });
  const original = config.output.epgIndexFile;
  config.output.epgIndexFile = rel;
  try {
    writeFileSync(abs, '{ isso nao e json');
    assert.equal(readIndex(config), null);
    writeFileSync(abs, '[1,2,3]');
    assert.equal(readIndex(config), null, 'raiz que nao e objeto');
  } finally {
    config.output.epgIndexFile = original;
    rmSync(abs, { force: true });
  }
});

test('sliceFileName gera nome seguro e o id continua legivel', () => {
  assert.equal(sliceFileName('Globo.br@SD'), 'Globo.br_at_SD.json');
  assert.equal(sliceFileName('AELatinAmerica.us@Brazil'), 'AELatinAmerica.us_at_Brazil.json');
  assert.equal(sliceFileName('Sem.feed'), 'Sem.feed.json');
  // Nada fora de [A-Za-z0-9._-] sobrevive: sem barra, sem espaco, sem travessia.
  assert.equal(sliceFileName('../../etc/passwd'), '.._.._etc_passwd.json');
  assert.equal(sliceFileName('a b/c:d?e'), 'a_b_c_d_e.json');
  assert.ok(/^[A-Za-z0-9._-]+\.json$/.test(sliceFileName('x y@z/w')));
});

test('writeEpgSlices corta na janela, marca o programa em curso e usa epoch', () => {
  const sliceDir = 'tmp/teste-slices';
  const gzRel = 'tmp/teste-guia.xml.gz';
  const origDir = config.output.epgSliceDir;
  const origGz = config.output.epgFile;
  const origHorizon = config.epg.sliceHorizonHours;
  config.output.epgSliceDir = sliceDir;
  config.output.epgFile = gzRel;
  config.epg.sliceHorizonHours = 24;

  const now = Date.now();
  const ts = (offsetH: number) => {
    const d = new Date(now + offsetH * 3600_000);
    const p = (n: number, w = 2) => String(n).padStart(w, '0');
    return (
      `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
      `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())} +0000`
    );
  };

  try {
    mkdirSync(resolve(ROOT, 'tmp'), { recursive: true });
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE tv SYSTEM "xmltv.dtd">\n<tv>\n' +
      '<channel id="A.br@SD"><display-name>A</display-name></channel>\n' +
      // Ja terminou: fora.
      `<programme start="${ts(-5)}" stop="${ts(-4)}" channel="A.br@SD"><title>Passado</title></programme>\n` +
      // Em curso agora.
      `<programme start="${ts(-1)}" stop="${ts(1)}" channel="A.br@SD"><title>Agora</title>` +
      '<desc>Em curso</desc><category>News</category></programme>\n' +
      // Dentro da janela.
      `<programme start="${ts(2)}" stop="${ts(3)}" channel="A.br@SD"><title>Depois</title></programme>\n` +
      // Alem de 24 h: fora.
      `<programme start="${ts(30)}" stop="${ts(31)}" channel="A.br@SD"><title>Longe</title></programme>\n` +
      // Canal que nao esta na playlist: fora.
      `<programme start="${ts(1)}" stop="${ts(2)}" channel="Z.br@SD"><title>Alheio</title></programme>\n` +
      '</tv>\n';
    writeFileSync(resolve(ROOT, gzRel), gzipSync(Buffer.from(xml)));

    const r = writeEpgSlices(config, [
      { tvgId: 'A.br@SD', name: 'Canal A', logo: 'https://e/a.png' },
      { tvgId: 'SemGrade.br@SD', name: 'Sem Grade', logo: null },
      { tvgId: null, name: 'Sem Id', logo: null },
    ]);

    assert.equal(r.files, 1, 'so o canal com grade vira arquivo');
    assert.equal(r.skippedNoGuide, 1, 'canal sem grade e contado, nao publicado');
    assert.equal(r.programmes, 2, 'passado e alem da janela ficam de fora');

    const slice = JSON.parse(
      readFileSync(resolve(ROOT, sliceDir, 'A.br_at_SD.json'), 'utf8'),
    ) as { id: string; name: string; now: number; count: number; programmes: { s: number; e: number; t: string; d: string; c: string[] }[] };
    assert.equal(slice.id, 'A.br@SD');
    assert.equal(slice.name, 'Canal A', 'nome vem da playlist, nao do guia');
    assert.equal(slice.count, 2);
    assert.deepEqual(slice.programmes.map((p) => p.t), ['Agora', 'Depois'], 'em ordem de inicio');
    assert.equal(slice.now, 0, 'aponta o programa em curso');
    assert.equal(slice.programmes[0]!.d, 'Em curso');
    assert.deepEqual(slice.programmes[0]!.c, ['News']);
    // Epoch em segundos, nao milissegundos nem string.
    for (const p of slice.programmes) {
      assert.equal(typeof p.s, 'number');
      assert.ok(Number.isInteger(p.s) && p.s > 1_000_000_000 && p.s < 10_000_000_000, `epoch em segundos: ${p.s}`);
      assert.ok(p.e > p.s);
    }

    const idx = JSON.parse(readFileSync(resolve(ROOT, sliceDir, 'index.json'), 'utf8')) as {
      channels: number; timeFormat: string; items: { id: string; file: string; count: number }[];
    };
    assert.equal(idx.channels, 1);
    assert.equal(idx.timeFormat, 'epoch-seconds-utc');
    assert.equal(idx.items[0]!.file, 'A.br_at_SD.json', 'indice publica o nome pronto');
    assert.ok(existsSync(resolve(ROOT, sliceDir, idx.items[0]!.file)), 'arquivo do indice existe');
    assert.ok(!existsSync(resolve(ROOT, sliceDir, 'Z.br_at_SD.json')), 'canal alheio nao vira arquivo');
  } finally {
    config.output.epgSliceDir = origDir;
    config.output.epgFile = origGz;
    config.epg.sliceHorizonHours = origHorizon;
    rmSync(resolve(ROOT, sliceDir), { recursive: true, force: true });
    rmSync(resolve(ROOT, gzRel), { force: true });
  }
});

test('writeEpgSlices limpa fatia de canal que perdeu a grade', () => {
  const sliceDir = 'tmp/teste-slices-limpeza';
  const origDir = config.output.epgSliceDir;
  const origGz = config.output.epgFile;
  config.output.epgSliceDir = sliceDir;
  config.output.epgFile = 'tmp/nao-existe.xml.gz';
  try {
    mkdirSync(resolve(ROOT, sliceDir), { recursive: true });
    writeFileSync(resolve(ROOT, sliceDir, 'Velho.br_at_SD.json'), '{"stale":true}');
    const r = writeEpgSlices(config, []);
    assert.equal(r.files, 0);
    assert.ok(
      !existsSync(resolve(ROOT, sliceDir, 'Velho.br_at_SD.json')),
      'arquivo velho nao pode continuar publicado',
    );
    assert.ok(existsSync(resolve(ROOT, sliceDir, 'index.json')), 'indice vazio ainda e escrito');
  } finally {
    config.output.epgSliceDir = origDir;
    config.output.epgFile = origGz;
    rmSync(resolve(ROOT, sliceDir), { recursive: true, force: true });
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
