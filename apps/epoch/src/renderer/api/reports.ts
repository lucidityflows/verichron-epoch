export const reportsApi = {
  getReport: (runId: string) => window.epoch.getReport(runId),
  openReport: (runId: string) => window.epoch.openReport(runId),
};
