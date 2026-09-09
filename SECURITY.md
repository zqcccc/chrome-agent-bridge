# Security model

Agent Browser Bridge is a local developer/agent bridge, not a browser sandbox.
An agent using it can inspect and control tabs in the connected Chrome profile,
including pages where the user is logged in. Treat the bridge token like a
local capability credential.

## Trust boundary

- The relay listens on `127.0.0.1` by default and is intended for local use.
- HTTP RPC and WebSocket connections require the generated bearer token. The relay does not expose an HTTP endpoint that returns the token.
- Anyone who can read the token, access the local relay, or control the user
  account can potentially control connected browser tabs.
- `page.evaluate`, debugger-backed operations, screenshots, and form actions
  may expose sensitive data or cause irreversible actions.
- The extension's content scripts cannot access protected `chrome://` pages,
  but ordinary authenticated web pages are within the bridge's intended scope.

This project does not provide isolation, authorization per website, or a
security boundary between agents. Use it only with trusted local agents and
review automation that sends messages, submits forms, purchases goods, or
changes account state.

## Reporting a vulnerability

Please avoid opening a public issue for a vulnerability that could expose
browser data or allow unauthorized RPC calls. Report it privately to the
repository maintainers first, including reproduction steps and the affected
commit or version.
