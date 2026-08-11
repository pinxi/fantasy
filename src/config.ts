import { z } from 'zod';
import path from 'node:path';

try {
  process.loadEnvFile(path.resolve(process.cwd(), '.env'));
} catch {
  // no .env yet — env vars may come from the shell
}

// Empty strings in .env (unset keys) parse as undefined.
const optionalString = (schema: z.ZodString) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), schema.optional());

const Env = z.object({
  SLEEPER_JWT: optionalString(z.string().min(20)),
  FANTASYPROS_API_KEY: optionalString(z.string().min(8)),
  DISCORD_WEBHOOK_URL: optionalString(z.string().url()),
  DATA_DIR: z.string().default('./data'),
});

export const env = Env.parse(process.env);

export const DATA_DIR = path.resolve(process.cwd(), env.DATA_DIR);
export const DB_PATH = path.join(DATA_DIR, 'fantasy.db');
export const RAW_DIR = path.join(DATA_DIR, 'raw');

export const SLEEPER_USER_ID = '765415446357942272';
export const SEASON = 2026;
export const PRIOR_SEASONS = [2023, 2024, 2025];
