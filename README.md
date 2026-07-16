# Expert Supply Flywheel MVP

Local-first full-stack MVP for expert crowdsourcing recruitment operations.

## What It Does

- Turns project demand into an expert recruiting persona.
- Recalls existing internal experts before spending external search budget.
- Uses Serper/Google and free public fallbacks to discover public candidate evidence.
- Uses Alibaba Cloud Bailian GLM 5.2 for project analysis, candidate extraction, fit explanations, outreach drafts, trial task design, and retrospective suggestions.
- Stores projects, experts, evidence, pipeline state, outreach drafts, trial tasks, marketing content, agent task runs, and audit events in Postgres.
- Keeps outreach and channel publishing draft-only in this MVP; it does not send emails, auto-post to social platforms, or scrape private contact details.

## Setup

```bash
npm install
cp .env.example .env
```

Set `DATABASE_URL` to a Postgres connection string. For local development, use a local Postgres database or a Neon development branch.

```bash
npx prisma generate
npm run prisma:migrate
npm run db:seed
npm run dev
```

Open `http://localhost:3000`.

## Environment

```bash
DATABASE_URL="postgresql://user:password@host/database?sslmode=require"
DASHSCOPE_BASE_URL="https://dashscope.aliyuncs.com/compatible-mode/v1"
BAILIAN_MODEL="glm-5.2"
BAILIAN_FALLBACK_MODELS="glm-5.1"
SERPER_API_KEY="..."
DASHSCOPE_API_KEY="..."
SEARCH_CACHE_TTL_HOURS="168"
SEARCH_FALLBACK_PROVIDERS="openalex,github"
PUBLIC_TRIAL_ACCESS="0"
TRIAL_BASIC_AUTH_USER="internal-ops-user"
TRIAL_BASIC_AUTH_PASSWORD="use-a-long-random-password"
```

Do not commit real API keys. If a key was pasted into chat or shared broadly, rotate it before using this app beyond local testing.

Search cost controls:

- Search results are cached by exact query for `SEARCH_CACHE_TTL_HOURS`, defaulting to 7 days.
- Serper is used first for broad Google-quality search.
- If Serper is missing, rate-limited, or fails, the app can fall back to free public APIs listed in `SEARCH_FALLBACK_PROVIDERS`.
- `openalex` is useful for researchers, publications, universities, and medical/academic experts.
- `github` is useful for software engineering experts and open-source evidence.
- Fallback providers are lower recall than Google and should be treated as evidence discovery, not as equivalent search coverage. They are good enough to keep the workflow alive when Serper is unavailable, but not good enough to guarantee candidate recall.
- In this local environment, `glm-5.2` was the working Bailian model name. Some workspaces document provider-prefixed names such as `ZHIPU/GLM-5.2`, but this deployment should use a model name that the configured key can actually access.

## Public Deployment Notes

This is a full-stack Next.js application with API routes, Prisma, and Postgres. GitHub Pages cannot run the complete app because it only serves static files.

Recommended public trial options:

- Vercel + Neon Postgres for a long-lived public or internal trial.
- Render, Railway, Fly.io, or a small VPS with managed Postgres are also acceptable.
- Do not use Vercel temporary SQLite for a long-lived trial.

For a public runtime deployment:

1. Choose one production access mode:
   - Public trial: set `PUBLIC_TRIAL_ACCESS=1`. The homepage and APIs are anonymously accessible.
   - Protected trial: keep `PUBLIC_TRIAL_ACCESS=0` and set both `TRIAL_BASIC_AUTH_USER` and `TRIAL_BASIC_AUTH_PASSWORD`.
   - Production fails closed when public mode is off and the Basic Auth credentials are incomplete.
2. Do not upload `.env.local`, `.env`, `prisma/dev.db`, `.next`, or `node_modules`.
3. Run `npm install`, `npm run prisma:generate`, `npm run prisma:migrate:deploy`, and optionally `npm run db:seed`.
4. Build with `npm run build`.
5. Start with `npm run start`.

Public mode exposes project, candidate, review-queue, and mutation APIs without authentication. Use it only for data that is safe to share publicly, and monitor external API quota consumption.

The included `vercel.json` build command maps Vercel Neon integration variables such as `product_POSTGRES_PRISMA_URL` into `DATABASE_URL`, runs `prisma migrate deploy`, then builds the Next.js app. This keeps Vercel deployments on persistent Neon storage instead of temporary serverless files.

For production use, add authentication, role permissions, rate limits, backups, and operational monitoring.

## Verification

```bash
npm run lint
npm run test
npm run build
```

Use `npm run prisma:migrate` for local schema changes and `npm run prisma:migrate:deploy` for hosted environments. The legacy `db:init` script is SQLite-only and should not be used for the Vercel + Neon deployment.

## MVP Boundaries

- No login or multi-user permissions.
- No real email sending.
- No automatic LinkedIn/Maimai automation.
- No credential truth decision for regulated experts.
- No payment, contract, or SMS workflow.
- AI failures do not write partial business records; they are surfaced as API errors and audit events.
