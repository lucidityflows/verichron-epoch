/**
 * A plain-language cause for a failed setup step, when its output shows one
 * (EPOCH-465). Returns undefined rather than guessing: the raw lines are
 * always shown beside the hint.
 */
const PACKAGE_NAMES: Record<string, string> = {
  openssl: 'OpenSSL',
  libssl: 'OpenSSL',
  libcurl: 'libcurl',
};

const RULES: Array<{ test: RegExp; hint: (match: RegExpMatchArray) => string }> = [
  {
    test: /pkg-config(?:: not found| script could not be found|: command not found)/i,
    hint: () => "pkg-config isn't installed. Install the system tools, then try again.",
  },
  {
    test: /No package '([^']+)' found|Package '?([\w.+-]+)'?,? (?:required by .* )?(?:was )?not found/i,
    hint: (m) => {
      const pkg = (m[1] ?? m[2] ?? '').replace(/-[\d.]+$/, '');
      const name = PACKAGE_NAMES[pkg] ?? pkg;
      return `The ${name} development files aren't installed. Install the system tools, then try again.`;
    },
  },
  {
    test: /C compiler cannot create executables|no acceptable C compiler|cc: (?:not found|command not found)/i,
    hint: () => "No working C compiler was found. Install the system tools, then try again.",
  },
  {
    test: /make: (?:not found|command not found)/i,
    hint: () => "make isn't installed. Install the system tools, then try again.",
  },
  {
    test: /bzip2: (?:not found|Cannot exec)|tar: (?:not found|Child returned status)/i,
    hint: () => "The archive tools (tar and bzip2) aren't available.",
  },
  {
    test: /Could not get lock|dpkg frontend lock|Unable to acquire the dpkg/i,
    hint: () => 'Another program is installing software. Wait for it to finish, then try again.',
  },
  {
    test: /Unable to locate package ([\w.+-]+)/i,
    hint: (m) => `The package manager doesn't know ${m[1]}. Update its package lists (apt-get update), then try again.`,
  },
  {
    test: /SHA-256 mismatch/,
    hint: () => "A download didn't match its expected checksum, so it wasn't used. Try again; if it repeats, the download source has changed.",
  },
  {
    test: /fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|HTTP \d{3}/,
    hint: () => "A download failed. Check this computer's internet connection, then try again.",
  },
  {
    test: /No space left on device/i,
    hint: () => 'The disk is full. Free some space, then try again.',
  },
];

/** pkexec's own exit codes: 126 the request was dismissed, 127 authorization failed. */
export function adminPromptHint(code: number): string | undefined {
  if (code === 126) return 'The administrator request was cancelled.';
  if (code === 127) return "Administrator approval wasn't granted.";
  return undefined;
}

export function hintFor(lines: string[]): string | undefined {
  // The last matching line is usually the cause; earlier ones are often noise.
  for (const line of [...lines].reverse()) {
    for (const rule of RULES) {
      const match = line.match(rule.test);
      if (match) return rule.hint(match);
    }
  }
  return undefined;
}
