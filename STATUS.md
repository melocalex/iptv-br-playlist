# Painel de status

Gerado em **2026-10-24T05:10:22.778Z**.

## Descoberta

| Metrica | Valor |
| --- | --- |
| Canais descobertos | 12323 |
| Streams descobertos (URLs unicas) | 18058 |
| URLs duplicadas colapsadas | 11323 |
| Canais sem metadado na fonte | 2033 |

## Validacao

Validacao depende de onde o teste roda. O runner do GitHub Actions fica nos Estados Unidos e ve disponibilidade diferente de uma maquina no Brasil. **Os numeros por ponto de observacao nao sao somaveis.**

| Status | github-us | local-br |
| --- | --- | --- |
| WORKING | 1298 | 2388 |
| UNSTABLE | 10 | 87 |
| OFFLINE | 458 | 1309 |
| TIMEOUT | 22 | 204 |
| GEO_BLOCKED | 0 | 0 |
| AUTH_REQUIRED | 2 | 21 |
| UNSUPPORTED | 49 | 144 |
| UNKNOWN | 0 | 0 |

| Ponto de observacao | Ultima execucao | Checados | Elegiveis | Frescos (pulados) |
| --- | --- | --- | --- | --- |

## Status por canal

Status do canal e o melhor entre os streams dele. `UNKNOWN` domina porque cada execucao checa no maximo `validation.maxChecksPerRun` streams, e um canal com qualquer stream ainda nao checado conta como desconhecido, nao como indisponivel.

| Status | Canais |
| --- | --- |
| WORKING | 1995 |
| UNSTABLE | 29 |
| OFFLINE | 0 |
| TIMEOUT | 88 |
| GEO_BLOCKED | 0 |
| AUTH_REQUIRED | 0 |
| UNSUPPORTED | 0 |
| UNKNOWN | 10140 |

## Canais publicados

Estes sao os canais que entram nas playlists validadas: elegiveis **e** com metadado na fonte. Stream sem metadado de canal nunca e publicado, entao nao entra nestas contas — foram 855 streams nessa situacao nesta execucao, e eles aparecem apenas em `playlist-all.m3u`.

| Metrica | Valor |
| --- | --- |
| Canais publicados na playlist principal | 1169 |
| Destes, com status WORKING | 1163 |
| Destes, instaveis | 6 |
| Canais brasileiros | 290 |
| Canais internacionais | 879 |
| Com stream alternativo guardado | 386 |
| Com cobertura de EPG | 179 |
| Com audio em portugues **verificado** | 50 |
| Com legenda **verificada** | 233 |
| Com deteccao de legenda nao confiavel (HLS) | 1150 |

### Por grupo de pais

| Grupo | Canais publicados |
| --- | --- |
| OTHER | 498 |
| BR | 290 |
| US | 179 |
| LATAM | 104 |
| PT | 40 |
| ES | 26 |
| UK | 18 |
| INT | 14 |

### Por categoria

| Categoria | Canais publicados |
| --- | --- |
| Geral | 339 |
| Notícias | 167 |
| Cultura | 144 |
| Entretenimento | 118 |
| Filmes | 81 |
| Música | 66 |
| Séries | 66 |
| Variedades | 57 |
| Infantil | 49 |
| Esportes | 31 |
| Documentários | 21 |
| Educação | 16 |
| Animação | 14 |

## EPG

| Metrica | Valor |
| --- | --- |
| Canais pedidos ao EPG | 1169 |
| Canais com grade | 179 |
| Cobertura medida | 15.31% |
| Programas no guia | 9058 |
| Horizonte | 72 h |
| Canais sem grade | 675 |

### Fatias por canal

Grade curta em JSON, um arquivo por canal, para consumidor que nao parseia XMLTV. Horario em **epoch de segundos, UTC**. O indice publica o nome de arquivo pronto, entao o consumidor nao precisa reproduzir nenhuma transformacao do `tvg-id`.

| Metrica | Valor |
| --- | --- |
| Arquivos | 179 |
| Programas | 6092 |
| Janela | 24 h |
| Tamanho total | 1471.2 KB |
| Maior arquivo | 30.8 KB |
| Indice | `https://raw.githubusercontent.com/melocalex/iptv-br-playlist/main/docs/epg/index.json` |

Cobertura de EPG do iptv-org e parcial por natureza. O numero acima e o **medido**, sem arredondamento para cima. A lista completa de canais sem grade esta em `data/epg-coverage.json`.

### Fontes de EPG

| Fonte | Tipo | OK | Canais pedidos | Canais com grade | Programas | Observacao |
| --- | --- | --- | --- | --- | --- | --- |
| mi.tv | grabber | sim | 68 | 65 | 4149 | - |
| meuguia.tv | grabber | sim | 33 | 26 | 337 | - |
| meo.pt | grabber | sim | 20 | 20 | 946 | - |
| nostv.pt | grabber | sim | 19 | 19 | 526 | - |
| gatotv.com | grabber | sim | 5 | 5 | 267 | - |
| pluto.tv | grabber | sim | 81 | 79 | 2392 | - |
| kanya-us | published | sim | n/a | 24 | 441 | - |
| kanya-ke | published | sim | n/a | 0 | 0 | - |

## Playlists

| Arquivo | Conteudo | Canais | Entradas | Secoes |
| --- | --- | --- | --- | --- |
| `playlist.m3u` | Principal (todas as secoes, validada) | 1169 | 1169 | 80 |
| `playlist-br.m3u` | Brasil | 290 | 290 | 13 |
| `playlist-pt.m3u` | Portugues (PT + lusofonos) | 329 | 329 | 22 |
| `playlist-movies.m3u` | Filmes | 81 | 81 | 8 |
| `playlist-series.m3u` | Series | 72 | 72 | 10 |
| `playlist-sports.m3u` | Esportes | 32 | 32 | 6 |
| `playlist-international.m3u` | Internacional (tudo fora do Brasil) | 879 | 879 | 67 |
| `playlist-all.m3u` | Tudo, inclusive nao verificado e indisponivel | 12252 | 17965 | 101 |

## Limitacoes conhecidas

- Resultados de 2 pontos de observacao (local-br, github-us) sao reportados separadamente e **nao somam**: o mesmo stream pode estar WORKING em um e GEO_BLOCKED em outro.
- 10140 canais ainda nunca foram checados. O limite por execucao e `validation.maxChecksPerRun` = 1200; a cobertura cresce a cada rodada.
- Cobertura de EPG medida: 179 de 1169 canais da playlist principal (990 sem grade). Numero medido, sem arredondar para cima.
- Em 2001 canais o stream e HLS. O ffprobe nao abre a playlist de variante de legenda, logo **ausencia de faixa de legenda nao prova ausencia de legenda** nesses canais.
- Nenhuma playlist faz failover automatico. Streams alternativos ficam guardados em `data/channels.json`, mas trocar de stream depende do player: o projeto nao implementa nem testou failover, e por isso nao alega que exista.
- Nada aqui contorna DRM, autenticacao, paywall ou geobloqueio. `GEO_BLOCKED` e apenas um rotulo de diagnostico, baseado em HTTP 451 ou em texto explicito da resposta.
- 2033 streams nao tem metadado de canal na fonte. Ficam fora das playlists validadas e aparecem apenas em `playlist-all.m3u`, porque classificar pelo nome do canal seria adivinhacao.
