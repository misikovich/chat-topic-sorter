# Repository instructions

## Project

- This is a Node.js 26 TypeScript ESM Twitch chat topic sorter.
- `src/chatbot.ts` is the platform-neutral chat contract.
- `src/twitch.ts` contains Twitch EventSub and Helix behavior.
- `src/index.ts` is the environment-driven executable entrypoint.
- The topic-classification pipeline described in `README.md` is not wired into the entrypoint yet.

## Work in this repository

- Prefer Node built-ins and existing dependencies. Add a runtime dependency only when the requested behavior cannot be implemented clearly with the platform.
- Keep platform-specific fields and protocol handling out of `src/chatbot.ts`.
- Preserve sequential `AsyncIterable` message consumption and filter messages authored by the configured bot user.
- Keep logging scope-focused with a file-local `LOGTAG`. Never log access tokens, client secrets, or reconnect URLs.
- Treat `.env` as secret local state. When adding configuration, update `.env.example` and keep `.env` ignored.
- Treat `embedding-server/` as a pinned external Git submodule. Do not edit or advance it unless the task explicitly requests an upstream/submodule change.
- Keep llama.cpp scripts and prompts under `llama/`.

## Commands

```sh
git submodule update --init --recursive
npm install
npm start
npm test
npm run check
```

## Verification

- After TypeScript behavior changes, run `npm test` and `npm run check`.
- Use Node's built-in `node:test`; do not add a test framework.
- Mock `fetch` and `WebSocket` in tests. Do not contact live Twitch services or send live chat messages during automated verification.
- Keep tests focused on externally observable behavior, protocol boundaries, reconnect behavior, and regressions.
