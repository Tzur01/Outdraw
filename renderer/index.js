const joinName = document.getElementById("joinName");
const joinCode = document.getElementById("joinCode");
const joinBtn = document.getElementById("joinBtn");
const joinError = document.getElementById("joinError");

const createName = document.getElementById("createName");
const createBtn = document.getElementById("createBtn");
const createError = document.getElementById("createError");

function setError(target, message) {
  target.textContent = message || "";
}

function redirectToLobby(code, name) {
  localStorage.setItem("partyCode", code);
  localStorage.setItem("playerName", name);
  window.location.href = "lobby.html";
}

const api = window.clientApi.getApi();
let joinInFlight = false;
let createInFlight = false;

function normalizeCode(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, 4);
}

joinCode.addEventListener("input", () => {
  joinCode.value = normalizeCode(joinCode.value);
});

joinCode.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    joinBtn.click();
  }
});

joinName.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    joinBtn.click();
  }
});

createName.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    createBtn.click();
  }
});

async function ensureApi() {
  try {
    await api.connect();
    return true;
  } catch (error) {
    setError(joinError, "Server not available.");
    setError(createError, "Server not available.");
    return false;
  }
}

joinBtn.addEventListener("click", async () => {
  if (joinInFlight) return;
  setError(joinError, "");
  if (!(await ensureApi())) return;

  const name = joinName.value.trim();
  const code = normalizeCode(joinCode.value);
  joinCode.value = code;
  if (!name) {
    setError(joinError, "Enter your name.");
    return;
  }
  if (!code) {
    setError(joinError, "Enter a party code.");
    return;
  }

  joinInFlight = true;
  joinBtn.disabled = true;
  try {
    const response = await api.joinParty(code, name);
    if (!response.ok) {
      setError(joinError, response.error || "Unable to join.");
      return;
    }

    redirectToLobby(response.code, name);
  } finally {
    joinInFlight = false;
    joinBtn.disabled = false;
  }
});

createBtn.addEventListener("click", async () => {
  if (createInFlight) return;
  setError(createError, "");
  if (!(await ensureApi())) return;

  const name = createName.value.trim();
  if (!name) {
    setError(createError, "Enter your name.");
    return;
  }

  createInFlight = true;
  createBtn.disabled = true;
  try {
    const response = await api.createParty(name);
    if (!response.ok) {
      setError(createError, response.error || "Unable to create.");
      return;
    }

    redirectToLobby(response.code, name);
  } finally {
    createInFlight = false;
    createBtn.disabled = false;
  }
});
