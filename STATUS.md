# Status dashboard

Generated at **2026-10-25T11:27:38.842Z**.

## Discovery

| Metric | Value |
| --- | --- |
| Channels discovered | 12332 |
| Streams discovered (unique URLs) | 18056 |
| Duplicate URLs collapsed | 11333 |
| Channels with no metadata in the source | 2031 |

## Validation

A validation result depends on where the probe runs. The GitHub Actions runner sits in the United States and sees different availability than a machine in Brazil. **Numbers from different observation points do not add up.**

| Status | github-us | local-br |
| --- | --- | --- |
| WORKING | 2391 | 2388 |
| UNSTABLE | 17 | 87 |
| OFFLINE | 1110 | 1303 |
| TIMEOUT | 60 | 204 |
| GEO_BLOCKED | 0 | 0 |
| AUTH_REQUIRED | 8 | 21 |
| UNSUPPORTED | 104 | 144 |
| UNKNOWN | 0 | 0 |

| Observation point | Last run | Checked | Eligible | Fresh (skipped) |
| --- | --- | --- | --- | --- |

## Status per channel

A channel's status is the best among its streams. `UNKNOWN` dominates because each run checks at most `validation.maxChecksPerRun` streams, and a channel with any stream not yet checked counts as unknown, not as unavailable.

| Status | Channels |
| --- | --- |
| WORKING | 2442 |
| UNSTABLE | 30 |
| OFFLINE | 0 |
| TIMEOUT | 85 |
| GEO_BLOCKED | 0 |
| AUTH_REQUIRED | 0 |
| UNSUPPORTED | 0 |
| UNKNOWN | 9703 |

## Published channels

These are the channels that enter the validated playlists: eligible **and** carrying metadata in the source. A stream with no channel metadata is never published, so it is not counted here — there were 855 such streams in this run, and they appear only in `playlist-all.m3u`.

| Metric | Value |
| --- | --- |
| Channels published in the main playlist | 1617 |
| Of those, status WORKING | 1610 |
| Of those, unstable | 7 |
| Brazilian channels | 290 |
| International channels | 1327 |
| With an alternative stream kept | 522 |
| With guide coverage | 269 |
| With **verified** Portuguese audio | 50 |
| With **verified** subtitles | 287 |
| With unreliable subtitle detection (HLS) | 1584 |

### By country group

| Group | Published channels |
| --- | --- |
| OTHER | 687 |
| BR | 290 |
| LATAM | 273 |
| US | 240 |
| ES | 49 |
| PT | 40 |
| UK | 23 |
| INT | 15 |

### By category

| Category | Published channels |
| --- | --- |
| Geral | 589 |
| Notícias | 208 |
| Cultura | 179 |
| Entretenimento | 147 |
| Filmes | 86 |
| Música | 82 |
| Séries | 72 |
| Variedades | 71 |
| Infantil | 69 |
| Esportes | 49 |
| Documentários | 27 |
| Educação | 24 |
| Animação | 14 |

## Programme guide

| Metric | Value |
| --- | --- |
| Channels requested from the guide | 1617 |
| Channels with a guide | 269 |
| Measured coverage | 16.64% |
| Programmes in the guide | 12908 |
| Horizon | 72 h |
| Channels without a guide | 1348 |

### Per-channel slices

A short guide in JSON, one file per channel, for consumers that do not parse XMLTV. Times are **epoch seconds, UTC**. The index publishes the ready-made file name, so a consumer never has to reproduce any `tvg-id` transformation.

| Metric | Value |
| --- | --- |
| Files | 269 |
| Programmes | 8826 |
| Window | 24 h |
| Total size | 2033.5 KB |
| Largest file | 42.3 KB |
| Index | `https://raw.githubusercontent.com/melocalex/lighteye/main/docs/epg/index.json` |

iptv-org's guide coverage is partial by nature. The number above is the **measured** one, with no rounding up. The full list of channels without a guide is in `data/epg-coverage.json`.

### Guide sources

| Source | Kind | OK | Channels requested | Channels with a guide | Programmes | Note |
| --- | --- | --- | --- | --- | --- | --- |
| mi.tv | grabber | yes | 100 | 96 | 5347 | - |
| meuguia.tv | grabber | yes | 33 | 19 | 407 | - |
| meo.pt | grabber | yes | 26 | 26 | 934 | - |
| nostv.pt | grabber | yes | 21 | 17 | 271 | - |
| gatotv.com | grabber | yes | 24 | 23 | 676 | - |
| pluto.tv | grabber | yes | 112 | 107 | 3391 | - |
| kanya-us | published | yes | n/a | 66 | 1882 | - |
| kanya-ke | published | yes | n/a | 0 | 0 | - |

## Playlists

| File | Contents | Channels | Entries | Sections |
| --- | --- | --- | --- | --- |
| `playlist.m3u` | Main (all sections, validated) | 1617 | 1617 | 84 |
| `playlist-br.m3u` | Brazil | 290 | 290 | 13 |
| `playlist-pt.m3u` | Portuguese (PT + Portuguese-speaking) | 329 | 329 | 22 |
| `playlist-movies.m3u` | Movies | 86 | 86 | 8 |
| `playlist-series.m3u` | Series (TV shows) | 79 | 79 | 10 |
| `playlist-sports.m3u` | Sports | 50 | 50 | 6 |
| `playlist-international.m3u` | International (everything outside Brazil) | 1327 | 1327 | 71 |
| `playlist-all.m3u` | Everything, including unverified and unavailable | 12260 | 17962 | 101 |

## Known limitations

- Results from 2 observation points (local-br, github-us) are reported separately and **do not add up**: the same stream can be WORKING at one and GEO_BLOCKED at another.
- 9703 channels have never been checked. The per-run cap is `validation.maxChecksPerRun` = 1200; coverage grows each round.
- Measured guide coverage: 269 of 1617 channels in the main playlist (1348 without a guide). Measured, with no rounding up.
- 2436 channels are served over HLS. ffprobe does not open the subtitle variant playlist, so **absence of a subtitle track does not prove absence of subtitles** on those channels.
- No playlist performs automatic failover. Alternative streams are kept in `data/channels.json`, but switching streams is up to the player: the project neither implements nor has tested failover, so it does not claim one exists.
- Nothing here circumvents DRM, authentication, paywalls or geoblocking. `GEO_BLOCKED` is only a diagnostic label, based on HTTP 451 or explicit text in the response.
- 2031 streams have no channel metadata in the source. They stay out of the validated playlists and appear only in `playlist-all.m3u`, because classifying by channel name would be guessing.
