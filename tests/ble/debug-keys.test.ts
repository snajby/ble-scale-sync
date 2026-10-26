import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const runBtmgmt = vi.fn();
const readSettings = vi.fn();
vi.mock('../../src/ble/handler-node-ble/privacy.js', () => ({
  adapterIndexOf: () => 0,
  runBtmgmt: (...a: unknown[]) => runBtmgmt(...a),
  readSettings: (...a: unknown[]) => readSettings(...a),
}));

import {
  ensureDebugKeys,
  _resetDebugKeysStateForTests,
} from '../../src/ble/handler-node-ble/debug-keys.js';
import type { Adapter } from '../../src/ble/handler-node-ble/dbus.js';

const adapter = {} as Adapter;
const settings = (current: string[], supported = ['debug-keys', 'privacy']) => ({
  supported,
  current,
});

describe('ensureDebugKeys', () => {
  const realPlatform = process.platform;
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    runBtmgmt.mockReset().mockResolvedValue({ out: '' });
    readSettings.mockReset();
    _resetDebugKeysStateForTests();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform });
  });

  it('does nothing when Debug Keys is already on', async () => {
    readSettings.mockResolvedValue(settings(['powered', 'debug-keys']));
    await ensureDebugKeys(adapter);
    expect(runBtmgmt).not.toHaveBeenCalled();
  });

  it('turns it on and reads it back when it is off', async () => {
    readSettings
      .mockResolvedValueOnce(settings(['powered']))
      .mockResolvedValueOnce(settings(['powered', 'debug-keys']));
    await ensureDebugKeys(adapter);
    expect(runBtmgmt).toHaveBeenCalledWith(['--index', '0', 'debug-keys', 'on']);
  });

  it('does not try when the adapter does not support it', async () => {
    readSettings.mockResolvedValue(settings(['powered'], ['privacy']));
    await ensureDebugKeys(adapter);
    expect(runBtmgmt).not.toHaveBeenCalled();
  });

  it('never throws when btmgmt cannot be read or the setting does not take', async () => {
    readSettings.mockResolvedValueOnce(undefined);
    await expect(ensureDebugKeys(adapter)).resolves.toBeUndefined();
    readSettings.mockResolvedValue(settings(['powered']));
    await expect(ensureDebugKeys(adapter)).resolves.toBeUndefined();
  });
});
