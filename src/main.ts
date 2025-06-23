// src/main.ts
import Peer from 'peerjs';
import type { DataConnection } from 'peerjs';
import { wordPairs, type WordPair } from './data/wordpairs';

window.addEventListener('DOMContentLoaded', () => {
  const copyLinkBtn  = document.getElementById('copy-link-btn')!  as HTMLButtonElement;

  // ─── Helpers ──────────────────────────────────────────────────────────
  function getParam(name: string): string | null {
    return new URLSearchParams(window.location.search).get(name);
  }

  function isMessage(d: unknown): d is { type: string; [k: string]: any } {
    return typeof d === 'object' && d !== null && 'type' in d;
  }

  function formatTime(sec: number) {
    const m = String(Math.floor(sec / 60)).padStart(2, '0');
    const s = String(sec % 60).padStart(2, '0');
    return `${m}:${s}`;
  }

  // ─── DOM Elements ─────────────────────────────────────────────────────
  const stepRole       = document.getElementById('step-role')!          as HTMLDivElement;
  const chooseHostBtn  = document.getElementById('choose-host')!       as HTMLButtonElement;
  const chooseJoinBtn  = document.getElementById('choose-join')!       as HTMLButtonElement;

  const stepName       = document.getElementById('step-name')!          as HTMLDivElement;
  const chosenRoleText = document.getElementById('chosen-role-text')!   as HTMLParagraphElement;
  const nameInput      = document.getElementById('player-name-input')!  as HTMLInputElement;
  const submitNameBtn  = document.getElementById('submit-name')!       as HTMLButtonElement;

  const hostLobby      = document.getElementById('host-lobby')!         as HTMLDivElement;
  const hostIdSpan     = document.getElementById('host-peer-id')!       as HTMLSpanElement;
  const hostListEl     = document.getElementById('player-list-host')!   as HTMLUListElement;
  const startGameBtn   = document.getElementById('start-game-btn')!     as HTMLButtonElement;
  const startPlayerEl  = document.getElementById('start-player-display')! as HTMLParagraphElement;

  const joinLobby      = document.getElementById('join-lobby')!         as HTMLDivElement;
  const peerIdInput    = document.getElementById('peer-id-input')!      as HTMLInputElement;
  const joinBtn        = document.getElementById('join-btn')!           as HTMLButtonElement;
  const joinListEl     = document.getElementById('player-list-join')!   as HTMLUListElement;

  const playerView     = document.getElementById('player-view')!        as HTMLDivElement;
  const roleTitle      = document.getElementById('role-title')!         as HTMLHeadingElement;
  const wordDisplay    = document.getElementById('word-display')!       as HTMLParagraphElement;
  const timerEl        = document.getElementById('timer')!              as HTMLDivElement;
  const stopBtn        = document.getElementById('stop-btn')!           as HTMLButtonElement;
  const gameListEl     = document.getElementById('player-list-game')!   as HTMLUListElement;
  const restartBtn     = document.getElementById('restart-btn')!        as HTMLButtonElement;

  // ─── Types & State ────────────────────────────────────────────────────
  type PlayerInfo       = { id: string; name: string; role: 'normal'|'undercover' };
  type PlayerConnection = { id: string; name: string; conn: DataConnection };

  let peer: Peer;
  let connections: PlayerConnection[] = [];
  let isHost    = false;
  let myName    = '';
  let myInfo: PlayerInfo | null = null;
  let players: PlayerInfo[] = [];
  let eliminatedIds: string[] = [];
  let voteCounts: Record<string, number> = {};
  let votesCast: Set<string> = new Set();
  let votedTarget: string | null = null;
  let timerInterval: number;
  let remainingTime: number;
  let currentPair: WordPair;
  let myConn!: DataConnection;

  // ─── PeerJS-Options ──────────────────────────────────────────────────
  const peerOptions = {
    host:     location.hostname,
    //port:     9000,
    path:     '/peerjs',
    secure:   location.protocol === 'https:',
    key:      'peerjs'
  };

  // ─── Utils ────────────────────────────────────────────────────────────
  function renderList(el: HTMLUListElement, votePhase = false) {
    el.innerHTML = '';
    players.forEach(p => {
      const li = document.createElement('li');
      li.textContent = p.name;
      li.dataset.id = p.id;
      if (eliminatedIds.includes(p.id)) li.classList.add('eliminated');
      if (votePhase && !eliminatedIds.includes(p.id) && p.id !== peer.id) {
        li.classList.add('votable');
        li.onclick = () => vote(p.id);
      }
      if (p.id === votedTarget) li.classList.add('voted');
      el.appendChild(li);
    });
  }

  function broadcastPlayerList() {
    renderList(hostListEl);
    connections.forEach(({ conn }) => {
      if (conn.open) conn.send({
        type: 'player-list',
        players: players.map(p => ({ id: p.id, name: p.name }))
      });
    });
  }

  function pickRandomPair(): WordPair {
    return wordPairs[Math.floor(Math.random() * wordPairs.length)];
  }

  // ─── Round Logic ─────────────────────────────────────────────────────
  function startRound() {
    eliminatedIds = [];
    votesCast.clear();
    voteCounts = {};
    votedTarget = null;

    if (isHost) {
      // Assign roles
      const all = players.slice();
      const ucIdx = Math.floor(Math.random() * all.length);
      all.forEach((p,i) => p.role = i === ucIdx ? 'undercover' : 'normal');
      players = all;

      // New word-pair
      currentPair = pickRandomPair();

      // Broadcast start
      connections.forEach(({ conn }) => {
        if (conn.open) conn.send({ type: 'start', players, pair: currentPair });
      });

      // Host self-info
      myInfo = players.find(p => p.id === peer.id)!;
      const starter = players[Math.floor(Math.random() * players.length)].name;
      startPlayerEl.textContent = `Startspieler: ${starter}`;
    }

    showGameScreen();
  }

  function showGameScreen() {
    stepRole.style.display  = 'none';
    hostLobby.style.display = 'none';
    joinLobby.style.display = 'none';
    playerView.style.display = 'block';

    // own role & word
    roleTitle.textContent  = `Du bist ${myInfo!.role==='undercover'?'UNDERCOVER':'normaler Spieler'}!`;
    wordDisplay.textContent = `Dein Wort: ${ myInfo!.role==='undercover'
      ? currentPair.undercover
      : currentPair.common }`;

    renderList(gameListEl);

    // timer
    remainingTime = players.length * 60;
    clearInterval(timerInterval);
    timerEl.textContent = `Zeit: ${formatTime(remainingTime)}`;
    timerEl.style.display = '';
    stopBtn.style.display = isHost ? 'block' : 'none';

    timerInterval = window.setInterval(() => {
      remainingTime--;
      timerEl.textContent = `Zeit: ${formatTime(remainingTime)}`;
      if (remainingTime <= 0 && isHost) {
        clearInterval(timerInterval);
        beginVote();
        connections.forEach(({ conn }) => conn.send({ type: 'vote-start' }));
      }
    }, 1000);
  }

  function beginVote() {
    clearInterval(timerInterval);
    votesCast.clear();
    voteCounts = {};
    votedTarget = null;
    stopBtn.style.display = 'none';
    renderList(gameListEl, true);
  }

  function recordVote(voterId: string, targetId: string) {
    if (votesCast.has(voterId)) return;
    votesCast.add(voterId);
    voteCounts[targetId] = (voteCounts[targetId]||0) + 1;

    if (votesCast.size >= players.length - eliminatedIds.length) {
      endVoting();
    }
  }

  function endVoting() {
    clearInterval(timerInterval);
    // tally …
    const max = Math.max(...Object.values(voteCounts));
    const top = Object.entries(voteCounts).filter(([,v]) => v===max).map(([id])=>id);
    const elim = top[Math.floor(Math.random()*top.length)];
    eliminatedIds.push(elim);

    const uc = players.find(p=>p.role==='undercover')!;
    const out = players.find(p=>p.id===elim)!;
    const survivors = players.length - eliminatedIds.length;

    let msg: string;
    if (out.role==='undercover') {
      msg = `Die normalen Spieler haben gewonnen! Undercover war ${uc.name}.`;
    } else if (survivors<=2) {
      msg = `Der Undercover hat gewonnen! Undercover war ${uc.name}.`;
    } else {
      renderList(gameListEl);
      return;
    }

    connections.forEach(({ conn }) => {
      if (conn.open) conn.send({ type: 'game-end', message: msg });
    });
    showEnd(msg);
  }

  function showEnd(msg: string) {
    roleTitle.textContent   = msg;
    wordDisplay.textContent = '';
    timerEl.style.display   = 'none';
    stopBtn.style.display   = 'none';
    renderList(gameListEl);
    if (isHost) restartBtn.style.display = 'block';
  }

  function vote(targetId: string) {
    if (votesCast.has(peer.id)) return;
    votesCast.add(peer.id);
    votedTarget = targetId;
    renderList(gameListEl, true);

    if (isHost) {
      recordVote(peer.id, targetId);
    } else {
      myConn.send({ type: 'vote', voterId: peer.id, targetId });
    }
  }

  // ─── Onboarding & Init ───────────────────────────────────────────────
  chooseHostBtn.onclick = () => {
    isHost = true;
    stepRole.style.display = 'none';
    chosenRoleText.textContent = 'Du bist jetzt Host.';
    stepName.style.display = 'block';
  };
  chooseJoinBtn.onclick = () => {
    isHost = false;
    stepRole.style.display = 'none';
    chosenRoleText.textContent = 'Du trittst als Spieler bei.';
    stepName.style.display = 'block';
  };
  submitNameBtn.onclick = () => {
    myName = nameInput.value.trim();
    if (!myName) {
      alert('Bitte gib deinen Namen ein.');
      return;
    }
    stepName.style.display = 'none';
    isHost ? initHost() : initJoiner();
  };

  function initHost() {
    peer = new Peer(undefined as any, peerOptions);
    peer.on('open', (id) => {
  hostIdSpan.textContent = id;
  hostLobby.style.display = 'block';

  // ➡️ Hier der neue Code:
  copyLinkBtn.disabled = false;
  copyLinkBtn.onclick = () => {
    const link = `${location.protocol}//${location.host}${location.pathname}?host=${id}`;
    navigator.clipboard.writeText(link).then(() => {
      copyLinkBtn.textContent = 'Link kopiert!';
      setTimeout(() => {
        copyLinkBtn.textContent = 'Einladungslink kopieren';
      }, 2000);
    });
  };
  // ⬅️ Ende neuer Code

  players = [{ id, name: myName, role: 'normal' }];
  renderList(hostListEl, false);
});

    peer.on('connection', conn => {
      conn.on('open', () => conn.send({ type: 'request-intro' }));
      conn.on('data', data => {
        if (isMessage(data) && data.type==='intro' && !connections.some(p=>p.id===conn.peer)) {
          connections.push({ id: conn.peer, name: data.name, conn });
          players.push({ id: conn.peer, name: data.name, role: 'normal' });
          broadcastPlayerList();
        }
        if (isMessage(data) && data.type==='vote') {
          recordVote(data.voterId, data.targetId);
        }
      });
      conn.on('close', () => {
        connections = connections.filter(p=>p.id!==conn.peer);
        players     = players.filter(p=>p.id!==conn.peer);
        broadcastPlayerList();
      });
    });

    startGameBtn.onclick = () => startRound();
    restartBtn.onclick  = () => startRound();
  }

  function initJoiner() {
    peer = new Peer(undefined as any, peerOptions);
    joinLobby.style.display = 'block';

    peer.on('open', ownId => {
      const auto = getParam('host');
      const doJoin = () => {
        const hostId = peerIdInput.value.trim();
        if (!hostId) return alert('Join-Code fehlt!');
        if (hostId===ownId) return alert('Du darfst nicht dich selbst joinen.');
        myConn = peer.connect(hostId);
        myConn.on('open', ()=> myConn.send({ type:'intro', name:myName }));
        myConn.on('data', raw => {
          if (!isMessage(raw)) return;
          switch(raw.type) {
            case 'player-list':
              players = (raw.players as any[]).map(p=>({ ...p, role:'normal' }));
              renderList(joinListEl);
              break;
            case 'start':
              players = raw.players as PlayerInfo[];
              currentPair = raw.pair as WordPair;
              myInfo = players.find(p=>p.id===peer.id)!;
              eliminatedIds = []; votesCast.clear(); voteCounts = {}; votedTarget = null;
              showGameScreen();
              break;
            case 'vote-start':
              beginVote();
              break;
            case 'elimination':
              eliminatedIds.push(raw.targetId);
              renderList(gameListEl,true);
              break;
            case 'game-end':
              showEnd(raw.message);
              break;
          }
        });
        myConn.on('close', ()=>{
          alert('Verbindung zum Host verloren.');
          window.location.reload();
        });
      };

      // Auto-join if URL contains ?host=PEER_ID
      if (auto) {
        peerIdInput.value = auto;
        doJoin();
      }
      joinBtn.onclick = doJoin;
    });
  }
});
