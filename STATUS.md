# Status dashboard

Generated at **2026-10-29T13:06:07.209Z**.

## Discovery

| Metric | Value |
| --- | --- |
| Channels discovered | 12363 |
| Streams discovered (unique URLs) | 18401 |
| Duplicate URLs collapsed | 11376 |
| Channels with no metadata in the source | 2030 |

## Validation

A validation result depends on where the probe runs. The GitHub Actions runner sits in the United States and sees different availability than a machine in Brazil. **Numbers from different observation points do not add up.**

| Status | github-us | local-br |
| --- | --- | --- |
| WORKING | 4431 | 2385 |
| UNSTABLE | 48 | 86 |
| OFFLINE | 1787 | 1250 |
| TIMEOUT | 118 | 204 |
| GEO_BLOCKED | 0 | 0 |
| AUTH_REQUIRED | 18 | 21 |
| UNSUPPORTED | 211 | 144 |
| UNKNOWN | 0 | 0 |

| Observation point | Last run | Checked | Eligible | Fresh (skipped) |
| --- | --- | --- | --- | --- |

## Status per channel

A channel's status is the best among its streams. `UNKNOWN` dominates because each run checks at most `validation.maxChecksPerRun` streams, and a channel with any stream not yet checked counts as unknown, not as unavailable.

| Status | Channels |
| --- | --- |
| WORKING | 3774 |
| UNSTABLE | 40 |
| OFFLINE | 0 |
| TIMEOUT | 111 |
| GEO_BLOCKED | 0 |
| AUTH_REQUIRED | 0 |
| UNSUPPORTED | 0 |
| UNKNOWN | 8363 |

## Published channels

These are the channels that enter the validated playlists: eligible **and** carrying metadata in the source. A stream with no channel metadata is never published, so it is not counted here — there were 855 such streams in this run, and they appear only in `playlist-all.m3u`.

| Metric | Value |
| --- | --- |
| Channels published in the main playlist | 2959 |
| Of those, status WORKING | 2942 |
| Of those, unstable | 17 |
| Brazilian channels | 292 |
| International channels | 2667 |
| With an alternative stream kept | 934 |
| With guide coverage | 437 |
| With **verified** Portuguese audio | 53 |
| With **verified** subtitles | 493 |
| With unreliable subtitle detection (HLS) | 2903 |

### By country group

| Group | Published channels |
| --- | --- |
| OTHER | 1452 |
| US | 499 |
| LATAM | 489 |
| BR | 292 |
| ES | 86 |
| UK | 56 |
| PT | 43 |
| INT | 42 |

### By category

| Category | Published channels |
| --- | --- |
| Geral | 948 |
| Notícias | 345 |
| Cultura | 321 |
| Entretenimento | 292 |
| Filmes | 197 |
| Música | 175 |
| Variedades | 168 |
| Séries | 124 |
| Infantil | 123 |
| Esportes | 119 |
| Educação | 66 |
| Documentários | 58 |
| Animação | 23 |

## Programme guide

| Metric | Value |
| --- | --- |
| Channels requested from the guide | 2959 |
| Channels with a guide | 437 |
| Measured coverage | 14.77% |
| Programmes in the guide | 20280 |
| Horizon | 72 h |
| Channels without a guide | 2522 |

### Per-channel slices

A short guide in JSON, one file per channel, for consumers that do not parse XMLTV. Times are **epoch seconds, UTC**. The index publishes the ready-made file name, so a consumer never has to reproduce any `tvg-id` transformation.

| Metric | Value |
| --- | --- |
| Files | 437 |
| Programmes | 14712 |
| Window | 24 h |
| Total size | 3356.1 KB |
| Largest file | 47.5 KB |
| Index | `https://raw.githubusercontent.com/melocalex/lighteye/main/docs/epg/index.json` |

iptv-org's guide coverage is partial by nature. The number above is the **measured** one, with no rounding up. The full list of channels without a guide is in `data/epg-coverage.json`.

### Guide sources

| Source | Kind | OK | Channels requested | Channels with a guide | Programmes | Note |
| --- | --- | --- | --- | --- | --- | --- |
| mi.tv | grabber | yes | 147 | 139 | 7360 | - |
| meuguia.tv | grabber | yes | 33 | 20 | 340 | - |
| meo.pt | grabber | yes | 38 | 38 | 1446 | - |
| nostv.pt | grabber | yes | 24 | 11 | 178 | - |
| gatotv.com | grabber | yes | 58 | 44 | 1397 | - |
| pluto.tv | grabber | yes | 173 | 165 | 5326 | - |
| kanya-us | published | yes | n/a | 145 | 4233 | - |
| kanya-ke | published | yes | n/a | 0 | 0 | - |

## Playlists

| File | Contents | Channels | Entries | Sections |
| --- | --- | --- | --- | --- |
| `playlist.m3u` | Main (all sections, validated) | 2959 | 2959 | 93 |
| `playlist-br.m3u` | Brazil | 292 | 292 | 13 |
| `playlist-pt.m3u` | Portuguese (PT + Portuguese-speaking) | 334 | 334 | 22 |
| `playlist-movies.m3u` | Movies | 198 | 198 | 9 |
| `playlist-series.m3u` | Series (TV shows) | 136 | 136 | 10 |
| `playlist-sports.m3u` | Sports | 121 | 121 | 8 |
| `playlist-international.m3u` | International (everything outside Brazil) | 2667 | 2667 | 80 |
| `playlist-all.m3u` | Everything, including unverified and unavailable | 12288 | 18304 | 101 |

## Known limitations

- Results from 2 observation points (local-br, github-us) are reported separately and **do not add up**: the same stream can be WORKING at one and GEO_BLOCKED at another.
- 8363 channels have never been checked. The per-run cap is `validation.maxChecksPerRun` = 1200; coverage grows each round.
- Measured guide coverage: 437 of 2959 channels in the main playlist (2522 without a guide). Measured, with no rounding up.
- 3756 channels are served over HLS. ffprobe does not open the subtitle variant playlist, so **absence of a subtitle track does not prove absence of subtitles** on those channels.
- No playlist performs automatic failover. Alternative streams are kept in `data/channels.json`, but switching streams is up to the player: the project neither implements nor has tested failover, so it does not claim one exists.
- Nothing here circumvents DRM, authentication, paywalls or geoblocking. `GEO_BLOCKED` is only a diagnostic label, based on HTTP 451 or explicit text in the response.
- 2030 streams have no channel metadata in the source. They stay out of the validated playlists and appear only in `playlist-all.m3u`, because classifying by channel name would be guessing.
