// scripts/cleanupZombieRooms.js
require("dotenv").config({
  path: require("path").resolve(__dirname, "../.env"),
});

const { Room, RoomParticipant, sequelize } = require("../models");
const { Op } = require("sequelize");
const { clearRoomTimer } = require("../sockets/roundPhases");

const DRY_RUN = false; // already false
const CUTOFF_MINUTES = 30;
const MAX_RETRIES = 3;

async function deleteRoomWithRetry(room) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await sequelize.transaction(async (t) => {
        clearRoomTimer(`${room.code}_phase`);
        clearRoomTimer(`${room.code}_drawing`);

        await RoomParticipant.destroy({
          where: { roomId: room.id },
          transaction: t,
        });

        await room.destroy({ transaction: t });
      });

      console.log(`✅ Successfully deleted room ${room.code}`);
      return true;
    } catch (err) {
      if (err?.original?.code === "ER_LOCK_DEADLOCK" && attempt < MAX_RETRIES) {
        console.warn(
          `🔁 Deadlock on room ${room.code}. Retrying (${attempt}/${MAX_RETRIES})...`
        );
        await new Promise((r) => setTimeout(r, 300 * attempt));
      } else {
        throw err;
      }
    }
  }
}

(async () => {
  try {
    console.log("🧹 Starting zombie room cleanup...");
    console.log(`🧪 DRY_RUN = ${DRY_RUN}`);

    const cutoffTime = new Date(Date.now() - CUTOFF_MINUTES * 60 * 1000);

    const rooms = await Room.findAll({
      where: {
        status: {
          [Op.in]: ["waiting", "lobby", "inactive"],
        },
        updatedAt: {
          [Op.lt]: cutoffTime,
        },
      },
    });

    console.log(`🔍 Found ${rooms.length} candidate rooms`);

    let deletedCount = 0;

    for (const room of rooms) {
      const activeParticipants = await RoomParticipant.count({
        where: { roomId: room.id, isActive: true },
      });

      if (activeParticipants > 0) {
        console.log(
          `⏭️ Skipping room ${room.code} – ${activeParticipants} active players`
        );
        continue;
      }

      console.log(
        `${DRY_RUN ? "🧪 WOULD DELETE" : "🗑️ DELETING"} room ${room.code}`
      );

      if (DRY_RUN) continue;

      await deleteRoomWithRetry(room);
      deletedCount++;
    }

    console.log(
      `✅ Cleanup completed. Deleted ${deletedCount} zombie rooms`
    );
    process.exit(0);
  } catch (err) {
    console.error("❌ Cleanup failed:", err);
    process.exit(1);
  }
})();

