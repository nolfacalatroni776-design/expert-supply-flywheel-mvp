# Public Trial Access Design

## Goal

Make the production trial publicly accessible without an HTTP Basic Auth prompt while preserving a reversible, fail-closed authentication path for future use.

## Scope

Included:

- Anonymous access to the production homepage and application APIs.
- An explicit production environment switch named `PUBLIC_TRIAL_ACCESS`.
- Regression tests for public, protected, and misconfigured production modes.
- Deployment documentation and a production rollout verification.

Excluded:

- User accounts, sessions, roles, or per-project permissions.
- Rate limiting, CAPTCHA, abuse prevention, or data anonymization changes.
- Changes to projects, candidates, search results, workflows, or database schemas.

## Security Boundary

Setting `PUBLIC_TRIAL_ACCESS=1` makes the current production data and mutation APIs reachable without credentials. Visitors may read project and candidate data and may invoke workflows that create or update records or consume external API quota.

The application remains fail-closed by default. Production access is public only when the explicit switch is enabled. If the switch is missing or false, the existing Basic Auth behavior remains unchanged: valid credentials enable protected access, while missing credentials return a configuration error.

## Architecture

`resolveAccessProtection` will accept a `publicAccess` value in addition to environment, username, and password.

Resolution order:

1. If `publicAccess` is an accepted true value, return `disabled`.
2. Otherwise, if username and password are configured, return `enabled`.
3. Otherwise, return `misconfigured` in production and `disabled` outside production.

The proxy will pass `process.env.PUBLIC_TRIAL_ACCESS` into this resolver. Authentication parsing and credential comparison remain unchanged for protected mode.

Accepted public values will be intentionally narrow: `1` and `true`, case-insensitive after trimming. Other values will not disable protection.

## Configuration

Add to `.env.example`:

```text
PUBLIC_TRIAL_ACCESS="0"
```

Production rollout:

1. Set `PUBLIC_TRIAL_ACCESS=1` in Vercel Production.
2. Keep the existing Basic Auth credentials as dormant rollback credentials.
3. Redeploy production so the new environment value is applied.

Rollback requires setting `PUBLIC_TRIAL_ACCESS=0` or removing the variable, followed by a production redeploy.

## Testing

Unit tests must verify:

- Production with `PUBLIC_TRIAL_ACCESS=1` is public even when credentials exist.
- Production with `PUBLIC_TRIAL_ACCESS=true` is public.
- Unrecognized or false values do not disable protection.
- Production credentials still enable protected access when public mode is off.
- Production without public mode or credentials remains misconfigured.
- Local development without credentials remains unprotected.

Production verification must verify:

- `GET /` without `Authorization` returns `200`.
- `GET /api/projects` without `Authorization` returns `200` and valid JSON.
- Responses no longer include `WWW-Authenticate`.
- Existing authenticated requests continue to work because public mode ignores, rather than rejects, an Authorization header.
- The deployment has no new 5xx responses during verification.

## Acceptance Criteria

- When `PUBLIC_TRIAL_ACCESS=1` is configured in production, the system shall serve the homepage without requesting credentials.
- When an anonymous visitor requests `/api/projects`, the system shall return a successful JSON response.
- When public mode is disabled and credentials exist, the system shall continue enforcing Basic Auth.
- When public mode is disabled in production and credentials are absent, the system shall fail closed.
- When public mode is enabled, the system shall not alter existing project, candidate, workflow, or database data solely because access protection changed.

