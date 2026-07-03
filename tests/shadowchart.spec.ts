import { test } from "@playwright/test";
import { chromium } from "playwright-extra";
import stealthPlugin from "puppeteer-extra-plugin-stealth";
import { GoogleGenAI } from "@google/genai";
import * as fsMod from "fs";
import * as path from "path";
import axios from "axios";
import http from "http";

chromium.use(stealthPlugin());

function fileToGenerativePart(path, mimeType) { 
  return { inlineData: { data: fsMod.readFileSync(path).toString("base64"), mimeType } };
}

async function dispatchWebhook(reportText) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return;
  try {
    await axios.post(webhookUrl, {
      content: "📊 **NEW QUANT MODEL EXECUTION REPORT GENERATED**",
      embeds: [{
        title: "⚡ SHADOWCHART-AI RUN COMPLETED",
        description: reportText,
        color: 0x131722
      }]
    });
    console.log("📡 [Webhook] Live institutional alert dispatched successfully!");
  } catch (err) {
    console.error("❌ [Webhook] Dispatch operational failure:", err.message);
  }
}

function logToHistoricalDatabase(reportText) {
  const logDir = "./history";
  const logPath = path.join(logDir, "logs.json");
  if (!fsMod.existsSync(logDir)) fsMod.mkdirSync(logDir);
  const currentLogs = fsMod.existsSync(logPath) ? JSON.parse(fsMod.readFileSync(logPath, "utf-8")) : [];
  currentLogs.push({ timestamp: new Date().toISOString(), evaluation: reportText });
  fsMod.writeFileSync(logPath, JSON.stringify(currentLogs, null, 2));
  console.log("💾 [Database] Structural log snapshot committed to history/logs.json");
}

test("ShadowChart AI -> Production MultiModal Loop", async () => {
  test.setTimeout(240000); 
  if (!process.env.GEMINI_API_KEY) throw new Error("Missing GEMINI_API_KEY");

  const server = http.createServer((req, res) => {
    try {
      const targetPath = path.resolve("chart-buffer.html");
      if (fsMod.existsSync(targetPath)) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(fsMod.readFileSync(targetPath));
      } else {
        res.writeHead(404);
        res.end("Buffer file missing");
      }
    } catch (e) {
      res.writeHead(500);
      res.end();
    }
  });

  server.listen(8080, "127.0.0.1");

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }); 
  const browser = await chromium.launch({ 
    headless: true,
    args: [
      "--no-sandbox", 
      "--disable-setuid-sandbox", 
      "--disable-web-security",
      "--disable-gpu",
      "--use-gl=swiftshader",
      "--disable-software-rasterizer",
      "--disable-font-subpixel-positioning"
    ] 
  });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  const chartPath = "market-analysis-chart.png";

  try {
    console.log("🚀 [1/4] Spawning internal HTTP server and charting engine...");
    await page.goto("http://127.0.0.1:8080", { waitUntil: "commit", timeout: 60000 });

    console.log("⏳ [2/4] Syncing layout elements and stabilizing chart widgets...");
    await page.waitForTimeout(30000);

    console.log("📸 [3/4] Capturing pristine technical layout surface...");
    // Upgraded timeout safety parameter here explicitly
    await page.screenshot({ path: chartPath, timeout: 45000 });

    console.log("🧠 [4/4] Sending payload to Gemini for evaluation...");
    const imgPart = fileToGenerativePart(chartPath, "image/png");
    
    const prompt = `Act as an elite Managing Director of Quantitative Trading and Multi-Strategy Macro Research. Analyze the provided chart screenshot with absolute mathematical and structural rigidity. Strip away all retail fluff. Output the evaluation using the exact schema defined below. Do not add intro or wrap-up chit-chat.

## 📊 MARKET STRUCTURAL DATA & DELTA METRICS
| Metric | Real-Time Technical Value / Observation |
| :--- | :--- |
| **Asset / Ticker Pair** | [Extract Ticker from screen data] |
| **Current Print Price** | [Extract exact current price visible on screen] |
| **Volume Point of Control (POC)** | [Extract horizontal peak volume tier value] |
| **Delta POC & Structural Walls** | [Identify price range showcasing dominant aggressive absorption or high imbalance] |
| **CVD Momentum Bias** | [Evaluate if Cumulative Volume Delta indicates aggressive buying dominance or selling fatigue] |
| **RSI Momentum Phase** | [State exact numeric value and matrix quadrant] |

---

## ⚡ RIGID EXECUTABLE TRADING BANDS
* **Trigger Event:** High-volume breakout verification.
* **Optimal Execution Entry:** Target Zone.
* **Stop-Loss Invalidation Line:** Critical Invalidations.
* **Mathematical Risk-Reward Ratio (R:R):** Calculated Value.`;
    
    const res = await ai.models.generateContent({ model: "gemini-2.5-flash", contents: [prompt, imgPart] });
    const outputText = res.text;
    
    console.log("\n\n==================== REPORT ====================\n" + outputText + "\n========================================\n");
    
    logToHistoricalDatabase(outputText);
    await dispatchWebhook(outputText);

  } catch (err) { 
    console.error("❌ Operational Failure:", err); 
  } finally { 
    await browser.close();
    server.close();
  }
});