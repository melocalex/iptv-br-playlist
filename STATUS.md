# Painel de status

Gerado em **2026-10-24T04:28:35.404Z**.

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
| WORKING | 465 | 1338 |
| UNSTABLE | 1 | 39 |
| OFFLINE | 174 | 641 |
| TIMEOUT | 0 | 46 |
| GEO_BLOCKED | 0 | 0 |
| AUTH_REQUIRED | 0 | 17 |
| UNSUPPORTED | 8 | 84 |
| UNKNOWN | 0 | 0 |

| Ponto de observacao | Ultima execucao | Checados | Elegiveis | Frescos (pulados) |
| --- | --- | --- | --- | --- |

## Canais validados

| Metrica | Valor |
| --- | --- |
| Canais funcionando (WORKING) | 1161 |
| Canais brasileiros validados | 290 |
| Canais internacionais validados | 895 |
| Canais instaveis | 24 |
| Canais offline | 0 |
| Canais nunca checados | 11029 |
| Canais com stream alternativo guardado | 2615 |
| Com cobertura de EPG | 139 |
| Com audio em portugues **verificado** | 50 |
| Com legenda **verificada** | 759 |
| Com deteccao de legenda nao confiavel (HLS) | 1176 |

### Por grupo de pais

| Grupo | Canais validados |
| --- | --- |
| OTHER | 855 |
| BR | 290 |
| PT | 40 |

### Por categoria

| Categoria | Canais validados |
| --- | --- |
| Geral | 951 |
| Cultura | 36 |
| Entretenimento | 32 |
| Filmes | 30 |
| Notícias | 28 |
| Séries | 26 |
| Infantil | 19 |
| Educação | 13 |
| Variedades | 13 |
| Música | 11 |
| Animação | 10 |
| Documentários | 9 |
| Esportes | 7 |

## EPG

| Metrica | Valor |
| --- | --- |
| Canais pedidos ao EPG | 330 |
| Canais com grade | 139 |
| Cobertura medida | 42.12% |
| Programas no guia | 7395 |
| Horizonte | 72 h |
| Canais sem grade | 191 |

Cobertura de EPG do iptv-org e parcial por natureza. O numero acima e o **medido**, sem arredondamento para cima. A lista completa de canais sem grade esta em `data/epg-coverage.json`.

### Fontes de EPG

| Fonte | Tipo | OK | Canais pedidos | Canais com grade | Programas | Observacao |
| --- | --- | --- | --- | --- | --- | --- |
| mi.tv | grabber | sim | 60 | 57 | 3792 | - |
| meuguia.tv | grabber | sim | 33 | 26 | 351 | - |
| meo.pt | grabber | sim | 16 | 16 | 818 | - |
| nostv.pt | grabber | sim | 16 | 16 | 399 | - |
| gatotv.com | grabber | sim | 0 | 0 | 0 | nenhum canal da playlist coberto por este site |
| pluto.tv | grabber | sim | 67 | 66 | 2035 | - |
| kanya-us | published | sim | n/a | 0 | 0 | - |
| kanya-ke | published | sim | n/a | 0 | 0 | - |

## Playlists

| Arquivo | Conteudo | Canais | Entradas | Secoes |
| --- | --- | --- | --- | --- |
| `playlist.m3u` | Principal (todas as secoes, validada) | 330 | 330 | 22 |
| `playlist-br.m3u` | Brasil | 290 | 290 | 13 |
| `playlist-pt.m3u` | Portugues (PT + lusofonos) | 329 | 329 | 22 |
| `playlist-movies.m3u` | Filmes | 30 | 30 | 2 |
| `playlist-series.m3u` | Series | 26 | 26 | 2 |
| `playlist-sports.m3u` | Esportes | 7 | 7 | 2 |
| `playlist-international.m3u` | Internacional (tudo fora do Brasil) | 40 | 40 | 9 |
| `playlist-all.m3u` | Tudo, inclusive nao verificado e indisponivel | 12252 | 17965 | 101 |

## Limitacoes conhecidas

- Resultados de 2 pontos de observacao (local-br, github-us) sao reportados separadamente e **nao somam**: o mesmo stream pode estar WORKING em um e GEO_BLOCKED em outro.
- 11029 canais ainda nunca foram checados. O limite por execucao e `validation.maxChecksPerRun` = 1200; a cobertura cresce a cada rodada.
- Cobertura de EPG medida: 139 de 330 canais da playlist principal (191 sem grade). Numero medido, sem arredondar para cima.
- Em 1176 canais o stream e HLS. O ffprobe nao abre a playlist de variante de legenda, logo **ausencia de faixa de legenda nao prova ausencia de legenda** nesses canais.
- Nenhuma playlist faz failover automatico. Streams alternativos ficam guardados em `data/channels.json`, mas trocar de stream depende do player: o projeto nao implementa nem testou failover, e por isso nao alega que exista.
- Nada aqui contorna DRM, autenticacao, paywall ou geobloqueio. `GEO_BLOCKED` e apenas um rotulo de diagnostico, baseado em HTTP 451 ou em texto explicito da resposta.
- 2033 streams nao tem metadado de canal na fonte. Ficam fora das playlists validadas e aparecem apenas em `playlist-all.m3u`, porque classificar pelo nome do canal seria adivinhacao.
