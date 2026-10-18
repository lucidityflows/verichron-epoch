/**
 * Asks for a password on stdin. Without a terminal (the app relays the prompt
 * and writes the answer to stdin, which it keeps open for any later prompt),
 * stdin is held only while a prompt waits: once the line is read it is paused
 * and released, so the processor can exit when its work is done instead of
 * waiting on an input that never closes (EPOCH-489).
 *
 * `write` shows the prompt; when the app runs the processor it shows nothing,
 * and the app asks for the password on the `password:required` event instead.
 */
export function promptPassword(prompt: string, write: (text: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    write(prompt);

    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;

    if (!stdin.isTTY) {
      // Ended before this prompt (an earlier one read the last line): no answer can come.
      if (stdin.readableEnded) {
        reject(new Error('stdin closed before a password was entered'));
        return;
      }
      const chunks: Buffer[] = [];
      // A socket or pipe has ref()/unref(); a file redirected to stdin doesn't need them.
      const handle = stdin as NodeJS.ReadStream & { ref?: () => void; unref?: () => void };
      handle.ref?.();
      // After an earlier prompt paused it, a new 'data' listener alone would
      // not start it flowing again.
      stdin.resume();
      // Settles once: on the first line, or when stdin ends or fails before
      // one arrives, so a closed input is reported instead of waited on.
      const release = () => {
        stdin.removeListener('data', onData);
        stdin.removeListener('end', onEnd);
        stdin.removeListener('error', onError);
        stdin.pause();
        handle.unref?.();
      };
      const onData = (chunk: Buffer) => {
        const idx = chunk.indexOf(0x0a);
        if (idx !== -1) {
          chunks.push(chunk.subarray(0, idx));
          release();
          const line = Buffer.concat(chunks).toString('utf8').replace(/\r$/, '');
          write('\n');
          resolve(line);
        } else {
          chunks.push(chunk);
        }
      };
      const onEnd = () => {
        release();
        reject(new Error('stdin closed before a password was entered'));
      };
      const onError = (err: Error) => {
        release();
        reject(err);
      };
      stdin.on('data', onData);
      stdin.on('end', onEnd);
      stdin.on('error', onError);
      return;
    }

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let password = '';

    const onData = (char: string) => {
      switch (char) {
        case '\n':
        case '\r':
        case '\u0004':
          cleanup();
          write('\n');
          resolve(password);
          break;
        case '\u0003':
          cleanup();
          write('\n');
          reject(new Error('interrupted'));
          break;
        case '\u007f':
        case '\b':
          password = password.slice(0, -1);
          break;
        default:
          password += char;
          break;
      }
    };

    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(wasRaw ?? false);
      stdin.pause();
    };

    stdin.on('data', onData);
  });
}
