# Public Trial Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the production trial anonymously accessible when `PUBLIC_TRIAL_ACCESS=1` while preserving the existing fail-closed Basic Auth path when public mode is off.

**Architecture:** Extend the pure access-protection resolver with an explicit public-mode input, then pass the Vercel environment variable through the existing Next.js proxy. Keep authentication parsing untouched. Enable the mode only through a production environment variable so rollback requires no code change.

**Tech Stack:** Next.js 16 proxy middleware, TypeScript, Vitest, Vercel CLI, Vercel serverless runtime.

---

### Task 1: Add the Explicit Public-Mode Decision

**Files:**
- Modify: `src/lib/access-protection.test.ts`
- Modify: `src/lib/access-protection.ts`

- [ ] **Step 1: Write failing public-mode tests**

Add these tests to `src/lib/access-protection.test.ts`:

```ts
it.each(["1", "true", " TRUE "])("allows explicit public production access with %j", (publicAccess) => {
  expect(
    resolveAccessProtection({
      environment: "production",
      user: "ops",
      password: "secret",
      publicAccess,
    }),
  ).toBe("disabled");
});

it.each(["0", "false", "yes", ""])("does not make production public with %j", (publicAccess) => {
  expect(
    resolveAccessProtection({
      environment: "production",
      user: "ops",
      password: "secret",
      publicAccess,
    }),
  ).toBe("enabled");
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run src/lib/access-protection.test.ts
```

Expected: FAIL because `publicAccess` is not accepted by `resolveAccessProtection` and public mode is not implemented.

- [ ] **Step 3: Implement the minimal resolver change**

Replace `src/lib/access-protection.ts` with:

```ts
export function resolveAccessProtection({
  environment,
  user,
  password,
  publicAccess,
}: {
  environment?: string;
  user?: string;
  password?: string;
  publicAccess?: string;
}): "enabled" | "disabled" | "misconfigured" {
  if (["1", "true"].includes(publicAccess?.trim().toLowerCase() ?? "")) return "disabled";
  if (user?.trim() && password?.trim()) return "enabled";
  return environment === "production" ? "misconfigured" : "disabled";
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
npx vitest run src/lib/access-protection.test.ts
```

Expected: all access-protection tests PASS, including the existing fail-closed and credential-protected cases.

- [ ] **Step 5: Commit the resolver behavior**

```bash
git add src/lib/access-protection.ts src/lib/access-protection.test.ts
git commit -m "Add explicit public trial access mode"
```

### Task 2: Connect Public Mode to the Proxy and Documentation

**Files:**
- Modify: `src/proxy.ts`
- Modify: `.env.example`
- Modify: `README.md`

- [ ] **Step 1: Pass the environment switch through the proxy**

Change the beginning of `proxy` in `src/proxy.ts` to:

```ts
export function proxy(request: NextRequest) {
  const user = process.env.TRIAL_BASIC_AUTH_USER;
  const password = process.env.TRIAL_BASIC_AUTH_PASSWORD;
  const publicAccess = process.env.PUBLIC_TRIAL_ACCESS;
  const protection = resolveAccessProtection({
    environment: process.env.NODE_ENV,
    user,
    password,
    publicAccess,
  });
```

Keep the remaining Basic Auth parsing, credential comparison, `401`, and `503` behavior unchanged.

- [ ] **Step 2: Add the example environment variable**

Add this line before the Basic Auth variables in `.env.example`:

```text
PUBLIC_TRIAL_ACCESS="0"
```

- [ ] **Step 3: Document public and protected deployment modes**

Add `PUBLIC_TRIAL_ACCESS="0"` to the README environment block. Replace the first public-runtime deployment note with:

```markdown
1. Choose one production access mode:
   - Public trial: set `PUBLIC_TRIAL_ACCESS=1`. The homepage and APIs are anonymously accessible.
   - Protected trial: keep `PUBLIC_TRIAL_ACCESS=0` and set both `TRIAL_BASIC_AUTH_USER` and `TRIAL_BASIC_AUTH_PASSWORD`.
   - Production fails closed when public mode is off and the Basic Auth credentials are incomplete.
```

Add this warning immediately after the deployment steps:

```markdown
Public mode exposes project, candidate, review-queue, and mutation APIs without authentication. Use it only for data that is safe to share publicly, and monitor external API quota consumption.
```

- [ ] **Step 4: Run static and full regression checks**

Run in parallel:

```bash
npm run lint
npm run typecheck
npm run test
```

Expected: lint exits 0, TypeScript exits 0, and all Vitest files pass.

- [ ] **Step 5: Commit proxy and documentation changes**

```bash
git add src/proxy.ts .env.example README.md
git commit -m "Document and wire public trial access"
```

### Task 3: Enable and Deploy Public Production Access

**Files:**
- No repository file changes.
- Modify external state: Vercel Production environment and deployment.

- [ ] **Step 1: Set the explicit production switch**

Run:

```bash
npx --yes vercel@latest env add PUBLIC_TRIAL_ACCESS production --force --value '1' --yes
```

Expected: Vercel reports `PUBLIC_TRIAL_ACCESS` overridden or added for Production.

- [ ] **Step 2: Deploy the tested working tree**

Run:

```bash
npx --yes vercel@latest --prod --yes
```

Expected: build completes, deployment status is `READY`, and `https://expert-supply-flywheel-mvp.vercel.app` is aliased to the new deployment.

- [ ] **Step 3: Verify anonymous homepage and API access**

Using the available server-side JavaScript fetch tool, execute:

```js
const [home, projects] = await Promise.all([
  fetch("https://expert-supply-flywheel-mvp.vercel.app/"),
  fetch("https://expert-supply-flywheel-mvp.vercel.app/api/projects"),
]);
const projectsJson = await projects.json();
({
  homeStatus: home.status,
  projectsStatus: projects.status,
  projectsOk: projectsJson.ok === true,
  homeAuthenticateHeader: home.headers.get("www-authenticate"),
  projectsAuthenticateHeader: projects.headers.get("www-authenticate"),
});
```

Expected:

```text
homeStatus: 200
projectsStatus: 200
projectsOk: true
homeAuthenticateHeader: null
projectsAuthenticateHeader: null
```

- [ ] **Step 4: Verify Authorization headers are harmless in public mode**

Execute:

```js
const response = await fetch("https://expert-supply-flywheel-mvp.vercel.app/", {
  headers: { Authorization: "Basic invalid-public-mode-credential" },
});
({ status: response.status, authenticateHeader: response.headers.get("www-authenticate") });
```

Expected: status `200` and `authenticateHeader` is `null`.

- [ ] **Step 5: Verify runtime health**

Run against the latest production deployment:

```bash
npx --yes vercel@latest logs --environment production --since 30m --status-code 5xx --limit 100 --json
```

Expected: no 5xx log entries.

### Task 4: Final Verification and Repository Synchronization

**Files:**
- No new file changes expected.

- [ ] **Step 1: Run fresh completion checks**

Run:

```bash
npm run lint
npm run typecheck
npm run test
git diff --check
git status --short --branch
```

Expected: all commands exit 0; the worktree is clean and `main` is ahead of `origin/main` only by the access-design and implementation commits.

- [ ] **Step 2: Push the reviewed commits**

```bash
git push origin main
```

Expected: `origin/main` advances to the local implementation commit.

- [ ] **Step 3: Confirm local and remote synchronization**

```bash
git status --short --branch
printf 'local=' && git rev-parse HEAD
printf 'remote=' && git rev-parse origin/main
```

Expected: clean `main...origin/main` status and identical SHA values.
