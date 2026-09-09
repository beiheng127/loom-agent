import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("loomDesktop", {
  isDesktop: true,
  openDirectory: () => ipcRenderer.invoke("loom:openDirectory"),
});
