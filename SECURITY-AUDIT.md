# Security Findings: RapidX Voice Agent Stack, 9 August 2026

## Scope and threat model

The reviewed surface is the public Node dashboard, browser assets, PayU callbacks, Dograh and Cal.com adapters, deployment scripts, and the Rumik overlay. The highest-value assets are provider credentials, tenant data, wallet integrity, paid telephony and model usage, session tokens, support content, and availability.

Trust boundaries are browser to Studio, Studio to the local JSON store, Studio to Dograh, Studio to PayU, Studio to Cal.com, and tenant to tenant. The main abuse cases are credential stuffing, cross-tenant object access, forged payment callbacks, signup-driven provider spend, stored XSS through support or agent text, and denial of service against the single Node process.

## Findings

| # | Severity | Title | Location | CWE | Evidence | Required fix | Status |
|---|---|---|---|---|---|---|---|
| 1 | High | Wallet does not gate or deduct paid provider usage | `dashboard/server.js`, TTS, chat, voice-session and dial handlers | CWE-770 | Routes record usage but do not atomically reserve or deduct wallet credit before upstream spend. Public signup grants credit and can reach shared provider configuration. | Move wallet and usage accounting to PostgreSQL, reserve credit transactionally before work, settle actual cost after work, and enforce per-tenant quotas. | Open, documented production blocker |
| 2 | High | Shared Dograh organization configuration is not safe for paying multi-tenant use | `dashboard/.env.example`, `dashboard/server.js` | CWE-639 | One server-side Dograh key and workflow are used for all Studio tenants. Context variables do not establish upstream authorization isolation. | Provision one scoped Dograh organization binding per tenant and verify two-organization isolation before customer BYON. | Open, documented production blocker |
| 3 | Medium | Financial and identity data uses a single-process JSON store | `dashboard/lib/core.js` | CWE-362 | Atomic file replacement prevents torn writes inside one process, but there is no database transaction, row lock, multi-replica safety, encrypted field storage, or durable reconciliation. | Migrate wallets, payment intents, gateway events, memberships and audit records to PostgreSQL before accepting money. Add retention, export and erasure jobs for PII. | Open, documented production blocker |
| 4 | Medium | Production response lacks HSTS and a Content Security Policy | `dashboard/lib/core.js`, production nginx | CWE-319, CWE-693 | Live header verification returned `X-Content-Type-Options`, `Referrer-Policy`, and `X-Frame-Options`, but no HSTS or CSP. | Add HSTS at the HTTPS proxy after confirming every subdomain is HTTPS. Introduce CSP in report-only mode, verify browser calls and audio, then enforce it. | Open, rollout requires browser verification |
| 5 | Low | Signup reveals whether an email already exists | `dashboard/server.js`, `apiSignup` | CWE-204 | Existing accounts return `email_taken`, while new accounts create a tenant. | Use a neutral response or accept the enumeration risk for a low-sensitivity product. Keep login errors generic. | Accepted for current evaluation build |
| 6 | Low | Expired hashed sessions were not removed by the cleanup predicate | `dashboard/lib/core.js`, `getSession` | CWE-613 | The expiry branch filtered only the legacy plaintext `token` field, not `tokenHash`. Access was still denied, but expired rows remained until a new session was created. | Filter by both the legacy token and computed token hash. | Fixed and tested |

## Controls verified

- Staged Git content passed Gitleaks with no findings.
- `.env`, runtime `data/`, private keys, local Dograh checkouts, backups, and production credentials are ignored and not staged.
- Passwords use salted scrypt hashes and constant-time comparison.
- Session tokens are generated with `crypto.randomBytes`, stored as SHA-256 hashes, and sent in HttpOnly, SameSite cookies. Production cookies use Secure.
- Request bodies have hard size caps and API traffic has an in-process token bucket.
- Tenant-owned resources are scoped from the authenticated session. Cross-tenant agent, ticket, BYON, and member operations use tenant predicates.
- Admin routes enforce role levels. Impersonation requires password reauthentication, expires after 30 minutes, is audited, and blocks billing and administrative mutations.
- PayU amounts come from a server-owned catalog. Callback hashes and server verification are required, browser returns cannot credit, and ledger references are idempotent.
- User content rendered through HTML templates is escaped or assigned as text. No `eval`, shell execution, or user-controlled server URL fetch was found in the dashboard.
- The only runtime dependency is pinned in `pnpm-lock.yaml`. Nine Node tests and syntax checks pass.

## Release decision

The repository is suitable for source sharing, local evaluation, demos, and continued development. It is not approved for accepting customer money or exposing shared paid provider credentials to unrestricted signup until findings 1 through 3 are closed.
