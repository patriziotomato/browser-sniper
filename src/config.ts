// Zentrale Spielkonfiguration und Schwierigkeitsstufen.

export type DifficultyId = 'leicht' | 'normal' | 'schwer' | 'elite';

export interface Difficulty {
  id: DifficultyId;
  label: string;
  enemyCount: [number, number];
  /** Distanzbereich der Gegner in Metern (horizontal). */
  distance: [number, number];
  /** Sekunden zwischen Glint-Maximum und Schuss (Reaktionsfenster). */
  reactionWindow: number;
  /** Sekunden, bis ein Gegner nach dem Anlegen den Glint voll aufgebaut hat. */
  aimTime: number;
  /** Multiplikator, wie schnell Gegner dich entdecken. */
  detection: number;
  /** Trefferwahrscheinlichkeit gegnerischer Schuetzen (Scharfschuetze bekommt +). */
  enemyAccuracy: number;
  /** Maximale Windgeschwindigkeit in m/s. */
  maxWind: number;
  /** Windanzeige im HUD. */
  showWindHud: boolean;
  /** Leichte Kugelspur sichtbar. */
  showTrace: boolean;
  /** Markieren: alle automatisch, per Taste oder gar nicht. */
  tagging: 'auto' | 'manual' | 'none';
  /** Markierung zeigt die Entfernung. */
  tagDistance: boolean;
  /** Treffer, die du einstecken kannst. */
  lives: number;
  /** Moerser: wie stark ein eigener Schuss die Stellung verraet (0..1) und Sekunden bis zum ersten Einschlag. */
  mortarPerShot: number;
  mortarCountdown: number;
}

export const DIFFICULTIES: Record<DifficultyId, Difficulty> = {
  leicht: {
    id: 'leicht', label: 'Leicht', enemyCount: [2, 3], distance: [150, 320],
    reactionWindow: 2.0, aimTime: 3.2, detection: 0.4, enemyAccuracy: 0.35,
    maxWind: 3, showWindHud: true, showTrace: true, tagging: 'auto', tagDistance: true, lives: 3,
    mortarPerShot: 0.2, mortarCountdown: 16,
  },
  normal: {
    id: 'normal', label: 'Normal', enemyCount: [2, 4], distance: [200, 450],
    reactionWindow: 1.5, aimTime: 2.6, detection: 0.6, enemyAccuracy: 0.55,
    maxWind: 6, showWindHud: true, showTrace: false, tagging: 'manual', tagDistance: true, lives: 2,
    mortarPerShot: 0.26, mortarCountdown: 13,
  },
  schwer: {
    id: 'schwer', label: 'Schwer', enemyCount: [3, 5], distance: [250, 600],
    reactionWindow: 1.15, aimTime: 2.0, detection: 0.85, enemyAccuracy: 0.75,
    maxWind: 9, showWindHud: false, showTrace: false, tagging: 'manual', tagDistance: false, lives: 2,
    mortarPerShot: 0.32, mortarCountdown: 11,
  },
  elite: {
    id: 'elite', label: 'Elite', enemyCount: [4, 5], distance: [300, 780],
    reactionWindow: 0.85, aimTime: 1.5, detection: 1.1, enemyAccuracy: 0.9,
    maxWind: 12, showWindHud: false, showTrace: false, tagging: 'none', tagDistance: false, lives: 1,
    mortarPerShot: 0.38, mortarCountdown: 9,
  },
};

export const RIFLE = {
  muzzleVelocity: 790, // m/s, .308 Win 175gr
  /** Quadratischer Widerstandskoeffizient k [1/m], getunt auf ~530 m/s bei 600 m (G7-aehnlich). */
  dragK: 0.000665,
  sightHeight: 0.055, // m ueber der Laufachse
  magazine: 5,
  boltTime: 1.2,
  reloadTime: 2.6,
  zoomMin: 4,
  zoomMax: 20,
  baseFov: 62,
  zeroMin: 100,
  zeroMax: 1000,
  zeroStep: 50,
};

declare const __JEV_ENABLED__: boolean;

export const JEV = {
  /** Key steckt NICHT im Browser-Code; der Vite-Server haengt ihn an (siehe vite.config.ts). */
  enabled: typeof __JEV_ENABLED__ !== 'undefined' && __JEV_ENABLED__,
  apiUrl: '/jev-api',
  model: (import.meta.env.VITE_JEV_MODEL as string | undefined) || 'jev-latest',
  /** Takt des Direktors in Sekunden. */
  interval: 1.5,
  /** Timeout pro Anfrage in ms, danach entscheidet die lokale KI. */
  timeoutMs: 900,
};

export const jevEnabled = () => JEV.enabled;

export type QualityId = 'hoch' | 'mittel' | 'niedrig' | 'test';
export interface Quality {
  id: QualityId;
  label: string;
  pixelRatio: number;
  shadows: boolean;
  shadowMap: number;
  terrainStep: number;
  vegetation: number;
  grass: number;
}
export const QUALITIES: Record<QualityId, Quality> = {
  hoch: { id: 'hoch', label: 'Hoch', pixelRatio: 1.5, shadows: true, shadowMap: 4096, terrainStep: 2, vegetation: 1, grass: 1 },
  mittel: { id: 'mittel', label: 'Mittel', pixelRatio: 1, shadows: true, shadowMap: 2048, terrainStep: 3, vegetation: 0.7, grass: 0.55 },
  niedrig: { id: 'niedrig', label: 'Niedrig', pixelRatio: 0.8, shadows: true, shadowMap: 1024, terrainStep: 4, vegetation: 0.45, grass: 0.25 },
  test: { id: 'test', label: 'Test', pixelRatio: 1, shadows: false, shadowMap: 512, terrainStep: 8, vegetation: 0.08, grass: 0.03 },
};

function initialQuality(): QualityId {
  try {
    const q = new URLSearchParams(location.search).get('q');
    if (q && q in QUALITIES) return q as QualityId;
    const s = localStorage.getItem('ridgeline.quality');
    if (s && s in QUALITIES) return s as QualityId;
  } catch { /* egal */ }
  return 'hoch';
}
function stored(key: string, def: number): number {
  try {
    const v = Number(localStorage.getItem(key));
    return isFinite(v) && localStorage.getItem(key) !== null ? v : def;
  } catch {
    return def;
  }
}
export const settings = {
  quality: QUALITIES[initialQuality()],
  sensitivity: stored('ridgeline.sens', 1),
  volume: stored('ridgeline.volume', 0.8),
};

export interface Stats { played: number; won: number; kills: number; longest: number }
export function loadStats(): Stats {
  try {
    return { played: 0, won: 0, kills: 0, longest: 0, ...JSON.parse(localStorage.getItem('ridgeline.stats') || '{}') };
  } catch {
    return { played: 0, won: 0, kills: 0, longest: 0 };
  }
}
export function saveStats(s: Stats) {
  try { localStorage.setItem('ridgeline.stats', JSON.stringify(s)); } catch { /* egal */ }
}
