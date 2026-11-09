/** Unit tests for probing an existing bridge before scanning Windows processes. */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const ipc = vi.hoisted(() => ({
  connect: vi.fn(),
  request: vi.fn(),
  close: vi.fn(),
}));

vi.mock('../../../src/lib/sessions.js', () => ({
  getSession: vi.fn(),
  updateSession: vi.fn(),
}));

vi.mock('../../../src/lib/utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/utils.js')>()),
  isProcessAlive: vi.fn(),
}));

vi.mock('../../../src/lib/bridge-client.js', () => ({
  BridgeClient: class {
    connect = ipc.connect;
    request = ipc.request;
    close = ipc.close;
  },
}));

vi.mock('../../../src/lib/auth/keychain.js', () => ({}));
vi.mock('../../../src/lib/auth/profiles.js', () => ({}));

import { ensureBridgeReady } from '../../../src/lib/bridge-manager.js';
import { AuthError, ClientError, IpcTimeoutError, NetworkError } from '../../../src/lib/errors.js';
import { getSession, updateSession } from '../../../src/lib/sessions.js';
import { getSocketPath, isProcessAlive } from '../../../src/lib/utils.js';

const SESSION_NAME = '@ready-test';
const BRIDGE_PID = 4242;
const session = {
  name: SESSION_NAME,
  server: { url: 'https://mcp.example.com' },
  pid: BRIDGE_PID,
  status: 'active' as const,
  mcpSessionId: 'existing-session',
  lastSeenAt: '2026-01-01T00:00:00.000Z',
};

describe('ensureBridgeReady', () => {
  beforeEach(() => {
    vi.mocked(getSession)
      .mockReset()
      .mockResolvedValue(session as never);
    vi.mocked(updateSession).mockReset().mockResolvedValue(undefined);
    vi.mocked(isProcessAlive).mockReset().mockReturnValue(true);
    ipc.connect.mockReset().mockResolvedValue(undefined);
    ipc.request.mockReset().mockResolvedValue({});
    ipc.close.mockReset().mockResolvedValue(undefined);
  });

  it('uses a responsive bridge without checking process liveness', async () => {
    vi.mocked(isProcessAlive).mockImplementation(() => {
      throw new Error('A process scan must not run on the healthy path');
    });

    await expect(ensureBridgeReady(SESSION_NAME, 45)).resolves.toBe(
      getSocketPath(SESSION_NAME, BRIDGE_PID)
    );

    expect(ipc.connect).toHaveBeenCalledExactlyOnceWith({ retryTimeoutMillis: 0 });
    expect(ipc.request).toHaveBeenCalledExactlyOnceWith('getServerDetails', undefined, 45);
    expect(ipc.close).toHaveBeenCalledTimes(1);
    expect(isProcessAlive).not.toHaveBeenCalled();
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('retains socket retries when a live bridge is not listening yet', async () => {
    ipc.connect.mockRejectedValueOnce(new NetworkError('Connection refused'));

    await expect(ensureBridgeReady(SESSION_NAME)).resolves.toBe(
      getSocketPath(SESSION_NAME, BRIDGE_PID)
    );

    expect(ipc.connect).toHaveBeenNthCalledWith(1, { retryTimeoutMillis: 0 });
    expect(ipc.connect).toHaveBeenNthCalledWith(2, undefined);
    expect(ipc.request).toHaveBeenCalledTimes(1);
    expect(ipc.close).toHaveBeenCalledTimes(2);
    expect(isProcessAlive).toHaveBeenCalledExactlyOnceWith(BRIDGE_PID);
    expect(updateSession).not.toHaveBeenCalled();
  });

  it.each([
    ['unauthorized', AuthError],
    ['expired', ClientError],
  ] as const)('rejects a saved %s session before probing', async (status, errorType) => {
    vi.mocked(getSession).mockResolvedValue({ ...session, status } as never);

    await expect(ensureBridgeReady(SESSION_NAME)).rejects.toBeInstanceOf(errorType);

    expect(ipc.connect).not.toHaveBeenCalled();
    expect(isProcessAlive).not.toHaveBeenCalled();
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('rejects a missing session without probing or scanning', async () => {
    vi.mocked(getSession).mockResolvedValue(undefined);

    await expect(ensureBridgeReady(SESSION_NAME)).rejects.toThrow('Session not found');

    expect(ipc.connect).not.toHaveBeenCalled();
    expect(isProcessAlive).not.toHaveBeenCalled();
  });

  it.each([
    ['401 Unauthorized', 'unauthorized', AuthError],
    ['404 Session not found', 'expired', ClientError],
  ] as const)('preserves session classification for %s', async (message, status, errorType) => {
    ipc.request.mockRejectedValueOnce(new Error(message));

    await expect(ensureBridgeReady(SESSION_NAME)).rejects.toBeInstanceOf(errorType);

    expect(updateSession).toHaveBeenCalledExactlyOnceWith(SESSION_NAME, { status });
    expect(isProcessAlive).not.toHaveBeenCalled();
    expect(ipc.request).toHaveBeenCalledTimes(1);
    expect(ipc.close).toHaveBeenCalledTimes(1);
  });

  it('reports server errors without treating the bridge as dead', async () => {
    ipc.request.mockRejectedValueOnce(new Error('Invalid server configuration'));

    await expect(ensureBridgeReady(SESSION_NAME)).rejects.toThrow('Invalid server configuration');

    expect(isProcessAlive).not.toHaveBeenCalled();
    expect(updateSession).not.toHaveBeenCalled();
    expect(ipc.close).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'does not restart a bridge after a health request timeout (retry=%s)',
    async (retry) => {
      if (retry) {
        ipc.connect.mockRejectedValueOnce(new NetworkError('Connection refused'));
      }
      const error = new IpcTimeoutError('Request timeout: getServerDetails');
      ipc.request.mockRejectedValueOnce(error);

      await expect(ensureBridgeReady(SESSION_NAME, 1)).rejects.toBe(error);

      expect(ipc.request).toHaveBeenCalledExactlyOnceWith('getServerDetails', undefined, 1);
      expect(ipc.close).toHaveBeenCalledTimes(retry ? 2 : 1);
      expect(isProcessAlive).toHaveBeenCalledTimes(retry ? 1 : 0);
      expect(updateSession).not.toHaveBeenCalled();
    }
  );

  it.each([false, true])(
    'attempts existing recovery after an unreachable pipe (process alive=%s)',
    async (alive) => {
      ipc.connect.mockRejectedValue(new NetworkError('Connection refused'));
      vi.mocked(isProcessAlive).mockReturnValue(alive);
      // Stop at restartBridge's metadata read so this test never spawns a process.
      vi.mocked(getSession)
        .mockResolvedValueOnce(session as never)
        .mockResolvedValue(undefined);

      await expect(ensureBridgeReady(SESSION_NAME)).rejects.toThrow('Session not found');

      expect(updateSession).toHaveBeenCalledExactlyOnceWith(SESSION_NAME, {
        status: 'reconnecting',
        lastConnectionAttemptAt: expect.any(String),
      });
      expect(ipc.connect).toHaveBeenCalledTimes(alive ? 2 : 1);
      expect(ipc.close).toHaveBeenCalledTimes(alive ? 2 : 1);
      expect(getSession).toHaveBeenCalledTimes(2);
    }
  );
});
