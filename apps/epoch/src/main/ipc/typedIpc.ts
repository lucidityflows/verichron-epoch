import { ipcMain } from 'electron';
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import type { EventChannel, EventPayload, InvokeArgs, InvokeChannel, InvokeResult } from '../../shared/ipc/channels';

type InvokeHandler<Channel extends InvokeChannel> = (
  event: IpcMainInvokeEvent,
  ...args: InvokeArgs<Channel>
) => InvokeResult<Channel> | Promise<InvokeResult<Channel>>;

export function handleIpc<Channel extends InvokeChannel>(channel: Channel, handler: InvokeHandler<Channel>): void {
  ipcMain.handle(channel, (event, ...args) => handler(event, ...(args as InvokeArgs<Channel>)));
}

export function sendIpcEvent<Channel extends EventChannel>(
  target: Pick<WebContents, 'send'>,
  channel: Channel,
  payload: EventPayload<Channel>
): void {
  target.send(channel, payload);
}
