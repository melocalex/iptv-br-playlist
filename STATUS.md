# Painel de status

Gerado em **2026-10-24T04:14:45.768Z**.

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
| WORKING | 307 | 1338 |
| UNSTABLE | 0 | 39 |
| OFFLINE | 85 | 641 |
| TIMEOUT | 0 | 46 |
| GEO_BLOCKED | 0 | 0 |
| AUTH_REQUIRED | 0 | 17 |
| UNSUPPORTED | 6 | 84 |
| UNKNOWN | 0 | 0 |

| Ponto de observacao | Ultima execucao | Checados | Elegiveis | Frescos (pulados) |
| --- | --- | --- | --- | --- |

## Canais validados

| Metrica | Valor |
| --- | --- |
| Canais funcionando (WORKING) | 1159 |
| Canais brasileiros validados | 289 |
| Canais internacionais validados | 894 |
| Canais instaveis | 24 |
| Canais offline | 0 |
| Canais nunca checados | 11031 |
| Canais com stream alternativo guardado | 2615 |
| Com cobertura de EPG | 0 |
| Com audio em portugues **verificado** | 50 |
| Com legenda **verificada** | 759 |
| Com deteccao de legenda nao confiavel (HLS) | 1174 |

### Por grupo de pais

| Grupo | Canais validados |
| --- | --- |
| OTHER | 855 |
| BR | 289 |
| PT | 39 |

### Por categoria

| Categoria | Canais validados |
| --- | --- |
| Geral | 950 |
| Cultura | 36 |
| Entretenimento | 32 |
| Filmes | 30 |
| Notícias | 27 |
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
| Canais pedidos ao EPG | 328 |
| Canais com grade | 0 |
| Cobertura medida | 0% |
| Programas no guia | 0 |
| Horizonte | 72 h |
| Canais sem grade | 328 |

Cobertura de EPG do iptv-org e parcial por natureza. O numero acima e o **medido**, sem arredondamento para cima. A lista completa de canais sem grade esta em `data/epg-coverage.json`.

### Fontes de EPG

| Fonte | Tipo | OK | Canais pedidos | Canais com grade | Programas | Observacao |
| --- | --- | --- | --- | --- | --- | --- |

## Playlists

| Arquivo | Conteudo | Canais | Entradas | Secoes |
| --- | --- | --- | --- | --- |
| `playlist.m3u` | Principal (todas as secoes, validada) | 328 | 328 | 22 |
| `playlist-br.m3u` | Brasil | 289 | 289 | 13 |
| `playlist-pt.m3u` | Portugues (PT + lusofonos) | 327 | 327 | 22 |
| `playlist-movies.m3u` | Filmes | 30 | 30 | 2 |
| `playlist-series.m3u` | Series | 26 | 26 | 2 |
| `playlist-sports.m3u` | Esportes | 7 | 7 | 2 |
| `playlist-international.m3u` | Internacional (tudo fora do Brasil) | 39 | 39 | 9 |
| `playlist-all.m3u` | Tudo, inclusive nao verificado e indisponivel | 12252 | 17965 | 101 |

## Limitacoes conhecidas

- Resultados de 2 pontos de observacao (local-br, github-us) sao reportados separadamente e **nao somam**: o mesmo stream pode estar WORKING em um e GEO_BLOCKED em outro.
- 11031 canais ainda nunca foram checados. O limite por execucao e `validation.maxChecksPerRun` = 1200; a cobertura cresce a cada rodada.
- Cobertura de EPG medida: 0 de 328 canais da playlist principal (328 sem grade). Numero medido, sem arredondar para cima.
- Em 1174 canais o stream e HLS. O ffprobe nao abre a playlist de variante de legenda, logo **ausencia de faixa de legenda nao prova ausencia de legenda** nesses canais.
- Nenhuma playlist faz failover automatico. Streams alternativos ficam guardados em `data/channels.json`, mas trocar de stream depende do player: o projeto nao implementa nem testou failover, e por isso nao alega que exista.
- Nada aqui contorna DRM, autenticacao, paywall ou geobloqueio. `GEO_BLOCKED` e apenas um rotulo de diagnostico, baseado em HTTP 451 ou em texto explicito da resposta.
- 2033 streams nao tem metadado de canal na fonte. Ficam fora das playlists validadas e aparecem apenas em `playlist-all.m3u`, porque classificar pelo nome do canal seria adivinhacao.
