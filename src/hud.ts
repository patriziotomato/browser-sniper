import * as THREE from 'three';
import { Player } from './player';
import { Enemy, INTENTS, INTENT_LABEL, INTENT_VERB } from './enemies/enemy';
import { DirectorStatus } from './ai/director';
import { RIFLE, moveKeys, moveKeysText, settings } from './config';
import { Mortar } from './mortar';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export class Hud {
  private scope = $<HTMLCanvasElement>('scope');
  private sctx = this.scope.getContext('2d')!;
  private info = $('scope-info');
  private hint = $('hint');
  private breath = $('breath');
  private breathFill = $('breath-fill');
  private danger = $('danger');
  private debug = $('debug');
  private wind = $('wind');
  private toastEl = $('toast');
  private toastT = 0;
  private heat = $('heat');
  private heatFill = $('heat-fill');
  private mortarEl = $('mortar');
  private mortarText = '';
  debugOn = false;
  feedOn = true;
  threats: { pos: THREE.Vector3; enemy: Enemy; until: number }[] = [];
  hp = 1;
  maxHp = 1;

  resize() {
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.scope.width = window.innerWidth * dpr;
    this.scope.height = window.innerHeight * dpr;
  }

  toast(text: string, seconds = 2.5) {
    this.toastEl.textContent = text;
    this.toastEl.style.opacity = '1';
    this.toastT = seconds;
  }

  private briefEl = $('brief');
  private briefT = 0;
  briefHeld = false;
  brief(html: string, seconds = 12) {
    this.briefEl.innerHTML = html;
    this.briefT = seconds;
  }

  /** Debug: Gegnerpositionen auf dem Bildschirm markieren. */
  /** Markierte Gegner (und im Debug alle) anzeigen. */
  drawMarkers(enemies: Enemy[], camera: THREE.Camera, from: THREE.Vector3, showDist: boolean, scopeBlend: number) {
    const c = this.sctx;
    const W = this.scope.width, H = this.scope.height;
    const dpr = W / window.innerWidth;
    const R = Math.min(W, H) * 0.47;
    const v = new THREE.Vector3();
    c.font = `${Math.round(11 * dpr)}px ui-monospace, monospace`;
    c.textAlign = 'center';
    for (const e of enemies) {
      const debug = this.debugOn;
      if (!e.tagged && !debug) continue;
      v.copy(e.pos).setY(e.pos.y + 2.1).project(camera);
      if (v.z > 1) continue;
      const x = (v.x * 0.5 + 0.5) * W, y = (-v.y * 0.5 + 0.5) * H;
      if (scopeBlend > 0.5 && Math.hypot(x - W / 2, y - H / 2) > R - 10) continue;
      const col = e.dead ? 'rgba(170,170,170,0.6)' : debug && !e.tagged ? 'rgba(255,70,50,0.95)' : 'rgba(240,190,80,0.95)';
      c.strokeStyle = col;
      c.fillStyle = col;
      c.lineWidth = 1.6 * dpr;
      const s = 6 * dpr;
      c.beginPath();
      c.moveTo(x, y - s); c.lineTo(x + s, y); c.lineTo(x, y + s); c.lineTo(x - s, y); c.closePath();
      c.stroke();
      if (e.dead) {
        c.beginPath(); c.moveTo(x - s * 0.6, y - s * 0.6); c.lineTo(x + s * 0.6, y + s * 0.6); c.moveTo(x + s * 0.6, y - s * 0.6); c.lineTo(x - s * 0.6, y + s * 0.6); c.stroke();
      }
      const label = debug ? `${e.info.label} ${Math.round(e.pos.distanceTo(from))} m` : showDist ? `${Math.round(e.pos.distanceTo(from))} m` : '';
      if (label) c.fillText(label, x, y - s - 5 * dpr);
      if (!e.dead && (e.tagged || debug)) {
        const src = e.intentSource === 'jev' ? 'Jev' : 'lokal';
        c.fillStyle = e.intentSource === 'jev' ? 'rgba(130,210,255,0.95)' : 'rgba(220,220,220,0.85)';
        c.fillText(`${INTENT_VERB[e.intent]} · ${src}`, x, y + s + 13 * dpr);
      }
    }
  }

  /** Roter Hinweis auf den Schuetzen, der dich getroffen hat. */
  drawThreats(camera: THREE.Camera, scopeBlend: number) {
    const now = performance.now();
    this.threats = this.threats.filter((t) => t.until > now && !t.enemy.dead);
    if (!this.threats.length) return;
    const c = this.sctx;
    const W = this.scope.width, H = this.scope.height;
    const dpr = W / window.innerWidth;
    const R = Math.min(W, H) * 0.47;
    const v = new THREE.Vector3();
    for (const t of this.threats) {
      const a = Math.min(1, (t.until - now) / 1500) * (0.7 + 0.3 * Math.sin(now / 90));
      c.strokeStyle = `rgba(255,50,30,${a})`;
      c.fillStyle = c.strokeStyle;
      c.lineWidth = 2.5 * dpr;
      v.copy(t.enemy.pos).setY(t.enemy.pos.y + 1).project(camera);
      const x = (v.x * 0.5 + 0.5) * W, y = (-v.y * 0.5 + 0.5) * H;
      const limit = scopeBlend > 0.5 ? R - 30 * dpr : Math.min(W, H) * 0.45;
      const dx = x - W / 2, dy = y - H / 2;
      const inside = v.z < 1 && Math.hypot(dx, dy) < limit;
      if (inside) {
        c.beginPath();
        c.arc(x, y, 16 * dpr, 0, Math.PI * 2);
        c.stroke();
      } else {
        // Pfeil am Rand in Richtung des Schuetzen
        let ang = Math.atan2(dy, dx);
        if (v.z > 1) ang += Math.PI;
        const px = W / 2 + Math.cos(ang) * limit, py = H / 2 + Math.sin(ang) * limit;
        c.save();
        c.translate(px, py);
        c.rotate(ang);
        c.beginPath();
        c.moveTo(14 * dpr, 0); c.lineTo(-8 * dpr, -10 * dpr); c.lineTo(-8 * dpr, 10 * dpr); c.closePath();
        c.fill();
        c.restore();
      }
    }
  }

  /** Ausweichstellungen: Raute mit Taste und Name, am Bildrand als Pfeil. */
  drawPositions(marks: { pos: THREE.Vector3; dir: -1 | 1; label: string }[], camera: THREE.Camera, urgent: boolean) {
    if (!marks.length) return;
    const c = this.sctx;
    const W = this.scope.width, H = this.scope.height;
    const dpr = W / window.innerWidth;
    const now = performance.now();
    const a = urgent ? 0.75 + 0.25 * Math.sin(now / 120) : 0.55;
    const v = new THREE.Vector3();
    c.font = `600 ${Math.round(12 * dpr)}px ui-sans-serif, system-ui, sans-serif`;
    c.textBaseline = 'middle';
    for (const m of marks) {
      v.copy(m.pos).setY(m.pos.y + 0.8).project(camera);
      let x = (v.x * 0.5 + 0.5) * W, y = (-v.y * 0.5 + 0.5) * H;
      const behind = v.z > 1;
      const margin = 70 * dpr;
      const off = behind || x < margin || x > W - margin || y < margin || y > H - margin;
      // Auf dem Handy uebernehmen die Stellungs-Tasten den Hinweis am Rand
      if (off && settings.touch) continue;
      if (off) {
        // Am Rand der Seite, auf der die Stellung liegt
        x = m.dir < 0 ? margin : W - margin;
        y = clampN(behind ? H / 2 : y, H * 0.3, H * 0.7);
      }
      const col = urgent ? `rgba(120,230,140,${a})` : `rgba(170,220,170,${a})`;
      c.strokeStyle = col;
      c.fillStyle = col;
      c.lineWidth = 2 * dpr;
      const s = 8 * dpr;
      if (off) {
        c.beginPath();
        const tip = m.dir < 0 ? x - 30 * dpr : x + 30 * dpr;
        c.moveTo(tip, y); c.lineTo(tip - m.dir * 14 * dpr, y - 10 * dpr); c.lineTo(tip - m.dir * 14 * dpr, y + 10 * dpr); c.closePath();
        c.fill();
      } else {
        c.beginPath();
        c.moveTo(x, y - s); c.lineTo(x + s, y); c.lineTo(x, y + s); c.lineTo(x - s, y); c.closePath();
        c.stroke();
      }
      c.textAlign = 'center';
      const key = moveKeys()[m.dir < 0 ? 0 : 1];
      c.fillText(`[${key}] ${m.label}`, x, y + (off ? 22 : -18) * dpr);
    }
    c.textBaseline = 'alphabetic';
  }

  /** Verrats-Anzeige und Countdown-Banner fuer den Moerser. */
  drawMortar(m: Mortar, time: number, eye: THREE.Vector3, hidden: boolean) {
    const mission = m.mission && !m.mission.cancelled ? m.mission : null;
    this.heat.style.opacity = !hidden && (m.heat > 0.03 || mission) ? '1' : '0';
    this.heatFill.style.width = `${Math.round(m.heat * 100)}%`;
    this.heatFill.style.background = m.heat > 0.75 ? '#e0533f' : m.heat > 0.45 ? '#e09a3f' : '#d9c48a';
    this.heat.classList.toggle('hot', m.heat > 0.75);
    let text = '';
    if (!hidden && mission) {
      const close = Math.hypot(mission.target.x - eye.x, mission.target.z - eye.z) < 22;
      if (time < mission.firstImpact) {
        const sec = Math.max(0, Math.ceil(mission.firstImpact - time));
        text = close
          ? `<b>MOERSERFEUER IN ${sec} s</b><span>${moveKeysText()}: Stellung wechseln${mission.bySpotter ? ' · oder den Spotter ausschalten' : ''}</span>`
          : `<b>MOERSERFEUER IN ${sec} s</b><span>Ziel ist deine alte Stellung</span>`;
      } else {
        text = close ? `<b>MOERSERFEUER — RAUS DA!</b><span>${moveKeysText()}: Stellung wechseln</span>` : '<b>BESCHUSS AUF ALTE STELLUNG</b><span>Nutze die Zeit</span>';
      }
    }
    if (text !== this.mortarText) {
      this.mortarText = text;
      this.mortarEl.innerHTML = text;
      this.mortarEl.style.opacity = text ? '1' : '0';
    }
  }

  private feedEl = $('feed');
  private feed: { html: string; t: number }[] = [];
  private seen = new Map<number, number>();

  /** Entscheidungs-Feed: jede neue Gegner-Absicht mit Quelle und Wahrscheinlichkeit. */
  updateFeed(enemies: Enemy[], show: boolean) {
    const now = performance.now();
    for (const e of enemies) {
      const last = this.seen.get(e.id) ?? 0;
      if (e.decision.seq !== last) {
        this.seen.set(e.id, e.decision.seq);
        if (last === 0 && e.decision.intent === 'beobachten') continue;
        const d = e.decision;
        const badge = d.source === 'jev' ? '<span class="src jev">JEV</span>' : '<span class="src lokal">LOKAL</span>';
        this.feed.unshift({ html: `${badge} <b>${e.info.label}</b> ${INTENT_VERB[d.intent]} <small>${Math.round(d.p * 100)} %</small>`, t: now });
      }
    }
    this.feed = this.feed.filter((f) => now - f.t < 9000).slice(0, 5);
    if (!show || !this.feed.length) {
      this.feedEl.style.opacity = '0';
      return;
    }
    this.feedEl.style.opacity = '1';
    this.feedEl.innerHTML = this.feed.map((f) => `<div style="opacity:${Math.max(0.25, 1 - (now - f.t) / 9000)}">${f.html}</div>`).join('');
  }

  resetFeed() {
    this.feed = [];
    this.seen.clear();
  }

  setHint(text: string) {
    if (this.hint.textContent !== text) this.hint.textContent = text;
  }

  drawScope(p: Player, hidden = false) {
    const c = this.sctx;
    const W = this.scope.width, H = this.scope.height;
    c.clearRect(0, 0, W, H);
    const blend = hidden ? 0 : p.scopeBlend;
    this.info.style.opacity = blend > 0.6 ? '1' : '0';
    this.breath.style.opacity = blend > 0.6 ? '1' : '0';
    if (blend < 0.02) return;
    const R = Math.min(W, H) * 0.47;
    const cx = W / 2, cy = H / 2;
    c.globalAlpha = Math.min(1, blend * 1.4);
    // Schwarzer Rand + weicher Linsenschatten
    c.fillStyle = '#000';
    c.beginPath();
    c.rect(0, 0, W, H);
    c.arc(cx, cy, R, 0, Math.PI * 2, true);
    c.fill();
    const g = c.createRadialGradient(cx, cy, R * 0.82, cx, cy, R);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.85)');
    c.fillStyle = g;
    c.beginPath();
    c.arc(cx, cy, R, 0, Math.PI * 2);
    c.fill();

    // Absehen (erste Bildebene: Mil-Werte gelten bei jedem Zoom)
    const fovRad = (p.fov * Math.PI) / 180;
    const pxPerMil = (H / 2 / Math.tan(fovRad / 2)) * 0.001;
    const dpr = W / window.innerWidth;
    c.save();
    c.beginPath();
    c.arc(cx, cy, R, 0, Math.PI * 2);
    c.clip();
    c.strokeStyle = 'rgba(8,8,8,0.92)';
    c.fillStyle = 'rgba(8,8,8,0.92)';
    const thin = Math.max(1, 0.9 * dpr);
    c.lineWidth = thin;
    c.beginPath();
    c.moveTo(cx - R, cy); c.lineTo(cx + R, cy);
    c.moveTo(cx, cy - R); c.lineTo(cx, cy + R);
    c.stroke();
    // dicke Balken ausserhalb von 10 mil
    const post = 10 * pxPerMil;
    c.lineWidth = Math.max(3, 4 * dpr);
    c.beginPath();
    c.moveTo(cx - R, cy); c.lineTo(cx - post, cy);
    c.moveTo(cx + post, cy); c.lineTo(cx + R, cy);
    c.moveTo(cx, cy + post); c.lineTo(cx, cy + R);
    c.stroke();
    // Punkte je Mil; bei kleinem Zoom nur jede zweite, damit das Ziel sichtbar bleibt
    const dotR = Math.max(1.1 * dpr, Math.min(3.2 * dpr, pxPerMil * 0.09));
    const stepMil = pxPerMil < 7 * dpr ? 2 : 1;
    for (let i = -10; i <= 10; i++) {
      if (i === 0 || i % stepMil !== 0) continue;
      for (const [x, y] of [[cx + i * pxPerMil, cy], [cx, cy + i * pxPerMil]]) {
        c.beginPath();
        c.arc(x, y, dotR, 0, Math.PI * 2);
        c.fill();
      }
      if (pxPerMil > 14 * dpr) {
        c.lineWidth = thin;
        const hx = cx + (i - Math.sign(i) * 0.5) * pxPerMil;
        const hy = cy + (i - Math.sign(i) * 0.5) * pxPerMil;
        c.beginPath();
        c.moveTo(hx, cy - dotR * 1.5); c.lineTo(hx, cy + dotR * 1.5);
        c.moveTo(cx - dotR * 1.5, hy); c.lineTo(cx + dotR * 1.5, hy);
        c.stroke();
      }
    }
    if (pxPerMil > 9) {
      c.font = `${Math.round(10 * dpr)}px ui-monospace, monospace`;
      c.textAlign = 'center';
      for (const i of [5, 10]) {
        c.fillText(String(i), cx + i * pxPerMil, cy - pxPerMil * 0.6);
        c.fillText(String(i), cx - pxPerMil * 0.7, cy + i * pxPerMil + 4 * dpr);
      }
    }
    c.restore();
    c.globalAlpha = 1;

    const dots = '●'.repeat(p.ammo) + '○'.repeat(RIFLE.magazine - p.ammo);
    const incl = p.inclineDeg;
    this.info.innerHTML =
      `<span>Fleck <b>${p.zero} m</b></span><span>Zoom <b>${p.zoom.toFixed(1)}×</b></span>` +
      `<span>Neigung <b>${incl >= 0 ? '+' : ''}${incl.toFixed(1)}°</b></span><span class="ammo">${dots}</span>` +
      (this.maxHp > 1 ? `<span class="hp">${'♥'.repeat(this.hp)}${'♡'.repeat(this.maxHp - this.hp)}</span>` : '');
    const b = p.breathStatus;
    this.breathFill.style.width = `${Math.abs(b) * 100}%`;
    this.breathFill.style.background = b < 0 ? '#c24a3a' : p.holdingBreath ? '#d9d2b0' : 'rgba(217,210,176,0.45)';
  }

  update(dt: number, danger: number, windSpeed: number, windDirDeg: number, showWind: boolean) {
    if (this.briefT > 0) this.briefT -= dt;
    this.briefEl.style.opacity = this.briefT > 0 || this.briefHeld ? '1' : '0';
    this.danger.style.opacity = String(Math.min(0.8, danger * 0.9));
    if (this.toastT > 0) {
      this.toastT -= dt;
      if (this.toastT <= 0) this.toastEl.style.opacity = '0';
    }
    this.wind.style.display = showWind ? 'flex' : 'none';
    if (showWind) {
      this.wind.innerHTML = `<span style="transform:rotate(${windDirDeg}deg)">↑</span>${windSpeed.toFixed(1)} m/s`;
    }
  }

  drawDebug(enemies: Enemy[], status: DirectorStatus, extra: string) {
    if (!this.debugOn) {
      this.debug.style.display = 'none';
      return;
    }
    this.debug.style.display = 'block';
    const rows = enemies
      .map((e) => {
        const probs = INTENTS.map((i) => {
          const pct = Math.round(e.probs[i] * 100);
          return `<span class="bar${i === e.intent ? ' cur' : ''}"><i style="width:${pct}%"></i><em>${INTENT_VERB[i]} ${pct}%</em></span>`;
        }).join('');
        return `<div class="${e.dead ? 'dead' : ''}"><b>#${e.id + 1} ${e.info.label}</b> ${e.dead ? '† tot' : `<span class="src ${e.intentSource}">${e.intentSource === 'jev' ? 'JEV' : 'LOKAL'}</span> ${INTENT_VERB[e.intent]} · Phase ${e.phase} · Wahrn. ${Math.min(100, e.awareness * 100).toFixed(0)}% · Nerv. ${(e.nerves * 100).toFixed(0)}% · ${e.knowsPlayer ? 'kennt Position' : '—'}`}<div class="bars">${probs}</div></div>`;
      })
      .join('');
    this.debug.innerHTML =
      `${jevLine(status)}${rows}<div class="dh">${extra}</div>`;
  }
}

function clampN(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v));
}

/** Kopfzeile des Debug-Panels: ist Jev verfuegbar, und wenn nicht, warum? */
function jevLine(st: DirectorStatus): string {
  const stats = `Aufrufe ${st.calls} · Fallbacks ${st.fallbacks}`;
  switch (st.mode) {
    case 'jev':
      return `<div class="jev ok">Jev aktiv · Latenz ${st.lastLatency} ms · ${stats}</div>`;
    case 'aus':
      return `<div class="jev off">Jev nicht verfuegbar: in diesem Build gibt es keinen Jev-Proxy bzw. keinen API-Key (z. B. GitHub Pages). Die lokale KI steuert die Gegner.</div>`;
    case 'pausiert':
      return `<div class="jev off">Jev nicht erreichbar, nach 6 Fehlern in Folge ausgesetzt · neuer Versuch in ${st.pausedFor} s · lokale KI steuert<br><small>Letzter Fehler: ${escapeHtml(st.lastError)} · ${stats}</small></div>`;
    case 'fehler':
      return `<div class="jev off">Jev nicht erreichbar · lokale KI uebernimmt<br><small>Fehler: ${escapeHtml(st.lastError)} · ${stats}</small></div>`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
