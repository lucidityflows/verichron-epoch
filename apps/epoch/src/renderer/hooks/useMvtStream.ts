import { useEffect, useState } from 'react';
import { pipelineApi } from '../api/pipeline';

export function useMvtStream() {
  const [logs, setLogs] = useState<string[]>([]);
  const [pendingPasswordPrompt, setPendingPasswordPrompt] = useState<string | null>(null);

  useEffect(() => {
    const unsubLog = pipelineApi.onMvtLog?.((data) => {
      setLogs((prev) => [...prev, data.line]);
    });
    const unsubPassword = pipelineApi.onMvtPasswordRequired?.((username) => {
      setPendingPasswordPrompt(username);
    });

    return () => {
      unsubLog?.();
      unsubPassword?.();
    };
  }, []);

  const submitPassword = async (password: string) => {
    await pipelineApi.submitMvtPassword(password);
    setPendingPasswordPrompt(null);
  };

  return { logs, pendingPasswordPrompt, submitPassword };
}
