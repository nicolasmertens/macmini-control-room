const http = require('http');
const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 3847;
const HOME = process.env.HOME || '/Users/macmini';
const CONTROL_ROOM = path.join(HOME, 'macmini-control-room');
const AGENTS_JSON = path.join(CONTROL_ROOM, 'agents.json');
const AGENTS_DIR = path.join(CONTROL_ROOM, 'agents');
const AGENT_LOGS_DIR = path.join(HOME, 'agent-logs');
const OLD_LOG = path.join(HOME, 'auto-fix.log');
const REPO_DIR = path.join(HOME, 'mrtns-projects');
const RUN_AGENT = path.join(CONTROL_ROOM, 'run-agent.sh');
const ENV = { encoding: 'utf8', timeout: 15000, env: { ...process.env, PATH: '/opt/homebrew/bin:/usr/local/bin:' + process.env.PATH } };

// Ensure dirs exist
[AGENT_LOGS_DIR, AGENTS_DIR].forEach(d => { try { fs.mkdirSync(d, { recursive: true }); } catch {} });

function safe(cmd) {
  try { return execSync(cmd, ENV).trim(); } catch { return ''; }
}

function parseCron(expr) {
  if (expr.startsWith('@')) {
    const map = { '@reboot': 'On startup', '@hourly': 'Every hour', '@daily': 'Every day at midnight', '@weekly': 'Every Sunday', '@monthly': '1st of month', '@yearly': 'January 1st' };
    return map[expr] || expr;
  }
  const [min, hr, dom, mon, dow] = expr.split(' ');
  const parts = [];
  if (min === '*' && hr === '*') parts.push('Every minute');
  else if (min.startsWith('*/')) parts.push(`Every ${min.slice(2)} minutes`);
  else if (hr === '*') parts.push(`At minute ${min} of every hour`);
  else if (hr.startsWith('*/')) parts.push(`Every ${hr.slice(2)} hours at minute ${min}`);
  else parts.push(`At ${hr.padStart(2, '0')}:${min.padStart(2, '0')}`);
  if (dow !== '*') {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    parts.push(`on ${dow.split(',').map(d => days[+d] || d).join(', ')}`);
  }
  if (dom !== '*') parts.push(`on day ${dom}`);
  if (mon !== '*') parts.push(`in month ${mon}`);
  return parts.join(' ');
}

function getAgents() {
  try {
    const agents = JSON.parse(fs.readFileSync(AGENTS_JSON, 'utf8'));
    return agents.map(agent => {
      // Read agent log
      const logFile = path.join(AGENT_LOGS_DIR, `${agent.id}.log`);
      let logLines = [];
      try { logLines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean); } catch {}

      // Also check old combined log for auto-fix
      if (agent.id === 'auto-fix') {
        try {
          const oldLines = fs.readFileSync(OLD_LOG, 'utf8').split('\n').filter(Boolean);
          logLines = [...oldLines, ...logLines];
        } catch {}
      }

      // Parse log entries
      const entries = [];
      for (const line of logLines.slice(-200)) {
        // Try new format: 2026-02-06 11:30:00 [STATUS] message
        let m = line.match(/^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s+\[(\w+)\]\s*(.*)/);
        if (m) {
          const d = new Date(m[1]);
          entries.push({ ts: d.toISOString(), short: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`, status: m[2], msg: m[3] });
          continue;
        }
        // Try old format: Fri Feb  6 11:30:00 EST 2026: message
        m = line.match(/^(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\w+\s+\d{4}):\s*(.*)/);
        if (m) {
          const d = new Date(m[1]);
          entries.push({ ts: d.toISOString(), short: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`, status: 'LOG', msg: m[2] });
        }
      }

      // Determine current status
      const lockFile = path.join(HOME, 'agent-locks', `${agent.id}.lock`);
      let running = false;
      let pid = null;
      try {
        pid = fs.readFileSync(lockFile, 'utf8').trim();
        running = safe(`kill -0 ${pid} 2>/dev/null && echo yes`) === 'yes';
        if (!running) pid = null;
      } catch {}

      // For auto-fix also check the old way
      if (agent.id === 'auto-fix' && !running) {
        const cp = safe('pgrep -f "claude -p"');
        if (cp) { running = true; pid = cp; }
      }

      // Last outcome
      const doneEntries = entries.filter(e =>
        /DONE|Finished|success|Created|completed/i.test(e.msg) || /ERROR|TIMEOUT|fail/i.test(e.msg)
      );
      const lastOutcome = doneEntries.length > 0 ? doneEntries[doneEntries.length - 1] : null;

      return {
        ...agent,
        human: parseCron(agent.schedule),
        running,
        pid,
        log: entries.slice(-100),
        lastOutcome,
        lastRun: entries.length > 0 ? entries[entries.length - 1] : null,
      };
    });
  } catch (e) {
    return [];
  }
}

function getSystemStatus() {
  const currentBranch = safe(`cd ${REPO_DIR} && git branch --show-current`);
  const lastCommit = safe(`cd ${REPO_DIR} && git log --oneline -5`);
  const openPRs = safe(`cd ${REPO_DIR} && gh pr list --state open --json number,title,headRefName,createdAt 2>/dev/null`) || '[]';
  const autoFixCount = safe(`cd ${REPO_DIR} && gh issue list --label auto-fix --state open --json number --jq 'length' 2>/dev/null`) || '0';
  const autoFixIssues = safe(`cd ${REPO_DIR} && gh issue list --label auto-fix --state open --limit 20 --json number,title 2>/dev/null`) || '[]';
  const uptime = safe('uptime');
  const disk = safe("df -h / | awk 'NR==2{print $3\"/\"$4\" (\"$5\" used)\"}'");
  const memory = safe("vm_stat | awk '/Pages free/{f=$3} /Pages active/{a=$3} END{printf \"%.0f MB active, %.0f MB free\",a*4096/1048576,f*4096/1048576}'");

  return {
    currentBranch,
    lastCommit: lastCommit.split('\n'),
    openPRs: (() => { try { return JSON.parse(openPRs); } catch { return []; } })(),
    autoFixIssuesRemaining: parseInt(autoFixCount) || 0,
    autoFixIssues: (() => { try { return JSON.parse(autoFixIssues); } catch { return []; } })(),
    uptime, disk, memory,
    timestamp: new Date().toISOString()
  };
}

function getStatus() {
  return {
    agents: getAgents(),
    system: getSystemStatus()
  };
}

function createAgent({ name, goal, schedule, timeout }) {
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const icon = '🤖';

  // Create agent prompt file
  const mdContent = `---
name: ${name}
schedule: "${schedule}"
goal: ${goal}
workdir: ${HOME}
timeout: ${timeout || 600}
icon: ${icon}
---

${goal}
`;
  fs.writeFileSync(path.join(AGENTS_DIR, `${id}.md`), mdContent);

  // Update agents.json
  const agents = JSON.parse(fs.readFileSync(AGENTS_JSON, 'utf8'));
  agents.push({ id, name, goal, schedule, icon, timeout: timeout || 600 });
  fs.writeFileSync(AGENTS_JSON, JSON.stringify(agents, null, 2) + '\n');

  // Add to crontab
  const currentCron = safe('crontab -l 2>/dev/null');
  const cronLine = `${schedule} ${RUN_AGENT} ${id} ${timeout || 600} >> ${AGENT_LOGS_DIR}/${id}.log 2>&1`;
  const newCron = currentCron + '\n' + cronLine + '\n';
  try {
    execSync(`echo "${newCron.replace(/"/g, '\\"')}" | crontab -`, ENV);
  } catch (e) {
    return { ok: false, error: e.message };
  }

  return { ok: true, id, cronLine };
}

function deleteAgent(agentId) {
  // Remove from agents.json
  let agents = JSON.parse(fs.readFileSync(AGENTS_JSON, 'utf8'));
  agents = agents.filter(a => a.id !== agentId);
  fs.writeFileSync(AGENTS_JSON, JSON.stringify(agents, null, 2) + '\n');

  // Remove prompt file
  const mdFile = path.join(AGENTS_DIR, `${agentId}.md`);
  try { fs.unlinkSync(mdFile); } catch {}

  // Remove from crontab
  const currentCron = safe('crontab -l 2>/dev/null');
  const lines = currentCron.split('\n').filter(l => !l.includes(`run-agent.sh ${agentId}`));
  try {
    execSync(`echo "${lines.join('\n').replace(/"/g, '\\"')}" | crontab -`, ENV);
  } catch {}

  return { ok: true };
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  if (req.url === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getStatus()));
  } else if (req.url === '/api/trigger' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let agentId = 'auto-fix';
      try { agentId = JSON.parse(body).agentId || 'auto-fix'; } catch {}
      exec(`bash ${RUN_AGENT} ${agentId} >> ${AGENT_LOGS_DIR}/${agentId}.log 2>&1`, { env: ENV.env });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ triggered: true, agentId }));
    });
  } else if (req.url === '/api/agent' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const result = createAgent(data);
        res.writeHead(result.ok ? 200 : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
  } else if (req.url?.startsWith('/api/agent/') && req.method === 'DELETE') {
    const agentId = req.url.split('/').pop();
    const result = deleteAgent(agentId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(HTML);
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`Control Room: http://0.0.0.0:${PORT}`));

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Mac Mini \u2014 Control Room</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#08090a;--s1:#101114;--s2:#181a1f;--s3:#1e2027;--b1:#252830;--b2:#32353e;--t:#e4e4e7;--t2:#8b8d98;--t3:#5c5e6a;--t4:#3a3c44;--green:#22c55e;--red:#ef4444;--amber:#f59e0b;--blue:#3b82f6;--purple:#a855f7}
body{background:var(--bg);color:var(--t);font-family:'DM Sans',sans-serif;min-height:100vh}

/* Header */
header{padding:20px 28px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--b1)}
header h1{font-size:16px;font-weight:600;display:flex;align-items:center;gap:10px}
.hdr-r{display:flex;align-items:center;gap:14px}
.hdr-t{font-size:11px;color:var(--t3);font-family:'JetBrains Mono',monospace}
.btn{padding:7px 14px;border-radius:7px;border:1px solid var(--b1);background:var(--s2);color:var(--t);font-size:12px;font-weight:500;cursor:pointer;transition:.15s;font-family:'DM Sans',sans-serif}
.btn:hover{background:var(--s3);border-color:var(--b2)}.btn:active{transform:scale(.97)}
.btn.primary{background:var(--blue);border-color:var(--blue);color:#fff}.btn.primary:hover{opacity:.9}

/* Agent Cards */
.agents-grid{display:grid;gap:1px;background:var(--b1)}
.schedule-group{background:var(--s1)}
.sg-header{padding:12px 22px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--t3);background:var(--bg);border-bottom:1px solid var(--b1);display:flex;align-items:center;gap:8px}
.sg-header .schedule-expr{color:var(--amber);font-family:'JetBrains Mono',monospace}
.sg-agents{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:1px;background:var(--b1)}
.agent-card{background:var(--s1);padding:18px 22px;cursor:pointer;transition:background .2s;position:relative}
.agent-card:hover{background:var(--s2)}
.ac-top{display:flex;align-items:center;gap:10px;margin-bottom:10px}
.ac-icon{font-size:20px}
.ac-name{font-size:14px;font-weight:600;flex:1}
.ac-status{display:flex;align-items:center;gap:5px;font-size:11px;font-weight:500}
.dot{width:8px;height:8px;border-radius:50%}
.dot.live{background:var(--green);box-shadow:0 0 8px var(--green);animation:pulse 2s infinite}
.dot.idle{background:var(--t4)}
.dot.err{background:var(--red);box-shadow:0 0 6px var(--red)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.ac-goal{font-size:12px;color:var(--t2);margin-bottom:8px;line-height:1.5}
.ac-meta{display:flex;gap:12px;font-size:11px;color:var(--t3)}
.ac-meta span{display:flex;align-items:center;gap:4px}
.ac-outcome{margin-top:8px;padding:8px 10px;border-radius:6px;font-size:11px;font-family:'JetBrains Mono',monospace}
.ac-outcome.ok{background:#22c55e10;color:var(--green)}
.ac-outcome.err{background:#ef444410;color:var(--red)}
.ac-outcome.skip{background:var(--s2);color:var(--t3)}

/* Summary Strip */
.summary{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--b1)}
.summary .c{background:var(--s1);padding:14px 22px}
.lbl{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--t3);margin-bottom:6px}
.val{font-size:22px;font-weight:700;letter-spacing:-.03em;font-family:'JetBrains Mono',monospace}
.sub{font-size:11px;color:var(--t3);margin-top:2px}

/* Issue/PR list */
.detail-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:1px;background:var(--b1)}
.detail-grid>.c{background:var(--s1);padding:16px 22px}
.il{list-style:none}.il li{padding:5px 0;border-bottom:1px solid #ffffff08;display:flex;gap:8px;font-size:12px;align-items:baseline}
.il li:last-child{border:none}.il .n{color:var(--blue);font-family:'JetBrains Mono',monospace;font-size:11px;min-width:30px}
.il .tt{color:var(--t2);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pr{padding:6px 0;border-bottom:1px solid #ffffff08}.pr:last-child{border:none}
.pr-t{font-size:12px;font-weight:500}.pr-m{font-size:10px;color:var(--t3);margin-top:2px;font-family:'JetBrains Mono',monospace}
.cm{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--t2);padding:3px 0}.cm .h{color:var(--amber)}

/* Activity Log */
.log{background:var(--s1);border-top:1px solid var(--b1)}
.log-h{padding:14px 22px;border-bottom:1px solid var(--b1);display:flex;align-items:center;justify-content:space-between}
.log-h h2{font-size:12px;font-weight:600}
.badge{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:5px;font-size:11px;font-weight:500}
.badge.b{background:#3b82f618;color:var(--blue)}
.log-b{max-height:350px;overflow-y:auto;scroll-behavior:smooth}
.ll{padding:3px 22px;font-family:'JetBrains Mono',monospace;font-size:11px;line-height:1.65;color:var(--t2);white-space:pre-wrap;word-break:break-all}
.ll:hover{background:var(--s2)}.ll .ts{color:var(--t4);margin-right:6px}.ll .ag{color:var(--purple);margin-right:6px}
.ll.st{color:var(--blue)}.ll.fi{color:var(--green)}.ll.err{color:var(--red)}.ll.sk{color:var(--t4)}.ll.ad{color:var(--amber)}
.foot{padding:10px 22px;border-top:1px solid var(--b1);font-size:10px;color:var(--t4);font-family:'JetBrains Mono',monospace;display:flex;justify-content:space-between}

/* Agent Detail Modal */
.modal-bg{display:none;position:fixed;inset:0;z-index:100;background:rgba(0,0,0,.7);backdrop-filter:blur(4px)}
.modal-bg.open{display:flex;align-items:center;justify-content:center}
.modal{background:var(--s1);border:1px solid var(--b1);border-radius:12px;width:90%;max-width:800px;max-height:85vh;overflow-y:auto}
.modal-hdr{padding:20px 24px;border-bottom:1px solid var(--b1);display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;background:var(--s1);z-index:1;border-radius:12px 12px 0 0}
.modal-hdr h2{font-size:14px;font-weight:600;display:flex;align-items:center;gap:8px}
.xb{background:none;border:none;color:var(--t3);font-size:18px;cursor:pointer;padding:4px 8px;border-radius:4px}.xb:hover{color:var(--t);background:var(--s2)}
.modal-hdr .actions{display:flex;gap:8px;align-items:center}
.ms{padding:20px 24px;border-bottom:1px solid var(--b1)}.ms:last-child{border:none}
.ms h3{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--t3);margin-bottom:12px}
.log-entry{padding:4px 0;font-size:11px;display:flex;gap:10px;border-bottom:1px solid #ffffff06;font-family:'JetBrains Mono',monospace}
.log-entry:last-child{border:none}
.le-ts{color:var(--t3);min-width:42px}
.le-st{min-width:60px;font-weight:500}
.le-st.START{color:var(--blue)}.le-st.DONE{color:var(--green)}.le-st.ERROR{color:var(--red)}.le-st.TIMEOUT{color:var(--amber)}.le-st.SKIP{color:var(--t4)}.le-st.LOG{color:var(--t2)}
.le-msg{color:var(--t2);flex:1;overflow:hidden;text-overflow:ellipsis}

/* Create Agent Modal */
.form-group{margin-bottom:16px}
.form-group label{display:block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--t3);margin-bottom:6px}
.form-group input,.form-group textarea,.form-group select{width:100%;padding:10px 12px;background:var(--s2);border:1px solid var(--b1);border-radius:8px;color:var(--t);font-size:13px;font-family:'DM Sans',sans-serif;outline:none;transition:border .2s}
.form-group input:focus,.form-group textarea:focus,.form-group select:focus{border-color:var(--blue)}
.form-group textarea{min-height:80px;resize:vertical}
.form-group .hint{font-size:10px;color:var(--t4);margin-top:4px}
.schedule-presets{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.schedule-presets button{padding:4px 10px;border-radius:5px;border:1px solid var(--b1);background:var(--s2);color:var(--t2);font-size:11px;cursor:pointer;transition:.15s}
.schedule-presets button:hover{background:var(--s3);color:var(--t)}
.schedule-presets button.active{background:var(--blue);border-color:var(--blue);color:#fff}

/* System bar */
.sysbar{display:grid;grid-template-columns:1fr 2fr 1fr;gap:1px;background:var(--b1)}
.sysbar .c{background:var(--s1);padding:12px 22px;font-size:12px;color:var(--t2)}

/* Scrollbar */
::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:var(--b1);border-radius:3px}

@media(max-width:768px){
  .summary{grid-template-columns:1fr 1fr}
  .detail-grid{grid-template-columns:1fr}
  .sg-agents{grid-template-columns:1fr}
  .sysbar{grid-template-columns:1fr}
}
</style>
</head>
<body>

<header>
  <h1>Mac Mini Control Room</h1>
  <div class="hdr-r">
    <span class="hdr-t" id="time"></span>
    <button class="btn" onclick="openCreate()">+ New Agent</button>
  </div>
</header>

<!-- Summary Strip -->
<div class="summary">
  <div class="c"><div class="lbl">Agents</div><div class="val" id="agentCount">\u2014</div><div class="sub" id="agentRunning"></div></div>
  <div class="c"><div class="lbl">Auto-fix Queue</div><div class="val" id="qc">\u2014</div><div class="sub">issues remaining</div></div>
  <div class="c"><div class="lbl">Open PRs</div><div class="val" id="pc">\u2014</div><div class="sub">waiting for merge</div></div>
  <div class="c"><div class="lbl">System</div><div id="si" style="font-size:12px;line-height:1.7"></div></div>
</div>

<!-- Agents grouped by schedule -->
<div class="agents-grid" id="agentsGrid"></div>

<!-- Details: issues, PRs, commits -->
<div class="detail-grid">
  <div class="c"><div class="lbl">Issue Queue</div><ul class="il" id="il"></ul></div>
  <div class="c"><div class="lbl">Pull Requests</div><div id="pl"></div></div>
  <div class="c"><div class="lbl">Recent Commits</div><div id="commits"></div></div>
</div>

<!-- Activity Log (all agents combined) -->
<div class="log">
  <div class="log-h"><h2>Activity Log</h2><span class="badge b" id="lc">0</span></div>
  <div class="log-b" id="lb"></div>
</div>
<div class="foot"><span id="up">\u2014</span><span>refresh: 10s</span></div>

<!-- Agent Detail Modal -->
<div class="modal-bg" id="agentModal" onclick="if(event.target===this)closeAgent()">
<div class="modal">
  <div class="modal-hdr">
    <h2 id="amTitle"></h2>
    <div class="actions">
      <button class="btn" id="amTrigger" onclick="triggerAgent()">Run Now</button>
      <button class="xb" onclick="closeAgent()">\u2715</button>
    </div>
  </div>
  <div class="ms">
    <h3>Goal</h3>
    <div id="amGoal" style="font-size:13px;color:var(--t2);line-height:1.6"></div>
  </div>
  <div class="ms">
    <h3>Schedule</h3>
    <div style="display:flex;gap:16px;align-items:baseline">
      <span id="amSchedule" style="font-family:'JetBrains Mono',monospace;font-size:14px;color:var(--amber)"></span>
      <span id="amHuman" style="font-size:13px;color:var(--t2)"></span>
    </div>
  </div>
  <div class="ms">
    <h3>Execution History</h3>
    <div id="amLog" style="max-height:300px;overflow-y:auto"></div>
  </div>
</div>
</div>

<!-- Create Agent Modal -->
<div class="modal-bg" id="createModal" onclick="if(event.target===this)closeCreate()">
<div class="modal" style="max-width:600px">
  <div class="modal-hdr">
    <h2>Create New Agent</h2>
    <button class="xb" onclick="closeCreate()">\u2715</button>
  </div>
  <div class="ms">
    <div class="form-group">
      <label>Name</label>
      <input type="text" id="caName" placeholder="e.g. Inbox Zero, Deploy Checker, Backup Photos">
    </div>
    <div class="form-group">
      <label>Goal</label>
      <textarea id="caGoal" placeholder="Describe what this agent should achieve. Be outcome-oriented.&#10;&#10;e.g. 'Go through my inbox and archive everything that's a newsletter or notification. Flag anything that needs a reply. Goal: inbox under 10 messages.'"></textarea>
      <div class="hint">Write it like you'd explain to a smart person. The agent uses Claude Code to figure out how.</div>
    </div>
    <div class="form-group">
      <label>Schedule</label>
      <input type="text" id="caSchedule" placeholder="*/30 * * * *" value="0 */4 * * *">
      <div class="schedule-presets">
        <button onclick="setSchedule('*/15 * * * *',this)">Every 15m</button>
        <button onclick="setSchedule('*/30 * * * *',this)">Every 30m</button>
        <button onclick="setSchedule('0 */2 * * *',this)">Every 2h</button>
        <button onclick="setSchedule('0 */4 * * *',this)" class="active">Every 4h</button>
        <button onclick="setSchedule('0 8 * * *',this)">Daily 8am</button>
        <button onclick="setSchedule('0 8 * * 1-5',this)">Weekdays 8am</button>
        <button onclick="setSchedule('0 22 * * *',this)">Nightly 10pm</button>
        <button onclick="setSchedule('0 0 1 * *',this)">Monthly</button>
      </div>
      <div class="hint" style="margin-top:8px" id="scheduleHint">Every 4 hours at minute 0</div>
    </div>
    <div class="form-group">
      <label>Timeout (seconds)</label>
      <input type="number" id="caTimeout" value="600" min="30" max="7200">
      <div class="hint">Max time the agent can run. 600 = 10 min, 1800 = 30 min.</div>
    </div>
    <button class="btn primary" style="width:100%;padding:12px;font-size:14px" onclick="submitAgent()">Create Agent</button>
  </div>
</div>
</div>

<script>
let D = {};
let currentAgent = null;

async function load() {
  try {
    const r = await fetch('/api/status');
    D = await r.json();
    render();
  } catch(e) {
    console.error('Load failed:', e);
  }
}

function render() {
  const { agents, system } = D;
  document.getElementById('time').textContent = new Date().toLocaleTimeString();

  // Summary
  const running = agents.filter(a => a.running).length;
  document.getElementById('agentCount').textContent = agents.length;
  document.getElementById('agentRunning').textContent = running > 0 ? running + ' running' : 'all idle';
  document.getElementById('qc').textContent = system.autoFixIssuesRemaining;
  document.getElementById('pc').textContent = system.openPRs.length;
  document.getElementById('si').innerHTML = esc(system.disk) + '<br>' + esc(system.memory) + '<br><span style="color:var(--t3)">' + esc(system.currentBranch) + '</span>';

  // Group agents by schedule
  const groups = {};
  agents.forEach(a => {
    const key = a.schedule;
    if (!groups[key]) groups[key] = { schedule: key, human: a.human, agents: [] };
    groups[key].agents.push(a);
  });

  const grid = document.getElementById('agentsGrid');
  grid.innerHTML = Object.values(groups).map(g => {
    const agentCards = g.agents.map(a => {
      let statusClass = 'idle';
      let statusText = 'Idle';
      if (a.running) { statusClass = 'live'; statusText = 'Running'; }
      else if (a.lastOutcome && /ERROR|TIMEOUT|fail/i.test(a.lastOutcome.msg)) { statusClass = 'err'; statusText = 'Error'; }

      let outcomeHtml = '';
      if (a.lastOutcome) {
        const cls = /ERROR|TIMEOUT|fail/i.test(a.lastOutcome.msg) ? 'err' : /DONE|Finished|success|Created/i.test(a.lastOutcome.msg) ? 'ok' : 'skip';
        outcomeHtml = '<div class="ac-outcome ' + cls + '">' + a.lastOutcome.short + ' ' + esc(a.lastOutcome.msg.substring(0, 100)) + '</div>';
      }

      return '<div class="agent-card" data-id="'+esc(a.id)+'" onclick="openAgent(this.dataset.id)">' +
        '<div class="ac-top">' +
          '<span class="ac-icon">' + a.icon + '</span>' +
          '<span class="ac-name">' + esc(a.name) + '</span>' +
          '<span class="ac-status"><span class="dot ' + statusClass + '"></span>' + statusText + '</span>' +
        '</div>' +
        '<div class="ac-goal">' + esc(a.goal) + '</div>' +
        '<div class="ac-meta">' +
          '<span>' + esc(a.human) + '</span>' +
          (a.type === 'service' ? '<span style="color:var(--purple)">service</span>' : '<span>timeout: ' + a.timeout + 's</span>') +
          '<span>' + a.log.length + ' entries</span>' +
        '</div>' +
        outcomeHtml +
      '</div>';
    }).join('');

    return '<div class="schedule-group">' +
      '<div class="sg-header">' +
        '<span class="schedule-expr">' + esc(g.schedule) + '</span>' +
        '<span>' + esc(g.human) + '</span>' +
        '<span style="margin-left:auto">' + g.agents.length + ' agent' + (g.agents.length > 1 ? 's' : '') + '</span>' +
      '</div>' +
      '<div class="sg-agents">' + agentCards + '</div>' +
    '</div>';
  }).join('');

  // Issues
  const il = document.getElementById('il');
  il.innerHTML = system.autoFixIssues.length === 0
    ? '<li style="color:var(--t3);font-size:12px">All done</li>'
    : system.autoFixIssues.slice(0, 10).map(i => '<li><span class="n">#' + i.number + '</span><span class="tt">' + esc(i.title) + '</span></li>').join('');

  // PRs
  const pl = document.getElementById('pl');
  pl.innerHTML = system.openPRs.length === 0
    ? '<div style="color:var(--t3);font-size:12px">None</div>'
    : system.openPRs.map(p => '<div class="pr"><div class="pr-t">#' + p.number + ' ' + esc(p.title) + '</div><div class="pr-m">' + p.headRefName + ' · ' + ago(p.createdAt) + '</div></div>').join('');

  // Commits
  document.getElementById('commits').innerHTML = system.lastCommit.map(c => '<div class="cm"><span class="h">' + esc(c.substring(0, 7)) + '</span> ' + esc(c.substring(8)) + '</div>').join('');

  // Combined activity log
  const allLogs = [];
  agents.forEach(a => {
    a.log.forEach(entry => {
      allLogs.push({ ...entry, agent: a.name, agentIcon: a.icon });
    });
  });
  allLogs.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
  const recent = allLogs.slice(-150);

  const lb = document.getElementById('lb');
  const atBot = lb.scrollTop >= lb.scrollHeight - lb.clientHeight - 40;
  lb.innerHTML = recent.map(l => {
    let c = 'll';
    if (/START|Starting/i.test(l.msg)) c += ' st';
    else if (/DONE|Finished|Created/i.test(l.msg)) c += ' fi';
    else if (/ERROR|fail/i.test(l.msg)) c += ' err';
    else if (/SKIP|skipping|waiting/i.test(l.msg)) c += ' sk';
    else if (/Adding|commit/i.test(l.msg)) c += ' ad';
    return '<div class="' + c + '"><span class="ts">' + (l.short || '') + '</span><span class="ag">' + (l.agentIcon || '') + '</span>' + esc(l.msg) + '</div>';
  }).join('');
  document.getElementById('lc').textContent = recent.length + ' lines';
  if (atBot) lb.scrollTop = lb.scrollHeight;

  document.getElementById('up').textContent = system.uptime;

  // Update agent modal if open
  if (currentAgent) {
    const a = agents.find(x => x.id === currentAgent);
    if (a) renderAgentModal(a);
  }
}

function openAgent(id) {
  currentAgent = id;
  const a = D.agents.find(x => x.id === id);
  if (!a) return;
  renderAgentModal(a);
  document.getElementById('agentModal').classList.add('open');
}

function renderAgentModal(a) {
  document.getElementById('amTitle').innerHTML = a.icon + ' ' + esc(a.name);
  document.getElementById('amGoal').textContent = a.goal;
  document.getElementById('amSchedule').textContent = a.schedule;
  document.getElementById('amHuman').textContent = a.human;
  document.getElementById('amTrigger').style.display = a.type === 'service' ? 'none' : '';

  const logHtml = a.log.slice(-50).reverse().map(e => {
    const stClass = (e.status || 'LOG').toUpperCase();
    return '<div class="log-entry">' +
      '<span class="le-ts">' + (e.short || '') + '</span>' +
      '<span class="le-st ' + stClass + '">' + stClass + '</span>' +
      '<span class="le-msg">' + esc(e.msg) + '</span>' +
    '</div>';
  }).join('');
  document.getElementById('amLog').innerHTML = logHtml || '<div style="color:var(--t3);font-size:12px">No log entries yet</div>';
}

function closeAgent() {
  currentAgent = null;
  document.getElementById('agentModal').classList.remove('open');
}

async function triggerAgent() {
  if (!currentAgent) return;
  const btn = document.getElementById('amTrigger');
  btn.textContent = 'Triggered...';
  btn.style.opacity = '0.5';
  await fetch('/api/trigger', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: currentAgent })
  }).catch(() => {});
  setTimeout(load, 3000);
  setTimeout(() => { btn.textContent = 'Run Now'; btn.style.opacity = '1'; }, 5000);
}

// Create Agent
function openCreate() { document.getElementById('createModal').classList.add('open'); }
function closeCreate() { document.getElementById('createModal').classList.remove('open'); }

function setSchedule(expr, btn) {
  document.getElementById('caSchedule').value = expr;
  document.querySelectorAll('.schedule-presets button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  updateScheduleHint(expr);
}

function updateScheduleHint(expr) {
  const hints = {
    '*/15 * * * *': 'Every 15 minutes',
    '*/30 * * * *': 'Every 30 minutes',
    '0 */2 * * *': 'Every 2 hours at minute 0',
    '0 */4 * * *': 'Every 4 hours at minute 0',
    '0 8 * * *': 'Every day at 08:00',
    '0 8 * * 1-5': 'Weekdays at 08:00',
    '0 22 * * *': 'Every day at 22:00',
    '0 0 1 * *': 'First day of every month at midnight'
  };
  document.getElementById('scheduleHint').textContent = hints[expr] || expr;
}

async function submitAgent() {
  const name = document.getElementById('caName').value.trim();
  const goal = document.getElementById('caGoal').value.trim();
  const schedule = document.getElementById('caSchedule').value.trim();
  const timeout = parseInt(document.getElementById('caTimeout').value) || 600;

  if (!name || !goal || !schedule) {
    alert('Fill in name, goal, and schedule');
    return;
  }

  const r = await fetch('/api/agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, goal, schedule, timeout })
  });
  const result = await r.json();
  if (result.ok) {
    closeCreate();
    document.getElementById('caName').value = '';
    document.getElementById('caGoal').value = '';
    load();
  } else {
    alert('Error: ' + (result.error || 'Unknown'));
  }
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeAgent(); closeCreate(); }
});

function ago(d) { const m = Math.floor((Date.now() - new Date(d)) / 60000); if (m < 60) return m + 'm'; const h = Math.floor(m / 60); return h < 24 ? h + 'h' : Math.floor(h / 24) + 'd'; }
function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

load();
setInterval(load, 10000);
setTimeout(() => { document.getElementById('lb').scrollTop = 99999; }, 1500);
</script>
</body>
</html>`;
