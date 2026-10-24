# iptv-br-playlist

Agregador, validador e classificador de playlists IPTV públicas, com guia de programação XMLTV.
Uma playlist M3U organizada em seções, gerada e republicada sozinha por GitHub Actions.

> **Research objective — channel RAG with AI.** O objetivo de pesquisa está em
> **[RESEARCH.md](RESEARCH.md)**, em inglês: usar este corpus como substrato de recuperação para
> um modelo responder o que está no ar, onde, em qual idioma e **se de fato toca** — com base em
> evidência medida, nunca no nome do canal. A documentação operacional abaixo segue em português.

A fonte primária é o [iptv-org](https://github.com/iptv-org/iptv). Nada aqui contorna DRM,
autenticação, paywall ou geobloqueio — o projeto só agrega, mede e organiza o que já é público.

## A URL

Uma playlist, todas as seções, só os streams que passaram na validação:

```
https://raw.githubusercontent.com/Mis4nthr0pic/iptv-br-playlist/main/playlist.m3u
```

Cole em VLC, Kodi, TiviMate ou IPTV Smarters. O EPG já vem referenciado no cabeçalho
(`url-tvg`), então o player carrega a grade sozinho — não precisa configurar nada à parte.

### Fatias, para quem quiser menos

| Arquivo | Conteúdo |
| --- | --- |
| `playlist.m3u` | **principal** — tudo validado, em seções, Brasil primeiro |
| `playlist-br.m3u` | só Brasil |
| `playlist-pt.m3u` | Portugal e canais em português |
| `playlist-movies.m3u` | filmes |
| `playlist-series.m3u` | séries |
| `playlist-sports.m3u` | esportes |
| `playlist-international.m3u` | tudo fora do Brasil |
| `playlist-all.m3u` | tudo, **inclusive não verificado e indisponível** (traz `x-health` em cada entrada) |
| `epg.xml.gz` | guia XMLTV |
| `status.json` / [`STATUS.md`](STATUS.md) | painel com os números medidos |
| `data/channels.json` | metadados completos, com streams alternativos e a evidência de cada validação |

Troque o nome do arquivo no fim da URL acima para pegar qualquer uma delas.

### Sobre as "seções"

A seção vai no atributo `group-title` de cada entrada, no formato `País • Categoria`
(`🇧🇷 Brasil • Notícias`, `🌐 International • Filmes`). A ordem do arquivo também é a ordem
das seções: Brasil, Portugal, América Latina, España, United States, United Kingdom,
International, Other Countries — e, dentro de cada país, notícias, esportes, filmes, séries,
documentários, infantil, animação, entretenimento, música, cultura, educação, variedades, geral.

**TiviMate, IPTV Smarters e Kodi mostram isso como seções navegáveis.** O VLC é a exceção: ele
ignora `group-title` e achata a lista num bloco só — lá o que você percebe é a ordem. Não é
limitação da playlist, é do VLC.

## Como um canal é classificado

País e categoria **nunca** saem do nome do canal. Saem dos metadados da fonte:

- categoria: `channels.json#categories` do iptv-org, mapeada em [`config/taxonomy.json`](config/taxonomy.json);
- país: `feeds.json#broadcast_area` tem precedência sobre `channels.json#country`, porque um feed
  dedicado é o que de fato chega ao espectador. `AELatinAmerica.us@Brazil` tem `broadcast_area`
  `c/BR`, então entra em **Brasil**, não em United States;
- `International` só quando a área de transmissão é mundial (`r/WW`, `r/UN`) ou cobre três países
  ou mais;
- o motivo da decisão fica gravado em `countryGroupReason`, canal por canal, em `data/channels.json`.

Stream sem metadado de canal na fonte fica fora das playlists validadas e aparece só em
`playlist-all.m3u`. Adivinhar a categoria pelo nome seria mais bonito no relatório e errado.

O boot check compara a taxonomia com `countries.json` e `categories.json` a cada execução e
**aborta** se um código não existir. Foi assim que apareceu que o iptv-org usa `UK`, não `GB` —
sem a checagem, o grupo United Kingdom ficaria silenciosamente vazio.

## Validação

Cada stream passa por uma pré-checagem HTTP e, se responder, por um `ffprobe` de verdade.
São gravados: resolução, codec de vídeo e de áudio, fps, canais de áudio, **idiomas de áudio
detectados**, faixas de legenda, resposta HTTP, horário da checagem e o motivo da falha.

| Status | Quando |
| --- | --- |
| `WORKING` | ffprobe abriu e achou faixa de áudio ou de vídeo |
| `UNSTABLE` | funcionou numa tentativa e falhou em outra, ou oscila entre execuções |
| `OFFLINE` | erro de rede, 4xx/5xx sem motivo declarado |
| `TIMEOUT` | estourou o tempo de conexão ou de probe |
| `GEO_BLOCKED` | **só** com HTTP 451 ou texto explícito de bloqueio regional na resposta |
| `AUTH_REQUIRED` | HTTP 401, `WWW-Authenticate`, ou texto explícito de autenticação |
| `UNSUPPORTED` | respondeu, mas o ffprobe não achou nada tocável |
| `UNKNOWN` | ainda não checado nesta janela |

Duas regras que o relatório respeita:

- **`GEO_BLOCKED` exige prova.** Um HTTP 403 pelado fica `OFFLINE` com `reason: http_403` e o
  trecho do corpo guardado como evidência: recusa comprovada, motivo não comprovado.
- **Ausência de legenda não é prova de ausência.** Em HLS o ffprobe não abre a playlist de
  variante de legenda. Nesses casos `subtitleDetectionReliable` é `false` e o painel conta isso
  separado, em vez de afirmar que o canal não tem legenda.

Um stream não é descartado por uma falha. O histórico fica em `data/health.json` (versionado) e
só depois de `validation.dropAfterFailures` falhas consecutivas ele sai das playlists validadas —
continuando em `playlist-all.m3u`. Streams alternativos do mesmo canal ficam guardados nos
metadados, ordenados por confiabilidade medida.

### Onde o teste roda muda o resultado

O runner do GitHub Actions fica nos Estados Unidos. Boa parte dos canais brasileiros responde
para quem está no Brasil e recusa de lá — e alguns fazem o contrário. Por isso cada resultado é
gravado por **ponto de observação** (`local-br`, `github-us`) e o painel mostra os dois lado a
lado. **Os números de pontos diferentes não somam.** Um canal entra nas playlists validadas se
funcionou em pelo menos um ponto, e o metadado diz qual.

Para medir do Brasil, na sua máquina:

```bash
IPTV_VANTAGE=local-br npm run all
```

## EPG

Aqui mora a parte que a documentação por aí ainda descreve errado. Medido em 2026-10-24:

- `https://iptv-org.github.io/epg/guides/` responde **HTTP 404**;
- `iptv-org/epg` não publica release nem branch `gh-pages`;
- o `GUIDES.md` do projeto, que lista guias da comunidade, estava com **todos os hosts em
  status vermelho, 0 canais** e nenhuma linha de Brasil ou Portugal.

Ou seja: não existe hoje um guia pronto do iptv-org para baixar. O projeto usa dois caminhos:

1. **O grabber do próprio `iptv-org/epg`** (caminho primário). Ele emite XMLTV com `xmltv_id`
   idêntico ao `tvg-id` da playlist (`AELatinAmerica.us@Brazil`), então o casamento é exato, sem
   adivinhação. Rodamos só para os canais que entraram na playlist e só para os sites que cobrem
   esses canais — `mi.tv` (196 canais BR), `meuguia.tv` (64 BR), `meo.pt` (82 PT), `nostv.pt`
   (79 PT), `gatotv.com`, `pluto.tv`. A lista está em [`config/epg.json`](config/epg.json).
2. **Guias publicados já verificados.** `https://epg.kanya.io/us/guide.xml.gz` é o guia que o
   próprio `index.m3u` do iptv-org aponta em `x-tvg-url`, e os ids dele já são `canal@feed`.
   Medido: 1.401 canais, 65.766 programas — mas **0 de 394 canais brasileiros** e 2 de 66
   portugueses. Serve para internacionais, não resolve o Brasil.

Guia de terceiro com id próprio (`i.mjh.nz`, por exemplo) fica **desligado** por padrão: casar
por semelhança de nome seria adivinhação. Para ligar, preencha `idMap` explicitamente.

A grade é normalizada para timestamp XMLTV canônico, deduplicada por `(canal, início, fim)` e
cortada no horizonte de `epg.programmeHorizonHours`. Nenhuma grade é inventada: canal sem fonte
fica sem programa, e aparece na lista de `data/epg-coverage.json`.

Os elementos reemitidos são `title`, `sub-title`, `desc`, `category`, `country`, `language`,
`orig-language`, `date`, `episode-num`, `length` e `icon` no `<programme>`, e `display-name`,
`icon` e `url` no `<channel>`. `credits`, `rating` e `star-rating` são aninhados e ficam de fora
— título, descrição, início e fim, que é o que a spec pede, ficam.

**A cobertura publicada é a medida.** O número está em [`STATUS.md`](STATUS.md) e em
`status.json`; a cobertura do iptv-org é parcial por natureza e o projeto não arredonda para cima.

### Grade fatiada por canal, em JSON

Para quem não consegue parsear XMLTV — um player de TV com pouca memória, por exemplo — a grade
sai também em um JSON por canal, com janela curta:

```
https://raw.githubusercontent.com/melocalex/iptv-br-playlist/main/docs/epg/index.json
```

O índice lista cada canal com o **nome de arquivo pronto**, então o consumidor nunca precisa
reproduzir a transformação do `tvg-id` (`Globo.br@SD` → `Globo.br_at_SD.json`):

```json
{
  "horizonHours": 24,
  "timeFormat": "epoch-seconds-utc",
  "channels": 179,
  "items": [{ "id": "GloboNews.br@SD", "name": "GloboNews",
              "file": "GloboNews.br_at_SD.json", "count": 29,
              "from": 1792816200, "to": 1792902600 }]
}
```

Cada fatia:

```json
{
  "id": "GloboNews.br@SD", "name": "GloboNews", "logo": "https://…",
  "horizonHours": 24, "now": 0, "count": 29,
  "programmes": [
    { "s": 1792816200, "e": 1792819200,
      "t": "Jornal GloboNews - Edição Da Meia-Noite - Ao Vivo", "d": "", "c": [] }
  ]
}
```

- `s` / `e` são **epoch em segundos, UTC** — inteiro, não timestamp XMLTV. Parsear
  `20261024120000 +0000` em BrightScript é sofrimento; `s` é aritmética direta.
- `now` é o índice do programa em curso dentro de `programmes`, ou `-1` se nenhum. Dá para
  desenhar "no ar agora" sem varrer o array.
- `t` título, `d` descrição (cortada em `epg.sliceDescMaxChars`), `c` categorias.
- `programmes` vem ordenado por início, e inclui o programa que já começou e ainda não acabou.

Tamanho medido: **179 arquivos, 6.092 programas, 1.471 KB no total, média 8,2 KB, maior 30,8 KB**
(um canal de desenhos curtos). O consumidor lê um arquivo por vez.

As fatias são geradas na etapa de `build`, a partir do `epg.xml.gz` **já verificado**, e não na
job isolada do grabber — assim o JSON publicado não sai de um workspace onde código de terceiro
rodou. Canal que perde a grade tem a fatia removida; o diretório é refeito a cada execução.

## Configuração

Nenhum limite, timeout ou concorrência vive no código. Tudo em `config/` e tudo sobrescrevível
por variável de ambiente — veja [`.env.example`](.env.example).

| Arquivo | O que define |
| --- | --- |
| `config/config.json` | dono do repositório, timeouts, concorrência, carência de recheck, EPG, saídas |
| `config/sources.json` | registro modular de fontes; acrescentar outra lista pública é um objeto novo |
| `config/taxonomy.json` | grupos de país, categorias em pt-BR, ordem das seções |
| `config/evidence.json` | padrões que classificam uma falha por evidência, escada de resolução |
| `config/epg.json` | sites do grabber e guias publicados, com o que foi medido em cada um |

Regra do override: `IPTV_` + caminho da chave em maiúscula.
`validation.concurrency` → `IPTV_VALIDATION_CONCURRENCY`.

### Fontes redundantes

`index.m3u` do iptv-org já contém as entradas das listas de país e de categoria — medido: as
11.323 URLs dele são todas subconjunto de `streams.json`. As listas redundantes estão declaradas
em `config/sources.json` com `coveredBy` e **não são baixadas**. Para provar a redundância em vez
de confiar nela:

```bash
npm run all -- --verify-redundancy
```

O relatório passa a trazer, por fonte, quantas entradas faltavam na master.

## Rodando local (macOS)

Precisa de Node 22.6+ (o projeto roda TypeScript direto, sem build) e de ffmpeg.

```bash
brew install ffmpeg
npm install
npm run typecheck && npm test
node src/cli.ts check
```

Comandos:

```bash
node src/cli.ts sources                        # só baixa e resume as fontes
node src/cli.ts validate --only=BR --limit=200 # valida uma fatia
node src/cli.ts epg                            # só o EPG
node src/cli.ts build --skip-epg               # gera playlists com o health que já existe
node src/cli.ts all                            # tudo
```

`--only` aceita grupos separados por vírgula (`--only=BR,PT`). `--limit=0` remove o teto.
`--force` ignora o cache HTTP.

## Automação

[`.github/workflows/atualizar.yml`](.github/workflows/atualizar.yml) roda todo dia às 03:10 de
Brasília e também sob demanda. O workflow tem **uma** permissão, `contents: write`, não usa
segredo nenhum e comita o que mudou.

Custo controlado por três mecanismos: GET condicional com ETag nas fontes (cache de disco),
`node_modules` do grabber em cache, e validação incremental — cada status tem sua carência em
`validation.recheckHours`, e `validation.maxChecksPerRun` limita quanto cada execução checa.
Canal nunca checado vai na frente; Brasil e Portugal têm prioridade.

## Postura de segurança

Todo o conteúdo vem de base pública editável por terceiros (`channels.json` do iptv-org) e de
código de terceiro (o grabber). As defesas são por isso, não por formalidade:

- **Nome, logo e URL nunca entram como HTML.** O painel monta a tabela por nó de DOM, com
  `textContent`, e só aceita logo com esquema `http(s)`. Verificado injetando payload no
  `dashboard-data.json` servido: renderiza como texto, nenhum script executa.
- **Nada injeta linha na M3U publicada.** Valor com CR/LF é achatado numa linha, URL que não for
  `http(s)` sem espaço é descartada, e diretiva copiada da fonte passa por lista permitida.
  Sem isso, um nome de canal com `\n` viraria uma entrada nova apontando para outro stream.
- **O grabber roda isolado.** É a única parte que executa código de terceiro, e roda numa job
  com `contents: read`, sem credencial, cujo workspace é descartado. Ele entrega apenas
  arquivos por artifact. A job que publica faz checkout limpo, não roda nada de terceiro e
  comita **somente** os caminhos de uma lista fechada — arquivo fora dela derruba a execução.
- **O pin do grabber é conferido sempre.** `epg.grabberRef` é um commit SHA; `HEAD` e
  `git status --porcelain` são checados a cada execução, inclusive quando o diretório vem do
  cache do Actions, e qualquer divergência refaz o clone.
- **Só a job confiável grava cache.** As outras usam `actions/cache/restore`. Se a job do
  grabber pudesse gravar o cache de fontes, ela envenenaria o `channels.json` que a job de
  publicação usa para montar as playlists.
- **Download tem teto.** Corpo lido em pedaços com limite e descompressão com `maxOutputLength`:
  um `.gz` de fonte pública pode ser bomba de descompressão.
- **O XMLTV publicado é reconstruído, não copiado.** Os filhos permitidos de `<programme>` e
  `<channel>` são extraídos, decodificados e reescapados; o resto é descartado. Copiar o
  conteúdo cru exigiria confiar que a fonte emite XML bem formado, e nenhuma lista de padrões
  proibidos resolve isso — `<title>sem fechar` passaria por qualquer regex e quebraria o player
  de quem consome. Reconstruindo, o arquivo é bem formado por construção.
- **A job que publica reconfere os arquivos de EPG** (`node src/cli.ts verify-epg`): gzip válido,
  raiz `<tv>`, XML balanceado por contagem de tags, timestamp XMLTV válido, nenhum programa sem
  `<channel>` declarado, índice dentro dos tipos e tetos esperados. Ela não confia na etapa
  anterior só porque é do mesmo projeto.

Risco residual assumido: o `node_modules` do grabber vem do cache do Actions e não é coberto
pela checagem de árvore limpa (não é versionado no repositório dele). A job é sem credencial e
descartável, então o alcance fica no conteúdo do próprio guia — que já é dado de terceiro por
natureza. Para zerar também isso, desligue o cache `epg-grabber` no workflow.

## Limitações conhecidas

A lista completa é **gerada a partir do que foi medido** em cada execução, no fim de
[`STATUS.md`](STATUS.md). As estruturais:

- **Sem failover automático.** Streams alternativos ficam nos metadados, mas trocar de stream
  depende do player. O projeto não implementa nem testou failover, então não alega que exista.
- **Cobertura de EPG é parcial.** Pelos motivos da seção acima.
- **Resultado depende do ponto de observação.** Vale o que está medido, não o que seria desejável.
- **Streams públicos caem.** A lista do iptv-org muda todo dia; é por isso que existe histórico de
  saúde em vez de uma decisão definitiva por stream.
- **Legenda em HLS não é conclusiva.** Detectada quando aparece; ausência não é afirmada.

## Painel

GitHub Pages serve [`docs/`](docs/) com filtro por país, categoria, status, cobertura de EPG e
áudio em português verificado. Os dados vêm de `docs/dashboard-data.json`, gerado junto com as
playlists.

## Usando com o MeloPlayer

A URL da playlist principal serve direto como entrada no **MeloPlayer**, o canal Roku sideloaded
que toca listas M3U. É só apontar o player para ela — a lista já vem validada, em seções e com
EPG referenciado.
