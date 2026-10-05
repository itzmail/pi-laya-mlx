import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { Key } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

interface RouteConfig {
  provider: string;
  model: string;
  thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  description: string;
  /** Focused yes/no question for this route; enables the more reliable noul probe mode. */
  noul?: string;
}

interface RouterSettings {
  enabled: boolean;
  endpoint?: string;
  /** Minimum confidence (0-1) required before switching models. Below this, keep current model. */
  threshold?: number;
  /** Use per-route yes/no probes instead of a single choice question (default true when all routes define `noul`). */
  noul_mode?: boolean;
  routes: Record<string, RouteConfig>;
}

const CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "laya-router.json");

function loadConfig(): RouterSettings | null {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return null;
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export default function (pi: ExtensionAPI) {
  let lastPrompt: string | undefined;
  let lastPredictedCategory: string | undefined;

  const toggleLaya = (ctx: ExtensionContext | ExtensionCommandContext, forceState?: boolean) => {
    const config = loadConfig();
    if (!config) {
      if (ctx.hasUI) ctx.ui.notify("Config file not found at ~/.pi/agent/laya-router.json. Run 'laya init' in terminal.", "error");
      return;
    }

    config.enabled = forceState !== undefined ? forceState : !config.enabled;
    try {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
    } catch (err: any) {
      if (ctx.hasUI) ctx.ui.notify(`Failed to save config: ${err.message}`, "error");
      return;
    }

    const stateLabel = config.enabled ? "ENABLED" : "DISABLED";
    if (ctx.hasUI) {
      ctx.ui.notify(`⚡ Laya auto-router is now ${stateLabel}`, "info");
    }
    pi.events.emit("laya:toggle", { enabled: config.enabled });
  };

  const handleCommand = async (args: string | undefined, ctx: ExtensionCommandContext) => {
    const config = loadConfig();
    if (!config) {
      ctx.ui.notify("Config file not found at ~/.pi/agent/laya-router.json. Run 'laya init' in terminal.", "error");
      return;
    }

    const trimmed = args?.trim().toLowerCase();
    if (trimmed === "on") {
      toggleLaya(ctx, true);
      return;
    }
    if (trimmed === "off") {
      toggleLaya(ctx, false);
      return;
    }
    if (!trimmed || trimmed === "toggle") {
      toggleLaya(ctx);
      return;
    }

    if (trimmed === "status" || trimmed === "list") {
      const status = config.enabled ? "ENABLED" : "DISABLED";
      const endpoint = config.endpoint || "http://127.0.0.1:4141/predict";

      // Check daemon health
      let daemon = "unknown";
      try {
        const healthUrl = new URL(endpoint);
        healthUrl.pathname = "/health";
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 800);
        const res = await fetch(healthUrl.toString(), { signal: controller.signal });
        clearTimeout(t);
        daemon = res.ok ? "running" : `error ${res.status}`;
      } catch {
        daemon = "not running";
      }

      const routesList = Object.entries(config.routes)
        .map(([key, val]) => `• ${key}: ${val.provider}/${val.model} (thinking: ${val.thinking})`)
        .join("\n");

      ctx.ui.notify(
        `[Laya Auto-Router: ${status}]\nDaemon: ${daemon} (${endpoint})\nThreshold: ${config.threshold ?? 0.25}\n\n${routesList}\n\nToggle: /laya (or Ctrl+Shift+J / Alt+J)\nRecent logs: /laya logs`,
        "info"
      );
      return;
    }

    if (trimmed?.startsWith("log")) {
      const endpoint = config.endpoint || "http://127.0.0.1:4141/predict";
      try {
        const logsUrl = new URL(endpoint);
        logsUrl.pathname = "/logs";
        logsUrl.searchParams.set("limit", "10");
        const res = await fetch(logsUrl.toString());
        if (!res.ok) {
          ctx.ui.notify(`[Laya] Failed to fetch logs (${res.status})`, "error");
          return;
        }
        const data = await res.json() as { logs: Array<{ timestamp: string; prompt: string; choice: string; confidence: number; latency_ms: number }> };
        if (!data.logs || data.logs.length === 0) {
          ctx.ui.notify("[Laya] No prediction logs recorded yet.", "info");
          return;
        }
        const logLines = data.logs.map((item) => {
          const timeStr = item.timestamp.split("T")[1]?.slice(0, 8) || "";
          const conf = Math.round((item.confidence || 0) * 100);
          const p = item.prompt.length > 35 ? item.prompt.slice(0, 32) + "..." : item.prompt;
          return `[${timeStr}] ${item.choice} (${conf}%) [${item.latency_ms}ms] <- "${p}"`;
        }).join("\n");

        ctx.ui.notify(`[Laya Recent Logs]\n${logLines}`, "info");
      } catch (err: any) {
        ctx.ui.notify(`[Laya] Error fetching logs: ${err.message}`, "error");
      }
      return;
    }

    if (trimmed?.startsWith("flag") || trimmed?.startsWith("correct")) {
      const parts = trimmed.split(/\s+/);
      const targetInput = parts[1]?.toLowerCase();
      if (!lastPrompt) {
        ctx.ui.notify("[Laya] No recent prompt recorded to flag.", "warning");
        return;
      }
      const catMap: Record<string, string> = {
        chat: "CHAT_OR_TRIVIAL",
        trivial: "CHAT_OR_TRIVIAL",
        review: "CODE_REVIEW",
        code_review: "CODE_REVIEW",
        coding: "CODING_STANDARD",
        code: "CODING_STANDARD",
        explore: "RESEARCH_AND_EXPLORE",
        research: "RESEARCH_AND_EXPLORE",
        arch: "HARD_ARCHITECTURE",
        architecture: "HARD_ARCHITECTURE",
      };
      const targetCat = catMap[targetInput] || Object.keys(config.routes).find((k) => k.toLowerCase() === targetInput);
      if (!targetCat) {
        ctx.ui.notify(
          `Usage: /laya flag [chat|review|coding|explore|arch]\nLast prompt: "${lastPrompt.slice(0, 50)}" (was: ${lastPredictedCategory || "unknown"})`,
          "warning"
        );
        return;
      }

      const endpoint = config.endpoint || "http://127.0.0.1:4141/predict";
      const corrUrl = new URL(endpoint);
      corrUrl.pathname = "/corrections";
      try {
        await fetch(corrUrl.toString(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: lastPrompt,
            target: targetCat,
            was: lastPredictedCategory,
          }),
        });
        ctx.ui.notify(
          `⚡ [Laya] Flagged: "${lastPrompt.slice(0, 45)}" → ${targetCat}\nSaved to corrections.jsonl. Run /skill:laya-tune to optimize anchors.`,
          "info"
        );
      } catch (err: any) {
        ctx.ui.notify(`[Laya] Error saving flag: ${err.message}`, "error");
      }
      return;
    }

    ctx.ui.notify("Usage: /laya [on|off|toggle|status|logs|flag <cat>] or press Ctrl+Shift+J / Alt+J", "warning");
  };

  pi.registerCommand("laya-router", {
    description: "Inspect or toggle Laya local model routing",
    handler: handleCommand,
  });

  pi.registerCommand("laya", {
    description: "Toggle or inspect Laya local model routing",
    handler: handleCommand,
  });

  pi.registerShortcut(Key.ctrlShift("j"), {
    description: "Toggle Laya auto-router ON/OFF",
    handler: async (ctx) => {
      toggleLaya(ctx);
    },
  });

  pi.registerShortcut(Key.alt("j"), {
    description: "Toggle Laya auto-router ON/OFF",
    handler: async (ctx) => {
      toggleLaya(ctx);
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const config = loadConfig();
    if (!config || !config.enabled) return;

    let promptText = event.prompt?.trim();
    if (!promptText || promptText.length < 3) return;

    // Fast path: skip slash commands
    if (promptText.startsWith("/")) return;

    // Strip injected XML blocks (<memory>...</memory>, <context>...</context>, etc.)
    promptText = promptText.replace(/<[a-zA-Z0-9_-]+[\s\S]*?<\/[a-zA-Z0-9_-]+>/gi, "").replace(/<[^>]+>/g, "").trim();
    if (!promptText || promptText.length < 3) return;

    const routeKeys = Object.keys(config.routes);
    if (routeKeys.length === 0) return;

    const criteria: Record<string, string> = {};
    const noulProbes: Record<string, string> = {};
    for (const [key, val] of Object.entries(config.routes)) {
      criteria[key] = val.description;
      if (val.noul) noulProbes[key] = val.noul;
    }
    const useNoul = config.noul_mode !== false && Object.keys(noulProbes).length === Object.keys(config.routes).length;

    const stateSnippet = promptText.length > 400 ? promptText.slice(0, 400) : promptText;
    lastPrompt = stateSnippet;

    const payload = {
      state: stateSnippet,
      questions: {
        task_category: {
          type: "choice",
          instructions: "Classify the developer's intent into the single most appropriate task category.",
          criteria,
          ...(useNoul ? { noul: noulProbes } : {}),
        },
      },
    };

    if (ctx.hasUI && ctx.ui.setStatus) {
      ctx.ui.setStatus("laya-router", "⚡ [Laya] Classifying intent...");
    }

    try {
      const endpoint = config.endpoint || "http://127.0.0.1:4141/predict";
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1500);

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeout);
      if (ctx.hasUI && ctx.ui.setStatus) {
        ctx.ui.setStatus("laya-router", undefined);
      }

      if (!res.ok) {
        throw new Error(`daemon status ${res.status}`);
      }

      const data = await res.json() as any;
      const taskAnswer = data?.answers?.task_category;
      const selectedCategory = taskAnswer?.choice || taskAnswer?.value;
      lastPredictedCategory = selectedCategory;
      const probabilities: Record<string, number> | undefined = taskAnswer?.probabilities;
      const confidence = taskAnswer?.confidence ?? (probabilities ? probabilities[selectedCategory] : undefined);
      const confPercent = confidence !== undefined ? ` (${Math.round(confidence * 100)}%)` : "";

      if (!selectedCategory || !config.routes[selectedCategory]) return;

      const threshold = config.threshold ?? 0.25;
      const topProb = confidence ?? (probabilities ? Math.max(...Object.values(probabilities)) : 1);

      const targetCategory = topProb >= threshold ? selectedCategory : "CHAT_OR_TRIVIAL";
      const targetRoute = config.routes[targetCategory];
      if (!targetRoute) return;

      const targetModel = ctx.modelRegistry.find(targetRoute.provider, targetRoute.model);
      if (!targetModel) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            `⚡ [Laya] Model not found in registry: ${targetRoute.provider}/${targetRoute.model}`,
            "warning"
          );
        }
        return;
      }

      const currentModel = ctx.model || (pi as any).activeModel;
      const isSame = currentModel && currentModel.id === targetRoute.model && currentModel.provider === targetRoute.provider;

      const effectiveThinking = targetRoute.thinking
        ? clampThinkingLevel(targetModel, targetRoute.thinking)
        : pi.getThinkingLevel();

      const switchNote = topProb >= threshold
        ? `${targetCategory}${confPercent}`
        : `CHAT_OR_TRIVIAL (fallback from ${selectedCategory} ${Math.round(topProb * 100)}%)`;

      if (!isSame) {
        const switched = await pi.setModel(targetModel);
        if (switched) {
          if (effectiveThinking) {
            pi.setThinkingLevel(effectiveThinking);
          }
          const thinkingNote = targetRoute.thinking !== effectiveThinking
            ? `${effectiveThinking} (clamped from ${targetRoute.thinking})`
            : effectiveThinking;
          if (ctx.hasUI) {
            ctx.ui.notify(
              `⚡ [Laya] Switched → ${switchNote} [${targetRoute.provider}/${targetRoute.model} | thinking: ${thinkingNote}]`,
              "info"
            );
          }
        }
      } else {
        const currentThinking = pi.getThinkingLevel();
        if (effectiveThinking && currentThinking !== effectiveThinking) {
          pi.setThinkingLevel(effectiveThinking);
        }
        if (ctx.hasUI && topProb >= threshold) {
          ctx.ui.notify(
            `⚡ [Laya] Kept ${selectedCategory}${confPercent} [${targetRoute.model} | thinking: ${effectiveThinking}]`,
            "info"
          );
        }
      }
    } catch (layaErr: any) {
      if (ctx.hasUI && ctx.ui.setStatus) {
        ctx.ui.setStatus("laya-router", undefined);
      }

      // Fallback to Jev Cloud Router if configured
      const apiKey = process.env.TYPESAFE_API_KEY;
      if (apiKey) {
        try {
          if (ctx.hasUI && ctx.ui.setStatus) {
            ctx.ui.setStatus("laya-router", "⚡ [Jev Fallback] Classifying...");
          }

          const jevEndpoint = (config as any).jev_endpoint || "https://api.typesafe.ai/v1/systemone";
          const jevController = new AbortController();
          const jevTimeout = setTimeout(() => jevController.abort(), 2000);

          const jevRes = await fetch(jevEndpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model: (config as any).jev_model || "jev-latest",
              state: stateSnippet,
              questions: {
                task_category: {
                  type: "choice",
                  instructions: "Classify the developer's intent into the single most appropriate task category.",
                  criteria,
                },
              },
            }),
            signal: jevController.signal,
          });

          clearTimeout(jevTimeout);
          if (ctx.hasUI && ctx.ui.setStatus) {
            ctx.ui.setStatus("laya-router", undefined);
          }

          if (jevRes.ok) {
            const jevData = await jevRes.json() as any;
            const taskAnswer = jevData?.answers?.task_category;
            const selectedCategory = taskAnswer?.choice || taskAnswer?.value;
            lastPredictedCategory = selectedCategory;

            if (selectedCategory && config.routes[selectedCategory]) {
              const targetRoute = config.routes[selectedCategory];
              const targetModel = ctx.modelRegistry.find(targetRoute.provider, targetRoute.model);
              if (targetModel) {
                const currentModel = ctx.model || (pi as any).activeModel;
                const isSame = currentModel && currentModel.id === targetRoute.model && currentModel.provider === targetRoute.provider;
                const effectiveThinking = targetRoute.thinking
                  ? clampThinkingLevel(targetModel, targetRoute.thinking)
                  : pi.getThinkingLevel();

                if (!isSame) {
                  const switched = await pi.setModel(targetModel);
                  if (switched) {
                    if (effectiveThinking) pi.setThinkingLevel(effectiveThinking);
                    if (ctx.hasUI) {
                      ctx.ui.notify(
                        `⚡ [Jev Fallback] Switched → ${selectedCategory} [${targetRoute.provider}/${targetRoute.model}]`,
                        "info"
                      );
                    }
                  }
                }
              }
            }
            return;
          }
        } catch {}
      }

      if (ctx.hasUI && !apiKey) {
        ctx.ui.notify(
          "⚡ [Router] Laya daemon offline. Run 'laya start' in terminal or check 'laya status'.",
          "warning"
        );
      }
    }
  });
}
