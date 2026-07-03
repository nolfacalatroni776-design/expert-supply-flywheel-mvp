# Expert Supply Flywheel MVP

Local-first full-stack MVP for expert crowdsourcing recruitment operations.

## What It Does

- Turns project demand into an expert recruiting persona.
- Recalls existing internal experts before spending external search budget.
- Uses Serper/Google and free public fallbacks to discover public candidate evidence.
- Uses Alibaba Cloud Bailian GLM 5.2 for project analysis, candidate extraction, fit explanations, outreach drafts, trial task design, and retrospective suggestions.
- Stores projects, experts, evidence, pipeline state, outreach drafts, trial tasks, marketing content, agent task runs, and audit events in SQLite.
- Keeps outreach and channel publishing draft-only in this MVP; it does not send emails, auto-post to social platforms, or scrape private contact details.

## Setup

```bash
npm install
cp .env.example .env
npx prisma generate
npm run db:init
npm run db:seed
npm run dev
```

Open `http://localhost:3000`.

## Environment

```bash
DATABASE_URL="file:./dev.db"
DASHSCOPE_BASE_URL="https://dashscope.aliyuncs.com/compatible-mode/v1"
BAILIAN_MODEL="glm-5.2"
BAILIAN_FALLBACK_MODELS="ZHIPU/GLM-5.2"
SERPER_API_KEY="..."
DASHSCOPE_API_KEY="..."
SEARCH_CACHE_TTL_HOURS="168"
SEARCH_FALLBACK_PROVIDERS="openalex,github"
```

Do not commit real API keys. If a key was pasted into chat or shared broadly, rotate it before using this app beyond local testing.

Search cost controls:

- Search results are cached by exact query for `SEARCH_CACHE_TTL_HOURS`, defaulting to 7 days.
- Serper is used first for broad Google-quality search.
- If Serper is missing, rate-limited, or fails, the app can fall back to free public APIs listed in `SEARCH_FALLBACK_PROVIDERS`.
- `openalex` is useful for researchers, publications, universities, and medical/academic experts.
- `github` is useful for software engineering experts and open-source evidence.
- Fallback providers are lower recall than Google and should be treated as evidence discovery, not as equivalent search coverage. They are good enough to keep the workflow alive when Serper is unavailable, but not good enough to guarantee candidate recall.
- In this local environment, `glm-5.2` was the working Bailian model name. `ZHIPU/GLM-5.2` remains configured as a fallback for workspaces where that route is enabled.

## Public Deployment Notes

This is a full-stack Next.js application with API routes, Prisma, and SQLite. GitHub Pages cannot run the complete app because it only serves static files.

Recommended public trial options:

- Vercel free deployment for a 24-hour, low-traffic public trial by using `DATABASE_URL="file:/tmp/expert-recruiter-trial.db"` and `ENABLE_RUNTIME_DB_INIT="1"`.
- Render, Railway, Fly.io, or a small VPS with persistent disk for the full MVP.
- Vercel for longer-lived usage only after the database layer is moved to a hosted database.

For a public runtime deployment:

1. Set the environment variables from `.env.example` in the hosting provider.
2. Do not upload `.env.local`, `.env`, `prisma/dev.db`, `.next`, or `node_modules`.
3. Run `npm install`, `npm run prisma:generate`, `npm run db:init`, and optionally `npm run db:seed`.
4. Build with `npm run build`.
5. Start with `npm run start`.

The Vercel trial mode creates a temporary SQLite database at runtime and seeds safe trial data on first access. It is intended for short, low-traffic trials only. Runtime data can reset when the serverless instance is rebuilt or recycled.

For production use, replace local SQLite with a managed database and add authentication, role permissions, rate limits, and operational monitoring.

## Verification

```bash
npm run lint
npm run test
npm run build
```

`prisma migrate dev` is kept as a script for normal Prisma workflows, but this local MVP also includes `npm run db:init` because the schema engine failed silently in this desktop environment. The app still uses Prisma Client for all runtime database access.

## MVP Boundaries

- No login or multi-user permissions.
- No real email sending.
- No automatic LinkedIn/Maimai automation.
- No credential truth decision for regulated experts.
- No payment, contract, or SMS workflow.
- AI failures do not write partial business records; they are surfaced as API errors and audit events.
