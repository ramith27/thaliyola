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
    // Requests per user per minute on /api and /mcp (0 disables)
    RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(0).default(600),
    LOG_REQUESTS: z.enum(["true", "false"]).default("true"),
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
    // Asset storage: local disk (ASSET_DIR) or any S3-compatible service
    ASSET_STORE: z.enum(["local", "s3"]).default("local"),
    S3_ENDPOINT: z.string().url().optional(),
    S3_REGION: z.string().default("us-east-1"),
    S3_BUCKET: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    S3_PREFIX: z.string().optional(),
    S3_PATH_STYLE: z.enum(["true", "false"]).default("true"),
    ASSET_MAX_BYTES: z.coerce.number().int().positive().default(5 * 1024 * 1024),
    // Semantic search: local = bge-small in-process; hash = offline test embedder; off = keyword search only
    EMBEDDINGS: z.enum(["local", "hash", "off"]).default("local"),
    EMBEDDING_CACHE_DIR: z.string().optional(),
    // Cosine similarity a vector-only hit needs to be returned at all
    SEARCH_MIN_SIMILARITY: z.coerce.number().min(0).max(1).default(0.6),
    // ...and be within this much of the best semantic match for the query
    SEARCH_SIMILARITY_WINDOW: z.coerce.number().min(0).max(1).default(0.02),
    // Cosine similarity at which an existing finding counts as a near-duplicate
    DUPLICATE_SIMILARITY: z.coerce.number().min(0).max(1).default(0.8),
    // Published entries not verified for this many days are flagged possibly_stale
    STALE_AFTER_DAYS: z.coerce.number().int().positive().default(90),
    STALE_AFTER_DAYS_ARTICLES: z.coerce.number().int().positive().optional(),
    MAINTENANCE_INTERVAL_HOURS: z.coerce.number().positive().default(6),
    // Email: smtp (SMTP_URL, e.g. smtps://user:pass@mail.example.com:465), json (log only) or off
    MAIL_TRANSPORT: z.enum(["smtp", "json", "off"]).default("off"),
    SMTP_URL: z.string().optional(),
    MAIL_FROM: z.string().default("Cairn <cairn@localhost>"),
    // Team channel for review and change events (Slack incoming webhook URL)
    SLACK_WEBHOOK_URL: z.string().optional(),
    DUPLICATE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.6),
  })
  .superRefine((env, ctx) => {
    if (env.AUTH_MODE === "dev" && !env.DEV_TOKENS.trim()) {
      ctx.addIssue({ code: "custom", message: "AUTH_MODE=dev requires DEV_TOKENS (token=email pairs)" });
    }
    if (env.ASSET_STORE === "s3" && (!env.S3_ENDPOINT || !env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY)) {
      ctx.addIssue({ code: "custom", message: "ASSET_STORE=s3 requires S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY" });
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
    mailTransport: config.MAIL_TRANSPORT === "smtp" && !config.SMTP_URL ? "off" : config.MAIL_TRANSPORT,
    smtpUrl: config.SMTP_URL,
    mailFrom: config.MAIL_FROM,
    slackWebhookUrl: config.SLACK_WEBHOOK_URL,
    rateLimitPerMinute: config.RATE_LIMIT_PER_MINUTE,
    logRequests: config.LOG_REQUESTS === "true",
    publicUrl: config.PUBLIC_URL?.replace(/\/+$/, ""),
    sessionTtlHours: config.SESSION_TTL_HOURS,
    cookieSecure: config.COOKIE_SECURE,
    assetDir: config.ASSET_DIR,
    s3:
      config.ASSET_STORE === "s3"
        ? {
            endpoint: config.S3_ENDPOINT!,
            region: config.S3_REGION,
            bucket: config.S3_BUCKET!,
            accessKeyId: config.S3_ACCESS_KEY_ID!,
            secretAccessKey: config.S3_SECRET_ACCESS_KEY!,
            prefix: config.S3_PREFIX,
            pathStyle: config.S3_PATH_STYLE === "true",
          }
        : undefined,
    searchMinSimilarity: config.SEARCH_MIN_SIMILARITY,
    searchSimilarityWindow: config.SEARCH_SIMILARITY_WINDOW,
    duplicateSimilarity: config.DUPLICATE_SIMILARITY,
    assetMaxBytes: config.ASSET_MAX_BYTES,
  };
}

export interface Settings {
  adminEmails: string[];
  duplicateThreshold: number;
  authMode: "local" | "cloudflare" | "dev";
  mailTransport: "smtp" | "json" | "off";
  smtpUrl?: string;
  mailFrom: string;
  slackWebhookUrl?: string;
  rateLimitPerMinute: number;
  logRequests: boolean;
  publicUrl?: string;
  sessionTtlHours: number;
  cookieSecure: "auto" | "true" | "false";
  assetDir: string;
  /** Set when ASSET_STORE=s3. */
  s3?: import("./core/s3.js").S3Config;
  searchMinSimilarity: number;
  searchSimilarityWindow: number;
  duplicateSimilarity: number;
  assetMaxBytes: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return Env.parse(env);
}
