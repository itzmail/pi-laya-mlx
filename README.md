# pi-laya-mlx ⚡

> **Fast, local semantic router & model optimizer for Pi coding agent using Apple Silicon MLX.**

`pi-laya-mlx` classifies developer prompt intent locally in **sub-15ms** using dense multilingual sentence embeddings, then dynamically routes each prompt to the optimal model and thinking tier (e.g., lightweight models for simple chat/file exploration, high-reasoning frontier models for deep architecture and hard coding tasks).

---

## 💻 Hardware & Platform Support

| Platform | Hardware Target | Acceleration | Expected Latency |
|---|---|---|---|
| **macOS** | Apple Silicon (M1 / M2 / M3 / M4) | **Metal GPU Native (Zero-Copy)** | **~5–15 ms** |
| **Linux (x86_64 / ARM64 / Asahi)** | Generic CPU / Apple CPU | **CPU Fallback (`mlx[cpu]`)** | **~40–120 ms** |

> ⚠️ **Note on Linux / Asahi Linux:** Apple MLX hardware acceleration depends on Apple's proprietary Metal framework (macOS only). On Linux, it runs in **CPU-only mode**, which is functional but slower than macOS Metal execution.

---

## 📦 Installation

### 1. Install as Pi Package

Install directly from GitHub or npm:

```bash
# From Git repository:
pi install git:github.com/<your-username>/pi-laya-mlx

# Or from npm:
pi install npm:pi-laya-mlx

# Or locally during development:
pi install ./pi-laya-mlx
```

### 2. Setup Daemon Environment

In the package `daemon` directory (or globally), install the Python dependencies:

```bash
cd daemon

# Recommended: using uv (ultra fast)
uv venv
uv pip install -r requirements.txt

# Or using standard pip:
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

---

## 🚀 CLI Usage (`laya`)

`pi-laya-mlx` includes a convenient CLI binary:

```bash
# Check daemon health, active model, and anchor counts
laya status

# Start daemon in background (port 4141)
laya start

# Stop the running daemon
laya stop

# Restart the daemon
laya restart

# Hot-reload anchor embeddings after editing anchors.json (<50ms)
laya reload

# View recent prediction logs & confidence scores
laya logs -n 20

# Record a misclassification flag for tuning
laya flag CODING_STANDARD "tolong implementasikan fungsi ini"

# Initialize default ~/.pi/agent/laya-router.json config
laya init
```

---

## ⚡ Pi Extension Commands & Shortcuts

Inside your Pi session:

- **Toggle router on/off**: `/laya` or press `Ctrl+Shift+J` / `Alt+J`
- **Check status**: `/laya status`
- **View prediction logs**: `/laya logs`
- **Flag misclassification**: `/laya flag [chat|coding|review|explore|arch]`
- **Tune anchors**: `/skill:laya-tune`

---

## ⚙️ Configuration (`~/.pi/agent/laya-router.json`)

```json
{
  "enabled": true,
  "endpoint": "http://127.0.0.1:4141/predict",
  "threshold": 0.25,
  "routes": {
    "CHAT_OR_TRIVIAL": {
      "provider": "anthropic",
      "model": "claude-haiku-4-5",
      "thinking": "off",
      "description": "General casual chat, short responses, confirmations, trivial queries"
    },
    "RESEARCH_AND_EXPLORE": {
      "provider": "anthropic",
      "model": "claude-haiku-4-5",
      "thinking": "low",
      "description": "File search, code exploration, grep lookups, error investigations"
    },
    "CODING_STANDARD": {
      "provider": "anthropic",
      "model": "claude-sonnet-4-6",
      "thinking": "low",
      "description": "Standard coding tasks, bug fixes, feature implementation, refactoring"
    },
    "CODE_REVIEW": {
      "provider": "anthropic",
      "model": "claude-sonnet-4-6",
      "thinking": "medium",
      "description": "Code reviews, diff analysis, security audits, pre-push checks"
    },
    "HARD_ARCHITECTURE": {
      "provider": "anthropic",
      "model": "claude-opus-4-6",
      "thinking": "high",
      "description": "Complex system architecture, tricky debugging, hard distributed systems"
    }
  }
}
```

---

## 🎯 Continuous Tuning

When Laya misclassifies a prompt:
1. Run `/laya flag <category>` (or `laya flag` in CLI) to log the prompt.
2. Run `/skill:laya-tune` in Pi. An isolated background agent will analyze the flagged entries, add new anchor exemplars to `anchors.json`, and hot-reload the daemon instantly via `/reload-anchors` without restarting the server.

---

## 📄 License

MIT
