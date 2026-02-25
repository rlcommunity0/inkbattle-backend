require("dotenv").config({
  path: require("path").resolve(__dirname, "../.env"),
});

const { Room, RoomParticipant } = require("../models");
const { Op } = require("sequelize");

(async () => {
  try {
    console.log("\n📊 INKBATTLE LIVE PLATFORM STATS\n");

    // ---------------------------
    // ROOM STATS
    // ---------------------------
    const totalRooms = await Room.count();

    const lobbyRooms = await Room.count({
      where: { status: "lobby" },
    });

    const activeRooms = await Room.count({
      where: { status: "active" },
    });

    const soloRooms = await Room.count({
      where: { gameMode: "1v1" },
    });

    const teamRooms = await Room.count({
      where: { gameMode: "team_vs_team" },
    });

    // ---------------------------
    // PLAYER STATS
    // ---------------------------
    const activePlayers = await RoomParticipant.count({
      where: { isActive: true },
    });

    const lobbyPlayers = await RoomParticipant.count({
      where: { isActive: true },
      include: [{
        model: Room,
        where: { status: "lobby" },
      }],
    });

    const playingPlayers = await RoomParticipant.count({
      where: { isActive: true },
      include: [{
        model: Room,
        where: { status: "active" },
      }],
    });

    // ---------------------------
    // MODE-SPECIFIC PLAYERS
    // ---------------------------
    const soloPlayers = await RoomParticipant.count({
      where: { isActive: true },
      include: [{
        model: Room,
        where: { gameMode: "1v1", status: "active" },
      }],
    });

    const teamPlayers = await RoomParticipant.count({
      where: { isActive: true },
      include: [{
        model: Room,
        where: { gameMode: "team_vs_team", status: "active" },
      }],
    });

    // ---------------------------
    // ZOMBIE / STALE DETECTION
    // ---------------------------
    const zombieRooms = await Room.count({
      include: [{
        model: RoomParticipant,
        as: "participants",
        required: false,
        where: { isActive: true },
      }],
      where: {
        "$participants.id$": null,
      },
    });

    // ---------------------------
    // OUTPUT
    // ---------------------------
    console.log("🏠 ROOMS");
    console.log("────────────");
    console.log(`Total rooms        : ${totalRooms}`);
    console.log(`Lobby rooms        : ${lobbyRooms}`);
    console.log(`Active rooms       : ${activeRooms}`);
    console.log(`Solo (1v1) rooms   : ${soloRooms}`);
    console.log(`Team vs Team rooms : ${teamRooms}`);

    console.log("\n👥 PLAYERS");
    console.log("────────────");
    console.log(`Active players     : ${activePlayers}`);
    console.log(`In lobby           : ${lobbyPlayers}`);
    console.log(`Playing now        : ${playingPlayers}`);
    console.log(`Solo players       : ${soloPlayers}`);
    console.log(`Team players       : ${teamPlayers}`);

    console.log("\n🧟 HEALTH");
    console.log("────────────");
    console.log(`Zombie rooms       : ${zombieRooms}`);

    console.log("\n✅ Stats generated successfully\n");

    process.exit(0);
  } catch (err) {
    console.error("❌ Failed to fetch platform stats:", err);
    process.exit(1);
  }
})();

