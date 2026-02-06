# Inspiration & Future Ideas

## Cronicle (https://github.com/jhuckaby/Cronicle)
Multi-server task scheduler with web UI. MIT licensed, 5.2k stars.
Interesting features we might steal ideas from later:
- Visual schedule builder (multi-select years/months/days/hours/minutes)
- Real-time progress bars with estimated time remaining
- Performance graphs per job (historical stats)
- Plugin system (jobs emit JSON progress events)
- CPU/memory tracking per job
- Web hooks for external notifications
- API keys for remote triggering
- Chain events (one job triggers another, passing data between them)

**Why we're NOT using it:** Overkill. It's a full distributed scheduler for multi-server
setups. We have one Mac Mini. Our dashboard + agent system is simpler and purpose-built.

## Other tools worth knowing about
- **Dagu** — DAG-based scheduler, YAML config, native Docker/SSH support
- **Cronitor** — cron monitoring SaaS, good for alerting on failures
- **n8n.io** — visual workflow automation (like Zapier but self-hosted)

## Ideas for later
- [ ] Agent chaining: morning-report waits for auto-fix to finish
- [ ] Agent-to-agent data passing (auto-fix results -> morning-report)
- [ ] Webhook on agent completion (post to Slack/Discord)
- [ ] Historical performance charts per agent
- [ ] "Create Agent" UI: describe goal in plain text -> generates prompt file + cron entry
- [ ] Cost tracking per agent (Claude API usage)
- [ ] Mobile push notifications via Pushover/ntfy instead of iMessage
