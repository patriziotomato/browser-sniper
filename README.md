# Ridgeline

Scharfschuetzen-Duell im Browser (Three.js + TypeScript + Vite). Konzept: siehe Claude-Doc "Ridgeline – Spielkonzept".

## Start

```bash
npm install
npm run dev
```

Der Browser oeffnet sich auf http://localhost:5173. Grafikstufe im Menue waehlbar (oder `?q=niedrig` an die URL haengen).

## Online spielen

https://patriziotomato.github.io/browser-sniper/ (wird bei jedem Push auf `main` per GitHub Actions gebaut).
Online gibt es keinen Server fuer den Jev-Proxy, dort steuert die lokale KI die Gegner.

## Jev (Gegner-Taktik)

In `.env.local`:

```
VITE_JEV_API_KEY=dein-key
# optional, Standard: https://api.typesafe.ai/v1/systemone
# VITE_JEV_API_URL=
```

Der Browser ruft `/jev-api` auf, der Vite-Server leitet an TypeSafe weiter und haengt den Key an
(siehe `vite.config.ts`). So gibt es kein CORS-Problem und der Key steckt nicht im Browser-Code.
Nach Aenderungen an `.env.local` den Dev-Server neu starten. Mit der Taste I siehst du im Spiel,
ob Jev oder die lokale KI entscheidet, die Latenz und ggf. den letzten Fehler.
Request/Antwort-Format steckt komplett in `src/ai/jev.ts`.

## Struktur

- `src/world/` Terrain, Himmel/Wetter, Vegetation, Deckungen, prozedurale Texturen
- `src/ballistics.ts` Flugbahnsimulation (Widerstand, Wind, Zeroing)
- `src/player.ts` Kamera, Zielfernrohr, Atmung, Puls, Ducken
- `src/enemies/` Gegnermodell, Animation, Wahrnehmung, Zielablauf
- `src/ai/` Jev-Client und Taktik-Direktor mit lokaler Fallback-KI
- `src/game.ts` Rundenablauf, Treffer, Bullet-Cam
