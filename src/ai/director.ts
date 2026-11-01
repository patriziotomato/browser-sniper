import { JEV, jevEnabled } from '../config';
import { Enemy, INTENTS, INTENT_LABEL, Intent } from '../enemies/enemy';
import { Rng } from '../core/rng';
import { askJev, JevQuestion } from './jev';

export interface Situation {
  time: number;
  coverLabel: string;
  coverPenetrable: boolean;
  playerExposed: boolean;
  playerExposedFor: number;
  lastPlayerShotAgo: number;
  playerShots: number;
  windSpeed: number;
  weather: string;
}

export interface DirectorStatus {
  /** jev = antwortet · fehler = letzter Aufruf fehlgeschlagen · pausiert = nach Fehlerserie ausgesetzt · aus = in diesem Build nicht verfuegbar */
  mode: 'jev' | 'fehler' | 'pausiert' | 'aus';
  pausedFor: number;
  lastLatency: number;
  lastError: string;
  calls: number;
  fallbacks: number;
}

const NERVES_SCALE = ['ruhig', 'angespannt', 'nervoes', 'panisch'];

/** Uebersetzt Zahlen in Worte (Jev ist bei Zahlen schwach). */
function words(e: Enemy, s: Situation, all: Enemy[]): Record<string, string> {
  const dead = all.filter((o) => o.dead).length;
  const dist = Math.round(e.pos.distanceTo(e.home));
  return {
    rolle: `${e.info.label}, ${e.info.persona}`,
    gesundheit: e.wounds > 0 ? 'am Bein verwundet' : 'unverletzt',
    wissen_ueber_spieler: e.knowsPlayer ? 'weiss ungefaehr, wo der feindliche Schuetze liegt' : e.awareness > 0.5 ? 'hat einen Verdacht, aber keine sichere Position' : 'hat den Schuetzen nicht bemerkt',
    sicht_auf_spieler: e.canSeePlayer && s.playerExposed ? 'der Schuetze ist gerade sichtbar' : 'der Schuetze ist gerade nicht zu sehen',
    eigene_schuesse: e.shotsFired === 0 ? 'hat noch nicht geschossen' : e.missedShots > 0 ? 'hat geschossen und verfehlt' : 'hat schon geschossen',
    beinahe_getroffen: s.time - e.lastNearMiss < 6 ? 'eine Kugel ist eben knapp neben ihm eingeschlagen' : 'wurde nicht beschossen',
    kameraden: dead === 0 ? 'alle Kameraden leben' : dead === 1 ? 'ein Kamerad ist gefallen' : 'mehrere Kameraden sind gefallen',
    position: dist > 15 ? 'hat die Stellung schon gewechselt' : 'ist noch in der Ausgangsstellung',
    alarm: e.alarmed ? 'hat Alarm gegeben' : 'hat noch keinen Alarm gegeben',
  };
}

function globalWords(s: Situation): Record<string, string> {
  return {
    lage_deckung_spieler: `Der feindliche Schuetze liegt hinter: ${s.coverLabel}${s.coverPenetrable ? ' (Kugeln gehen durch)' : ''}`,
    lage_spieler_sichtbar: s.playerExposed ? (s.playerExposedFor > 6 ? 'der Schuetze ist schon lange ungedeckt' : 'der Schuetze zielt gerade') : 'der Schuetze ist abgetaucht',
    lage_letzter_schuss: s.playerShots === 0 ? 'es ist noch kein Schuss gefallen' : s.lastPlayerShotAgo < 4 ? 'gerade eben ist ein Schuss gefallen' : 'vor einer Weile ist ein Schuss gefallen',
    lage_wetter: `${s.weather}, ${s.windSpeed > 7 ? 'starker Wind' : s.windSpeed > 3 ? 'maessiger Wind' : 'kaum Wind'}`,
  };
}

/** Lokale Utility-KI: dieselben Optionen, Gewichte aus Faustregeln. */
export function fallbackProbs(e: Enemy, s: Situation): Record<Intent, number> {
  const w: Record<Intent, number> = { beobachten: 1, zielen: 0, stellung_wechseln: 0.08, alarmieren: 0.02, deckung: 0.08 };
  const recentMiss = s.time - e.lastNearMiss < 5;
  if (e.knowsPlayer && e.info.shoots) w.zielen = (e.type === 'scharfschuetze' ? 3.5 : 2.2) + e.nerves;
  else if (e.info.shoots && e.awareness > 0.55 && s.coverPenetrable) w.zielen = 0.9;
  if (e.knowsPlayer) w.beobachten = 0.3;
  if (!e.alarmed && (e.knowsPlayer || e.awareness > 0.6)) w.alarmieren = e.type === 'spotter' ? 4 : 0.4;
  if (recentMiss) { w.deckung += 1.4 * (1 - e.nerves * 0.3); w.stellung_wechseln += 0.6; }
  if (e.missedShots >= 2) w.stellung_wechseln += 0.7;
  if (e.type === 'spotter' && e.knowsPlayer && e.alarmed) { w.deckung += 0.5; w.beobachten += 1; }
  return normalize(w);
}

function normalize(w: Record<Intent, number>): Record<Intent, number> {
  const sum = INTENTS.reduce((a, k) => a + Math.max(0, w[k]), 0) || 1;
  const out = {} as Record<Intent, number>;
  for (const k of INTENTS) out[k] = Math.max(0, w[k]) / sum;
  return out;
}

/** Ungueltige Optionen ausblenden (Spotter schiesst nicht, ohne Wissen kein gezielter Schuss). */
function mask(e: Enemy, p: Record<Intent, number>, s: Situation): Record<Intent, number> {
  const out = { ...p };
  if (!e.info.shoots) out.zielen = 0;
  if (!e.knowsPlayer && !(s.coverPenetrable && e.awareness > 0.5)) out.zielen = 0;
  if (e.alarmed) out.alarmieren *= 0.1;
  return normalize(out);
}

export class Director {
  status: DirectorStatus = { mode: jevEnabled() ? 'jev' : 'aus', pausedFor: 0, lastLatency: 0, lastError: '', calls: 0, fallbacks: 0 };
  private timer = 0;
  private inflight = false;
  private failStreak = 0;
  private pausedUntil = 0;
  private enabled = jevEnabled();

  constructor(private rng: Rng) {}

  update(dt: number, enemies: Enemy[], s: Situation, force = false) {
    this.timer -= dt;
    this.status.pausedFor = Math.max(0, Math.ceil((this.pausedUntil - performance.now()) / 1000));
    if (!force && this.timer > 0) return;
    this.timer = JEV.interval;
    const alive = enemies.filter((e) => !e.dead);
    if (alive.length === 0) return;

    if (this.enabled && this.inflight) return; // laufende Anfrage abwarten, Gegner behalten ihre Absicht
    const paused = performance.now() < this.pausedUntil;
    if (this.enabled && !paused) {
      this.decideWithJev(alive, enemies, s);
    } else {
      for (const e of alive) this.apply(e, fallbackProbs(e, s), 'lokal', s);
    }
  }

  private async decideWithJev(alive: Enemy[], all: Enemy[], s: Situation) {
    this.inflight = true;
    const state: Record<string, string> = { ...globalWords(s) };
    const questions: Record<string, JevQuestion> = {};
    for (const e of alive) {
      const k = `gegner_${e.id + 1}`;
      for (const [key, val] of Object.entries(words(e, s, all))) state[`${k}_${key}`] = val;
      questions[`${k}_aktion`] = {
        type: 'choice',
        instructions: `Was tut ${k} (${e.info.label}) als Naechstes am wahrscheinlichsten? Er ist ein ${e.info.persona}.`,
        options: [...INTENTS],
        descriptions: Object.fromEntries(INTENTS.map((i) => [i, INTENT_LABEL[i]])),
      };
      questions[`${k}_entdeckt`] = { type: 'noulli', instructions: `Hat ${k} den feindlichen Schuetzen wahrscheinlich schon entdeckt?` };
      questions[`${k}_nervositaet`] = { type: 'score', instructions: `Wie nervoes ist ${k} gerade?`, options: NERVES_SCALE };
    }
    this.status.calls++;
    try {
      const res = await askJev(state, questions, JEV.timeoutMs);
      this.status.lastLatency = Math.round(res.latencyMs);
      this.status.lastError = '';
      this.status.mode = 'jev';
      this.failStreak = 0;
      for (const e of alive) {
        if (e.dead) continue;
        const k = `gegner_${e.id + 1}`;
        const a = res.answers[`${k}_aktion`];
        const det = res.answers[`${k}_entdeckt`];
        const nerv = res.answers[`${k}_nervositaet`];
        if (det?.p !== undefined) {
          e.detectP = det.p;
          // Jev darf Wahrnehmung nur verstaerken, wenn der Gegner den Spieler tatsaechlich sehen kann (fair)
          if (det.p > 0.7 && e.canSeePlayer && s.playerExposed) e.awareness = Math.min(1.2, e.awareness + 0.15);
        }
        if (nerv?.score !== undefined) e.nerves = e.nerves * 0.5 + nerv.score * 0.5;
        if (a?.probs) {
          const p = {} as Record<Intent, number>;
          for (const i of INTENTS) p[i] = a.probs[i] ?? a.probs[INTENT_LABEL[i]] ?? 0;
          this.apply(e, p, 'jev', s);
        } else {
          this.apply(e, fallbackProbs(e, s), 'lokal', s);
        }
      }
    } catch (err) {
      this.failStreak++;
      this.status.fallbacks++;
      this.status.mode = 'fehler';
      // Nach 6 Fehlern in Folge 20 s aussetzen, dann erneut versuchen
      if (this.failStreak >= 6) {
        this.pausedUntil = performance.now() + 20000;
        this.failStreak = 5;
        this.status.mode = 'pausiert';
      }
      this.status.lastError = err instanceof Error ? (err.name === 'AbortError' ? `Timeout > ${JEV.timeoutMs} ms` : err.message) : String(err);
      for (const e of alive) if (!e.dead) this.apply(e, fallbackProbs(e, s), 'lokal', s);
    } finally {
      this.inflight = false;
    }
  }

  private apply(e: Enemy, probs: Record<Intent, number>, source: 'jev' | 'lokal', s: Situation) {
    const p = mask(e, normalize(probs), s);
    e.probs = p;
    e.suspicionShot = s.coverPenetrable && !e.knowsPlayer && p.zielen > 0;
    // Wuerfeln statt Maximum: glaubwuerdig, aber nicht auswendig lernbar
    let r = this.rng.next(), pick: Intent = 'beobachten';
    for (const i of INTENTS) {
      r -= p[i];
      if (r <= 0) { pick = i; break; }
    }
    e.setIntent(pick, source, p[pick]);
  }
}
