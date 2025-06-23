// src/main.ts
import Peer from 'peerjs';
import type { DataConnection } from 'peerjs';
import { wordPairs, type WordPair } from './data/wordpairs';

window.addEventListener('DOMContentLoaded', () => {
  // ─── Helpers ────────────────────────────────────────────────
  function getParam(name: string): string | null {
    return new URLSearchParams(window.location.search).get(name);
  }

  function isMessage(d: unknown): d is { type: string; [k: string]: any } {
    return typeof d === 'object' && d !== null && 'type' in d;
  }

  function formatTime(sec: number): string {
    const m = String(Math.floor(sec / 60)).padStart(2, '0');
    const s = String(sec % 60).padStart(2, '0');
    return `${m}:${s}`;
  }

  function copyToClipboard(text: string): Promise<void> {
    if (navigator.clipboard?.writeText) {
      return navigator.clipboard.writeText(text);
    }
    // Fallback für HTTP
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'absolute';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    return Promise.resolve();
  }

  // ─── DOM Elements ──────────────────────────────────────────────
  const stepRole      = document.getElementById('step-role')!          as HTMLDivElement;
  const chooseHostBtn = document.getElementById('choose-host')!       as HTMLButtonElement;
  const chooseJoinBtn = document.getElementById('choose-join')!       as HTMLButtonElement;

  const stepName       = document.getElementById('step-name')!         as HTMLDivElement;
  const chosenRoleText = document.getElementById('chosen-role-text')!  as HTMLParagraphElement;
  const nameInput      = document.getElementById('player-name-input')! as HTMLInputElement;
  const submitNameBtn  = document.getElementById('submit-name')!      as HTMLButtonElement;

  const hostLobby      = document.getElementById('host-lobby')!        as HTMLDivElement;
  const hostIdSpan     = document.getElementById('host-peer-id')!      as HTMLSpanElement;
  const copyLinkBtn    = document.getElementById('copy-link-btn')!     as HTMLButtonElement;
  const hostListEl     = document.getElementById('player-list-host')!  as HTMLUListElement;
  const startGameBtn   = document.getElementById('start-game-btn')!    as HTMLButtonElement;
  const startPlayerEl  = document.getElementById('start-player-display')! as HTMLParagraphElement;

  const joinLobby   = document.getElementById('join-lobby')!        as HTMLDivElement;
  const peerIdInput = document.getElementById('peer-id-input')!     as HTMLInputElement;
  const joinBtn     = document.getElementById('join-btn')!          as HTMLButtonElement;
  const joinListEl  = document.getElementById('player-list-join')!  as HTMLUListElement;

  const playerView  = document.getElementById('player-view')!       as HTMLDivElement;
  const roleTitle   = document.getElementById('role-title')!        as HTMLHeadingElement;
  const wordDisplay = document.getElementById('word-display')!      as HTMLParagraphElement;
  const timerEl     = document.getElementById('timer')!             as HTMLDivElement;
  const stopBtn     = document.getElementById('stop-btn')!          as HTMLButtonElement;
  const gameListEl  = document.getElementById('player-list-game')!  as HTMLUListElement;
  const restartBtn  = document.getElementById('restart-btn')!       as HTMLButtonElement;

  // ─── Types & State ────────────────────────────────────────────────
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
  let timerInterval!: number;
  let remainingTime = 0;
  let currentPair!: WordPair;
  let myConn!: DataConnection;

  // ─── PeerJS-Options ────────────────────────────────────────────────
  const peerOptions = {
    host:   location.hostname,
    port:   location.port ? Number(location.port) : (location.protocol === 'https:' ? 443 : 80),
    path:   '/peerjs',
    secure: location.protocol === 'https:'
  };

  // ─── Utils ──────────────────────────────────────────────────────────
  function renderList(el: HTMLUListElement, votePhase = false) {
    el.innerHTML = '';
    players.forEach(p => {
      const li = document.createElement('li');
      li.textContent = p.name;
      li.dataset.id = p.id;
      if (eliminatedIds.includes(p.id)) li.classList.add('eliminated');
      if (votePhase && !eliminatedIds.includes(p.id) && p.id !== peer.id) {
        li.classList.add('votable');
        li.addEventListener('click', () => vote(p.id));
      }
      //if (p.id === votedTarget) li.classList.add('voted');
      if (votePhase && p.id === votedTarget) li.classList.add('voted'); //Haken nur während der Abstimmung
      el.appendChild(li);
    });
  }

  function broadcastPlayerList() {
    renderList(hostListEl);
    connections.forEach(({ conn }) => {
      if (conn.open) conn.send({
        type: 'player-list',
        players: players.map(({id,name}) => ({id,name}))
      });
    });
  }

  function pickRandomPair(): WordPair {
    return wordPairs[Math.floor(Math.random() * wordPairs.length)];
  }

  // ─── Round Logic ────────────────────────────────────────────────────
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

      // Host self-info & start player
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
    wordDisplay.textContent = `Dein Wort: ${myInfo!.role==='undercover'
      ? currentPair.undercover
      : currentPair.common}`;

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
        connections.forEach(({ conn }) => {
          if (conn.open) conn.send({ type: 'vote-start' });
        });
      }
    }, 1000);
  }

  // Stop-Button
  stopBtn.addEventListener('click', () => {
    console.log('❗ Stop-Button geklickt, isHost=', isHost);
    if (!isHost) return;
    clearInterval(timerInterval);
    beginVote();
    connections.forEach(({ conn }) => {
      if (conn.open) conn.send({ type: 'vote-start' });
    });
  });

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
    voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;

    if (votesCast.size >= players.length - eliminatedIds.length) {
      endVoting();
    }
  }

  /*function endVoting() {
    clearInterval(timerInterval);
    const max = Math.max(...Object.values(voteCounts));
    const top = Object.entries(voteCounts).filter(([,v]) => v === max).map(([id])=>id);
    const elim = top[Math.floor(Math.random()*top.length)];
    eliminatedIds.push(elim);

    const uc = players.find(p => p.role === 'undercover')!;
    const survivors = players.length - eliminatedIds.length;

    let msg: string;
    if (players.find(p=>p.id===elim)!.role === 'undercover') {
      msg = `Die normalen Spieler haben gewonnen! Undercover war ${uc.name}.`;
    } else if (survivors <= 2) {
      msg = `Der Undercover hat gewonnen! Undercover war ${uc.name}.`;
    } else {
      renderList(gameListEl);
      return;
    }

    connections.forEach(({ conn }) => {
      if (conn.open) conn.send({ type: 'game-end', message: msg });
    });
    showEnd(msg);
  }*/

    function endVoting() {
  clearInterval(timerInterval);

  // Ermittele meistgewählten Spieler
  const max = Math.max(...Object.values(voteCounts));
  const top = Object.entries(voteCounts).filter(([, v]) => v === max).map(([id]) => id);
  const elim = top[Math.floor(Math.random() * top.length)];
  eliminatedIds.push(elim);

  const eliminatedPlayer = players.find(p => p.id === elim)!;
  const undercoverPlayer = players.find(p => p.role === 'undercover')!;
  const survivors = players.length - eliminatedIds.length;

  // 🟥 Fall 1: Undercover wurde eliminiert → Spielende
  if (eliminatedPlayer.role === 'undercover') {
    const msg = `Die normalen Spieler haben gewonnen! Undercover war ${undercoverPlayer.name}.`;
    connections.forEach(({ conn }) => {
      if (conn.open) conn.send({ type: 'game-end', message: msg });
    });
    showEnd(msg);
    return;
  }

  // 🟥 Fall 2: Nur noch 2 Spieler → Undercover gewinnt
  if (survivors <= 2) {
    const msg = `Der Undercover hat gewonnen! Undercover war ${undercoverPlayer.name}.`;
    connections.forEach(({ conn }) => {
      if (conn.open) conn.send({ type: 'game-end', message: msg });
    });
    showEnd(msg);
    return;
  }

  // 🟨 Fall 3: Normaler Spieler eliminiert → Spiel geht weiter
  votedTarget = null;
  votesCast.clear();
  voteCounts = {};
  renderList(gameListEl); // Aktualisiere Spieler-UI

  // Informiere Clients über Eliminierung
  connections.forEach(({ conn }) => {
    if (conn.open) conn.send({ type: 'elimination', targetId: elim });
  });

  // ⏱️ Timer mit alter Restzeit weiterlaufen lassen
  if (isHost) {
    stopBtn.style.display = 'block';
    timerInterval = window.setInterval(() => {
      remainingTime--;
      timerEl.textContent = `Zeit: ${formatTime(remainingTime)}`;
      if (remainingTime <= 0) {
        clearInterval(timerInterval);
        beginVote();
        connections.forEach(({ conn }) => {
          if (conn.open) conn.send({ type: 'vote-start' });
        });
      }
    }, 1000);
  }
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
    if (votesCast.has(peer.id) || eliminatedIds.includes(peer.id)) return;
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
  chooseHostBtn.addEventListener('click', () => {
    isHost = true;
    stepRole.style.display = 'none';
    chosenRoleText.textContent = 'Du bist jetzt Host.';
    stepName.style.display = 'block';
  });

  chooseJoinBtn.addEventListener('click', () => {
    isHost = false;
    stepRole.style.display = 'none';
    chosenRoleText.textContent = 'Du trittst als Spieler bei.';
    stepName.style.display = 'block';
  });

  submitNameBtn.addEventListener('click', () => {
    myName = nameInput.value.trim();
    if (!myName) {
      alert('Bitte gib deinen Namen ein.');
      return;
    }
    stepName.style.display = 'none';
    if (isHost) initHost();
    else initJoiner();
  });

  function initHost() {
    peer = new Peer(undefined as any, peerOptions);
    peer.on('open', id => {
      hostIdSpan.textContent = id;
      hostLobby.style.display = 'block';

      // Einladungslink
      copyLinkBtn.disabled = false;
      copyLinkBtn.addEventListener('click', () => {
        const link = `${location.protocol}//${location.host}${location.pathname}?host=${id}`;
        copyToClipboard(link)
          .then(() => {
            copyLinkBtn.textContent = 'Link kopiert!';
            setTimeout(() => copyLinkBtn.textContent = 'Einladungslink kopieren', 2000);
          })
          .catch(err => {
            console.warn('Clipboard failed', err);
            alert('Kopieren fehlgeschlagen, bitte manuell kopieren.');
          });
      });

      players = [{ id, name: myName, role: 'normal' }];
      renderList(hostListEl);
    });

    peer.on('connection', conn => {
      conn.on('open', () => conn.send({ type: 'request-intro' }));
      conn.on('data', data => {
        if (!isMessage(data)) return;
        if (data.type === 'intro' && !connections.some(p=>p.id===conn.peer)) {
          connections.push({ id: conn.peer, name: data.name, conn });
          players.push({ id: conn.peer, name: data.name, role: 'normal' });
          broadcastPlayerList();
        }
        if (data.type === 'vote') {
          recordVote(data.voterId, data.targetId);
        }
      });
      conn.on('close', () => {
        connections = connections.filter(p=>p.id!==conn.peer);
        players     = players.filter(p=>p.id!==conn.peer);
        broadcastPlayerList();
      });
    });

    startGameBtn.addEventListener('click', () => {
      if (players.length < 3) {
        alert('Das Spiel kann erst gestartet werden, wenn mindestens 3 Spieler in der Lobby sind.');
        return;
      }
      startRound();
    });
    restartBtn.addEventListener('click', () => {
      restartBtn.style.display = 'none'; // Button ausblenden
      startRound();                      // Spiel starten
    });;
  }

  function initJoiner() {
    peer = new Peer(undefined as any, peerOptions);
    joinLobby.style.display = 'block';

    peer.on('open', ownId => {
      const auto = getParam('host');
      const doJoin = () => {
        const hostId = peerIdInput.value.trim();
        if (!hostId) return alert('Join-Code fehlt!');
        if (hostId === ownId) return alert('Du darfst nicht dich selbst joinen.');
        myConn = peer.connect(hostId);
        myConn.on('open', () => myConn.send({ type: 'intro', name: myName }));
        myConn.on('data', raw => {
          if (!isMessage(raw)) return;
          switch (raw.type) {
            case 'player-list':
              players = (raw.players as any[]).map(p => ({ ...p, role: 'normal' }));
              renderList(joinListEl);
              break;
            case 'start':
              players      = raw.players as PlayerInfo[];
              currentPair  = raw.pair as WordPair;
              myInfo       = players.find(p=>p.id===peer.id)!;
              eliminatedIds= []; votesCast.clear(); voteCounts={}; votedTarget=null;
              showGameScreen();
              break;
            case 'vote-start':
              beginVote();
              break;
            case 'elimination':
              eliminatedIds.push(raw.targetId);
              renderList(gameListEl, true);
              break;
            case 'game-end':
              showEnd(raw.message);
              break;
          }
        });
        myConn.on('close', () => {
          alert('Verbindung zum Host verloren.');
          window.location.reload();
        });
      };

      if (auto) {
        peerIdInput.value = auto;
        doJoin();
      }
      joinBtn.addEventListener('click', doJoin);
    });
  }
});
