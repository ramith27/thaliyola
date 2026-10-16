import { z } from "zod";

const Env = z
  .object({
    PORT: z.coerce.number().default(8080),
    // Interface to bind; 0.0.0.0 inside containers, 127.0.0.1 behind a local tunnel
    HOST: z.string().default("0.0.0.0"),
    DATABASE_URL: z.string().default("postgres://cairn:cairn@localhost:5432/cairn"),
    // local = built-in accounts; cloudflare = Cloudflare Access; dev = static tokens (local development only)
    AUTH_MODE: z.enum(["local", "cloudflare", "dev"]).default("local"),
    // Public base URL (e.g. https://cairn.example.com). In local mode it enables the OAuth server for
    // MCP clients such as claude.ai connectors, which need a fixed issuer URL.
    PUBLIC_URL: z.string().url().optional(),
    SESSION_TTL_HOURS: z.coerce.number().int().positive().default(168),
    // Secure cookies: auto = when the request arrived over https (directly or via a local proxy/tunnel)
    COOKIE_SECURE: z.enum(["auto", "true", "false"]).default("auto"),
    // dev mode: comma-separated "token=email" pairs
    DEV_TOKENS: z.string().default(""),
    // cloudflare mode: https://<team>.cloudflareaccess.com and the Access app's AUD tag
    CF_ACCESS_TEAM_DOMAIN: z.string().optional(),
    CF_ACCESS_AUD: z.string().optional(),
    // Emails that may approve anywhere and manage projects and members
    ADMIN_EMAILS: z.string().default(""),
    // Share of a proposal's terms an existing finding must contain to count as a near-duplicate
    // Built web UI to serve at / (defaults to apps/web/dist in the repo)
    WEB_DIST: z.string().optional(),
    // Where uploaded screenshots, token files and specs are stored
    ASSET_DIR: z.string().default("./data/assets"),
    ASSET_MAX_BYTES: z.coerce.number().int().positive().default(5 * 1024 * 1024),
    // Semantic search: local = bge-small in-process; hash = offline test embedder; off = keyword search only
    EMBEDDINGS: z.enum(["local", "hash", "off"]).default("local"),
    EMBEDDING_CACHE_DIR: z.string().optional(),
    // Cosine similarity a vector-only hit needs to be returned at all
    SEARCH_MIN_SIMILARITY: z.coerce.number().min(0).max(1).default(0.6),
    // Cosine similarity at which an existing finding counts as a near-duplicate
    DUPLICATE_SIMILARITY: z.coerce.number().min(0).max(1).default(0.8),
    // Published entries not verified for this many days are flagged possibly_stale
    STALE_AFTER_DAYS: z.coerce.number().int().positive().default(90),
    STALE_AFTER_DAYS_ARTICLES: z.coerce.number().int().positive().optional(),
    MAINTENANCE_INTERVAL_HOURS: z.coerce.number().positive().default(6),
    DUPLICATE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.6),
  })
  .superRefine((env, ctx) => {
    if (env.AUTH_MODE === "dev" && !env.DEV_TOKENS.trim()) {
      ctx.addIssue({ code: "custom", message: "AUTH_MODE=dev requires DEV_TOKENS (token=email pairs)" });
    }
    if (env.AUTH_MODE === "cloudflare" && (!env.CF_ACCESS_TEAM_DOMAIN || !env.CF_ACCESS_AUD)) {
      ctx.addIssue({ code: "custom", message: "AUTH_MODE=cloudflare requires CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD" });
    }
  });

export type Config = z.infer<typeof Env>;

export function settingsFrom(config: Config): Settings {
  return {
    adminEmails: config.ADMIN_EMAILS.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean),
    duplicateThreshold: config.DUPLICATE_THRESHOLD,
    authMode: config.AUTH_MODE,
    publicUrl: config.PUBLIC_URL?.replace(/\/+$/, ""),
    sessionTtlHours: config.SESSION_TTL_HOURS,
    cookieSecure: config.COOKIE_SECURE,
    assetDir: config.ASSET_DIR,
    searchMinSimilarity: config.SEARCH_MIN_SIMILARITY,
    duplicateSimilarity: config.DUPLICATE_SIMILARITY,
    assetMaxBytes: config.ASSET_MAX_BYTES,
  };
}

export interface Settings {
  adminEmails: string[];
  duplicateThreshold: number;
  authMode: "local" | "cloudflare" | "dev";
  publicUrl?: string;
  sessionTtlHours: number;
  cookieSecure: "auto" | "true" | "false";
  assetDir: string;
  searchMinSimilarity: number;
  duplicateSimilarity: number;
  assetMaxBytes: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return Env.parse(env);
}
