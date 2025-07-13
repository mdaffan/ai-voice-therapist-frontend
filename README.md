# Voice-Therapist UI (React + Vite)

A minimal voice-chat front-end with WebRTC recording, SSE streaming and 3-D blob visualiser.

---

## 1 Getting started (local dev)

```bash
cd voice-therapist-ui
pnpm install
pnpm dev      # http://localhost:5173 (or next available port)
```

The UI expects the backend to be running on `http://localhost:9000` (override via the `API_BASE` const inside `src/App.jsx`).

---

## 2 Docker

```bash
# Build static bundle and serve via Nginx on port 3000
docker build -f Dockerfile -t voice-therapist-ui .
docker run -p 3000:3000 voice-therapist-ui

# Open http://localhost:3000
```

---

## 3 Scripts

* `pnpm dev` – Vite dev server with HMR.
* `pnpm build` – production bundle to `dist/`.
* `pnpm preview` – locally preview the production build.

---

### Tech stack

* React 18 + Hooks
* Vite build tool
* TailwindCSS for utility-first styling
* Three.js via `@react-three/fiber` for blob animation
* PNPM workspace
