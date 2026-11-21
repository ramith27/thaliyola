import { z } from "zod";
import { ownDatabaseHosts } from "./core/connections/network.js";
import { parseKey } from "./core/secrets.js";

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
    // Which proxies' X-Forwarded-For / -Proto to believe (client address for sign-in throttling, https for cookies):
    // loopback (a proxy on the same machine), a number of hops, "true", or addresses / ranges / loopback, linklocal,
    // uniquelocal (comma-separated). Behind one cloud load balancer: 1 (the address it appends, which clients can't
    // forge). Not uniquelocal there: it believes every private-address hop, so such a client could pick its own address
    TRUST_PROXY: z.string().default("loopback"),
    // On SIGTERM: how long in-flight requests and background jobs get to finish before the process exits anyway.
    // Keep it below Kubernetes' terminationGracePeriodSeconds minus the preStop sleep
    SHUTDOWN_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(600).default(20),
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
    // New people who sign in through Cloudflare Access (or a dev token) wait until an admin approves them
    REQUIRE_APPROVAL: z.enum(["true", "false"]).default("true"),
    // People who may publish in a project (Project admins, and any role given "publish") publish their own writes,
    // from Claude as well as the web, without waiting for review
    DIRECT_PUBLISH: z.enum(["true", "false"]).default("true"),
    DEFAULT_PROJECT_VISIBILITY: z.enum(["members", "team"]).default("members"),
    // People with Review approve, reject and publish through Claude (MCP tools, and REST calls with an API or OAuth
    // token), with the same permissions as in the web app. Off: only a person signed in to the web app decides
    ALLOW_MCP_APPROVALS: z.enum(["true", "false"]).default("true"),
    // Reviewers may approve their own article and finding proposals (off: someone else must)
    REVIEW_SELF_APPROVAL: z.enum(["true", "false"]).default("true"),
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
    // The /thaliyola slash command: the Slack app's signing secret (and SLACK_BOT_TOKEN to post answers).
    SLACK_SIGNING_SECRET: z.string().optional(),
    SLACK_API_URL: z.string().url().optional(),
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
    // Read private repositories' languages on GitLab (gitlab.com or self-hosted): a token with read_api
    GITLAB_TOKEN: z.string().optional(),
    // Connections: a project's databases, APIs, git hosts, Slack and Trello. Secrets are encrypted with CONNECTIONS_KEY
    // (32 random bytes, base64: openssl rand -base64 32; a Kubernetes Secret in production). To rotate it, set the new
    // key and keep the old one as CONNECTIONS_KEY_OLD until the server has re-sealed every secret (it does at start-up).
    CONNECTIONS: z.enum(["on", "off"]).default("on"),
    CONNECTIONS_KEY: z.string().optional(),
    CONNECTIONS_KEY_OLD: z.string().optional(),
    // Let API, Slack, Trello and git connections reach private networks (databases always may; loopback and metadata never)
    CONNECTIONS_ALLOW_PRIVATE: z.enum(["true", "false"]).default("false"),
    // Read-only queries through a database connection: rows returned (at most 1000) and time allowed
    QUERY_MAX_ROWS: z.coerce.number().int().min(1).max(1000).default(200),
    QUERY_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(15_000),
    // Skills for Claude: true/on (everyone gets the skills assigned to them), admins (Administrators only, for a
    // pilot) or false/off (Thaliyola gives Claude no skills). Admins can change it in Admin › System.
    SKILLS_ENABLED: z
      .string()
      .default("on")
      .transform((v) => v.trim().toLowerCase())
      .pipe(z.enum(["on", "true", "off", "false", "admins"])),
    // A skill version needs a second person to approve it unless this is on (small teams only).
    SKILLS_SELF_APPROVAL: z.enum(["true", "false"]).default("false"),
    // A Project admin's new skill or edit in their own project publishes at once (unless it has high-risk content),
    // like their articles. Needs DIRECT_PUBLISH too
    SKILLS_DIRECT_PUBLISH: z.enum(["true", "false"]).default("true"),
    // Largest skill import (a .zip or .tar.gz upload, or a repository archive)
    SKILLS_IMPORT_MAX_BYTES: z.coerce.number().int().positive().default(50 * 1024 * 1024),
    // How long "who loaded which skill" is kept
    SKILLS_USAGE_DAYS: z.coerce.number().int().min(1).max(3650).default(365),
    // Git hosts that skill imports may reach on a private network (exact host names, comma-separated, e.g. a VPN-only
    // GitLab). CONNECTIONS_ALLOW_PRIVATE doesn't apply to skill imports.
    SKILLS_GIT_HOSTS: z.string().default(""),
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
    for (const name of ["CONNECTIONS_KEY", "CONNECTIONS_KEY_OLD"] as const) {
      const value = env[name]?.trim();
      if (!value) continue;
      try {
        parseKey(value, name);
      } catch (err) {
        ctx.addIssue({ code: "custom", message: (err as Error).message });
      }
    }
    if (env.CONNECTIONS_KEY_OLD?.trim() && !env.CONNECTIONS_KEY?.trim()) ctx.addIssue({ code: "custom", message: "CONNECTIONS_KEY_OLD needs CONNECTIONS_KEY (the new key)" });
  });

export type Config = z.infer<typeof Env>;

/** TRUST_PROXY as Express takes it: true / false, a hop count, or the list of trusted addresses and ranges. */
export function trustProxyFrom(value: string): boolean | number | string {
  const v = value.trim();
  if (v === "true" || v === "false") return v === "true";
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

export function settingsFrom(config: Config): Settings {
  return {
    adminEmails: config.ADMIN_EMAILS.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean),
    requireApproval: config.REQUIRE_APPROVAL === "true",
    directPublish: config.DIRECT_PUBLISH === "true",
    mcpApprovals: config.ALLOW_MCP_APPROVALS === "true",
    reviewSelfApproval: config.REVIEW_SELF_APPROVAL === "true",
    defaultProjectVisibility: config.DEFAULT_PROJECT_VISIBILITY,
    duplicateThreshold: config.DUPLICATE_THRESHOLD,
    authMode: config.AUTH_MODE,
    mailTransport: config.MAIL_TRANSPORT === "smtp" && !config.SMTP_URL ? "off" : config.MAIL_TRANSPORT,
    smtpUrl: config.SMTP_URL,
    mailFrom: config.MAIL_FROM,
    slackWebhookUrl: config.SLACK_WEBHOOK_URL,
    slackApp: { signingSecret: config.SLACK_SIGNING_SECRET || undefined, botToken: config.SLACK_BOT_TOKEN || undefined, apiUrl: config.SLACK_API_URL },
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
      gitlabToken: config.GITLAB_TOKEN || undefined,
    },
    connections: {
      enabled: config.CONNECTIONS === "on",
      keys: {
        key: config.CONNECTIONS_KEY?.trim() ? parseKey(config.CONNECTIONS_KEY) : undefined,
        oldKey: config.CONNECTIONS_KEY_OLD?.trim() ? parseKey(config.CONNECTIONS_KEY_OLD, "CONNECTIONS_KEY_OLD") : undefined,
      },
      allowPrivate: config.CONNECTIONS_ALLOW_PRIVATE === "true",
      queryMaxRows: config.QUERY_MAX_ROWS,
      queryTimeoutMs: config.QUERY_TIMEOUT_MS,
      ownHosts: ownDatabaseHosts(config.DATABASE_URL),
    },
    skillsDelivery: config.SKILLS_ENABLED === "true" ? "on" : config.SKILLS_ENABLED === "false" ? "off" : config.SKILLS_ENABLED,
    skillsSelfApproval: config.SKILLS_SELF_APPROVAL === "true",
    skillsDirectPublish: config.SKILLS_DIRECT_PUBLISH === "true",
    skills: {
      importMaxBytes: config.SKILLS_IMPORT_MAX_BYTES,
      usageDays: config.SKILLS_USAGE_DAYS,
      gitHosts: config.SKILLS_GIT_HOSTS.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean),
    },
  };
}

/** Skills for Claude (core/skills). */
export interface SkillSettings {
  /** Largest import (upload or repository archive), in bytes. */
  importMaxBytes: number;
  /** Days of skill usage kept. */
  usageDays: number;
  /** Hosts skill imports may reach on a private network (SKILLS_GIT_HOSTS). */
  gitHosts: string[];
}

/** Who Thaliyola gives skills to: everyone (assigned skills), Administrators only, or nobody. */
export type SkillsDelivery = "on" | "admins" | "off";

/** Connections (core/connections). Keys never leave the server and are never logged. */
export interface ConnectionSettings {
  enabled: boolean;
  keys: import("./core/secrets.js").SecretKeys;
  /** API, Slack, Trello and git connections may reach private networks. */
  allowPrivate: boolean;
  queryMaxRows: number;
  queryTimeoutMs: number;
  /** Thaliyola's own database host(s): never a connection target. */
  ownHosts: string[];
  /** Tests only, never from the environment: loopback and the own database host are allowed (local test servers). */
  allowLocal?: boolean;
  /** Tests only: how long call_api waits (20 s otherwise). */
  callTimeoutMs?: number;
  /** Tests only: DNS lookups. */
  lookup?: (host: string) => Promise<{ address: string; family?: number }[]>;
  /** Tests only: API base URLs (slack, slack_hooks, trello, github, gitlab, bigquery, google_token, snowflake). */
  endpoints?: Partial<Record<string, string>>;
}

export interface Settings {
  /** Approvals from Claude (ALLOW_MCP_APPROVALS; Admin › System). Absent: on. */
  mcpApprovals?: boolean;
  /** Reviewers may approve their own article and finding proposals (REVIEW_SELF_APPROVAL; Admin › System). Absent: on. */
  reviewSelfApproval?: boolean;
  /** Skills for Claude delivery (SKILLS_ENABLED; Admin › System). Absent: on. */
  skillsDelivery?: SkillsDelivery;
  /** Authors may approve their own skill versions (SKILLS_SELF_APPROVAL; Admin › System). Absent: off. */
  skillsSelfApproval?: boolean;
  /** Project admins publish their own project's skills without review (SKILLS_DIRECT_PUBLISH; Admin › System). Absent: on. */
  skillsDirectPublish?: boolean;
  /** Skill import limits and private git hosts; absent: the defaults. */
  skills?: SkillSettings;
  /** Connections; absent in tests that don't use them. */
  connections?: ConnectionSettings;
  /** Team sources; absent in tests that don't use them. */
  sources?: { enabled: boolean; slackToken?: string; notionToken?: string; tavilyKey?: string; allowPrivate: boolean };
  /** Vulnerability matching; `fetch` is injected in tests. */
  /** The /thaliyola slash command (core/slack-app.ts). */
  slackApp?: { signingSecret?: string; botToken?: string; apiUrl?: string; fetch?: typeof fetch };
  security?: {
    enabled: boolean;
    osvUrl: string;
    kevUrl: string;
    feed?: boolean;
    nvdUrl?: string;
    nvdKey?: string;
    githubUrl?: string;
    githubToken?: string;
    gitlabToken?: string;
    fetch?: typeof fetch;
  };
  adminEmails: string[];
  /** New people seen through an identity provider need an admin's approval before they can do anything. */
  requireApproval: boolean;
  /** Writes by people holding "publish" in a project publish at once (agents' writes included) instead of waiting. */
  directPublish: boolean;
  /** Who can read a new project unless its creator chooses: its members only, or everyone signed in. */
  defaultProjectVisibility: "members" | "team";
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
