import { test } from "@playwright/test";
import http from "http";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import https from "https";
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });
const STATE_FILE = path.join(__dirname, "../position.json");

// Helper: Initialize or read local state tracking
function getLocalPosition(): { position: "NONE" | "LONG" | "SHORT" } {
    if (!fs.existsSync(STATE_FILE)) {
        fs.writeFileSync(STATE_FILE, JSON.stringify({ position: "NONE" }));
        return { position: "NONE" };
    }
    try {
        return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    } catch {
        return { position: "NONE" };
    }
}

function updateLocalPosition(newPosition: "NONE" | "LONG" | "SHORT") {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ position: newPosition }, null, 2));
    console.log(`💾 [STATE MATRIX]: Local position state updated to -> ${newPosition}`);
}

function fireBinanceOrder(symbol: string, side: "BUY" | "SELL", quantity: number) {
    const apiKey = process.env.BINANCE_API_KEY || "MOCK_KEY";
    const secretKey = process.env.BINANCE_SECRET_KEY || "MOCK_SECRET";
    const baseUrl = "testnet.binance.vision";
    
    const timestamp = Date.now() - 1000;
    const recvWindow = 60000;
    
    const queryString = `symbol=${symbol}&side=${side}&type=MARKET&quantity=${quantity}&recvWindow=${recvWindow}&timestamp=${timestamp}`;
    const signature = crypto.createHmac("sha256", secretKey).update(queryString).digest("hex");
    
    console.log(`\n🛡️ [BINANCE ENGINE] Dispatching Insulated Market Order (${side})...`);
    
    const options = {
        hostname: baseUrl,
        path: `/api/v3/order?${queryString}&signature=${signature}`,
        method: "POST",
        headers: {
            "X-MBX-APIKEY": apiKey,
            "Content-Type": "application/x-www-form-urlencoded"
        }
    };

    const req = https.request(options, (res) => {
        let body = "";
        res.on("data", (chunk) => body += chunk);
        res.on("end", () => {
            console.log(`00000000 [EXCHANGE RESPONSE (${res.statusCode})]: ${body}`);
        });
    });
    req.on("error", (e) => console.error("❌ Net Error: " + e.message));
    req.end();
}

test("ShadowChart AI -> Visual Analysis Trading Loop", async ({ page }) => {
    test.setTimeout(180000);
    
    // Read active tracking states
    const currentState = getLocalPosition();
    console.log(`\n🔍 [PRE-FLIGHT STATE]: Active market exposure status: ${currentState.position}`);

    await page.route((url) => {
        const target = url.toString().toLowerCase();
        return target.includes("font") || target.endsWith(".woff") || target.endsWith(".woff2");
    }, (route) => route.abort());
    
    const server = http.createServer((req, res) => {
        fs.readFile(path.join(__dirname, "../chart-buffer.html"), (err, data) => {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(data || "<html></html>");
        });
    });
    server.listen(8080, "127.0.0.1");

    console.log("\n=================== INITIALIZING PERFECTED VISUAL ENGINE RUN ===================");
    
    // Token Optimization: Downscale viewport size layout slightly to drop resolution footprint
    await page.setViewportSize({ width: 1152, height: 648 });
    await page.goto("http://127.0.0.1:8080?symbol=BTCUSDT", { waitUntil: "commit" });
    
    console.log("⏳ Allowing chart canvas layouts to populate frames...");
    await page.waitForTimeout(15000);

    const screenshotPath = path.join(__dirname, "chart-capture.jpg");
    
    console.log("📸 Ripping highly-compressed raw surface buffer via CDP Session...");
    const cdpSession = await page.context().newCDPSession(page);
    
    // Token Optimization: Quality dropped to 65 to reduce payload size while keeping vectors perfectly legible
    const { data } = await cdpSession.send("Page.captureScreenshot", {
        format: "jpeg",
        quality: 65
    });
    
    fs.writeFileSync(screenshotPath, Buffer.from(data, "base64"));
    console.log("📸 Compact frame saved to disk: " + screenshotPath);

    const imageBuffer = fs.readFileSync(screenshotPath);
    const base64Image = imageBuffer.toString("base64");

    // Vision Prompt Engineering Matrix
    const technicalPrompt = `You are an elite quantitative technical analysis system. Analyze this multi-timeframe chart.
Top Panel: 4-Hour Macro Trend. Bottom Panel: 1-Hour Execution Window.

Strictly execute your logic using this evaluation framework:
1. TREND ALIGNMENT: Check the relationship of the price candles relative to the Moving Averages.
2. MOMENTUM INDICATORS: Evaluate the RSI patterns. Identify any hidden bullish or bearish divergence across the panels.
3. CANDLESTICK STRUCTURE: Look for exhaustive patterns at key support or resistance zones (e.g., engulfing, hammers, pin bars).

Cross-examine these findings against our current state criteria:
Current Market Position State: ${currentState.position}

Trading Rules:
- If current position is 'NONE' and technicals confirm strong upside entry, output action: "BUY".
- If current position is 'LONG' and technicals show bearish exhaustion, resistance rejection, or profit targets hit, output action: "SELL" (to clear the long position).
- If current position is 'LONG' and trend is still healthy up, output action: "HOLD".
- If setup is choppy, unclear, or conflicting across timeframes, output action: "HOLD".

Output your evaluation strictly inside a single minified JSON object matching this schema:
{"action": "BUY" | "SELL" | "HOLD", "reason": "Concise, metrics-focused rationalized summary sentence"}
Do not wrap your output in markdown code blocks (\`\`\`). Output pure raw JSON text only.`;

    let decisionStr = "";
    try {
        console.log("🧠 Dispatching image to Gemini 2.0 Flash for optimized visual analysis...");
        let response = await ai.models.generateContent({
            model: "gemini-2.0-flash",
            contents: [{ inlineData: { data: base64Image, mimeType: "image/jpeg" } }, technicalPrompt],
            config: { responseMimeType: "application/json" }
        });
        decisionStr = response.text;
    } catch (error: any) {
        if (error.message && error.message.includes("429")) {
            console.warn("\n⚠️ Rate Limit encountered. Engaging 30s cooldown retrier...");
            await page.waitForTimeout(30000);
            try {
                let response = await ai.models.generateContent({
                    model: "gemini-2.0-flash",
                    contents: [{ inlineData: { data: base64Image, mimeType: "image/jpeg" } }, technicalPrompt],
                    config: { responseMimeType: "application/json" }
                });
                decisionStr = response.text;
            } catch (retryError: any) {
                console.error("❌ Retry capacity exhausted: " + retryError.message);
            }
        } else {
            console.error("❌ Processing block fault: " + error.message);
        }
    }

    // State Execution Processing Phase
    if (decisionStr) {
        try {
            console.log("\n📊 [AI ANALYSIS CRITERIA MATRIX]: " + decisionStr);
            const decision = JSON.parse(decisionStr.trim());

            if (decision.action === "BUY" && currentState.position === "NONE") {
                fireBinanceOrder("BTCUSDT", "BUY", 0.005);
                updateLocalPosition("LONG");
            } else if (decision.action === "SELL" && currentState.position === "LONG") {
                fireBinanceOrder("BTCUSDT", "SELL", 0.005);
                updateLocalPosition("NONE");
            } else {
                console.log(`⏸️ Order criteria skipped. AI recommended [${decision.action}] but State status is [${currentState.position}]. No order fired.`);
            }
        } catch (jsonErr) {
            console.warn("⚠️ JSON syntax parsing anomaly. Halting loop to prevent capital exposure.");
        }
    } else {
        console.warn("\n⚠️ Engine vision channels offline. Position guarded.");
    }
    
    await page.waitForTimeout(5000);
    server.close();
});
