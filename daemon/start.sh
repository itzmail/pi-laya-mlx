#!/bin/bash
# Start/stop/status/reload the Laya local decision daemon (port 4141).
# Usage: ./start.sh [start|stop|status|restart|reload]

DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${LAYA_PORT:-4141}"

is_running() {
  curl -s -m 1 -o /dev/null "http://127.0.0.1:$PORT/health" && return 0 || return 1
}

case "${1:-start}" in
  start)
    if is_running; then
      echo "Laya daemon already running on :$PORT"
      curl -s "http://127.0.0.1:$PORT/health"; echo
      exit 0
    fi
    cd "$DIR"
    if command -v uv >/dev/null 2>&1; then
      nohup uv run server.py > server.log 2>&1 &
    else
      nohup python3 server.py > server.log 2>&1 &
    fi
    echo "Laya daemon starting (pid $!)... waiting for model load"
    for _ in $(seq 1 35); do
      sleep 1
      if is_running; then
        echo "ready."
        curl -s "http://127.0.0.1:$PORT/health"; echo
        exit 0
      fi
    done
    echo "failed to start — check $DIR/server.log"
    exit 1
    ;;
  stop)
    pkill -f "daemon/server.py" 2>/dev/null
    sleep 1
    lsof -ti:"$PORT" | xargs kill -9 2>/dev/null
    echo "Laya daemon stopped."
    ;;
  status)
    if is_running; then
      echo "running:"
      curl -s "http://127.0.0.1:$PORT/health"; echo
    else
      echo "not running."
      exit 1
    fi
    ;;
  reload)
    if is_running; then
      curl -s -X POST "http://127.0.0.1:$PORT/reload-anchors"; echo
    else
      echo "Laya daemon is not running."
      exit 1
    fi
    ;;
  restart)
    "$0" stop; "$0" start
    ;;
  *)
    echo "Usage: $0 [start|stop|status|restart|reload]"
    exit 1
    ;;
esac
