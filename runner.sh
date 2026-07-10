#!/bin/bash
echo "🚀 Booting ShadowChart AI Daemon Engine Loop..."
if [ -f "./.env.sh" ]; then
    echo "🔑 Loading environment from .env.sh..."
    source ./.env.sh
else
    echo "⚠️  .env.sh not found — relying on already-exported env vars in this shell."
fi
# --- setup ---
LOG_DIR="./logs"
mkdir -p "$LOG_DIR"

XVFB_PID=""
LISTENER_PID=""

cleanup() {
    echo "🛑 Shutting down daemon..."
    if [ -n "$XVFB_PID" ] && kill -0 "$XVFB_PID" 2>/dev/null; then
        kill "$XVFB_PID" 2>/dev/null
    fi
    if [ -n "$LISTENER_PID" ] && kill -0 "$LISTENER_PID" 2>/dev/null; then
        kill "$LISTENER_PID" 2>/dev/null
    fi
    # Catch any stray child processes (e.g. a stuck playwright run) spawned by this shell
    kill $(jobs -p) 2>/dev/null
    exit 0
}
trap cleanup SIGINT SIGTERM

# Check if Xvfb is already running, if not, start it cleanly
if ! pgrep -x "Xvfb" > /dev/null; then
    echo "Starting virtual display framebuffer..."
    Xvfb :99 -screen 0 1280x1024x24 -nolisten tcp &
    XVFB_PID=$!
    sleep 2
fi
export DISPLAY=:99

# Forward local active environment session variables straight down into workers
export GEMINI_API_KEY="${GEMINI_API_KEY}"
export BINANCE_API_KEY="${BINANCE_API_KEY}"
export BINANCE_SECRET_KEY="${BINANCE_SECRET_KEY}"
export DISCORD_WEBHOOK_URL="${DISCORD_WEBHOOK_URL}"
export TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN}"
export TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID}"

# Start the persistent Telegram listener for manual BUY/SELL/EXIT button control.
# Runs independently of the cycle loop below — it's always listening, even
# while a chart-analysis cycle is mid-run.
node telegram-listener.js >> "$LOG_DIR/telegram-listener.log" 2>&1 &
LISTENER_PID=$!
echo "📡 Telegram listener started (PID $LISTENER_PID)"

while true; do
    CYCLE_LOG="$LOG_DIR/shadowchart-$(date +%F).log"
    echo "⏰ [$(date)] Commencing cycle..." | tee -a "$CYCLE_LOG"

    # Watchdog: kill the test run if it hangs past 320s so a stuck cycle
    # can't stall the loop indefinitely. Set slightly above the test's own
    # 300s internal timeout so legitimate retries aren't killed prematurely.
    timeout 320s npx playwright test tests/shadowchart.spec.ts >> "$CYCLE_LOG" 2>&1
    EXIT_CODE=$?

    if [ $EXIT_CODE -eq 124 ]; then
        echo "⚠️  [$(date)] Cycle TIMED OUT and was killed by watchdog." | tee -a "$CYCLE_LOG"
    elif [ $EXIT_CODE -ne 0 ]; then
        echo "❌ [$(date)] Cycle FAILED with exit code $EXIT_CODE." | tee -a "$CYCLE_LOG"
    else
        echo "✅ [$(date)] Cycle completed successfully." | tee -a "$CYCLE_LOG"
    fi

    echo "💤 Sleeping for 30 minutes..." | tee -a "$CYCLE_LOG"
    sleep 1800
done
