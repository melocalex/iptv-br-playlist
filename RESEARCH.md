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

- No embedding index, no vector store, no retrieval or generation code. This repository produces
  the corpus; the RAG layer over it does not exist.
- No evaluation set. There are no reference question/answer pairs, so none of the research
  questions above can be scored today.
