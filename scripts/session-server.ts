import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { URLSearchParams } from "node:url";

const PORT = 8080;
const SESSIONS_DIR = "/srv/devbox/sessions";
const SCRIPTS_DIR = "/srv/devbox/scripts";
const REPOS_DIR = "/srv/devbox/repos";

let TAILSCALE_IP = "127.0.0.1";
try {
  TAILSCALE_IP = execFileSync("tailscale", ["ip", "-4"], { encoding: "utf8" }).trim();
} catch {
  console.warn("Could not get Tailscale IP, falling back to 127.0.0.1");
}

interface Session {
  name: string;
  repo: string;
  branch: string;
  baseBranch: string;
  port: number;
  worktreePath: string;
  tailscaleIp: string;
  startedAt: string;
  tmuxSession: string;
}

function findClaudeBridgeSessionId(worktreePath: string): string | null {
  try {
    const dir = path.join(process.env.HOME ?? "/home/dev", ".claude", "sessions");
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
        if (data.cwd === worktreePath && data.bridgeSessionId) {
          return data.bridgeSessionId as string;
        }
      } catch {
        // ignore malformed files
      }
    }
  } catch {
    // ignore missing directory
  }
  return null;
}

function readSessions(): Session[] {
  try {
    return fs
      .readdirSync(SESSIONS_DIR)
      .filter((f) => f.endsWith(".json"))
      .flatMap((f) => {
        try {
          return [JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), "utf8")) as Session];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function listRepos(): string[] {
  try {
    return fs
      .readdirSync(REPOS_DIR)
      .filter((name) => fs.existsSync(path.join(REPOS_DIR, name, ".git")))
      .sort();
  } catch {
    return [];
  }
}


function formatElapsed(startedAt: string): string {
  const mins = Math.floor((Date.now() - new Date(startedAt).getTime()) / 60000);
  const hrs = Math.floor(mins / 60);
  return hrs > 0 ? `${hrs}h ${mins % 60}m` : `${mins}m`;
}

function parseBody(req: http.IncomingMessage): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(Object.fromEntries(new URLSearchParams(body)));
      } catch {
        resolve({});
      }
    });
  });
}

function esc(str: string): string {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function tmuxCapture(tmuxSession: string): string {
  try {
    return execFileSync(
      "tmux",
      ["capture-pane", "-t", `${tmuxSession}:server`, "-p", "-S", "-500"],
      { encoding: "utf8" },
    );
  } catch {
    return "(tmux session not found)";
  }
}

function renderLogsPage(name: string, tmuxSession: string, initialOutput: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(name)} — logs</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #0f1117; --surface: #1a1d27; --border: #2d3148;
      --accent: #6c63ff; --text: #e2e8f0; --muted: #8892a4;
      --font: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    body { background: var(--bg); color: var(--text); font-family: var(--font);
           display: flex; flex-direction: column; height: 100dvh; }
    header { display: flex; align-items: center; gap: 12px; padding: 12px 16px;
             border-bottom: 1px solid var(--border); flex-shrink: 0; }
    header a { color: var(--muted); text-decoration: none; font-size: .85rem; }
    header a:hover { color: var(--text); }
    header strong { font-size: .95rem; }
    header .tag { font-size: .7rem; color: var(--muted); background: var(--surface);
                  padding: 2px 8px; border-radius: 20px; border: 1px solid var(--border); }
    pre { flex: 1; overflow: auto; padding: 14px 16px; font-family: "SF Mono", "Fira Code",
          "Consolas", monospace; font-size: .75rem; line-height: 1.5;
          white-space: pre-wrap; word-break: break-all; color: #c9d1d9; }
  </style>
</head>
<body>
  <header>
    <a href="/">← Back</a>
    <strong>${esc(name)}</strong>
    <span class="tag">dev server</span>
  </header>
  <pre id="log">${esc(initialOutput)}</pre>
  <script>
    const pre = document.getElementById('log');
    const es = new EventSource('/sessions/${esc(name)}/stream');
    es.onmessage = e => { pre.textContent = JSON.parse(e.data); pre.scrollTop = pre.scrollHeight; };
  </script>
</body>
</html>`;
}

function readBranchesByRepo(repos: string[]): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const repo of repos) {
    try {
      result[repo] = execFileSync(
        "git",
        ["-C", path.join(REPOS_DIR, repo), "branch", "--format=%(refname:short)"],
        { encoding: "utf8" },
      )
        .split("\n")
        .map((b) => b.trim())
        .filter((b) => b && !b.startsWith("session/"))
        .sort();
    } catch {
      result[repo] = ["main"];
    }
  }
  return result;
}

function renderPage(sessions: Session[], repos: string[]): string {
  const cards =
    sessions.length === 0
      ? `<p class="empty">No active sessions.</p>`
      : sessions
          .map((s) => {
            const devUrl = `http://${s.tailscaleIp}:${s.port}`;
            const bridgeId = findClaudeBridgeSessionId(s.worktreePath);
            const claudeUrl = bridgeId ? `https://claude.ai/code/${bridgeId}` : null;
            return `
        <div class="card">
          <div class="card-header">
            <strong>${esc(s.name)}</strong>
            <span class="tag">${esc(s.repo)}</span>
            <span class="tag">${esc(s.branch)}</span>
          </div>
          <div class="row"><span>Dev server</span><a href="${esc(devUrl)}" target="_blank">${esc(devUrl)}</a></div>
          ${claudeUrl ? `<div class="row"><span>Claude</span><a href="${esc(claudeUrl)}" target="_blank">Open session ↗</a></div>` : ""}
          <div class="row"><span>Logs</span><a href="/sessions/${esc(s.name)}">View dev server logs ↗</a></div>
          <div class="row"><span>Running</span><span>${formatElapsed(s.startedAt)}</span></div>
          <div class="row"><span>tmux</span><code>${esc(s.tmuxSession)}</code></div>
          <form method="POST" action="/stop">
            <input type="hidden" name="name" value="${esc(s.name)}">
            <button class="btn-stop">Stop session</button>
          </form>
        </div>`;
          })
          .join("\n");

  const branchesByRepo = readBranchesByRepo(repos);
  const firstRepo = repos[0] ?? "";

  const repoOpts = repos
    .map((r) => `<option value="${esc(r)}">${esc(r)}</option>`)
    .join("\n");

  const branchOpts = repos
    .flatMap((r) =>
      (branchesByRepo[r] ?? ["main"]).map(
        (b) =>
          `<option value="${esc(b)}" data-repo="${esc(r)}"${b === "main" && r === firstRepo ? " selected" : ""}>${esc(b)}</option>`,
      ),
    )
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dev Sessions</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #0f1117; --surface: #1a1d27; --border: #2d3148;
      --accent: #6c63ff; --stop: #e05050; --text: #e2e8f0; --muted: #8892a4;
      --r: 10px; --font: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    body { background: var(--bg); color: var(--text); font-family: var(--font);
           padding: 16px; max-width: 480px; margin: 0 auto; }
    h1 { font-size: 1rem; font-weight: 600; color: var(--muted);
         letter-spacing: .05em; text-transform: uppercase; }
    .sub { font-size: .8rem; color: var(--muted); margin-bottom: 20px; }
    .label { font-size: .7rem; font-weight: 600; color: var(--muted);
             text-transform: uppercase; letter-spacing: .08em; margin-bottom: 10px; }
    .empty { color: var(--muted); font-size: .875rem; margin-bottom: 20px; }
    .card { background: var(--surface); border: 1px solid var(--border);
            border-radius: var(--r); padding: 14px; margin-bottom: 12px; }
    .card-header { display: flex; justify-content: space-between; align-items: center;
                   margin-bottom: 10px; }
    .card-header strong { font-size: 1rem; }
    .tag { font-size: .72rem; color: var(--muted); background: var(--bg);
           padding: 2px 8px; border-radius: 20px; border: 1px solid var(--border); }
    .row { display: flex; justify-content: space-between; align-items: center;
           font-size: .8rem; color: var(--muted); margin-bottom: 6px; }
    .row a { color: var(--accent); text-decoration: none; font-size: .8rem; }
    .row a:hover { text-decoration: underline; }
    code { font-size: .72rem; background: var(--bg); padding: 2px 6px;
           border-radius: 4px; border: 1px solid var(--border); color: var(--text); }
    .btn-stop { width: 100%; margin-top: 12px; padding: 10px; background: transparent;
                border: 1px solid var(--stop); color: var(--stop); border-radius: var(--r);
                font-size: .875rem; cursor: pointer; }
    .btn-stop:active { background: var(--stop); color: #fff; }
    hr { border: none; border-top: 1px solid var(--border); margin: 20px 0; }
    .form { background: var(--surface); border: 1px solid var(--border);
            border-radius: var(--r); padding: 14px; }
    .field { margin-bottom: 12px; }
    label { display: block; font-size: .72rem; color: var(--muted);
            text-transform: uppercase; letter-spacing: .06em; margin-bottom: 5px; }
    input, select { width: 100%; padding: 10px 12px; background: var(--bg);
                    border: 1px solid var(--border); border-radius: 8px;
                    color: var(--text); font-size: .95rem; appearance: none; }
    input:focus, select:focus { outline: none; border-color: var(--accent); }
    .hint { font-size: .7rem; color: var(--muted); margin-top: 4px; }
    .btn-start { width: 100%; padding: 12px; background: var(--accent); border: none;
                 border-radius: var(--r); color: #fff; font-size: 1rem;
                 font-weight: 600; cursor: pointer; }
    .btn-start:active { opacity: .8; }
  </style>
</head>
<body>
  <h1>Dev Sessions</h1>
  <p class="sub">${esc(TAILSCALE_IP)}:${PORT}</p>

  <p class="label">Active (${sessions.length})</p>
  ${cards}

  <hr>

  <p class="label">New Session</p>
  <form method="POST" action="/start" class="form">
    <div class="field">
      <label for="name">Session name</label>
      <input type="text" id="name" name="name" placeholder="e.g. fix-search"
             pattern="[a-z0-9-]+" autocomplete="off" autocapitalize="none"
             spellcheck="false" required>
      <p class="hint">lowercase letters, numbers, hyphens</p>
    </div>
    <div class="field">
      <label for="repo">Repository</label>
      <select id="repo" name="repo" onchange="filterBranches(this.value)">${repoOpts}</select>
    </div>
    <div class="field">
      <label for="branch">Base branch</label>
      <select id="branch" name="branch">${branchOpts}</select>
    </div>
    <div class="field">
      <label for="port">Port</label>
      <input type="text" id="port" name="port" value="4321"
             pattern="[0-9]+" inputmode="numeric">
      <p class="hint">auto-increments if in use</p>
    </div>
    <button type="submit" class="btn-start">Start session</button>
  </form>
  <script>
    function filterBranches(repo) {
      const sel = document.getElementById('branch');
      for (const opt of sel.options) opt.hidden = opt.dataset.repo !== repo;
      const first = [...sel.options].find(o => !o.hidden);
      if (first) sel.value = first.value;
    }
    filterBranches(document.getElementById('repo').value);
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "GET" && url.pathname === "/") {
    const html = renderPage(readSessions(), listRepos());
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  if (req.method === "POST" && url.pathname === "/start") {
    const body = await parseBody(req);
    const name = (body.name ?? "").trim();
    const repo = (body.repo ?? "").trim();
    const branch = (body.branch ?? "main").trim();
    const port = (body.port ?? "4321").trim();

    if (!/^[a-z0-9-]+$/.test(name) || !/^[a-z0-9_-]+$/.test(repo)) {
      res.writeHead(302, { Location: "/" });
      res.end();
      return;
    }

    execFile(
      `${SCRIPTS_DIR}/start-session.sh`,
      [name, repo, branch, port],
      { env: { ...process.env } },
      (err, _stdout, stderr) => {
        if (err) console.error(`[start] ${name}:`, stderr || err.message);
        else console.log(`[start] Session '${name}' started on port ${port}`);
      },
    );

    await new Promise((r) => setTimeout(r, 1500));
    res.writeHead(302, { Location: "/" });
    res.end();
    return;
  }

  if (req.method === "POST" && url.pathname === "/stop") {
    const body = await parseBody(req);
    const name = (body.name ?? "").trim();

    if (name) {
      execFile(
        `${SCRIPTS_DIR}/stop-session.sh`,
        [name],
        { env: { ...process.env } },
        (err, _stdout, stderr) => {
          if (err) console.error(`[stop] ${name}:`, stderr || err.message);
          else console.log(`[stop] Session '${name}' stopped.`);
        },
      );
      await new Promise((r) => setTimeout(r, 800));
    }

    res.writeHead(302, { Location: "/" });
    res.end();
    return;
  }

  const logsMatch = url.pathname.match(/^\/sessions\/([a-z0-9-]+)$/);
  if (req.method === "GET" && logsMatch) {
    const name = logsMatch[1];
    const sessionFile = path.join(SESSIONS_DIR, `${name}.json`);
    if (!fs.existsSync(sessionFile)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Session not found");
      return;
    }
    const session = JSON.parse(fs.readFileSync(sessionFile, "utf8")) as Session;
    const initial = tmuxCapture(session.tmuxSession);
    const html = renderLogsPage(name, session.tmuxSession, initial);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  const streamMatch = url.pathname.match(/^\/sessions\/([a-z0-9-]+)\/stream$/);
  if (req.method === "GET" && streamMatch) {
    const name = streamMatch[1];
    const sessionFile = path.join(SESSIONS_DIR, `${name}.json`);
    if (!fs.existsSync(sessionFile)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Session not found");
      return;
    }
    const session = JSON.parse(fs.readFileSync(sessionFile, "utf8")) as Session;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const interval = setInterval(() => {
      const output = tmuxCapture(session.tmuxSession);
      res.write(`data: ${JSON.stringify(output)}\n\n`);
    }, 2000);
    req.on("close", () => clearInterval(interval));
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Session server: http://${TAILSCALE_IP}:${PORT}`);
});
