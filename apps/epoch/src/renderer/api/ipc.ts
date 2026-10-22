import type { InvokeArgs, InvokeChannel, InvokeResult } from '../../shared/ipc/channels';

export function invokeIpc<Channel extends InvokeChannel>(
  channel: Channel,
  ...args: InvokeArgs<Channel>
): Promise<InvokeResult<Channel>> {
  return window.epoch.invoke(channel, ...args);
}
