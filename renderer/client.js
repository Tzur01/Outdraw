let cachedSocket;
let socketLoading;

function getServerUrl() {
  if (window.location.origin && window.location.origin !== "null") {
    return window.location.origin;
  }
  return "http://localhost:3000";
}

function loadSocketIo() {
  if (window.io) return Promise.resolve();
  if (socketLoading) return socketLoading;

  socketLoading = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `${getServerUrl()}/socket.io/socket.io.js`;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load socket.io"));
    document.head.appendChild(script);
  });

  return socketLoading;
}

async function getSocket() {
  if (cachedSocket) return cachedSocket;
  await loadSocketIo();
  cachedSocket = window.io(getServerUrl(), {
    autoConnect: true,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    reconnectionDelayMax: 2000,
    timeout: 10000
  });
  return cachedSocket;
}

function createWebApi() {
  return {
    connect: async () => {
      await getSocket();
    },
    createParty: async (name) => {
      const socket = await getSocket();
      return new Promise((resolve) => {
        socket.emit("create_party", { name }, (response) => resolve(response));
      });
    },
    joinParty: async (code, name) => {
      const socket = await getSocket();
      return new Promise((resolve) => {
        socket.emit("join_party", { code, name }, (response) =>
          resolve(response)
        );
      });
    },
    getState: async () => {
      const socket = await getSocket();
      return new Promise((resolve) => {
        socket.emit("get_state", {}, (response) => resolve(response));
      });
    },
    startRound: async () => {
      const socket = await getSocket();
      return new Promise((resolve) => {
        socket.emit("start_round", {}, (response) => resolve(response));
      });
    },
    startNewGame: async () => {
      const socket = await getSocket();
      return new Promise((resolve) => {
        socket.emit("start_new_game", {}, (response) => resolve(response));
      });
    },
    pickPrompt: async (prompt) => {
      const socket = await getSocket();
      return new Promise((resolve) => {
        socket.emit("pick_prompt", { prompt }, (response) => resolve(response));
      });
    },
    sendStroke: async (stroke) => {
      const socket = await getSocket();
      return new Promise((resolve) => {
        socket.emit("draw_stroke", { stroke }, (response) => resolve(response));
      });
    },
    undoLastStroke: async () => {
      const socket = await getSocket();
      return new Promise((resolve) => {
        socket.emit("undo_last_stroke", {}, (response) => resolve(response));
      });
    },
    submitGuess: async (guess) => {
      const socket = await getSocket();
      return new Promise((resolve) => {
        socket.emit("submit_guess", { guess }, (response) => resolve(response));
      });
    },
    closeParty: async () => {
      const socket = await getSocket();
      return new Promise((resolve) => {
        socket.emit("close_party", {}, (response) => resolve(response));
      });
    },
    onRoomUpdate: async (callback) => {
      const socket = await getSocket();
      socket.on("room_update", (payload) => callback(payload));
    },
    onGameUpdate: async (callback) => {
      const socket = await getSocket();
      socket.on("game_update", (payload) => callback(payload));
    },
    onPromptOptions: async (callback) => {
      const socket = await getSocket();
      socket.on("prompt_options", (payload) => callback(payload));
    },
    onPrompt: async (callback) => {
      const socket = await getSocket();
      socket.on("prompt", (payload) => callback(payload));
    },
    onDrawStroke: async (callback) => {
      const socket = await getSocket();
      socket.on("draw_stroke", (payload) => callback(payload));
    },
    onDrawReset: async (callback) => {
      const socket = await getSocket();
      socket.on("draw_reset", (payload) => callback(payload));
    },
    onRoundResults: async (callback) => {
      const socket = await getSocket();
      socket.on("round_results", (payload) => callback(payload));
    },
    onRoomClosed: async (callback) => {
      const socket = await getSocket();
      socket.on("room_closed", (payload) => callback(payload));
    },
    onSocketConnect: async (callback) => {
      const socket = await getSocket();
      socket.on("connect", () => callback());
    },
    onSocketDisconnect: async (callback) => {
      const socket = await getSocket();
      socket.on("disconnect", (reason) => callback(reason));
    }
  };
}

function getApi() {
  if (window.api) return window.api;
  return createWebApi();
}

window.clientApi = { getApi };
