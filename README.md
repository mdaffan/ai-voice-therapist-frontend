# Voice-Therapist UI (React + Vite)

A minimal voice-chat front-end with WebRTC recording, SSE streaming and 3-D blob visualiser.

---

## 1 Getting started (local dev)

```bash
cd voice-therapist-ui
pnpm install
pnpm dev      # http://localhost:5173 (or next available port)
```

The UI expects the backend to be running on `http://localhost:9000` by default.  In production or if the API is on a different host, set the environment variable before build:

You can also change the value temporarily when running the dev server:

```bash
VITE_API_BASE="https://staging.example.com" 
```


## 2 Scripts

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
