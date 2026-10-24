import { z } from "zod";

const Env = z
  .object({
    PORT: z.coerce.number().default(8080),
    // Interface to bind; 0.0.0.0 inside containers, 127.0.0.1 behind a local tunnel
    HOST: z.string().default("0.0.0.0"),
    DATABASE_URL: z.string().default("postgres://thaliyola:thaliyola@localhost:5432/thaliyola"),
    // local = built-in accounts; cloudflare = Cloudflare Access; dev = static tokens (local development only)
    AUTH_MODE: z.enum(["local", "cloudflare", "dev"]).default("local"),
    // Public base URL (e.g. https://thaliyola.example.com). In local mode it enables the OAuth server for
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
    // Largest upload for document import (a zip of Markdown/HTML pages and their images)
    IMPORT_MAX_BYTES: z.coerce.number().int().positive().default(50 * 1024 * 1024),
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
    // Weekly digest email: day (0 = Sunday … 6 = Saturday) and hour, server local time
    DIGEST_DAY: z.coerce.number().int().min(0).max(6).default(1),
    DIGEST_HOUR: z.coerce.number().int().min(0).max(23).default(8),
    // How long searches are kept for the hit rate and knowledge gaps
    SEARCH_LOG_DAYS: z.coerce.number().int().positive().default(180),
    // Email: smtp (SMTP_URL, e.g. smtps://user:pass@mail.example.com:465), json (log only) or off
    MAIL_TRANSPORT: z.enum(["smtp", "json", "off"]).default("off"),
    SMTP_URL: z.string().optional(),
    MAIL_FROM: z.string().default("Thaliyola <thaliyola@localhost>"),
    // Team channel for review and change events (Slack incoming webhook URL)
    SLACK_WEBHOOK_URL: z.string().optional(),
    DUPLICATE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.6),
    // Team sources (feeds, pages, Slack, Notion, Hacker News, web search) fetched into the inbox
    SOURCES: z.enum(["on", "off"]).default("on"),
    SLACK_BOT_TOKEN: z.string().optional(),
    NOTION_TOKEN: z.string().optional(),
    TAVILY_API_KEY: z.string().optional(),
    // Let feeds and page watches reach private networks (intranet wikis). Off: only public addresses
    SOURCES_ALLOW_PRIVATE: z.enum(["true", "false"]).default("false"),
    // Vulnerabilities: daily re-check of uploaded dependencies against OSV, and the CISA KEV catalog
    VULN_SCAN: z.enum(["on", "off"]).default("on"),
    OSV_API_URL: z.string().url().default("https://api.osv.dev"),
    KEV_URL: z.string().url().default("https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json"),
    // Latest critical vulnerabilities worldwide (NVD, GitHub advisories, CISA KEV), every 6 hours; keys only raise rate limits
    ADVISORY_FEED: z.enum(["on", "off"]).default("on"),
    NVD_API_URL: z.string().url().default("https://services.nvd.nist.gov/rest/json/cves/2.0"),
    NVD_API_KEY: z.string().optional(),
    GITHUB_API_URL: z.string().url().default("https://api.github.com"),
    GITHUB_TOKEN: z.string().optional(),
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
    importMaxBytes: config.IMPORT_MAX_BYTES,
    digestDay: config.DIGEST_DAY,
    digestHour: config.DIGEST_HOUR,
    searchLogDays: config.SEARCH_LOG_DAYS,
    sources: {
      enabled: config.SOURCES === "on",
      slackToken: config.SLACK_BOT_TOKEN || undefined,
      notionToken: config.NOTION_TOKEN || undefined,
      tavilyKey: config.TAVILY_API_KEY || undefined,
      allowPrivate: config.SOURCES_ALLOW_PRIVATE === "true",
    },
    security: {
      enabled: config.VULN_SCAN === "on",
      osvUrl: config.OSV_API_URL,
      kevUrl: config.KEV_URL,
      feed: config.ADVISORY_FEED === "on",
      nvdUrl: config.NVD_API_URL,
      nvdKey: config.NVD_API_KEY || undefined,
      githubUrl: config.GITHUB_API_URL,
      githubToken: config.GITHUB_TOKEN || undefined,
    },
  };
}

export interface Settings {
  /** Team sources; absent in tests that don't use them. */
  sources?: { enabled: boolean; slackToken?: string; notionToken?: string; tavilyKey?: string; allowPrivate: boolean };
  /** Vulnerability matching; `fetch` is injected in tests. */
  security?: {
    enabled: boolean;
    osvUrl: string;
    kevUrl: string;
    feed?: boolean;
    nvdUrl?: string;
    nvdKey?: string;
    githubUrl?: string;
    githubToken?: string;
    fetch?: typeof fetch;
  };
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
  importMaxBytes: number;
  digestDay: number;
  digestHour: number;
  searchLogDays: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return Env.parse(env);
}
