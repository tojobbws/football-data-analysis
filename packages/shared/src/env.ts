import { z } from 'zod';

const csvInts = z
  .string()
  .default('')
  .transform((s) =>
    s
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => {
        const n = Number(x);
        if (!Number.isInteger(n)) throw new Error(`Not an integer id: ${x}`);
        return n;
      }),
  );

const csvStrings = z
  .string()
  .default('')
  .transform((s) =>
    s
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
  );

export const envSchema = z.object({
  API_FOOTBALL_KEY: z.string().min(1, 'API_FOOTBALL_KEY is required'),
  API_FOOTBALL_BASE_URL: z.string().url().default('https://v3.football.api-sports.io'),
  API_FOOTBALL_RPM: z.coerce.number().int().positive().default(10),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  TRACKED_LEAGUES: csvInts.default('39,140'),
  SEASON: z.coerce.number().int().min(2000),
  ODDS_MARKETS: csvStrings.default('MATCH_WINNER,ASIAN_HANDICAP,OVER_UNDER'),
  ODDS_BOOKMAKERS: csvInts.default(''),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  /** Optional: without it the AI shadow ranking job skips (nothing else depends on it). */
  ANTHROPIC_API_KEY: z.string().optional().transform((v) => v || undefined),
  /** Optional: with both set, the AI jobs (previews, shadow ranking) use OpenAI instead of Claude. */
  OPENAI_API_KEY: z.string().optional().transform((v) => v || undefined),
  OPENAI_MODEL: z.string().optional().transform((v) => v || undefined),
});

export type Env = z.infer<typeof envSchema>;

/** Loads `.env` at the repo root if present (Node >= 20.12). Real env vars win. */
export function loadDotEnvFile(): void {
  const path = new URL('../../../.env', import.meta.url);
  try {
    process.loadEnvFile(path);
  } catch {
    // no .env file -> rely on real environment (e.g. GitHub Actions secrets)
  }
}

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${msg}`);
  }
  return parsed.data;
}
