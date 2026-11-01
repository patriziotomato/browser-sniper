// Touch-Steuerung fuers Handy: Wischen zum Zielen, zwei Finger zum Zoomen, Tasten fuer alles andere.
import { Game } from './game';
import { RIFLE, settings } from './config';

export interface TouchHooks {
  /** Spiel pausieren und Pausenbildschirm zeigen. */
  pause(): void;
}

interface Pt { x: number; y: number }

export function setupTouch(game: Game, hooks: TouchHooks) {
  const root = document.getElementById('touch')!;
  const body = document.body;
  const el = (t: string) => root.querySelector<HTMLElement>(`[data-t="${t}"]`)!;
  const zeroLabel = document.getElementById('t-zero')!;
  const ammoLabel = el('fire').querySelector('small')!;
  const active = () => settings.touch && game.running && !game.paused && !!game.player;

  // ---- Zielen und Zoomen auf freier Flaeche
  const looks = new Map<number, Pt>();
  let pinch = 0;
  const pinchDist = () => {
    const [a, b] = [...looks.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  root.addEventListener('pointerdown', (e) => {
    if (!active() || (e.target as HTMLElement).closest('[data-t]')) return;
    e.preventDefault();
    if (game.cinematic) {
      game.skipCinematic();
      return;
    }
    root.setPointerCapture?.(e.pointerId);
    looks.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (looks.size === 2) pinch = pinchDist();
  });
  root.addEventListener('pointermove', (e) => {
    const prev = looks.get(e.pointerId);
    if (!prev || !active()) return;
    const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
    prev.x = e.clientX;
    prev.y = e.clientY;
    const p = game.player;
    if (looks.size >= 2) {
      const d = pinchDist();
      if (pinch > 0 && d > 0 && p.scoped) p.zoomBy(d / pinch);
      pinch = d;
      return;
    }
    // Im Zielfernrohr etwas feiner, damit kleine Fingerbewegungen reichen
    p.look(dx, dy, settings.touchSensitivity * (p.scoped ? 0.75 : 1));
  });
  const release = (e: PointerEvent) => {
    looks.delete(e.pointerId);
    if (looks.size < 2) pinch = 0;
  };
  root.addEventListener('pointerup', release);
  root.addEventListener('pointercancel', release);

  // ---- Tasten
  const press = (t: string, down: () => void, up?: () => void) => {
    const b = el(t);
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!active()) return;
      b.classList.add('down');
      down();
    });
    const end = () => {
      if (!b.classList.contains('down')) return;
      b.classList.remove('down');
      up?.();
    };
    b.addEventListener('pointerup', end);
    b.addEventListener('pointercancel', end);
    b.addEventListener('pointerleave', end);
  };

  press('fire', () => game.fire());
  press('scope', () => {
    const p = game.player;
    if (p.state === 'ducked' || p.state === 'lowering') {
      p.raise();
      p.rightHeld = true;
    } else if (p.state === 'up' || p.state === 'rising') {
      p.rightHeld = !p.rightHeld;
    }
  });
  press('duck', () => {
    const p = game.player;
    if (p.state === 'up' || p.state === 'rising') {
      p.duck();
      p.rightHeld = false;
    } else if (p.state === 'ducked' || p.state === 'lowering') {
      // aufrichten ohne Zielfernrohr
      p.rightHeld = false;
      p.raise();
    }
  });
  press('breath', () => game.player.setBreath(!game.player.holdingBreath));
  press('zoomIn', () => game.player.zoomBy(1.25));
  press('zoomOut', () => game.player.zoomBy(0.8));
  press('zeroUp', () => game.player.stepZero(1));
  press('zeroDown', () => game.player.stepZero(-1));
  press('tag', () => game.tag());
  press('moveL', () => game.relocate(-1));
  press('moveR', () => game.relocate(1));
  press('funk', () => (game.hud.briefHeld = true), () => (game.hud.briefHeld = false));
  // Pause geht auch, wenn gerade nichts aktiv ist
  el('pause').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (settings.touch && game.running && !game.paused) hooks.pause();
  });

  // Pinch-Zoom und Doppeltipp-Zoom von Safari abfangen
  for (const ev of ['gesturestart', 'gesturechange', 'dblclick']) {
    document.addEventListener(ev, (e) => {
      if (settings.touch) e.preventDefault();
    });
  }

  // Wer das Handy hochkant dreht oder die App wechselt, pausiert
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && active()) hooks.pause();
  });

  // ---- Anzeige
  let last = '';
  return function update() {
    const playing = active();
    body.classList.toggle('playing', playing);
    if (!playing) {
      looks.clear();
      pinch = 0;
      if (!game.running) game.hud.briefHeld = false;
      return;
    }
    if (window.innerHeight > window.innerWidth * 1.05) {
      hooks.pause();
      return;
    }
    const p = game.player;
    const busy = p.state === 'intro' || p.state === 'moving' || p.state === 'dead' || p.state === 'won' || game.cinematic;
    const up = p.state === 'up' || p.state === 'rising';
    const reloading = p.reloadT > 0;
    const state = [
      busy ? 'busy' : '',
      up ? 'up' : 'down',
      p.scoped ? 'scoped' : '',
      p.canFire ? 'ready' : '',
      p.holdingBreath ? 'holding' : '',
      game.difficulty.tagging === 'manual' ? 'tagging' : '',
      p.zero,
      p.ammo,
      reloading ? 'reload' : '',
    ].join('|');
    if (state === last) return;
    last = state;
    root.classList.toggle('busy', busy);
    root.classList.toggle('scoped', p.scoped);
    root.classList.toggle('up', up);
    root.classList.toggle('tagging', game.difficulty.tagging === 'manual');
    el('fire').classList.toggle('off', !p.canFire);
    el('breath').classList.toggle('on', p.holdingBreath);
    el('scope').classList.toggle('on', p.scoped);
    el('scope').textContent = up ? (p.scoped ? 'Scope aus' : 'Scope') : 'Anlegen';
    el('duck').textContent = up ? 'Ducken' : 'Hoch';
    zeroLabel.textContent = `${p.zero} m`;
    ammoLabel.textContent = reloading ? 'laedt' : `${p.ammo}/${RIFLE.magazine}`;
  };
}
