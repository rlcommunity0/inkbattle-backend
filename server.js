// server.js
require("dotenv").config();
const express = require("express");
const http = require("http");
const cors = require("cors");
const { sequelize } = require("./models");
const routes = require("./routes");
const initSockets = require("./sockets/socket");
const { sweepStaleParticipantsOnStart, rebuildTimersOnStartup } = require("./sockets/roundPhases");
const { seedThemes } = require("./utils/seedThemes");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Serve simple public files (test pages)
const path = require("path");
app.use(express.static(path.join(__dirname, "public")));

app.use("/api", routes).use((req, res, next) => {
  console.log(`req: ${req.method} ${req.url}`);
  next();
});

app.get("/", (req, res) => res.json({ ok: true }));

app.get("/health", (req, res) => {
  res.json({ status: "ok", pid: process.pid });
});

const server = http.createServer(app);
const io = require("socket.io")(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// Make io accessible to routes via app.locals
app.locals.io = io;

initSockets(io);

const PORT = process.env.PORT || 4000;

// ---- START SERVER IMMEDIATELY (optimized for pm2 reload: listen first, DB init after) ----
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
  console.log(
    `Server listening on 0.0.0.0:${PORT} (accessible from emulators via 10.0.2.2:${PORT})`,
  );
  console.log(`Database: ${process.env.DB_NAME || "inkbattles"}`);
  console.log(
    `Host: ${process.env.DB_HOST || "127.0.0.1"}:${process.env.DB_PORT || 3306}`,
  );
  console.log(
    "<<<<<---------- Backend restarted at ",
    new Date().toISOString(),
    " ------------->>>>>",
  );
  initializeServices(); // run async after listen
});

// ---- INIT SERVICES ASYNC ----
async function initializeServices() {
  try {
    console.log("Testing database connection...");
    await sequelize.authenticate();
    console.log("Database connection established successfully.");

    console.log("Syncing database models...");
    await sequelize.sync({});
    console.log("Database models synced successfully.");

    // Crash/restart safety: mark disconnected-but-still-active participants inactive and close empty rooms
    await sweepStaleParticipantsOnStart(io);

    // Rebuild phase timers from roundPhaseEndTime so rooms in progress continue after server restart
    await rebuildTimersOnStartup(io);

    // Seed themes and words (optional)
    // await seedThemes();
    console.log("Themes seeded successfully.");
  } catch (err) {
    console.error("Initialization failed:", err);
    console.log("Retrying in 5 seconds...");
    setTimeout(initializeServices, 5000);
  }
}

// ---- GRACEFUL SHUTDOWN (pm2 reload / stop) ----
let shuttingDown = false;

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`🛑 Received ${signal}. Starting graceful shutdown...`);

  server.close(() => {
    console.log("HTTP server closed.");
  });

  try {
    io.emit("server:restarting");
  } catch (_) {}

  setTimeout(async () => {
    try {
      await sequelize.close();
      console.log("Database connection closed.");
    } catch (_) {}
    console.log("Forcing shutdown now.");
    process.exit(0);
  }, 8000);
}

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);

