# Admin authentication

Separate admin sign-in for the Mioralane admin panel: **email + password → 6-digit
emailed code → 3-hour server-side session**.

Customer authentication is untouched. Nothing in this document changes
`/api/auth/*`, `UserModel`, Google sign-in, or customer API authorization.

---

## 1. Design in one page

| Concern | Customer (unchanged) | Admin (this feature) |
| --- | --- | --- |
| Account store | `users` (`UserModel`) | `admins` (`AdminModel`) |
| Credential | password (+ Google) | password **and** a one-time code |
| Session | stateless JWT | `adminsessions` row + JWT |
| Cookie | `token` | `admin_token` |
| JWT audience | `mioralane-clients` | `mioralane-admin-clients` |
| Lifetime | `JWT_EXPIRES_IN` (default 7d) | exactly 3 h, never slides |
| Revocable | no (expiry only) | yes — logout revokes the row |
| Guard | `protect` | `adminGuard` = `adminProtect` + `adminOnly` |

Why the isolation holds (all four are independent of any role flag):

1. **Different cookies.** `adminProtect` reads only `admin_token`; `protect` reads
   only `token`. Neither can be authenticated by the other's value.
2. **Different JWT audiences.** `jwt.verify` pins the audience, so a customer JWT
   fails the admin guard (and vice versa) *before* any database lookup.
3. **Different collections.** `adminProtect` reads `Admin` + `AdminSession`;
   `protect` reads `User`. A MongoDB id is never used to infer account type.
4. **Explicit principal.** Admin tokens carry `typ: "admin"`; `req.admin` is set
   only by `adminProtect`, and `adminOnly` requires it. A `User` row with
   `role: "admin"` is still a customer and cannot reach a single `/api/admin/*`
   endpoint.

Admin endpoints live under `/api/admin/auth`. The four pre-session routes
(`bootstrap`, `login`, `verify-otp`, `resend-otp`) are the only unguarded routes
under `/api/admin`; `tests/verify-admin-route-guards.ts` fails the build if any
other one appears.

---

## 2. Endpoint contract

Base URL (staging): `https://api-staging.mioralane.com`
Base URL (local): `http://localhost:5000`

All responses use the project envelope: `{ "success": true | false, ... }`.

### `POST /api/admin/auth/bootstrap`

One-time provisioning of the **first** admin. Guarded by `ADMIN_BOOTSTRAP_SECRET`,
not by a session.

| Header | Value |
| --- | --- |
| `Content-Type` | `application/json` |
| `x-admin-bootstrap-secret` | the value of `ADMIN_BOOTSTRAP_SECRET` |

```json
{ "email": "mioralaneshop@gmail.com", "password": "<12+ chars, 3 of 4 classes>", "name": "Owner" }
```

| Status | Meaning |
| --- | --- |
| `201` | Created. Body: `{ success, message, admin: { id, email, name, role: "owner", permissions, isActive, createdAt } }` |
| `400` | Body invalid or password too weak |
| `403` | Header missing or wrong |
| `409` | An admin already exists (bootstrap is one-shot) |
| `503` | `ADMIN_BOOTSTRAP_SECRET` is not configured (bootstrap disabled) |

It creates **no** session and sets **no** cookie. The account still has to sign in
and pass OTP verification.

### `POST /api/admin/auth/login`

| Header | Value |
| --- | --- |
| `Content-Type` | `application/json` |
| `X-Turnstile-Token` | only if the deployment sets `TURNSTILE_SECRET_KEY` |

```json
{ "email": "mioralaneshop@gmail.com", "password": "…" }
```

`200`:

```json
{
  "success": true,
  "requiresOtp": true,
  "challengeId": "…43 url-safe chars…",
  "expiresAt": "2026-10-26T16:44:00.000Z",
  "otpExpiresInSeconds": 300
}
```

`401` `{ "success": false, "message": "Invalid email or password" }` — the same
answer for an unknown address, a wrong password **and** a disabled account.

`429` — rate limited (10 per 5 min per IP).
`503` — the code could not be emailed; no challenge and no session were created.

No cookie is set here. `challengeId` is the only thing to keep.

### `POST /api/admin/auth/verify-otp`

```json
{ "challengeId": "…", "otp": "123456" }
```

`200` sets the `admin_token` cookie and returns:

```json
{
  "success": true,
  "csrfToken": "…",
  "admin": { "id": "…", "email": "…", "name": "…", "role": "owner", "permissions": [], "isActive": true, "createdAt": "…" },
  "session": { "expiresAt": "2026-10-26T19:44:00.000Z" }
}
```

Failures are `400` with a `code`:

| `code` | Meaning |
| --- | --- |
| `OTP_INVALID` | wrong code (attempt counted) |
| `OTP_ATTEMPT_LIMIT` | 5 wrong attempts — the challenge is void |
| `OTP_EXPIRED` | the 5-minute window passed |
| `OTP_ALREADY_USED` | the code was already redeemed (replay) |
| `CHALLENGE_NOT_FOUND` | unknown challenge id, or a newer code was requested |

Also `401` if the account was disabled between the two steps, and `429` when rate
limited (10 per 5 min per IP).

### `POST /api/admin/auth/resend-otp`

```json
{ "challengeId": "…" }
```

`200` returns a **new** `challengeId` and expiry (the presented one is invalidated).
`429` with `{ code: "OTP_RESEND_COOLDOWN", retryAfterSeconds }` inside the 60-second
server-side cooldown, and `400` if the challenge is gone.

### `GET /api/admin/auth/me`

Requires the `admin_token` cookie. Returns the same `{ csrfToken, admin, session }`
shape as `verify-otp`, and is the session bootstrap the panel calls on every load.
`401` when the cookie is missing, expired, revoked or forged; `403` when the admin
is disabled.

### `POST /api/admin/auth/logout`

Requires the cookie **and** `X-CSRF-Token`. Revokes the `adminsessions` row, clears
the cookie, and answers `{ "success": true, "message": "Signed out successfully" }`.
The revoked cookie is rejected immediately afterwards.

---

## 3. Session and cookie policy

* Expiry is `verifiedAt + 3 h`, written once. **No sliding expiration.**
* The cookie is `HttpOnly`, `Path=/`, `SameSite=None; Secure` in production and
  `SameSite=Lax` outside it. `Max-Age` is computed from the same instant as the
  database row and the JWT `exp`.
* Every admin request re-validates, against MongoDB: the session row exists, is not
  revoked, has not expired, and its admin still exists and is active.
* MongoDB TTL indexes only sweep dead rows — **authorization never relies on them**.
* CSRF is unchanged in principle: a session-bound HMAC (`X-CSRF-Token`) is required
  on state-changing requests. Admin tokens are derived with their own scope
  (`csrf.admin.v1`), and the pre-session admin endpoints are exempt by exact path.
  CSRF is never disabled globally.
* No token, OTP or password is stored in `localStorage`/`sessionStorage`, and none
  is logged.

---

## 4. Environment variables

| Variable | Required | Notes |
| --- | --- | --- |
| `ADMIN_OTP_EMAIL` | yes (else login answers 503) | Inbox every code is sent to. Shared by all admins. `ADMIN_EMAIL` is a deprecated alias. |
| `ADMIN_BOOTSTRAP_SECRET` | for bootstrap only | ≥ 32 chars (`openssl rand -base64 48`). Remove it to disable bootstrap. |
| `ADMIN_OTP_TTL_MINUTES` | no | Default `5`, allowed `1`–`15`. |
| `ADMIN_SESSION_TTL_HOURS` | no | Honoured **outside production only**. Production is pinned to `3` in code so the policy cannot be weakened by configuration. |
| `ADMIN_SEED_PASSWORD` | no | Used by `npm run seed:admin` only, and only when it creates the account. |

Email is delivered through the existing Brevo/SMTP configuration
(`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`).

### Deployment pairs that must agree

| Where | Variable | Staging value |
| --- | --- | --- |
| Backend (API) | `CORS_ORIGINS` | `https://mioralane.com,https://www.mioralane.com,https://admin.mioralane.com,https://admin-staging.mioralane.com` |
| Admin panel (build time) | `NEXT_PUBLIC_API_URL` | `https://api-staging.mioralane.com/api` |

`CORS_ORIGINS` is the single allowlist used by both CORS and the CSRF origin guard,
so the admin origin has to be in it or every cross-site POST is refused with
`Request blocked — untrusted origin`. Staging origins are deliberately **not** in the
built-in default list: set them explicitly on the staging deployment so production
never trusts a staging host. `NEXT_PUBLIC_*` is inlined at build time, so changing it
needs a rebuild, not a restart.

---

## 5. Provisioning and disabling bootstrap

1. Set `ADMIN_BOOTSTRAP_SECRET` in the deployment (PM2 `ecosystem.config.js` env or
   `.env`), then restart the API.
2. Run the bootstrap request once with your own email and a strong password.
3. **Delete `ADMIN_BOOTSTRAP_SECRET`** from the environment and restart. Bootstrap
   then answers `503`, and even with the secret set it answers `409` because an
   admin already exists. There is no public registration endpoint.

Alternative for a shell-based setup: `npm run seed:admin` (reads
`ADMIN_SEED_PASSWORD`, generates a random password when unset, prints it once).

---

## 6. Legacy `User` accounts with `role: "admin"`

They are **not** admins any more: they cannot sign in to the panel and cannot reach
`/api/admin/*`. Nothing is deleted or rewritten automatically.

Cleanup, if you want it, is a manual decision:

```js
// inspect first — do not run destructively without reading the output
db.users.find({ role: "admin" }, { email: 1, username: 1, createdAt: 1 })
// then, optionally, demote them to ordinary customers
db.users.updateMany({ role: "admin" }, { $set: { role: "user" } })
```

---

## 7. Postman walkthrough

### Setup that makes the rest work

* **Cookies are persisted by Postman automatically**, per host. Every request below
  goes to the same host (`api-staging.mioralane.com`), so the `admin_token` cookie
  from step 5 is sent on steps 6–8 without any manual copying. Leave the cookie jar
  on (it is by default). To force a signed-out state, use
  *Cookies → manage cookies* and delete `admin_token`.
* **CSRF.** Every state-changing admin request except `bootstrap`, `login`,
  `verify-otp` and `resend-otp` must carry `X-CSRF-Token`. Copy the `csrfToken`
  value from the `verify-otp` response body (step 5) or from `GET /me` (step 6)
  into a Postman environment variable and add the header
  `X-CSRF-Token: {{csrfToken}}` to those requests.
* **Turnstile.** If the deployment sets `TURNSTILE_SECRET_KEY`, `POST /login` also
  needs `X-Turnstile-Token` from a solved widget. If it is unset, the middleware is
  a no-op and the header can be omitted.
* **Origin.** Postman sends no `Origin` header, which the Origin guard treats as a
  non-browser client and allows. Do not add a fake `Origin`.
* **Never paste secrets or codes into chat.** Keep the bootstrap secret in a Postman
  environment variable, and copy the OTP from the mailbox.

### Order

| # | Request | Method / URL | Headers | Body | Expect |
| --- | --- | --- | --- | --- | --- |
| 1 | Bootstrap | `POST https://api-staging.mioralane.com/api/admin/auth/bootstrap` | `Content-Type: application/json`, `x-admin-bootstrap-secret: {{adminBootstrapSecret}}` | `{"email":"mioralaneshop@gmail.com","password":"<strong password>","name":"Owner"}` | `201`, `admin.role = "owner"`, **no** `Set-Cookie` |
| 2 | Bootstrap again | same | same | different email | `409` |
| 3 | Login | `POST …/api/admin/auth/login` | `Content-Type: application/json` | `{"email":"mioralaneshop@gmail.com","password":"…"}` | `200`, `requiresOtp: true`, `challengeId`, **no** `Set-Cookie` |
| 4 | Read the code | — | — | Open the `ADMIN_OTP_EMAIL` inbox; subject “Mioralane Admin — your verification code” | A 6-digit code, valid 5 min |
| 5 | Verify | `POST …/api/admin/auth/verify-otp` | `Content-Type: application/json` | `{"challengeId":"{{challengeId}}","otp":"{{otp}}"}` | `200`, `Set-Cookie: admin_token=…; Max-Age=10800; HttpOnly`, `csrfToken`, `admin`, `session.expiresAt` = now + 3 h |
| 6 | Session | `GET …/api/admin/auth/me` | — | — | `200`, same profile, fresh `csrfToken` |
| 7 | Business endpoint | `GET https://api-staging.mioralane.com/api/admin/dashboard/summary` | — | — | `200` — proves the new guard protects existing admin routes |
| 8 | Logout | `POST …/api/admin/auth/logout` | `X-CSRF-Token: {{csrfToken}}` | — | `200`; cookie cleared server-side |
| 9 | Replay the old cookie | `GET …/api/admin/auth/me` with `Cookie: admin_token=<old value>` (take it from Postman's cookie jar before step 8) | `Cookie: admin_token=…` | — | `401`, `code: ADMIN_SESSION_REVOKED` |

### Negative checks

| Check | Request | Expect |
| --- | --- | --- |
| Wrong password | `POST …/login` with a bad password | `401`, `Invalid email or password`, and **no** email arrives |
| Unknown address | `POST …/login` with an unused address | `401`, byte-identical message |
| Wrong code | `POST …/verify-otp` with `"000000"` | `400`, `code: OTP_INVALID` |
| Attempt ceiling | repeat the wrong code 5× | last answer `code: OTP_ATTEMPT_LIMIT`, and the correct code is then refused |
| Expired code | request a code, wait > 5 min (or set `ADMIN_OTP_TTL_MINUTES=1`), then verify | `400`, `code: OTP_EXPIRED` |
| Reused code | repeat a successful `verify-otp` body | `400`, `code: OTP_ALREADY_USED` |
| No CSRF | `POST …/logout` without `X-CSRF-Token` | `403`, `CSRF token invalid or missing` |
| Customer cannot be admin | `POST https://api-staging.mioralane.com/api/auth/login` with a storefront account, then `GET …/api/admin/auth/me` in the same Postman session | Admin call answers `401 ADMIN_SESSION_REQUIRED` — the customer `token` cookie is never accepted as an admin session |
| Admin cannot be a customer | `GET …/api/auth/me` while holding only `admin_token` | `401` |

### Testing the 3-hour expiry without weakening production

Production is pinned to 3 hours. On **staging** set
`ADMIN_SESSION_TTL_HOURS=1` (integer 1–24), restart, sign in, and wait an hour —
`GET /me` then answers `401` with `code: ADMIN_SESSION_EXPIRED` even though the JWT
is still within its `exp` and no TTL sweep is needed. Revert the variable afterwards.

For an immediate check without waiting, the automated harness does exactly this
(`tests/verify-admin-auth.ts`, section D): it rewrites the stored `expiresAt` into
the past and asserts the 401. Against a scratch database you can do the same:

```js
db.adminsessions.updateOne({ revokedAt: null }, { $set: { expiresAt: new Date(Date.now() - 1000) } })
```

---

## 8. Operating notes

* **Restart the API after changing any admin env var** (`pm2 restart mioralane-api`
  or `pm2 reload mioralane-api`) — the values are read per request, but PM2 must
  re-read the environment.
* Rebuild is only needed for code changes: `npm run build` (backend), and
  `npm run build` in `mioralane-admin`, then restart/redeploy.
* Indexes: the first boot after this change creates the `admins`, `adminotps` and
  `adminsessions` indexes (`unique` on `Admin.email`, `AdminOtp.challengeId`,
  `AdminSession.tokenHash`, plus TTL indexes). Watch the boot logs for index errors
  if a previous partial deployment exists.
* Verification: `npm run verify:admin-auth` (behavioural, no database needed), plus
  `npm run verify:route-guards` and `npm run verify:csrf`.
