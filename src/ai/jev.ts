import { JEV } from '../config';

/**
 * Jev-Client (TypeSafe System-One-Modell).
 *
 * Wenn dein Endpoint ein anderes Request- oder Antwortformat erwartet als unten,
 * musst du NUR diese Datei anpassen: buildRequest() und parseAnswer().
 * Der Rest des Spiels arbeitet mit JevAnswer.
 */

export type JevType = 'choice' | 'noulli' | 'score';

export interface JevQuestion {
  type: JevType;
  instructions: string;
  /** Choice: Options-Schluessel. Score: Skala von niedrig nach hoch. */
  options?: string[];
  /** Choice: Beschreibung je Option (wird als criteria gesendet). */
  descriptions?: Record<string, string>;
}

export interface JevAnswer {
  /** Choice: Wahrscheinlichkeit je Option. */
  probs?: Record<string, number>;
  /** Noulli: Wahrscheinlichkeit fuer "ja". */
  p?: number;
  /** Score: Position 0..1 auf der Skala. */
  score?: number;
}

/** Wie die Fragetypen im API-Payload heissen. Bei Bedarf an die Doku anpassen. */
const TYPE_NAMES: Record<JevType, string> = { choice: 'choice', noulli: 'noul', score: 'choice' };

function buildRequest(state: Record<string, string>, questions: Record<string, JevQuestion>) {
  const q: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(questions)) {
    // Laut Doku: choice -> criteria {schluessel: beschreibung}, ja/nein -> "noul".
    // Score wird hier als choice ueber die Skala gestellt und als Erwartungswert ausgewertet.
    q[name] = {
      type: TYPE_NAMES[def.type],
      instructions: def.instructions,
      ...(def.options ? { criteria: Object.fromEntries(def.options.map((o) => [o, def.descriptions?.[o] ?? o])) } : {}),
    };
  }
  // State als lesbarer Text (eine Zeile pro Merkmal)
  const stateText = Object.entries(state).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join('\n');
  return {
    url: JEV.apiUrl,
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: JEV.model, state: stateText, questions: q }),
    } as RequestInit,
  };
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && isFinite(v) ? v : undefined);

/** Tolerantes Parsen: akzeptiert gaengige Antwortformen. */
function parseAnswer(raw: unknown, def: JevQuestion): JevAnswer | null {
  if (raw == null) return null;
  if (typeof raw === 'number') return def.type === 'score' ? { score: raw } : { p: raw };
  if (typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;

  if (def.type === 'choice') {
    const src = (o.probabilities ?? o.probs ?? o.distribution ?? o.scores ?? o.options) as unknown;
    const probs: Record<string, number> = {};
    if (Array.isArray(src)) {
      src.forEach((it, i) => {
        if (typeof it === 'number' && def.options) probs[def.options[i]] = it;
        else if (it && typeof it === 'object') {
          const r = it as Record<string, unknown>;
          const key = String(r.option ?? r.label ?? r.name ?? r.value ?? def.options?.[i]);
          const p = num(r.probability ?? r.p ?? r.score);
          if (p !== undefined) probs[key] = p;
        }
      });
    } else if (src && typeof src === 'object') {
      for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
        const p = num(v) ?? num((v as Record<string, unknown>)?.probability);
        if (p !== undefined) probs[k] = p;
      }
    }
    if (Object.keys(probs).length === 0) {
      const pick = (o.choice ?? o.answer ?? o.pick ?? o.selected) as string | undefined;
      if (pick && def.options) for (const opt of def.options) probs[opt] = opt === pick ? 1 : 0;
    }
    return Object.keys(probs).length ? { probs } : null;
  }

  if (def.type === 'noulli') {
    const p = num(o.noul ?? o.probability ?? o.p ?? o.yes ?? o.true ?? o.value);
    if (p !== undefined) return { p };
    const probs = o.probabilities as Record<string, number> | undefined;
    if (probs) return { p: num(probs.yes ?? probs.ja ?? probs.true) ?? 0 };
    return null;
  }

  // score
  const n = def.options?.length ?? 0;
  const pos = o.position ?? o.score ?? o.value;
  if (typeof pos === 'number') return { score: pos > 1 && n > 1 ? pos / (n - 1) : pos };
  if (typeof pos === 'string' && def.options) {
    const i = def.options.indexOf(pos);
    if (i >= 0) return { score: n > 1 ? i / (n - 1) : 0 };
  }
  const probs = o.probabilities as Record<string, number> | undefined;
  if (probs && def.options) {
    let s = 0;
    def.options.forEach((opt, i) => (s += (probs[opt] ?? 0) * (n > 1 ? i / (n - 1) : 0)));
    return { score: s };
  }
  return null;
}

export interface JevResult {
  answers: Record<string, JevAnswer>;
  latencyMs: number;
}

export async function askJev(state: Record<string, string>, questions: Record<string, JevQuestion>, timeoutMs: number): Promise<JevResult> {
  const { url, init } = buildRequest(state, questions);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = performance.now();
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${body.slice(0, 120)}`);
    }
    const json = (await res.json()) as Record<string, unknown>;
    const root = (json.answers ?? json.results ?? json.outputs ?? json.data ?? json) as Record<string, unknown>;
    const answers: Record<string, JevAnswer> = {};
    for (const [name, def] of Object.entries(questions)) {
      const a = parseAnswer(root[name], def);
      if (a) answers[name] = a;
    }
    if (Object.keys(answers).length === 0) throw new Error('Antwortformat nicht erkannt (siehe src/ai/jev.ts)');
    return { answers, latencyMs: performance.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}
