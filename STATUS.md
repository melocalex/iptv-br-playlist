# Status dashboard

Generated at **2026-10-24T11:03:22.426Z**.

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
| WORKING | 1988 | 2388 |
| UNSTABLE | 16 | 87 |
| OFFLINE | 915 | 1309 |
| TIMEOUT | 47 | 204 |
| GEO_BLOCKED | 0 | 0 |
| AUTH_REQUIRED | 5 | 21 |
| UNSUPPORTED | 65 | 144 |
| UNKNOWN | 0 | 0 |

| Observation point | Last run | Checked | Eligible | Fresh (skipped) |
| --- | --- | --- | --- | --- |

## Status per channel

A channel's status is the best among its streams. `UNKNOWN` dominates because each run checks at most `validation.maxChecksPerRun` streams, and a channel with any stream not yet checked counts as unknown, not as unavailable.

| Status | Channels |
| --- | --- |
| WORKING | 2164 |
| UNSTABLE | 29 |
| OFFLINE | 0 |
| TIMEOUT | 78 |
| GEO_BLOCKED | 0 |
| AUTH_REQUIRED | 0 |
| UNSUPPORTED | 0 |
| UNKNOWN | 9981 |

## Published channels

These are the channels that enter the validated playlists: eligible **and** carrying metadata in the source. A stream with no channel metadata is never published, so it is not counted here — there were 855 such streams in this run, and they appear only in `playlist-all.m3u`.

| Metric | Value |
| --- | --- |
| Channels published in the main playlist | 1338 |
| Of those, status WORKING | 1332 |
| Of those, unstable | 6 |
| Brazilian channels | 290 |
| International channels | 1048 |
| With an alternative stream kept | 430 |
| With guide coverage | 226 |
| With **verified** Portuguese audio | 50 |
| With **verified** subtitles | 256 |
| With unreliable subtitle detection (HLS) | 1317 |

### By country group

| Group | Published channels |
| --- | --- |
| OTHER | 567 |
| BR | 290 |
| US | 202 |
| LATAM | 173 |
| PT | 40 |
| ES | 31 |
| UK | 21 |
| INT | 14 |

### By category

| Category | Published channels |
| --- | --- |
| Geral | 450 |
| Notícias | 175 |
| Cultura | 149 |
| Entretenimento | 126 |
| Filmes | 83 |
| Música | 78 |
| Séries | 70 |
| Variedades | 61 |
| Infantil | 53 |
| Esportes | 35 |
| Documentários | 25 |
| Educação | 19 |
| Animação | 14 |

## Programme guide

| Metric | Value |
| --- | --- |
| Channels requested from the guide | 1338 |
| Channels with a guide | 226 |
| Measured coverage | 16.89% |
| Programmes in the guide | 10572 |
| Horizon | 72 h |
| Channels without a guide | 1112 |

### Per-channel slices

A short guide in JSON, one file per channel, for consumers that do not parse XMLTV. Times are **epoch seconds, UTC**. The index publishes the ready-made file name, so a consumer never has to reproduce any `tvg-id` transformation.

| Metric | Value |
| --- | --- |
| Files | 226 |
| Programmes | 7624 |
| Window | 24 h |
| Total size | 1780.2 KB |
| Largest file | 30.3 KB |
| Index | `https://raw.githubusercontent.com/melocalex/lighteye/main/docs/epg/index.json` |

iptv-org's guide coverage is partial by nature. The number above is the **measured** one, with no rounding up. The full list of channels without a guide is in `data/epg-coverage.json`.

### Guide sources

| Source | Kind | OK | Channels requested | Channels with a guide | Programmes | Note |
| --- | --- | --- | --- | --- | --- | --- |
| mi.tv | grabber | yes | 83 | 79 | 4230 | - |
| meuguia.tv | grabber | yes | 33 | 20 | 229 | - |
| meo.pt | grabber | yes | 23 | 23 | 801 | - |
| nostv.pt | grabber | yes | 19 | 19 | 384 | - |
| gatotv.com | grabber | yes | 15 | 15 | 571 | - |
| pluto.tv | grabber | yes | 93 | 91 | 2777 | - |
| kanya-us | published | yes | n/a | 49 | 1580 | - |
| kanya-ke | published | yes | n/a | 0 | 0 | - |

## Playlists

| File | Contents | Channels | Entries | Sections |
| --- | --- | --- | --- | --- |
| `playlist.m3u` | Main (all sections, validated) | 1338 | 1338 | 81 |
| `playlist-br.m3u` | Brazil | 290 | 290 | 13 |
| `playlist-pt.m3u` | Portuguese (PT + Portuguese-speaking) | 329 | 329 | 22 |
| `playlist-movies.m3u` | Movies | 83 | 83 | 8 |
| `playlist-series.m3u` | Series (TV shows) | 77 | 77 | 10 |
| `playlist-sports.m3u` | Sports | 36 | 36 | 6 |
| `playlist-international.m3u` | International (everything outside Brazil) | 1048 | 1048 | 68 |
| `playlist-all.m3u` | Everything, including unverified and unavailable | 12252 | 17965 | 101 |

## Known limitations

- Results from 2 observation points (local-br, github-us) are reported separately and **do not add up**: the same stream can be WORKING at one and GEO_BLOCKED at another.
- 9981 channels have never been checked. The per-run cap is `validation.maxChecksPerRun` = 1200; coverage grows each round.
- Measured guide coverage: 226 of 1338 channels in the main playlist (1112 without a guide). Measured, with no rounding up.
- 2168 channels are served over HLS. ffprobe does not open the subtitle variant playlist, so **absence of a subtitle track does not prove absence of subtitles** on those channels.
- No playlist performs automatic failover. Alternative streams are kept in `data/channels.json`, but switching streams is up to the player: the project neither implements nor has tested failover, so it does not claim one exists.
- Nothing here circumvents DRM, authentication, paywalls or geoblocking. `GEO_BLOCKED` is only a diagnostic label, based on HTTP 451 or explicit text in the response.
- 2033 streams have no channel metadata in the source. They stay out of the validated playlists and appear only in `playlist-all.m3u`, because classifying by channel name would be guessing.
