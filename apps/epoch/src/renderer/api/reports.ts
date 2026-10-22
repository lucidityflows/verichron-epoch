import { invokeIpc } from './ipc';

export const reportsApi = {
  getReport: (runId: string) => invokeIpc('epoch:getReport', runId),
  openReport: (runId: string) => invokeIpc('epoch:openReport', runId),
};
