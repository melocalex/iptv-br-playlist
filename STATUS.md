# Status dashboard

Generated at **2026-10-28T12:56:15.683Z**.

## Discovery

| Metric | Value |
| --- | --- |
| Channels discovered | 12340 |
| Streams discovered (unique URLs) | 18146 |
| Duplicate URLs collapsed | 11353 |
| Channels with no metadata in the source | 2030 |

## Validation

A validation result depends on where the probe runs. The GitHub Actions runner sits in the United States and sees different availability than a machine in Brazil. **Numbers from different observation points do not add up.**

| Status | github-us | local-br |
| --- | --- | --- |
| WORKING | 3970 | 2388 |
| UNSTABLE | 41 | 87 |
| OFFLINE | 1611 | 1251 |
| TIMEOUT | 108 | 204 |
| GEO_BLOCKED | 0 | 0 |
| AUTH_REQUIRED | 18 | 21 |
| UNSUPPORTED | 184 | 144 |
| UNKNOWN | 0 | 0 |

| Observation point | Last run | Checked | Eligible | Fresh (skipped) |
| --- | --- | --- | --- | --- |

## Status per channel

A channel's status is the best among its streams. `UNKNOWN` dominates because each run checks at most `validation.maxChecksPerRun` streams, and a channel with any stream not yet checked counts as unknown, not as unavailable.

| Status | Channels |
| --- | --- |
| WORKING | 3519 |
| UNSTABLE | 38 |
| OFFLINE | 0 |
| TIMEOUT | 110 |
| GEO_BLOCKED | 0 |
| AUTH_REQUIRED | 0 |
| UNSUPPORTED | 0 |
| UNKNOWN | 8600 |

## Published channels

These are the channels that enter the validated playlists: eligible **and** carrying metadata in the source. A stream with no channel metadata is never published, so it is not counted here — there were 855 such streams in this run, and they appear only in `playlist-all.m3u`.

| Metric | Value |
| --- | --- |
| Channels published in the main playlist | 2702 |
| Of those, status WORKING | 2687 |
| Of those, unstable | 15 |
| Brazilian channels | 291 |
| International channels | 2411 |
| With an alternative stream kept | 835 |
| With guide coverage | 405 |
| With **verified** Portuguese audio | 51 |
| With **verified** subtitles | 459 |
| With unreliable subtitle detection (HLS) | 2655 |

### By country group

| Group | Published channels |
| --- | --- |
| OTHER | 1283 |
| LATAM | 467 |
| US | 451 |
| BR | 291 |
| ES | 80 |
| UK | 49 |
| PT | 43 |
| INT | 38 |

### By category

| Category | Published channels |
| --- | --- |
| Geral | 883 |
| Notícias | 314 |
| Cultura | 277 |
| Entretenimento | 274 |
| Filmes | 174 |
| Música | 163 |
| Variedades | 144 |
| Infantil | 114 |
| Séries | 113 |
| Esportes | 111 |
| Educação | 64 |
| Documentários | 49 |
| Animação | 22 |

## Programme guide

| Metric | Value |
| --- | --- |
| Channels requested from the guide | 2702 |
| Channels with a guide | 405 |
| Measured coverage | 14.99% |
| Programmes in the guide | 18780 |
| Horizon | 72 h |
| Channels without a guide | 2297 |

### Per-channel slices

A short guide in JSON, one file per channel, for consumers that do not parse XMLTV. Times are **epoch seconds, UTC**. The index publishes the ready-made file name, so a consumer never has to reproduce any `tvg-id` transformation.

| Metric | Value |
| --- | --- |
| Files | 405 |
| Programmes | 13569 |
| Window | 24 h |
| Total size | 3065.2 KB |
| Largest file | 46.3 KB |
| Index | `https://raw.githubusercontent.com/melocalex/lighteye/main/docs/epg/index.json` |

iptv-org's guide coverage is partial by nature. The number above is the **measured** one, with no rounding up. The full list of channels without a guide is in `data/epg-coverage.json`.

### Guide sources

| Source | Kind | OK | Channels requested | Channels with a guide | Programmes | Note |
| --- | --- | --- | --- | --- | --- | --- |
| mi.tv | grabber | yes | 134 | 123 | 6470 | - |
| meuguia.tv | grabber | yes | 33 | 21 | 501 | - |
| meo.pt | grabber | yes | 38 | 38 | 1388 | - |
| nostv.pt | grabber | yes | 24 | 13 | 184 | - |
| gatotv.com | grabber | yes | 48 | 39 | 1231 | - |
| pluto.tv | grabber | yes | 165 | 158 | 5135 | - |
| kanya-us | published | yes | n/a | 131 | 3871 | - |
| kanya-ke | published | yes | n/a | 0 | 0 | - |

## Playlists

| File | Contents | Channels | Entries | Sections |
| --- | --- | --- | --- | --- |
| `playlist.m3u` | Main (all sections, validated) | 2702 | 2702 | 91 |
| `playlist-br.m3u` | Brazil | 291 | 291 | 13 |
| `playlist-pt.m3u` | Portuguese (PT + Portuguese-speaking) | 333 | 333 | 22 |
| `playlist-movies.m3u` | Movies | 175 | 175 | 9 |
| `playlist-series.m3u` | Series (TV shows) | 123 | 123 | 10 |
| `playlist-sports.m3u` | Sports | 113 | 113 | 8 |
| `playlist-international.m3u` | International (everything outside Brazil) | 2411 | 2411 | 78 |
| `playlist-all.m3u` | Everything, including unverified and unavailable | 12267 | 18053 | 101 |

## Known limitations

- Results from 2 observation points (local-br, github-us) are reported separately and **do not add up**: the same stream can be WORKING at one and GEO_BLOCKED at another.
- 8600 channels have never been checked. The per-run cap is `validation.maxChecksPerRun` = 1200; coverage grows each round.
- Measured guide coverage: 405 of 2702 channels in the main playlist (2297 without a guide). Measured, with no rounding up.
- 3508 channels are served over HLS. ffprobe does not open the subtitle variant playlist, so **absence of a subtitle track does not prove absence of subtitles** on those channels.
- No playlist performs automatic failover. Alternative streams are kept in `data/channels.json`, but switching streams is up to the player: the project neither implements nor has tested failover, so it does not claim one exists.
- Nothing here circumvents DRM, authentication, paywalls or geoblocking. `GEO_BLOCKED` is only a diagnostic label, based on HTTP 451 or explicit text in the response.
- 2030 streams have no channel metadata in the source. They stay out of the validated playlists and appear only in `playlist-all.m3u`, because classifying by channel name would be guessing.
