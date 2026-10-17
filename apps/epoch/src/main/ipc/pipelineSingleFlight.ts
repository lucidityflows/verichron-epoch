export type PipelineTool = 'processor' | 'orchestrator';

interface PipelineReservation {
  tool: PipelineTool;
}

export class PipelineSingleFlight {
  private active: PipelineReservation | null = null;

  reserve(tool: PipelineTool): () => void {
    if (this.active) {
      throw new Error(`Cannot start ${tool} while ${this.active.tool} is running in this app.`);
    }

    const reservation: PipelineReservation = { tool };
    this.active = reservation;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.active === reservation) this.active = null;
    };
  }
}
