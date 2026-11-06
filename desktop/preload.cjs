const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('ccagentSetup', Object.freeze({
  status: () => ipcRenderer.invoke('ccagent:status'),
  chooseFolder: () => ipcRenderer.invoke('ccagent:folder'),
  saveModel: body => ipcRenderer.invoke('ccagent:model', body),
  testModel: id => ipcRenderer.invoke('ccagent:test-model', id),
  finish: (view = '') => ipcRenderer.invoke('ccagent:finish', view),
  logs: () => ipcRenderer.invoke('ccagent:logs'),
}));
