# Status dashboard

Generated at **2026-10-30T13:02:18.171Z**.

## Discovery

| Metric | Value |
| --- | --- |
| Channels discovered | 12369 |
| Streams discovered (unique URLs) | 18410 |
| Duplicate URLs collapsed | 11379 |
| Channels with no metadata in the source | 2034 |

## Validation

A validation result depends on where the probe runs. The GitHub Actions runner sits in the United States and sees different availability than a machine in Brazil. **Numbers from different observation points do not add up.**

| Status | github-us | local-br |
| --- | --- | --- |
| WORKING | 5060 | 2385 |
| UNSTABLE | 64 | 86 |
| OFFLINE | 2055 | 1249 |
| TIMEOUT | 142 | 204 |
| GEO_BLOCKED | 0 | 0 |
| AUTH_REQUIRED | 19 | 21 |
| UNSUPPORTED | 249 | 144 |
| UNKNOWN | 0 | 0 |

| Observation point | Last run | Checked | Eligible | Fresh (skipped) |
| --- | --- | --- | --- | --- |

## Status per channel

A channel's status is the best among its streams. `UNKNOWN` dominates because each run checks at most `validation.maxChecksPerRun` streams, and a channel with any stream not yet checked counts as unknown, not as unavailable.

| Status | Channels |
| --- | --- |
| WORKING | 4227 |
| UNSTABLE | 52 |
| OFFLINE | 0 |
| TIMEOUT | 125 |
| GEO_BLOCKED | 0 |
| AUTH_REQUIRED | 0 |
| UNSUPPORTED | 0 |
| UNKNOWN | 7890 |

## Published channels

These are the channels that enter the validated playlists: eligible **and** carrying metadata in the source. A stream with no channel metadata is never published, so it is not counted here — there were 855 such streams in this run, and they appear only in `playlist-all.m3u`.

| Metric | Value |
| --- | --- |
| Channels published in the main playlist | 3424 |
| Of those, status WORKING | 3395 |
| Of those, unstable | 29 |
| Brazilian channels | 297 |
| International channels | 3127 |
| With an alternative stream kept | 1081 |
| With guide coverage | 452 |
| With **verified** Portuguese audio | 53 |
| With **verified** subtitles | 538 |
| With unreliable subtitle detection (HLS) | 3363 |

### By country group

| Group | Published channels |
| --- | --- |
| OTHER | 1794 |
| US | 559 |
| LATAM | 534 |
| BR | 297 |
| ES | 89 |
| UK | 64 |
| INT | 44 |
| PT | 43 |

### By category

| Category | Published channels |
| --- | --- |
| Geral | 1091 |
| Notícias | 402 |
| Cultura | 393 |
| Entretenimento | 345 |
| Filmes | 226 |
| Música | 207 |
| Variedades | 192 |
| Séries | 138 |
| Infantil | 135 |
| Esportes | 131 |
| Educação | 73 |
| Documentários | 68 |
| Animação | 23 |

## Programme guide

| Metric | Value |
| --- | --- |
| Channels requested from the guide | 3424 |
| Channels with a guide | 452 |
| Measured coverage | 13.2% |
| Programmes in the guide | 20456 |
| Horizon | 72 h |
| Channels without a guide | 2972 |

### Per-channel slices

A short guide in JSON, one file per channel, for consumers that do not parse XMLTV. Times are **epoch seconds, UTC**. The index publishes the ready-made file name, so a consumer never has to reproduce any `tvg-id` transformation.

| Metric | Value |
| --- | --- |
| Files | 452 |
| Programmes | 15060 |
| Window | 24 h |
| Total size | 3398.4 KB |
| Largest file | 46.8 KB |
| Index | `https://raw.githubusercontent.com/melocalex/lighteye/main/docs/epg/index.json` |

iptv-org's guide coverage is partial by nature. The number above is the **measured** one, with no rounding up. The full list of channels without a guide is in `data/epg-coverage.json`.

### Guide sources

| Source | Kind | OK | Channels requested | Channels with a guide | Programmes | Note |
| --- | --- | --- | --- | --- | --- | --- |
| mi.tv | grabber | yes | 148 | 140 | 7306 | - |
| meuguia.tv | grabber | yes | 33 | 23 | 365 | - |
| meo.pt | grabber | yes | 41 | 41 | 1483 | - |
| nostv.pt | grabber | yes | 25 | 17 | 189 | - |
| gatotv.com | grabber | yes | 58 | 57 | 2002 | - |
| pluto.tv | grabber | yes | 180 | 172 | 5513 | - |
| kanya-us | published | yes | n/a | 143 | 3598 | - |
| kanya-ke | published | yes | n/a | 0 | 0 | - |

## Playlists

| File | Contents | Channels | Entries | Sections |
| --- | --- | --- | --- | --- |
| `playlist.m3u` | Main (all sections, validated) | 3424 | 3424 | 93 |
| `playlist-br.m3u` | Brazil | 297 | 297 | 13 |
| `playlist-pt.m3u` | Portuguese (PT + Portuguese-speaking) | 341 | 341 | 24 |
| `playlist-movies.m3u` | Movies | 228 | 228 | 10 |
| `playlist-series.m3u` | Series (TV shows) | 150 | 150 | 10 |
| `playlist-sports.m3u` | Sports | 133 | 133 | 8 |
| `playlist-international.m3u` | International (everything outside Brazil) | 3127 | 3127 | 80 |
| `playlist-all.m3u` | Everything, including unverified and unavailable | 12294 | 18313 | 101 |

## Known limitations

- Results from 2 observation points (local-br, github-us) are reported separately and **do not add up**: the same stream can be WORKING at one and GEO_BLOCKED at another.
- 7890 channels have never been checked. The per-run cap is `validation.maxChecksPerRun` = 1200; coverage grows each round.
- Measured guide coverage: 452 of 3424 channels in the main playlist (2972 without a guide). Measured, with no rounding up.
- 4216 channels are served over HLS. ffprobe does not open the subtitle variant playlist, so **absence of a subtitle track does not prove absence of subtitles** on those channels.
- No playlist performs automatic failover. Alternative streams are kept in `data/channels.json`, but switching streams is up to the player: the project neither implements nor has tested failover, so it does not claim one exists.
- Nothing here circumvents DRM, authentication, paywalls or geoblocking. `GEO_BLOCKED` is only a diagnostic label, based on HTTP 451 or explicit text in the response.
- 2034 streams have no channel metadata in the source. They stay out of the validated playlists and appear only in `playlist-all.m3u`, because classifying by channel name would be guessing.
