// Let the kernel keep pairing keys made with the Bluetooth SMP debug key pair
// (`ble.keep_debug_keys`).
//
// A Beurer BF500 pairs with the debug key pair: BlueZ's mgmt event for the new
// long term key says "Key type: Debug key from P-256 (0x04)". With the adapter's
// Debug Keys setting off the key is not reused, so the scale asks for SET and a
// new pairing before every weigh-in, while the same scale reconnects from a phone
// without it. `btmgmt debug-keys on` turns the setting on. It needs no
// power-cycle and survives one, so it is checked once per scan cycle.

import { bleLog } from '../types.js';
import { btmgmtErrorLine } from '../btmgmt.js';
import { adapterIndexOf, readSettings, runBtmgmt } from './privacy.js';
import type { Adapter } from './dbus.js';

const warned = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) {
    bleLog.debug(message);
    return;
  }
  warned.add(key);
  bleLog.warn(message);
}

/** Test seam: the module keeps per-process state on purpose. */
export function _resetDebugKeysStateForTests(): void {
  warned.clear();
}

/**
 * Turn on the adapter's Debug Keys setting if it is off. Never throws: a failure
 * is logged once and the cycle carries on, because an unbonded scale still reads.
 */
export async function ensureDebugKeys(adapter: Adapter): Promise<void> {
  if (process.platform !== 'linux') return;
  const index = adapterIndexOf(adapter);
  if (index === undefined) {
    warnOnce(
      'no-index',
      'ble.keep_debug_keys: could not tell which hciN the BlueZ adapter is; not applied.',
    );
    return;
  }
  const before = await readSettings(index);
  if (!before) {
    warnOnce(
      `no-info:${index}`,
      `ble.keep_debug_keys: btmgmt could not read hci${index}. Is btmgmt installed, and does ` +
        'the process have CAP_NET_ADMIN?',
    );
    return;
  }
  if (before.current.includes('debug-keys')) return;
  if (!before.supported.includes('debug-keys')) {
    warnOnce(
      `unsupported:${index}`,
      `ble.keep_debug_keys: hci${index} does not support Debug Keys; not applied.`,
    );
    return;
  }
  const res = await runBtmgmt(['--index', String(index), 'debug-keys', 'on']);
  const after = await readSettings(index);
  if (after?.current.includes('debug-keys')) {
    bleLog.info(`ble.keep_debug_keys: Debug Keys is on for hci${index}.`);
    return;
  }
  warnOnce(
    `failed:${index}`,
    `ble.keep_debug_keys: could not turn Debug Keys on for hci${index}: ` +
      `${res.failure ?? btmgmtErrorLine(res.out) ?? 'the setting is not in the adapter settings'}.`,
  );
}
