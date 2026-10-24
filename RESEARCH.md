# Research objective — channel RAG with AI

> This document states the research objective in English. The operational documentation
> (setup, configuration, workflow) stays in Brazilian Portuguese in [README.md](README.md).

## Objective

Build a retrieval-augmented generation layer over a live television channel corpus, so that a
model can answer questions about **what is on, where, in which language, and whether it actually
plays** — grounded in measured evidence rather than in channel names.

The thesis this repository exists to test: **a channel catalogue becomes useful to a language
model only once availability is measured rather than claimed.** Public IPTV directories are
assertions. An assertion is not retrievable ground truth. Every record here carries the
observation that produced it — what was probed, from where, at what time, with what result — so
retrieval can be filtered by evidence instead of by hope.

## Why this corpus

The pipeline already emits the substrate a RAG system needs. Measured on 2026-10-24:

| Signal | Scale | Notes |
| --- | --- | --- |
| Channels in catalogue | 12,252 | country, categories, languages, timezones, logo, website |
| Channels passing validation | 1,169 | in 80 published sections |
| Streams with health history | 4,167 | per-stream, per-vantage, with timestamps |
| Streams with measured media info | 2,024 channels | codec, resolution, fps, audio language, subtitle tracks |
| Channels with programme guide | 179 | 9,058 programme entries, 72 h horizon |
| Channels with alternative streams | 386 | ranked by measured reliability |
| Declared languages | 212 distinct | from the source's feed metadata |
| Country groups / categories | 8 / 13 | from source metadata, never from the channel name |

Three properties make this different from scraping a directory:

1. **Every classification is traceable.** `countryGroupReason` records *why* a channel landed in
   a group — `feed.broadcast_area=c/BR` or `channel.country=US`. A retrieval answer can cite the
   reason, not just the label.
2. **Every health claim has an observation behind it.** Status, HTTP response, failure reason, a
   snippet of the refusing body, and the probe timestamp. `GEO_BLOCKED` appears only with HTTP
   451 or explicit text; a bare 403 stays `OFFLINE` with the evidence attached.
3. **Observation point is part of the record.** The same stream is `WORKING` from Brazil and
   refused from a United States runner. Measured: 2,393 working from `local-br`, 1,304 from
   `github-us`. Of 1,169 published channels, 1,090 were confirmed from Brazil and 79 only from
   the US runner — and a play-test of that US-only cohort from Brazil opened 8 of 11, against 26
   of 29 for a general sample. **Availability is a function of the observer**, which any honest
   retrieval layer has to model rather than average away.

## Research questions

1. **Grounded availability.** Can a model answer "what can I watch right now, in Portuguese,
   that will actually play from here" using only evidence-bearing records, and abstain when the
   evidence is stale or absent? The failure mode to beat is confident recommendation of a dead
   stream.
2. **Metadata-only classification.** The pipeline deliberately refuses to infer category from a
   channel's name. How far does source metadata alone carry, and where does it run out? Measured
   today: 855 eligible streams carry no channel metadata at all and are therefore unpublishable.
   Can a model close that gap *and* mark its own inferences as inferences?
3. **Partial guide coverage as a first-class state.** EPG covers 179 of 1,169 channels — 15.31%,
   measured, not rounded up. Most questions about "what's on" have no answer. How should a
   retrieval layer represent and communicate a corpus that is mostly silent?
4. **Observer-dependent retrieval.** Given per-vantage records, can retrieval be conditioned on
   the asker's location without collapsing to a single global truth?
5. **Freshness decay.** Health records age with per-status grace periods. What is the useful
   half-life of a validation result, and can that be learned from the history rather than
   configured?

## The retrieval substrate

Published to the repository and served over HTTPS, no server involved:

| Artifact | Shape | Use in retrieval |
| --- | --- | --- |
| `data/channels.json` | full per-channel records, ~18 MB | the document corpus |
| `data/health.json` | per-stream, per-vantage observation history | evidence and freshness |
| `data/epg-index.json` | `tvg-id` → programme count | guide coverage signal |
| `epg.xml.gz` | XMLTV, 179 channels, 9,058 programmes | temporal grounding |
| `docs/epg/<channel>.json` | per-channel 24 h slice, epoch seconds, ~8 KB each | per-channel temporal retrieval |
| `docs/epg/index.json` | channel → file, with programme counts and time range | slice discovery |
| `status.json` | aggregate counts per vantage and category | corpus-level priors |
| `docs/dashboard-data.json` | compact per-channel summary, ~158 KB | lightweight index |

Stable identity is `tvg-id` in `channel@feed` form (`Globo.br@SD`), which joins the playlist,
the metadata and the XMLTV guide exactly, with no name matching anywhere in the chain.

## The retrieval layer, as built

Implemented in this repository, no runtime dependency added:

| Module | Role |
| --- | --- |
| `src/lexical.ts` | BM25 over weighted fields, written by hand; accent-folded tokenizer |
| `src/corpus.ts` | loads `data/channels.json` and the `docs/epg/` slices into documents and indexes |
| `src/plan.ts` | Portuguese/English question → structured query (country, category, language, vantage, time window) |
| `src/retrieve.ts` | structured filter + BM25, then a per-channel verdict for availability and for programme |
| `src/ask.ts` | evidence block, grounding rules, deterministic rendering, post-hoc grounding check |
| `src/anthropic.ts` | minimal Messages API client; key from `ANTHROPIC_API_KEY`, never from code |
| `src/mcp.ts` | MCP server over stdio: `search_channels`, `channel_evidence`, `now_playing`, `corpus_stats` |
| `src/evaluate.ts` | scores `config/eval.json` against the published corpus |

**No vector store.** 1,169 published channels and 6,073 programmes in the window fit in memory;
measured, the whole corpus loads and indexes in ~600 ms. A term index is also the only one of the
two that can say *which word retrieved which channel*, which a research claim needs. Switching to
embeddings requires a retrieval number that justifies it; none exists yet.

**Two verdicts per candidate, never averaged away.** Availability is one of `CONFIRMED_HERE`,
`CONFIRMED_ELSEWHERE`, `STALE`, `REFUSED`, `NEVER_CHECKED`, resolved against the asker's vantage.
Programme is one of `ON_AIR`, `GUIDE_GAP`, `GUIDE_STALE`, `NO_GUIDE`. Measured on the published
corpus on 2026-10-24, from `local-br`: 1,102 `CONFIRMED_HERE`, 67 `CONFIRMED_ELSEWHERE`, and for
the guide 178 `ON_AIR`, 1 `GUIDE_GAP`, 990 `NO_GUIDE`.

**Generation cannot exceed the evidence.** Every `tvg-id` and every URL in a model-written answer
is checked against the evidence block; a citation that is not there discards the generated text and
the deterministic rendering stands. Channels excluded from the index stay queryable by `tvg-id` and
answer with the evidence of their exclusion, so "does X work?" has a measured answer when the
answer is no — 9,141 channels are held that way.

## Measured evaluation

`config/eval.json` holds 17 questions. Each declares what is expected of the plan (the filters
extracted), of retrieval (which `tvg-id`s must and must not appear) and of abstention. Run with
`npm run rag:eval`; the report lands in `data/rag-eval.json`.

Measured at `now = 2026-10-24T05:57:15.877Z`, against the corpus generated the same day:

| Metric | Result |
| --- | --- |
| Cases passed | 17 / 17 |
| Individual checks passed | 78 / 78 |
| Channels indexed / with guide | 1,169 / 179 (15.31%) |

What that number is and is not:

- It measures **conformance to the specification**, not agreement with the world. The expected
  answers were written against this corpus after inspecting retrieval output, and there are no
  human relevance judgements. A second author writing the same set would be the next step.
- **Generation was not scored.** No `ANTHROPIC_API_KEY` was present in the environment where this
  was built, so no model-written answer was ever produced or graded. The API client and the
  grounding check are covered by tests against a local HTTP server; the model's own text is not.
- Two cases are adversarial rather than confirmatory, and one of them failed on first run and
  changed the design: a channel name absent from the corpus used to fall back to the whole
  catalogue, and now abstains.
- The score is a function of the instant. Shifting one case 72 h forward makes every observation
  in the corpus stale and the layer abstains on both axes — the freshness rule, measured rather
  than asserted.
- It is also a function of **when the guide was generated**, not only of when the question is
  asked. Part of the source rolls the day at 06:00 UTC, so a guide built before that hour leaves
  channels with no programme on air: measured by the pipeline, 29 of 179 channels at a 05:10 UTC
  generation against 1 at the 06:10 UTC cron. "What is on now" therefore has a different answer
  for the same question and the same clock, depending on an upstream publication boundary. That
  is a property of the corpus the retrieval layer has to report, not smooth over — and a second
  reason the single number above needs its timestamp to mean anything.

Against the five research questions: 1, 3 and 4 are now scorable and scored above. Question 2
remains unscorable for the path that matters — measured today, 0 of the 50 channels with verified
Portuguese audio lack `por` in their declared metadata, so there is no instance where measured
audio rescues missing metadata. Question 5 is unaddressed: grace periods are still configured in
`config/rag.json`, not learned from the health history.

## Constraints the design accepts

These are research constraints, not defects to be hidden:

- **No content-level ground truth.** `ffprobe` proves a stream is reachable and decodable at an
  instant. It does not prove the picture is correct, that it continues, or that the stream is the
  channel it claims to be. Nothing here verifies *what* is being broadcast.
- **Guide coverage is thin and skewed.** Sources cover Brazil and Portugal; the 879 international
  channels are largely without a guide.
- **Snapshots, not streams of truth.** Validation is point-in-time. A general sample from the
  published playlist opened 26 of 29 — the gap is ordinary churn in public streams.
- **Nothing is circumvented.** No DRM, authentication, paywall or geoblocking is bypassed, and no
  credential is handled. That bounds the corpus to what is already public.

## Not built yet

Named so the gap is explicit, not implied:

- **No scored generation.** The answer-writing path exists and is guarded, but no model output has
  been graded, because no API key was available where this was built. Faithfulness of the written
  answer to the evidence block is therefore asserted by construction, not measured.
- **No independent relevance judgements.** The evaluation set states what the layer should do, and
  its author also wrote the layer. Retrieval quality against someone else's idea of a good answer
  is unmeasured, and so is recall: the set says which channels must appear, never that no better
  channel was missed.
- **No learned freshness.** Research question 5 stands open. The useful half-life of a validation
  result is configured per status in `config/rag.json`; nothing derives it from the health history
  that `data/health.json` already keeps.
- **No embedding index.** Deliberate, not pending — the lexical index is the current answer, and a
  measured retrieval failure is what would justify changing it.
- **Conversation state is absent.** Each question is answered on its own; follow-ups ("and in
  Spanish?") start from zero.
