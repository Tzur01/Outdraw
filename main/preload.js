const { contextBridge } = require("electron");
const { io } = require("socket.io-client");

let socket;

function getSocket() {
  if (!socket) {
    socket = io("http://localhost:3000", {
      autoConnect: true,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 2000,
      timeout: 10000
    });
  }
  return socket;
}

contextBridge.exposeInMainWorld("api", {
  connect: () => {
    getSocket();
  },
  createParty: (name) =>
    new Promise((resolve) => {
      const active = getSocket();
      active.emit("create_party", { name }, (response) => resolve(response));
    }),
  joinParty: (code, name) =>
    new Promise((resolve) => {
      const active = getSocket();
      active.emit("join_party", { code, name }, (response) =>
        resolve(response)
      );
    }),
  getState: () =>
    new Promise((resolve) => {
      const active = getSocket();
      active.emit("get_state", {}, (response) => resolve(response));
    }),
  startRound: () =>
    new Promise((resolve) => {
      const active = getSocket();
      active.emit("start_round", {}, (response) => resolve(response));
    }),
  startNewGame: () =>
    new Promise((resolve) => {
      const active = getSocket();
      active.emit("start_new_game", {}, (response) => resolve(response));
    }),
  pickPrompt: (prompt) =>
    new Promise((resolve) => {
      const active = getSocket();
      active.emit("pick_prompt", { prompt }, (response) => resolve(response));
    }),
  sendStroke: (stroke) =>
    new Promise((resolve) => {
      const active = getSocket();
      active.emit("draw_stroke", { stroke }, (response) => resolve(response));
    }),
  undoLastStroke: () =>
    new Promise((resolve) => {
      const active = getSocket();
      active.emit("undo_last_stroke", {}, (response) => resolve(response));
    }),
  submitGuess: (guess) =>
    new Promise((resolve) => {
      const active = getSocket();
      active.emit("submit_guess", { guess }, (response) => resolve(response));
    }),
  closeParty: () =>
    new Promise((resolve) => {
      const active = getSocket();
      active.emit("close_party", {}, (response) => resolve(response));
    }),
  onRoomUpdate: (callback) => {
    const active = getSocket();
    active.on("room_update", (payload) => callback(payload));
  },
  onGameUpdate: (callback) => {
    const active = getSocket();
    active.on("game_update", (payload) => callback(payload));
  },
  onPromptOptions: (callback) => {
    const active = getSocket();
    active.on("prompt_options", (payload) => callback(payload));
  },
  onPrompt: (callback) => {
    const active = getSocket();
    active.on("prompt", (payload) => callback(payload));
  },
  onDrawStroke: (callback) => {
    const active = getSocket();
    active.on("draw_stroke", (payload) => callback(payload));
  },
  onDrawReset: (callback) => {
    const active = getSocket();
    active.on("draw_reset", (payload) => callback(payload));
  },
  onRoundResults: (callback) => {
    const active = getSocket();
    active.on("round_results", (payload) => callback(payload));
  },
  onRoomClosed: (callback) => {
    const active = getSocket();
    active.on("room_closed", (payload) => callback(payload));
  },
  onSocketConnect: (callback) => {
    const active = getSocket();
    active.on("connect", () => callback());
  },
  onSocketDisconnect: (callback) => {
    const active = getSocket();
    active.on("disconnect", (reason) => callback(reason));
  }
});
