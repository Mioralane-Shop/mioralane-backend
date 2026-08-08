import dotenv from 'dotenv';

// Load environment variables FIRST, before any other module is imported.
// ES module imports are hoisted, so importing this file at the very top of
// the entrypoint guarantees process.env is populated before modules that
// read env values at load time (e.g. auth JWT_SECRET).
dotenv.config();
