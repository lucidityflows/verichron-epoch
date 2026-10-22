import { contextBridge, ipcRenderer } from 'electron';
import type {
  EventChannel,
  EventPayload,
  EpochBridge,
  InvokeArgs,
  InvokeChannel,
  InvokeResult,
} from '../shared/ipc/channels';

const epochBridge: EpochBridge = {
  platform: process.platform,

  invoke<Channel extends InvokeChannel>(
    channel: Channel,
    ...args: InvokeArgs<Channel>
  ): Promise<InvokeResult<Channel>> {
    return ipcRenderer.invoke(channel, ...args);
  },

  on<Channel extends EventChannel>(channel: Channel, callback: (payload: EventPayload<Channel>) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, payload: EventPayload<Channel>) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
};

contextBridge.exposeInMainWorld('epoch', epochBridge);
