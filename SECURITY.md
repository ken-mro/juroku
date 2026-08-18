# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

- Use GitHub's private vulnerability reporting on this repository
  (Security → Report a vulnerability), or
- email the operator at the address listed in the privacy policy:
  https://ju-roku.com/privacy (English: https://ju-roku.com/privacy-en)

You should get a first reply within a week. Please include steps to reproduce
and, if relevant, the browser / OS you used.

## Scope

- `public/index.html` — the game (runs entirely in the browser)
- `worker/` — the Cloudflare Worker behind `/api/*` (Google sign-in, session
  cookie, KV sync). Secrets live only in Cloudflare (never in this repository).

Out of scope: the Suno CDN and other third-party services the game connects to,
and denial-of-service against Cloudflare.

## Supported version

Only the version deployed at https://ju-roku.com (the `main` branch) is
supported.
