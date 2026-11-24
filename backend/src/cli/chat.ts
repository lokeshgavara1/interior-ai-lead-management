/**
 * Talk to the AI receptionist from your terminal (real prompt, engine, scoring,
 * assignment and alerts; in-memory database; no WhatsApp/Meta). Needs only the AI
 * settings in .env.
 *
 *   npm run chat                                              # interactive
 *   npm run chat -- "Hi, 3BHK in Kondapur" "Budget 8 lakhs"   # scripted, then exit
 *
 * Commands (interactive): /lead  /history  /reset  /quit
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { color as c, createHarness, leadSummary } from './harness.js';

async function main() {
  let h = createHarness({ echo: true });
  console.log(
    c.dim(`AI: ${h.cfg.OPENAI_MODEL} @ ${h.cfg.OPENAI_BASE_URL ?? 'api.openai.com'} | json=${h.cfg.LLM_JSON_MODE} | grounding=${h.cfg.LLM_FACT_GROUNDING}`),
  );

  const scripted = process.argv.slice(2);
  if (scripted.length > 0) {
    for (const text of scripted) await h.send(text);
    console.log(c.dim('\nLead record:'));
    console.log(leadSummary(h.lead()));
    return;
  }

  console.log(c.dim('Type as the customer. Commands: /lead  /history  /reset  /quit\n'));
  const rl = createInterface({ input: stdin, output: stdout });
  for (;;) {
    const line = (await rl.question(c.cyan('You › '))).trim();
    if (!line) continue;
    if (line === '/quit' || line === '/exit') break;
    if (line === '/lead') {
      console.log(leadSummary(h.lead()));
      continue;
    }
    if (line === '/history') {
      for (const m of h.repo.messages) console.log(c.dim(`  ${m.sender_type.padEnd(8)} ${m.incoming_message ?? m.outgoing_message}`));
      continue;
    }
    if (line === '/reset') {
      h = createHarness({ echo: true });
      console.log(c.dim('Started a new conversation.'));
      continue;
    }
    // The harness echoes "You ›" itself; avoid printing the line twice.
    stdout.write('\x1b[1A\x1b[2K');
    await h.send(line);
  }
  rl.close();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
