# Status dashboard

Generated at **2026-10-31T12:29:43.128Z**.

## Discovery

| Metric | Value |
| --- | --- |
| Channels discovered | 12346 |
| Streams discovered (unique URLs) | 18386 |
| Duplicate URLs collapsed | 11355 |
| Channels with no metadata in the source | 2034 |

## Validation

A validation result depends on where the probe runs. The GitHub Actions runner sits in the United States and sees different availability than a machine in Brazil. **Numbers from different observation points do not add up.**

| Status | github-us | local-br |
| --- | --- | --- |
| WORKING | 5549 | 2384 |
| UNSTABLE | 65 | 86 |
| OFFLINE | 2191 | 1243 |
| TIMEOUT | 159 | 204 |
| GEO_BLOCKED | 0 | 0 |
| AUTH_REQUIRED | 19 | 21 |
| UNSUPPORTED | 271 | 144 |
| UNKNOWN | 0 | 0 |

| Observation point | Last run | Checked | Eligible | Fresh (skipped) |
| --- | --- | --- | --- | --- |

## Status per channel

A channel's status is the best among its streams. `UNKNOWN` dominates because each run checks at most `validation.maxChecksPerRun` streams, and a channel with any stream not yet checked counts as unknown, not as unavailable.

| Status | Channels |
| --- | --- |
| WORKING | 4598 |
| UNSTABLE | 53 |
| OFFLINE | 0 |
| TIMEOUT | 133 |
| GEO_BLOCKED | 0 |
| AUTH_REQUIRED | 0 |
| UNSUPPORTED | 0 |
| UNKNOWN | 7487 |

## Published channels

These are the channels that enter the validated playlists: eligible **and** carrying metadata in the source. A stream with no channel metadata is never published, so it is not counted here — there were 855 such streams in this run, and they appear only in `playlist-all.m3u`.

| Metric | Value |
| --- | --- |
| Channels published in the main playlist | 3796 |
| Of those, status WORKING | 3766 |
| Of those, unstable | 30 |
| Brazilian channels | 297 |
| International channels | 3499 |
| With an alternative stream kept | 1176 |
| With guide coverage | 477 |
| With **verified** Portuguese audio | 53 |
| With **verified** subtitles | 581 |
| With unreliable subtitle detection (HLS) | 3730 |

### By country group

| Group | Published channels |
| --- | --- |
| OTHER | 2007 |
| US | 632 |
| LATAM | 605 |
| BR | 297 |
| ES | 98 |
| UK | 66 |
| INT | 48 |
| PT | 43 |

### By category

| Category | Published channels |
| --- | --- |
| Geral | 1201 |
| Cultura | 445 |
| Notícias | 431 |
| Entretenimento | 395 |
| Música | 247 |
| Filmes | 243 |
| Variedades | 207 |
| Séries | 157 |
| Esportes | 151 |
| Infantil | 145 |
| Educação | 76 |
| Documentários | 72 |
| Animação | 26 |

## Programme guide

| Metric | Value |
| --- | --- |
| Channels requested from the guide | 3796 |
| Channels with a guide | 477 |
| Measured coverage | 12.57% |
| Programmes in the guide | 22061 |
| Horizon | 72 h |
| Channels without a guide | 3319 |

### Per-channel slices

A short guide in JSON, one file per channel, for consumers that do not parse XMLTV. Times are **epoch seconds, UTC**. The index publishes the ready-made file name, so a consumer never has to reproduce any `tvg-id` transformation.

| Metric | Value |
| --- | --- |
| Files | 477 |
| Programmes | 15860 |
| Window | 24 h |
| Total size | 3577.1 KB |
| Largest file | 42.5 KB |
| Index | `https://raw.githubusercontent.com/melocalex/lighteye/main/docs/epg/index.json` |

iptv-org's guide coverage is partial by nature. The number above is the **measured** one, with no rounding up. The full list of channels without a guide is in `data/epg-coverage.json`.

### Guide sources

| Source | Kind | OK | Channels requested | Channels with a guide | Programmes | Note |
| --- | --- | --- | --- | --- | --- | --- |
| mi.tv | grabber | yes | 152 | 144 | 7340 | - |
| meuguia.tv | grabber | yes | 33 | 28 | 172 | - |
| meo.pt | grabber | yes | 41 | 41 | 1509 | - |
| nostv.pt | grabber | yes | 26 | 19 | 268 | - |
| gatotv.com | grabber | yes | 64 | 63 | 2265 | - |
| pluto.tv | grabber | yes | 185 | 177 | 5716 | - |
| kanya-us | published | yes | n/a | 169 | 4791 | - |
| kanya-ke | published | yes | n/a | 0 | 0 | - |

## Playlists

| File | Contents | Channels | Entries | Sections |
| --- | --- | --- | --- | --- |
| `playlist.m3u` | Main (all sections, validated) | 3796 | 3796 | 94 |
| `playlist-br.m3u` | Brazil | 297 | 297 | 13 |
| `playlist-pt.m3u` | Portuguese (PT + Portuguese-speaking) | 341 | 341 | 24 |
| `playlist-movies.m3u` | Movies | 245 | 245 | 10 |
| `playlist-series.m3u` | Series (TV shows) | 169 | 169 | 10 |
| `playlist-sports.m3u` | Sports | 153 | 153 | 8 |
| `playlist-international.m3u` | International (everything outside Brazil) | 3499 | 3499 | 81 |
| `playlist-all.m3u` | Everything, including unverified and unavailable | 12271 | 18289 | 101 |

## Known limitations

- Results from 2 observation points (local-br, github-us) are reported separately and **do not add up**: the same stream can be WORKING at one and GEO_BLOCKED at another.
- 7487 channels have never been checked. The per-run cap is `validation.maxChecksPerRun` = 1200; coverage grows each round.
- Measured guide coverage: 477 of 3796 channels in the main playlist (3319 without a guide). Measured, with no rounding up.
- 4583 channels are served over HLS. ffprobe does not open the subtitle variant playlist, so **absence of a subtitle track does not prove absence of subtitles** on those channels.
- No playlist performs automatic failover. Alternative streams are kept in `data/channels.json`, but switching streams is up to the player: the project neither implements nor has tested failover, so it does not claim one exists.
- Nothing here circumvents DRM, authentication, paywalls or geoblocking. `GEO_BLOCKED` is only a diagnostic label, based on HTTP 451 or explicit text in the response.
- 2034 streams have no channel metadata in the source. They stay out of the validated playlists and appear only in `playlist-all.m3u`, because classifying by channel name would be guessing.
