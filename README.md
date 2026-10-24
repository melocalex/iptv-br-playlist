# LightEye

**Ask an AI what is on television right now, and get an answer grounded in evidence —
or an explicit "I don't know".**

LightEye builds a corpus of live TV channels where every record carries the observation that
produced it, and puts a retrieval layer on top of it. You can ask a question in plain language
and get back channels, streams and programmes **with the measurement that backs each claim**:
what was probed, from where, at what time, with what result.

The research objective is stated in **[RESEARCH.md](RESEARCH.md)**. The thesis: *a channel
catalogue becomes useful to a language model only once availability is measured rather than
claimed.* Public directories are assertions, and an assertion is not retrievable ground truth.

```bash
node src/cli.ts ask "what news channels in Portuguese are on right now"
```

```
- GloboNews (`GloboNews.br@SD`, BR) — confirmed from your observation point: WORKING
  at `local-br` on 2026-10-24T03:44:46.074Z (2.08 h ago)
  URL: http://79.127.238.228:14093
  On air: Globo Repórter (05:20–06:00 UTC)

Evidence: 28 channels passed the filter, 28 have a valid observation, 11 of those have a
guide and 10 have a programme on air. The guide covers 179 of 1169 indexed channels (15.31%).
```

## Scope and limits

LightEye aggregates and measures **publicly available** stream directories, primarily
[iptv-org](https://github.com/iptv-org/iptv). It is deliberately built so that:

- **No DRM, authentication, paywall or geoblocking is circumvented.** `GEO_BLOCKED` is a
  diagnostic label derived from HTTP 451 or explicit text in a response — never an attempt to
  work around one.
- **No credentials are handled.** No login, no token, no Xtream support, by design.
- **Nothing is re-hosted.** The project stores URLs and measurements, never stream content.

These are properties of the design, not disclaimers. They are what makes the corpus
reproducible by anyone from the same public sources.

## The AI layer

### Asking

```bash
node src/cli.ts ask "what is on CazeTV"
node src/cli.ts ask "does GloboNews.br@SD work from here" --vantage=local-br
node src/cli.ts ask "any football on now" --no-model   # retrieval only, no API call
```

Four decisions define this layer:

- **No vector database.** 1,169 published channels and ~6,000 programmes in the window fit in
  memory. The index is hand-written BM25 (`src/lexical.ts`) combined with structural filters —
  country, category, language, observation point, time window. It costs less, answers faster
  and, above all, is debuggable: you can point at which term retrieved which channel. Measured:
  the whole corpus loads and indexes in ~600 ms. Replacing it with embeddings needs a number
  that justifies the change.
- **Availability is a function of the observer.** The per-channel verdict distinguishes
  `CONFIRMED_HERE` from `CONFIRMED_ELSEWHERE`. The same stream is `WORKING` from Brazil and
  refused from the US runner, and the answer never promises it opens for you when the
  confirmation came from somewhere else.
- **"I don't know" is an answer.** Stale evidence, a channel with no guide, or a name absent
  from the corpus produce a declared abstention with the measured reason. The failure mode to
  beat is confidently recommending a stream that does not play.
- **What is on air comes from the clock, not a precomputed pointer.** The layer compares the
  slice's `s`/`e` against the instant of the question, and the slice's `generatedAt` decides
  whether the data is too old to answer (`rag.freshness.guideStaleAfterHours`).

Every answer that passes through the model is checked before it is returned: a `tvg-id` or URL
that is not in the evidence block drops the generated text and the deterministic wording stands.

### MCP server

The same layer exposes four tools over stdio, in JSON-RPC, with no dependencies:

| Tool | Returns |
| --- | --- |
| `search_channels` | channels matching the filter, with availability per observation point and a guide verdict |
| `channel_evidence` | every observation for a `tvg-id`, with HTTP, reason, measured media and freshness |
| `now_playing` | what the guide says is on air, or a statement that it is unknown |
| `corpus_stats` | measured corpus numbers, so nothing is generalized about the catalogue |

```bash
npm run mcp
```

[`.mcp.json`](.mcp.json) registers the server for clients that read that project
configuration. A channel left out of the index stays queryable: `channel_evidence` answers with
the evidence for its exclusion — status, HTTP and `checkedAt` — instead of "unknown channel".

### Generation

The final wording can come from the Anthropic API. The key comes from `ANTHROPIC_API_KEY` in the
environment, never from the code. Without it, retrieval works identically and the answer is
deterministic, with a notice saying so. Model, token cap and timeout live in `config/rag.json`.

### Evaluation

```bash
npm run rag:eval
```

[`config/eval.json`](config/eval.json) holds 17 questions with expectations for the plan
(extracted filters), the retrieval (who must appear) and the abstention. The command fails if
any case fails and writes `data/rag-eval.json` with the `now` it used — the score depends on the
instant, because evidence expires and the guide window lasts 24 h. To reproduce an old
measurement:

```bash
node src/cli.ts rag-eval --now=2026-10-24T05:52:00Z
```

## The corpus

Everything is a static file served over HTTPS from the repository. There is no server.

Base URL: `https://raw.githubusercontent.com/melocalex/lighteye/main/`

| Artifact | Contents |
| --- | --- |
| `data/channels.json` | the document corpus: ~12,000 channels with country, category, languages, timezones, classification reason, and per-stream measurements |
| `data/health.json` | observation history per stream, per observation point, with timestamps and evidence |
| `docs/epg/index.json` + `docs/epg/<channel>.json` | per-channel programme slices, 24 h window, epoch seconds |
| `epg.xml.gz` | full XMLTV guide |
| `status.json` / [`STATUS.md`](STATUS.md) | aggregate counts, measured |
| `playlist.m3u` and slices | the catalogue as a playable M3U, organized into sections |

### As a playlist

The playlist is the human-facing view of the same corpus — the format television players
already read. The guide is referenced in the header, so players load it automatically:

```
https://raw.githubusercontent.com/melocalex/lighteye/main/playlist.m3u
```

Narrower slices: `playlist-br.m3u`, `playlist-pt.m3u`, `playlist-movies.m3u`,
`playlist-series.m3u`, `playlist-sports.m3u`, `playlist-international.m3u`, and
`playlist-all.m3u` (everything, including unverified and unavailable, each entry carrying an
`x-health` attribute). Swap the file name at the end of the URL.

The section is the `group-title` attribute, formatted `Country • Category`
(`🇧🇷 Brasil • Notícias`). File order is section order: Brazil first, then Portugal, Latin
America, Spain, United States, United Kingdom, International, Other Countries; within each
country, categories follow a configured order.

TiviMate, IPTV Smarters and Kodi render these as navigable sections. VLC is the exception: it
ignores `group-title` and flattens the list, so there you only perceive the ordering.

## How a channel is categorized

Country and category **never** come from the channel's name. They come from source metadata:

- category: `channels.json#categories` from iptv-org, mapped in
  [`config/taxonomy.json`](config/taxonomy.json);
- country: `feeds.json#broadcast_area` takes precedence over `channels.json#country`, because a
  dedicated feed is what actually reaches the viewer. `AELatinAmerica.us@Brazil` has
  `broadcast_area` `c/BR`, so it lands in **Brazil**, not United States;
- `International` only when the broadcast area is worldwide (`r/WW`, `r/UN`) or spans three or
  more countries;
- the reason for each decision is recorded per channel as `countryGroupReason`.

A stream with no channel metadata in the source stays out of the validated playlists and appears
only in `playlist-all.m3u`. Guessing a category from a channel name would look better in the
report and be wrong.

A boot check compares the taxonomy against `countries.json` and `categories.json` on every run
and **aborts** if a code does not exist. That is how it surfaced that iptv-org uses `UK`, not
`GB` — without the check, the United Kingdom group would have stayed silently empty.

## Measurement

Each stream goes through an HTTP pre-check and, if it responds, a real `ffprobe`. Recorded:
resolution, video and audio codec, fps, audio channels, **detected audio languages**, subtitle
tracks, HTTP response, probe timestamp and failure reason.

| Status | When |
| --- | --- |
| `WORKING` | ffprobe opened it and found an audio or video track |
| `UNSTABLE` | succeeded on one attempt and failed on another, or flaps between runs |
| `OFFLINE` | network error, or 4xx/5xx with no declared reason |
| `TIMEOUT` | connect or probe deadline exceeded |
| `GEO_BLOCKED` | **only** with HTTP 451 or explicit regional-block text in the response |
| `AUTH_REQUIRED` | HTTP 401, `WWW-Authenticate`, or explicit authentication text |
| `UNSUPPORTED` | responded, but ffprobe found nothing playable |
| `UNKNOWN` | not yet checked in this window |

Two rules the reporting keeps:

- **`GEO_BLOCKED` requires proof.** A bare HTTP 403 stays `OFFLINE` with `reason: http_403` and
  a snippet of the body kept as evidence: refusal proven, motive not.
- **Absence of subtitles is not proof of absence.** Over HLS, ffprobe does not open the subtitle
  variant playlist. In those cases `subtitleDetectionReliable` is `false`, and the dashboard
  counts them separately instead of asserting the channel has no subtitles.

A stream is not dropped after one failure. History lives in `data/health.json` (versioned), and
only after `validation.dropAfterFailures` consecutive failures does it leave the validated
playlists — while remaining in `playlist-all.m3u`. Alternative streams for the same channel are
kept in the metadata, ranked by measured reliability.

### Where the probe runs changes the result

The GitHub Actions runner sits in the United States. Many Brazilian channels answer a probe from
Brazil and refuse one from there — and some do the opposite. So every result is recorded per
**observation point** (`local-br`, `github-us`) and the report shows both side by side.
**Numbers from different points do not add up.** A channel enters the validated playlists if it
worked from at least one point, and the metadata says which.

To measure from Brazil, on your own machine:

```bash
IPTV_VANTAGE=local-br npm run all
```

## Programme guide

Measured on 2026-10-24, and worth stating because published documentation elsewhere is stale:

- `https://iptv-org.github.io/epg/guides/` returns **HTTP 404**;
- `iptv-org/epg` publishes no release and has no `gh-pages` branch;
- its `GUIDES.md`, the community guide list, had **every host red, 0 channels**, and no Brazil
  or Portugal entry at all.

There is no ready-made guide to download. Two paths are used instead:

1. **The iptv-org grabber itself** (primary). It emits XMLTV whose `xmltv_id` is identical to
   the playlist's `tvg-id` (`AELatinAmerica.us@Brazil`), so the join is exact, with no guessing.
   It runs only for channels that made it into the playlist and only for sites covering them —
   `mi.tv`, `meuguia.tv`, `meo.pt`, `nostv.pt`, `gatotv.com`, `pluto.tv`. See
   [`config/epg.json`](config/epg.json).
2. **Already-published, verified guides.** `https://epg.kanya.io/us/guide.xml.gz` is the guide
   iptv-org's own `index.m3u` points at via `x-tvg-url`, and its ids are already `channel@feed`.
   Measured: 1,401 channels, 65,766 programmes — but **0 of 394 Brazilian channels** and 2 of 66
   Portuguese. Useful for international coverage; it does not solve Brazil.

A third-party guide with its own id scheme (`i.mjh.nz`, for example) stays **disabled** by
default: matching by name similarity would be guessing. To enable one, supply an explicit
`idMap`.

The guide is normalized to canonical XMLTV timestamps, deduplicated by `(channel, start, stop)`
and cut at `epg.programmeHorizonHours`. No schedule is invented: a channel without a source has
no programmes and is listed in `data/epg-coverage.json`.

Re-emitted elements are `title`, `sub-title`, `desc`, `category`, `country`, `language`,
`orig-language`, `date`, `episode-num`, `length` and `icon` inside `<programme>`, and
`display-name`, `icon` and `url` inside `<channel>`. `credits`, `rating` and `star-rating` are
nested and are dropped; title, description, start and end are kept.

**Published coverage is measured coverage.** The number is in [`STATUS.md`](STATUS.md) and
`status.json`. iptv-org's coverage is partial by nature and this project does not round up.

### Per-channel guide slices

For consumers that cannot parse XMLTV — a television player with little memory, for instance —
the guide is also published as one small JSON per channel:

```
https://raw.githubusercontent.com/melocalex/lighteye/main/docs/epg/index.json
```

The index lists each channel with its **ready-made file name**, so a consumer never reproduces
the `tvg-id` transformation (`Globo.br@SD` → `Globo.br_at_SD.json`):

```json
{
  "horizonHours": 24,
  "timeFormat": "epoch-seconds-utc",
  "channels": 179,
  "items": [{ "id": "GloboNews.br@SD", "name": "GloboNews",
              "file": "GloboNews.br_at_SD.json", "count": 29,
              "from": 1792816200, "to": 1792902600 }]
}
```

Each slice:

```json
{
  "id": "GloboNews.br@SD", "name": "GloboNews", "logo": "https://…",
  "horizonHours": 24, "count": 29,
  "programmes": [
    { "s": 1792816200, "e": 1792819200,
      "t": "Jornal GloboNews - Edição Da Meia-Noite - Ao Vivo", "d": "", "c": [] }
  ]
}
```

- `s` / `e` are **epoch seconds, UTC** — an integer, not an XMLTV timestamp. Parsing
  `20261024120000 +0000` on a constrained client is painful; `s` is plain arithmetic.
- `t` title, `d` description (capped at `epg.sliceDescMaxChars`), `c` categories.
- `programmes` is ordered by start time and includes the programme already in progress.
- **There is no field pointing at what is on air.** One existed and was removed: it was computed
  at generation time while the file is served for hours, so it went wrong and led consumers to
  display the wrong programme. Find it against the local clock — `p.s <= now && p.e > now`.

Measured: 179 files, ~6,000 programmes, ~1,460 KB total, ~8 KB average, 31 KB largest. A
consumer reads one file at a time.

Slices are generated during `build`, from the **already verified** `epg.xml.gz`, not in the
isolated grabber job — so the published JSON does not come out of a workspace where third-party
code ran. A channel that loses its guide has its slice removed; the directory is rebuilt on
every run.

#### Source day boundary

Some channels' listings only start at 06:00 UTC (03:00 in Brasília), which is the day rollover
for sites like `mi.tv`. Generating **before** that hour leaves those channels with nothing on
air until then — measured on a manual run at 05:10 UTC: 29 of 179 channels in that state. The
daily cron runs at **06:10 UTC**, just after the rollover; on the same data that would drop to
**1 channel**. If you trigger the workflow by hand, prefer after 06:10 UTC. The same question
therefore has different answers depending on when the guide was generated.

## Configuration

No limit, timeout or concurrency number lives in the code. Everything is in `config/` and
overridable by environment variable — see [`.env.example`](.env.example).

| File | Defines |
| --- | --- |
| `config/config.json` | repository identity, timeouts, concurrency, re-check grace periods, EPG, outputs |
| `config/sources.json` | modular source registry; adding another public list is one new object |
| `config/taxonomy.json` | country groups, categories, section ordering |
| `config/evidence.json` | patterns that classify a failure by evidence, resolution ladder |
| `config/epg.json` | grabber sites and published guides, each with what was measured |
| `config/rag.json` | BM25 weights, evidence freshness per status, evidence block size, model, and the Portuguese search lexicon |
| `config/eval.json` | retrieval evaluation set, with the pass floor the test enforces |

Override rule: `IPTV_` + the key path in upper case.
`validation.concurrency` → `IPTV_VALIDATION_CONCURRENCY`. The retrieval layer uses its own
prefix: `rag.retrieval.bm25K1` → `IPTV_RAG_RETRIEVAL_BM25K1`.

### Redundant sources

iptv-org's `index.m3u` already contains the entries of the country and category lists —
measured: its 11,323 URLs are all a subset of `streams.json`. Redundant lists are declared in
`config/sources.json` with `coveredBy` and **are not downloaded**. To prove the redundancy
instead of trusting it:

```bash
npm run all -- --verify-redundancy
```

The report then shows, per source, how many entries were missing from the master.

## Running locally

Requires Node 22.6+ (the project runs TypeScript directly, with no build step) and ffmpeg.

```bash
brew install ffmpeg
npm install
npm run typecheck && npm test
node src/cli.ts check
```

Commands:

```bash
node src/cli.ts sources                        # fetch and summarize the sources only
node src/cli.ts validate --only=BR --limit=200 # validate a slice
node src/cli.ts epg                            # build the guide only
node src/cli.ts verify-epg                     # re-verify the guide artifacts
node src/cli.ts build --skip-epg               # generate outputs from existing health data
node src/cli.ts all                            # everything
node src/cli.ts ask "question"                 # grounded answer over the corpus
node src/cli.ts mcp                            # MCP server over stdio
node src/cli.ts rag-eval                       # score the retrieval
```

`ask`, `mcp` and `rag-eval` read only what has already been published: no source downloads, no
network, no ffmpeg.

`--only` takes comma-separated groups (`--only=BR,PT`). `--limit=0` removes the cap. `--force`
ignores the HTTP cache.

## Automation

[`.github/workflows/atualizar.yml`](.github/workflows/atualizar.yml) runs daily at 06:10 UTC and
on demand. It has three jobs and **no workflow-level permissions**:

| Job | Permission | Role |
| --- | --- | --- |
| `validar` | `contents: read` | project code and ffprobe only |
| `epg` | `contents: read` | the **only** job running third-party code; no credentials, workspace discarded |
| `publicar` | `contents: write` | clean checkout, consumes artifacts, commits an allow-listed set of paths |

Cost is bounded by three mechanisms: conditional GET with ETag on the sources, a cached grabber,
and incremental validation — each status has its own grace period in
`validation.recheckHours`, and `validation.maxChecksPerRun` caps each run. Never-checked
channels go first; Brazil and Portugal have priority.

## Security posture

All content comes from a publicly editable database (iptv-org's `channels.json`) and from
third-party code (the grabber). The defences exist for that reason:

- **Names, logos and URLs never enter as HTML.** The dashboard builds its table from DOM nodes
  with `textContent` and accepts only `http(s)` logo URLs. Verified by injecting a payload into
  the served `dashboard-data.json`: it renders as text, no script executes.
- **Nothing can inject a line into the published M3U.** Values carrying CR/LF are flattened, a
  URL that is not `http(s)` without whitespace is dropped, and directives copied from the source
  pass an allow list. Without this, a channel name containing `\n` would become a new entry
  pointing at a different stream.
- **The grabber runs isolated**, in a job with `contents: read`, no credentials, whose workspace
  is discarded. The publishing job does a clean checkout, runs nothing third-party, and commits
  **only** paths from a closed list — anything outside it fails the run.
- **The grabber pin is always verified.** `epg.grabberRef` is a commit SHA; `HEAD` and
  `git status --porcelain` are checked on every run, including when the directory comes from the
  Actions cache, and any divergence re-clones.
- **Only the trusted job writes cache.** The others use `actions/cache/restore`. If the grabber
  job could write the source cache, it would poison the `channels.json` the publishing job uses.
- **Downloads are capped.** Bodies are read in chunks with a limit and decompression uses
  `maxOutputLength`: a `.gz` from a public source can be a decompression bomb.
- **The published XMLTV is rebuilt, not copied.** Allowed children of `<programme>` and
  `<channel>` are extracted, decoded and re-escaped; the rest is dropped. Copying raw content
  would require trusting the source to emit well-formed XML, and no denylist fixes that —
  `<title>unclosed` would pass any regex and break downstream parsers.
- **The publishing job re-verifies the guide** (`node src/cli.ts verify-epg`): valid gzip, exact
  prolog, balanced XML by tag counting, valid XMLTV timestamps, no orphan programmes, index
  within expected types and caps. It does not trust the previous stage merely for being part of
  the same project.
- **Third-party text entering the model context is data, never instruction.** Channel names and
  programme titles come from iptv-org and the grabbers and may carry an embedded instruction
  attempt. Before entering the evidence block they are flattened to one line — control
  characters and breaks removed — and capped at `rag.answer.maxTextChars`, so they cannot pose
  as a new prompt section. The block carries a notice saying so, and the system rule is to
  ignore any command appearing in those fields. There is no semantic filter: text that *says*
  something still arrives, it just cannot pretend to be prompt.
- **The generated answer is checked against an allow list.** Any token that looks like an
  address (`://`, `//host`, `www.`, `.m3u8`, `.mpd`) must be exactly a URL from the evidence
  block, and every cited `tvg-id` must be there. Matching only `https?://` would let through
  `www.other/live` and `other/playlist.m3u8`, which a player treats as links all the same. A
  violation drops the model's text and the deterministic wording stands.
- **MCP server output is not authorization.** What it returns is third-party evidence wrapped in
  JSON. An MCP client should not auto-approve actions based on it, and the server executes
  nothing: it only reads published files, with no network and no writes.

Accepted residual risk: the grabber's `node_modules` comes from the Actions cache and is not
covered by the clean-tree check. That job is credential-free and disposable, so the blast radius
stays within guide content — which is third-party data by nature. To close that too, disable the
`epg-grabber` cache in the workflow.

## Known limitations

The full list is **generated from what was measured** on each run, at the end of
[`STATUS.md`](STATUS.md). The structural ones:

- **No automatic failover.** Alternative streams are kept in the metadata, but switching streams
  is up to the player. The project neither implements nor has tested failover, so it does not
  claim one exists.
- **Guide coverage is partial**, for the reasons above.
- **Results depend on the observation point.** What is measured holds; what would be convenient
  does not.
- **`ffprobe` proves reachability, not correctness.** It shows a stream is decodable at an
  instant. It does not prove the picture is right, that it keeps playing, or that it is the
  channel it claims to be. Nothing here verifies broadcast content.
- **Public streams churn.** The iptv-org list changes daily, which is why health history exists
  instead of a permanent per-stream verdict.

## Dashboard

GitHub Pages serves [`docs/`](docs/) with filters by country, category, status, EPG coverage and
verified Portuguese audio: **https://melocalex.github.io/lighteye/**

## Using it with MeloPlayer

The main playlist URL works directly as input to **MeloPlayer**, a sideloaded Roku channel that
plays M3U lists. Point the player at it — the list arrives validated, in sections and with the
guide referenced. MeloPlayer also consumes the per-channel slices above to draw its programme
grid.

## Documentation language

This README, [`RESEARCH.md`](RESEARCH.md), [`.env.example`](.env.example) and the generated
reports are in English. In-source comments and the commit history are in Brazilian Portuguese
and have not been translated: rewriting them mechanically would risk introducing errors for
little benefit, and history cannot be rewritten without a force push.
