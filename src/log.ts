const started = Date.now();

function stamp(): string {
  const s = ((Date.now() - started) / 1000).toFixed(1).padStart(6, ' ');
  return `[${s}s]`;
}

export function info(...args: unknown[]): void {
  console.log(stamp(), ...args);
}

export function warn(...args: unknown[]): void {
  console.warn(stamp(), 'WARN', ...args);
}

export function error(...args: unknown[]): void {
  console.error(stamp(), 'ERROR', ...args);
}

export function progress(done: number, total: number, label: string): void {
  if (total === 0) return;
  const every = Math.max(1, Math.floor(total / 20));
  if (done % every !== 0 && done !== total) return;
  info(`${label}: ${done}/${total} (${((done / total) * 100).toFixed(0)}%)`);
}
