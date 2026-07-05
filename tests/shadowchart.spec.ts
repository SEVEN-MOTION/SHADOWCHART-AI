import { test } from "@playwright/test";
import http from "http";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import https from "https";
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

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
            console.log(`📡 [EXCHANGE RESPONSE (${res.statusCode})]: ${body}`);
        });
    });
    req.on("error", (e) => console.error("❌ Net Error: " + e.message));
    req.end();
}

test("ShadowChart AI -> Visual Analysis Trading Loop", async ({ page }) => {
    test.setTimeout(180000); // Expanded timeout to accommodate rate-limit cooldown retries
    
    // Narrow font filtering to keep local server traffic completely pure
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

    console.log("\n=================== INITIALIZING VISUAL ENGINE RUN ===================");
    
    // Downscaled viewport slightly to optimize token footprint while keeping full chart crispness
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("http://127.0.0.1:8080?symbol=BTCUSDT", { waitUntil: "commit" });
    
    console.log("⏳ Allowing chart canvas layouts to populate frames...");
    await page.waitForTimeout(15000);

    const screenshotPath = path.join(__dirname, "chart-capture.jpg");
    
    console.log("📸 Ripping raw hardware frame buffer via CDP Session...");
    const cdpSession = await page.context().newCDPSession(page);
    const { data } = await cdpSession.send("Page.captureScreenshot", {
        format: "jpeg",
        quality: 80
    });
    
    fs.writeFileSync(screenshotPath, Buffer.from(data, "base64"));
    console.log("📸 Frame saved to disk: " + screenshotPath);

    const imageBuffer = fs.readFileSync(screenshotPath);
    const base64Image = imageBuffer.toString("base64");

    const promptText = "Analyze this split technical chart (Top: 4H, Bottom: 1H). Look closely at the candles, moving averages, and RSI indicators. Determine whether a clear BUY or SELL action is warranted. You must output your decision strictly in JSON format matching this exact schema: {\"action\": \"BUY\" | \"SELL\" | \"HOLD\", \"reason\": \"your explanation here\"}";

    let decisionStr = "";
    try {
        console.log("🧠 Dispatching image to Gemini 2.0 Flash for market evaluation...");
        let response = await ai.models.generateContent({
            model: "gemini-2.0-flash",
            contents: [{ inlineData: { data: base64Image, mimeType: "image/jpeg" } }, promptText],
            config: { responseMimeType: "application/json" }
        });
        decisionStr = response.text;
    } catch (error: any) {
        if (error.message && error.message.includes("429")) {
            console.warn("\n⚠️ Hit Gemini Free-Tier Rate Limit. Initiating 30s pipeline cooldown loop...");
            await page.waitForTimeout(30000);
            
            try {
                console.log("🔄 Retrying Gemini market evaluation...");
                let response = await ai.models.generateContent({
                    model: "gemini-2.0-flash",
                    contents: [{ inlineData: { data: base64Image, mimeType: "image/jpeg" } }, promptText],
                    config: { responseMimeType: "application/json" }
                });
                decisionStr = response.text;
            } catch (retryError: any) {
                console.error("❌ Cooldown retry exhausted: " + retryError.message);
            }
        } else {
            console.error("❌ Visual processing exception: " + error.message);
        }
    }

    // Processing Phase
    if (decisionStr) {
        try {
            console.log("\n📊 [AI DECISION RECEIVED]: " + decisionStr);
            const decision = JSON.parse(decisionStr.trim());

            if (decision.action === "BUY" || decision.action === "SELL") {
                fireBinanceOrder("BTCUSDT", decision.action, 0.005);
            } else {
                console.log("⏸️ Market criteria not met. Position set to HOLD.");
            }
        } catch (jsonErr) {
            console.warn("⚠️ Output parsing failed, running insulation default execution.");
            fireBinanceOrder("BTCUSDT", "BUY", 0.005);
        }
    } else {
        console.warn("\n⚠️ API unavailable or blocked. Executing insulated asset hedge trade...");
        fireBinanceOrder("BTCUSDT", "BUY", 0.005);
    }
    
    await page.waitForTimeout(5000);
    server.close();
});
