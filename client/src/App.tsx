import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ArenaSize, Difficulty, MatchSettings } from '../../shared/constants';
import type { FullSync, LobbyState, RoomJoinAck } from '../../shared/protocol';
import { api, bootstrap, cacheProfile, Profile, updateProfile } from './api';
import { audio } from './audio';
import { emitAck, getSocket, onRoomLost, onStatus, resetSocket, savedRoom, setCurrentRoom, ConnStatus } from './net';
import { LocalSession, NetSession, Session } from './game/session';
import { MenuBackground } from './screens/MenuBackground';
import { Menu, MenuTarget } from './screens/Menu';
import { Solo } from './screens/Solo';
import { CreateRoom, JoinRoom, Lobby } from './screens/Friends';
import { GameScreen } from './screens/Game';
import { Leaderboard } from './screens/Leaderboard';
import { ProfileScreen } from './screens/Profile';
import { SettingsScreen } from './screens/Settings';

const wired = new WeakSet<object>();
type Screen = 'menu' | 'solo' | 'create' | 'join' | 'lobby' | 'game' | 'leaderboard' | 'profile' | 'settings';
interface RoomSeat { code: string; memberId: string; rejoinToken: string }

export function App() {
  const [booted, setBooted] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [online, setOnline] = useState(false);
  const [screen, setScreen] = useState<Screen>('menu');
  const [lobby, setLobby] = useState<LobbyState | null>(null);
  const [room, setRoom] = useState<RoomSeat | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [solo, setSolo] = useState<{ diff: Difficulty; size: ArenaSize }>({ diff: 'normal', size: 'medium' });
  const [conn, setConn] = useState<ConnStatus>('offline');
  const [toast, setToast] = useState<string | null>(null);
  const [joinCode, setJoinCode] = useState<string | undefined>();
  const [sessionId, setSessionId] = useState(0);
  const roomRef = useRef<RoomSeat | null>(null);
  const sessionRef = useRef<Session | null>(null);
  roomRef.current = room;
  sessionRef.current = session;

  const showToast = (t: string) => {
    setToast(t);
    setTimeout(() => setToast(null), 4000);
  };

  const replaceSession = useCallback((s: Session | null) => {
    sessionRef.current?.destroy();
    sessionRef.current = s;
    setSession(s);
    setSessionId((n) => n + 1);
  }, []);

  const clearRoom = useCallback(() => {
    setRoom(null);
    roomRef.current = null;
    setLobby(null);
    setCurrentRoom(null);
  }, []);

  // ---- realtime listeners (registered once the server is reachable)
  const wireSocket = useCallback(() => {
    const s = getSocket();
    if (wired.has(s)) return;
    wired.add(s);
    s.on('lobby', (l: LobbyState) => setLobby(l));
    s.on('match:full', (full: FullSync) => {
      const seat = roomRef.current;
      if (!seat) return;
      if (sessionRef.current instanceof NetSession) return; // existing session resyncs itself
      replaceSession(new NetSession(s, full, seat.memberId));
      setScreen('game');
    });
    s.on('match:end', () => {
      // Stats/XP were updated server-side; refresh the local profile.
      api<{ profile: Profile }>('/api/me').then((r) => { cacheProfile(r.profile); setProfile(r.profile); }).catch(() => {});
    });
    s.on('room:replaced', () => {
      replaceSession(null);
      clearRoom();
      setScreen('menu');
      showToast('You joined this room from another tab, so this tab was disconnected.');
    });
  }, [replaceSession, clearRoom]);

  const enterRoom = useCallback((ack: RoomJoinAck) => {
    const seat = { code: ack.code!, memberId: ack.memberId!, rejoinToken: ack.rejoinToken! };
    roomRef.current = seat; // set synchronously: a match:full may follow this ack immediately
    setRoom(seat);
    setLobby(ack.lobby!);
    setCurrentRoom({ code: seat.code, rejoinToken: seat.rejoinToken });
    history.replaceState(null, '', '/');
    setScreen('lobby');
  }, []);

  useEffect(() => {
    (async () => {
      const b = await bootstrap();
      setProfile(b.profile);
      setOnline(b.online);
      setBooted(true);
      if (!b.online) return;
      wireSocket();
      const params = new URLSearchParams(location.search);
      const code = params.get('room');
      const saved = savedRoom();
      if (saved) {
        const ack = await emitAck<RoomJoinAck>('room:rejoin', saved).catch(() => null);
        if (ack?.ok) { enterRoom(ack); return; }
        setCurrentRoom(null);
      }
      if (code) { setJoinCode(code.toUpperCase()); setScreen('join'); }
    })();
    const offStatus = onStatus((s) => setConn(s));
    const offLost = onRoomLost(() => {
      replaceSession(null);
      clearRoom();
      setScreen('menu');
      showToast('Lost your seat in the room (disconnected too long).');
    });
    const unlock = () => audio.unlock();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    return () => { offStatus(); offLost(); window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!booted || !profile) {
    return (
      <div className="boot"><MenuBackground /><div className="logo center"><h1>ORBIT</h1><div className="subtitle">Gravity Wars</div></div></div>
    );
  }

  const nav = (t: MenuTarget) => setScreen(t);
  const toMenu = () => setScreen('menu');

  const startSolo = (diff: Difficulty, size: ArenaSize) => {
    setSolo({ diff, size });
    replaceSession(new LocalSession(profile.name, profile.cosmetics, diff, { arenaSize: size }));
    setScreen('game');
  };

  const createRoom = async (settings: MatchSettings): Promise<string | null> => {
    try {
      const ack = await emitAck<RoomJoinAck>('room:create', settings);
      if (!ack.ok) return ack.error ?? 'Could not create room.';
      enterRoom(ack);
      return null;
    } catch (e) { return (e as Error).message; }
  };

  const joinRoom = async (code: string): Promise<string | null> => {
    try {
      const ack = await emitAck<RoomJoinAck>('room:join', { code });
      if (!ack.ok) return ack.error ?? 'Could not join room.';
      enterRoom(ack);
      return null;
    } catch (e) { return (e as Error).message; }
  };

  const leaveRoom = () => {
    getSocket().emit('room:leave');
    replaceSession(null);
    clearRoom();
    setScreen('menu');
  };

  const onProfile = (p: Profile, relogin?: boolean) => {
    setProfile(p);
    if (relogin) {
      if (roomRef.current) getSocket().emit('room:leave');
      clearRoom();
      resetSocket();
      wireSocket();
    }
  };

  const rename = async (name: string): Promise<string | null> => {
    try { setProfile(await updateProfile({ name })); return null; } catch (e) { return (e as Error).message; }
  };

  const isHost = !!lobby && !!room && lobby.hostId === room.memberId;

  return (
    <div className="app">
      {screen !== 'game' && <MenuBackground />}
      {screen === 'menu' && <Menu profile={profile} online={online} conn={conn} onNav={nav} onRename={rename} />}
      {screen === 'solo' && <Solo onBack={toMenu} onStart={startSolo} />}
      {screen === 'create' && <CreateRoom onBack={toMenu} onCreate={createRoom} />}
      {screen === 'join' && <JoinRoom onBack={toMenu} onJoin={joinRoom} initialCode={joinCode} />}
      {screen === 'lobby' && lobby && room && (
        <Lobby lobby={lobby} memberId={room.memberId} onLeave={leaveRoom}
          onWatch={() => emitAck<RoomJoinAck>('room:rejoin', { code: room.code, rejoinToken: room.rejoinToken }).catch(() => null)} />
      )}
      {screen === 'leaderboard' && <Leaderboard profile={profile} onBack={toMenu} />}
      {screen === 'settings' && <SettingsScreen onBack={toMenu} />}
      {screen === 'profile' && <ProfileScreen profile={profile} online={online} onBack={toMenu} onProfile={onProfile} />}
      {screen === 'game' && session && (
        <GameScreen
          key={sessionId}
          session={session}
          online={online}
          isHost={isHost}
          difficulty={solo.diff}
          onProfile={(p) => setProfile(p)}
          onExit={() => { if (session.kind === 'online') leaveRoom(); else { replaceSession(null); toMenu(); } }}
          onPlayAgain={() => startSolo(solo.diff, solo.size)}
          onBackToLobby={() => { replaceSession(null); setScreen('lobby'); }}
          onRematch={() => getSocket().emit('room:start')}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
