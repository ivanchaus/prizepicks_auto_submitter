document.getElementById("start-session-btn").addEventListener("click", async () => {
  console.log("🟡 Start session clicked");

  const res = await window.electronAPI.startSession();
  console.log("Returned:", res);

  if (!res || !res.sessionId) {
    console.error("❌ Failed to start session");
    document.getElementById("status").innerText = "Failed to start session ❌";
    return;
  }

  const sessionId = res.sessionId;
  document.getElementById("status").innerText = "Starting session…";

  // poll until session ready
  const interval = setInterval(async () => {
    const st = await window.electronAPI.checkSessionStatus(sessionId);
    if (st.ready) {
      clearInterval(interval);
      document.getElementById("status").innerText = "Session Ready ✔️";
      document.getElementById("session-id-input").value = sessionId;
    }
  }, 1000);
});

// Submit entries
document.getElementById("submit-entries-btn").addEventListener("click", async () => {
  const sessionId = document.getElementById("session-id-input").value;
  const entries = document.getElementById("entries-input").value.split("\n").filter(e => e.trim());
  const amount = Number(document.getElementById("wager-input").value);

  console.log("🟡 Submit clicked", { sessionId, entries, amount });

  const results = await window.electronAPI.submitEntries({ sessionId, selectedLinks: entries, amount });
  console.log("Submit Results:", results);
  document.getElementById("submit-status").innerText = JSON.stringify(results, null, 2);
});
