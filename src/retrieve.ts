/**
 * Recuperacao com evidencia: filtro estrutural, BM25 e veredito por canal.
 *
 * Duas propriedades do corpus sao modeladas aqui em vez de achatadas:
 *
 * 1. Disponibilidade depende do ponto de observacao. O mesmo stream esta WORKING do
 *    Brasil e recusado do runner dos EUA, entao o veredito distingue "confirmado
 *    daqui" de "confirmado de outro ponto".
 * 2. A grade cobre uma fracao dos canais. "Nao sei o que esta passando" e a resposta
 *    correta na maioria das perguntas, e por isso tem veredito proprio.
 */

import type { HealthStatus, RagConfig } from './config.ts';
import { isSuccess } from './health.ts';
import type { ChannelDoc, Corpus, CorpusStats, GuideProgramme } from './corpus.ts';
import { searchIndex } from './lexical.ts';
import type { Query } from './plan.ts';

export type AvailabilityVerdict =
  | 'CONFIRMED_HERE'
  | 'CONFIRMED_ELSEWHERE'
  | 'STALE'
  | 'REFUSED'
  | 'NEVER_CHECKED';

export type ProgrammeVerdict = 'ON_AIR' | 'GUIDE_GAP' | 'GUIDE_STALE' | 'NO_GUIDE';

export interface Observation {
  streamKey: string;
  url: string;
  vantage: string;
  status: HealthStatus;
  checkedAt: string;
  ageHours: number;
  http: number | null;
  reason: string | null;
  stale: boolean;
}

export interface Availability {
  verdict: AvailabilityVerdict;
  status: HealthStatus | null;
  vantage: string | null;
  checkedAt: string | null;
  ageHours: number | null;
  http: number | null;
  reason: string | null;
  streamKey: string | null;
  url: string | null;
  resolution: string | null;
  audioLanguages: string[];
  verifiedPortugueseAudio: boolean;
  /** Toda observacao do canal, para a resposta poder citar divergencia entre pontos. */
  observations: Observation[];
}

export interface ProgrammeNow {
  verdict: ProgrammeVerdict;
  current: GuideProgramme | null;
  next: GuideProgramme[];
  programmesInSlice: number;
  sliceGeneratedAt: string | null;
}

export interface Candidate {
  channel: ChannelDoc;
  score: number;
  lexicalScore: number;
  availability: Availability;
  programme: ProgrammeNow;
}

export interface Abstention {
  kind: 'availability' | 'programme';
  reason: string;
}

export interface RetrievalCounts {
  indexed: number;
  /** Depois do filtro estrutural (pais, categoria, idioma) ou do tvg-id citado. */
  afterFilters: number;
  /** Depois da busca lexical restringir o universo. Igual ao anterior quando nao ha texto. */
  afterText: number;
  afterEvidence: number;
  excludedStale: number;
  excludedRefused: number;
  excludedNeverChecked: number;
  withGuide: number;
  onAir: number;
}

export interface RetrievalResult {
  query: Query;
  candidates: Candidate[];
  abstentions: Abstention[];
  notes: string[];
  counts: RetrievalCounts;
  stats: CorpusStats;
  now: number;
}

const VERDICT_TIER: Record<AvailabilityVerdict, number> = {
  CONFIRMED_HERE: 0,
  CONFIRMED_ELSEWHERE: 1,
  STALE: 2,
  REFUSED: 3,
  NEVER_CHECKED: 4,
};

function staleLimit(rag: RagConfig, status: HealthStatus): number {
  return rag.freshness.staleAfterHours[status] ?? 0;
}

export function observationsOf(rag: RagConfig, channel: ChannelDoc, now: number): Observation[] {
  const out: Observation[] = [];
  for (const s of channel.streams) {
    for (const [vantage, v] of Object.entries(s.byVantage)) {
      const at = Date.parse(v.checkedAt);
      if (Number.isNaN(at)) continue;
      const ageHours = (now - at) / 3_600_000;
      out.push({
        streamKey: s.key,
        url: s.url,
        vantage,
        status: v.status,
        checkedAt: v.checkedAt,
        ageHours: Number(ageHours.toFixed(2)),
        http: v.http,
        reason: v.reason,
        stale: ageHours > staleLimit(rag, v.status),
      });
    }
  }
  out.sort((a, b) => b.checkedAt.localeCompare(a.checkedAt) || a.streamKey.localeCompare(b.streamKey));
  return out;
}

function verdictOf(obs: Observation, askVantage: string): AvailabilityVerdict {
  if (isSuccess(obs.status) && !obs.stale) {
    return obs.vantage === askVantage ? 'CONFIRMED_HERE' : 'CONFIRMED_ELSEWHERE';
  }
  if (isSuccess(obs.status)) return 'STALE';
  return 'REFUSED';
}

export function availabilityOf(
  rag: RagConfig,
  channel: ChannelDoc,
  askVantage: string,
  now: number,
): Availability {
  const observations = observationsOf(rag, channel, now);
  const streamOf = new Map(channel.streams.map((s) => [s.key, s]));

  let best: { obs: Observation; verdict: AvailabilityVerdict } | null = null;
  for (const obs of observations) {
    const verdict = verdictOf(obs, askVantage);
    if (!best || VERDICT_TIER[verdict] < VERDICT_TIER[best.verdict]) best = { obs, verdict };
  }

  if (!best) {
    const primary = channel.streams[0] ?? null;
    return {
      verdict: 'NEVER_CHECKED',
      status: null,
      vantage: null,
      checkedAt: null,
      ageHours: null,
      http: null,
      reason: null,
      streamKey: primary?.key ?? null,
      url: primary?.url ?? null,
      resolution: primary?.resolution ?? null,
      audioLanguages: primary?.audioLanguages ?? [],
      verifiedPortugueseAudio: false,
      observations,
    };
  }

  const stream = streamOf.get(best.obs.streamKey);
  return {
    verdict: best.verdict,
    status: best.obs.status,
    vantage: best.obs.vantage,
    checkedAt: best.obs.checkedAt,
    ageHours: best.obs.ageHours,
    http: best.obs.http,
    reason: best.obs.reason,
    streamKey: best.obs.streamKey,
    url: best.obs.url,
    resolution: stream?.resolution ?? null,
    audioLanguages: stream?.audioLanguages ?? [],
    verifiedPortugueseAudio: channel.streams.some((s) => s.verifiedPortugueseAudio),
    observations,
  };
}

export function programmeOf(
  rag: RagConfig,
  corpus: Corpus,
  channel: ChannelDoc,
  now: number,
): ProgrammeNow {
  const slice = corpus.guide.get(channel.tvgId);
  if (!slice) {
    return {
      verdict: 'NO_GUIDE',
      current: null,
      next: [],
      programmesInSlice: 0,
      sliceGeneratedAt: null,
    };
  }

  const nowSec = Math.floor(now / 1000);
  const tol = rag.freshness.programmeToleranceSeconds;
  const current = slice.programmes.find((p) => p.start - tol <= nowSec && p.end + tol > nowSec) ?? null;
  const upcoming = slice.programmes
    .filter((p) => p.start > nowSec)
    .slice(0, rag.answer.maxNextProgrammes);

  let verdict: ProgrammeVerdict = 'ON_AIR';
  if (!current) {
    const sliceAgeHours = (now - Date.parse(slice.generatedAt)) / 3_600_000;
    const allEnded = slice.programmes.every((p) => p.end <= nowSec);
    verdict =
      allEnded || sliceAgeHours > rag.freshness.guideStaleAfterHours ? 'GUIDE_STALE' : 'GUIDE_GAP';
  }

  return {
    verdict,
    current,
    next: upcoming,
    programmesInSlice: slice.programmes.length,
    sliceGeneratedAt: slice.generatedAt,
  };
}

function matchesFilters(query: Query, c: ChannelDoc): boolean {
  if (query.countryGroups.length && !query.countryGroups.includes(c.countryGroup)) return false;
  if (query.categories.length && !query.categories.some((x) => c.categories.includes(x))) {
    return false;
  }
  if (query.languages.length) {
    const declared = query.languages.some((l) => c.declaredLanguages.includes(l));
    // Audio comprovado pelo ffprobe vale como idioma, mesmo sem metadado declarado.
    const verified =
      query.languages.includes('por') && c.streams.some((s) => s.verifiedPortugueseAudio);
    if (!declared && !verified) return false;
  }
  return true;
}

export function retrieve(
  rag: RagConfig,
  corpus: Corpus,
  query: Query,
  now: number,
): RetrievalResult {
  const notes: string[] = [];
  let textNoMatch = false;

  let pool = corpus.channels;
  if (query.tvgIds.length) {
    const wanted = new Set(query.tvgIds);
    pool = pool.filter((c) => wanted.has(c.tvgId));
    const missing = query.tvgIds.filter((id) => !corpus.byTvgId.has(id));
    for (const id of missing) notes.push(`tvg-id fora do corpus indexado: ${id}`);
  } else {
    pool = pool.filter((c) => matchesFilters(query, c));
  }
  const afterFilters = pool.length;

  const lexical = new Map<string, number>();
  if (query.terms.length) {
    const allow = new Set(pool.map((c) => c.tvgId));
    for (const hit of searchIndex(corpus.channelIndex, query.terms, {
      k1: rag.retrieval.bm25K1,
      b: rag.retrieval.bm25B,
      allow,
    })) {
      lexical.set(hit.id, hit.score);
    }
    // Titulo de programa tambem recupera canal: 'jornal nacional' nao e nome de canal.
    for (const hit of searchIndex(corpus.programmeIndex, query.terms, {
      k1: rag.retrieval.bm25K1,
      b: rag.retrieval.bm25B,
    }).slice(0, rag.retrieval.programmeTopK)) {
      const ref = corpus.programmeRef.get(hit.id);
      if (!ref || !allow.has(ref.tvgId)) continue;
      lexical.set(ref.tvgId, Math.max(lexical.get(ref.tvgId) ?? 0, hit.score));
    }

    const matched = pool.filter((c) => (lexical.get(c.tvgId) ?? 0) > rag.retrieval.minScore);
    if (matched.length) {
      pool = matched;
    } else if (query.categories.length || query.languages.length || query.countryGroups.length) {
      // Havendo filtro estrutural, o texto que nao casou era ruido: a pergunta
      // continua respondivel e fica registrado que o texto foi ignorado.
      notes.push(`nenhum termo do texto livre casou no indice: ${query.terms.join(' ')}`);
    } else {
      // Sem filtro estrutural, o texto ERA a pergunta. Devolver o catalogo inteiro
      // responderia outra coisa, entao aqui a resposta e a abstencao.
      textNoMatch = true;
      pool = [];
    }
  }

  const counts: RetrievalCounts = {
    indexed: corpus.channels.length,
    afterFilters,
    afterText: pool.length,
    afterEvidence: 0,
    excludedStale: 0,
    excludedRefused: 0,
    excludedNeverChecked: 0,
    withGuide: 0,
    onAir: 0,
  };

  const candidates: Candidate[] = [];
  for (const channel of pool) {
    const availability = availabilityOf(rag, channel, query.vantage, now);
    if (query.requireAvailable) {
      if (availability.verdict === 'STALE') {
        counts.excludedStale++;
        continue;
      }
      if (availability.verdict === 'REFUSED') {
        counts.excludedRefused++;
        continue;
      }
      if (availability.verdict === 'NEVER_CHECKED') {
        counts.excludedNeverChecked++;
        continue;
      }
    }
    const programme = programmeOf(rag, corpus, channel, now);
    if (programme.verdict !== 'NO_GUIDE') counts.withGuide++;
    if (programme.verdict === 'ON_AIR') counts.onAir++;

    const lexicalScore = lexical.get(channel.tvgId) ?? 0;
    let score = lexicalScore;
    if (availability.verdict === 'CONFIRMED_HERE') score += rag.retrieval.vantageBonus;
    if (programme.verdict !== 'NO_GUIDE') score += rag.retrieval.guideBonus;
    if (query.requireGuide && programme.verdict === 'ON_AIR') score += rag.retrieval.onAirBonus;
    if (query.languages.includes('por') && availability.verifiedPortugueseAudio) {
      score += rag.retrieval.verifiedAudioBonus;
    }

    candidates.push({ channel, score, lexicalScore, availability, programme });
  }
  counts.afterEvidence = candidates.length;

  candidates.sort(
    (a, b) => b.score - a.score || a.channel.tvgId.localeCompare(b.channel.tvgId),
  );
  const top = candidates.slice(0, Math.min(query.limit, rag.answer.maxCandidates));

  const abstentions: Abstention[] = [];
  if (top.length === 0) {
    abstentions.push({
      kind: 'availability',
      reason: textNoMatch
        ? `nenhum canal do corpus casa '${query.terms.join(' ')}', e a pergunta nao trouxe ` +
          `filtro de pais, categoria ou idioma para responder por outro caminho ` +
          `(${corpus.channels.length} canais indexados)`
        : `nenhum canal com evidencia valida satisfaz o filtro ` +
          `(${afterFilters} passaram no filtro estrutural; ${counts.excludedStale} descartados por ` +
          `evidencia vencida, ${counts.excludedRefused} por observacao de recusa, ` +
          `${counts.excludedNeverChecked} por nunca terem sido checados)`,
    });
  }
  if (query.requireGuide && !top.some((c) => c.programme.verdict === 'ON_AIR')) {
    abstentions.push({
      kind: 'programme',
      reason:
        `a grade cobre ${corpus.stats.channelsWithGuide} dos ${corpus.stats.channelsIndexed} ` +
        `canais indexados (${corpus.stats.guideCoveragePercent}%) e nenhum dos candidatos tem ` +
        `programa registrado no ar agora; o que esta passando e desconhecido`,
    });
  }

  return { query, candidates: top, abstentions, notes, counts, stats: corpus.stats, now };
}
