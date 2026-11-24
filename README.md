# SpaceMolt Agent UI

Vite + React + TypeScript frontend for the deployed SpaceMolt agent backend. It authenticates the human with Clerk, connects a pilot through SpaceMolt's browser login, and then lets the human talk to a backend agent that prioritizes missions and a pilot-defined objective through registered safe actions and approval-gated proposals.

## Setup

```sh
npm install
cp .env.example .env.local
```

Fill in `VITE_CLERK_PUBLISHABLE_KEY` with your own Clerk publishable key. `VITE_BACKEND_URL` defaults to `https://spacemolt-agent-backend.vercel.app`.

```sh
npm run dev
```

`npm run build` type-checks and produces `dist/`.

## Auth flow

Clerk signs the human into this app only. SpaceMolt has its own login, so no SpaceMolt username/password is requested for existing pilots:

1. Choose **Use SpaceMolt browser sign-in** and click **Open SpaceMolt sign-in**.
2. The UI shows a user code and a SpaceMolt link. Open it, sign in with Google on SpaceMolt, pick the pilot, and approve.
3. The UI polls the backend until approval, then shows the observation and enables **Pilot chat**. No password, username, or SpaceMolt token is handled by this app.
4. To create a new pilot, choose **Create pilot with registration code**, enter a username, empire, and the code from `https://spacemolt.com/dashboard`. The generated password is shown once - save it.

All transient links, codes, generated passwords and the SpaceMolt `sessionId` live only in component state. Nothing is written to `localStorage` or other persistent storage. A Clerk JWT is never sent to SpaceMolt.

## Pilot chat

After connecting, the chat section sends messages to `POST /api/chat` with the in-memory `sessionId`, the last 20 messages, the selected provider/model from `GET /api/health`'s `llmProviders` and `llmModelOptionsByProvider`, and the editable personal objective. The backend prefetches game state, asks the LLM for a reply plus at most four registered actions, executes safe actions immediately, and returns action results plus any proposals. The agent prioritizes active missions and the personal objective, and reports what changed after each meaningful batch.

Quick prompts cover the basic loop:

- **Where am I?** - read status and ask for a next step
- **Mine here** - travel/mine when at a resource POI
- **Dock, sell & refuel** - return to station, sell cargo, refuel

Type free-form requests too, e.g. `check my system for ore and tell me the best route`. The agent knows the SpaceMolt game loop and tool IDs from server-provided state; it does not invent IDs.

Approval cards show the exact `tool/action/args` and reason before anything sensitive happens. Text actions also show an editable text box; the pilot can revise the draft and click **Approve & send**, which sends that exact edited text to `POST /api/execute`. Decline discards the proposal locally. Combat, hunting, faction and mission writes, passengers, crafting, freight, gifts, trades, chat, forum posts and petitions all require approval.

## Errors

- `400` → invalid input or SpaceMolt error; the backend message is shown.
- `429` → SpaceMolt rate limit; retry shortly.
- `502` → backend could not connect to SpaceMolt.

Browser login terminal states are `access_denied` (declined) and `expired_token` (link expired); both ask the human to start a new link.

A slow LLM no longer hides game data: the observation card shows `Proposal unavailable: <reason>` while keeping `observed` status. Chat turns that cannot reach the LLM reply with an error and take no game action.

The UI treats backend JSON as untrusted: proposal fields may be strings, objects, numbers or missing, and are safely stringified before display instead of being passed directly to React as children.
