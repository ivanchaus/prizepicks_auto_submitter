import { app, BrowserWindow, ipcMain } from "electron";
import path from "path";
import fs from "fs-extra";
import { chromium } from "playwright";
import { v4 as uuidv4 } from "uuid";
import { fileURLToPath } from "url";
// import chromeLauncher from "chrome-launcher"; // FIXED import (no *)
import * as chromeLauncher from "chrome-launcher";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SESSIONS_DIR = path.join(process.cwd(), "sessions");
fs.ensureDirSync(SESSIONS_DIR);

const sessions = {}; // { sessionId -> { browser, page, sessionPath, ready } }

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1350,
    height: 1020,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

/* ==========================================================
   Detect Installed Chrome
========================================================== */
async function getChromeExecutable() {
  try {
    const installations = await chromeLauncher.getInstallations();
    if (installations.length > 0) {
      console.log("🟢 Chrome detected:", installations[0]);
      return installations[0];
    }
    console.warn("⚠️ Chrome not found, using Playwright Chromium.");
    return undefined;
  } catch (err) {
    console.warn("Chrome detection failed, fallback to bundled Chromium");
    return undefined;
  }
}

/* ==========================================================
   Start Session
========================================================== */
ipcMain.handle("start-session", async () => {
  const sessionId = uuidv4();

  // 👉 use real Chrome profile instead of sandbox session
  const sessionPath = "/Users/ivachau/Library/Application Support/Google/Chrome/Default";
  sessions[sessionId] = { browser: null, page: null, sessionPath, ready: false };

  try {
    const browser = await chromium.launchPersistentContext(sessionPath, {
      headless: false,
      executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      args: [
        "--disable-blink-features=AutomationControlled",
        "--disable-infobars",
        "--no-first-run",
        "--no-default-browser-check",
        "--start-maximized",
        "--no-sandbox",
      ],
      timeout: 120000
    });

    const page = await browser.newPage();
    sessions[sessionId].browser = browser;
    sessions[sessionId].page = page;
    sessions[sessionId].ready = true;

    await page.goto("https://app.prizepicks.com", { waitUntil: "networkidle" });

    return { sessionId };
  } catch (err) {
    return { error: err.message };
  }
});

/* ==========================================================
   Check Session Status
========================================================== */
ipcMain.handle("session-status", (event, sessionId) => {
  const exists = Boolean(sessions[sessionId]);
  const ready = exists && sessions[sessionId].ready;
  return { exists, ready };
});

/* ==========================================================
   Submit Entries
========================================================== */
ipcMain.handle("submit-entries", async (event, { sessionId, selectedLinks, amount }) => {
  console.log("📩 Submit request:", { sessionId, selectedLinks, amount });
  console.log("📦 Session lookup:", sessions[sessionId]);

  if (!sessions[sessionId]) return { error: "❌ No session found" };
  if (!sessions[sessionId].ready) return { error: "❌ Session exists but not ready" };

  const { page, browser, sessionPath } = sessions[sessionId];
  const results = [];

  for (const link of selectedLinks) {
    try {
      console.log("➡️ Processing link:", link);

      await page.goto(link.trim(), { waitUntil: "networkidle" });
      await page.waitForTimeout(1000);

      /* ========= SELECT POWER PLAY FIRST ========= */
      const pp = await page.$('button:has-text("Power Play")');
      const flex = await page.$('button:has-text("Flex")');

      if (pp) {
        console.log("💥 Power Play selected");
        await pp.click({ delay: 120 });
      } else if (flex) {
        console.log("⚠️ Only Flex found → clicking Power equivalent");
        await flex.click({ delay: 120 });
      }

      await page.waitForTimeout(400);

      /* ========= ENTER WAGER AMOUNT ========= */
      if (amount) {
        const input = await page.$('input[type="number"]');
        if (input) {
          console.log("💰 Setting wager:", amount);
          await input.click({ clickCount: 3 });
          await input.fill(String(amount));
          await page.waitForTimeout(300);
        }
      }

      /* ========= FINAL SUBMIT ========= */
      await page.waitForSelector('button:has-text("Submit"), button:has-text("Place Entry")', {
        timeout: 10000,
      });

      await page.click('button:has-text("Submit"), button:has-text("Place Entry")', {
        delay: 200,
      });

      console.log("📤 Entry submitted:", link);
      results.push({ link, status: "submitted" });

      await page.waitForTimeout(1200);
    } catch (err) {
      console.error("❌ Submit failed:", err);
      results.push({ link, status: "failed", error: err.message });
    }
  }

  try {
    await browser.storageState({ path: path.join(sessionPath, "storageState.json") });
  } catch (err) {
    console.warn("⚠️ Failed to save browser state:", err.message);
  }

  return results;
});

/* ==========================================================
   Close Session
========================================================== */
ipcMain.handle("close-session", async (event, sessionId) => {
  if (!sessions[sessionId]) return { error: "Invalid session" };
  try {
    await sessions[sessionId].browser.close();
    delete sessions[sessionId];
    console.log("🛑 Session closed:", sessionId);
    return { closed: true };
  } catch (err) {
    console.error("❌ Close failed:", err);
    return { error: err.message };
  }
});
