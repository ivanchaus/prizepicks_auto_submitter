const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  startSession: () => ipcRenderer.invoke("start-session"),
  checkSessionStatus: (sessionId) => ipcRenderer.invoke("session-status", sessionId),
  submitEntries: (data) => ipcRenderer.invoke("submit-entries", data),
});


// contextBridge.exposeInMainWorld("electronAPI", {
//   startSession: () => ipcRenderer.invoke("start-session"),
//   checkSessionStatus: (sessionId) => ipcRenderer.invoke("session-status", sessionId),
//   submitEntries: (data) => ipcRenderer.invoke("submit-entries", data),
//   closeSession: (sessionId) => ipcRenderer.invoke("close-session", data)
// });