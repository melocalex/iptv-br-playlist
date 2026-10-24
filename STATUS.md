# Status dashboard

Generated at **2026-10-24T06:45:28.675Z**.

## Discovery

| Metric | Value |
| --- | --- |
| Channels discovered | 12323 |
| Streams discovered (unique URLs) | 18058 |
| Duplicate URLs collapsed | 11323 |
| Channels with no metadata in the source | 2033 |

## Validation

A validation result depends on where the probe runs. The GitHub Actions runner sits in the United States and sees different availability than a machine in Brazil. **Numbers from different observation points do not add up.**

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

| Observation point | Last run | Checked | Eligible | Fresh (skipped) |
| --- | --- | --- | --- | --- |

## Status per channel

A channel's status is the best among its streams. `UNKNOWN` dominates because each run checks at most `validation.maxChecksPerRun` streams, and a channel with any stream not yet checked counts as unknown, not as unavailable.

| Status | Channels |
| --- | --- |
| WORKING | 1995 |
| UNSTABLE | 29 |
| OFFLINE | 0 |
| TIMEOUT | 88 |
| GEO_BLOCKED | 0 |
| AUTH_REQUIRED | 0 |
| UNSUPPORTED | 0 |
| UNKNOWN | 10140 |

## Published channels

These are the channels that enter the validated playlists: eligible **and** carrying metadata in the source. A stream with no channel metadata is never published, so it is not counted here — there were 855 such streams in this run, and they appear only in `playlist-all.m3u`.

| Metric | Value |
| --- | --- |
| Channels published in the main playlist | 1169 |
| Of those, status WORKING | 1163 |
| Of those, unstable | 6 |
| Brazilian channels | 290 |
| International channels | 879 |
| With an alternative stream kept | 386 |
| With guide coverage | 179 |
| With **verified** Portuguese audio | 50 |
| With **verified** subtitles | 233 |
| With unreliable subtitle detection (HLS) | 1150 |

### By country group

| Group | Published channels |
| --- | --- |
| OTHER | 498 |
| BR | 290 |
| US | 179 |
| LATAM | 104 |
| PT | 40 |
| ES | 26 |
| UK | 18 |
| INT | 14 |

### By category

| Category | Published channels |
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

## Programme guide

| Metric | Value |
| --- | --- |
| Channels requested from the guide | 1169 |
| Channels with a guide | 179 |
| Measured coverage | 15.31% |
| Programmes in the guide | 9058 |
| Horizon | 72 h |
| Channels without a guide | 675 |

### Per-channel slices

A short guide in JSON, one file per channel, for consumers that do not parse XMLTV. Times are **epoch seconds, UTC**. The index publishes the ready-made file name, so a consumer never has to reproduce any `tvg-id` transformation.

| Metric | Value |
| --- | --- |
| Files | 179 |
| Programmes | 6008 |
| Window | 24 h |
| Total size | 1447.6 KB |
| Largest file | 32.2 KB |
| Index | `https://raw.githubusercontent.com/melocalex/lighteye/main/docs/epg/index.json` |

iptv-org's guide coverage is partial by nature. The number above is the **measured** one, with no rounding up. The full list of channels without a guide is in `data/epg-coverage.json`.

### Guide sources

| Source | Kind | OK | Channels requested | Channels with a guide | Programmes | Note |
| --- | --- | --- | --- | --- | --- | --- |
| mi.tv | grabber | yes | 68 | 65 | 4149 | - |
| meuguia.tv | grabber | yes | 33 | 26 | 337 | - |
| meo.pt | grabber | yes | 20 | 20 | 946 | - |
| nostv.pt | grabber | yes | 19 | 19 | 526 | - |
| gatotv.com | grabber | yes | 5 | 5 | 267 | - |
| pluto.tv | grabber | yes | 81 | 79 | 2392 | - |
| kanya-us | published | yes | n/a | 24 | 441 | - |
| kanya-ke | published | yes | n/a | 0 | 0 | - |

## Playlists

| File | Contents | Channels | Entries | Sections |
| --- | --- | --- | --- | --- |
| `playlist.m3u` | Main (all sections, validated) | 1169 | 1169 | 80 |
| `playlist-br.m3u` | Brazil | 290 | 290 | 13 |
| `playlist-pt.m3u` | Portuguese (PT + Portuguese-speaking) | 329 | 329 | 22 |
| `playlist-movies.m3u` | Movies | 81 | 81 | 8 |
| `playlist-series.m3u` | Series (TV shows) | 72 | 72 | 10 |
| `playlist-sports.m3u` | Sports | 32 | 32 | 6 |
| `playlist-international.m3u` | International (everything outside Brazil) | 879 | 879 | 67 |
| `playlist-all.m3u` | Everything, including unverified and unavailable | 12252 | 17965 | 101 |

## Known limitations

- Results from 2 observation points (local-br, github-us) are reported separately and **do not add up**: the same stream can be WORKING at one and GEO_BLOCKED at another.
- 10140 channels have never been checked. The per-run cap is `validation.maxChecksPerRun` = 1200; coverage grows each round.
- Measured guide coverage: 179 of 1169 channels in the main playlist (990 without a guide). Measured, with no rounding up.
- 2001 channels are served over HLS. ffprobe does not open the subtitle variant playlist, so **absence of a subtitle track does not prove absence of subtitles** on those channels.
- No playlist performs automatic failover. Alternative streams are kept in `data/channels.json`, but switching streams is up to the player: the project neither implements nor has tested failover, so it does not claim one exists.
- Nothing here circumvents DRM, authentication, paywalls or geoblocking. `GEO_BLOCKED` is only a diagnostic label, based on HTTP 451 or explicit text in the response.
- 2033 streams have no channel metadata in the source. They stay out of the validated playlists and appear only in `playlist-all.m3u`, because classifying by channel name would be guessing.
