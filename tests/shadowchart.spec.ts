import { test } from "@playwright/test";
import { chromium } from "playwright-extra";
import stealthPlugin from "puppeteer-extra-plugin-stealth";
import { GoogleGenAI } from "@google/genai";
import * as fsMod from "fs";
import * as path from "path";

chromium.use(stealthPlugin());

function fileToGenerativePart(path, mimeType) { 
  return { inlineData: { data: fsMod.readFileSync(path).toString("base64"), mimeType } };
}

test("ShadowChart AI -> Production MultiModal Loop", async () => {
  test.setTimeout(120000);
  if (!process.env.GEMINI_API_KEY) throw new Error("Missing GEMINI_API_KEY");

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }); 
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  const chartPath = "market-analysis-chart.png";

  try {
    const localUrl = "file://" + path.resolve("chart-buffer.html");
    
    console.log("🚀 [1/4] Spawning isolated internal charting engine...");
    await page.goto(localUrl, { waitUntil: "networkidle", timeout: 45000 });

    console.log("⏳ [2/4] Syncing cross-origin content frames and elements...");
    const chartFrameElement = await page.waitForSelector("iframe[id^=\"tradingview_\"]", { timeout: 20000 });
    const frame = await chartFrameElement.contentFrame();
    if (!frame) throw new Error("Failed to capture core rendering context frame.");

    await frame.waitForSelector("canvas", { timeout: 25000 });
    console.log("🟢 Canvas structure confirmed active.");

    await page.waitForTimeout(10000);

    console.log("📸 [3/4] Capturing pristine technical layout...");
    await page.screenshot({ path: chartPath, timeout: 15000, animations: "disabled" });

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
| **Micro Demand Floor (Support)**| [Primary defensive technical level] |
| **Macro Supply Ceiling (Resistance)**| [Primary overhead structural blocker] |

---

## ⚡ RIGID EXECUTABLE TRADING BANDS

### 🟢 SETUP A: THE HIGH-CONVICTION BREAKOUT COMPRESSION PLAY
*   **Tactical Philosophy:** Momentum-driven continuation capturing institutional order flow above the structural range ceiling.
*   **Trigger Event:** A definitive close above macro resistance validated by positive Delta POC expansion.
*   **Optimal Execution Entry:** Price target immediately following confirmation.
*   **Stop-Loss Invalidation Line:** Set exactly below the breakout block or structural swing low.
*   **Take-Profit Targets:** 
    *   **T1 (Scalp Target):** First historical liquidity pocket.
    *   **T2 (Macro Extension):** Major structural swing high.
*   **Mathematical Risk-Reward Ratio (R:R):** [Explicitly calculate ratio based on entry/SL/T1]

### 🔵 SETUP B: THE CONSERVATIVE MEAN-REVERSION PULLBACK PLAY
*   **Tactical Philosophy:** Exploiting retail stop-hunts to accumulate long exposure at institutional order blocks.
*   **Trigger Event:** Price retraces to test the micro demand floor followed by immediate aggressive bid absorption.
*   **Optimal Execution Entry:** Target zone within the upper layer of the support block.
*   **Stop-Loss Invalidation Line:** Decisive invalidation if price prints below the structural floor.
*   **Take-Profit Targets:**
    *   **T1 (Range Equilibrium):** Local mid-range point.
    *   **T2 (Range Ceiling):** Re-test of the overhead macro resistance line.
*   **Mathematical Risk-Reward Ratio (R:R):** [Explicitly calculate ratio based on entry/SL/T2]

---

## 🔬 CANDLESTICK & VOLUME LAYER CONFIRMATION
> **Order Flow Context:** [Provide a highly technical, 2-sentence breakdown analyzing the exact visual relationship between the latest 3-5 candlesticks, volume profiles, and net imbalance indicators. Identify if there is buying absorption, volume divergence, or systemic selling exhaustion.]

---

## 🎯 QUANTITATIVE CONFLUENCE SCORE
$$\\text{Confluence Score} = \\mathbf{[Insert\\,Score\\,1-10]}$$
*   **Institutional Weighting:** [Provide a single, razor-sharp sentence explaining the specific confluence match between Price Structure, Delta metrics, and RSI profiles.]`;
    
    const res = await ai.models.generateContent({ model: "gemini-2.5-flash", contents: [prompt, imgPart] });
    console.log("\n\n==================== REPORT ====================\n" + res.text + "\n========================================\n");
  } catch (err) { 
    console.error("❌ Operational Failure:", err); 
  } finally { 
    await browser.close(); 
  }
});