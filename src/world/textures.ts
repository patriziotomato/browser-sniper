import * as THREE from 'three';

// Prozedurale Texturen (Canvas), damit der Prototyp ohne Asset-Downloads laeuft.

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function tex(c: HTMLCanvasElement, repeat = false, srgb = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);

/** Moderner Flecktarn (Multicam-artig). */
export function camoTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(256, 256);
  g.fillStyle = '#7a7357';
  g.fillRect(0, 0, 256, 256);
  const cols = ['#5b5a3e', '#8d8463', '#4a4232', '#9a906c', '#3f4430', '#6b5f45'];
  for (let i = 0; i < 260; i++) {
    g.fillStyle = cols[i % cols.length];
    g.beginPath();
    const x = rand(0, 256), y = rand(0, 256), r = rand(4, 16);
    for (let a = 0; a < Math.PI * 2; a += 0.6) {
      const rr = r * rand(0.6, 1.3);
      g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr * 0.7);
    }
    g.closePath();
    g.fill();
  }
  return tex(c, true);
}

export function bushCardTexture(dry = false): THREE.CanvasTexture {
  const [c, g] = canvas(512, 512);
  g.clearRect(0, 0, 512, 512);
  // Zweige
  g.strokeStyle = '#33261a';
  g.lineCap = 'round';
  for (let i = 0; i < 14; i++) {
    g.lineWidth = rand(1.5, 3);
    g.beginPath();
    g.moveTo(256 + rand(-20, 20), 505);
    g.quadraticCurveTo(256 + rand(-120, 120), 320, 256 + rand(-220, 220), rand(40, 260));
    g.stroke();
  }
  // Blaetter: spitz zulaufend, mit Verlauf und Mittelrippe; innen dunkler, aussen heller
  for (let i = 0; i < 1500; i++) {
    const a = rand(0, Math.PI * 2), r = Math.sqrt(Math.random()) * 236;
    const x = 256 + Math.cos(a) * r, y = 256 + Math.sin(a) * r * 0.92;
    const outer = r / 236;
    const len = rand(9, 17), wid = len * rand(0.32, 0.45);
    const hue = dry ? rand(48, 70) : rand(78, 112);
    const light = 14 + outer * 16 + rand(-3, 6) + (y < 200 ? 4 : 0);
    const sat = rand(30, 55);
    g.save();
    g.translate(x, y);
    g.rotate(a + rand(-0.9, 0.9));
    const grad = g.createLinearGradient(0, -wid, 0, wid);
    grad.addColorStop(0, `hsl(${hue},${sat}%,${light + 7}%)`);
    grad.addColorStop(1, `hsl(${hue + 6},${sat}%,${Math.max(4, light - 5)}%)`);
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(-len / 2, 0);
    g.quadraticCurveTo(0, -wid, len / 2, 0);
    g.quadraticCurveTo(0, wid, -len / 2, 0);
    g.fill();
    g.strokeStyle = `hsla(${hue},30%,${light + 14}%,0.5)`;
    g.lineWidth = 0.7;
    g.beginPath();
    g.moveTo(-len / 2, 0);
    g.lineTo(len / 2.4, 0);
    g.stroke();
    g.restore();
  }
  return tex(c);
}

/** Fichtenzweig als Alpha-Karte: Hauptast, Seitentriebe, dichte Nadeln, hellere Triebspitzen. */
export function branchCardTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(512, 256);
  g.clearRect(0, 0, 512, 256);
  g.lineCap = 'round';
  const needle = (x: number, y: number, ang: number, len: number, light: number) => {
    g.strokeStyle = `hsl(${rand(100, 140)},${rand(28, 48)}%,${light}%)`;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    g.stroke();
  };
  // Zweig: Hauptachse von links (Stamm) nach rechts, Seitentriebe schraeg nach vorne
  const twigs: { x0: number; y0: number; x1: number; y1: number }[] = [];
  for (let i = 0; i < 26; i++) {
    const t = 0.06 + (i / 26) * 0.9;
    const x0 = t * 490, y0 = 128 + Math.sin(t * 3) * 4;
    const side = i % 2 ? 1 : -1;
    const reach = 92 * Math.sin(Math.PI * Math.min(1, t * 1.1)) * (1 - t * 0.3) * rand(0.75, 1.05);
    twigs.push({ x0, y0, x1: x0 + reach * 0.75, y1: y0 + side * reach });
  }
  twigs.push({ x0: 0, y0: 128, x1: 505, y1: 126 });
  g.strokeStyle = '#2e2216';
  for (const tw of twigs) {
    g.lineWidth = tw.x0 === 0 ? 4 : 1.8;
    g.beginPath();
    g.moveTo(tw.x0, tw.y0);
    g.lineTo(tw.x1, tw.y1);
    g.stroke();
  }
  // Nadeln entlang aller Triebe: innen dunkel, aussen heller
  g.lineWidth = 1.6;
  for (let pass = 0; pass < 2; pass++) {
    for (const tw of twigs) {
      const dx = tw.x1 - tw.x0, dy = tw.y1 - tw.y0;
      const len = Math.hypot(dx, dy);
      const ang = Math.atan2(dy, dx);
      const n = Math.round(len * 1.6);
      for (let k = 0; k < n; k++) {
        const t = k / n;
        const x = tw.x0 + dx * t, y = tw.y0 + dy * t;
        const side = Math.random() < 0.5 ? -1 : 1;
        const a = ang + side * rand(0.5, 1.2);
        const tipness = tw.x0 === 0 ? 0.2 : t;
        const light = pass === 0 ? rand(8, 16) : rand(14, 24) + tipness * rand(6, 16);
        needle(x, y, a, rand(7, 13) * (pass === 0 ? 1.15 : 0.9), light);
      }
    }
  }
  return tex(c);
}

export function grassCardTexture(): THREE.CanvasTexture {
  // Helligkeit und Form; die Farbe kommt im Shader vom Boden
  const [c, g] = canvas(256, 256);
  g.clearRect(0, 0, 256, 256);
  for (let i = 0; i < 150; i++) {
    const x = rand(10, 246), h = rand(90, 250) * (Math.random() < 0.2 ? 0.6 : 1), bend = rand(-30, 30);
    const w = rand(1.6, 3.2);
    const grad = g.createLinearGradient(0, 256, 0, 256 - h);
    const v = rand(150, 215);
    grad.addColorStop(0, `rgb(${v * 0.55},${v * 0.6},${v * 0.45})`);
    grad.addColorStop(1, `rgb(${v * rand(0.95, 1.1)},${v},${v * rand(0.7, 0.85)})`);
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(x - w, 256);
    g.quadraticCurveTo(x + bend * 0.4, 256 - h * 0.55, x + bend, 256 - h);
    g.quadraticCurveTo(x + bend * 0.4 + w * 0.6, 256 - h * 0.55, x + w, 256);
    g.fill();
  }
  return tex(c);
}

export function barkTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(128, 256);
  g.fillStyle = '#5a4634';
  g.fillRect(0, 0, 128, 256);
  for (let i = 0; i < 160; i++) {
    const v = rand(25, 110);
    g.strokeStyle = `rgba(${v},${v * 0.78},${v * 0.58},0.7)`;
    g.lineWidth = rand(1, 4);
    const x = rand(0, 128);
    g.beginPath();
    g.moveTo(x, 0);
    for (let y = 0; y <= 256; y += 16) g.lineTo(x + rand(-4, 4), y);
    g.stroke();
  }
  return tex(c, true);
}

export function planksTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(256, 256);
  const n = 8;
  for (let i = 0; i < n; i++) {
    const base = rand(70, 110);
    g.fillStyle = `rgb(${base},${base * 0.72},${base * 0.5})`;
    g.fillRect(0, (i * 256) / n, 256, 256 / n);
    for (let k = 0; k < 40; k++) {
      g.strokeStyle = `rgba(30,20,10,${rand(0.1, 0.35)})`;
      g.lineWidth = rand(0.5, 1.5);
      const y = (i * 256) / n + rand(2, 256 / n - 2);
      g.beginPath();
      g.moveTo(0, y);
      g.bezierCurveTo(80, y + rand(-2, 2), 170, y + rand(-2, 2), 256, y);
      g.stroke();
    }
    g.fillStyle = 'rgba(15,10,5,0.85)';
    g.fillRect(0, (i * 256) / n, 256, 2);
  }
  return tex(c, true);
}

export function logEndTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(128, 128);
  g.fillStyle = '#b08a5a';
  g.fillRect(0, 0, 128, 128);
  for (let r = 4; r < 62; r += rand(3, 6)) {
    g.strokeStyle = `rgba(90,60,30,${rand(0.3, 0.6)})`;
    g.lineWidth = rand(0.8, 2);
    g.beginPath();
    g.arc(64 + rand(-2, 2), 64 + rand(-2, 2), r, 0, Math.PI * 2);
    g.stroke();
  }
  g.strokeStyle = '#3d2e22';
  g.lineWidth = 6;
  g.beginPath();
  g.arc(64, 64, 61, 0, Math.PI * 2);
  g.stroke();
  return tex(c);
}

export function rockTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(256, 256);
  g.fillStyle = '#6d6a64';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 2500; i++) {
    const v = rand(60, 150);
    g.fillStyle = `rgba(${v},${v * 0.98},${v * 0.93},${rand(0.08, 0.3)})`;
    g.fillRect(rand(0, 256), rand(0, 256), rand(1, 6), rand(1, 6));
  }
  for (let i = 0; i < 120; i++) {
    g.fillStyle = `rgba(${rand(60, 90)},${rand(80, 105)},${rand(40, 55)},${rand(0.15, 0.4)})`;
    g.beginPath();
    g.arc(rand(0, 256), rand(0, 256), rand(3, 14), 0, Math.PI * 2);
    g.fill();
  }
  return tex(c, true);
}

export function sandbagTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(128, 128);
  g.fillStyle = '#8b7d5c';
  g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 600; i++) {
    g.fillStyle = `rgba(${rand(90, 150)},${rand(80, 130)},${rand(55, 90)},0.3)`;
    g.fillRect(rand(0, 128), rand(0, 128), 2, 2);
  }
  return tex(c, true);
}

/** Weicher radialer Fleck fuer Glint, Muendungsfeuer, Staub. */
export function glowTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(128, 128);
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.15, 'rgba(255,250,235,0.85)');
  grad.addColorStop(0.45, 'rgba(255,240,210,0.18)');
  grad.addColorStop(1, 'rgba(255,240,210,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  // Stern fuer den Glint
  g.globalCompositeOperation = 'lighter';
  g.strokeStyle = 'rgba(255,255,255,0.5)';
  g.lineWidth = 2;
  g.beginPath(); g.moveTo(0, 64); g.lineTo(128, 64); g.moveTo(64, 0); g.lineTo(64, 128); g.stroke();
  return tex(c);
}

export function dustTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(64, 64);
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.6, 'rgba(255,255,255,0.35)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return tex(c);
}

export function flagTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(128, 64);
  g.fillStyle = '#c23b22';
  g.fillRect(0, 0, 128, 64);
  g.fillStyle = '#e8e2d0';
  g.fillRect(0, 22, 128, 20);
  return tex(c);
}
