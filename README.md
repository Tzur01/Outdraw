
# OutDraw

**OutDraw is a human vs AI party game where you draw things that humans will get, but an AI won't!**
<p align="center">
  <img src="https://github.com/user-attachments/assets/1d1118f4-3cca-4186-b384-5a863dfb7878"
       alt="OutDraw Screenshot"
       width="600" />
</p>

## Tech Stack

- `Electron`
- `Express` + `Socket.IO`
- `HTML/CSS/JS`

## Prerequisites
- Node.js 18+
- npm

## First-Time Setup

Clone the repo, enter the project folder, and install dependencies:

```bash
git clone <repo-url>
cd Outdraw
npm install
```

## Run The Desktop App

```bash
npm start
```

This starts:

- Electron window (`renderer/index.html`)
- Local game server on `http://localhost:3000`


## Run (Browser / Phone on Same Wi-Fi)

You can also run just the server and connect from any device on your LAN:

```bash
npm run start:server
```

Then open the URL printed in the terminal, for example `http://192.168.x.x:3000`, on each device.
