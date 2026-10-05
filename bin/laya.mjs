#!/usr/bin/env node

import { spawn, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PKG_ROOT = path.resolve(__dirname, "..");
const DAEMON_DIR = path.join(PKG_ROOT, "daemon");

const PORT = process.env.LAYA_PORT || "4141";
const BASE_URL = `http://127.0.0.1:${PORT}`;
const USER_CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "laya-router.json");

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
};

async function checkHealth(timeoutMs = 1200) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${BASE_URL}/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, status: res.status };
    const data = await res.json();
    return { ok: true, data };
  } catch {
    return { ok: false };
  }
}

function getDaemonPid() {
  try {
    const out = execSync(`lsof -ti:${PORT}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const pids = out.trim().split("\n").filter(Boolean);
    return pids.length > 0 ? pids[0] : null;
  } catch {
    return null;
  }
}

async function cmdStatus() {
  console.log(`\n${c.bold}⚡ Laya Local Router Status${c.reset}`);
  console.log(`${c.dim}Endpoint: ${BASE_URL}${c.reset}\n`);

  const pid = getDaemonPid();
  const health = await checkHealth();

  if (health.ok) {
    console.log(`  State:      ${c.green}● RUNNING${c.reset} ${pid ? `(PID: ${pid})` : ""}`);
    console.log(`  Model:      ${c.cyan}${health.data?.model || "default"}${c.reset}`);
    console.log(`  Engine:     ${health.data?.engine || "laya-mlx"}`);
    
    if (health.data?.anchors_count) {
      console.log(`\n  ${c.bold}Active Anchor Exemplars:${c.reset}`);
      for (const [cat, count] of Object.entries(health.data.anchors_count)) {
        console.log(`    • ${cat.padEnd(22)} : ${c.yellow}${count}${c.reset} exemplars`);
      }
    }
  } else {
    console.log(`  State:      ${c.red}○ STOPPED${c.reset}`);
    console.log(`  ${c.dim}Run 'laya start' to launch daemon.${c.reset}`);
  }

  // Config check
  console.log(`\n  ${c.bold}Pi Extension Config:${c.reset}`);
  if (fs.existsSync(USER_CONFIG_PATH)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
      console.log(`    • File:     ${USER_CONFIG_PATH}`);
      console.log(`    • Enabled:  ${cfg.enabled ? `${c.green}YES${c.reset}` : `${c.yellow}NO${c.reset}`}`);
      console.log(`    • Threshold: ${cfg.threshold ?? 0.25}`);
      console.log(`    • Routes:   ${Object.keys(cfg.routes || {}).join(", ")}`);
    } catch {
      console.log(`    • Status:   ${c.red}Invalid JSON in ${USER_CONFIG_PATH}${c.reset}`);
    }
  } else {
    console.log(`    • Status:   ${c.dim}Not configured yet. Run 'laya init'${c.reset}`);
  }
  console.log();
}

async function cmdStart() {
  const health = await checkHealth(500);
  if (health.ok) {
    console.log(`${c.yellow}[Laya] Daemon is already running on port ${PORT}.${c.reset}`);
    return;
  }

  console.log(`${c.cyan}[Laya] Starting daemon on port ${PORT}...${c.reset}`);

  let runCmd = "uv";
  let runArgs = ["run", "server.py"];

  // Fallback to python3 if uv is not installed
  try {
    execSync("which uv", { stdio: "ignore" });
  } catch {
    runCmd = "python3";
    runArgs = ["server.py"];
  }

  const logFile = path.join(DAEMON_DIR, "server.log");
  const outStream = fs.openSync(logFile, "a");
  const errStream = fs.openSync(logFile, "a");

  const child = spawn(runCmd, runArgs, {
    cwd: DAEMON_DIR,
    detached: true,
    stdio: ["ignore", outStream, errStream],
    env: { ...process.env, LAYA_PORT: PORT },
  });

  child.unref();

  process.stdout.write(`Waiting for model load (${runCmd})... `);
  for (let i = 0; i < 35; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const h = await checkHealth(800);
    if (h.ok) {
      console.log(`${c.green}Ready!${c.reset}`);
      console.log(`${c.dim}Logs written to: ${logFile}${c.reset}`);
      return;
    }
    process.stdout.write(".");
  }

  console.log(`\n${c.red}[Laya] Timeout waiting for daemon startup. Check ${logFile}${c.reset}`);
  process.exit(1);
}

async function cmdStop() {
  const pid = getDaemonPid();
  if (!pid) {
    console.log(`${c.yellow}[Laya] No running daemon found on port ${PORT}.${c.reset}`);
    return;
  }

  console.log(`${c.cyan}[Laya] Stopping daemon (PID: ${pid})...${c.reset}`);
  try {
    process.kill(Number(pid), "SIGTERM");
  } catch {
    try {
      execSync(`kill -9 ${pid}`, { stdio: "ignore" });
    } catch {}
  }

  await new Promise((r) => setTimeout(r, 1000));
  const pidAfter = getDaemonPid();
  if (pidAfter) {
    try {
      execSync(`kill -9 ${pidAfter}`, { stdio: "ignore" });
    } catch {}
  }

  console.log(`${c.green}[Laya] Daemon stopped successfully.${c.reset}`);
}

async function cmdReload() {
  console.log(`${c.cyan}[Laya] Reloading anchor embeddings...${c.reset}`);
  try {
    const res = await fetch(`${BASE_URL}/reload-anchors`, { method: "POST" });
    if (!res.ok) {
      console.error(`${c.red}[Laya] Failed to reload anchors (HTTP ${res.status})${c.reset}`);
      return;
    }
    const data = await res.json();
    console.log(`${c.green}✓ Anchors reloaded in ${data.reloaded_ms}ms!${c.reset}`);
    if (data.counts) {
      for (const [cat, count] of Object.entries(data.counts)) {
        console.log(`  • ${cat.padEnd(22)}: ${count} exemplars`);
      }
    }
  } catch (err) {
    console.error(`${c.red}[Laya] Error connecting to daemon: ${err.message}${c.reset}`);
  }
}

async function cmdLogs(limit = 15) {
  try {
    const res = await fetch(`${BASE_URL}/logs?limit=${limit}`);
    if (!res.ok) {
      console.error(`${c.red}[Laya] Failed to fetch logs (HTTP ${res.status})${c.reset}`);
      return;
    }
    const data = await res.json();
    if (!data.logs || data.logs.length === 0) {
      console.log(`${c.dim}[Laya] No prediction logs recorded yet.${c.reset}`);
      return;
    }

    console.log(`\n${c.bold}⚡ Recent Laya Prediction Logs (Latest ${data.logs.length}):${c.reset}\n`);
    for (const item of data.logs) {
      const timeStr = item.timestamp?.split("T")[1]?.slice(0, 8) || "";
      const conf = Math.round((item.confidence || 0) * 100);
      const prompt = item.prompt?.length > 45 ? item.prompt.slice(0, 42) + "..." : item.prompt;
      console.log(
        `  ${c.dim}[${timeStr}]${c.reset} ${c.green}${item.choice?.padEnd(20)}${c.reset} (${conf}% conf) [${item.latency_ms}ms] <- "${prompt}"`
      );
    }
    console.log();
  } catch (err) {
    console.error(`${c.red}[Laya] Error fetching logs: ${err.message}${c.reset}`);
  }
}

async function cmdFlag(cat, prompt) {
  if (!cat || !prompt) {
    console.log(`Usage: laya flag <category> <prompt text>`);
    console.log(`Categories: CHAT_OR_TRIVIAL, RESEARCH_AND_EXPLORE, CODING_STANDARD, CODE_REVIEW, HARD_ARCHITECTURE`);
    return;
  }

  try {
    const res = await fetch(`${BASE_URL}/corrections`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, target: cat }),
    });
    if (!res.ok) {
      console.error(`${c.red}[Laya] Failed to record correction (HTTP ${res.status})${c.reset}`);
      return;
    }
    console.log(`${c.green}✓ Flagged prompt saved to corrections.jsonl → ${cat}${c.reset}`);
    console.log(`Run '/skill:laya-tune' inside Pi to optimize anchors.`);
  } catch (err) {
    console.error(`${c.red}[Laya] Error recording correction: ${err.message}${c.reset}`);
  }
}

function cmdInit() {
  const targetDir = path.dirname(USER_CONFIG_PATH);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  if (fs.existsSync(USER_CONFIG_PATH)) {
    console.log(`${c.yellow}[Laya] Config already exists at: ${USER_CONFIG_PATH}${c.reset}`);
    return;
  }

  const sampleConfig = {
    enabled: true,
    endpoint: "http://127.0.0.1:4141/predict",
    threshold: 0.25,
    routes: {
      CHAT_OR_TRIVIAL: {
        provider: "anthropic",
        model: "claude-haiku-4-5",
        thinking: "off",
        description: "General casual chat, short responses, simple confirmations, trivial queries",
      },
      RESEARCH_AND_EXPLORE: {
        provider: "anthropic",
        model: "claude-haiku-4-5",
        thinking: "low",
        description: "File search, code exploration, grep lookups, error investigations, planning",
      },
      CODING_STANDARD: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        thinking: "low",
        description: "Standard coding tasks, bug fixes, feature implementation, refactoring, unit tests",
      },
      CODE_REVIEW: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        thinking: "medium",
        description: "Code reviews, diff analysis, security audits, pre-push checks",
      },
      HARD_ARCHITECTURE: {
        provider: "anthropic",
        model: "claude-opus-4-6",
        thinking: "high",
        description: "Complex system architecture, tricky debugging, hard distributed systems problems",
      },
    },
  };

  fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(sampleConfig, null, 2), "utf8");
  console.log(`${c.green}✓ Created default config at: ${USER_CONFIG_PATH}${c.reset}`);
}

function printHelp() {
  console.log(`
${c.bold}⚡ Laya MLX CLI${c.reset} — Local semantic router for Pi coding agent

${c.bold}USAGE:${c.reset}
  laya <command> [options]

${c.bold}COMMANDS:${c.reset}
  ${c.cyan}status${c.reset}              Check daemon health, model, active anchors, and config
  ${c.cyan}start${c.reset}               Start the Laya daemon in background on port ${PORT}
  ${c.cyan}stop${c.reset}                Stop the running Laya daemon
  ${c.cyan}restart${c.reset}             Restart the Laya daemon
  ${c.cyan}reload${c.reset}              Hot-reload anchors.json embeddings without restart
  ${c.cyan}logs${c.reset} [-n <limit>]   Display recent semantic prediction logs
  ${c.cyan}flag${c.reset} <cat> <text>   Record a misclassification correction for tuning
  ${c.cyan}init${c.reset}                Create default ~/.pi/agent/laya-router.json config
  ${c.cyan}help${c.reset}                Show this help message

${c.bold}ENVIRONMENT VARIABLES:${c.reset}
  LAYA_PORT           Port for Laya daemon (default: 4141)
  LAYA_MODEL          Hugging Face model ID (default: aac6fef/laya-multilingual-mlx)
`);
}

const [,, cmd, ...args] = process.argv;

switch (cmd) {
  case "status":
    await cmdStatus();
    break;
  case "start":
    await cmdStart();
    break;
  case "stop":
    await cmdStop();
    break;
  case "restart":
    await cmdStop();
    await cmdStart();
    break;
  case "reload":
    await cmdReload();
    break;
  case "logs":
  case "log": {
    const limitIdx = args.indexOf("-n");
    const limit = limitIdx !== -1 && args[limitIdx + 1] ? Number(args[limitIdx + 1]) : 15;
    await cmdLogs(limit);
    break;
  }
  case "flag":
  case "correct":
    await cmdFlag(args[0], args.slice(1).join(" "));
    break;
  case "init":
    cmdInit();
    break;
  case "help":
  case "--help":
  case "-h":
  case undefined:
    printHelp();
    break;
  default:
    console.error(`${c.red}Unknown command: ${cmd}${c.reset}`);
    printHelp();
    process.exit(1);
}
