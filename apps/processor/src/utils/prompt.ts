/**
 * Asks for a password on stdin. Without a terminal (the app relays the prompt
 * and writes the answer to stdin, which it keeps open for any later prompt),
 * stdin is held only while a prompt waits: once the line is read it is paused
 * and released, so the processor can exit when its work is done instead of
 * waiting on an input that never closes (EPOCH-489).
 */
export function promptPassword(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    process.stdout.write(prompt);

    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;

    if (!stdin.isTTY) {
      const chunks: Buffer[] = [];
      // A socket or pipe has ref()/unref(); a file redirected to stdin doesn't need them.
      const handle = stdin as NodeJS.ReadStream & { ref?: () => void; unref?: () => void };
      handle.ref?.();
      // After an earlier prompt paused it, a new 'data' listener alone would
      // not start it flowing again.
      stdin.resume();
      stdin.on('data', function onData(chunk: Buffer) {
        const idx = chunk.indexOf(0x0a);
        if (idx !== -1) {
          chunks.push(chunk.subarray(0, idx));
          stdin.removeListener('data', onData);
          stdin.pause();
          handle.unref?.();
          const line = Buffer.concat(chunks).toString('utf8').replace(/\r$/, '');
          process.stdout.write('\n');
          resolve(line);
        } else {
          chunks.push(chunk);
        }
      });
      stdin.on('error', reject);
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
          process.stdout.write('\n');
          resolve(password);
          break;
        case '\u0003':
          cleanup();
          process.stdout.write('\n');
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
