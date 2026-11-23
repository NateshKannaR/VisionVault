# Local portal fixture

Two ISRO-themed demo roles exercise message exchange and form handling with synthetic records. The Node server binds to the local loopback interface. It uses short-lived in-process sessions and a local JSON state file. Accounts and the compatibility encryption key are shared demo fixtures.

```sh
npm ci
npm run build
npm run demo:portal
```

Open [the local portal sign-in](http://127.0.0.1:3000/login.html). The login page lists both demo accounts. Use separate browser profiles to keep an employee and an HR session open at the same time.

| Setting | Purpose |
| --- | --- |
| `PORT` | Demo server port, default `3000` |
| `VISIONVAULT_DEMO_DATA` | Override the default ignored state directory at `isro-panel/data/` |

The demo accepts only loopback connections and serves a fixed set of pages and assets. Use the [main README](../README.md) for the public site and optional planner deployment.
