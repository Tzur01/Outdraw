const partyCodeEl = document.getElementById("partyCode");
const playerList = document.getElementById("playerList");
const lobbyError = document.getElementById("lobbyError");
const lobbyHostControls = document.getElementById("lobbyHostControls");
const startGameBtn = document.getElementById("startGameBtn");
const closePartyLobbyBtn = document.getElementById("closePartyLobbyBtn");
const nextRoundBtn = document.getElementById("nextRoundBtn");
const newGameBtn = document.getElementById("newGameBtn");
const closePartyResultsBtn = document.getElementById("closePartyResultsBtn");
const resultsHostControls = document.getElementById("resultsHostControls");
const resultsStatus = document.getElementById("resultsStatus");
const resultsPrompt = document.getElementById("resultsPrompt");
const resultsAi = document.getElementById("resultsAi");
const resultsList = document.getElementById("resultsList");
const promptOptionsEl = document.getElementById("promptOptions");
const promptPickHint = document.getElementById("promptPickHint");
const sceneHint = document.getElementById("sceneHint");
const sceneRole = document.getElementById("sceneRole");
const undoStrokeBtn = document.getElementById("undoStrokeBtn");
const gamePlayerList = document.getElementById("gamePlayerList");
const guessAttemptsBadge = document.getElementById("guessAttemptsBadge");
const drawCanvas = document.getElementById("drawCanvas");
const watchCanvas = document.getElementById("watchCanvas");
const guessArea = document.getElementById("guessArea");
const guessInput = document.getElementById("guessInput");
const guessBtn = document.getElementById("guessBtn");
const drawerNameEls = document.querySelectorAll("[data-drawer-name]");
const timerEls = document.querySelectorAll("[data-round-timer]");
const promptTextEls = document.querySelectorAll("[data-prompt-text]");
const lobbyView = document.getElementById("screenLobby");
const promptPickView = document.getElementById("screenPromptPick");
const gameplayView = document.getElementById("screenGameplay");
const resultsView = document.getElementById("screenResults");
const api = window.clientApi.getApi();

let selfId = null;
let isHost = false;
let currentPrompt = null;
let currentPromptOptions = [];
let currentStatus = "lobby";
let currentDrawerId = null;
let currentRoom = null;
let timerInterval = null;
let isDrawing = false;
let lastPoint = null;
let activePathId = null;
let queuedStrokes = [];
let strokeFlushTimer = null;
let guessAttemptsLeft = null;
let maxGuessAttempts = 3;
let guessLocked = false;
let disconnected = false;
let rejoinInFlight = false;

const STROKE_SEND_INTERVAL_MS = 16;       

const drawCtx = drawCanvas.getContext("2d");
drawCtx.lineWidth = 4;
drawCtx.lineCap = "round";
drawCtx.lineJoin = "round";
drawCtx.strokeStyle = "#111";

const watchCtx = watchCanvas.getContext("2d");
watchCtx.lineWidth = 4;
watchCtx.lineCap = "round";
watchCtx.lineJoin = "round";
watchCtx.strokeStyle = "#111";

function getAvatarFallback(player) {
  if (player && player.isAi) return "AI";
  const initial = String(player && player.name ? player.name : "?")
    .trim()
    .charAt(0);
  return (initial || "?").toUpperCase();
}

function createAvatarElement(player, extraClass = "") {
  const avatar = document.createElement("div");
  avatar.className = `playerAvatar${extraClass ? ` ${extraClass}` : ""}`;

  const fallback = document.createElement("span");
  fallback.textContent = getAvatarFallback(player);
  avatar.appendChild(fallback);

  if (player && player.avatar) {
    const img = document.createElement("img");
    img.src = player.avatar;
    img.alt = `${player.name} avatar`;
    img.loading = "lazy";
    img.addEventListener("load", () => {
      avatar.classList.add("has-image");
    });
    img.addEventListener("error", () => {
      img.remove();
      avatar.classList.remove("has-image");
    });
    avatar.appendChild(img);
    if (img.complete && img.naturalWidth > 0) {
      avatar.classList.add("has-image");
    }
  }

  return avatar;
}

function setError(message) {
  lobbyError.textContent = message || "";
}

function setTextAll(elements, value) {
  elements.forEach((el) => {
    el.textContent = value;
  });
}

function formatTime(ms) {
  if (!ms || ms <= 0) return "0";
  return Math.ceil(ms / 1000).toString();
}

function startTimer(endsAt) {
  if (timerInterval) clearInterval(timerInterval);
  if (!endsAt) {
    setTextAll(timerEls, "--");
    return;
  }
  const update = () => {
    const remaining = Math.max(0, endsAt - Date.now());
    setTextAll(timerEls, formatTime(remaining));
  };
  update();
  timerInterval = setInterval(update, 250);
}

function clearCanvas() {
  drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
  watchCtx.clearRect(0, 0, watchCanvas.width, watchCanvas.height);
}

function drawStroke(stroke, targetCtx, targetCanvas) {
  if (!stroke) return;
  const canvas = targetCanvas;
  const ctx = targetCtx;
  const x0 = stroke.x0 * canvas.width;
  const y0 = stroke.y0 * canvas.height;
  const x1 = stroke.x1 * canvas.width;
  const y1 = stroke.y1 * canvas.height;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

function setDrawingEnabled(enabled) {
  drawCanvas.style.pointerEvents = enabled ? "auto" : "none";
}

function setActiveScreen(target) {
  [
    lobbyView,
    promptPickView,
    gameplayView,
    resultsView
  ].forEach((screen) => {
    screen.classList.toggle("active", screen === target);
  });
}

function setGameplayRole(isDrawer) {
  gameplayView.classList.toggle("drawer-view", !!isDrawer);
  sceneRole.textContent = isDrawer ? "Role: Drawer" : "Role: Guesser";
  const showUndo = isDrawer && currentStatus === "drawing";
  undoStrokeBtn.style.display = showUndo ? "inline-flex" : "none";
  undoStrokeBtn.disabled = !showUndo;
}

function updateGuessBarVisibility(isDrawer) {
  if (currentStatus !== "drawing" && currentStatus !== "guessing") {
    guessArea.style.display = "none";
    guessAttemptsBadge.textContent = "";
    return;
  }

  if (isDrawer) {
    guessArea.style.display = "none";
    sceneHint.textContent = currentStatus === "drawing"
      ? "Draw clearly while guessers watch."
      : "Keep calm and let them guess.";
    return;
  }

  const attemptsLeft = guessAttemptsLeft == null
    ? maxGuessAttempts
    : guessAttemptsLeft;
  guessAttemptsBadge.textContent =
    `Attempts: ${attemptsLeft}/${maxGuessAttempts}`;
  if (guessLocked || attemptsLeft <= 0) {
    guessArea.style.display = "none";
    sceneHint.textContent = "No attempts left. Watch the sketch unfold.";
    return;
  }

  guessArea.style.display = "flex";
  sceneHint.textContent = currentStatus === "drawing"
    ? "Live guessing is open. Try now."
    : "Final seconds. Type a guess before time runs out.";
}

function renderPromptOptions(options) {
  promptOptionsEl.innerHTML = "";
  options.forEach((option) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = option;
    button.addEventListener("click", async () => {
      const response = await api.pickPrompt(option);
      if (!response.ok) {
        setError(response.error || "Unable to pick prompt.");
      }
    });
    promptOptionsEl.appendChild(button);
  });
}

function resetResults() {
  resultsStatus.textContent = "";
  resultsPrompt.textContent = "";
  resultsAi.textContent = "";
  resultsAi.style.display = "none";
  resultsList.innerHTML = "";
}

function updateHostControls(status) {
  lobbyHostControls.style.display = isHost && status === "lobby" ? "block" : "none";
  resultsHostControls.style.display =
    isHost && (status === "results" || status === "game_over")
      ? "block"
      : "none";
  nextRoundBtn.style.display = status === "results" ? "block" : "none";
  newGameBtn.style.display = status === "game_over" ? "block" : "none";
  closePartyResultsBtn.style.display =
    status === "results" || status === "game_over" ? "block" : "none";
}

function updateGameView(game) {
  if (!game) return;
  const nextStatus = game.status || "lobby";
  currentDrawerId = game.drawerId || null;
  if (typeof game.maxGuessAttempts === "number") {
    maxGuessAttempts = game.maxGuessAttempts;
  }
  if (typeof game.guessAttemptsLeft === "number") {
    guessAttemptsLeft = game.guessAttemptsLeft;
  } else if (nextStatus !== "drawing" && nextStatus !== "guessing") {
    guessAttemptsLeft = null;
  }
  guessLocked = !!game.guessLocked;

  if (nextStatus !== currentStatus && nextStatus === "drawing") {
    clearCanvas();
    currentPrompt = null;
  }
  if (nextStatus !== currentStatus && nextStatus === "guessing") {
    guessInput.value = "";
  }
  if (nextStatus !== currentStatus && nextStatus === "prompt_pick") {
    clearCanvas();
    currentPromptOptions = [];
    currentPrompt = null;
    resetResults();
  }
  currentStatus = nextStatus;

  setTextAll(drawerNameEls, game.drawerName || "-");
  startTimer(game.endsAt);
  updateHostControls(currentStatus);

  const isDrawer = game.drawerId === selfId;
  setGameplayRole(isDrawer);

  if (currentStatus === "lobby") {
    setActiveScreen(lobbyView);
    setTextAll(promptTextEls, "-");
    setDrawingEnabled(false);
    sceneHint.textContent = "";
    if (currentRoom) renderPlayers(currentRoom);
    return;
  }

  if (currentStatus === "prompt_pick") {
    setDrawingEnabled(false);
    const options = game.promptOptions || currentPromptOptions;
    if (isDrawer) {
      setActiveScreen(promptPickView);
      promptPickHint.textContent = "Choose one. Auto-pick in 15 seconds.";
      if (options && options.length) {
        renderPromptOptions(options);
        currentPromptOptions = options;
      }
    } else {
      setActiveScreen(gameplayView);
      setTextAll(promptTextEls, "-");
      guessArea.style.display = "none";
      sceneHint.textContent = "Waiting for the drawer to choose a prompt.";
    }
    if (currentRoom) renderPlayers(currentRoom);
    return;
  }

  if (currentStatus === "drawing") {
    setDrawingEnabled(isDrawer);
    setTextAll(
      promptTextEls,
      isDrawer
        ? currentPrompt || game.prompt || "-"
        : game.promptMasked || "-"
    );
    setActiveScreen(gameplayView);
    updateGuessBarVisibility(isDrawer);
    if (currentRoom) renderPlayers(currentRoom);
    return;
  }

  if (currentStatus === "guessing") {
    setDrawingEnabled(false);
    setTextAll(
      promptTextEls,
      isDrawer ? game.prompt || game.promptMasked || "-" : game.promptMasked || "-"
    );
    setActiveScreen(gameplayView);
    updateGuessBarVisibility(isDrawer);
    if (currentRoom) renderPlayers(currentRoom);
    return;
  }

  if (currentStatus === "results" || currentStatus === "game_over") {
    setDrawingEnabled(false);
    setActiveScreen(resultsView);
    resultsStatus.textContent =
      currentStatus === "game_over" ? "Game over" : "Round results";
    if (currentRoom) renderPlayers(currentRoom);
    return;
  }

  setActiveScreen(lobbyView);
  setTextAll(promptTextEls, "-");
  setDrawingEnabled(false);
  sceneHint.textContent = "";
  if (currentRoom) renderPlayers(currentRoom);
}

function renderPlayers(room) {
  currentRoom = room;
  partyCodeEl.textContent = room.code;
  const renderList = (target) => {
    target.innerHTML = "";
    room.players.forEach((player) => {
      const item = document.createElement("li");
      const tags = [];
      if (player.id === room.hostId) tags.push("host");
      if (currentDrawerId && player.id === currentDrawerId) {
        tags.push("drawer");
      } else if (currentStatus === "guessing") {
        tags.push("guesser");
      }
      if (player.isAi) tags.push("devil rival");

      const row = document.createElement("div");
      row.className = "playerRow";
      if (player.id === selfId) row.classList.add("is-self");
      if (player.isAi) row.classList.add("is-ai-rival");

      const avatar = createAvatarElement(player);

      const meta = document.createElement("div");
      meta.className = "playerMeta";
      const nameEl = document.createElement("div");
      nameEl.className = "playerName";
      nameEl.textContent = player.name;
      meta.appendChild(nameEl);
      if (tags.length) {
        const tagsEl = document.createElement("div");
        tagsEl.className = "playerTags";
        tagsEl.textContent = tags.join(" • ");
        meta.appendChild(tagsEl);
      }

      row.appendChild(avatar);
      row.appendChild(meta);
      item.appendChild(row);
      target.appendChild(item);
    });
  };

  renderList(playerList);
  renderList(gamePlayerList);
  isHost = room.hostId === selfId;
  startGameBtn.disabled = !isHost;
  nextRoundBtn.disabled = !isHost;
  newGameBtn.disabled = !isHost;
  closePartyLobbyBtn.disabled = !isHost;
  closePartyResultsBtn.disabled = !isHost;
  updateHostControls(currentStatus);
}

async function initLobby() {
  try {
    await api.connect();
  } catch (error) {
    setError("Server not available.");
    return;
  }

  const code = localStorage.getItem("partyCode");
  const name = localStorage.getItem("playerName");

  if (!code || !name) {
    setError("Missing party details. Return to the join screen.");
    return;
  }

  partyCodeEl.textContent = code;

  const joinResponse = await api.joinParty(code, name);
  if (!joinResponse.ok) {
    setError(joinResponse.error || "Unable to join lobby.");
    return;
  }

  if (joinResponse.room) {
    selfId = joinResponse.playerId;
    renderPlayers(joinResponse.room);
    if (joinResponse.room.game) {
      updateGameView(joinResponse.room.game);
    }
  }

  const rejoinRoom = async () => {
    if (rejoinInFlight) return;
    rejoinInFlight = true;
    try {
      const response = await api.joinParty(code, name);
      if (!response.ok) {
        setError(
          `Reconnection failed: ${response.error || "Unable to rejoin room."}`
        );
        return;
      }
      selfId = response.playerId;
      setError("");
      if (response.room) {
        renderPlayers(response.room);
        if (response.room.game) {
          updateGameView(response.room.game);
        }
      }
    } finally {
      rejoinInFlight = false;
    }
  };

  api.onSocketDisconnect(() => {
    disconnected = true;
    setError("Connection lost. Reconnecting...");
  });

  api.onSocketConnect(async () => {
    if (!disconnected) return;
    disconnected = false;
    await rejoinRoom();
  });

  api.onRoomUpdate((room) => {
    renderPlayers(room);
  });

  api.onGameUpdate((game) => {
    updateGameView(game);
  });

  api.onPromptOptions(({ options }) => {
    currentPromptOptions = options || [];
    if (currentStatus === "prompt_pick") {
      renderPromptOptions(currentPromptOptions);
    }
  });

  api.onPrompt(({ prompt }) => {
    currentPrompt = prompt;
    if (currentStatus === "drawing") {
      setTextAll(promptTextEls, prompt);
    }
  });

  api.onDrawStroke(({ stroke }) => {
    drawStroke(stroke, watchCtx, watchCanvas);
  });
  api.onDrawReset(({ strokes }) => {
    clearCanvas();
    if (!strokes || !strokes.length) return;
    strokes.forEach((stroke) => {
      drawStroke(stroke, watchCtx, watchCanvas);
      if (currentDrawerId === selfId) {
        drawStroke(stroke, drawCtx, drawCanvas);
      }
    });
  });

  api.onRoundResults(({
    prompt,
    correctGuessers,
    scores,
    drawerBonus,
    winner,
    aiGuess,
    aiConfidence,
    aiCorrect
  }) => {
    resultsPrompt.textContent = `Answer: ${prompt}`;
    resultsAi.textContent = "";
    resultsAi.style.display = "none";
    if (aiGuess) {
      const displayGuess = aiGuess.replace(/_/g, " ");
      const verdict = aiCorrect ? "correct" : "wrong";
      const percent = Math.round((aiConfidence || 0) * 100);
      resultsAi.textContent = `SketchBot guessed "${displayGuess}" (${verdict} - ${percent}% confidence)`;
      resultsAi.style.display = "block";
    }

    const correctById = new Map();
    (correctGuessers || []).forEach((entry) => {
      if (entry && entry.id) {
        correctById.set(entry.id, entry);
      }
    });
    const baseStatus = currentStatus === "game_over"
      ? "Game over"
      : "Round results";
    if (winner && winner.type === "single" && winner.player) {
      resultsStatus.textContent =
        `${baseStatus} - Winner: ${winner.player.name}`;
    } else if (winner && winner.type === "tie" && Array.isArray(winner.players)) {
      const names = winner.players.map((entry) => entry.name).join(", ");
      resultsStatus.textContent = `${baseStatus} - Tie: ${names}`;
    } else if (correctById.size > 0) {
      resultsStatus.textContent =
        `${baseStatus} - ${correctById.size} solved`;
    } else {
      resultsStatus.textContent = `${baseStatus} - No correct guesses`;
    }

    resultsList.innerHTML = "";
    resultsList.classList.add("resultsBoard");
    if (scores && scores.length > 0) {
      scores.forEach((player, index) => {
        const item = document.createElement("li");
        item.className = "resultCard";
        if (player.id === selfId) item.classList.add("is-self");
        if (player.isAi) item.classList.add("is-ai-rival");

        const rank = document.createElement("div");
        rank.className = "resultRank";
        rank.textContent = `#${index + 1}`;

        const identity = document.createElement("div");
        identity.className = "resultIdentity";

        const avatar = createAvatarElement(player, "resultAvatar");
        const meta = document.createElement("div");
        meta.className = "resultMeta";
        const nameEl = document.createElement("div");
        nameEl.className = "resultName";
        nameEl.textContent = player.name;
        const roleEl = document.createElement("div");
        roleEl.className = "resultRole";
        if (player.id === selfId) {
          roleEl.textContent = "you";
        } else if (player.isAi) {
          roleEl.textContent = "devil rival";
        } else {
          roleEl.textContent = "player";
        }
        meta.appendChild(nameEl);
        meta.appendChild(roleEl);
        identity.appendChild(avatar);
        identity.appendChild(meta);

        const scoreEl = document.createElement("div");
        scoreEl.className = "resultScore";
        scoreEl.textContent = `${player.score} pts`;

        const badges = document.createElement("div");
        badges.className = "resultBadges";

        const solved = correctById.get(player.id);
        if (solved) {
          const badge = document.createElement("span");
          badge.className = "resultBadge correct";
          badge.textContent = `Solved +${solved.points || 0}`;
          badges.appendChild(badge);
        }
        if (player.id === currentDrawerId && drawerBonus > 0) {
          const badge = document.createElement("span");
          badge.className = "resultBadge drawer";
          badge.textContent = `Drawer +${drawerBonus}`;
          badges.appendChild(badge);
        }
        if (winner) {
          const won =
            (winner.type === "single" &&
              winner.player &&
              winner.player.id === player.id) ||
            (winner.type === "tie" &&
              Array.isArray(winner.players) &&
              winner.players.some((entry) => entry.id === player.id));
          if (won) {
            const badge = document.createElement("span");
            badge.className = "resultBadge winner";
            badge.textContent = "Winner";
            badges.appendChild(badge);
          }
        }

        item.appendChild(rank);
        item.appendChild(identity);
        item.appendChild(scoreEl);
        item.appendChild(badges);
        resultsList.appendChild(item);
      });
    } else {
      const item = document.createElement("li");
      item.className = "resultCard";
      item.textContent = "No score data yet.";
      resultsList.appendChild(item);
    }
  });

  api.onRoomClosed(() => {
    setError("Party closed by host.");
    localStorage.removeItem("partyCode");
    localStorage.removeItem("playerName");
    setTimeout(() => {
      window.location.href = "index.html";
    }, 800);
  });

  const state = await api.getState();
  if (state.ok) {
    renderPlayers(state.room);
    if (state.room.game) {
      updateGameView(state.room.game);
    }
  }
}

startGameBtn.addEventListener("click", async () => {
  setError("");
  clearCanvas();
  currentPrompt = null;
  currentPromptOptions = [];
  const response = await api.startRound();
  if (!response.ok) {
    setError(response.error || "Unable to start game.");
  }
});

nextRoundBtn.addEventListener("click", async () => {
  setError("");
  clearCanvas();
  currentPrompt = null;
  currentPromptOptions = [];
  const response = await api.startRound();
  if (!response.ok) {
    setError(response.error || "Unable to start round.");
  }
});

newGameBtn.addEventListener("click", async () => {
  setError("");
  clearCanvas();
  currentPrompt = null;
  currentPromptOptions = [];
  const response = await api.startNewGame();
  if (!response.ok) {
    setError(response.error || "Unable to start new game.");
  }
});

function handleCloseParty() {
  return async () => {
    setError("");
    const response = await api.closeParty();
    if (!response.ok) {
      setError(response.error || "Unable to close party.");
      return;
    }
    localStorage.removeItem("partyCode");
    localStorage.removeItem("playerName");
    window.location.href = "index.html";
  };
}

closePartyLobbyBtn.addEventListener("click", handleCloseParty());
closePartyResultsBtn.addEventListener("click", handleCloseParty());

guessBtn.addEventListener("click", async () => {
  setError("");
  if (currentStatus !== "drawing" && currentStatus !== "guessing") return;
  const attemptsLeft = guessAttemptsLeft == null
    ? maxGuessAttempts
    : guessAttemptsLeft;
  if (guessLocked || attemptsLeft <= 0) {
    setError("No guess attempts left.");
    return;
  }
  const guess = guessInput.value.trim();
  if (!guess) {
    setError("Enter a guess.");
    return;
  }
  const response = await api.submitGuess(guess);
  if (!response.ok) {
    setError(response.error || "Unable to submit guess.");
    return;
  }
  guessAttemptsLeft = response.attemptsLeft;
  guessLocked = !!response.locked;
  guessInput.value = "";
  if (response.correct) {
    sceneHint.textContent = `Correct! +${response.points} points.`;
  } else {
    setError(`Not correct. ${response.attemptsLeft} attempts left.`);
  }
  updateGuessBarVisibility(false);
});

drawCanvas.addEventListener("pointerdown", (event) => {
  if (currentStatus !== "drawing") return;
  isDrawing = true;
  activePathId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const rect = drawCanvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;
  lastPoint = { x, y };
});

drawCanvas.addEventListener("pointermove", (event) => {
  if (!isDrawing || currentStatus !== "drawing") return;
  const rect = drawCanvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;
  const stroke = {
    x0: lastPoint.x,
    y0: lastPoint.y,
    x1: x,
    y1: y,
    pathId: activePathId
  };
  drawStroke(stroke, drawCtx, drawCanvas);
  queueStrokeForNetwork(stroke);
  lastPoint = { x, y };
});

function stopDrawing() {
  if (queuedStrokes.length) {
    const pendingBatch = queuedStrokes;
    queuedStrokes = [];
    pendingBatch.forEach((stroke) => {
      api.sendStroke(stroke);
    });
  }
  if (strokeFlushTimer) {
    clearTimeout(strokeFlushTimer);
    strokeFlushTimer = null;
  }
  isDrawing = false;
  activePathId = null;
  lastPoint = null;
}

function queueStrokeForNetwork(stroke) {
  queuedStrokes.push(stroke);
  if (strokeFlushTimer) return;
  strokeFlushTimer = setTimeout(() => {
    const toSend = queuedStrokes;
    queuedStrokes = [];
    toSend.forEach((queuedStroke) => {
      api.sendStroke(queuedStroke);
    });
    strokeFlushTimer = null;
  }, STROKE_SEND_INTERVAL_MS);
}

undoStrokeBtn.addEventListener("click", async () => {
  if (currentStatus !== "drawing") return;
  if (strokeFlushTimer) {
    clearTimeout(strokeFlushTimer);
    strokeFlushTimer = null;
  }
  if (queuedStrokes.length) {
    const pendingBatch = queuedStrokes;
    queuedStrokes = [];
    await Promise.all(pendingBatch.map((stroke) => api.sendStroke(stroke)));
  }
  const response = await api.undoLastStroke();
  if (!response || !response.ok) {
    setError((response && response.error) || "Unable to undo stroke.");
  }
});

drawCanvas.addEventListener("pointerup", stopDrawing);
drawCanvas.addEventListener("pointerleave", stopDrawing);
drawCanvas.addEventListener("pointercancel", stopDrawing);

initLobby();
