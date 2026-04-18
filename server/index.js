const express = require("express");
const http = require("http");
const path = require("path");
const os = require("os");
const { Server } = require("socket.io");
const {
  ROOM_GRACE_MS,
  DRAW_MS,
  GUESS_MS,
  PROMPT_PICK_MS,
  GUESS_POINTS_MAX,
  GUESS_POINTS_MIN,
  GUESS_ORDER_PENALTY,
  DRAWER_POINTS_PER_CORRECT,
  MAX_GUESS_ATTEMPTS,
  PROMPT_OPTIONS_COUNT
} = require("./game/constants");
const { loadPrompts, getPromptOptions } = require("./game/prompts");
const SERVER_PORT = 3000;
const SERVER_HOST = "0.0.0.0";
const AI_PLAYER_ID = "ai:sketchbot";
const AI_PLAYER_NAME = "SketchBot";
const AVATARS_DIR = path.join(__dirname, "..", "renderer", "avatars");
const AVATAR_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".svg", ".webp"]);

// AI model dependencies (optional)
const fs = require("fs");
const { createCanvas } = require("canvas");

let tf = null;
let aiModel = null;
let aiClasses = [];
let aiReady = false;
let aiSupportsFileModel = false;
let avatarPool = [];

function loadAvatarPool() {
  try {
    const files = fs.readdirSync(AVATARS_DIR, { withFileTypes: true });
    avatarPool = files
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => AVATAR_EXTENSIONS.has(path.extname(name).toLowerCase()))
      .map((name) => `avatars/${name}`);
    console.log(`[avatars] loaded ${avatarPool.length} files`);
  } catch (err) {
    avatarPool = [];
    console.log("[avatars] directory not found, using placeholders only");
  }
}

function getAssignedAvatars(room) {
  const assigned = new Set();
  if (!room) return assigned;

  if (room.aiProfile && room.aiProfile.avatar) {
    assigned.add(room.aiProfile.avatar);
  }
  if (room.players) {
    room.players.forEach((player) => {
      if (player && player.avatar) {
        assigned.add(player.avatar);
      }
    });
  }
  return assigned;
}

function pickAvatar(room) {
  if (!avatarPool.length) return null;
  const assigned = getAssignedAvatars(room);
  const available = avatarPool.filter((avatar) => !assigned.has(avatar));
  const pool = available.length ? available : avatarPool;
  return pool[Math.floor(Math.random() * pool.length)];
}

function getAiProfile(room) {
  if (room.aiProfile) return room.aiProfile;
  return {
    id: AI_PLAYER_ID,
    name: AI_PLAYER_NAME,
    isAi: true,
    avatar: null
  };
}

function getPublicPlayer(room, playerId) {
  if (playerId === AI_PLAYER_ID) return getAiProfile(room);
  return room.players.get(playerId) || null;
}

function getPublicPlayers(room) {
  return [...Array.from(room.players.values()), getAiProfile(room)];
}

function ensureAiScore(room) {
  if (!room.game || !room.game.scores) return;
  if (!room.game.scores.has(AI_PLAYER_ID)) {
    room.game.scores.set(AI_PLAYER_ID, 0);
  }
}

loadAvatarPool();

function tryLoadTensorflow() {
  if (tf) return tf;
  try {
    // Prefer Node backend because local file:// model loading is faster.
    tf = require("@tensorflow/tfjs-node");
    aiSupportsFileModel = true;
    return tf;
  } catch (err) {
    try {
      // Pure JS fallback keeps app running and can load model via local HTTP.
      tf = require("@tensorflow/tfjs");
      aiSupportsFileModel = false;
      return tf;
    } catch (innerErr) {
      console.warn("[ai] TensorFlow not available. AI guesser disabled.");
      return null;
    }
  }
}

async function loadAiModel() {
  const tfLib = tryLoadTensorflow();
  if (!tfLib) return;
  try {
    const modelPath = aiSupportsFileModel
      ? `file://${path.join(__dirname, "model", "model.json")}`
      : `http://127.0.0.1:${SERVER_PORT}/model/model.json`;
    aiModel = await tfLib.loadLayersModel(modelPath);
    const txt = fs
      .readFileSync(path.join(__dirname, "model", "class_names.txt"), "utf-8");
    aiClasses = txt.split("\n").filter(Boolean);
    aiReady = true;
    const backendLabel = aiSupportsFileModel ? "tfjs-node/file" : "tfjs/http";
    console.log(`[ai] model loaded (${backendLabel}) with ${aiClasses.length} classes`);
  } catch (err) {
    console.error("[ai] Failed to load model:", err.message || err);
    aiReady = false;
  }
}

function clamp01(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  if (num < 0) return 0;
  if (num > 1) return 1;
  return num;
}

function strokesToTensor(strokes, size = 28) {
  if (!tf || !Array.isArray(strokes) || strokes.length === 0) return null;

  // Match DoodleClassifier preprocessing: draw on 280x280, then downscale to 28x28.
  const sourceSize = 280;
  const sourceCanvas = createCanvas(sourceSize, sourceSize);
  const sourceCtx = sourceCanvas.getContext("2d");
  sourceCtx.fillStyle = "#fff";
  sourceCtx.fillRect(0, 0, sourceSize, sourceSize);
  sourceCtx.lineWidth = 16;
  sourceCtx.lineCap = "round";
  sourceCtx.lineJoin = "round";
  sourceCtx.strokeStyle = "#000";

  strokes.forEach((s) => {
    const x0 = clamp01(s.x0) * sourceSize;
    const y0 = clamp01(s.y0) * sourceSize;
    const x1 = clamp01(s.x1) * sourceSize;
    const y1 = clamp01(s.y1) * sourceSize;
    sourceCtx.beginPath();
    sourceCtx.moveTo(x0, y0);
    sourceCtx.lineTo(x1, y1);
    sourceCtx.stroke();
  });

  const resizedCanvas = createCanvas(size, size);
  const resizedCtx = resizedCanvas.getContext("2d");
  resizedCtx.drawImage(sourceCanvas, 0, 0, size, size);

  const imgData = resizedCtx.getImageData(0, 0, size, size);
  const data = imgData.data;
  const arr = new Float32Array(size * size);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    const red = data[i];
    arr[j] = (255 - red) / 255;
  }
  return tf.tensor(arr, [1, size, size, 1]);
}

function predictFromStrokes(strokes) {
  if (!tf || !aiReady || !aiModel || !aiClasses.length) return null;
  const scores = tf.tidy(() => {
    const input = strokesToTensor(strokes);
    if (!input) return [];
    const logits = aiModel.predict(input);
    return Array.from(logits.dataSync());
  });
  if (!scores.length) return null;
  const limit = Math.min(scores.length, aiClasses.length);
  let bestIndex = -1;
  let bestScore = -Infinity;
  for (let i = 0; i < limit; i++) {
    const score = Number(scores[i]);
    if (!Number.isFinite(score)) continue;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }
  if (bestIndex < 0) return null;
  return { guess: aiClasses[bestIndex], confidence: bestScore };
}

function normalizeLabel(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, " ");
}

function buildPromptMask(prompt) {
  if (!prompt) return null;
  return String(prompt)
    .split("")
    .map((char) => (/[A-Za-z]/.test(char) ? "_" : char))
    .join(" ");
}

function getSortedScores(room) {
  return Array.from(room.game.scores.entries())
    .map(([id, score]) => {
      const player = getPublicPlayer(room, id);
      return {
        id,
        name: player ? player.name : "Unknown",
        score,
        isAi: !!(player && player.isAi),
        avatar: player ? player.avatar || null : null
      };
    })
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

function countCorrectGuesses(room) {
  let count = 0;
  room.game.guesses.forEach((entry) => {
    if (entry.correct) count += 1;
  });
  return count;
}

function isGuesserResolved(room, playerId) {
  const guess = room.game.guesses.get(playerId);
  if (guess && guess.correct) return true;
  const attemptsUsed =
    (room.game.guessAttempts && room.game.guessAttempts.get(playerId)) || 0;
  return attemptsUsed >= MAX_GUESS_ATTEMPTS;
}

function allGuessersResolved(room) {
  const guesserIds = Array.from(room.players.keys()).filter(
    (id) => id !== room.game.drawerId
  );
  if (guesserIds.length === 0) return false;
  return guesserIds.every((id) => isGuesserResolved(room, id));
}

function computeCorrectGuessPoints(room) {
  const remainingMs = Math.max(0, (room.game.endsAt || Date.now()) - Date.now());
  const phaseDuration = room.game.status === "drawing" ? DRAW_MS : GUESS_MS;
  const ratio = phaseDuration > 0 ? remainingMs / phaseDuration : 0;
  const timeDecayedCap = Math.round(
    GUESS_POINTS_MIN + (GUESS_POINTS_MAX - GUESS_POINTS_MIN) * ratio
  );
  const alreadyCorrect = countCorrectGuesses(room);
  const orderPenalty = alreadyCorrect * GUESS_ORDER_PENALTY;
  return Math.max(GUESS_POINTS_MIN, timeDecayedCap - orderPenalty);
}


const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  pingInterval: 20000,
  pingTimeout: 60000
});

app.use(express.static(path.join(__dirname, "..", "renderer")));
app.use("/model", express.static(path.join(__dirname, "model")));

const rooms = new Map();
const promptsPath = path.join(__dirname, "prompts.txt");
const fallbackPrompts = ["cat", "house", "tree", "pizza", "rocket", "guitar"];
const prompts = loadPrompts(promptsPath, fallbackPrompts);

function normalizePromptKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function getPromptOptionsForRoom(room, count) {
  if (!room || !room.game) return getPromptOptions(prompts, count);
  if (!room.game.usedPrompts) {
    room.game.usedPrompts = new Set();
  }

  const unusedPrompts = prompts.filter(
    (prompt) => !room.game.usedPrompts.has(normalizePromptKey(prompt))
  );

  if (!unusedPrompts.length) {
    // Keep rounds playable if the prompt pool is exhausted.
    room.game.usedPrompts = new Set();
    return getPromptOptions(prompts, count);
  }

  return getPromptOptions(unusedPrompts, count);
}

function generateCode() {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let code = "";
  for (let i = 0; i < 4; i += 1) {
    code += letters[Math.floor(Math.random() * letters.length)];
  }
  return code;
}

function getUniqueCode() {
  let code = generateCode();
  while (rooms.has(code)) {
    code = generateCode();
  }
  return code;
}

function toRoomPayload(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    round: room.round,
    roundActive: room.roundActive,
    players: getPublicPlayers(room),
    game: getGamePublic(room)
  };
}

function toRoomPayloadForSelf(room, selfId) {
  return {
    code: room.code,
    hostId: room.hostId,
    round: room.round,
    roundActive: room.roundActive,
    players: getPublicPlayers(room),
    selfId,
    game: getGamePublic(room, selfId)
  };
}

function getGamePublic(room, selfId) {
  const game = room.game;
  if (!game) {
    return {
      status: "lobby",
      roundNumber: 0,
      drawerId: null,
      drawerName: null,
      endsAt: null,
      promptMasked: null,
      prompt: null,
      promptOptions: null,
      scores: [],
      isLastRound: false,
      maxGuessAttempts: MAX_GUESS_ATTEMPTS,
      guessAttemptsLeft: null,
      guessLocked: false
    };
  }
  ensureAiScore(room);

  const drawer = room.players.get(game.drawerId);
  const promptMasked = buildPromptMask(game.prompt);
  const isDrawer = selfId && selfId === game.drawerId;

  const scores = Array.from(game.scores.entries()).map(([id, score]) => {
    const player = getPublicPlayer(room, id);
    return {
      id,
      name: player ? player.name : "Unknown",
      score,
      isAi: !!(player && player.isAi),
      avatar: player ? player.avatar || null : null
    };
  });
  const attemptsUsed = selfId ? ((game.guessAttempts && game.guessAttempts.get(selfId)) || 0) : 0;
  const ownGuess = selfId ? game.guesses.get(selfId) : null;
  const isGuesser =
    !!selfId &&
    (game.status === "drawing" || game.status === "guessing") &&
    selfId !== game.drawerId;
  const guessLocked = isGuesser
    ? !!(ownGuess && ownGuess.correct) || attemptsUsed >= MAX_GUESS_ATTEMPTS
    : false;

  return {
    status: game.status,
    roundNumber: game.roundNumber,
    drawerId: game.drawerId,
    drawerName: drawer ? drawer.name : null,
    endsAt: game.endsAt,
    promptMasked,
    prompt: isDrawer &&
      (game.status === "drawing" || game.status === "guessing")
      ? game.prompt
      : null,
    promptOptions: isDrawer && game.status === "prompt_pick"
      ? game.promptOptions
      : null,
    scores,
    isLastRound: !!game.isLastRound,
    maxGuessAttempts: MAX_GUESS_ATTEMPTS,
    guessAttemptsLeft: isGuesser
      ? Math.max(0, MAX_GUESS_ATTEMPTS - attemptsUsed)
      : null,
    guessLocked
  };
}

function sendDrawerPrivateState(socket, room) {
  if (!room.game || room.game.drawerId !== socket.id) return;
  if (room.game.status === "prompt_pick") {
    socket.emit("prompt_options", {
      options: room.game.promptOptions,
      endsAt: room.game.endsAt
    });
  }
  if (
    room.game.status === "drawing" ||
    room.game.status === "guessing"
  ) {
    socket.emit("prompt", { prompt: room.game.prompt });
  }
}

function emitGameUpdate(room) {
  room.players.forEach((_, playerId) => {
    io.to(playerId).emit("game_update", getGamePublic(room, playerId));
  });
  if (room.game && room.game.drawerId) {
    if (room.game.status === "prompt_pick") {
      io.to(room.game.drawerId).emit("prompt_options", {
        options: room.game.promptOptions,
        endsAt: room.game.endsAt
      });
    }
    if (
      room.game.status === "drawing" ||
      room.game.status === "guessing"
    ) {
      io.to(room.game.drawerId).emit("prompt", {
        prompt: room.game.prompt
      });
    }
  }
}

function emitGameUpdateFor(socket, room) {
  socket.emit("game_update", getGamePublic(room, socket.id));
  sendDrawerPrivateState(socket, room);
}

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = list[i];
    list[i] = list[j];
    list[j] = temp;
  }
  return list;
}

function rebuildDrawerQueue(room) {
  const ids = Array.from(room.players.keys()).filter(
    (id) => !room.game.drawnIds.has(id)
  );
  room.drawerQueue = shuffle(ids);
}

function enqueueDrawer(room, playerId) {
  if (room.game.drawnIds.has(playerId)) return;
  if (room.drawerQueue.includes(playerId)) return;
  room.drawerQueue.push(playerId);
}

function nextDrawer(room) {
  if (!room.drawerQueue || room.drawerQueue.length === 0) {
    rebuildDrawerQueue(room);
  }
  room.drawerQueue = room.drawerQueue.filter((id) => room.players.has(id));
  if (room.drawerQueue.length === 0) {
    rebuildDrawerQueue(room);
  }
  const next = room.drawerQueue.shift();
  if (next) {
    room.game.drawnIds.add(next);
  }
  return next;
}

function clearTimers(room) {
  if (room.game && room.game.timer) {
    clearTimeout(room.game.timer);
    room.game.timer = null;
  }
}

function startPromptPick(room) {
  if (!room.game) return;
  clearTimers(room);

  const drawerId = nextDrawer(room);
  if (!drawerId) {
    room.game.status = "lobby";
    room.game.drawerId = null;
    room.game.endsAt = null;
    emitGameUpdate(room);
    return;
  }

  room.game.roundNumber += 1;
  room.round = room.game.roundNumber;
  room.roundActive = true;
  room.game.status = "prompt_pick";
  room.game.drawerId = drawerId;
  room.game.prompt = null;
  room.game.promptOptions = getPromptOptionsForRoom(
    room,
    PROMPT_OPTIONS_COUNT
  );
  room.game.guesses = new Map();
  room.game.guessAttempts = new Map();
  room.game.strokes = []; // reset strokes for new round
  room.game.endsAt = Date.now() + PROMPT_PICK_MS;
  room.game.isLastRound = room.drawerQueue.length === 0;
  room.game.timer = setTimeout(() => {
    const autoPrompt = room.game.promptOptions[0];
    if (autoPrompt) {
      startDrawing(room, autoPrompt);
    }
  }, PROMPT_PICK_MS);

  const drawer = room.players.get(drawerId);
  console.log(
    `[round] ${room.code} #${room.game.roundNumber} prompt_pick drawer ${
      drawer ? drawer.name : drawerId
    }`
  );
  emitGameUpdate(room);
}

function startDrawing(room, prompt) {
  if (!room.game) return;
  clearTimers(room);
  room.game.status = "drawing";
  room.game.prompt = prompt;
  if (!room.game.usedPrompts) {
    room.game.usedPrompts = new Set();
  }
  room.game.usedPrompts.add(normalizePromptKey(prompt));
  room.game.endsAt = Date.now() + DRAW_MS;
  room.game.timer = setTimeout(() => startGuessing(room), DRAW_MS);
  console.log(`[round] ${room.code} drawing started`);
  emitGameUpdate(room);
  if (room.game.drawerId) {
    io.to(room.game.drawerId).emit("prompt", { prompt });
  }
}

function startGuessing(room) {
  if (!room.game) return;
  clearTimers(room);
  room.game.status = "guessing";
  room.game.endsAt = Date.now() + GUESS_MS;
  room.game.timer = setTimeout(() => finishRound(room), GUESS_MS);
  console.log(`[round] ${room.code} guessing started`);
  emitGameUpdate(room);
}

function finishRound(room) {
  if (!room.game) return;
  clearTimers(room);
  room.game.endsAt = null;

  ensureAiScore(room);
  let aiResult = null;
  if (room.game.strokes && room.game.strokes.length && aiModel) {
    try {
      aiResult = predictFromStrokes(room.game.strokes);
    } catch (err) {
      console.error("AI prediction failed", err);
    }
  }

  const correctGuessers = [];
  room.game.guesses.forEach((guess, playerId) => {
    if (guess.correct) {
      correctGuessers.push({
        id: playerId,
        name: guess.name,
        points: guess.points || 0,
        isAi: false
      });
    }
  });
  if (aiResult) {
    const aiCorrect =
      normalizeLabel(aiResult.guess) === normalizeLabel(room.game.prompt);
    if (aiCorrect) {
      const aiAlreadyCorrectCount = countCorrectGuesses(room);
      const aiPenalty = aiAlreadyCorrectCount * GUESS_ORDER_PENALTY;
      const aiPoints = Math.max(
        GUESS_POINTS_MIN,
        Math.round(
          GUESS_POINTS_MIN +
          (GUESS_POINTS_MAX - GUESS_POINTS_MIN) * aiResult.confidence
        ) - aiPenalty
      );
      const aiScore = room.game.scores.get(AI_PLAYER_ID) || 0;
      room.game.scores.set(AI_PLAYER_ID, aiScore + aiPoints);
      correctGuessers.push({
        id: AI_PLAYER_ID,
        name: AI_PLAYER_NAME,
        points: aiPoints,
        isAi: true
      });
    }
  }
  correctGuessers.sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));

  const drawerInRoom = room.players.has(room.game.drawerId);
  const drawerBonus =
    drawerInRoom && correctGuessers.length > 0
      ? correctGuessers.length * DRAWER_POINTS_PER_CORRECT
      : 0;
  if (drawerInRoom && drawerBonus > 0) {
    const drawerScore = room.game.scores.get(room.game.drawerId) || 0;
    room.game.scores.set(room.game.drawerId, drawerScore + drawerBonus);
  }

  room.game.status = room.game.isLastRound ? "game_over" : "results";
  room.roundActive = false;

  console.log(
    `[round] ${room.code} ended (${room.game.status})`
  );
  emitGameUpdate(room);

  const payload = {
    prompt: room.game.prompt,
    correctGuessers,
    drawerBonus,
    scores: getSortedScores(room)
  };
  if (room.game.status === "game_over" && payload.scores.length > 0) {
    const bestScore = payload.scores[0].score;
    const winners = payload.scores.filter((entry) => entry.score === bestScore);
    payload.winner = winners.length === 1
      ? { type: "single", player: winners[0] }
      : { type: "tie", players: winners };
  }
  if (aiResult) {
    payload.aiGuess = aiResult.guess;
    payload.aiConfidence = aiResult.confidence;
    payload.aiCorrect =
      normalizeLabel(aiResult.guess) === normalizeLabel(room.game.prompt);
  }

  io.to(room.code).emit("round_results", payload);
}

function scheduleRoomCleanup(room) {
  if (room.cleanupTimer) return;
  room.cleanupTimer = setTimeout(() => {
    clearTimers(room);
    rooms.delete(room.code);
    console.log(`[party] expired ${room.code}`);
    logRoomSummary();
  }, ROOM_GRACE_MS);
}

function cancelRoomCleanup(room) {
  if (room.cleanupTimer) {
    clearTimeout(room.cleanupTimer);
    room.cleanupTimer = null;
  }
}

function leaveRoom(socket) {
  const code = socket.data.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  if (!room) return;

  room.players.delete(socket.id);
  if (room.game) {
    room.game.scores.delete(socket.id);
    room.game.guesses.delete(socket.id);
    if (room.game.guessAttempts) {
      room.game.guessAttempts.delete(socket.id);
    }
    room.game.drawnIds.delete(socket.id);
    room.drawerQueue = room.drawerQueue.filter((id) => id !== socket.id);
  }

  if (room.hostId === socket.id) {
    const nextHost = room.players.values().next().value;
    room.hostId = nextHost ? nextHost.id : null;
  }

  if (room.game && room.game.drawerId === socket.id) {
    clearTimers(room);
    room.game.status = "lobby";
    room.game.drawerId = null;
    room.game.prompt = null;
    room.game.promptOptions = [];
    room.game.endsAt = null;
    room.game.guesses = new Map();
    room.game.guessAttempts = new Map();
    room.game.isLastRound = false;
    room.roundActive = false;
    emitGameUpdate(room);
  }

  if (
    room.game &&
    room.players.size < 2 &&
    room.game.status !== "lobby"
  ) {
    clearTimers(room);
    room.game.status = "lobby";
    room.game.drawerId = null;
    room.game.prompt = null;
    room.game.promptOptions = [];
    room.game.endsAt = null;
    room.game.guesses = new Map();
    room.game.guessAttempts = new Map();
    room.game.isLastRound = false;
    room.roundActive = false;
    emitGameUpdate(room);
  }

  if (room.game && room.game.status === "guessing") {
    if (allGuessersResolved(room)) {
      finishRound(room);
    }
  }

  if (room.players.size === 0) {
    scheduleRoomCleanup(room);
  } else {
    io.to(code).emit("room_update", toRoomPayload(room));
  }

  socket.leave(code);
  socket.data.roomCode = null;
}

function logRoomSummary() {
  const summary = Array.from(rooms.values()).map((room) => {
    const names = Array.from(room.players.values()).map((player) => player.name);
    return `${room.code} (${room.players.size}): ${names.join(", ") || "-"}`;
  });
  if (summary.length === 0) {
    console.log("[rooms] none");
  } else {
    console.log(`[rooms] ${summary.join(" | ")}`);
  }
}

io.on("connection", (socket) => {
  const addr = socket.handshake.address || "unknown";
  console.log(`[connect] ${socket.id} from ${addr}`);

  socket.onAny((eventName) => {
    if (eventName !== "ping" && eventName !== "pong" && eventName !== "draw_stroke") {
      console.log(`[event] ${socket.id} ${eventName}`);
    }
  });

  socket.on("create_party", ({ name }, ack) => {
    if (!name || !name.trim()) {
      ack({ ok: false, error: "Name is required." });
      return;
    }

    const code = getUniqueCode();
    const room = {
      code,
      hostId: socket.id,
      round: 0,
      roundActive: false,
      players: new Map(),
      aiProfile: {
        id: AI_PLAYER_ID,
        name: AI_PLAYER_NAME,
        isAi: true,
        avatar: null
      },
      cleanupTimer: null,
      drawerQueue: [],
      game: {
        status: "lobby",
        roundNumber: 0,
        drawerId: null,
        prompt: null,
        promptOptions: [],
        endsAt: null,
        guesses: new Map(),
        guessAttempts: new Map(),
        scores: new Map(),
        timer: null,
        drawnIds: new Set(),
        usedPrompts: new Set(),
        isLastRound: false,
        strokes: [] // store drawing strokes for AI prediction
      }
    };
    room.aiProfile.avatar = pickAvatar(room);
    rooms.set(code, room);

    room.players.set(socket.id, {
      id: socket.id,
      name: name.trim(),
      avatar: pickAvatar(room),
      isAi: false
    });
    room.game.scores.set(socket.id, 0);
    ensureAiScore(room);
    enqueueDrawer(room, socket.id);
    socket.data.roomCode = code;
    socket.join(code);

    const payload = toRoomPayloadForSelf(room, socket.id);
    ack({ ok: true, code, playerId: socket.id, room: payload });
    console.log(`[party] created ${code} by ${name.trim()}`);
    logRoomSummary();
    io.to(code).emit("room_update", toRoomPayload(room));
  });

  socket.on("join_party", ({ code, name }, ack) => {
    const cleanCode = code ? code.trim().toUpperCase() : "";
    if (!cleanCode) {
      ack({ ok: false, error: "Party code is required." });
      return;
    }
    if (!name || !name.trim()) {
      ack({ ok: false, error: "Name is required." });
      return;
    }

    const room = rooms.get(cleanCode);
    if (!room) {
      ack({ ok: false, error: "Party not found." });
      return;
    }

    cancelRoomCleanup(room);

    if (socket.data.roomCode && socket.data.roomCode !== cleanCode) {
      leaveRoom(socket);
    }

    room.players.set(socket.id, {
      id: socket.id,
      name: name.trim(),
      avatar: pickAvatar(room),
      isAi: false
    });
    if (!room.game.scores.has(socket.id)) {
      room.game.scores.set(socket.id, 0);
    }
    ensureAiScore(room);
    if (
      room.game.status === "lobby" ||
      room.game.status === "results"
    ) {
      enqueueDrawer(room, socket.id);
    }
    if (!room.hostId) {
      room.hostId = socket.id;
    }
    socket.data.roomCode = cleanCode;
    socket.join(cleanCode);

    const payload = toRoomPayloadForSelf(room, socket.id);
    ack({ ok: true, code: cleanCode, playerId: socket.id, room: payload });
    console.log(`[party] joined ${cleanCode} by ${name.trim()}`);
    logRoomSummary();
    io.to(cleanCode).emit("room_update", toRoomPayload(room));
    emitGameUpdate(room);
  });

  socket.on("get_state", (_, ack) => {
    const code = socket.data.roomCode;
    if (!code) {
      ack({ ok: false, error: "Not in a room." });
      return;
    }
    const room = rooms.get(code);
    if (!room) {
      ack({ ok: false, error: "Room not found." });
      return;
    }
    ack({ ok: true, room: toRoomPayloadForSelf(room, socket.id) });
    emitGameUpdateFor(socket, room);
  });

  socket.on("start_round", (_, ack) => {
    const code = socket.data.roomCode;
    if (!code) {
      ack({ ok: false, error: "Not in a room." });
      return;
    }
    const room = rooms.get(code);
    if (!room) {
      ack({ ok: false, error: "Room not found." });
      return;
    }
    if (room.hostId !== socket.id) {
      ack({ ok: false, error: "Only the host can start rounds." });
      return;
    }
    if (room.players.size < 2) {
      ack({ ok: false, error: "Need at least 2 players to start." });
      return;
    }
    if (room.game.status === "game_over") {
      ack({ ok: false, error: "Game over. Start a new game." });
      return;
    }
    if (
      room.game.status !== "lobby" &&
      room.game.status !== "results"
    ) {
      ack({ ok: false, error: "Round already in progress." });
      return;
    }

    if (room.game.status === "lobby") {
      room.game.roundNumber = 0;
      room.game.drawnIds = new Set();
      room.game.usedPrompts = new Set();
      room.drawerQueue = [];
      room.game.scores = new Map();
      room.players.forEach((player) => {
        room.game.scores.set(player.id, 0);
      });
      ensureAiScore(room);
    }

    startPromptPick(room);
    const payload = toRoomPayload(room);
    ack({ ok: true, room: payload });
    io.to(code).emit("room_update", payload);
  });

  socket.on("start_new_game", (_, ack) => {
    const code = socket.data.roomCode;
    if (!code) {
      ack({ ok: false, error: "Not in a room." });
      return;
    }
    const room = rooms.get(code);
    if (!room) {
      ack({ ok: false, error: "Room not found." });
      return;
    }
    if (room.hostId !== socket.id) {
      ack({ ok: false, error: "Only the host can start a new game." });
      return;
    }
    if (room.players.size < 2) {
      ack({ ok: false, error: "Need at least 2 players to start." });
      return;
    }
    if (
      room.game.status !== "game_over" &&
      room.game.status !== "lobby"
    ) {
      ack({ ok: false, error: "Finish the current round first." });
      return;
    }

    room.game.roundNumber = 0;
    room.game.drawnIds = new Set();
    room.game.usedPrompts = new Set();
    room.drawerQueue = [];
    room.game.scores = new Map();
    room.players.forEach((player) => {
      room.game.scores.set(player.id, 0);
    });
    ensureAiScore(room);

    startPromptPick(room);
    const payload = toRoomPayload(room);
    ack({ ok: true, room: payload });
    io.to(code).emit("room_update", payload);
  });

  socket.on("pick_prompt", ({ prompt }, ack) => {
    const code = socket.data.roomCode;
    if (!code) {
      ack({ ok: false, error: "Not in a room." });
      return;
    }
    const room = rooms.get(code);
    if (!room || !room.game) {
      ack({ ok: false, error: "Room not found." });
      return;
    }
    if (room.game.status !== "prompt_pick") {
      ack({ ok: false, error: "Not accepting prompt picks now." });
      return;
    }
    if (room.game.drawerId !== socket.id) {
      ack({ ok: false, error: "Only the drawer can pick a prompt." });
      return;
    }
    if (!room.game.promptOptions.includes(prompt)) {
      ack({ ok: false, error: "Invalid prompt." });
      return;
    }

    console.log(`[prompt] ${code} picked ${prompt}`);
    startDrawing(room, prompt);
    ack({ ok: true });
  });

  socket.on("draw_stroke", ({ stroke }, ack) => {
    const code = socket.data.roomCode;
    if (!code) {
      if (ack) ack({ ok: false, error: "Not in a room." });
      return;
    }
    const room = rooms.get(code);
    if (!room || !room.game) return;
    if (room.game.status !== "drawing") return;
    if (room.game.drawerId !== socket.id) return;
    if (
      !stroke ||
      !Number.isFinite(stroke.x0) ||
      !Number.isFinite(stroke.y0) ||
      !Number.isFinite(stroke.x1) ||
      !Number.isFinite(stroke.y1)
    ) {
      if (ack) ack({ ok: false, error: "Invalid stroke." });
      return;
    }
    const pathId =
      typeof stroke.pathId === "string" && stroke.pathId.length
        ? stroke.pathId.slice(0, 64)
        : null;
    const normalizedStroke = {
      x0: stroke.x0,
      y0: stroke.y0,
      x1: stroke.x1,
      y1: stroke.y1,
      pathId
    };

    // keep a copy of strokes for AI prediction later
    room.game.strokes.push(normalizedStroke);

    io.to(code).emit("draw_stroke", { stroke: normalizedStroke });
    if (ack) ack({ ok: true });
  });

  socket.on("undo_last_stroke", (_, ack) => {
    const code = socket.data.roomCode;
    if (!code) {
      if (ack) ack({ ok: false, error: "Not in a room." });
      return;
    }
    const room = rooms.get(code);
    if (!room || !room.game) {
      if (ack) ack({ ok: false, error: "Room not found." });
      return;
    }
    if (room.game.status !== "drawing") {
      if (ack) ack({ ok: false, error: "Undo is only allowed while drawing." });
      return;
    }
    if (room.game.drawerId !== socket.id) {
      if (ack) ack({ ok: false, error: "Only the drawer can undo." });
      return;
    }
    if (!room.game.strokes.length) {
      if (ack) ack({ ok: false, error: "Nothing to undo." });
      return;
    }

    const lastStroke = room.game.strokes[room.game.strokes.length - 1];
    const lastPathId = lastStroke.pathId || null;
    if (lastPathId) {
      room.game.strokes = room.game.strokes.filter(
        (stroke) => stroke.pathId !== lastPathId
      );
    } else {
      room.game.strokes.pop();
    }

    io.to(code).emit("draw_reset", { strokes: room.game.strokes });
    if (ack) ack({ ok: true, remaining: room.game.strokes.length });
  });

  socket.on("submit_guess", ({ guess }, ack) => {
    const code = socket.data.roomCode;
    if (!code) {
      if (ack) ack({ ok: false, error: "Not in a room." });
      return;
    }
    const room = rooms.get(code);
    if (!room || !room.game) {
      if (ack) ack({ ok: false, error: "Room not found." });
      return;
    }
    if (room.game.status !== "drawing" && room.game.status !== "guessing") {
      if (ack) ack({ ok: false, error: "Not accepting guesses now." });
      return;
    }
    if (room.game.drawerId === socket.id) {
      if (ack) ack({ ok: false, error: "Drawer cannot guess." });
      return;
    }
    if (!room.game.guessAttempts) {
      room.game.guessAttempts = new Map();
    }
    const previousGuess = room.game.guesses.get(socket.id);
    if (previousGuess && previousGuess.correct) {
      if (ack) ack({ ok: false, error: "Already guessed correctly." });
      return;
    }
    const attemptsUsed = room.game.guessAttempts.get(socket.id) || 0;
    if (attemptsUsed >= MAX_GUESS_ATTEMPTS) {
      if (ack) ack({ ok: false, error: "No guess attempts left." });
      return;
    }

    const cleanGuess = (guess || "").trim();
    if (!cleanGuess) {
      if (ack) ack({ ok: false, error: "Guess is empty." });
      return;
    }

    const correct =
      cleanGuess.toLowerCase() === room.game.prompt.toLowerCase();
    const nextAttemptsUsed = attemptsUsed + 1;
    room.game.guessAttempts.set(socket.id, nextAttemptsUsed);
    let points = 0;
    if (correct) {
      points = computeCorrectGuessPoints(room);
      const current = room.game.scores.get(socket.id) || 0;
      room.game.scores.set(socket.id, current + points);
    }

    const player = room.players.get(socket.id);
    room.game.guesses.set(socket.id, {
      name: player ? player.name : "Unknown",
      guess: cleanGuess,
      correct,
      points,
      attemptsUsed: nextAttemptsUsed
    });

    if (ack) {
      ack({
        ok: true,
        correct,
        points,
        attemptsLeft: Math.max(0, MAX_GUESS_ATTEMPTS - nextAttemptsUsed),
        locked: correct || nextAttemptsUsed >= MAX_GUESS_ATTEMPTS
      });
    }
    emitGameUpdate(room);

    if (allGuessersResolved(room)) {
      finishRound(room);
    }
  });

  socket.on("close_party", async (_, ack) => {
    const code = socket.data.roomCode;
    if (!code) {
      ack({ ok: false, error: "Not in a room." });
      return;
    }
    const room = rooms.get(code);
    if (!room) {
      ack({ ok: false, error: "Room not found." });
      return;
    }
    if (room.hostId !== socket.id) {
      ack({ ok: false, error: "Only the host can close the party." });
      return;
    }

    cancelRoomCleanup(room);
    clearTimers(room);
    rooms.delete(code);
    io.to(code).emit("room_closed", { code });
    const sockets = await io.in(code).fetchSockets();
    sockets.forEach((member) => {
      member.data.roomCode = null;
    });
    io.in(code).socketsLeave(code);
    ack({ ok: true });
  });

  socket.on("disconnect", (reason) => {
    console.log(`[disconnect] ${socket.id} reason=${reason}`);
    leaveRoom(socket);
    logRoomSummary();
  });
});

server.listen(SERVER_PORT, SERVER_HOST, () => {
  const nets = os.networkInterfaces();
  const addresses = [];
  let primaryLan = null;
  Object.values(nets).forEach((netList) => {
    netList.forEach((net) => {
      if (net.family === "IPv4" && !net.internal) {
        addresses.push(net.address);
        if (!primaryLan) primaryLan = net.address;
      }
    });
  });

  console.log("Server running on:");
  console.log(`  http://localhost:${SERVER_PORT}`);
  addresses.forEach((addr) => {
    console.log(`  http://${addr}:${SERVER_PORT}`);
  });
  if (primaryLan) {
    console.log(`Phone URL: http://${primaryLan}:${SERVER_PORT}`);
  }
  console.log("Use the same URL on both devices (same Wi-Fi).");
  console.log("Create a party on one device, then join with the same code.");
  loadAiModel();
});

function shutdown() {
  console.log("Shutting down server...");
  server.close(() => {
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
