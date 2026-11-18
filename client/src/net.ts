// Socket.IO connection to the authoritative game server, with automatic reconnection and room re-joining.
import { io, Socket } from 'socket.io-client';
import { getToken } from './api';

export type ConnStatus = 'offline' | 'connecting' | 'connected' | 'reconnecting';

let socket: Socket | null = null;
let status: ConnStatus = 'offline';
let ping = 0;
let currentRoom: { code: string; rejoinToken: string } | null = null;
const statusListeners = new Set<(s: ConnStatus, ping: number) => void>();

function setStatus(s: ConnStatus) {
  status = s;
  statusListeners.forEach((l) => l(status, ping));
}

export function onStatus(fn: (s: ConnStatus, ping: number) => void): () => void {
  statusListeners.add(fn);
  fn(status, ping);
  return () => statusListeners.delete(fn);
}

export function getSocket(): Socket {
  if (socket) return socket;
  socket = io({ auth: (cb) => cb({ token: getToken() }), transports: ['websocket', 'polling'], reconnectionDelayMax: 3000 });
  setStatus('connecting');
  let connectedOnce = false;
  socket.on('connect', () => {
    setStatus('connected');
    if (connectedOnce && currentRoom) {
      socket!.emit('room:rejoin', currentRoom, (ack: { ok: boolean }) => {
        if (!ack.ok) { currentRoom = null; lostListeners.forEach((l) => l()); }
      });
    }
    connectedOnce = true;
  });
  socket.on('disconnect', () => setStatus('reconnecting'));
  socket.on('connect_error', () => setStatus(connectedOnce ? 'reconnecting' : 'connecting'));
  setInterval(() => {
    if (!socket?.connected) return;
    const t0 = performance.now();
    socket.emit('net:ping', () => {
      ping = Math.round(performance.now() - t0);
      statusListeners.forEach((l) => l(status, ping));
    });
  }, 2000);
  return socket;
}

/** Call after login/logout so the socket authenticates as the new account. */
export function resetSocket(): void {
  if (!socket) return;
  socket.removeAllListeners();
  socket.disconnect();
  socket = null;
  currentRoom = null;
  setStatus('offline');
}

const lostListeners = new Set<() => void>();
export function onRoomLost(fn: () => void): () => void {
  lostListeners.add(fn);
  return () => lostListeners.delete(fn);
}

export function setCurrentRoom(r: { code: string; rejoinToken: string } | null) {
  currentRoom = r;
  try { r ? sessionStorage.setItem('orbit.room', JSON.stringify(r)) : sessionStorage.removeItem('orbit.room'); } catch { /* ignore */ }
}

/** A room seat saved in this tab (survives a page refresh). */
export function savedRoom(): { code: string; rejoinToken: string } | null {
  try { return JSON.parse(sessionStorage.getItem('orbit.room') ?? 'null'); } catch { return null; }
}

export function emitAck<T>(event: string, data: unknown, timeoutMs = 6000): Promise<T> {
  const s = getSocket();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('The server did not respond. Check your connection.')), timeoutMs);
    const send = () => s.emit(event, data, (res: T) => { clearTimeout(t); resolve(res); });
    if (s.connected) send();
    else s.once('connect', send);
  });
}
