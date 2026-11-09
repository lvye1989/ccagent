const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('ccagentSetup', Object.freeze({
  status: () => ipcRenderer.invoke('ccagent:status'),
  prerequisites: options => ipcRenderer.invoke('ccagent:prerequisites', options),
  installPrerequisite: id => ipcRenderer.invoke('ccagent:install-prerequisite', id),
  cancelPrerequisiteInstall: () => ipcRenderer.invoke('ccagent:cancel-prerequisite-install'),
  openPrerequisitePage: id => ipcRenderer.invoke('ccagent:prerequisite-page', id),
  reviewPrerequisites: () => ipcRenderer.invoke('ccagent:review-prerequisites'),
  login: () => ipcRenderer.invoke('ccagent:login'),
  chooseFolder: () => ipcRenderer.invoke('ccagent:folder'),
  saveModel: body => ipcRenderer.invoke('ccagent:model', body),
  testModel: id => ipcRenderer.invoke('ccagent:test-model', id),
  officialServices: () => ipcRenderer.invoke('ccagent:official-services'),
  saveOfficialServices: body => ipcRenderer.invoke('ccagent:save-official-services', body),
  accountPage: section => ipcRenderer.invoke('ccagent:account-page', section),
  finish: (view = '') => ipcRenderer.invoke('ccagent:finish', view),
  logs: () => ipcRenderer.invoke('ccagent:logs'),
}));
