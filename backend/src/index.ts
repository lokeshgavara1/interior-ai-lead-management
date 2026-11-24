import { createOpenAiLlm } from './ai/llm.js';
import { createMetaGraph } from './channels/meta.js';
import { createSheetsApi, loadServiceAccount } from './channels/sheets.js';
import { createWhatsAppSender } from './channels/whatsapp.js';
import { loadConfig } from './config.js';
import { createSupabaseRepo } from './db/supabaseRepo.js';
import type { EngineDeps, Logger } from './engine/deps.js';
import { Inbox } from './engine/inbox.js';
import { runFollowups } from './jobs/followups.js';
import { runOverdueCheck } from './jobs/overdue.js';
import { runSheetSync } from './jobs/sheetSync.js';
import { createNotifier } from './notify/notifier.js';
import { buildServer } from './server.js';

/** Runs `task` every `ms`, never overlapping with itself. Returns a stop function. */
function every(ms: number, name: string, log: Logger, task: () => Promise<void>): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await task();
    } catch (err) {
      log.error({ err }, `${name} failed`);
    } finally {
      running = false;
    }
  }, ms);
  return () => clearInterval(timer);
}

async function main() {
  const cfg = loadConfig();

  const repo = createSupabaseRepo(cfg.SUPABASE_URL, cfg.SUPABASE_SERVICE_ROLE_KEY);
  const wa = createWhatsAppSender(cfg.WHATSAPP_ACCESS_TOKEN, cfg.META_GRAPH_VERSION);
  const meta = createMetaGraph(cfg.META_GRAPH_VERSION);
  const llm = createOpenAiLlm({
    apiKey: cfg.OPENAI_API_KEY,
    model: cfg.OPENAI_MODEL,
    baseURL: cfg.OPENAI_BASE_URL,
    jsonMode: cfg.LLM_JSON_MODE,
    timeoutMs: cfg.LLM_TIMEOUT_MS,
  });
  const notifier = createNotifier(repo, wa, {
    host: cfg.SMTP_HOST,
    port: cfg.SMTP_PORT,
    user: cfg.SMTP_USER,
    pass: cfg.SMTP_PASS,
    from: cfg.SMTP_FROM,
  });

  // Placeholder logger until Fastify's is available; replaced below.
  const deps: EngineDeps = {
    repo,
    llm,
    wa,
    meta,
    notifier,
    log: console,
    now: () => new Date(),
    historyLimit: cfg.HISTORY_LIMIT,
    factGrounding: cfg.LLM_FACT_GROUNDING,
  };
  console.info(
    `AI: model=${cfg.OPENAI_MODEL} base=${cfg.OPENAI_BASE_URL ?? 'api.openai.com'} json=${cfg.LLM_JSON_MODE} grounding=${cfg.LLM_FACT_GROUNDING}`,
  );
  const inbox = new Inbox(deps, cfg.DEBOUNCE_MS);
  const app = buildServer({
    deps,
    inbox,
    metaAppSecret: cfg.META_APP_SECRET,
    metaVerifyToken: cfg.META_VERIFY_TOKEN,
    logLevel: cfg.LOG_LEVEL,
  });
  deps.log = app.log;

  inbox.startSweeper();

  const stops = [
    every(cfg.FOLLOWUP_INTERVAL_MS, 'follow-ups', app.log, async () => {
      const sent = await runFollowups(deps);
      if (sent) app.log.info({ sent }, 'follow-ups sent');
    }),
    every(cfg.OVERDUE_INTERVAL_MS, 'overdue check', app.log, async () => {
      await runOverdueCheck(deps);
    }),
  ];

  const creds = loadServiceAccount(cfg.GOOGLE_SERVICE_ACCOUNT_JSON, cfg.GOOGLE_SERVICE_ACCOUNT_FILE);
  if (creds) {
    const sheets = createSheetsApi(creds);
    stops.push(every(cfg.SHEETS_SYNC_INTERVAL_MS, 'sheet sync', app.log, () => runSheetSync(deps, sheets)));
    app.log.info({ serviceAccount: creds.client_email }, 'Google Sheets sync enabled');
  } else {
    app.log.info('Google Sheets sync disabled (no service account configured)');
  }

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    stops.forEach((stop) => stop());
    await app.close();
    await inbox.drain();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: cfg.PORT, host: '0.0.0.0' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
