# Knight Room

A complete, responsive private chess game: vanilla JavaScript + CSS frontend, Node.js + Express + Socket.IO backend, and authoritative chess.js rules. No build step, accounts, CDN scripts, or database.

## Run

Install **Node.js 22 or newer**, then from this folder:

```sh
npm install
npm start
```

Open **http://localhost:3000**. The server binds to `0.0.0.0` and uses `PORT` if set. `npm run dev` enables Node's watch mode. `npm test` runs the game and real Socket.IO integration tests.

## Test with two tabs

1. Create a game, choose color/time, and copy its invite link.
2. Open the link in a **private/incognito window or a separate browser profile** and join. Ordinary tabs share localStorage; they intentionally restore the same seat when they have its token. Use a separate profile to play the other side.
3. Make moves by clicking a piece and destination or dragging it. Promotion opens a queen/rook/bishop/knight picker. Flip the board and use the SAN list or arrow buttons to review moves; return to the latest position to play.
4. Open a third browser/profile and choose **Watch as a spectator**. A regular Join on a full room gives a clear error.
5. Refresh a player window: its per-room token restores its seat, FEN, SAN history and clocks. Disconnect one player: after 60 seconds the opponent wins unless that player reconnects. Closing one of multiple tabs for a seat does not disconnect the remaining tab.
6. Try a draw offer and decline/accept, resign, and have both players request a rematch. Colors swap. Enable takebacks before creating to test request/accept/decline.
7. Choose 1+0 to check clock expiration, or Custom for increment behavior. White's initial clock is free until the first move, then Black's clock starts. Both sides receive increment after each move, including White's first move.

## Project structure

```text
multiplayer-chess/
  package.json / package-lock.json
  server/
    index.js             Express, sockets, seats, rate limits, cleanup
    game.js              Rules, clocks, results, takebacks, rematches
  public/
    index.html           Setup, game and dialogs
    style.css            Responsive board, dark/light themes
    app.js               Server-state rendering, touch/mouse, audio
    favicon.svg
  test/
    game.test.js         Rules and deterministic clock tests
    network.test.js      Real two-player Socket.IO integration tests
  browser-tests/
    game.spec.js         Desktop/mobile browser acceptance tests
  playwright.config.js
  Dockerfile
  render.yaml
  README.md
```

## Behavior and design choices

- Six-character codes use `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, checked for uniqueness. Exactly two player seats, plus read-only spectators. Player tokens are 256-bit random bearer secrets and never appear in public game state or share links.
- Each event requires a valid attached socket/seat, checks payload types, turn order and room state, and returns an acknowledgment with a readable error. The server supplies legal destinations; the browser never adjudicates moves or results.
- Server clocks use monotonic time and are recalculated from the active turn's last-move timestamp. Updates are broadcast every 250ms; client interpolation is visual only. Clocks continue during disconnects. A move arriving at/after flag fall is rejected. Reconnect and returning to a visible tab sync clocks again.
- Castling, en passant, all four promotions, checkmate, stalemate, threefold repetition, 50-move rule and insufficient material are handled by chess.js. Threefold/50-move draws are **automatic**, rather than requiring a claim.
- Timeout is a draw when the non-flagging side cannot possibly mate, including bare king, lone minor versus bare king, and bishops restricted to the same square color. Cooperative-mate cases are considered (two knights, or a lone minor with enemy blocking material).
- Accepted takebacks undo **one ply**, restore the pre-move clock balances, remove its increment, and restart the prior side's clock at acceptance. Only the last mover can request one; requests disappear on the next move.
- A rematch requires both connected players' agreement; seats swap, clocks reset and spectators stay. No automatic seat replacement after abandonment.
- Waiting/active rooms expire after **2 hours without joining or moving**; finished games expire **10 minutes after ending**, leaving time to review/rematch. Sync/clock ticks do not extend room lifetime. Disconnect grace is 60 seconds once both seats exist.
- Payloads are capped at 8KB. Per-socket and per-IP token buckets limit events, with 30 simultaneous sockets per transport IP, a creation cooldown and a 1,000-room cap. IP accounting uses the direct connection address and deliberately does not trust arbitrary forwarded headers; behind a reverse proxy this can group users. Tune this or add trusted-proxy edge rate limiting before a large public deployment.
- Names render through textContent, same-origin assets are protected by CSP, and pieces have Unicode fallback with system chess-symbol fonts. Sounds are small synthesized tones and require a browser interaction to unlock audio. Theme, mute, names and room tokens persist locally; clipboard operations need HTTPS or localhost.

## Deploy

Deploy the **whole Node service**, which serves both the frontend and Socket.IO on the same port. This is not a static hosting project.

**Render:** push this folder to a Git repository, create a Node Web Service, set the root directory to `multiplayer-chess` if the repository includes its parent, build command `npm ci --omit=dev`, start command `npm start`, and health check `/health`. A `render.yaml` blueprint is provided for a repository rooted at this folder. See [Render's Express guide](https://render.com/docs/deploy-node-express-app) and [WebSockets guide](https://render.com/docs/websocket).

**Railway:** create a project from the Git repository, choose this folder as the root if needed, use Node 22+, build with `npm ci --omit=dev`, start with `npm start`, and generate a public domain. The server already listens on the injected `PORT`. You may also use the included Dockerfile. See [Railway's Express guide](https://docs.railway.com/guides/express) and [Socket.IO guide](https://docs.railway.com/guides/socketio).

Use **one instance/replica** with this in-memory design. Restarting, redeploying or sleeping the service erases rooms and tokens' seat associations. Choose an always-running service for reliable live games. Multiple replicas require a shared room store, distributed clock/lock ownership and a Socket.IO adapter; an adapter alone does not share game state. No deployment has been performed by this project.

## Optional browser acceptance tests

```sh
npx playwright install chromium
npx playwright test
```

The test runner starts its own server on port 3100 and checks player interaction, spectator restrictions, refresh, history navigation, drag/drop, themes and mobile layout in isolated browser contexts.
