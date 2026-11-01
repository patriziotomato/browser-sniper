import { DIFFICULTIES, DifficultyId, JEV, QUALITIES, jevEnabled, loadStats, saveStats, settings } from './config';
import { Game } from './game';
import { audio } from './audio';

const $ = (id: string) => document.getElementById(id)!;
const app = $('app');
const game = new Game(app);
const canvas = game.renderer.domElement;

let diff: DifficultyId = 'normal';
try {
  const saved = localStorage.getItem('ridgeline.diff') as DifficultyId | null;
  if (saved && saved in DIFFICULTIES) diff = saved;
} catch { /* ohne Storage */ }

// Menue
const diffRow = $('diffs');
for (const d of Object.values(DIFFICULTIES)) {
  const b = document.createElement('button');
  b.textContent = d.label;
  b.dataset.id = d.id;
  b.onclick = () => {
    diff = d.id;
    try { localStorage.setItem('ridgeline.diff', diff); } catch { /* egal */ }
    syncDiff();
  };
  diffRow.appendChild(b);
}
const qualRow = $('quals');
for (const q of Object.values(QUALITIES)) {
  if (q.id === 'test') continue;
  const b = document.createElement('button');
  b.textContent = q.label;
  b.dataset.id = q.id;
  b.onclick = () => {
    settings.quality = q;
    try { localStorage.setItem('ridgeline.quality', q.id); } catch { /* egal */ }
    syncQual();
  };
  qualRow.appendChild(b);
}
function syncQual() {
  qualRow.querySelectorAll('button').forEach((b) => b.classList.toggle('sel', (b as HTMLElement).dataset.id === settings.quality.id));
}
syncQual();
function syncDiff() {
  diffRow.querySelectorAll('button').forEach((b) => b.classList.toggle('sel', (b as HTMLElement).dataset.id === diff));
}
syncDiff();
// Einstellungen
const sens = $('sens') as HTMLInputElement, vol = $('vol') as HTMLInputElement;
sens.value = String(settings.sensitivity);
vol.value = String(settings.volume);
audio.setVolume(settings.volume);
sens.oninput = () => {
  settings.sensitivity = Number(sens.value);
  try { localStorage.setItem('ridgeline.sens', sens.value); } catch { /* egal */ }
};
vol.oninput = () => {
  settings.volume = Number(vol.value);
  audio.setVolume(settings.volume);
  try { localStorage.setItem('ridgeline.volume', vol.value); } catch { /* egal */ }
};
function renderStats() {
  const st = loadStats();
  $('stats-line').textContent = st.played
    ? `Runden ${st.played} · gewonnen ${st.won} · Gegner ausgeschaltet ${st.kills} · weitester Treffer ${st.longest ? st.longest + ' m' : '–'}`
    : '';
}
renderStats();

$('jev-status').innerHTML = jevEnabled()
  ? `Gegner-Taktik: <b>Jev</b> (${JEV.model}), lokale KI als Fallback`
  : `Gegner-Taktik: <b>lokale KI</b>. Fuer Jev <code>VITE_JEV_API_KEY</code> in <code>.env.local</code> setzen und den Dev-Server neu starten.`;

function show(id: 'menu' | 'end' | 'pause' | null) {
  for (const s of ['menu', 'end', 'pause']) $(s).classList.toggle('hidden', s !== id);
}

function startRound() {
  audio.init();
  audio.setVolume(settings.volume);
  show(null);
  $('loading').classList.remove('hidden');
  // Einen Frame warten, damit der Ladebildschirm sichtbar ist
  setTimeout(() => {
    game.start(diff);
    $('loading').classList.add('hidden');
    canvas.requestPointerLock?.();
  }, 30);
}

$('start').onclick = startRound;
$('again').onclick = startRound;
$('to-menu').onclick = () => {
  renderStats();
  show('menu');
};
$('resume').onclick = () => canvas.requestPointerLock?.();
$('quit').onclick = () => {
  game.running = false;
  game.paused = false;
  show('menu');
};

game.onEnd = (s) => {
  document.exitPointerLock?.();
  const st = loadStats();
  st.played++;
  if (s.won) st.won++;
  st.kills += s.kills;
  st.longest = Math.max(st.longest, s.longest);
  saveStats(st);
  $('end-title').textContent = s.won ? 'GEBIET GESAEUBERT' : 'GETROFFEN';
  $('end-reason').textContent = s.reason;
  const acc = s.shots ? Math.round((s.hits / s.shots) * 100) : 0;
  $('end-stats').innerHTML = [
    [`${s.kills}/${s.enemies}`, 'Gegner'],
    [`${s.hits}/${s.shots}`, `Treffer (${acc} %)`],
    [s.longest ? `${s.longest} m` : '–', 'Weitester Treffer'],
    [`${s.time} s`, 'Rundenzeit'],
    [s.difficulty, 'Schwierigkeit'],
  ].map(([v, l]) => `<div><b>${v}</b><span>${l}</span></div>`).join('');
  show('end');
};

// Eingabe
document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === canvas;
  if (!locked && game.running && $('menu').classList.contains('hidden') && $('end').classList.contains('hidden')) {
    game.paused = true;
    show('pause');
  } else if (locked && game.paused) {
    game.paused = false;
    show(null);
  }
});
canvas.addEventListener('click', () => {
  if (game.running && document.pointerLockElement !== canvas) canvas.requestPointerLock?.();
});
document.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement === canvas && game.running && !game.paused) game.player.look(e.movementX, e.movementY);
});
document.addEventListener('mousedown', (e) => {
  if (!game.running || game.paused || document.pointerLockElement !== canvas) return;
  if (e.button === 2) {
    game.player.rightHeld = true;
    game.player.raise();
  } else if (e.button === 1) {
    e.preventDefault();
    game.tag();
  } else if (e.button === 0) {
    game.fire();
  }
});
document.addEventListener('mouseup', (e) => {
  if (e.button === 2 && game.player) game.player.rightHeld = false;
});
document.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('wheel', (e) => {
  if (game.running && !game.paused) game.player.wheel(e.deltaY);
}, { passive: true });
document.addEventListener('keydown', (e) => {
  if (e.code === 'Tab') {
    e.preventDefault();
    game.hud.briefHeld = true;
    return;
  }
  if (e.code === 'F3' || e.code === 'KeyI') {
    e.preventDefault();
    game.hud.debugOn = !game.hud.debugOn;
    return;
  }
  if (!game.running || game.paused) return;
  const p = game.player;
  switch (e.code) {
    case 'Space':
      e.preventDefault();
      if (!e.repeat) game.skipCinematic();
      p.duck();
      break;
    case 'KeyS': p.duck(); break;
    case 'KeyW': p.raise(); break;
    case 'ShiftLeft': case 'ShiftRight': p.setBreath(true); break;
    case 'KeyR': p.zeroKeyHeld = true; break;
    case 'KeyQ': game.tag(); break;
  }
});
document.addEventListener('keyup', (e) => {
  if (!game.player) return;
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') game.player.setBreath(false);
  if (e.code === 'KeyR') game.player.zeroKeyHeld = false;
  if (e.code === 'Tab') game.hud.briefHeld = false;
});

// Hauptschleife
let last = performance.now();
function frame(now: number) {
  const dt = (now - last) / 1000;
  last = now;
  if (game.running || game.player) game.update(dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Fuer Tests und Debugging
(window as unknown as { ridgeline: Game }).ridgeline = game;
