import { test } from '@playwright/test';
import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import https from 'https';
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });
const STATE_FILE = path.join(__dirname, '../position.json');

function getLocalPosition() {
    const defaultState = { position: 'NONE', entryPrice: null, quantity: null };
    if (!fs.existsSync(STATE_FILE)) {
        fs.writeFileSync(STATE_FILE, JSON.stringify(defaultState));
        return defaultState;
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        return { ...defaultState, ...parsed }; // backfill missing fields from older state files
    } catch (e) {
        return defaultState;
    }
}

function updateLocalPosition(pos: string, entryPrice: number | null = null, quantity: number | null = null) {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ position: pos, entryPrice, quantity }, null, 2));
    console.log('STATE MATRIX: Position updated to -> ' + pos + (entryPrice ? ` @ ${entryPrice}` : ''));
}

function computeAvgFillPrice(fills: any[]): number | null {
    if (!Array.isArray(fills) || fills.length === 0) return null;
    let totalCost = 0;
    let totalQty = 0;
    for (const f of fills) {
        const price = parseFloat(f.price);
        const qty = parseFloat(f.qty);
        totalCost += price * qty;
        totalQty += qty;
    }
    return totalQty > 0 ? totalCost / totalQty : null;
}

function sendDiscordAlert(msg: string): Promise<void> {
    if (!process.env.DISCORD_WEBHOOK_URL) return Promise.resolve();
    return new Promise<void>((resolve) => {
        const req = https.request(process.env.DISCORD_WEBHOOK_URL as string, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        req.on('error', (err) => {
            console.error('ALERT AGENT: Discord webhook failed ->', err.message);
            resolve();
        });
        req.on('response', () => resolve());
        req.write(JSON.stringify({ content: msg }));
        req.end();
    });
}

function sendTelegramAlert(msg: string, withButtons: boolean = false): Promise<void> {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return Promise.resolve();
    return new Promise<void>((resolve) => {
        const payload: any = { chat_id: chatId, text: msg };
        if (withButtons) {
            payload.reply_markup = {
                inline_keyboard: [[
                    { text: '🟢 BUY', callback_data: 'BUY' },
                    { text: '🔴 SELL', callback_data: 'SELL' },
                    { text: '⚪ EXIT', callback_data: 'EXIT' }
                ]]
            };
        }
        const req = https.request(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        req.on('error', (err) => {
            console.error('ALERT AGENT: Telegram send failed ->', err.message);
            resolve();
        });
        req.on('response', (res) => {
            if (res.statusCode !== 200) {
                console.error('ALERT AGENT: Telegram responded with status', res.statusCode);
            }
            resolve();
        });
        req.write(JSON.stringify(payload));
        req.end();
    });
}

async function dispatchAlerts(msg: string, withTelegramButtons: boolean = false) {
    console.log('ALERT AGENT: Broadcasting signals...');
    // Fire both channels in parallel; one failing shouldn't block the other.
    await Promise.all([sendDiscordAlert(msg), sendTelegramAlert(msg, withTelegramButtons)]);
}

// Sends the actual chart screenshot (not just text) so you can see exactly
// what Gemini analyzed. Uses native fetch/FormData (Node 18+) for multipart upload.
async function sendTelegramPhoto(imagePath: string, caption: string, withButtons: boolean = false): Promise<void> {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;
    try {
        const form = new FormData();
        form.append('chat_id', chatId);
        form.append('caption', caption);
        if (withButtons) {
            form.append('reply_markup', JSON.stringify({
                inline_keyboard: [[
                    { text: '🟢 BUY', callback_data: 'BUY' },
                    { text: '🔴 SELL', callback_data: 'SELL' },
                    { text: '⚪ EXIT', callback_data: 'EXIT' }
                ]]
            }));
        }
        const fileBuffer = fs.readFileSync(imagePath);
        form.append('photo', new Blob([fileBuffer], { type: 'image/jpeg' }), 'chart-capture.jpg');

        const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', body: form });
        if (!res.ok) {
            console.error('ALERT AGENT: Telegram photo send failed, status', res.status, await res.text());
        }
    } catch (err: any) {
        console.error('ALERT AGENT: Telegram photo send error ->', err.message);
    }
}

async function sendDiscordPhoto(imagePath: string, caption: string): Promise<void> {
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl) return;
    try {
        const form = new FormData();
        form.append('payload_json', JSON.stringify({ content: caption }));
        const fileBuffer = fs.readFileSync(imagePath);
        form.append('files[0]', new Blob([fileBuffer], { type: 'image/jpeg' }), 'chart-capture.jpg');

        const res = await fetch(webhookUrl, { method: 'POST', body: form });
        if (!res.ok) {
            console.error('ALERT AGENT: Discord photo send failed, status', res.status, await res.text());
        }
    } catch (err: any) {
        console.error('ALERT AGENT: Discord photo send error ->', err.message);
    }
}

async function dispatchAlertsWithPhoto(imagePath: string, caption: string, withTelegramButtons: boolean = false) {
    console.log('ALERT AGENT: Broadcasting signals with chart preview...');
    await Promise.all([
        sendDiscordPhoto(imagePath, caption),
        sendTelegramPhoto(imagePath, caption, withTelegramButtons)
    ]);
}

/**
 * Places a market order and resolves ONLY once we know the real outcome.
 * Resolves { ok: true, filled: boolean, body } on a completed HTTP round trip,
 * rejects on network-level failure (no response at all).
 * Caller is responsible for deciding what to do with ok/filled — this function
 * never assumes success.
 */
function fireBinanceOrder(symbol: string, side: string, quantity: number): Promise<{ ok: boolean; filled: boolean; body: any }> {
    return new Promise((resolve, reject) => {
        const apiKey = process.env.BINANCE_API_KEY;
        const secretKey = process.env.BINANCE_SECRET_KEY;

        if (!apiKey || !secretKey) {
            return reject(new Error('BINANCE_API_KEY / BINANCE_SECRET_KEY not set — refusing to send a live order with mock credentials.'));
        }

        const timestamp = Date.now() - 1000;
        const query = 'symbol=' + symbol + '&side=' + side + '&type=MARKET&quantity=' + quantity + '&recvWindow=60000&timestamp=' + timestamp;
        const signature = crypto.createHmac('sha256', secretKey).update(query).digest('hex');
        const options = {
            hostname: 'testnet.binance.vision',
            path: '/api/v3/order?' + query + '&signature=' + signature,
            method: 'POST',
            headers: { 'X-MBX-APIKEY': apiKey, 'Content-Type': 'application/x-www-form-urlencoded' }
        };

        const req = https.request(options, res => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                console.log('EXCHANGE RESPONSE [' + res.statusCode + ']:', body);
                let parsed: any = null;
                try { parsed = JSON.parse(body); } catch (e) { /* leave null */ }

                const success = res.statusCode === 200 && !!parsed && !parsed.code; // Binance errors carry a numeric `code`
                const filled = success && Array.isArray(parsed?.fills) && parsed.fills.length > 0;

                if (success && filled) {
                    dispatchAlerts('ShadowChart AI filled: ' + side + ' ' + quantity + ' ' + symbol);
                } else if (!success) {
                    dispatchAlerts('ShadowChart AI ORDER FAILED: ' + side + ' ' + quantity + ' ' + symbol + ' -> ' + body);
                }

                resolve({ ok: success, filled, body: parsed ?? body });
            });
        });

        req.on('error', (err) => {
            console.error('EXCHANGE REQUEST ERROR:', err.message);
            reject(err);
        });

        req.end();
    });
}

test('ShadowChart AI -> Loop', async ({ page }) => {
    test.setTimeout(300000); // widened from 3min to 5min — retry logic on Gemini calls can now legitimately take longer
    const currentState = getLocalPosition();

    // NOTE: font-blocking removed — TradingView's widget loads its own webfonts
    // for price axis labels/watermark and can fail to render candles at all
    // if those requests are aborted. Re-add narrower blocking later only if
    // you confirm a specific non-essential font URL is safe to drop.

    // Spawn context loop proxy engine server
    const server = http.createServer((req, res) => {
        fs.readFile(path.join(__dirname, '../chart-buffer.html'), (err, data) => {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data || '<html></html>');
        });
    });
    server.listen(8080, '127.0.0.1');
    console.log('INITIALIZING VISUAL ENGINE RUN');

    // Surface what's actually happening inside the page — critical for diagnosing
    // why the TradingView widget might not be rendering (blocked CDN, JS errors, etc.)
    page.on('console', msg => console.log(`PAGE CONSOLE [${msg.type()}]:`, msg.text()));
    page.on('pageerror', err => console.error('PAGE ERROR:', err.message));
    page.on('requestfailed', req => console.error('REQUEST FAILED:', req.url(), req.failure()?.errorText));

    try {
        await page.setViewportSize({ width: 1920, height: 1080 });
        await page.goto('http://127.0.0.1:8080?symbol=BTCUSDT', { waitUntil: 'commit' });
        // TradingView's widget loads its script, then fetches chart data async (iframe + datafeed).
        // Wait for network activity to actually settle instead of guessing a fixed duration,
        // then add a short buffer for the final render frame to paint.
        try {
            await page.waitForLoadState('networkidle', { timeout: 40000 });
        } catch (e) {
            console.log('networkidle wait timed out — proceeding anyway, chart may still be loading.');
        }
        await page.waitForTimeout(5000);

        const shotPath = path.join(__dirname, 'chart-capture.jpg');
        const cdp = await page.context().newCDPSession(page);

        // A blank/loading-spinner frame compresses to a much smaller JPEG than a real
        // chart full of candles, colors, and indicator lines. Use that as a heuristic
        // to detect a not-yet-rendered chart and give it more time before giving up.
        let data: string = '';
        let capturedBuffer: Buffer = Buffer.alloc(0);
        const MIN_LIKELY_CHART_BYTES = 40000;
        const MAX_CAPTURE_ATTEMPTS = 4;

        for (let attempt = 1; attempt <= MAX_CAPTURE_ATTEMPTS; attempt++) {
            const shot = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 65 });
            data = shot.data;
            capturedBuffer = Buffer.from(data, 'base64');

            if (capturedBuffer.length >= MIN_LIKELY_CHART_BYTES) {
                console.log(`Screenshot capture looks like a real chart (${capturedBuffer.length} bytes, attempt ${attempt}).`);
                break;
            }
            console.log(`Screenshot capture attempt ${attempt}/${MAX_CAPTURE_ATTEMPTS} looks too small (${capturedBuffer.length} bytes) — likely still loading, waiting and retrying...`);
            if (attempt < MAX_CAPTURE_ATTEMPTS) {
                await page.waitForTimeout(10000);
            } else {
                console.log('Proceeding with the last capture despite it looking possibly incomplete — chart data may still be missing.');
            }
        }

        fs.writeFileSync(shotPath, capturedBuffer);

        if (!process.env.GEMINI_API_KEY) {
            throw new Error('GEMINI_API_KEY not set — aborting cycle.');
        }

        // Transient network drops (dropped sockets, brief outages) shouldn't burn
        // a whole 15-minute cycle. Retry a couple of times with backoff before giving up.
        async function generateWithRetry(maxAttempts = 3) {
            let lastErr: any;
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                try {
                    return await ai.models.generateContent({
                        model: 'gemini-2.5-flash',
                        contents: [
                            { inlineData: { data, mimeType: 'image/jpeg' } },
                            'Analyze this chart (4h and 1h panels shown). Output strictly inside a single minified JSON object matching this schema: {"action": "BUY" | "SELL" | "HOLD", "trend": "string - short/medium-term trend direction across both timeframes", "keyLevels": "string - nearest support/resistance levels visible", "indicators": "string - what RSI, moving averages, and volume are showing", "conclusion": "string - one or two sentences tying it together and justifying the action"}. Do not wrap in markdown.'
                        ],
                        config: { responseMimeType: 'application/json' }
                    });
                } catch (err: any) {
                    lastErr = err;
                    console.error(`Gemini call failed (attempt ${attempt}/${maxAttempts}):`, err.message);
                    if (attempt < maxAttempts) {
                        const delay = attempt * 5000; // 5s, then 10s
                        console.log(`Retrying in ${delay / 1000}s...`);
                        await new Promise(r => setTimeout(r, delay));
                    }
                }
            }
            throw lastErr;
        }

        const response = await generateWithRetry();

        let decision: { action: string; trend: string; keyLevels: string; indicators: string; conclusion: string };
        try {
            decision = JSON.parse(response.text.trim());
        } catch (e) {
            console.error('AI DECISION MATRIX: failed to parse response ->', response.text);
            return; // bail this cycle, don't touch position state
        }
        console.log('AI DECISION MATRIX:', decision);

        const emoji = decision.action === 'BUY' ? '🟢' : decision.action === 'SELL' ? '🔴' : '⚪';
        const caption =
            `${emoji} ShadowChart AI — ${decision.action}\n\n` +
            `📈 Trend: ${decision.trend}\n` +
            `📍 Key Levels: ${decision.keyLevels}\n` +
            `📊 Indicators: ${decision.indicators}\n\n` +
            `✅ Conclusion: ${decision.conclusion}`;

        // Persist so the Telegram listener's /panel command can show the latest
        // analysis alongside the control buttons, not just the raw position state.
        try {
            fs.writeFileSync(
                path.join(__dirname, '../last-analysis.json'),
                JSON.stringify({ ...decision, caption, timestamp: new Date().toISOString() }, null, 2)
            );
        } catch (e) {
            console.error('Failed to persist last-analysis.json:', (e as Error).message);
        }
        await dispatchAlertsWithPhoto(shotPath, caption, true);

        if (decision.action === 'BUY' && currentState.position === 'NONE') {
            try {
                const result = await fireBinanceOrder('BTCUSDT', 'BUY', 0.005);
                if (result.ok && result.filled) {
                    const avgPrice = computeAvgFillPrice(result.body?.fills);
                    updateLocalPosition('LONG', avgPrice, 0.005);
                } else {
                    console.log('BUY order did not confirm a fill — position state left unchanged.', result.body);
                }
            } catch (err: any) {
                console.error('BUY order request failed, position state left unchanged ->', err.message);
            }
        } else if (decision.action === 'SELL' && currentState.position === 'LONG') {
            try {
                const result = await fireBinanceOrder('BTCUSDT', 'SELL', 0.005);
                if (result.ok && result.filled) {
                    updateLocalPosition('NONE', null, null);
                } else {
                    console.log('SELL order did not confirm a fill — position state left unchanged.', result.body);
                }
            } catch (err: any) {
                console.error('SELL order request failed, position state left unchanged ->', err.message);
            }
        } else {
            console.log('Order criteria skipped. No alignment adjustments made.');
        }
    } catch (err: any) {
        console.error('Processing error:', err.message);
        if (err.cause) {
            console.error('Processing error cause:', err.cause);
        }
    } finally {
        // Always release the port and give in-flight alert requests a moment to finish,
        // regardless of where the cycle failed.
        await page.waitForTimeout(5000);
        server.close();
    }
});
