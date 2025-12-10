
import { app, BrowserWindow, ipcMain } from "electron";
import path from "path";
import fs from "fs-extra";
import { chromium } from "playwright";
import { v4 as uuidv4 } from "uuid";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SESSIONS_DIR = path.join(process.cwd(), "sessions");
fs.ensureDirSync(SESSIONS_DIR);

const sessions = {}; // sessionId -> { browser, page, sessionPath, ready, error }

const isMac = process.platform === "darwin";
const isWindows = process.platform === "win32";

/** Try to find a system Chrome/Edge on common paths; fallback to undefined. */
function findSystemChrome() {
  // Allow user override env var CHROME_PATH
  if (process.env.CHROME_PATH) {
    try {
      if (fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
    } catch {}
  }

  const candidates = [];

  if (isMac) {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"
    );
  } else if (isWindows) {
    const programFiles = process.env["PROGRAMFILES"] || "C:\\Program Files";
    const programFilesX86 = process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
    const localApp = process.env.LOCALAPPDATA || path.join(process.env.HOME || "", "AppData", "Local");

    candidates.push(
      path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(localApp, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(programFiles, "Chromium", "Application", "chrome.exe"),
      path.join(localApp, "Microsoft", "Edge", "Application", "msedge.exe")
    );
  } else {
    // linux-ish candidates
    candidates.push("/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium");
  }

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return undefined;
}

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 920,
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
  if (!isMac) app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

/* --------------------------
   Start session (Playwright)
   -------------------------- */
ipcMain.handle("start-session", async () => {
  const sessionId = uuidv4();
  const sessionPath = path.join(SESSIONS_DIR, sessionId); // per-session user-data dir
  fs.ensureDirSync(sessionPath);

  sessions[sessionId] = { browser: null, page: null, sessionPath, ready: false, error: null };

  try {
    const exe = findSystemChrome(); // may be undefined -> Playwright's Chromium used
    if (exe) console.log("Using system Chrome:", exe);
    else console.log("System Chrome not found; using Playwright Chromium.");

    const browser = await chromium.launchPersistentContext(sessionPath, {
      headless: false,
      executablePath: exe || undefined,
      args: [
        "--start-maximized",
        "--disable-blink-features=AutomationControlled", // try to reduce detection
        "--disable-infobars",
        "--no-default-browser-check",
        "--no-first-run",
      ],
      timeout: 120000,
    });

    const page = await browser.newPage();
    sessions[sessionId].browser = browser;
    sessions[sessionId].page = page;
    sessions[sessionId].ready = true;

    // Open PrizePicks home so user can confirm login; UI can poll status
    await page.goto("https://app.prizepicks.com", { waitUntil: "networkidle" }).catch(() => {});

    console.log("Session started:", sessionId);
    return { sessionId };
  } catch (err) {
    console.error("Failed to start session:", err);
    sessions[sessionId].error = err.message;
    return { error: err.message };
  }
});

/* --------------------------
   Session status
   -------------------------- */
ipcMain.handle("session-status", async (event, sessionId) => {
  const s = sessions[sessionId];
  if (!s) return { exists: false, ready: false };
  const browserOpen = !!s.browser;
  const pageReady = !!s.page && !s.page.isClosed?.();
  return { exists: true, ready: Boolean(s.ready && browserOpen && pageReady), error: s.error || null };
});

/* --------------------------
   Submit entries
   selectedLinks: array of urls (strings)
   amount: optional number or string
   -------------------------- */
ipcMain.handle("submit-entries", async (event, { sessionId, selectedLinks, amount }) => {
  console.log("Submit request:", { sessionId, count: selectedLinks?.length ?? 0, amount });
  const s = sessions[sessionId];
  if (!s) return { error: "No session found" };
  if (!s.ready) return { error: "Session not ready" };

  const { page, browser, sessionPath } = s;
  const results = [];

  for (const rawLink of selectedLinks) {
    const link = String(rawLink).trim();
    if (!link) continue;

    try {
      console.log("Navigating to:", link);
      await page.goto(link, { waitUntil: "networkidle", timeout: 30000 });

      // wait a little for UI to stabilize
      await page.waitForTimeout(800 + Math.random() * 600);

      // Attempt to click Power Play. Use multiple selector strategies to be robust.
      let clickedPower = false;

      // Strategy 1: direct button text "Power Play"
      const ppHandle = await page.$('button:has-text("Power Play")');
      if (ppHandle) {
        await ppHandle.click({ delay: 120 });
        clickedPower = true;
        console.log("Clicked Power Play (by text).");
      } else {
        // Strategy 2: text contains "Power" (some variants)
        const loose = await page.$('button:has-text("Power")');
        if (loose) {
          await loose.click({ delay: 120 });
          clickedPower = true;
          console.log("Clicked Power Play (loose).");
        }
      }

      // Strategy 3: if a toggle/switch exists (data-test or aria)
      if (!clickedPower) {
        try {
          // Evaluate DOM to find an element that looks like power play toggle
          const toggled = await page.evaluate(() => {
            const candidates = Array.from(document.querySelectorAll("button, [role='button']"));
            for (const el of candidates) {
              const t = (el.innerText || "").toLowerCase();
              if (t.includes("power play") || t.includes("power")) {
                el.click();
                return true;
              }
            }
            return false;
          });
          if (toggled) {
            clickedPower = true;
            console.log("Clicked Power Play via DOM scan.");
          }
        } catch (e) {
          // ignore
        }
      }

      // Pause to allow UI update
      if (clickedPower) await page.waitForTimeout(500 + Math.random() * 600);

      // Enter wager amount if an input exists and amount provided
      if (amount !== undefined && amount !== null && String(amount).trim() !== "") {
        try {
          // Common numeric input selectors
          const inputSelectors = [
            'input[type="number"]',
            'input[placeholder*="Amount"]',
            'input[name*="amount"]',
            'input[name*="wager"]',
            'input[aria-label*="Amount"]'
          ];

          let inputFound = null;
          for (const sel of inputSelectors) {
            const h = await page.$(sel);
            if (h) {
              inputFound = h;
              break;
            }
          }

          if (inputFound) {
            await inputFound.click({ clickCount: 3 });
            await inputFound.fill(String(amount));
            await page.waitForTimeout(300 + Math.random() * 400);
            console.log("Wager input filled:", amount);
          } else {
            // fallback: click quick preset buttons (if exist)
            // Try to find a button that matches the amount text
            const presetBtn = await page.$(`button:has-text("${amount}")`);
            if (presetBtn) {
              await presetBtn.click({ delay: 120 });
              console.log("Clicked preset amount button:", amount);
            } else {
              console.log("No wager input/preset found for amount:", amount);
            }
          }
        } catch (e) {
          console.warn("Failed to set wager amount:", e.message);
        }
      }

      // Now click the primary submit (could be "Submit Lineup" or "Place Entry" or "Submit")
      // Try multiple possible buttons in order
      const submitSelectors = [
        'button:has-text("Submit Lineup")',
        'button:has-text("Place Entry")',
        'button:has-text("Submit")',
        'button:has-text("Confirm")'
      ];

      let submitted = false;
      for (const sel of submitSelectors) {
        try {
          const el = await page.$(sel);
          if (el) {
            // Hover + slight pause to simulate human
            await el.hover();
            await page.waitForTimeout(120 + Math.random() * 250);
            await el.click({ delay: 100 });
            submitted = true;
            console.log("Clicked submit via selector:", sel);
            break;
          }
        } catch (e) {
          // ignore and try next
        }
      }

      // If not found, try DOM-eval fallback to find a button containing "submit" text
      if (!submitted) {
        try {
          const fallback = await page.evaluate(() => {
            const btn = Array.from(document.querySelectorAll("button")).find(b => {
              const t = (b.innerText || "").toLowerCase();
              return t.includes("submit") || t.includes("place entry") || t.includes("confirm");
            });
            if (btn) { btn.click(); return true; }
            return false;
          });
          if (fallback) {
            submitted = true;
            console.log("Clicked submit via DOM fallback.");
          }
        } catch (e) {}
      }

      if (!submitted) throw new Error("Could not find Submit button");

      // Wait a little for confirmation UI; adjust if site shows a modal or toast
      await page.waitForTimeout(900 + Math.random() * 900);

      results.push({ link, status: "submitted" });
      console.log("Submitted OK:", link);
    } catch (err) {
      console.error("Error processing link:", link, err.message);
      results.push({ link, status: "failed", error: err.message });
    }

    // small pacing between entries
    await page.waitForTimeout(500 + Math.random() * 800);
  }

  // Save storage state so the session remains logged in next time (optional)
  try {
    await s.browser.storageState({ path: path.join(sessionPath, "storageState.json") });
  } catch (e) {
    console.warn("Failed to save storage state:", e.message);
  }

  return results;
});

/* --------------------------
   Close session
   -------------------------- */
ipcMain.handle("close-session", async (event, sessionId) => {
  const s = sessions[sessionId];
  if (!s) return { error: "Invalid session" };
  try {
    await s.browser.close();
    delete sessions[sessionId];
    return { closed: true };
  } catch (err) {
    console.error("Close session failed:", err);
    return { error: err.message };
  }
});
