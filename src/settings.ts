import * as z from "zod";

export const REGION_HOSTS = {
  us: "https://api.us1.odp.optimizely.com",
  eu: "https://api.eu1.odp.optimizely.com",
  au: "https://api.au1.odp.optimizely.com",
} as const;

export type Region = keyof typeof REGION_HOSTS;

/** Fixed limits; ODP credentials and region come from each client request, not from here. */
export const LIMITS = {
  requestTimeoutMs: 30_000,
  maxRetries: 2,
  maxResponseChars: 100_000,
  defaultPageSize: 25,
  schemaCacheTtlMs: 60 * 60 * 1000,
  schemaCacheMaxEntries: 100,
} as const;

const bool = z.enum(["true", "false"]).transform((v) => v === "true");

/** Optional operator settings from environment variables. None are required. */
const SettingsSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default("0.0.0.0"),
  /** If set, clients must also send `Authorization: Bearer <token>`. Use when the endpoint is reachable by others. */
  ODP_MCP_AUTH_TOKEN: z.string().min(16, "ODP_MCP_AUTH_TOKEN must be at least 16 characters").optional(),
  ODP_MCP_ALLOW_MUTATIONS: bool.default(false),
  ODP_MCP_ENABLE_EXPORTS: bool.default(true),
  /** Testing only: send every ODP request to this origin instead of the regional host. */
  ODP_MCP_UPSTREAM_OVERRIDE: z.url().optional(),
});

export type Settings = z.infer<typeof SettingsSchema>;

export function loadSettings(env = process.env): Settings {
  const parsed = SettingsSchema.safeParse(
    Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== "")),
  );
  if (!parsed.success) throw new Error(`invalid environment settings:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
