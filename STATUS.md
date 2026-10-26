# Status dashboard

Generated at **2026-10-26T13:00:37.926Z**.

## Discovery

| Metric | Value |
| --- | --- |
| Channels discovered | 12337 |
| Streams discovered (unique URLs) | 18067 |
| Duplicate URLs collapsed | 11340 |
| Channels with no metadata in the source | 2031 |

## Validation

A validation result depends on where the probe runs. The GitHub Actions runner sits in the United States and sees different availability than a machine in Brazil. **Numbers from different observation points do not add up.**

| Status | github-us | local-br |
| --- | --- | --- |
| WORKING | 2863 | 2388 |
| UNSTABLE | 20 | 87 |
| OFFLINE | 1247 | 1283 |
| TIMEOUT | 69 | 204 |
| GEO_BLOCKED | 0 | 0 |
| AUTH_REQUIRED | 8 | 21 |
| UNSUPPORTED | 131 | 144 |
| UNKNOWN | 0 | 0 |

| Observation point | Last run | Checked | Eligible | Fresh (skipped) |
| --- | --- | --- | --- | --- |

## Status per channel

A channel's status is the best among its streams. `UNKNOWN` dominates because each run checks at most `validation.maxChecksPerRun` streams, and a channel with any stream not yet checked counts as unknown, not as unavailable.

| Status | Channels |
| --- | --- |
| WORKING | 2808 |
| UNSTABLE | 33 |
| OFFLINE | 0 |
| TIMEOUT | 91 |
| GEO_BLOCKED | 0 |
| AUTH_REQUIRED | 0 |
| UNSUPPORTED | 0 |
| UNKNOWN | 9333 |

## Published channels

These are the channels that enter the validated playlists: eligible **and** carrying metadata in the source. A stream with no channel metadata is never published, so it is not counted here — there were 855 such streams in this run, and they appear only in `playlist-all.m3u`.

| Metric | Value |
| --- | --- |
| Channels published in the main playlist | 1986 |
| Of those, status WORKING | 1976 |
| Of those, unstable | 10 |
| Brazilian channels | 289 |
| International channels | 1697 |
| With an alternative stream kept | 612 |
| With guide coverage | 320 |
| With **verified** Portuguese audio | 50 |
| With **verified** subtitles | 369 |
| With unreliable subtitle detection (HLS) | 1953 |

### By country group

| Group | Published channels |
| --- | --- |
| OTHER | 874 |
| LATAM | 342 |
| US | 339 |
| BR | 289 |
| ES | 58 |
| PT | 39 |
| UK | 27 |
| INT | 18 |

### By category

| Category | Published channels |
| --- | --- |
| Geral | 679 |
| Notícias | 246 |
| Cultura | 208 |
| Entretenimento | 197 |
| Filmes | 140 |
| Música | 110 |
| Variedades | 97 |
| Séries | 89 |
| Infantil | 78 |
| Esportes | 58 |
| Documentários | 38 |
| Educação | 30 |
| Animação | 16 |

## Programme guide

| Metric | Value |
| --- | --- |
| Channels requested from the guide | 1986 |
| Channels with a guide | 320 |
| Measured coverage | 16.11% |
| Programmes in the guide | 14703 |
| Horizon | 72 h |
| Channels without a guide | 1666 |

### Per-channel slices

A short guide in JSON, one file per channel, for consumers that do not parse XMLTV. Times are **epoch seconds, UTC**. The index publishes the ready-made file name, so a consumer never has to reproduce any `tvg-id` transformation.

| Metric | Value |
| --- | --- |
| Files | 320 |
| Programmes | 10836 |
| Window | 24 h |
| Total size | 2495.8 KB |
| Largest file | 40.1 KB |
| Index | `https://raw.githubusercontent.com/melocalex/lighteye/main/docs/epg/index.json` |

iptv-org's guide coverage is partial by nature. The number above is the **measured** one, with no rounding up. The full list of channels without a guide is in `data/epg-coverage.json`.

### Guide sources

| Source | Kind | OK | Channels requested | Channels with a guide | Programmes | Note |
| --- | --- | --- | --- | --- | --- | --- |
| mi.tv | grabber | yes | 110 | 104 | 5377 | - |
| meuguia.tv | grabber | yes | 33 | 20 | 344 | - |
| meo.pt | grabber | yes | 27 | 27 | 996 | - |
| nostv.pt | grabber | yes | 22 | 16 | 311 | - |
| gatotv.com | grabber | yes | 32 | 30 | 1027 | - |
| pluto.tv | grabber | yes | 139 | 134 | 4142 | - |
| kanya-us | published | yes | n/a | 90 | 2506 | - |
| kanya-ke | published | yes | n/a | 0 | 0 | - |

## Playlists

| File | Contents | Channels | Entries | Sections |
| --- | --- | --- | --- | --- |
| `playlist.m3u` | Main (all sections, validated) | 1986 | 1986 | 86 |
| `playlist-br.m3u` | Brazil | 289 | 289 | 13 |
| `playlist-pt.m3u` | Portuguese (PT + Portuguese-speaking) | 327 | 327 | 22 |
| `playlist-movies.m3u` | Movies | 141 | 141 | 9 |
| `playlist-series.m3u` | Series (TV shows) | 97 | 97 | 10 |
| `playlist-sports.m3u` | Sports | 59 | 59 | 6 |
| `playlist-international.m3u` | International (everything outside Brazil) | 1697 | 1697 | 73 |
| `playlist-all.m3u` | Everything, including unverified and unavailable | 12265 | 17973 | 101 |

## Known limitations

- Results from 2 observation points (local-br, github-us) are reported separately and **do not add up**: the same stream can be WORKING at one and GEO_BLOCKED at another.
- 9333 channels have never been checked. The per-run cap is `validation.maxChecksPerRun` = 1200; coverage grows each round.
- Measured guide coverage: 320 of 1986 channels in the main playlist (1666 without a guide). Measured, with no rounding up.
- 2806 channels are served over HLS. ffprobe does not open the subtitle variant playlist, so **absence of a subtitle track does not prove absence of subtitles** on those channels.
- No playlist performs automatic failover. Alternative streams are kept in `data/channels.json`, but switching streams is up to the player: the project neither implements nor has tested failover, so it does not claim one exists.
- Nothing here circumvents DRM, authentication, paywalls or geoblocking. `GEO_BLOCKED` is only a diagnostic label, based on HTTP 451 or explicit text in the response.
- 2031 streams have no channel metadata in the source. They stay out of the validated playlists and appear only in `playlist-all.m3u`, because classifying by channel name would be guessing.
