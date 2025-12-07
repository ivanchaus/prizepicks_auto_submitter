import { app, BrowserWindow, ipcMain } from "electron";
import path from "path";
import fs from "fs-extra";
import { chromium } from "playwright";
import { v4 as uuidv4 } from "uuid";
import { fileURLToPath } from "url";
import * as chromeLauncher from "chrome-launcher";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SESSIONS_DIR = path.join(process.cwd(), "sessions");
fs.ensureDirSync(SESSIONS_DIR);

const sessions = {}; // sessionId -> { browser, page, sessionPath, ready }

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 950,
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

// Utility: detect installed Chrome
async function getChromeExecutable() {
  try {
    const installations = await chromeLauncher.Launcher.getInstallations();
    if (installations.length > 0) {
      console.log("Found Chrome:", installations[0]);
      return installations[0];
    } else {
      console.warn("No Chrome installation found, using Playwright bundled Chromium.");
      return undefined; // Playwright will fallback to its Chromium
    }
  } catch (err) {
    console.error("Chrome detection failed:", err);
    return undefined;
  }
}

/* ---------- IPC: Start new session ---------- */
ipcMain.handle("start-session", async () => {
  const sessionId = uuidv4();
  const sessionPath = path.join(SESSIONS_DIR, sessionId);
  fs.ensureDirSync(sessionPath);
  sessions[sessionId] = { browser: null, page: null, sessionPath, ready: false };

  try {
    const chromePath = await getChromeExecutable();

    const browser = await chromium.launchPersistentContext(sessionPath, {
      headless: false,
      executablePath: chromePath, // auto-detected or undefined
      args: [
        "--disable-blink-features=AutomationControlled",
        "--start-maximized",
        "--no-sandbox"
      ],
      timeout: 120000
    });

    const page = await browser.newPage();
    sessions[sessionId].browser = browser;
    sessions[sessionId].page = page;
    sessions[sessionId].ready = true;

    await page.goto("https://app.prizepicks.com/login", { waitUntil: "domcontentloaded" });

    return { sessionId };
  } catch (err) {
    console.error("Failed to start session:", err);
    return { error: err.message };
  }
});

/* ---------- IPC: Session status ---------- */
ipcMain.handle("session-status", (event, sessionId) => {
  if (!sessions[sessionId]) return { ready: false };
  return { ready: sessions[sessionId].ready };
});

/* ---------- IPC: Get entries ---------- */
ipcMain.handle("get-entries", async () => [
  "https://app.prizepicks.com/board?projections=8376792-u-15.5,8360786-u-12.5,8368048-o-12.5&wager_id=action",
  "https://app.prizepicks.com/board?projections=8376792-u-15.5,8368048-o-12.5&wager_id=action",
]);

/* ---------- IPC: Submit selected entries ---------- */
ipcMain.handle("submit-entries", async (event, { sessionId, selectedLinks, amount }) => {
  if (!sessions[sessionId] || !sessions[sessionId].ready)
    return { error: "Invalid or not ready session" };

  const { page, sessionPath, browser } = sessions[sessionId];
  const results = [];

  for (const link of selectedLinks) {
    try {
      await page.goto(link, { waitUntil: "networkidle" });
      await page.waitForTimeout(800 + Math.random() * 500);

      // Click first "Place Entry" / "Submit" button
      await page.waitForSelector('button:has-text("Place Entry"), button:has-text("Submit")', { timeout: 10000 });
      await page.click('button:has-text("Place Entry"), button:has-text("Submit")', { delay: 120 });

      // Set wager amount if numeric input exists
      const input = await page.$('input[type="number"]');
      if (input && amount) {
        await input.click({ clickCount: 3 });
        await input.fill(String(amount));
        await page.waitForTimeout(400);
      }

      // Select Power Play option if available
      const powerPlayBtn = await page.$('button:has-text("Power Play")');
      if (powerPlayBtn) {
        await powerPlayBtn.click({ delay: 100 });
        await page.waitForTimeout(300);
      }

      // Confirm final submission
      await page.waitForSelector('button:has-text("Confirm"), button:has-text("Submit")', { timeout: 10000 });
      await page.click('button:has-text("Confirm"), button:has-text("Submit")', { delay: 120 });

      results.push({ link, status: "submitted" });
    } catch (err) {
      results.push({ link, status: "failed", error: err.message });
    }
  }

  // Save session storage
  try {
    await browser.storageState({ path: path.join(sessionPath, "storageState.json") });
  } catch (e) {
    console.warn("Failed to save storage state:", e.message);
  }

  return results;
});
/* ---------- IPC: Close session ---------- */
ipcMain.handle("close-session", async (event, sessionId) => {
  if (!sessions[sessionId]) return { error: "Invalid session" };
  try {
    await sessions[sessionId].browser.close();
    delete sessions[sessionId];
    return { closed: true };
  } catch (err) {
    console.error("Failed to close session:", err);
    return { error: err.message };
  }
});
