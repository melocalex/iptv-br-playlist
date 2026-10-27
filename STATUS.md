# Status dashboard

Generated at **2026-10-27T12:16:25.631Z**.

## Discovery

| Metric | Value |
| --- | --- |
| Channels discovered | 12337 |
| Streams discovered (unique URLs) | 18068 |
| Duplicate URLs collapsed | 11340 |
| Channels with no metadata in the source | 2031 |

## Validation

A validation result depends on where the probe runs. The GitHub Actions runner sits in the United States and sees different availability than a machine in Brazil. **Numbers from different observation points do not add up.**

| Status | github-us | local-br |
| --- | --- | --- |
| WORKING | 3538 | 2388 |
| UNSTABLE | 28 | 87 |
| OFFLINE | 1478 | 1282 |
| TIMEOUT | 97 | 204 |
| GEO_BLOCKED | 0 | 0 |
| AUTH_REQUIRED | 11 | 21 |
| UNSUPPORTED | 150 | 144 |
| UNKNOWN | 0 | 0 |

| Observation point | Last run | Checked | Eligible | Fresh (skipped) |
| --- | --- | --- | --- | --- |

## Status per channel

A channel's status is the best among its streams. `UNKNOWN` dominates because each run checks at most `validation.maxChecksPerRun` streams, and a channel with any stream not yet checked counts as unknown, not as unavailable.

| Status | Channels |
| --- | --- |
| WORKING | 3263 |
| UNSTABLE | 37 |
| OFFLINE | 0 |
| TIMEOUT | 105 |
| GEO_BLOCKED | 0 |
| AUTH_REQUIRED | 0 |
| UNSUPPORTED | 0 |
| UNKNOWN | 8860 |

## Published channels

These are the channels that enter the validated playlists: eligible **and** carrying metadata in the source. A stream with no channel metadata is never published, so it is not counted here — there were 855 such streams in this run, and they appear only in `playlist-all.m3u`.

| Metric | Value |
| --- | --- |
| Channels published in the main playlist | 2445 |
| Of those, status WORKING | 2431 |
| Of those, unstable | 14 |
| Brazilian channels | 291 |
| International channels | 2154 |
| With an alternative stream kept | 756 |
| With guide coverage | 356 |
| With **verified** Portuguese audio | 50 |
| With **verified** subtitles | 421 |
| With unreliable subtitle detection (HLS) | 2400 |

### By country group

| Group | Published channels |
| --- | --- |
| OTHER | 1150 |
| LATAM | 421 |
| US | 393 |
| BR | 291 |
| ES | 77 |
| PT | 40 |
| UK | 38 |
| INT | 35 |

### By category

| Category | Published channels |
| --- | --- |
| Geral | 830 |
| Notícias | 290 |
| Cultura | 247 |
| Entretenimento | 236 |
| Filmes | 153 |
| Música | 140 |
| Variedades | 119 |
| Infantil | 109 |
| Séries | 105 |
| Esportes | 87 |
| Educação | 62 |
| Documentários | 46 |
| Animação | 21 |

## Programme guide

| Metric | Value |
| --- | --- |
| Channels requested from the guide | 2445 |
| Channels with a guide | 356 |
| Measured coverage | 14.56% |
| Programmes in the guide | 16051 |
| Horizon | 72 h |
| Channels without a guide | 2089 |

### Per-channel slices

A short guide in JSON, one file per channel, for consumers that do not parse XMLTV. Times are **epoch seconds, UTC**. The index publishes the ready-made file name, so a consumer never has to reproduce any `tvg-id` transformation.

| Metric | Value |
| --- | --- |
| Files | 356 |
| Programmes | 11783 |
| Window | 24 h |
| Total size | 2676.2 KB |
| Largest file | 35.2 KB |
| Index | `https://raw.githubusercontent.com/melocalex/lighteye/main/docs/epg/index.json` |

iptv-org's guide coverage is partial by nature. The number above is the **measured** one, with no rounding up. The full list of channels without a guide is in `data/epg-coverage.json`.

### Guide sources

| Source | Kind | OK | Channels requested | Channels with a guide | Programmes | Note |
| --- | --- | --- | --- | --- | --- | --- |
| mi.tv | grabber | yes | 127 | 111 | 4594 | - |
| meuguia.tv | grabber | yes | 33 | 18 | 257 | - |
| meo.pt | grabber | yes | 28 | 28 | 1095 | - |
| nostv.pt | grabber | yes | 22 | 16 | 217 | - |
| gatotv.com | grabber | yes | 45 | 45 | 1952 | - |
| pluto.tv | grabber | yes | 149 | 144 | 4606 | - |
| kanya-us | published | yes | n/a | 106 | 3330 | - |
| kanya-ke | published | yes | n/a | 0 | 0 | - |

## Playlists

| File | Contents | Channels | Entries | Sections |
| --- | --- | --- | --- | --- |
| `playlist.m3u` | Main (all sections, validated) | 2445 | 2445 | 91 |
| `playlist-br.m3u` | Brazil | 291 | 291 | 13 |
| `playlist-pt.m3u` | Portuguese (PT + Portuguese-speaking) | 330 | 330 | 22 |
| `playlist-movies.m3u` | Movies | 154 | 154 | 9 |
| `playlist-series.m3u` | Series (TV shows) | 114 | 114 | 10 |
| `playlist-sports.m3u` | Sports | 88 | 88 | 8 |
| `playlist-international.m3u` | International (everything outside Brazil) | 2154 | 2154 | 78 |
| `playlist-all.m3u` | Everything, including unverified and unavailable | 12265 | 17974 | 101 |

## Known limitations

- Results from 2 observation points (local-br, github-us) are reported separately and **do not add up**: the same stream can be WORKING at one and GEO_BLOCKED at another.
- 8860 channels have never been checked. The per-run cap is `validation.maxChecksPerRun` = 1200; coverage grows each round.
- Measured guide coverage: 356 of 2445 channels in the main playlist (2089 without a guide). Measured, with no rounding up.
- 3253 channels are served over HLS. ffprobe does not open the subtitle variant playlist, so **absence of a subtitle track does not prove absence of subtitles** on those channels.
- No playlist performs automatic failover. Alternative streams are kept in `data/channels.json`, but switching streams is up to the player: the project neither implements nor has tested failover, so it does not claim one exists.
- Nothing here circumvents DRM, authentication, paywalls or geoblocking. `GEO_BLOCKED` is only a diagnostic label, based on HTTP 451 or explicit text in the response.
- 2031 streams have no channel metadata in the source. They stay out of the validated playlists and appear only in `playlist-all.m3u`, because classifying by channel name would be guessing.
