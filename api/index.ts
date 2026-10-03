import '../src/env';
import { validate } from '../src/config/env.validation';
import createApp from '../src/app.module';

/*
 * P1.6.2 — validate the environment on the path production actually runs.
 *
 * `validate()` was called only by `src/main.ts` (the local entrypoint), so this
 * file — the Vercel handler — booted with whatever it was given. That is how a
 * placeholder JWT_SECRET reached production: the app signed and verified tokens
 * with a string that is committed in this repository, so anyone who can read the
 * source can mint a token the API accepts.
 *
 * Ordering note: the `createApp` import above is static, so ES-module hoisting
 * evaluates `app.module` (and its ImageKit construction) BEFORE this call. A
 * deployment missing an ImageKit variable therefore still fails with ImageKit's
 * own error first — a loud cold-start failure either way. `src/main.ts` avoids the
 * hoisting with a dynamic import, which is not available here: Vercel compiles
 * this handler as CommonJS, where a top-level `await import()` is a syntax error.
 */
validate(process.env);

const app = createApp();

/**
 * Vercel serverless handler.
 * Exports the Express application as the default export so Vercel can
 * serve all routes through a single serverless function.
 */
export default app;
