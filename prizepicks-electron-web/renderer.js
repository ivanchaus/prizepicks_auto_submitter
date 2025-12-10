const { ipcRenderer } = window.electron || require("electron");

document.addEventListener("DOMContentLoaded", () => {
  const sessionInput = document.getElementById("session-id-input");
  const entriesInput = document.getElementById("entries-input");
  const wagerInput = document.getElementById("wager-input");
  const submitBtn = document.getElementById("submit-entries-btn");
  const startBtn = document.getElementById("start-session-btn");
  const closeBtn = document.getElementById("close-session-btn");
  const statusBox = document.getElementById("submit-status");

  function logStatus(msg) {
    console.log(msg);
    statusBox.textContent += msg + "\n";
    statusBox.scrollTop = statusBox.scrollHeight;
  }

  // Start new session
  startBtn.addEventListener("click", async () => {
    logStatus("⚡ Starting new session...");
    const res = await ipcRenderer.invoke("start-session");
    if (res.sessionId) {
      sessionInput.value = res.sessionId;
      logStatus(`✅ Session started: ${res.sessionId}`);
    } else {
      logStatus(`❌ Failed to start session: ${res.error}`);
    }
  });

  // Submit entries
  submitBtn.addEventListener("click", async () => {
    const sessionId = sessionInput.value.trim();
    if (!sessionId) return logStatus("❌ No session ID. Start a session first.");
    const entriesRaw = entriesInput.value.trim();
    if (!entriesRaw) return logStatus("❌ No entries to submit.");
    const amount = Number(wagerInput.value) || undefined;

    // Parse URLs from lines like:
    // "Entry #2: https://app.prizepicks.com/board?projections= 8409927-o-9.5,..."
    const selectedLinks = entriesRaw
      .split("\n")
      .map(line => {
        // Extract URL starting with https://
        const match = line.match(/https?:\/\/\S+/);
        if (!match) return null;
        // Fix any space after `projections=` (remove it)
        return match[0].replace(/projections=\s+/, "projections=");
      })
      .filter(l => l); // remove nulls

    if (!selectedLinks.length) return logStatus("❌ No valid URLs found.");

    logStatus(`⚡ Submitting ${selectedLinks.length} entries...`);

    try {
      const results = await ipcRenderer.invoke("submit-entries", { sessionId, selectedLinks, amount });

      results.forEach(r => {
        if (r.status === "submitted") logStatus(`✅ Submitted: ${r.link}`);
        else logStatus(`❌ Failed: ${r.link} → ${r.error}`);
      });
    } catch (err) {
      logStatus(`❌ Error submitting entries: ${err.message}`);
    }
  });

  // Close session
  closeBtn.addEventListener("click", async () => {
    const sessionId = sessionInput.value.trim();
    if (!sessionId) return logStatus("❌ No session to close.");
    logStatus(`⚡ Closing session: ${sessionId}...`);
    const res = await ipcRenderer.invoke("close-session", sessionId);
    if (res.closed) {
      logStatus("✅ Session closed.");
      sessionInput.value = "";
    } else {
      logStatus(`❌ Failed to close session: ${res.error}`);
    }
  });
});

