# ISRO Mission Portal Prototype

A local full-stack prototype for the ISRO mission registry, HR messaging, and employee forms.

## Run

Requires Node.js 18 or newer.

```sh
npm start
```

Open the login page:

- **Live Production URL**: [https://isrovisionvault.vercel.app/](https://isrovisionvault.vercel.app/)
- **Local Dev Server**: http://localhost:3000/

Demo accounts:

- HR: `hr.admin` / `ISRO-HR-DEMO-2026`
- Employee: `rsharma_mcc` / `ISRO-EMP-DEMO-2026`

## Prototype behavior

- Missions, messages, and form completion are stored by the server in `data/prototype-state.json`.
- Messages are encrypted in the browser before transmission and stored as ciphertext with AES-256-GCM. The generated server key in `data/.message-key` protects legacy/server-created records.
- The browser UI calls the server API and retains browser storage only as an offline fallback.
- The current prototype contains one employee: Rajesh Kumar.
- API routes require an `HttpOnly` session cookie and enforce HR/employee permissions.
- Use **Sign Out** in the top-right to end the session.
- In DevTools → Network, `POST /api/messages` now shows an `enc` field instead of the message text.

## Important

This is a local prototype, not a production security system. Before deployment, replace demo credentials with a real identity provider, use HTTPS, a managed database, a KMS-backed key, CSRF protection, rate limiting, audit logging, backups, and security testing. Use synthetic mission data until those controls are implemented.
