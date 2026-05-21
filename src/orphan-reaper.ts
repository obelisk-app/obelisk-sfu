/**
 * Boot-time sweep for orphan ffmpeg processes spawned by prior test-peer
 * runs that didn't get cleaned up — the textbook case is the SFU getting
 * SIGKILLed (OOM, pm2 timeout, hard kill) before its in-process spawner
 * could send SIGTERM to its children. Without this sweep, those ffmpegs
 * survive across SFU restarts, each pinning a CPU core while pumping
 * VP8/Opus into a now-dead mediasoup port. The 2026-05-07 incident had
 * three of these alive for 15-23 hours, load avg 13 on a 4-core box, and
 * mediasoup workers missing realtime deadlines — visible to operators as
 * "the SFU randomly stops working until I restart it".
 *
 * Identification is by argv signature only — both substrings come from
 * the encoder args shared by the mediasoup and mesh test-peer scripts. If
 * those args change, the strings here must change in lockstep, or the
 * sweep silently does nothing.
 *
 * MUST run only once at boot, before any new test peer is spawned —
 * otherwise it would happily kill our own freshly-launched children.
 */
import { readdirSync, readFileSync } from 'node:fs';

import { createLogger } from './log.js';

const log = createLogger('orphan-reaper');

const FFMPEG_SIGNATURES = [
  'testsrc2=size=640x480:rate=15',
  'sine=frequency=440:beep_factor=4',
] as const;

/**
 * Returns the number of orphan PIDs we sent SIGTERM to. SIGKILL follows
 * automatically after a 2 s grace for anything that ignored SIGTERM.
 */
export function reapTestPeerOrphans(): number {
  let pids: number[];
  try {
    pids = readdirSync('/proc')
      .filter((name) => /^\d+$/.test(name))
      .map(Number);
  } catch {
    // Non-Linux — /proc absent. The reaper is a no-op there; the
    // production deploy is always Linux so this is fine.
    return 0;
  }

  const targets: number[] = [];
  for (const pid of pids) {
    let cmdline: string;
    try {
      const raw = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      // /proc/N/cmdline uses NUL separators with a trailing NUL.
      cmdline = raw.replace(/\0+$/, '').replace(/\0/g, ' ');
    } catch {
      continue;
    }
    if (!cmdline.startsWith('ffmpeg')) continue;
    if (!FFMPEG_SIGNATURES.some((sig) => cmdline.includes(sig))) continue;
    targets.push(pid);
  }

  if (targets.length === 0) return 0;

  let killed = 0;
  for (const pid of targets) {
    try {
      process.kill(pid, 'SIGTERM');
      killed++;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ESRCH') {
        log.warn('SIGTERM failed', { pid, err: (err as Error).message });
      }
    }
  }
  log.warn('reaped orphan test-peer ffmpegs', { killed, pids: targets });

  // Escalate to SIGKILL after a short grace for anything that ignored
  // SIGTERM. ffmpeg normally exits within ms of SIGTERM; this is a
  // safety net for the rare hang during muxer shutdown.
  setTimeout(() => {
    for (const pid of targets) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }, 2_000).unref?.();

  return killed;
}
